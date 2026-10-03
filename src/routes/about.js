'use strict';
/** 「关于」页：产品介绍 / 功能亮点 / 版本日志 / 隐私声明 / 功能需求反馈 */
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { get, DATA_DIR, DB_FILE } = require('../db');
const auth = require('../lib/auth');
const about = require('../lib/about');

const router = express.Router();

const VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
).version;

function safeSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) total += dirSize(p);
      else { try { total += fs.statSync(p).size; } catch { /* ignore */ } }
    }
  } catch { /* ignore */ }
  return total;
}

router.get('/about', auth.requireLogin, (req, res) => {
  const stats = {
    txns: Number(get('SELECT COUNT(*) AS c FROM transactions WHERE deleted_at IS NULL')?.c || 0),
    ledgers: Number(get('SELECT COUNT(*) AS c FROM ledgers')?.c || 0),
    attachments: Number(get('SELECT COUNT(*) AS c FROM attachments')?.c || 0),
    dataSize: safeSize(DB_FILE) + dirSize(path.join(DATA_DIR, 'uploads')),
  };
  // 运行天数：从第一笔记账（或首个账本创建）算起（created_at 为本地时间）
  const first = get(
    `SELECT MIN(created_at) AS t FROM (
       SELECT created_at FROM transactions UNION ALL
       SELECT created_at FROM ledgers
     )`
  );
  let days = 1;
  if (first && first.t) {
    const ms = Date.now() - new Date(String(first.t).replace(' ', 'T')).getTime();
    if (Number.isFinite(ms) && ms > 0) days = Math.max(1, Math.floor(ms / 86400000) + 1);
  }
  const fmtSize = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB'
    : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
    : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');
  res.render('about', {
    title: '关于', activeNav: 'about',
    version: VERSION,
    app: about.APP,
    upstream: about.UPSTREAM,
    features: about.FEATURES,
    changelog: about.CHANGELOG,
    tech: about.TECH,
    issuesUrl: about.issuesUrl(),
    stats: { ...stats, days, sizeLabel: fmtSize(stats.dataSize) },
    envInfo: {
      node: process.version,
      platform: process.platform,
      dataDir: DATA_DIR,
      uptime: Math.round(process.uptime()),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
});

module.exports = router;

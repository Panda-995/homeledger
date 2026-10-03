'use strict';
/**
 * 开放 API：供小龙虾（OpenClaw / PicoClaw）、Hermes Agent、快捷指令等外部工具调用。
 * 鉴权：Authorization: Bearer <令牌>（在「设置 → 开放 API」中创建）。
 * 本路由挂在全局 CSRF 中间件之前，不走会话；令牌只存 SHA-256 摘要。
 */
const crypto = require('node:crypto');
const express = require('express');
const { all, get, run, nowStr, todayStr, TXN_TYPES } = require('../db');
const auth = require('../lib/auth');
const ai = require('../lib/ai');
const txn = require('../lib/txn');
const fd = require('../lib/formdata');
const att = require('../lib/attachments');

const router = express.Router();

/* ------------------------------- 令牌工具 -------------------------------- */

function hashToken(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

/** 生成新令牌：hl_ + 24 字节随机数的 base64url（约 32 字符） */
function mintToken() {
  return 'hl_' + crypto.randomBytes(24).toString('base64url');
}

/* ------------------------------- 鉴权中间件 ------------------------------- */

function requireToken(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  const plain = m ? m[1].trim() : '';
  if (!plain) return res.status(401).json({ ok: false, error: '缺少 Bearer 令牌（Authorization: Bearer <令牌>）' });

  const row = get(
    `SELECT t.*, u.username, u.status AS user_status FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    hashToken(plain)
  );
  if (!row) return res.status(401).json({ ok: false, error: '令牌无效或已吊销' });
  if (row.user_status !== 'active') return res.status(401).json({ ok: false, error: '令牌所属用户已被禁用' });

  const ledgerId = Number(row.ledger_id) ||
    Number(get('SELECT ledger_id FROM ledger_members WHERE user_id = ? ORDER BY ledger_id LIMIT 1', row.user_id)?.ledger_id) ||
    0;
  if (!ledgerId) return res.status(403).json({ ok: false, error: '该令牌未绑定账本，且用户名下没有可用账本' });

  // 令牌效力跟随成员关系：被移出账本后令牌立即失效（否则仍可读该账本流水与截图）
  const member = get('SELECT role FROM ledger_members WHERE user_id = ? AND ledger_id = ?', row.user_id, ledgerId);
  if (!member) return res.status(403).json({ ok: false, error: '令牌所属用户已不是该账本成员，令牌已失效' });

  req.openAuth = { userId: Number(row.user_id), username: row.username, ledgerId, tokenId: Number(row.id), tokenName: row.name, role: member.role };
  run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', nowStr(), row.id);
  next();
}

router.use(requireToken);

/* ------------------------------ 每令牌频控 ------------------------------ */
/* Hermes / OpenClaw 是会自主循环调工具的 agent，失控时会无限刷接口；
   /ai/bill 还会消耗已配置的视觉模型额度，单独收紧。 */
const RATE_RULES = [
  { match: (p) => p === '/ai/bill', max: 10, windowMs: 60 * 1000 },
  { match: () => true, max: 60, windowMs: 60 * 1000 },
];
const rateBuckets = new Map(); // `${tokenId}:${ruleIndex}` -> [timestamps]
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of rateBuckets) {
    const alive = arr.filter((t) => now - t < 5 * 60 * 1000);
    if (alive.length) rateBuckets.set(k, alive);
    else rateBuckets.delete(k);
  }
}, 5 * 60 * 1000).unref?.();

router.use((req, res, next) => {
  const now = Date.now();
  const ruleIdx = RATE_RULES.findIndex((r) => r.match(req.path));
  const rule = RATE_RULES[ruleIdx];
  const key = `${req.openAuth.tokenId}:${ruleIdx}`;
  const arr = (rateBuckets.get(key) || []).filter((t) => now - t < rule.windowMs);
  if (arr.length >= rule.max) {
    const retry = Math.ceil((rule.windowMs - (now - arr[0])) / 1000);
    return res.status(429).json({ ok: false, error: `请求过于频繁（${rule.max} 次/分钟），请 ${retry} 秒后重试` });
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  next();
});

/** 写操作需令牌所属用户在该账本有写权限（防止只读成员用令牌绕过网页端角色限制） */
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!auth.canWrite(req.openAuth.role)) {
    return res.status(403).json({ ok: false, error: '该令牌所属用户在此账本中只有只读权限，无法执行写操作' });
  }
  next();
});

/* --------------------------------- 连通性 -------------------------------- */

router.get('/ping', (req, res) => {
  res.json({
    ok: true,
    app: 'homeledger',
    ledger_id: req.openAuth.ledgerId,
    user: req.openAuth.username,
    token: req.openAuth.tokenName,
    today: todayStr(),
  });
});

/* ------------------------------- 名称解析 -------------------------------- */

/** 中文/英文别名 → 标准 type key */
const TYPE_ALIASES = (() => {
  const map = { 支出: 'expense', 收入: 'income', 转账: 'transfer', 借出: 'lend', 借入: 'borrow' };
  for (const t of TXN_TYPES) map[t.key] = t.key;
  return map;
})();

function resolveCategory(ledgerId, name, kind) {
  const s = String(name || '').trim();
  if (!s) return null;
  const cats = fd.flatCategories(ledgerId);
  const lower = s.toLowerCase();
  return (
    cats.find((c) => c.path.toLowerCase() === lower) ||
    cats.find((c) => c.name.toLowerCase() === lower && (!kind || c.kind === kind)) ||
    cats.find((c) => c.name.toLowerCase() === lower) ||
    null
  );
}

function resolveAccount(ledgerId, name, { autoCreate = true, created = null } = {}) {
  const s = String(name || '').trim();
  if (!s) return null;
  const acc = fd.accounts(ledgerId).find((a) => a.name === s);
  if (acc) return Number(acc.id);
  if (!autoCreate) return null;
  const info = run(
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, created_at) VALUES (?,?,?,?,?,?)`,
    ledgerId, s.slice(0, 30), 'debit', '🏦', 'CNY', nowStr()
  );
  if (created) created.push(s.slice(0, 30));
  return Number(info.lastInsertRowid);
}

function parseAmount(body) {
  if (body.amount_cents != null) return Math.abs(Math.round(Number(body.amount_cents) || 0));
  const yuan = Number(body.amount);
  if (!Number.isFinite(yuan) || yuan <= 0) return 0;
  return Math.abs(Math.round(yuan * 100));
}

/* -------------------------------- 记一笔 --------------------------------- */

router.post('/transactions', (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const body = req.body || {};
  try {
    const type = TYPE_ALIASES[String(body.type || 'expense').trim()] || 'expense';
    const amountCents = parseAmount(body);
    if (!amountCents) return res.status(400).json({ ok: false, error: '金额无效（请传 amount，单位：元）' });

    const createdAccounts = [];
    const isTransfer = ['transfer', 'invest_buy', 'invest_sell'].includes(type);
    const kind = type === 'income' || ['refund', 'interest', 'repay_receive', 'reimburse'].includes(type) ? 'income' : 'expense';
    const category = resolveCategory(ledgerId, body.category, kind);

    const txnId = txn.createTransaction(ledgerId, userId, {
      type,
      amount_cents: amountCents,
      currency: String(body.currency || 'CNY').toUpperCase().slice(0, 8),
      account_id: resolveAccount(ledgerId, body.account || body.account_name, { created: createdAccounts }),
      to_account_id: isTransfer ? resolveAccount(ledgerId, body.to_account || body.to_account_name, { created: createdAccounts }) : null,
      category_id: category ? Number(category.id) : null,
      txn_date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || body.txn_date || '')) ? String(body.date || body.txn_date) : todayStr(),
      note: body.note || '',
      merchant: body.merchant || '',
      tags: body.tags || '',
      is_reimbursable: body.is_reimbursable ? 1 : 0,
      source: 'api_open',
      ai_json: body.raw ? JSON.stringify(body.raw).slice(0, 4000) : null,
    });

    auth.audit(req, 'api.txn.create', {
      ledgerId, entity: 'transaction', entityId: txnId,
      detail: `开放API·${req.openAuth.tokenName} 记 ${type} ¥${(amountCents / 100).toFixed(2)}`,
    });
    res.json({
      ok: true, id: txnId,
      category_resolved: category ? category.path : null,
      accounts_created: createdAccounts,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ----------------------------- 截图 / 文本识别 ----------------------------- */

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

router.post('/ai/bill', async (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const body = req.body || {};
  try {
    const rawImages = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
    const text = String(body.text || '').slice(0, 4000);
    if (!rawImages.length && !text) {
      return res.status(400).json({ ok: false, error: '请提供 images（dataURL 数组）或 text 账单文字' });
    }
    // 统一规范成 { dataUrl }：既接受纯 dataURL 字符串（推荐），也接受 { dataUrl } 对象
    const images = [];
    for (const img of rawImages) {
      const url = String((img && (img.dataUrl || img.url)) || img || '');
      const m = /^data:([^;]+);base64,(.+)$/.exec(url);
      if (!m) return res.status(400).json({ ok: false, error: 'images 元素必须是 dataURL（data:image/...;base64,xxx）' });
      if (Buffer.byteLength(m[2], 'base64') > MAX_IMAGE_BYTES) {
        return res.status(400).json({ ok: false, error: '单张图片请小于 8MB' });
      }
      images.push({ dataUrl: url });
    }

    const confirm = body.confirm === true || body.confirm === 'true' || body.confirm === 1;
    // 图片留档：入库时必然保存并关联；草稿模式默认不留档（试探性调用不堆垃圾），传 save_images=true 可强制留档
    const wantSave = confirm || body.save_images === true || body.save_images === 'true' || body.save_images === 1;
    const savedImages = [];
    const saveWarnings = [];
    if (wantSave) {
      for (const img of images) {
        try {
          savedImages.push(att.saveDataUrlImage({ dataUrl: img.dataUrl, ledgerId, userId }));
        } catch (e) {
          saveWarnings.push(`有图片保存失败（${e.message}），识别继续。`);
        }
      }
    }

    const result = await ai.analyzeBill({ images, text, ledgerId });
    const warnings = [...(result.warnings || []), ...saveWarnings];

    if (!confirm) {
      return res.json({
        ok: true, engine: result.engine, model: result.model || null,
        warnings, drafts: result.items, confirmed: false,
        images: savedImages.map((s) => ({ id: s.id, path: `/uploads/${s.rel}`, size: s.size, txn_id: null })),
        hint: '检查 drafts 无误后，用 confirm=true 重新调用即可直接入库（图片会随记录一起保存并关联）',
      });
    }

    // 直接入库。账户解析链：条目自带 → body.default_account（可自动创建）→ 账本第一个账户
    const defaultAccName = body.default_account || body.default_account_name;
    const firstAccount = () =>
      Number(get('SELECT id FROM accounts WHERE ledger_id = ? AND is_archived = 0 ORDER BY sort_order, id LIMIT 1', ledgerId)?.id) || null;
    const createdAccounts = [];
    const created = [];
    const errors = [];
    for (const it of result.items) {
      try {
        const accountId = Number(it.account_id) ||
          resolveAccount(ledgerId, it.account_name || defaultAccName, { created: createdAccounts }) ||
          firstAccount();
        const id = txn.createTransaction(ledgerId, userId, {
          type: it.type || 'expense',
          amount_cents: Number(it.amount_cents) || 0,
          currency: it.currency || 'CNY',
          account_id: accountId,
          category_id: it.category_id || null,
          txn_date: it.txn_date || todayStr(),
          note: it.note || '',
          merchant: it.merchant || '',
          tags: it.tags || '',
          is_reimbursable: it.is_reimbursable ? 1 : 0,
          source: 'api_open_ai',
          ai_json: JSON.stringify(it.raw || it).slice(0, 4000),
        });
        created.push(id);
      } catch (e) {
        errors.push(`${it.merchant || it.note || '一笔'}：${e.message}`);
      }
    }
    // 账单截图落到对应记录上：数量一致时一图一笔，否则整组图挂第一笔
    const linked = att.linkImagesToTxns({ ledgerId, imageIds: savedImages.map((s) => s.id), txnIds: created });

    auth.audit(req, 'api.ai.bill', {
      ledgerId, detail: `开放API·${req.openAuth.tokenName} ${result.engine} 识别并入库 ${created.length} 笔，图片 ${savedImages.length} 张`,
    });
    res.json({
      ok: created.length > 0,
      engine: result.engine, model: result.model || null,
      warnings,
      accounts_created: createdAccounts,
      confirmed: true, created: created.length, ids: created, errors,
      images: savedImages.map((s) => ({
        id: s.id,
        path: `/uploads/${s.rel}`,
        size: s.size,
        txn_id: (linked.find((l) => l.image_id === s.id) || {}).txn_id ?? null,
      })),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ---------------------------- 记录 / 截图回查 ----------------------------- */

/** 最近记账（含关联的账单截图），便于外部工具在聊天里回执「记好了 + 原图」 */
router.get('/transactions/recent', (req, res) => {
  const { ledgerId } = req.openAuth;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const rows = all(
    `SELECT t.id, t.type, t.amount_cents, t.currency, t.txn_date, t.merchant, t.note, t.source, t.created_at,
            c.name AS category_name, a.name AS account_name
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.ledger_id = ? AND t.deleted_at IS NULL
     ORDER BY t.txn_date DESC, t.id DESC LIMIT ?`,
    ledgerId, limit
  );
  const imgMap = att.listByTxnIds(rows.map((r) => r.id));
  res.json({
    ok: true,
    count: rows.length,
    transactions: rows.map((r) => ({
      ...r,
      images: (imgMap.get(Number(r.id)) || []).map((i) => ({ id: i.id, path: `/uploads/${i.rel_path}`, size: i.size })),
    })),
  });
});

/** 取回某张账单截图（需令牌；网页端 /uploads/<rel_path> 同样可直接访问） */
router.get('/attachments/:id', (req, res) => {
  const { ledgerId } = req.openAuth;
  const found = att.resolveFile(ledgerId, req.params.id);
  if (!found) return res.status(404).json({ ok: false, error: '截图不存在' });
  res.type(att.safeMime(found.row.mime));
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(found.abs);
});

/** API 兜底：未匹配的路径/方法一律 JSON 404，避免落到网页错误页（会因缺会话 locals 渲染 500） */
router.use((req, res) => {
  res.status(404).json({ ok: false, error: `接口不存在：${req.method} ${req.path}` });
});

module.exports = router;

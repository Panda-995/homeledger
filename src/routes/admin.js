'use strict';
/** 设置 / 账本 / 成员 / 导入导出 / 备份 / 系统管理 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const {
  all, get, run, tx, nowStr, todayStr, DATA_DIR, DB_FILE,
  getSetting, setSetting, createDefaultAccounts, addLedgerMember,
} = require('../db');
const auth = require('../lib/auth');
const ai = require('../lib/ai');
const txn = require('../lib/txn');
const importer = require('../lib/importers');
const fd = require('../lib/formdata');
const u = require('../lib/util');

const router = express.Router();

/* ------------------------------ 导入预览缓存 ------------------------------ */
const previewCache = new Map(); // token -> { records, source, fileName, encoding, createdAt }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of previewCache) if (now - v.createdAt > 30 * 60 * 1000) previewCache.delete(k);
}, 5 * 60 * 1000).unref?.();

/* ---------------------------------- 设置 ---------------------------------- */

router.get('/settings', auth.requireLogin, (req, res) => {
  const cfg = ai.getAiConfig();
  // 新令牌明文只展示一次：取走即删，刷新/重进后不再出现
  const newToken = req.session.newToken || null;
  delete req.session.newToken;
  const isAdmin = !!res.locals.user.is_admin;
  // 管理员：附带「系统管理」区块数据（用户 / 统计 / 审计日志）
  let adminData = null;
  if (isAdmin) {
    adminData = {
      users: all(
        `SELECT u.*,
          (SELECT COUNT(*) FROM ledger_members m WHERE m.user_id = u.id) AS ledger_count,
          (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id AND t.deleted_at IS NULL) AS txn_count
         FROM users u ORDER BY u.id`
      ),
      stats: {
        users: Number(get('SELECT COUNT(*) AS c FROM users')?.c || 0),
        ledgers: Number(get('SELECT COUNT(*) AS c FROM ledgers')?.c || 0),
        txns: Number(get('SELECT COUNT(*) AS c FROM transactions WHERE deleted_at IS NULL')?.c || 0),
        attachments: Number(get('SELECT COUNT(*) AS c FROM attachments')?.c || 0),
        dbSize: safeSize(DB_FILE),
        uploadsSize: dirSize(path.join(DATA_DIR, 'uploads')),
      },
      audits: all('SELECT a.*, u.display_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 60'),
    };
  }
  res.render('settings', {
    title: '设置', activeNav: 'settings',
    cfg,
    aiReady: ai.isAiReady(),
    settings: require('../db').allSettings(),
    isAdmin,
    newToken,
    admin: adminData,
    apiTokens: all(
      `SELECT id, name, token_tail, last_used_at, created_at FROM api_tokens
       WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC`,
      res.locals.user.id
    ),
    envInfo: {
      node: process.version,
      platform: process.platform,
      pid: process.pid,
      mem: Math.round(process.memoryUsage().rss / 1024 / 1024),
      dataDir: DATA_DIR,
      dbSize: safeSize(DB_FILE),
      uptime: Math.round(process.uptime()),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
});

function safeSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/* --------------------------- 开放 API 令牌管理 ---------------------------- */

function hashToken(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

router.post('/settings/api-tokens', auth.requireLogin, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30) || 'API 令牌';
  const plain = 'hl_' + crypto.randomBytes(24).toString('base64url');
  run(
    `INSERT INTO api_tokens (user_id, ledger_id, name, token_hash, token_tail, created_at)
     VALUES (?,?,?,?,?,?)`,
    res.locals.user.id,
    res.locals.ledger ? Number(res.locals.ledger.id) : null,
    name, hashToken(plain), plain.slice(-4), nowStr()
  );
  auth.audit(req, 'api.token.create', { entity: 'api_token', detail: `创建令牌「${name}」` });
  // 明文只在下一次渲染中通过专用卡片展示一次（库里只存摘要）
  req.session.newToken = { name, token: plain };
  res.redirect('/settings#api');
});

router.post('/settings/api-tokens/:id/revoke', auth.requireLogin, (req, res) => {
  const id = Number(req.params.id);
  const row = get('SELECT * FROM api_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL', id, res.locals.user.id);
  if (row) {
    run('UPDATE api_tokens SET revoked_at = ? WHERE id = ?', nowStr(), id);
    auth.audit(req, 'api.token.revoke', { entity: 'api_token', entityId: id, detail: `吊销令牌「${row.name}」` });
    req.session.flash = { type: 'success', message: `令牌「${row.name}」已吊销` };
  }
  res.redirect('/settings#api');
});

router.post('/settings/profile', auth.requireLogin, (req, res) => {
  const displayName = String(req.body.display_name || '').trim();
  const email = String(req.body.email || '').trim() || null;
  const username = String(req.body.username || '').trim();
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.avatar_color || '') ? req.body.avatar_color : res.locals.user.avatar_color;
  if (!displayName) { res.flash('error', '昵称不能为空'); return res.redirect('/settings'); }

  // 用户名：2-24 位，字母/数字/下划线/中划线/点，全站唯一
  if (username !== res.locals.user.username) {
    if (!/^[A-Za-z0-9_\-.]{2,24}$/.test(username)) {
      res.flash('error', '用户名需为 2-24 位字母、数字或 _ - . 组合');
      return res.redirect('/settings');
    }
    const dup = get('SELECT id FROM users WHERE username = ? AND id != ?', username, req.session.userId);
    if (dup) { res.flash('error', `用户名「${username}」已被占用`); return res.redirect('/settings'); }
    run('UPDATE users SET username = ? WHERE id = ?', username, req.session.userId);
    auth.audit(req, 'user.username_change', { entity: 'user', entityId: req.session.userId, detail: `${res.locals.user.username} → ${username}` });
  }

  run('UPDATE users SET display_name = ?, email = ?, avatar_color = ? WHERE id = ?',
    displayName.slice(0, 30), email, color, req.session.userId);
  res.flash('success', '个人资料已更新');
  res.redirect('/settings');
});

/* ------------------------------ 自传头像 ------------------------------ */

const AVATAR_DIR = () => path.join(DATA_DIR, 'uploads', 'avatars');
const AVATAR_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** 从 dataUrl 解析图片，嗅探真实格式（防止改扩展名伪装），非法返回 null */
function parseAvatarDataUrl(dataUrl) {
  const m = /^data:image\/([a-z+]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch (e) { return null; }
  if (!buf || buf.length < 16 || buf.length > 2 * 1024 * 1024) return null;
  // 魔数校验
  const hex = buf.subarray(0, 12).toString('hex');
  let ext = null;
  if (hex.startsWith('89504e47')) ext = 'png';
  else if (hex.startsWith('ffd8ff')) ext = 'jpg';
  else if (hex.startsWith('47494638')) ext = 'gif';
  else if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') ext = 'webp';
  if (!ext) return null;
  return { buf, ext };
}

/** 删除旧头像文件（扩展名可能变化） */
function removeAvatarFile(avatarPath) {
  if (!avatarPath) return;
  try { fs.unlinkSync(path.join(AVATAR_DIR(), avatarPath)); } catch (e) { /* 文件已不存在则忽略 */ }
}

router.post('/settings/avatar', auth.requireLogin, (req, res) => {
  const parsed = parseAvatarDataUrl(req.body.dataUrl);
  if (!parsed) { res.status(400).json({ ok: false, error: '请上传 2MB 以内的 PNG/JPG/GIF/WebP 图片' }); return; }
  fs.mkdirSync(AVATAR_DIR(), { recursive: true });
  const name = `user-${req.session.userId}.${parsed.ext}`;
  removeAvatarFile(res.locals.user.avatar_path);
  fs.writeFileSync(path.join(AVATAR_DIR(), name), parsed.buf);
  run('UPDATE users SET avatar_path = ?, avatar_ver = ? WHERE id = ?', name, Date.now(), req.session.userId);
  auth.audit(req, 'user.avatar_change', { entity: 'user', entityId: req.session.userId });
  res.json({ ok: true });
});

router.post('/settings/avatar/clear', auth.requireLogin, (req, res) => {
  removeAvatarFile(res.locals.user.avatar_path);
  run('UPDATE users SET avatar_path = NULL, avatar_ver = NULL WHERE id = ?', req.session.userId);
  res.json({ ok: true });
});

router.post('/settings/password', auth.requireLogin, (req, res) => {
  const oldPw = String(req.body.old_password || '');
  const pw = String(req.body.new_password || '');
  const pw2 = String(req.body.new_password2 || '');
  const user = get('SELECT * FROM users WHERE id = ?', req.session.userId);
  if (!auth.verifyPassword(oldPw, user.password_hash)) { res.flash('error', '当前密码不正确'); return res.redirect('/settings'); }
  if (pw.length < 6) { res.flash('error', '新密码至少 6 位'); return res.redirect('/settings'); }
  if (pw !== pw2) { res.flash('error', '两次输入的新密码不一致'); return res.redirect('/settings'); }
  run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(pw), req.session.userId);
  auth.audit(req, 'user.password_change', { entity: 'user', entityId: req.session.userId });
  res.flash('success', '密码已修改');
  res.redirect('/settings');
});

/** 主题切换（同时写 session 与用户表） */
router.get('/theme/:mode', auth.requireLogin, (req, res) => {
  const mode = req.params.mode === 'dark' ? 'dark' : 'light';
  run('UPDATE users SET theme = ? WHERE id = ?', mode, req.session.userId);
  res.redirect(req.get('referer') || '/');
});

router.post('/settings/ai', auth.requireLogin, require('../lib/auth').requireAdmin, async (req, res) => {
  const keys = ['ai.enabled', 'ai.base_url', 'ai.api_key', 'ai.model', 'ai.vision', 'ai.timeout_ms', 'ai.auto_save'];
  const before = ai.getAiConfig();
  const rawKey = String(req.body['ai.api_key'] == null ? '' : req.body['ai.api_key']).trim();
  if (req.body.clear_api_key) {
    setSetting('ai.api_key', '');
  } else if (rawKey === '' || ai.isMaskedSecret(rawKey)) {
    // 留空，或提交的仍是页面上的「已保存」掩码 → 保持原 Key 不变
    setSetting('ai.api_key', before.apiKey);
  } else if (!ai.isHeaderSafe(rawKey)) {
    res.flash('error', 'API Key 含有非法字符（复制时可能带入了全角符号），已保留原 Key，请重新粘贴');
    return res.redirect('/settings#ai');
  } else {
    setSetting('ai.api_key', rawKey);
  }
  setSetting('ai.base_url', String(req.body['ai.base_url'] || '').trim());
  setSetting('ai.model', String(req.body['ai.model'] || '').trim());
  setSetting('ai.enabled', req.body['ai.enabled'] ? 'true' : 'false');
  setSetting('ai.vision', req.body['ai.vision'] ? 'true' : 'false');
  setSetting('ai.auto_save', req.body['ai.auto_save'] ? 'true' : 'false');
  setSetting('ai.timeout_ms', String(Number(req.body['ai.timeout_ms']) || 90000));
  auth.audit(req, 'settings.ai', { detail: keys.join(',') });
  res.flash('success', 'AI 配置已保存');
  res.redirect('/settings#ai');
});

router.post('/settings/site', auth.requireLogin, require('../lib/auth').requireAdmin, (req, res) => {
  if (req.body['site.name']) setSetting('site.name', String(req.body['site.name']).slice(0, 20));
  if (req.body['site.currency']) setSetting('site.currency', String(req.body['site.currency']).slice(0, 8));
  setSetting('site.allow_register', req.body['site.allow_register'] ? 'true' : 'false');
  setSetting('security.login_max_fail', String(Number(req.body['security.login_max_fail']) || 10));
  res.flash('success', '站点设置已保存');
  res.redirect('/settings#site');
});

router.post('/api/ai/test', auth.requireLogin, require('../lib/auth').requireAdmin, async (req, res) => {
  // 允许用表单里未保存的值直接测试
  if (req.body.base_url) setSetting('ai.base_url', String(req.body.base_url).trim());
  if (req.body.model) setSetting('ai.model', String(req.body.model).trim());
  const key = String(req.body.api_key == null ? '' : req.body.api_key).trim();
  if (key && !ai.isMaskedSecret(key)) {
    // 传了真实新 Key 才覆盖；留空或仍是页面掩码 → 沿用已保存的 Key
    if (!ai.isHeaderSafe(key)) {
      return res.json({ ok: false, error: 'API Key 含有非法字符（复制时可能带入了全角符号或中文标点），请重新粘贴' });
    }
    setSetting('ai.api_key', key);
  }
  const r = await ai.testConnection();
  res.json(r.ok ? { ok: true, message: '连接成功，模型响应正常', raw: r.raw } : { ok: false, error: r.error });
});

/**
 * 拉取可用模型列表（只查询、不写库）
 * 允许带上页面上还没保存的 base_url / api_key，方便「先填地址 → 拉列表 → 选模型 → 保存」
 */
router.post('/api/ai/models', auth.requireLogin, require('../lib/auth').requireAdmin, async (req, res) => {
  try {
    const out = await ai.listModels({
      baseUrl: String(req.body.base_url || '').trim(),
      apiKey: String(req.body.api_key == null ? '' : req.body.api_key).trim(),
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* ---------------------------------- 账本 ---------------------------------- */

router.get('/ledgers', auth.requireLogin, (req, res) => {
  const rows = all(
    `SELECT l.*, m.role,
      (SELECT COUNT(*) FROM transactions t WHERE t.ledger_id = l.id AND t.deleted_at IS NULL) AS txn_count,
      (SELECT COUNT(*) FROM ledger_members x WHERE x.ledger_id = l.id) AS member_count,
      (SELECT COUNT(*) FROM accounts a WHERE a.ledger_id = l.id) AS account_count
     FROM ledgers l JOIN ledger_members m ON m.ledger_id = l.id AND m.user_id = ?
     ORDER BY l.is_archived, l.sort_order, l.id`,
    req.session.userId
  );
  res.render('ledgers', { title: '账本管理', activeNav: 'ledgers', rows, today: todayStr() });
});

router.post('/ledgers', auth.requireLogin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) { res.flash('error', '请填写账本名称'); return res.redirect('/ledgers'); }
  const currency = String(req.body.currency || 'CNY').slice(0, 8);
  const info = run(
    'INSERT INTO ledgers (name, kind, currency, icon, color, owner_id, note, created_at) VALUES (?,?,?,?,?,?,?,?)',
    name.slice(0, 30),
    ['personal', 'family', 'business', 'travel', 'project'].includes(req.body.kind) ? req.body.kind : 'personal',
    currency, req.body.icon || '📒', req.body.color || u.colorFor(name), req.session.userId,
    req.body.note ? String(req.body.note).slice(0, 200) : null, nowStr()
  );
  addLedgerMember(info.lastInsertRowid, req.session.userId, 'owner');
  if (req.body.with_default_accounts !== '0') createDefaultAccounts(info.lastInsertRowid, currency, req.session.userId);
  req.session.ledgerId = info.lastInsertRowid;
  auth.audit(req, 'ledger.create', { entity: 'ledger', entityId: info.lastInsertRowid, detail: name });
  res.flash('success', `账本「${name}」已创建`);
  res.redirect('/ledgers');
});

router.post('/ledgers/:id', auth.requireLogin, auth.requireLedgerManage, (req, res) => {
  const id = Number(req.params.id);
  const l = get('SELECT * FROM ledgers WHERE id = ?', id);
  if (!l) { res.flash('error', '账本不存在'); return res.redirect('/ledgers'); }
  run('UPDATE ledgers SET name=?, kind=?, currency=?, icon=?, color=?, note=?, sort_order=? WHERE id=?',
    String(req.body.name || l.name).slice(0, 30), req.body.kind || l.kind,
    String(req.body.currency || l.currency).slice(0, 8),
    req.body.icon || l.icon, req.body.color || l.color,
    req.body.note ? String(req.body.note).slice(0, 200) : null,
    Number(req.body.sort_order) || l.sort_order, id);
  res.flash('success', '账本信息已更新');
  res.redirect('/ledgers');
});

router.post('/ledgers/:id/archive', auth.requireLogin, auth.requireLedgerManage, (req, res) => {
  const id = Number(req.params.id);
  const l = get('SELECT * FROM ledgers WHERE id = ?', id);
  if (!l) return res.redirect('/ledgers');
  run('UPDATE ledgers SET is_archived = ? WHERE id = ?', l.is_archived ? 0 : 1, id);
  res.flash('success', l.is_archived ? '账本已恢复' : '账本已归档');
  res.redirect('/ledgers');
});

/** 账本级联删除：清掉该账本全部数据（附件磁盘文件由调用方收集后另行清理） */
function deleteLedgerCascade(id) {
  const files = all('SELECT rel_path FROM attachments WHERE ledger_id = ?', id);
  const ids = all('SELECT id FROM transactions WHERE ledger_id = ?', id).map((r) => r.id);
  for (const tid of ids) run('DELETE FROM transaction_tags WHERE transaction_id = ?', tid);
  run('DELETE FROM splits WHERE ledger_id = ?', id);
  run('DELETE FROM transactions WHERE ledger_id = ?', id);
  run('DELETE FROM attachments WHERE ledger_id = ?', id);
  run('DELETE FROM accounts WHERE ledger_id = ?', id);
  run('DELETE FROM budgets WHERE ledger_id = ?', id);
  run('DELETE FROM recurring_rules WHERE ledger_id = ?', id);
  // 订阅必须随账本删除：否则后台任务会继续给已不存在的账本生成流水
  run('DELETE FROM subscriptions WHERE ledger_id = ?', id);
  run('DELETE FROM goals WHERE ledger_id = ?', id);
  run('DELETE FROM debts WHERE ledger_id = ?', id);
  run('DELETE FROM tags WHERE ledger_id = ?', id);
  run('DELETE FROM categories WHERE ledger_id = ?', id);
  run('DELETE FROM ledger_members WHERE ledger_id = ?', id);
  run('DELETE FROM ledger_invites WHERE ledger_id = ?', id);
  run('DELETE FROM import_jobs WHERE ledger_id = ?', id);
  run('DELETE FROM ledgers WHERE id = ?', id);
  return files.map((f) => f.rel_path);
}

/** 尽力清理附件磁盘文件（失败忽略：文件可能已被手工删除） */
function cleanupUploadFiles(relPaths) {
  const root = path.join(DATA_DIR, 'uploads');
  for (const rel of relPaths || []) {
    const abs = path.resolve(root, String(rel));
    if (!abs.startsWith(path.resolve(root) + path.sep)) continue;
    try { fs.unlinkSync(abs); } catch { /* ignore */ }
  }
}

router.post('/ledgers/:id/delete', auth.requireLogin, (req, res) => {
  const id = Number(req.params.id);
  const l = get('SELECT * FROM ledgers WHERE id = ? AND owner_id = ?', id, req.session.userId);
  if (!l) { res.flash('error', '只有账本拥有者可以删除账本'); return res.redirect('/ledgers'); }
  if (String(req.body.confirm || '') !== l.name) {
    res.flash('error', '请准确输入账本名称以确认删除');
    return res.redirect('/ledgers');
  }
  let files = [];
  tx(() => { files = deleteLedgerCascade(id); });
  cleanupUploadFiles(files);
  auth.audit(req, 'ledger.delete', { entity: 'ledger', entityId: id, detail: l.name });
  if (Number(req.session.ledgerId) === id) req.session.ledgerId = null;
  res.flash('success', `账本「${l.name}」及其全部数据已删除`);
  res.redirect('/ledgers');
});

/* ---------------------------------- 成员 ---------------------------------- */

router.get('/members', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const members = fd.members(ledgerId);
  const invites = all('SELECT i.*, u.display_name AS creator FROM ledger_invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.ledger_id = ? ORDER BY i.id DESC LIMIT 20', ledgerId);
  const stats = txn.memberBreakdown(ledgerId, `${todayStr().slice(0, 7)}-01`, `${todayStr().slice(0, 7)}-31`);
  const statMap = new Map(stats.map((s) => [Number(s.id), s]));
  res.render('members', {
    title: '成员与权限', activeNav: 'members',
    members: members.map((m) => ({ ...m, stat: statMap.get(Number(m.user_id)) || { cnt: 0, expense: 0, income: 0 } })),
    invites,
  });
});

router.post('/members/invite', auth.requireLogin, auth.requireLedgerManage, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const role = ['viewer', 'member', 'admin'].includes(req.body.role) ? req.body.role : 'member';
  const days = Math.min(Math.max(Number(req.body.days) || 7, 1), 90);
  const code = u.uid(20);
  const expires = u.addDays(todayStr(), days);
  run(
    'INSERT INTO ledger_invites (ledger_id, code, role, created_by, expires_at, created_at) VALUES (?,?,?,?,?,?)',
    ledgerId, code, role, req.session.userId, expires, nowStr()
  );
  auth.audit(req, 'member.invite', { ledgerId, detail: `${role} 有效期至 ${expires}` });
  res.flash('success', `邀请链接已生成（${days} 天内有效）：${req.protocol}://${req.get('host')}/join/${code}`);
  res.redirect('/members');
});

router.post('/members/:id', auth.requireLogin, auth.requireLedgerManage, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const m = get('SELECT * FROM ledger_members WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!m) { res.flash('error', '成员不存在'); return res.redirect('/members'); }
  if (m.role === 'owner') { res.flash('error', '拥有者角色不可修改'); return res.redirect('/members'); }
  const role = ['viewer', 'member', 'admin'].includes(req.body.role) ? req.body.role : m.role;
  run('UPDATE ledger_members SET role = ?, nickname = ? WHERE id = ?', role, req.body.nickname ? String(req.body.nickname).slice(0, 20) : null, id);
  res.flash('success', '成员权限已更新');
  res.redirect('/members');
});

router.post('/members/:id/remove', auth.requireLogin, auth.requireLedgerManage, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const m = get('SELECT * FROM ledger_members WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!m) return res.redirect('/members');
  if (m.role === 'owner') { res.flash('error', '不能移除账本拥有者'); return res.redirect('/members'); }
  run('DELETE FROM ledger_members WHERE id = ?', id);
  auth.audit(req, 'member.remove', { ledgerId, detail: String(m.user_id) });
  res.flash('success', '成员已移出账本');
  res.redirect('/members');
});

/* ------------------------------- 导入 / 导出 ------------------------------ */

router.get('/import', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const jobs = all('SELECT * FROM import_jobs WHERE ledger_id = ? ORDER BY id DESC LIMIT 20', ledgerId);
  const accounts = fd.accounts(ledgerId);
  res.render('import', { title: '账单导入', activeNav: 'import', jobs, accounts, preview: null, token: null });
});

router.post('/api/import/preview', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  try {
    const { dataUrl, fileName } = req.body;
    const m = /^data:.*?;base64,(.+)$/s.exec(String(dataUrl || ''));
    if (!m) return res.status(400).json({ ok: false, error: '请选择 CSV 账单文件' });
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 20 * 1024 * 1024) return res.status(400).json({ ok: false, error: '文件请小于 20MB' });
    const parsed = importer.parseBill(buf);
    if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });

    const token = u.uid(24);
    previewCache.set(token, {
      records: parsed.records, neutralRecords: parsed.neutralRecords || [],
      source: parsed.source, fileName: fileName || 'bill.csv', encoding: parsed.encoding,
      createdAt: Date.now(), ledgerId, userId: req.session.userId,
    });

    const cats = fd.flatCategories(ledgerId);
    const guessCat = (r) => {
      if (r.neutral) return '账户间转账（不计收支）';
      const kind = r.type === 'income' ? 'income' : 'expense';
      const direct = r.category_hint ? ai.resolveCategoryId(ledgerId, r.category_hint, kind) : null;
      if (direct) return cats.find((c) => Number(c.id) === Number(direct))?.path || r.category_hint;
      const kw = ai.classifyByKeywords(r.text);
      if (kw) {
        const cid = ai.resolveCategoryId(ledgerId, kw.category, kw.kind === 'income' ? 'income' : kind);
        if (cid) return cats.find((c) => Number(c.id) === Number(cid))?.path || kw.category;
        return kw.category;
      }
      return kind === 'income' ? '其他收入/其他收入' : '其他支出/其他';
    };
    const sample = parsed.records.slice(0, 200).map((r) => ({
      ...r,
      type_label: require('../db').TXN_TYPE_MAP[r.type]?.label || r.type,
      guess_category: guessCat(r),
      guess_account: r.account_hint || '—',
    }));

    const stat = { income: 0, expense: 0, transfer: 0, minDate: null, maxDate: null };
    for (const r of parsed.records) {
      if (r.type === 'income') stat.income += r.amount_cents;
      else if (r.type === 'transfer') stat.transfer += r.amount_cents;
      else stat.expense += r.amount_cents;
      if (!stat.minDate || r.txn_date < stat.minDate) stat.minDate = r.txn_date;
      if (!stat.maxDate || r.txn_date > stat.maxDate) stat.maxDate = r.txn_date;
    }

    const neutralSample = (parsed.neutralRecords || []).slice(0, 20).map((r) => ({
      ...r,
      type_label: require('../db').TXN_TYPE_MAP[r.type]?.label || r.type,
      guess_category: guessCat(r),
      guess_account: r.account_hint || '—',
    }));

    res.json({
      ok: true, token,
      source: parsed.source,
      sourceLabel: { alipay: '支付宝账单', wechat: '微信支付账单', generic: '通用 CSV' }[parsed.source] || parsed.source,
      encoding: parsed.encoding,
      header: parsed.header,
      count: parsed.records.length,
      skipped: parsed.skipped || 0,
      neutralCount: (parsed.neutralRecords || []).length,
      neutralSample,
      sample, stat,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/api/import/commit', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const cached = previewCache.get(String(req.body.token || ''));
  if (!cached || cached.ledgerId !== ledgerId) {
    return res.status(400).json({ ok: false, error: '预览已过期，请重新上传文件' });
  }
  try {
    const r = importer.importRecords({
      ledgerId, userId: req.session.userId,
      records: cached.records,
      neutralRecords: cached.neutralRecords || [],
      includeNeutral: req.body.include_neutral === true || req.body.include_neutral === 'true',
      source: cached.source, fileName: cached.fileName,
      autoCreateAccount: req.body.auto_create_account !== false,
      defaultAccountId: req.body.default_account_id ? Number(req.body.default_account_id) : null,
    });
    previewCache.delete(String(req.body.token));
    auth.audit(req, 'import.commit', { ledgerId, detail: `${cached.fileName} 导入 ${r.imported} 笔` });
    res.json({ ok: true, ...r, redirect: '/import' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/export', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const form = fd.txFormData(ledgerId, req.session.userId);
  const years = all(
    "SELECT DISTINCT substr(txn_date,1,4) AS y FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL ORDER BY y DESC",
    ledgerId
  ).map((r) => r.y);
  res.render('export', { title: '导出与备份', activeNav: 'export', form, years, isAdmin: !!res.locals.user.is_admin });
});

router.get('/export/csv', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const f = {
    from: req.query.from || '',
    to: req.query.to || '',
    type: req.query.type || '',
    accountId: req.query.account_id ? Number(req.query.account_id) : null,
    categoryId: req.query.category_id ? Number(req.query.category_id) : null,
    sort: 'date_asc',
  };
  const rows = [];
  let page = 1;
  for (;;) {
    const r = txn.listTransactions(ledgerId, { ...f, page, pageSize: 200 });
    rows.push(...r.rows);
    if (page >= r.pages || page > 100) break;
    page++;
  }
  const csv = importer.toCsv(importer.EXPORT_HEADER, importer.exportRows(ledgerId, rows));
  const name = `账单_${ledger.name}_${f.from || '全部'}_${f.to || '全部'}.csv`;
  auth.audit(req, 'export.csv', { ledgerId, detail: `${rows.length} 行` });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
  res.send(csv);
});

router.get('/export/json', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const dump = {
    app: 'homeledger', version: 1, exported_at: nowStr(),
    ledger: get('SELECT * FROM ledgers WHERE id = ?', ledgerId),
    accounts: all('SELECT * FROM accounts WHERE ledger_id = ?', ledgerId),
    categories: all('SELECT * FROM categories WHERE ledger_id IS NULL OR ledger_id = ?', ledgerId),
    tags: all('SELECT * FROM tags WHERE ledger_id = ?', ledgerId),
    transactions: all('SELECT * FROM transactions WHERE ledger_id = ?', ledgerId),
    splits: all('SELECT * FROM splits WHERE ledger_id = ?', ledgerId),
    budgets: all('SELECT * FROM budgets WHERE ledger_id = ?', ledgerId),
    recurring_rules: all('SELECT * FROM recurring_rules WHERE ledger_id = ?', ledgerId),
    goals: all('SELECT * FROM goals WHERE ledger_id = ?', ledgerId),
    debts: all('SELECT * FROM debts WHERE ledger_id = ?', ledgerId),
  };
  const name = `账本数据_${ledger.name}_${todayStr()}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
  res.send(JSON.stringify(dump, null, 2));
});

/** 备份：下载 SQLite 数据库文件 */
router.get('/backup/db', auth.requireLogin, auth.requireAdmin, (req, res, next) => {
  try {
    // 用 VACUUM INTO 产出一致、紧凑的完整快照（包含 WAL 中尚未合并的写入）。
    // 直接 copyFileSync 活库文件在 WAL 模式下会缺最近写入，-wal 又不会随 .db 一起被下载。
    const target = path.join(DATA_DIR, `backup-${todayStr()}-${Date.now()}.db`);
    require('../db').db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    auth.audit(req, 'backup.download');
    res.download(target, `homeledger-${todayStr()}.db`, (err) => {
      try { fs.unlinkSync(target); } catch { /* ignore */ }
      if (err && !res.headersSent) next(err);
    });
  } catch (e) {
    next(e);
  }
});

/** 恢复：保存上传文件并替换数据库（需重启容器生效） */
router.post('/backup/restore', auth.requireLogin, auth.requireAdmin, (req, res) => {
  try {
    const m = /^data:.*?;base64,(.+)$/s.exec(String(req.body.dataUrl || ''));
    if (!m) { res.flash('error', '请选择 .db 数据库文件'); return res.redirect('/export'); }
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length < 100 || buf.slice(0, 15).toString('utf8') !== 'SQLite format 3') {
      res.flash('error', '文件不是有效的 SQLite 数据库');
      return res.redirect('/export');
    }
    const safety = path.join(DATA_DIR, `pre-restore-${Date.now()}.db`);
    fs.copyFileSync(DB_FILE, safety);
    fs.writeFileSync(path.join(DATA_DIR, 'restore-pending.db'), buf);
    fs.writeFileSync(path.join(DATA_DIR, 'RESTORE-PENDING.txt'),
      `已上传待恢复数据库，时间 ${nowStr()}\n当前数据已备份为：${path.basename(safety)}\n\n恢复方法：\n1) 停止容器；\n2) 把 restore-pending.db 改名为 homeledger.db 覆盖原文件（同时删除 homeledger.db-wal / -shm）；\n3) 启动容器。\n`);
    auth.audit(req, 'backup.restore_upload', { detail: `备份于 ${path.basename(safety)}` });
    res.flash('success', `已接收备份文件并做好安全备份（${path.basename(safety)}）。请按 data 目录下 RESTORE-PENDING.txt 的说明完成恢复。`);
    res.redirect('/export');
  } catch (e) {
    res.flash('error', '恢复失败：' + e.message);
    res.redirect('/export');
  }
});

/* -------------------------------- 系统管理 -------------------------------- */
/* 页面已并入 /settings#系统管理；老链接 /admin 统一重定向，POST 接口保持原路径不变 */

router.get('/admin', auth.requireLogin, auth.requireAdmin, (req, res) => {
  res.redirect('/settings#admin');
});

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

router.post('/admin/users/:id', auth.requireLogin, auth.requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = get('SELECT * FROM users WHERE id = ?', id);
  if (!user) { res.flash('error', '用户不存在'); return res.redirect('/settings#admin'); }
  const action = req.body.action || '';
  if (id === Number(req.session.userId) && ['disable', 'delete', 'demote'].includes(action)) {
    res.flash('error', '不能对自己执行该操作');
    return res.redirect('/settings#admin');
  }
  switch (action) {
    case 'promote':
      run('UPDATE users SET is_admin = 1 WHERE id = ?', id);
      res.flash('success', `${user.display_name} 已成为管理员`);
      break;
    case 'demote':
      run('UPDATE users SET is_admin = 0 WHERE id = ?', id);
      res.flash('success', `${user.display_name} 已取消管理员`);
      break;
    case 'disable':
      run("UPDATE users SET status = 'disabled' WHERE id = ?", id);
      run('DELETE FROM sessions WHERE user_id = ?', id);
      res.flash('success', `${user.display_name} 已被禁用`);
      break;
    case 'enable':
      run("UPDATE users SET status = 'active' WHERE id = ?", id);
      res.flash('success', `${user.display_name} 已启用`);
      break;
    case 'reset': {
      const pw = String(req.body.new_password || '').trim() || ('hl' + u.uid(8));
      run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(pw), id);
      res.flash('success', `已重置 ${user.display_name} 的密码为：${pw}（请转告本人后尽快修改）`);
      break;
    }
    case 'delete': {
      const owned = all('SELECT id, name FROM ledgers WHERE owner_id = ?', id);
      const files = [];
      for (const l of owned) {
        const others = get('SELECT user_id FROM ledger_members WHERE ledger_id = ? AND user_id != ? LIMIT 1', l.id, id);
        if (others) run('UPDATE ledgers SET owner_id = ? WHERE id = ?', others.user_id, l.id);
        else tx(() => { files.push(...deleteLedgerCascade(l.id)); });
      }
      cleanupUploadFiles(files);
      run('DELETE FROM ledger_members WHERE user_id = ?', id);
      run('DELETE FROM sessions WHERE user_id = ?', id);
      // 吊销令牌并清掉站内通知：软删后令牌仍能通过 users JOIN 生效，必须显式吊销
      run('UPDATE api_tokens SET revoked_at = ? WHERE user_id = ?', nowStr(), id);
      run('DELETE FROM notifications WHERE user_id = ?', id);
      run("UPDATE users SET status = 'disabled', username = username || '_deleted_' || id WHERE id = ?", id);
      if (String(req.body.hard || '') === '1') run('DELETE FROM users WHERE id = ?', id);
      res.flash('success', '用户已删除（其名下账本已转交或清理）');
      break;
    }
    default:
      res.flash('error', '未知操作');
  }
  auth.audit(req, 'admin.user_action', { entity: 'user', entityId: id, detail: action });
  res.redirect('/settings#admin');
});

/** 立即执行一次后台任务（周期账单/预警检查） */
router.post('/admin/run-scheduler', auth.requireLogin, auth.requireAdmin, (req, res) => {
  const r = require('../lib/scheduler').runDaily();
  res.flash('success', `已执行：周期账单 ${r.recurring} 笔，预算预警 ${r.budgets}，借贷提醒 ${r.debts}，目标提醒 ${r.goals}`);
  res.redirect('/settings#admin');
});

module.exports = router;

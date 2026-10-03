'use strict';
/** 认证、会话、CSRF、权限、审计 */
const crypto = require('node:crypto');
const session = require('express-session');
const { all, get, run, tx, nowStr } = require('../db');

/* -------------------------------- 密码哈希 --------------------------------- */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${hash}`;
}

function verifyPassword(plain, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const calc = crypto.scryptSync(String(plain), salt, SCRYPT.keylen, { N: Number(N), r: Number(r), p: Number(p) });
    const target = Buffer.from(hash, 'hex');
    if (calc.length !== target.length) return false;
    return crypto.timingSafeEqual(calc, target);
  } catch {
    return false;
  }
}

/* ---------------------------- SQLite 会话存储 ----------------------------- */

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    this.timer = setInterval(() => {
      try { run('DELETE FROM sessions WHERE expires_at < ?', Date.now()); } catch { /* ignore */ }
    }, 10 * 60 * 1000);
    this.timer.unref?.();
  }
  _expiry(sess) {
    const ms = sess?.cookie?.maxAge ?? 30 * 24 * 60 * 60 * 1000;
    return Date.now() + Number(ms);
  }
  get(sid, cb) {
    try {
      const row = get('SELECT data, expires_at FROM sessions WHERE sid = ?', sid);
      if (!row) return cb(null, null);
      if (Number(row.expires_at) < Date.now()) {
        run('DELETE FROM sessions WHERE sid = ?', sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.data));
    } catch (e) { return cb(e); }
  }
  set(sid, sess, cb) {
    try {
      run(
        `INSERT INTO sessions (sid, user_id, expires_at, data) VALUES (?,?,?,?)
         ON CONFLICT(sid) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at, data = excluded.data`,
        sid, sess.userId ?? null, this._expiry(sess), JSON.stringify(sess)
      );
      return cb(null);
    } catch (e) { return cb(e); }
  }
  touch(sid, sess, cb) {
    try {
      run('UPDATE sessions SET expires_at = ? WHERE sid = ?', this._expiry(sess), sid);
      return cb(null);
    } catch (e) { return cb(e); }
  }
  destroy(sid, cb) {
    try { run('DELETE FROM sessions WHERE sid = ?', sid); return cb(null); } catch (e) { return cb(e); }
  }
  clear(cb) {
    try { run('DELETE FROM sessions'); return cb(null); } catch (e) { return cb(e); }
  }
}

/* --------------------------------- 审计日志 -------------------------------- */

function audit(req, action, { entity = null, entityId = null, detail = null, ledgerId = null } = {}) {
  try {
    run(
      'INSERT INTO audit_logs (user_id, ledger_id, action, entity, entity_id, detail, ip, ua, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      req?.session?.userId ?? null,
      ledgerId ?? req?.session?.ledgerId ?? null,
      action, entity, entityId,
      detail ? String(detail).slice(0, 500) : null,
      req?.ip || req?.headers?.['x-forwarded-for'] || null,
      (req?.headers?.['user-agent'] || '').slice(0, 200),
      nowStr()
    );
  } catch { /* 审计失败不影响主流程 */ }
}

/* -------------------------------- 登录限流 -------------------------------- */

const attempts = new Map(); // key -> { count, firstAt, lockedUntil }

function loginKey(req, username) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  return `${ip}|${String(username || '').toLowerCase()}`;
}
/** 仅按用户名的二级限流键：trust proxy 场景下 XFF 可伪造，不能让攻击者靠换 IP 无限爆破同一账号 */
function userKey(username) {
  return `u:${String(username || '').toLowerCase()}`;
}
function tooManyAttempts(req, username, max = 10) {
  const now = Date.now();
  for (const k of [loginKey(req, username), userKey(username)]) {
    const rec = attempts.get(k);
    if (!rec) continue;
    if (rec.lockedUntil && rec.lockedUntil > now) {
      return Math.ceil((rec.lockedUntil - now) / 60000);
    }
  }
  return 0;
}
function recordFailure(req, username, max = 10) {
  const keys = [loginKey(req, username), userKey(username)];
  for (const k of keys) {
    const rec = attempts.get(k) || { count: 0, firstAt: Date.now(), lockedUntil: 0 };
    if (Date.now() - rec.firstAt > 15 * 60 * 1000) { rec.count = 0; rec.firstAt = Date.now(); }
    rec.count += 1;
    // 用户名级阈值放宽 3 倍：正常家庭多设备输错也不会误伤，但换 IP 爆破会撞上这层
    if (rec.count >= (k.startsWith('u:') ? max * 3 : max)) rec.lockedUntil = Date.now() + 10 * 60 * 1000;
    attempts.set(k, rec);
  }
}
function clearFailures(req, username) {
  attempts.delete(loginKey(req, username));
  attempts.delete(userKey(username));
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) {
    if ((v.lockedUntil || 0) < now && now - v.firstAt > 30 * 60 * 1000) attempts.delete(k);
  }
}, 10 * 60 * 1000).unref?.();

/* --------------------------------- 中间件 --------------------------------- */

/** 注入当前用户 / 账本等全局变量 */
function context(req, res, next) {
  res.locals.user = null;
  res.locals.ledgers = [];
  res.locals.ledger = null;
  res.locals.settings = null;
  res.locals.unreadCount = 0;
  res.locals.isAdmin = false;
  res.locals.q = req.query || {};
  res.locals.path = req.path;
  res.locals.csrf = csrfToken(req);
  if (req.session?.userId) {
    const u = get('SELECT * FROM users WHERE id = ? AND status = ?', req.session.userId, 'active');
    if (u) {
      res.locals.user = u;
      res.locals.ledgers = all(
        `SELECT l.*, m.role FROM ledgers l
         JOIN ledger_members m ON m.ledger_id = l.id
         WHERE m.user_id = ? AND l.is_archived = 0
         ORDER BY l.sort_order, l.id`,
        u.id
      );
      if (!res.locals.ledgers.length) {
        const any = all(
          `SELECT l.*, m.role FROM ledgers l JOIN ledger_members m ON m.ledger_id = l.id
           WHERE m.user_id = ? ORDER BY l.id`, u.id);
        res.locals.ledgers = any;
      }
      let lid = Number(req.session.ledgerId || 0);
      if (!lid || !res.locals.ledgers.some((l) => Number(l.id) === lid)) {
        lid = res.locals.ledgers[0] ? Number(res.locals.ledgers[0].id) : 0;
        req.session.ledgerId = lid || null;
      }
      res.locals.ledger = res.locals.ledgers.find((l) => Number(l.id) === lid) || null;
      res.locals.unreadCount = Number((get('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0', u.id) || {}).c || 0);
      res.locals.isAdmin = !!u.is_admin;
    } else {
      req.session.userId = null;
    }
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.session?.userId) {
    if (req.xhr || (req.headers.accept || '').includes('application/json')) {
      return res.status(401).json({ ok: false, error: '未登录', redirect: '/login' });
    }
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!res.locals.user?.is_admin) return res.status(403).render('error', { title: '无权限', message: '仅管理员可访问该页面' });
  next();
}

/** 账本权限：返回成员记录或 null */
function membership(userId, ledgerId) {
  if (!userId || !ledgerId) return null;
  return get('SELECT * FROM ledger_members WHERE user_id = ? AND ledger_id = ?', Number(userId), Number(ledgerId));
}

const ROLE_RANK = { viewer: 1, member: 2, admin: 3, owner: 4 };
const ROLE_LABEL = { viewer: '只读', member: '成员', admin: '管理员', owner: '拥有者' };
const canWrite = (role) => (ROLE_RANK[role] || 0) >= ROLE_RANK.member;
const canManage = (role) => (ROLE_RANK[role] || 0) >= ROLE_RANK.admin;

/** 校验对当前账本的写权限 */
function requireLedgerWrite(req, res, next) {
  const m = res.locals.ledger;
  if (!m) return res.status(400).render('error', { title: '没有账本', message: '请先创建一个账本' });
  if (!canWrite(m.role)) return res.status(403).render('error', { title: '只读权限', message: '你在该账本中只有只读权限，无法进行此操作' });
  next();
}
function requireLedgerManage(req, res, next) {
  const m = res.locals.ledger;
  if (!m || !canManage(m.role)) return res.status(403).render('error', { title: '权限不足', message: '需要账本管理员及以上权限' });
  next();
}

/* ---------------------------------- CSRF --------------------------------- */

function csrfToken(req) {
  if (!req.session) return '';
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(20).toString('hex');
  return req.session.csrf;
}

function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = (req.body && (req.body._csrf || req.body.csrf)) || req.headers['x-csrf-token'] || '';
  const expect = req.session?.csrf || '';
  if (!expect || token !== expect) {
    if ((req.headers.accept || '').includes('application/json')) {
      return res.status(403).json({ ok: false, error: 'CSRF 校验失败，请刷新页面重试' });
    }
    return res.status(403).render('error', { title: '会话已过期', message: '安全令牌校验失败，请返回上一页刷新后重试。' });
  }
  next();
}

/* --------------------------------- 通知中心 -------------------------------- */

function notify(userId, { kind = 'info', title, body = null, link = null, ledgerId = null }) {
  run(
    'INSERT INTO notifications (user_id, ledger_id, kind, title, body, link, created_at) VALUES (?,?,?,?,?,?,?)',
    userId, ledgerId, kind, title, body, link, nowStr()
  );
}

/**
 * 该提醒是否已经推送过。
 * 去重键统一以「正文 … |key」的形式写在 body 末尾，所以必须用包含匹配；
 * 用全等匹配会导致同一条提醒每次定时任务都重复推送。
 */
function alreadyNotified(dedupeKey) {
  if (!dedupeKey) return false;
  return !!get("SELECT id FROM notifications WHERE body LIKE '%' || ? || '%' LIMIT 1", dedupeKey);
}

/** 账本内所有可写成员（用于通知与成员统计） */
function ledgerWriterIds(ledgerId) {
  return all(
    "SELECT user_id FROM ledger_members WHERE ledger_id = ? AND role IN ('owner','admin','member')",
    ledgerId
  ).map((r) => Number(r.user_id));
}

module.exports = {
  hashPassword, verifyPassword,
  SqliteSessionStore,
  audit, context, requireLogin, requireAdmin,
  membership, requireLedgerWrite, requireLedgerManage,
  csrfToken, csrfProtect,
  ROLE_RANK, ROLE_LABEL, canWrite, canManage,
  notify, ledgerWriterIds, alreadyNotified,
  tooManyAttempts, recordFailure, clearFailures,
};

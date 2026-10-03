'use strict';
/** 登录 / 注册 / 初始化 / 账本切换 / 邀请加入 */
const express = require('express');
const { all, get, run, nowStr, getSetting } = require('../db');
const auth = require('../lib/auth');
const util = require('../lib/util');

const router = express.Router();

const USERNAME_RE = /^[A-Za-z0-9_.@-]{3,32}$/;

function safeNext(next) {
  if (!next || typeof next !== 'string') return '/';
  // 反斜杠会被浏览器规范化为 /："/\evil.com" 等价 "//evil.com"，必须一并拦截
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}

/* ---------------------------------- 登录 ---------------------------------- */

router.get('/login', (req, res) => {
  if (res.locals.user) return res.redirect('/');
  res.render('login', { title: '登录', next: safeNext(req.query.next), layout: 'layout-blank', error: null, username: '' });
});

router.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const next = safeNext(req.body.next);
  const maxFail = Number(getSetting('security.login_max_fail', '10')) || 10;

  const locked = auth.tooManyAttempts(req, username, maxFail);
  if (locked) {
    return res.status(429).render('login', {
      title: '登录', next, layout: 'layout-blank', username,
      error: `尝试次数过多，请在 ${locked} 分钟后重试。`,
    });
  }
  const user = get('SELECT * FROM users WHERE username = ?', username);
  if (!user || user.status !== 'active' || !auth.verifyPassword(password, user.password_hash)) {
    auth.recordFailure(req, username, maxFail);
    auth.audit(req, 'login.fail', { entity: 'user', detail: username });
    return res.status(401).render('login', {
      title: '登录', next, layout: 'layout-blank', username,
      error: '用户名或密码不正确。',
    });
  }
  auth.clearFailures(req, username);
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('error', { title: '登录失败', message: err.message });
    req.session.userId = Number(user.id);
    req.session.csrf = util.uid(40);
    run('UPDATE users SET last_login_at = ? WHERE id = ?', nowStr(), user.id);
    const m = get('SELECT ledger_id FROM ledger_members WHERE user_id = ? ORDER BY id LIMIT 1', user.id);
    req.session.ledgerId = m ? Number(m.ledger_id) : null;
    auth.audit(req, 'login.success', { entity: 'user', entityId: Number(user.id) });
    req.session.save(() => res.redirect(next));
  });
});

router.post('/logout', auth.requireLogin, (req, res) => {
  auth.audit(req, 'logout');
  req.session.destroy(() => {
    res.clearCookie('hl.sid');
    res.redirect('/login');
  });
});

/* ---------------------------------- 注册 ---------------------------------- */

router.get('/register', (req, res) => {
  if (res.locals.user) return res.redirect('/');
  if (String(getSetting('site.allow_register', 'false')) !== 'true') {
    return res.render('login', {
      title: '登录', next: '/', layout: 'layout-blank', username: '',
      error: '本站未开放自助注册，请联系管理员邀请你加入账本。',
    });
  }
  res.render('register', { title: '注册', layout: 'layout-blank', error: null, form: {} });
});

router.post('/register', (req, res) => {
  if (String(getSetting('site.allow_register', 'false')) !== 'true') {
    return res.status(403).render('error', { title: '注册已关闭', message: '本站未开放自助注册。' });
  }
  const username = String(req.body.username || '').trim();
  const displayName = String(req.body.display_name || '').trim() || username;
  const password = String(req.body.password || '');
  const password2 = String(req.body.password2 || '');
  const email = String(req.body.email || '').trim() || null;
  const fail = (error) => res.status(400).render('register', { title: '注册', layout: 'layout-blank', error, form: { username, display_name: displayName, email } });

  if (!USERNAME_RE.test(username)) return fail('用户名需 3–32 位，仅支持字母、数字、下划线、点、@ 和短横线。');
  if (password.length < 6) return fail('密码至少 6 位。');
  if (password !== password2) return fail('两次输入的密码不一致。');
  if (get('SELECT id FROM users WHERE username = ?', username)) return fail('该用户名已被占用。');

  const info = run(
    'INSERT INTO users (username, email, password_hash, display_name, avatar_color, is_admin, created_at) VALUES (?,?,?,?,?,0,?)',
    username, email, auth.hashPassword(password), displayName.slice(0, 30), util.colorFor(username), nowStr()
  );
  const ledgerId = require('../db').createDefaultLedger(info.lastInsertRowid, displayName);
  auth.audit(req, 'user.register', { entity: 'user', entityId: info.lastInsertRowid, detail: username });
  req.session.regenerate((err) => {
    if (err) return res.redirect('/login');
    req.session.userId = info.lastInsertRowid;
    req.session.ledgerId = ledgerId;
    req.session.csrf = util.uid(40);
    req.session.flash = { type: 'success', message: '注册成功，已为你创建默认账本与账户。' };
    req.session.save(() => res.redirect('/'));
  });
});

/* -------------------------------- 首次初始化 ------------------------------- */

router.get('/setup', (req, res) => {
  const hasUser = Number(get('SELECT COUNT(*) AS c FROM users')?.c || 0) > 0;
  if (hasUser) return res.redirect('/login');
  res.render('setup', { title: '初始化', layout: 'layout-blank', error: null, form: {} });
});

router.post('/setup', (req, res) => {
  const hasUser = Number(get('SELECT COUNT(*) AS c FROM users')?.c || 0) > 0;
  if (hasUser) return res.redirect('/login');
  const username = String(req.body.username || '').trim();
  const displayName = String(req.body.display_name || '').trim() || username;
  const password = String(req.body.password || '');
  const password2 = String(req.body.password2 || '');
  const siteName = String(req.body.site_name || '').trim();
  const fail = (error) => res.status(400).render('setup', { title: '初始化', layout: 'layout-blank', error, form: { username, display_name: displayName, site_name: siteName } });

  if (!USERNAME_RE.test(username)) return fail('用户名需 3–32 位，仅支持字母、数字、下划线、点、@ 和短横线。');
  if (password.length < 8) return fail('管理员密码至少 8 位，建议包含字母与数字。');
  if (password !== password2) return fail('两次输入的密码不一致。');

  const info = run(
    'INSERT INTO users (username, password_hash, display_name, avatar_color, is_admin, created_at) VALUES (?,?,?,?,1,?)',
    username, auth.hashPassword(password), displayName.slice(0, 30), util.colorFor(username), nowStr()
  );
  const ledgerId = require('../db').createDefaultLedger(info.lastInsertRowid, displayName);
  if (siteName) require('../db').setSetting('site.name', siteName.slice(0, 20));
  auth.audit(req, 'setup.done', { entity: 'user', entityId: info.lastInsertRowid });
  req.session.regenerate((err) => {
    if (err) return res.redirect('/login');
    req.session.userId = info.lastInsertRowid;
    req.session.ledgerId = ledgerId;
    req.session.csrf = util.uid(40);
    req.session.save(() => res.redirect('/'));
  });
});

/* ------------------------------- 账本切换 / 邀请 ------------------------------ */

router.post('/ledgers/switch', auth.requireLogin, (req, res) => {
  const id = Number(req.body.ledger_id);
  const m = auth.membership(req.session.userId, id);
  if (m) req.session.ledgerId = id;
  const back = safeNext(req.body.back);
  res.redirect(back);
});

/** 邀请码校验（GET 展示确认页 / POST 执行加入共用）；返回 { invite, ledger } 或已直接响应 */
function resolveInvite(req, res) {
  const code = String(req.params.code || '').trim();
  const invite = get('SELECT * FROM ledger_invites WHERE code = ?', code);
  if (!invite) { res.status(404).render('error', { title: '邀请无效', message: '邀请链接不存在或已被删除。' }); return null; }
  if (invite.expires_at && invite.expires_at < require('../db').todayStr()) {
    res.status(410).render('error', { title: '邀请已过期', message: '请让账本管理员重新生成邀请链接。' }); return null;
  }
  // 已使用的邀请一律不能再入（含本人）：否则被降级/移出的成员可拿旧链接恢复原角色
  if (Number(invite.used_by)) {
    res.status(410).render('error', { title: '邀请已使用', message: '该邀请链接已被使用，请让账本管理员重新生成。' }); return null;
  }
  const ledger = get('SELECT * FROM ledgers WHERE id = ?', invite.ledger_id);
  if (!ledger) { res.status(404).render('error', { title: '账本不存在', message: '该账本已被删除。' }); return null; }
  return { invite, ledger };
}

/** 邀请确认页：GET 不再直接入账（链接预览机器人/误点不会烧掉单用邀请码） */
router.get('/join/:code', auth.requireLogin, (req, res) => {
  const found = resolveInvite(req, res);
  if (!found) return;
  const { invite, ledger } = found;
  if (auth.membership(req.session.userId, invite.ledger_id)) {
    req.session.ledgerId = Number(invite.ledger_id);
    req.session.flash = { type: 'info', message: `你已是账本「${ledger.name}」的成员` };
    return res.redirect('/');
  }
  res.render('join', {
    title: '加入账本', layout: 'layout-blank',
    code: invite.code, ledgerName: ledger.name,
    roleLabel: auth.ROLE_LABEL[invite.role] || '成员',
    creator: (get('SELECT display_name FROM users WHERE id = ?', invite.created_by) || {}).display_name || '—',
    expiresAt: invite.expires_at || '',
    error: null,
  });
});

/** 确认加入（POST） */
router.post('/join/:code', auth.requireLogin, (req, res) => {
  const found = resolveInvite(req, res);
  if (!found) return;
  const { invite, ledger } = found;
  const code = invite.code;
  if (auth.membership(req.session.userId, invite.ledger_id)) {
    req.session.ledgerId = Number(invite.ledger_id);
    req.session.flash = { type: 'info', message: `你已是账本「${ledger.name}」的成员` };
    return res.redirect('/');
  }

  require('../db').addLedgerMember(invite.ledger_id, req.session.userId, invite.role || 'member');
  run('UPDATE ledger_invites SET used_by = ?, used_at = ? WHERE id = ?', req.session.userId, nowStr(), invite.id);
  req.session.ledgerId = Number(invite.ledger_id);
  auth.audit(req, 'ledger.join', { ledgerId: Number(invite.ledger_id), detail: `邀请码 ${code}` });
  for (const uid of auth.ledgerWriterIds(invite.ledger_id)) {
    if (Number(uid) === Number(req.session.userId)) continue;
    auth.notify(uid, {
      kind: 'info', ledgerId: Number(invite.ledger_id),
      title: `${res.locals.user.display_name} 加入了账本「${ledger.name}」`,
      link: '/members',
    });
  }
  req.session.flash = { type: 'success', message: `已加入账本「${ledger.name}」` };
  res.redirect('/');
});

module.exports = router;

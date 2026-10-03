'use strict';
/**
 * 开放 API：供小龙虾（OpenClaw / PicoClaw）、Hermes Agent、快捷指令等外部工具调用。
 * 鉴权：Authorization: Bearer <令牌>（在「设置 → 开放 API」中创建）。
 * 本路由挂在全局 CSRF 中间件之前，不走会话；令牌只存 SHA-256 摘要。
 *
 * 权限模型（令牌效力跟随成员关系，被移出账本/禁用即失效）：
 *   · 读取   —— 任何账本成员（含只读）
 *   · 写入   —— 账本可写成员（member 及以上）：交易/账户/分类/标签/借贷/预算/目标/订阅/周期账单
 *   · 站点设置 —— 仅站点管理员：站点与 AI 配置
 *   · 永不开放 —— 令牌管理、跨账本访问、读取任何密钥明文
 * 所有写入动作都进审计日志。
 */
const crypto = require('node:crypto');
const express = require('express');
const { all, get, run, nowStr, todayStr, TXN_TYPES, TXN_TYPE_MAP, setSetting } = require('../db');
const auth = require('../lib/auth');
const ai = require('../lib/ai');
const txn = require('../lib/txn');
const fd = require('../lib/formdata');
const att = require('../lib/attachments');
const subs = require('../lib/subscriptions');
const sch = require('../lib/scheduler');
const u = require('../lib/util');

const router = express.Router();

/* ------------------------------- 令牌工具 -------------------------------- */

function hashToken(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

/* ------------------------------- 鉴权中间件 ------------------------------- */

function requireToken(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  const plain = m ? m[1].trim() : '';
  if (!plain) return res.status(401).json({ ok: false, error: '缺少 Bearer 令牌（Authorization: Bearer <令牌>）' });

  const row = get(
    `SELECT t.*, u.username, u.status AS user_status, u.is_admin AS user_is_admin
     FROM api_tokens t JOIN users u ON u.id = t.user_id
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

  req.openAuth = {
    userId: Number(row.user_id), username: row.username, ledgerId,
    tokenId: Number(row.id), tokenName: row.name,
    role: member.role, isSiteAdmin: !!row.user_is_admin,
  };
  run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', nowStr(), row.id);
  next();
}

router.use(requireToken);

/* ------------------------------ 每令牌频控 ------------------------------ */
/* Hermes / OpenClaw 是会自主循环调工具的 agent，失控时会无限刷接口；
   /ai/bill 还会消耗已配置的视觉模型额度，单独收紧。 */
const RATE_RULES = [
  { match: (p) => p === '/ai/bill' || p === '/ai/bill/', max: 10, windowMs: 60 * 1000 },
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

/* ------------------------------ 角色分层 ------------------------------ */

/** 读取：任何账本成员（requireToken 已确保成员关系） */
/** 写入：账本可写成员 */
function requireWrite(req, res, next) {
  if (!auth.canWrite(req.openAuth.role)) {
    return res.status(403).json({ ok: false, error: '该令牌所属用户在此账本中只有只读权限，无法执行写操作' });
  }
  next();
}
/** 站点设置：仅站点管理员 */
function requireSiteAdmin(req, res, next) {
  if (!req.openAuth.isSiteAdmin) {
    return res.status(403).json({ ok: false, error: '该操作需要站点管理员令牌' });
  }
  next();
}

/* ------------------------------- 通用工具 -------------------------------- */

/** 中文/英文别名 → 标准 type key（null 原型防 prototype 键绕过白名单） */
const TYPE_ALIASES = (() => {
  const map = Object.assign(Object.create(null), {
    支出: 'expense', 收入: 'income', 转账: 'transfer', 借出: 'lend', 借入: 'borrow', 收回借款: 'repay_receive', 偿还借款: 'repay_pay',
  });
  for (const t of TXN_TYPES) map[t.key] = t.key;
  return map;
})();

/** 外键归属校验：账户/分类必须属于本账本（或系统分类），防止把他账本 id 挂进本账本 */
function validAccountId(ledgerId, id) {
  if (!id) return null;
  const a = get('SELECT id FROM accounts WHERE id = ? AND ledger_id = ?', Number(id), ledgerId);
  return a ? Number(a.id) : null;
}
function validCategoryId(ledgerId, id) {
  if (!id) return null;
  const c = get('SELECT id FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)', Number(id), ledgerId);
  return c ? Number(c.id) : null;
}

/** 批量 ids：去重 + 数量上限（超限抛 400，由路由错误中间件统一返回 JSON） */
function readBulkIds(body) {
  const raw = [...new Set([].concat((body || {}).ids || []).map(Number).filter(Boolean))];
  if (raw.length > 1000) {
    const e = new Error('ids 一次最多 1000 个');
    e.status = 400;
    throw e;
  }
  return raw;
}

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ok = (res, data) => res.json({ ok: true, ...data });
const bad = (res, status, error) => res.status(status).json({ ok: false, error });

/** 表单体 / JSON 统一取金额（分） */
const cents = (v) => u.parseAmountToCents(v);

/** 交易请求体 → createTransaction/updateTransaction 的 d（支持账户/分类按名称解析） */
function readTxnBody(ledgerId, body, { createdAccounts = [] } = {}) {
  const type = TYPE_ALIASES[String(body.type || 'expense').trim()] || 'expense';
  let amountCents;
  if (body.amount_cents != null) amountCents = Math.round(Number(body.amount_cents) || 0);
  else if (body.amount != null) amountCents = Math.round(Number(body.amount) * 100) || 0;
  const isTransfer = ['transfer', 'invest_buy', 'invest_sell'].includes(type);
  const kind = type === 'income' || ['refund', 'interest', 'repay_receive', 'reimburse'].includes(type) ? 'income' : 'expense';
  let category = null;
  if (body.category_id != null && body.category_id !== '') {
    category = get('SELECT id FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)', Number(body.category_id), ledgerId);
  } else if (body.category != null) {
    category = resolveCategory(ledgerId, body.category, kind);
  }
  const splits = Array.isArray(body.splits)
    ? body.splits.map((s) => ({ member_name: String(s.member_name || s.name || '').slice(0, 30), share_cents: Math.round(Number(s.share_cents ?? s.share ?? 0) || 0) })).filter((s) => s.member_name && s.share_cents)
    : undefined;
  const accountId = body.account_id != null && body.account_id !== '' ? Number(body.account_id) : resolveAccount(ledgerId, body.account || body.account_name, { created: createdAccounts });
  const toAccountId = isTransfer
    ? (body.to_account_id != null && body.to_account_id !== '' ? Number(body.to_account_id) : resolveAccount(ledgerId, body.to_account || body.to_account_name, { created: createdAccounts }))
    : null;
  return {
    type,
    amount_cents: amountCents,
    currency: String(body.currency || 'CNY').toUpperCase().slice(0, 8),
    account_id: accountId,
    to_account_id: toAccountId,
    category_id: category ? Number(category.id) : null,
    txn_date: DATE_RE.test(String(body.date || body.txn_date || '')) ? String(body.date || body.txn_date) : todayStr(),
    note: body.note || '',
    merchant: body.merchant || '',
    tags: body.tags || '',
    status: body.status === 'pending' ? 'pending' : 'cleared',
    is_reimbursable: body.is_reimbursable ? 1 : 0,
    splits,
    source: 'api_open',
  };
}

/* --------------------------------- 连通性 -------------------------------- */

router.get('/ping', (req, res) => {
  res.json({
    ok: true,
    app: 'homeledger',
    ledger_id: req.openAuth.ledgerId,
    user: req.openAuth.username,
    token: req.openAuth.tokenName,
    role: req.openAuth.role,
    site_admin: req.openAuth.isSiteAdmin,
    today: todayStr(),
  });
});

/* ------------------------------- 查询：交易 ------------------------------- */

/** 最近记账（含关联的账单截图），便于外部工具在聊天里回执「记好了 + 原图」
 *  注意：必须定义在 /transactions/:id 之前，否则 "recent" 会被当成 id 吞掉 */
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
  ok(res, {
    count: rows.length,
    transactions: rows.map((r) => ({
      ...r,
      images: (imgMap.get(Number(r.id)) || []).map((i) => ({ id: i.id, path: `/uploads/${i.rel_path}`, size: i.size })),
    })),
  });
});

router.get('/transactions', (req, res) => {
  const { ledgerId } = req.openAuth;
  const q = req.query;
  const f = {
    type: TYPE_ALIASES[String(q.type || '').trim()] || q.type || '',
    kind: q.kind || '',
    categoryId: q.category_id ? Number(q.category_id) : null,
    accountId: q.account_id ? Number(q.account_id) : null,
    memberId: q.member_id ? Number(q.member_id) : null,
    tagId: q.tag_id ? Number(q.tag_id) : null,
    source: q.source || '',
    month: /^\d{4}-\d{2}$/.test(String(q.month || '')) ? q.month : '',
    from: DATE_RE.test(String(q.from || '')) ? q.from : '',
    to: DATE_RE.test(String(q.to || '')) ? q.to : '',
    keyword: q.q || q.keyword || '',
    reimbursable: q.reimbursable || '',
    sort: ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'].includes(q.sort) ? q.sort : 'date_desc',
    page: Math.max(1, Number(q.page) || 1),
    pageSize: Math.min(200, Math.max(1, Number(q.page_size) || 30)),
  };
  const result = txn.listTransactions(ledgerId, f);
  // 一次性取附件数与图片，避免逐行查询
  const imgMap = att.listByTxnIds(result.rows.map((t) => t.id));
  ok(res, {
    total: result.total, page: result.page, page_size: result.pageSize, pages: result.pages,
    sum: { income: result.sum.income, expense: result.sum.expense },
    transactions: result.rows.map((t) => ({
      id: t.id, type: t.type, type_label: t.type_label,
      amount_cents: t.amount_cents, amount_base_cents: t.amount_base_cents, currency: t.currency,
      txn_date: t.txn_date, merchant: t.merchant, note: t.note,
      category: t.category_path, category_id: t.category_id,
      account: t.account_name, to_account: t.to_account_name,
      member: t.member_name, tags: t.tag_names, status: t.status,
      is_reimbursable: !!t.is_reimbursable, reimbursed_at: t.reimbursed_at,
      source: t.source, attachment_count: t.attachment_count || 0,
      images: (imgMap.get(Number(t.id)) || []).map((i) => ({ id: i.id, path: `/uploads/${i.rel_path}`, size: i.size })),
    })),
  });
});

router.get('/transactions/:id', (req, res) => {
  const { ledgerId } = req.openAuth;
  const t = txn.getTransaction(Number(req.params.id), ledgerId);
  if (!t) return bad(res, 404, '记录不存在');
  ok(res, {
    transaction: { ...t, images: att.listByTxn(t.id).map((i) => ({ id: i.id, path: `/uploads/${i.rel_path}`, size: i.size })), splits: txn.splitsOf(t.id) },
  });
});

/* ------------------------------- 查询：统计 ------------------------------- */

router.get('/summary', (req, res) => {
  const { ledgerId } = req.openAuth;
  const from = DATE_RE.test(String(req.query.from || '')) ? req.query.from : todayStr().slice(0, 7) + '-01';
  const to = DATE_RE.test(String(req.query.to || '')) ? req.query.to : todayStr();
  ok(res, { from, to, ...txn.summary(ledgerId, from, to) });
});

router.get('/reports/categories', (req, res) => {
  const { ledgerId } = req.openAuth;
  const from = DATE_RE.test(String(req.query.from || '')) ? req.query.from : todayStr().slice(0, 7) + '-01';
  const to = DATE_RE.test(String(req.query.to || '')) ? req.query.to : todayStr();
  const kind = req.query.kind === 'income' ? 'income' : 'expense';
  const top = req.query.top || null;
  ok(res, {
    from, to, kind,
    categories: top ? txn.subcategoryBreakdown(ledgerId, from, to, kind, top) : txn.categoryBreakdown(ledgerId, from, to, kind),
  });
});

router.get('/reports/trend', (req, res) => {
  const { ledgerId } = req.openAuth;
  ok(res, { months: Math.min(24, Math.max(2, Number(req.query.months) || 6)), trend: txn.monthlyTrend(ledgerId, Math.min(24, Math.max(2, Number(req.query.months) || 6))) });
});

/* ------------------------------- 查询：账户 ------------------------------- */

router.get('/accounts', (req, res) => {
  const { ledgerId } = req.openAuth;
  const overview = txn.accountOverview(ledgerId);
  ok(res, {
    net: overview.net, assets: overview.assets, liabilities: overview.liabilities,
    accounts: overview.accounts.map((a) => ({
      id: a.id, name: a.name, type: a.type, icon: a.icon, currency: a.currency,
      balance_cents: Number(a.balance_cents), initial_cents: Number(a.initial_cents),
      credit_limit: a.credit_limit ? Number(a.credit_limit) : null,
      bill_day: a.bill_day, due_day: a.due_day, is_archived: !!a.is_archived,
    })),
  });
});

router.get('/categories', (req, res) => {
  const { ledgerId } = req.openAuth;
  ok(res, { categories: fd.flatCategories(ledgerId).map((c) => ({ id: c.id, name: c.name, path: c.path, kind: c.kind, icon: c.icon, color: c.color, parent_id: c.parent_id, is_system: !!c.is_system })) });
});

router.get('/tags', (req, res) => {
  const { ledgerId } = req.openAuth;
  ok(res, { tags: fd.tags(ledgerId) });
});

/* ------------------------------- 查询：计划 ------------------------------- */

router.get('/debts', (req, res) => {
  const { ledgerId } = req.openAuth;
  const debts = all(
    `SELECT d.*, a.name AS account_name FROM debts d LEFT JOIN accounts a ON a.id = d.account_id
     WHERE d.ledger_id = ? ORDER BY d.status DESC, COALESCE(d.due_date, '9999') LIMIT 300`,
    ledgerId
  );
  const open = debts.filter((d) => d.status === 'open');
  ok(res, {
    receivable: open.filter((d) => d.direction === 'receivable').reduce((s, d) => s + Number(d.balance_cents), 0),
    payable: open.filter((d) => d.direction === 'payable').reduce((s, d) => s + Number(d.balance_cents), 0),
    debts,
  });
});

router.get('/budgets', (req, res) => {
  const { ledgerId } = req.openAuth;
  const budgets = all(
    `SELECT b.*, c.name AS category_name, a.name AS account_name
     FROM budgets b LEFT JOIN categories c ON c.id = b.category_id LEFT JOIN accounts a ON a.id = b.account_id
     WHERE b.ledger_id = ? ORDER BY b.is_active DESC, b.id`,
    ledgerId
  ).map((b) => {
    const range = sch.budgetPeriodRange(b, new Date());
    const used = sch.budgetUsedInRange(b, range.start, range.end);
    const amount = Number(b.amount_cents);
    return { ...b, used, range_label: range.label, ratio: amount > 0 ? (used / amount) * 100 : 0, remain: amount - used };
  });
  ok(res, { budgets });
});

router.get('/goals', (req, res) => {
  const { ledgerId } = req.openAuth;
  ok(res, { goals: all('SELECT * FROM goals WHERE ledger_id = ? ORDER BY CASE status WHEN \'active\' THEN 0 ELSE 1 END, id', ledgerId) });
});

router.get('/subscriptions', (req, res) => {
  const { ledgerId } = req.openAuth;
  const sums = subs.overview(ledgerId);
  ok(res, {
    monthly_total: sums.monthlyTotal, annual_total: sums.annualTotal,
    due_this_month: sums.dueThisMonth, this_month_charged: sums.thisMonthCharged,
    subscriptions: sums.items,
  });
});

router.get('/recurring', (req, res) => {
  const { ledgerId } = req.openAuth;
  const rules = all('SELECT * FROM recurring_rules WHERE ledger_id = ? ORDER BY is_active DESC, next_run_at', ledgerId).map((r) => ({
    ...r, payload: undefined, items: sch.ruleItems(r.payload),
  }));
  ok(res, { rules });
});

/* -------------------------------- 查询：设置 ------------------------------ */

router.get('/settings', (req, res) => {
  const cfg = ai.getAiConfig();
  ok(res, {
    site: { name: require('../db').getSetting('site.name', '家账簿'), currency: require('../db').getSetting('site.currency', 'CNY') },
    ai: {
      enabled: cfg.enabled, base_url: cfg.baseUrl, model: cfg.model,
      vision: cfg.vision, timeout_ms: cfg.timeoutMs, auto_save: cfg.autoSave,
      api_key_set: !!cfg.apiKey,
    },
  });
});

router.get('/ai/models', requireSiteAdmin, async (req, res) => {
  // 站点管理员专属：不带自定义 Key 时会回退到站点已保存的 Key 去请求 base_url，
  // 若对普通成员开放，等于可让服务器把站点 AI Key 发到任意 URL（SSRF + 密钥外发）
  try {
    const r = await ai.listModels({ baseUrl: req.query.base_url, apiKey: req.headers['x-ai-api-key'] || undefined });
    ok(res, { base_url: r.baseUrl, count: r.count, models: r.models });
  } catch (e) {
    bad(res, 400, e.message);
  }
});

/* -------------------------------- 记一笔 --------------------------------- */

router.post('/transactions', requireWrite, (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const body = req.body || {};
  try {
    const createdAccounts = [];
    const d = readTxnBody(ledgerId, body, { createdAccounts });
    const txnId = txn.createTransaction(ledgerId, userId, d);
    auth.audit(req, 'api.txn.create', {
      ledgerId, entity: 'transaction', entityId: txnId,
      detail: `开放API·${req.openAuth.tokenName} 记 ${d.type} ¥${(Math.abs(d.amount_cents || 0) / 100).toFixed(2)}`,
    });
    ok(res, { id: txnId, category_id: d.category_id, account_id: d.account_id, accounts_created: createdAccounts });
  } catch (e) {
    bad(res, 400, e.message);
  }
});

/* 批量操作：必须定义在 /transactions/:id 之前，否则 "bulk-*" 会被当成 id */
router.post('/transactions/bulk-delete', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const ids = readBulkIds(req.body);
  if (!ids.length) return bad(res, 400, '请提供 ids 数组');
  const n = txn.bulkDelete(ids, ledgerId);
  auth.audit(req, 'api.txn.bulkDelete', { ledgerId, detail: `开放API·${req.openAuth.tokenName} 批量删除 ${n} 笔` });
  ok(res, { deleted: n });
});

router.post('/transactions/bulk-category', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const ids = readBulkIds(req.body);
  const cid = validCategoryId(ledgerId, Number((req.body || {}).category_id));
  if (!ids.length || !cid) return bad(res, 400, '请提供 ids 与 category_id');
  const ph = ids.map(() => '?').join(',');
  const info = run(`UPDATE transactions SET category_id = ?, updated_at = ? WHERE ledger_id = ? AND id IN (${ph})`, cid, nowStr(), ledgerId, ...ids);
  auth.audit(req, 'api.txn.bulkCategory', { ledgerId, detail: `开放API·${req.openAuth.tokenName} 批量改分类 ${info.changes} 笔` });
  ok(res, { updated: info.changes });
});

router.post('/transactions/bulk-tag', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const ids = readBulkIds(req.body);
  const tag = String((req.body || {}).tag || '').trim();
  if (!ids.length || !tag) return bad(res, 400, '请提供 ids 与 tag');
  // 只给本账本存在且未删除的交易挂标签
  const ph = ids.map(() => '?').join(',');
  const owned = all(`SELECT id FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND id IN (${ph})`, ledgerId, ...ids).map((r) => Number(r.id));
  for (const id of owned) txn.applyTags(id, ledgerId, tag, false);
  auth.audit(req, 'api.txn.bulkTag', { ledgerId, detail: `开放API·${req.openAuth.tokenName} 批量加标签「${tag}」${owned.length} 笔` });
  ok(res, { tagged: owned.length });
});

router.post('/transactions/bulk-reimburse', requireWrite, (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const ids = readBulkIds(req.body);
  if (!ids.length) return bad(res, 400, '请提供 ids 数组');
  // 未指定入账账户时回落到账本第一个可用账户，避免报销收入悬空
  const accountId = (req.body || {}).account_id
    ? validAccountId(ledgerId, Number(req.body.account_id))
    : Number(get('SELECT id FROM accounts WHERE ledger_id = ? AND is_archived = 0 ORDER BY sort_order, id LIMIT 1', ledgerId)?.id) || null;
  try {
    const r = txn.markReimbursed(ids, ledgerId, userId, accountId);
    auth.audit(req, 'api.txn.bulkReimburse', { ledgerId, detail: `开放API·${req.openAuth.tokenName} 报销 ${r.count} 笔` });
    ok(res, { txn_id: r.txnId, count: r.count, total_cents: r.total });
  } catch (e) {
    bad(res, 400, e.message);
  }
});

/** 修改一笔：只覆盖请求里给出的字段，其余沿用原值 */
router.post('/transactions/:id', requireWrite, (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const id = Number(req.params.id);
  const old = txn.getTransaction(id, ledgerId);
  if (!old) return bad(res, 404, '记录不存在');
  const body = req.body || {};
  try {
    const createdAccounts = [];
    // 显式给出的字段优先；未给出的沿用原值；按名称给账户/分类时才做名称解析
    // 金额沿用原值时不取绝对值：adjust 交易是带符号的（调减为负），abs 会把调减翻成调增
    const rawDate = body.date ?? body.txn_date;
    const merged = {
      type: body.type ?? old.type,
      amount: body.amount_cents != null ? undefined : (body.amount ?? (Number(old.amount_cents) / 100)),
      amount_cents: body.amount_cents ?? undefined,
      currency: body.currency ?? old.currency,
      account_id: body.account_id ?? (body.account != null ? undefined : old.account_id),
      account: body.account,
      to_account_id: body.to_account_id ?? (body.to_account != null ? undefined : old.to_account_id),
      to_account: body.to_account,
      category_id: body.category_id ?? (body.category != null ? undefined : old.category_id),
      category: body.category,
      date: rawDate != null ? (DATE_RE.test(String(rawDate)) ? rawDate : old.txn_date) : old.txn_date,
      note: body.note ?? old.note ?? '',
      merchant: body.merchant ?? old.merchant ?? '',
      tags: body.tags ?? old.tag_names ?? '',
      status: body.status ?? old.status,
      is_reimbursable: body.is_reimbursable ?? !!old.is_reimbursable,
      splits: body.splits,
    };
    const txnId = txn.updateTransaction(id, ledgerId, userId, readTxnBody(ledgerId, merged, { createdAccounts }));
    auth.audit(req, 'api.txn.update', { ledgerId, entity: 'transaction', entityId: txnId, detail: `开放API·${req.openAuth.tokenName} 修改` });
    ok(res, { id: txnId, accounts_created: createdAccounts });
  } catch (e) {
    bad(res, 400, e.message);
  }
});

function softDeleteHandler(req, res) {
  const { ledgerId } = req.openAuth;
  const done = txn.softDelete(Number(req.params.id), ledgerId);
  if (!done) return bad(res, 404, '记录不存在');
  auth.audit(req, 'api.txn.delete', { ledgerId, entity: 'transaction', entityId: Number(req.params.id), detail: `开放API·${req.openAuth.tokenName} 删除` });
  ok(res, { deleted: Number(req.params.id) });
}
router.post('/transactions/:id/delete', requireWrite, softDeleteHandler);
router.delete('/transactions/:id', requireWrite, softDeleteHandler);

router.post('/transactions/:id/restore', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const id = Number(req.params.id);
  const r = get('SELECT id FROM transactions WHERE id = ? AND ledger_id = ? AND deleted_at IS NOT NULL', id, ledgerId);
  if (!r) return bad(res, 404, '没有可恢复的已删除记录');
  run('UPDATE transactions SET deleted_at = NULL, updated_at = ? WHERE id = ?', nowStr(), id);
  require('../db').recalcBalances(ledgerId);
  // 借贷类交易恢复后同步重建自动汇总台账
  txn.syncDebts(ledgerId);
  auth.audit(req, 'api.txn.restore', { ledgerId, entity: 'transaction', entityId: id });
  ok(res, { restored: id });
});

/* ----------------------------- 截图 / 文本识别 ----------------------------- */

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

router.post('/ai/bill', requireWrite, async (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const body = req.body || {};
  try {
    const rawImages = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
    const text = String(body.text || '').slice(0, 4000);
    if (!rawImages.length && !text) {
      return bad(res, 400, '请提供 images（dataURL 数组）或 text 账单文字');
    }
    const images = [];
    for (const img of rawImages) {
      const url = String((img && (img.dataUrl || img.url)) || img || '');
      const m = /^data:([^;]+);base64,(.+)$/.exec(url);
      if (!m) return bad(res, 400, 'images 元素必须是 dataURL（data:image/...;base64,xxx）');
      if (Buffer.byteLength(m[2], 'base64') > MAX_IMAGE_BYTES) return bad(res, 400, '单张图片请小于 8MB');
      images.push({ dataUrl: url });
    }

    const confirm = body.confirm === true || body.confirm === 'true' || body.confirm === 1;
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
      return ok(res, {
        engine: result.engine, model: result.model || null,
        warnings, drafts: result.items, confirmed: false,
        images: savedImages.map((s) => ({ id: s.id, path: `/uploads/${s.rel}`, size: s.size, txn_id: null })),
        hint: '检查 drafts 无误后，用 confirm=true 重新调用即可直接入库（图片会随记录一起保存并关联）',
      });
    }

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
    const linked = att.linkImagesToTxns({ ledgerId, imageIds: savedImages.map((s) => s.id), txnIds: created });

    auth.audit(req, 'api.ai.bill', {
      ledgerId, detail: `开放API·${req.openAuth.tokenName} ${result.engine} 识别并入库 ${created.length} 笔，图片 ${savedImages.length} 张`,
    });
    res.json({
      ok: created.length > 0,
      engine: result.engine, model: result.model || null,
      warnings, accounts_created: createdAccounts,
      confirmed: true, created: created.length, ids: created, errors,
      images: savedImages.map((s) => ({
        id: s.id, path: `/uploads/${s.rel}`, size: s.size,
        txn_id: (linked.find((l) => l.image_id === s.id) || {}).txn_id ?? null,
      })),
    });
  } catch (e) {
    bad(res, 400, e.message);
  }
});

/* ---------------------------- 记录 / 截图回查 ----------------------------- */

/** 取回某张账单截图（需令牌；网页端 /uploads/<rel_path> 同样可直接访问） */
router.get('/attachments/:id', (req, res) => {
  const { ledgerId } = req.openAuth;
  const found = att.resolveFile(ledgerId, req.params.id);
  if (!found) return bad(res, 404, '截图不存在');
  res.type(att.safeMime(found.row.mime));
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(found.abs);
});

/* --------------------------------- 账户管理 -------------------------------- */

router.post('/accounts', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return bad(res, 400, '请填写账户名称');
  const type = require('../db').ACCOUNT_TYPE_MAP[body.type] ? body.type : 'cash';
  const initial = body.initial_balance != null ? cents(body.initial_balance) : (body.initial_cents != null ? Math.round(Number(body.initial_cents) || 0) : 0);
  const info = run(
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, credit_limit,
      bill_day, due_day, note, include_in_net, sort_order, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ledgerId, name.slice(0, 30), type, String(body.icon || require('../db').ACCOUNT_TYPE_MAP[type].icon).slice(0, 8), body.currency || 'CNY',
    initial, initial,
    body.credit_limit ? cents(body.credit_limit) : null,
    body.bill_day ? Number(body.bill_day) : null,
    body.due_day ? Number(body.due_day) : null,
    body.note ? String(body.note).slice(0, 200) : null,
    body.include_in_net === false ? 0 : 1,
    Number(body.sort_order) || 50, nowStr()
  );
  auth.audit(req, 'api.account.create', { ledgerId, entity: 'account', entityId: info.lastInsertRowid, detail: name });
  ok(res, { id: Number(info.lastInsertRowid) });
});

function findAccount(req, res) {
  const a = get('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', Number(req.params.id), req.openAuth.ledgerId);
  if (!a) { bad(res, 404, '账户不存在'); return null; }
  return a;
}

router.post('/accounts/:id', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const acc = findAccount(req, res);
  if (!acc) return;
  const body = req.body || {};
  run(
    `UPDATE accounts SET name=?, type=?, icon=?, currency=?, initial_cents=?, credit_limit=?, bill_day=?, due_day=?,
      note=?, include_in_net=? WHERE id=?`,
    String(body.name || acc.name).slice(0, 30),
    require('../db').ACCOUNT_TYPE_MAP[body.type] ? body.type : acc.type,
    body.icon ? String(body.icon).slice(0, 8) : acc.icon,
    body.currency || acc.currency,
    body.initial_balance != null ? cents(body.initial_balance) : (body.initial_cents != null ? Math.round(Number(body.initial_cents) || 0) : Number(acc.initial_cents)),
    body.credit_limit != null ? (body.credit_limit === '' || body.credit_limit === null ? null : cents(body.credit_limit)) : acc.credit_limit,
    body.bill_day != null ? (body.bill_day ? Number(body.bill_day) : null) : acc.bill_day,
    body.due_day != null ? (body.due_day ? Number(body.due_day) : null) : acc.due_day,
    body.note != null ? String(body.note).slice(0, 200) : acc.note,
    body.include_in_net != null ? (body.include_in_net ? 1 : 0) : acc.include_in_net,
    acc.id
  );
  require('../db').recalcBalances(ledgerId);
  auth.audit(req, 'api.account.update', { ledgerId, entity: 'account', entityId: acc.id });
  ok(res, { id: acc.id });
});

router.post('/accounts/:id/archive', requireWrite, (req, res) => {
  const acc = findAccount(req, res);
  if (!acc) return;
  run('UPDATE accounts SET is_archived = ? WHERE id = ?', acc.is_archived ? 0 : 1, acc.id);
  auth.audit(req, 'api.account.archive', { ledgerId: req.openAuth.ledgerId, entity: 'account', entityId: acc.id, detail: acc.is_archived ? '恢复' : '停用' });
  ok(res, { id: acc.id, is_archived: !acc.is_archived });
});

router.post('/accounts/:id/delete', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const acc = findAccount(req, res);
  if (!acc) return;
  const used = Number(get('SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ? AND (account_id = ? OR to_account_id = ?)', ledgerId, acc.id, acc.id)?.c || 0);
  if (used > 0) return bad(res, 400, `该账户下有 ${used} 笔记录，无法删除。可改为「停用」。`);
  run('DELETE FROM accounts WHERE id = ? AND ledger_id = ?', acc.id, ledgerId);
  auth.audit(req, 'api.account.delete', { ledgerId, entity: 'account', entityId: acc.id, detail: acc.name });
  ok(res, { deleted: acc.id });
});

/** 余额调整：把账面余额拉平到实际值，差额记一笔 adjust（调减为负，不影响收支统计） */
router.post('/accounts/:id/adjust', requireWrite, (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const acc = findAccount(req, res);
  if (!acc) return;
  const body = req.body || {};
  const actual = body.actual_cents != null ? Math.round(Number(body.actual_cents) || 0) : cents(body.actual_balance);
  const delta = actual - Number(acc.balance_cents);
  if (!delta) return bad(res, 400, '余额一致，无需调整');
  try {
    const id = txn.createTransaction(ledgerId, userId, {
      type: 'adjust', amount_cents: delta, account_id: acc.id,
      txn_date: DATE_RE.test(String(body.date || body.adjust_date || '')) ? (body.date || body.adjust_date) : todayStr(),
      note: `余额调整：${u.fmtAmount(acc.balance_cents)} → ${u.fmtAmount(actual)}${body.note ? ' · ' + body.note : ''}`,
      source: 'manual',
    });
    auth.audit(req, 'api.account.adjust', { ledgerId, entity: 'account', entityId: acc.id, detail: String(delta) });
    ok(res, { txn_id: id, delta_cents: delta, balance_cents: actual });
  } catch (e) {
    bad(res, 400, e.message);
  }
});

/* ------------------------------ 分类 / 标签 ------------------------------ */

router.post('/categories', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return bad(res, 400, '请填写分类名称');
  const kind = body.kind === 'income' ? 'income' : 'expense';
  const parentId = body.parent_id ? Number(body.parent_id) : null;
  let color = u.safeColor(body.color, '#8c8c8c');
  if (parentId) {
    const p = get('SELECT color, kind, ledger_id, is_system FROM categories WHERE id = ?', parentId);
    if (!p || p.is_system || p.ledger_id === null || Number(p.ledger_id) !== ledgerId) return bad(res, 404, '父分类不存在（系统分类不可作为父级）');
    if (p.kind !== kind) return bad(res, 400, '父分类与目标分类的收支类型不一致');
    if (!body.color && p.color) color = p.color;
  }
  const info = run(
    'INSERT INTO categories (ledger_id, name, kind, parent_id, icon, color, is_system, sort_order) VALUES (?,?,?,?,?,?,0,?)',
    ledgerId, name.slice(0, 20), kind, parentId, String(body.icon || '🏷️').slice(0, 8), color, 999
  );
  auth.audit(req, 'api.category.create', { ledgerId, entity: 'category', entityId: info.lastInsertRowid, detail: name });
  ok(res, { id: Number(info.lastInsertRowid) });
});

function findCategory(req, res) {
  const c = get('SELECT * FROM categories WHERE id = ?', Number(req.params.id));
  // 系统分类（ledger_id IS NULL）全站共享，读可以，改删不允许
  if (!c || (c.ledger_id !== null && Number(c.ledger_id) !== req.openAuth.ledgerId)) { bad(res, 404, '分类不存在'); return null; }
  return c;
}

router.post('/categories/:id', requireWrite, (req, res) => {
  const c = findCategory(req, res);
  if (!c) return;
  if (c.is_system || c.ledger_id === null) return bad(res, 403, '系统内置分类不可修改（可新建自己的分类）');
  const body = req.body || {};
  run('UPDATE categories SET name=?, icon=?, color=? WHERE id = ?',
    String(body.name || c.name).slice(0, 20), body.icon ? String(body.icon).slice(0, 8) : c.icon, u.safeColor(body.color, c.color), c.id);
  auth.audit(req, 'api.category.update', { ledgerId: req.openAuth.ledgerId, entity: 'category', entityId: c.id });
  ok(res, { id: c.id });
});

router.post('/categories/:id/delete', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const c = findCategory(req, res);
  if (!c) return;
  if (c.is_system || c.ledger_id === null) return bad(res, 403, '系统内置分类不可删除');
  const used = Number(get('SELECT COUNT(*) AS c FROM transactions WHERE category_id = ?', c.id)?.c || 0);
  if (used > 0) {
    run('UPDATE categories SET is_archived = 1 WHERE id = ?', c.id);
    auth.audit(req, 'api.category.archive', { ledgerId, entity: 'category', entityId: c.id, detail: `有 ${used} 笔流水，改为归档` });
    return ok(res, { id: c.id, archived: true, used });
  }
  run('DELETE FROM categories WHERE id = ?', c.id);
  run('DELETE FROM categories WHERE parent_id = ?', c.id);
  auth.audit(req, 'api.category.delete', { ledgerId, entity: 'category', entityId: c.id, detail: c.name });
  ok(res, { id: c.id, deleted: true });
});

router.post('/tags', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const name = String((req.body || {}).name || '').trim();
  if (!name) return bad(res, 400, '请填写标签名');
  if (get('SELECT id FROM tags WHERE ledger_id = ? AND name = ?', ledgerId, name)) return bad(res, 400, '标签已存在');
  const info = run('INSERT INTO tags (ledger_id, name, color) VALUES (?,?,?)', ledgerId, name.slice(0, 20), u.safeColor((req.body || {}).color, u.colorFor(name)));
  auth.audit(req, 'api.tag.create', { ledgerId, entity: 'tag', entityId: info.lastInsertRowid, detail: name });
  ok(res, { id: Number(info.lastInsertRowid) });
});

router.post('/tags/:id/delete', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const id = Number(req.params.id);
  if (!get('SELECT id FROM tags WHERE id = ? AND ledger_id = ?', id, ledgerId)) return bad(res, 404, '标签不存在');
  run('DELETE FROM transaction_tags WHERE tag_id = ?', id);
  run('DELETE FROM tags WHERE id = ? AND ledger_id = ?', id, ledgerId);
  auth.audit(req, 'api.tag.delete', { ledgerId, entity: 'tag', entityId: id });
  ok(res, { deleted: id });
});

/* --------------------------------- 借贷台账 -------------------------------- */

router.post('/debts', requireWrite, (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const body = req.body || {};
  const counterparty = String(body.counterparty || body.name || '').trim();
  const amount = body.amount_cents != null ? Math.abs(Math.round(Number(body.amount_cents) || 0)) : Math.abs(cents(body.amount));
  const direction = body.direction === 'receivable' || body.direction === '借出' ? 'receivable' : 'payable';
  if (!counterparty || !amount) return bad(res, 400, '请填写对方名称与金额');
  const accountId = validAccountId(ledgerId, body.account_id);
  if (body.create_txn) {
    try {
      const txnId = txn.createTransaction(ledgerId, userId, {
        type: direction === 'receivable' ? 'lend' : 'borrow',
        amount_cents: amount,
        account_id: accountId,
        txn_date: DATE_RE.test(String(body.date || '')) ? body.date : todayStr(),
        merchant: counterparty,
        note: body.note || (direction === 'receivable' ? '借出' : '借入'),
        source: 'manual',
      });
      auth.audit(req, 'api.debt.create', { ledgerId, entity: 'debt', detail: `借台账 ${counterparty}` });
      return ok(res, { txn_id: txnId, synced_to_debts: true });
    } catch (e) {
      return bad(res, 400, e.message);
    }
  }
  const info = run(
    `INSERT INTO debts (ledger_id, direction, counterparty, principal_cents, balance_cents, currency, account_id, due_date, status, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ledgerId, direction, counterparty.slice(0, 40), amount, amount, body.currency || 'CNY',
    accountId, DATE_RE.test(String(body.due_date || '')) ? body.due_date : null, 'open',
    body.note ? String(body.note).slice(0, 200) : null, nowStr()
  );
  auth.audit(req, 'api.debt.create', { ledgerId, entity: 'debt', entityId: info.lastInsertRowid, detail: `${direction} ${counterparty}` });
  ok(res, { id: Number(info.lastInsertRowid), txn_created: false });
});

/** 收/还款：核销台账 + 生成流水（缺省金额 = 全部未还余额） */
router.post('/debts/:id/settle', requireWrite, (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const d = get('SELECT * FROM debts WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (!d) return bad(res, 404, '台账不存在');
  const body = req.body || {};
  const amount = Math.min(
    body.amount_cents != null ? Math.abs(Math.round(Number(body.amount_cents) || 0)) : (body.amount ? Math.abs(cents(body.amount)) : Number(d.balance_cents)),
    Number(d.balance_cents)
  );
  if (!amount) return bad(res, 400, '金额无效');
  try {
    const txnId = txn.createTransaction(ledgerId, userId, {
      type: d.direction === 'receivable' ? 'repay_receive' : 'repay_pay',
      amount_cents: amount,
      account_id: validAccountId(ledgerId, body.account_id) || d.account_id,
      txn_date: DATE_RE.test(String(body.date || '')) ? body.date : todayStr(),
      merchant: d.counterparty,
      note: (d.direction === 'receivable' ? '收回借款 · ' : '偿还借款 · ') + d.counterparty,
      source: 'manual',
    });
    const newBalance = Math.max(0, Number(d.balance_cents) - amount);
    if (d.note !== '系统自动汇总') {
      run('UPDATE debts SET balance_cents = ?, status = ? WHERE id = ?', newBalance, newBalance <= 0 ? 'closed' : 'open', d.id);
    } else {
      txn.syncDebts(ledgerId);
    }
    auth.audit(req, 'api.debt.settle', { ledgerId, entity: 'debt', entityId: d.id, detail: String(amount) });
    ok(res, { txn_id: txnId, remaining_cents: newBalance, closed: newBalance <= 0 });
  } catch (e) {
    bad(res, 400, e.message);
  }
});

router.post('/debts/:id/delete', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const id = Number(req.params.id);
  const d = get('SELECT * FROM debts WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!d) return bad(res, 404, '台账不存在');
  if (d.note === '系统自动汇总') return bad(res, 400, '自动汇总台账由借贷交易生成，请删除对应交易或用「还款」核销');
  run('DELETE FROM debts WHERE id = ? AND ledger_id = ?', id, ledgerId);
  auth.audit(req, 'api.debt.delete', { ledgerId, entity: 'debt', entityId: id, detail: d.counterparty });
  ok(res, { deleted: id });
});

/* --------------------------------- 预算 ---------------------------------- */

router.post('/budgets', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const amount = body.amount_cents != null ? Math.abs(Math.round(Number(body.amount_cents) || 0)) : Math.abs(cents(body.amount));
  if (!name || !amount) return bad(res, 400, '请填写预算名称与金额');
  const scope = ['overall', 'category', 'account'].includes(body.scope) ? body.scope : 'overall';
  const info = run(
    `INSERT INTO budgets (ledger_id, name, scope, category_id, account_id, period, amount_cents, currency,
      trigger_type, rollover, alert_pct, start_date, end_date, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
    ledgerId, name.slice(0, 30), scope,
    scope === 'category' ? validCategoryId(ledgerId, body.category_id) : null,
    scope === 'account' ? validAccountId(ledgerId, body.account_id) : null,
    ['monthly', 'yearly', 'weekly', 'custom'].includes(body.period) ? body.period : 'monthly',
    amount, body.currency || 'CNY',
    body.trigger_type === 'income' ? 'income' : 'expense',
    body.rollover ? 1 : 0,
    Number(body.alert_pct) || 80,
    DATE_RE.test(String(body.start_date || '')) ? body.start_date : null,
    DATE_RE.test(String(body.end_date || '')) ? body.end_date : null,
    nowStr()
  );
  auth.audit(req, 'api.budget.create', { ledgerId, entity: 'budget', entityId: info.lastInsertRowid, detail: name });
  ok(res, { id: Number(info.lastInsertRowid) });
});

function findBudget(req, res) {
  const b = get('SELECT * FROM budgets WHERE id = ? AND ledger_id = ?', Number(req.params.id), req.openAuth.ledgerId);
  if (!b) { bad(res, 404, '预算不存在'); return null; }
  return b;
}

router.post('/budgets/:id', requireWrite, (req, res) => {
  const ledgerId = req.openAuth.ledgerId;
  const b = findBudget(req, res);
  if (!b) return;
  const body = req.body || {};
  run(
    `UPDATE budgets SET name=?, scope=?, category_id=?, account_id=?, period=?, amount_cents=?, trigger_type=?,
      rollover=?, alert_pct=?, start_date=?, end_date=?, is_active=? WHERE id=?`,
    String(body.name || b.name).slice(0, 30),
    ['overall', 'category', 'account'].includes(body.scope) ? body.scope : b.scope,
    body.category_id != null ? validCategoryId(ledgerId, body.category_id) : b.category_id,
    body.account_id != null ? validAccountId(ledgerId, body.account_id) : b.account_id,
    ['monthly', 'yearly', 'weekly', 'custom'].includes(body.period) ? body.period : b.period,
    body.amount != null ? Math.abs(cents(body.amount)) : (body.amount_cents != null ? Math.abs(Math.round(Number(body.amount_cents) || 0)) : Number(b.amount_cents)),
    body.trigger_type === 'income' ? 'income' : body.trigger_type === 'expense' ? 'expense' : b.trigger_type,
    body.rollover != null ? (body.rollover ? 1 : 0) : b.rollover,
    body.alert_pct != null ? Number(body.alert_pct) || Number(b.alert_pct) : b.alert_pct,
    body.start_date != null ? (DATE_RE.test(String(body.start_date)) ? body.start_date : null) : b.start_date,
    body.end_date != null ? (DATE_RE.test(String(body.end_date)) ? body.end_date : null) : b.end_date,
    body.is_active != null ? (body.is_active ? 1 : 0) : b.is_active,
    b.id
  );
  auth.audit(req, 'api.budget.update', { ledgerId: req.openAuth.ledgerId, entity: 'budget', entityId: b.id });
  ok(res, { id: b.id });
});

router.post('/budgets/:id/toggle', requireWrite, (req, res) => {
  const b = findBudget(req, res);
  if (!b) return;
  run('UPDATE budgets SET is_active = ? WHERE id = ?', b.is_active ? 0 : 1, b.id);
  auth.audit(req, 'api.budget.toggle', { ledgerId: req.openAuth.ledgerId, entity: 'budget', entityId: b.id, detail: b.is_active ? '停用' : '启用' });
  ok(res, { id: b.id, is_active: !b.is_active });
});

router.post('/budgets/:id/delete', requireWrite, (req, res) => {
  const b = findBudget(req, res);
  if (!b) return;
  run('DELETE FROM budgets WHERE id = ? AND ledger_id = ?', b.id, req.openAuth.ledgerId);
  auth.audit(req, 'api.budget.delete', { ledgerId: req.openAuth.ledgerId, entity: 'budget', entityId: b.id, detail: b.name });
  ok(res, { deleted: b.id });
});

/* -------------------------------- 储蓄目标 -------------------------------- */

router.post('/goals', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const target = body.target_cents != null ? Math.abs(Math.round(Number(body.target_cents) || 0)) : Math.abs(cents(body.target_amount || body.target));
  if (!name || !target) return bad(res, 400, '请填写目标名称与目标金额');
  const info = run(
    'INSERT INTO goals (ledger_id, name, icon, target_cents, saved_cents, account_id, target_date, status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ledgerId, name.slice(0, 30), String(body.icon || '🎯').slice(0, 8), target,
    body.saved_cents != null ? Math.round(Number(body.saved_cents) || 0) : (body.saved_amount ? cents(body.saved_amount) : 0),
    validAccountId(ledgerId, body.account_id),
    DATE_RE.test(String(body.target_date || '')) ? body.target_date : null, 'active',
    body.note ? String(body.note).slice(0, 200) : null, nowStr()
  );
  auth.audit(req, 'api.goal.create', { ledgerId, entity: 'goal', entityId: info.lastInsertRowid, detail: name });
  ok(res, { id: Number(info.lastInsertRowid) });
});

/** 存入 / 取出（amount 为负即取出）；create_txn=true 时同步记一笔流水（与进度更新同事务） */
router.post('/goals/:id/deposit', requireWrite, (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const g = get('SELECT * FROM goals WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (!g) return bad(res, 404, '目标不存在');
  const body = req.body || {};
  const delta = body.amount_cents != null ? Math.round(Number(body.amount_cents) || 0) : cents(body.amount);
  if (!delta) return bad(res, 400, '请填写金额（取出请填负数）');
  const saved = Math.max(0, Number(g.saved_cents) + delta);
  const status = saved >= Number(g.target_cents) ? 'done' : 'active';
  const accountId = validAccountId(ledgerId, body.account_id) || g.account_id;
  const { tx } = require('../db');
  let txnId = null;
  tx(() => {
    run('UPDATE goals SET saved_cents = ?, status = ? WHERE id = ?', saved, status, g.id);
    if (body.create_txn) {
      txnId = txn.createTransaction(ledgerId, userId, {
        type: delta > 0 ? 'expense' : 'income',
        amount_cents: Math.abs(delta),
        account_id: accountId,
        txn_date: todayStr(),
        note: `储蓄目标「${g.name}」${delta > 0 ? '存入' : '取出'}`,
        source: 'manual',
      });
    }
  });
  if (status === 'done') {
    for (const uid of auth.ledgerWriterIds(ledgerId)) {
      auth.notify(uid, { kind: 'success', ledgerId, title: `🎉 储蓄目标达成：${g.name}`, link: '/goals' });
    }
  }
  auth.audit(req, 'api.goal.deposit', { ledgerId, entity: 'goal', entityId: g.id, detail: String(delta) });
  ok(res, { goal_id: g.id, saved_cents: saved, done: status === 'done', txn_id: txnId });
});

router.post('/goals/:id/delete', requireWrite, (req, res) => {
  const g = get('SELECT * FROM goals WHERE id = ? AND ledger_id = ?', Number(req.params.id), req.openAuth.ledgerId);
  if (!g) return bad(res, 404, '目标不存在');
  run('DELETE FROM goals WHERE id = ? AND ledger_id = ?', g.id, req.openAuth.ledgerId);
  auth.audit(req, 'api.goal.delete', { ledgerId: req.openAuth.ledgerId, entity: 'goal', entityId: g.id, detail: g.name });
  ok(res, { deleted: g.id });
});

/* -------------------------------- 订阅扣费 -------------------------------- */

/** 订阅请求体（与网页表单同语义；amount 单位：元） */
const SUB_CYCLES = new Set(['monthly', 'quarterly', 'half_yearly', 'yearly', 'weekly']);
function readSubBody(body) {
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const cycle = SUB_CYCLES.has(body.cycle) ? body.cycle : 'monthly';
  const cycleN = Math.max(1, Math.min(12, Number(body.cycle_n) || 1));
  const anchorDay = Math.max(1, Math.min(31, Number(body.anchor_day) || Number(todayStr().slice(8, 10))));
  const anchorMonth = body.anchor_month ? Math.max(1, Math.min(12, Number(body.anchor_month))) : null;
  const trialEnds = DAY.test(String(body.trial_ends_on || '')) ? body.trial_ends_on : null;
  const status = ['trial', 'active', 'paused', 'canceled'].includes(body.status) ? body.status : 'active';
  let next = DAY.test(String(body.next_charge_at || '')) ? body.next_charge_at : '';
  if (!next && trialEnds) next = trialEnds;
  if (!next) next = todayStr();
  let guard = 0;
  while (next < todayStr() && guard++ < 500) next = subs.advance(next, { cycle, cycle_n: cycleN, anchor_day: anchorDay });
  return {
    name: String(body.name || '').trim().slice(0, 40),
    icon: String(body.icon || '🧾').slice(0, 8) || '🧾',
    plan: body.plan ? String(body.plan).slice(0, 40) : null,
    vendor_url: u.safeExternalUrl(body.vendor_url),
    amount_cents: Math.abs(body.amount_cents != null ? Math.round(Number(body.amount_cents) || 0) : cents(body.amount)),
    currency: body.currency || 'CNY',
    cycle, cycle_n: cycleN, anchor_month: anchorMonth, anchor_day: anchorDay,
    account_id: body.account_id ? Number(body.account_id) : null,
    category_id: body.category_id ? Number(body.category_id) : null,
    auto_renew: body.auto_renew === undefined ? 1 : (body.auto_renew ? 1 : 0),
    trial_ends_on: trialEnds,
    next_charge_at: next,
    reminder_days: Math.max(0, Math.min(60, Number(body.reminder_days ?? 3) || 0)),
    status,
    note: body.note ? String(body.note).slice(0, 200) : null,
  };
}

router.post('/subscriptions', requireWrite, (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const d = readSubBody(req.body || {});
  if (!d.name) return bad(res, 400, '请填写订阅名称');
  if (!d.amount_cents) return bad(res, 400, '请填写每期扣费金额');
  d.account_id = validAccountId(ledgerId, d.account_id);
  d.category_id = validCategoryId(ledgerId, d.category_id);
  const info = run(
    `INSERT INTO subscriptions (ledger_id, name, icon, plan, vendor_url, amount_cents, currency, cycle, cycle_n,
      anchor_month, anchor_day, account_id, category_id, auto_renew, trial_ends_on, next_charge_at,
      reminder_days, status, note, created_by_user_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ledgerId, d.name, d.icon, d.plan, d.vendor_url, d.amount_cents, d.currency, d.cycle, d.cycle_n,
    d.anchor_month, d.anchor_day, d.account_id, d.category_id, d.auto_renew, d.trial_ends_on, d.next_charge_at,
    d.reminder_days, d.status, d.note, userId, nowStr()
  );
  auth.audit(req, 'api.subscription.create', { ledgerId, entity: 'subscription', entityId: info.lastInsertRowid, detail: d.name });
  ok(res, { id: Number(info.lastInsertRowid), next_charge_at: d.next_charge_at });
});

function findSub(req, res) {
  const s = get('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', Number(req.params.id), req.openAuth.ledgerId);
  if (!s) { bad(res, 404, '订阅不存在'); return null; }
  return s;
}

router.post('/subscriptions/:id', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const old = findSub(req, res);
  if (!old) return;
  const body = req.body || {};
  // 关键：显式抹掉 spread 带进来的 old.amount_cents，否则它恒非空、用户传的 amount 永远被忽略；
  // status 沿用 old（含 canceled——编辑已取消订阅不应把它复活成生效中）
  const d = readSubBody({
    ...old,
    ...body,
    amount_cents: body.amount_cents ?? undefined,
    amount: body.amount ?? (body.amount_cents != null ? undefined : (Number(old.amount_cents) / 100)),
    status: body.status ?? (['trial', 'active', 'paused', 'canceled'].includes(old.status) ? old.status : 'active'),
    next_charge_at: body.next_charge_at ?? old.next_charge_at,
  });
  if (!d.name || !d.amount_cents) return bad(res, 400, '名称与金额不能为空');
  d.account_id = validAccountId(ledgerId, d.account_id);
  d.category_id = validCategoryId(ledgerId, d.category_id);
  run(
    `UPDATE subscriptions SET name=?, icon=?, plan=?, vendor_url=?, amount_cents=?, currency=?, cycle=?, cycle_n=?,
      anchor_month=?, anchor_day=?, account_id=?, category_id=?, auto_renew=?, trial_ends_on=?, next_charge_at=?,
      reminder_days=?, status=?, note=? WHERE id=? AND ledger_id=?`,
    d.name, d.icon, d.plan, d.vendor_url, d.amount_cents, d.currency, d.cycle, d.cycle_n,
    d.anchor_month, d.anchor_day, d.account_id, d.category_id, d.auto_renew, d.trial_ends_on, d.next_charge_at,
    d.reminder_days, d.status, d.note, old.id, ledgerId
  );
  auth.audit(req, 'api.subscription.update', { ledgerId, entity: 'subscription', entityId: old.id, detail: d.name });
  ok(res, { id: old.id });
});

router.post('/subscriptions/:id/charge', requireWrite, (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const sub = findSub(req, res);
  if (!sub) return;
  const body = req.body || {};
  const txnId = subs.charge(sub, userId, { date: DATE_RE.test(String(body.date || '')) ? body.date : todayStr() });
  if (!txnId) return bad(res, 400, '订阅金额为 0，无法记账');
  // subs.charge 内部（非 silent）已 recalcBalances，无需重复
  auth.audit(req, 'api.subscription.charge', { ledgerId, entity: 'subscription', entityId: sub.id, detail: String(sub.amount_cents) });
  ok(res, { txn_id: txnId, amount_cents: Number(sub.amount_cents) });
});

router.post('/subscriptions/:id/skip', requireWrite, (req, res) => {
  const sub = findSub(req, res);
  if (!sub) return;
  const next = subs.advance(sub.next_charge_at, sub);
  run('UPDATE subscriptions SET next_charge_at = ? WHERE id = ?', next, sub.id);
  auth.audit(req, 'api.subscription.skip', { ledgerId: req.openAuth.ledgerId, entity: 'subscription', entityId: sub.id, detail: `顺延至 ${next}` });
  ok(res, { id: sub.id, next_charge_at: next });
});

router.post('/subscriptions/:id/toggle', requireWrite, (req, res) => {
  const sub = findSub(req, res);
  if (!sub) return;
  const back = sub.status === 'paused' || sub.status === 'canceled';
  run('UPDATE subscriptions SET status = ?, canceled_at = ? WHERE id = ?', back ? 'active' : 'paused', back ? null : sub.canceled_at, sub.id);
  auth.audit(req, 'api.subscription.toggle', { ledgerId: req.openAuth.ledgerId, entity: 'subscription', entityId: sub.id, detail: back ? '恢复' : '暂停' });
  ok(res, { id: sub.id, status: back ? 'active' : 'paused' });
});

router.post('/subscriptions/:id/cancel', requireWrite, (req, res) => {
  const sub = findSub(req, res);
  if (!sub) return;
  run("UPDATE subscriptions SET status = 'canceled', canceled_at = ? WHERE id = ?", nowStr(), sub.id);
  auth.audit(req, 'api.subscription.cancel', { ledgerId: req.openAuth.ledgerId, entity: 'subscription', entityId: sub.id, detail: sub.name });
  ok(res, { id: sub.id, status: 'canceled' });
});

router.post('/subscriptions/:id/delete', requireWrite, (req, res) => {
  const { ledgerId } = req.openAuth;
  const sub = findSub(req, res);
  if (!sub) return;
  run('DELETE FROM subscriptions WHERE id = ? AND ledger_id = ?', sub.id, ledgerId);
  auth.audit(req, 'api.subscription.delete', { ledgerId, entity: 'subscription', entityId: sub.id, detail: sub.name });
  ok(res, { deleted: sub.id });
});

/* -------------------------------- 周期账单 -------------------------------- */

router.post('/recurring', requireWrite, (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return bad(res, 400, '请填写账单名称');
  const rawItems = Array.isArray(body.items) ? body.items : [body];
  const items = [];
  for (const it of rawItems) {
    const amt = it.amount_cents != null ? Math.abs(Math.round(Number(it.amount_cents) || 0)) : Math.abs(cents(it.amount));
    if (!amt) continue;
    items.push({
      type: TYPE_ALIASES[String(it.type || 'expense').trim()] || 'expense',
      amount_cents: amt,
      category_id: validCategoryId(ledgerId, it.category_id),
      account_id: validAccountId(ledgerId, it.account_id),
      note: it.note || name,
      currency: 'CNY',
    });
  }
  if (!items.length) return bad(res, 400, '请至少填写一项金额');
  const frequency = ['daily', 'weekly', 'monthly', 'yearly'].includes(body.frequency) ? body.frequency : 'monthly';
  const intervalN = Math.max(1, Number(body.interval_n) || 1);
  const dayOfMonth = body.day_of_month ? Number(body.day_of_month) : null;
  let next = DATE_RE.test(String(body.next_run_at || '')) ? body.next_run_at : todayStr();
  let guard = 0;
  while (next < todayStr() && guard++ < 400) next = sch.advanceDate(next, { frequency, interval_n: intervalN, day_of_month: dayOfMonth });
  const info = run(
    `INSERT INTO recurring_rules (ledger_id, name, payload, frequency, interval_n, day_of_month, next_run_at,
      auto_post, is_active, created_at) VALUES (?,?,?,?,?,?,?,?,1,?)`,
    ledgerId, name.slice(0, 40), JSON.stringify({ items, user_id: userId }),
    frequency, intervalN, dayOfMonth || Number(next.slice(8, 10)),
    next, body.auto_post === undefined ? 1 : (body.auto_post ? 1 : 0), nowStr()
  );
  auth.audit(req, 'api.recurring.create', { ledgerId, entity: 'recurring', entityId: info.lastInsertRowid, detail: name });
  ok(res, { id: Number(info.lastInsertRowid), next_run_at: next });
});

function findRule(req, res) {
  const r = get('SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?', Number(req.params.id), req.openAuth.ledgerId);
  if (!r) { bad(res, 404, '周期账单不存在'); return null; }
  return r;
}

/** 立即按规则记一期并顺延 */
router.post('/recurring/:id/run', requireWrite, (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const r = findRule(req, res);
  if (!r) return;
  const items = sch.ruleItems(r.payload);
  const ids = [];
  for (const p of items) {
    const amt = Math.abs(Number(p.amount_cents) || 0);
    if (!amt) continue;
    const info = run(
      `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id,
        to_account_id, category_id, user_id, txn_date, note, merchant, status, source, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ledgerId, p.type || 'expense', amt, 'CNY', 1, amt, validAccountId(ledgerId, p.account_id), null,
      validCategoryId(ledgerId, p.category_id),
      userId, todayStr(), p.note || r.name, null, 'cleared', 'recurring', nowStr(), nowStr()
    );
    ids.push(Number(info.lastInsertRowid));
  }
  const nextRun = sch.advanceDate(r.next_run_at, r);
  run('UPDATE recurring_rules SET last_run_at = ?, next_run_at = ? WHERE id = ?', nowStr(), nextRun, r.id);
  require('../db').recalcBalances(ledgerId);
  auth.audit(req, 'api.recurring.run', { ledgerId, entity: 'recurring', entityId: r.id, detail: `记账 ${ids.length} 笔` });
  ok(res, { txn_ids: ids, next_run_at: nextRun });
});

router.post('/recurring/:id/toggle', requireWrite, (req, res) => {
  const r = findRule(req, res);
  if (!r) return;
  run('UPDATE recurring_rules SET is_active = ? WHERE id = ?', r.is_active ? 0 : 1, r.id);
  auth.audit(req, 'api.recurring.toggle', { ledgerId: req.openAuth.ledgerId, entity: 'recurring', entityId: r.id, detail: r.is_active ? '停用' : '启用' });
  ok(res, { id: r.id, is_active: !r.is_active });
});

router.post('/recurring/:id/delete', requireWrite, (req, res) => {
  const r = findRule(req, res);
  if (!r) return;
  run('DELETE FROM recurring_rules WHERE id = ? AND ledger_id = ?', r.id, req.openAuth.ledgerId);
  auth.audit(req, 'api.recurring.delete', { ledgerId: req.openAuth.ledgerId, entity: 'recurring', entityId: r.id, detail: r.name });
  ok(res, { deleted: r.id });
});

/* --------------------------------- 设置 ---------------------------------- */
/* 站点管理员令牌可读写；api_key 永不回显，只能设置/清除 */

router.post('/settings/site', requireWrite, requireSiteAdmin, (req, res) => {
  const body = req.body || {};
  if (body.site_name != null) setSetting('site.name', String(body.site_name).slice(0, 20));
  if (body.currency != null) setSetting('site.currency', String(body.currency).slice(0, 8));
  if (body.allow_register != null) setSetting('site.allow_register', body.allow_register ? 'true' : 'false');
  if (body.login_max_fail != null) setSetting('security.login_max_fail', String(Number(body.login_max_fail) || 10));
  auth.audit(req, 'api.settings.site', { detail: Object.keys(body).join(',') });
  ok(res, { updated: Object.keys(body) });
});

router.post('/settings/ai', requireWrite, requireSiteAdmin, (req, res) => {
  const body = req.body || {};
  const cfg = ai.getAiConfig();
  if (body.clear_api_key) setSetting('ai.api_key', '');
  else if (body.api_key != null && String(body.api_key).trim() !== '') {
    const rawKey = String(body.api_key).trim();
    if (ai.isMaskedSecret(rawKey)) return bad(res, 400, 'API Key 不能是掩码串');
    if (!ai.isHeaderSafe(rawKey)) return bad(res, 400, 'API Key 含有非法字符（可能带入了全角符号）');
    setSetting('ai.api_key', rawKey);
  }
  if (body.base_url != null) setSetting('ai.base_url', String(body.base_url).trim());
  if (body.model != null) setSetting('ai.model', String(body.model).trim());
  if (body.enabled != null) setSetting('ai.enabled', body.enabled ? 'true' : 'false');
  if (body.vision != null) setSetting('ai.vision', body.vision ? 'true' : 'false');
  if (body.auto_save != null) setSetting('ai.auto_save', body.auto_save ? 'true' : 'false');
  if (body.timeout_ms != null) setSetting('ai.timeout_ms', String(Number(body.timeout_ms) || cfg.timeoutMs));
  auth.audit(req, 'api.settings.ai', { detail: Object.keys(body).filter((k) => k !== 'api_key').join(',') });
  const after = ai.getAiConfig();
  ok(res, { ready: ai.isAiReady(), usable: ai.isAiUsable(), model: after.model, base_url: after.baseUrl, api_key_set: !!after.apiKey });
});

router.post('/settings/ai/test', requireWrite, requireSiteAdmin, async (req, res) => {
  const r = await ai.testConnection();
  if (!r.ok) return bad(res, 400, r.error);
  ok(res, { message: '连接成功，模型响应正常', raw: r.raw });
});

/* ------------------------------- API 兜底 -------------------------------- */

/** 路由内未捕获异常统一 JSON 500（不带会话上下文，落到网页错误页会渲染失败） */
router.use((err, req, res, _next) => {
  console.error('[openapi]', err);
  res.status(err.status || err.statusCode || 500).json({ ok: false, error: err.message || '服务器内部错误' });
});

router.use((req, res) => {
  res.status(404).json({ ok: false, error: `接口不存在：${req.method} ${req.path}` });
});

module.exports = router;

'use strict';
/** 账户 / 分类 / 标签管理 */
const express = require('express');
const { all, get, run, nowStr, todayStr, ACCOUNT_TYPE_MAP } = require('../db');
const auth = require('../lib/auth');
const txn = require('../lib/txn');
const fd = require('../lib/formdata');
const u = require('../lib/util');

const router = express.Router();

/* ---------------------------------- 账户 ---------------------------------- */

router.get('/accounts', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const overview = txn.accountOverview(ledgerId);
  const archived = fd.archivedAccounts(ledgerId);
  // 最近 30 天各账户流水
  const flows = all(
    `SELECT account_id, COALESCE(SUM(CASE WHEN type IN ('expense','lend','repay_pay','fee') THEN amount_base_cents ELSE 0 END),0) AS out,
            COALESCE(SUM(CASE WHEN type IN ('income','borrow','repay_receive','reimburse','refund','interest') THEN amount_base_cents ELSE 0 END),0) AS inflow
     FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date >= date(?, '-30 day')
     GROUP BY account_id`,
    ledgerId, todayStr()
  );
  const flowMap = new Map(flows.map((f) => [Number(f.account_id), f]));
  const accounts = overview.accounts.map((a) => ({
    ...a,
    flow: flowMap.get(Number(a.id)) || { out: 0, inflow: 0 },
    typeLabel: ACCOUNT_TYPE_MAP[a.type]?.label || a.type,
    isLiability: ['credit', 'loan', 'payable'].includes(a.type),
  }));
  // 按类型分组
  const groups = {};
  for (const a of accounts) {
    (groups[a.type] = groups[a.type] || []).push(a);
  }
  const budgetsByAccount = all("SELECT * FROM budgets WHERE ledger_id = ? AND scope = 'account' AND is_active = 1", ledgerId);
  res.render('accounts', {
    title: '账户管理', activeNav: 'accounts',
    accounts, archived, groups, overview, budgetsByAccount,
  });
});

router.post('/accounts', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const name = String(req.body.name || '').trim();
  if (!name) { res.flash('error', '请填写账户名称'); return res.redirect('/accounts'); }
  const type = ACCOUNT_TYPE_MAP[req.body.type] ? req.body.type : 'cash';
  const initial = u.parseAmountToCents(req.body.initial_balance);
  const info = run(
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, credit_limit,
      bill_day, due_day, institution, card_no, note, include_in_net, sort_order, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ledgerId, name.slice(0, 30), type, req.body.icon || ACCOUNT_TYPE_MAP[type].icon, req.body.currency || 'CNY',
    initial, initial,
    req.body.credit_limit ? u.parseAmountToCents(req.body.credit_limit) : null,
    req.body.bill_day ? Number(req.body.bill_day) : null,
    req.body.due_day ? Number(req.body.due_day) : null,
    req.body.institution ? String(req.body.institution).slice(0, 40) : null,
    req.body.card_no ? String(req.body.card_no).slice(-4) : null,
    req.body.note ? String(req.body.note).slice(0, 200) : null,
    req.body.include_in_net === undefined ? 1 : (req.body.include_in_net ? 1 : 0),
    Number(req.body.sort_order) || 50, nowStr()
  );
  auth.audit(req, 'account.create', { entity: 'account', entityId: info.lastInsertRowid, ledgerId });
  res.flash('success', `账户「${name}」已创建`);
  res.redirect('/accounts');
});

router.post('/accounts/:id', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const acc = get('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!acc) { res.flash('error', '账户不存在'); return res.redirect('/accounts'); }
  const initial = req.body.initial_balance !== undefined ? u.parseAmountToCents(req.body.initial_balance) : Number(acc.initial_cents);
  run(
    `UPDATE accounts SET name=?, type=?, icon=?, currency=?, initial_cents=?, credit_limit=?, bill_day=?, due_day=?,
      institution=?, note=?, include_in_net=?, sort_order=? WHERE id=?`,
    String(req.body.name || acc.name).slice(0, 30),
    ACCOUNT_TYPE_MAP[req.body.type] ? req.body.type : acc.type,
    req.body.icon || acc.icon,
    req.body.currency || acc.currency,
    initial,
    req.body.credit_limit ? u.parseAmountToCents(req.body.credit_limit) : null,
    req.body.bill_day ? Number(req.body.bill_day) : null,
    req.body.due_day ? Number(req.body.due_day) : null,
    req.body.institution ? String(req.body.institution).slice(0, 40) : null,
    req.body.note ? String(req.body.note).slice(0, 200) : null,
    req.body.include_in_net ? 1 : 0,
    Number(req.body.sort_order) || acc.sort_order,
    id
  );
  require('../db').recalcBalances(ledgerId);
  auth.audit(req, 'account.update', { entity: 'account', entityId: id, ledgerId });
  res.flash('success', '账户已更新');
  res.redirect('/accounts');
});

router.post('/accounts/:id/archive', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const acc = get('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (acc) {
    run('UPDATE accounts SET is_archived = ? WHERE id = ?', acc.is_archived ? 0 : 1, id);
    res.flash('success', acc.is_archived ? '账户已恢复' : '账户已停用（历史记录保留）');
  }
  res.redirect('/accounts');
});

router.post('/accounts/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const used = Number(get('SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ? AND (account_id = ? OR to_account_id = ?)', ledgerId, id, id)?.c || 0);
  if (used > 0) {
    res.flash('error', `该账户下有 ${used} 笔记录，无法删除。可改为「停用」。`);
    return res.redirect('/accounts');
  }
  run('DELETE FROM accounts WHERE id = ? AND ledger_id = ?', id, ledgerId);
  auth.audit(req, 'account.delete', { entity: 'account', entityId: id, ledgerId });
  res.flash('success', '账户已删除');
  res.redirect('/accounts');
});

/** 余额调整：生成一笔 adjust 交易，把账面余额拉平到实际值 */
router.post('/accounts/:id/adjust', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const acc = get('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!acc) { res.flash('error', '账户不存在'); return res.redirect('/accounts'); }
  const actual = u.parseAmountToCents(req.body.actual_balance);
  const delta = actual - Number(acc.balance_cents);
  if (delta === 0) { res.flash('info', '余额一致，无需调整'); return res.redirect('/accounts'); }
  txn.createTransaction(ledgerId, req.session.userId, {
    type: 'adjust',
    amount_cents: delta,
    account_id: id,
    txn_date: req.body.adjust_date || todayStr(),
    note: `余额调整：${u.fmtAmount(acc.balance_cents)} → ${u.fmtAmount(actual)}${req.body.note ? ' · ' + req.body.note : ''}`,
    source: 'manual',
  });
  auth.audit(req, 'account.adjust', { entity: 'account', entityId: id, ledgerId, detail: String(delta) });
  res.flash('success', `已调整 ${u.signedMoney(delta)}，账面余额已对齐`);
  res.redirect('/accounts');
});

/** 账户明细 */
router.get('/accounts/:id', auth.requireLogin, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const acc = get('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (!acc) return res.status(404).render('error', { title: '账户不存在', message: '该账户可能已被删除。' });
  const f = {
    accountId: Number(acc.id),
    from: req.query.from || '',
    to: req.query.to || '',
    page: Number(req.query.page) || 1,
    pageSize: 40,
    sort: 'date_desc',
  };
  const result = txn.listTransactions(ledgerId, f);
  const form = fd.txFormData(ledgerId, req.session.userId);
  res.render('account-detail', {
    title: `账户 · ${acc.name}`, activeNav: 'accounts', acc, f, result,
    groups: txn.groupByDate(result.rows), form,
    typeLabel: ACCOUNT_TYPE_MAP[acc.type]?.label || acc.type,
  });
});

/* ---------------------------------- 分类 ---------------------------------- */

router.get('/categories', auth.requireLogin, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const expenseTree = fd.categoryTree(ledgerId, 'expense');
  const incomeTree = fd.categoryTree(ledgerId, 'income');
  // 每个分类的笔数与金额（近一年）
  const stats = all(
    `SELECT category_id, COUNT(*) AS cnt, COALESCE(SUM(amount_base_cents),0) AS total
     FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date >= date('now','-365 day')
     GROUP BY category_id`,
    ledgerId
  );
  const statMap = new Map(stats.map((s) => [Number(s.category_id), s]));
  const decorate = (node) => ({
    ...node,
    stat: statMap.get(Number(node.id)) || { cnt: 0, total: 0 },
    children: (node.children || []).map(decorate),
  });
  res.render('categories', {
    title: '分类管理', activeNav: 'categories',
    expenseTree: expenseTree.map(decorate),
    incomeTree: incomeTree.map(decorate),
  });
});

router.post('/categories', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const name = String(req.body.name || '').trim();
  const kind = req.body.kind === 'income' ? 'income' : 'expense';
  if (!name) { res.flash('error', '请填写分类名称'); return res.redirect('/categories'); }
  const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
  const color = u.safeColor(req.body.color || (parentId ? (get('SELECT color FROM categories WHERE id = ?', parentId) || {}).color : null), '#8c8c8c');
  run(
    'INSERT INTO categories (ledger_id, name, kind, parent_id, icon, color, is_system, sort_order) VALUES (?,?,?,?,?,?,0,?)',
    ledgerId, name.slice(0, 20), kind, parentId, req.body.icon || '🏷️', color, 999
  );
  auth.audit(req, 'category.create', { entity: 'category', ledgerId, detail: name });
  res.flash('success', `分类「${name}」已添加`);
  res.redirect('/categories');
});

router.post('/categories/:id', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const c = get('SELECT * FROM categories WHERE id = ?', id);
  // 系统内置分类（ledger_id IS NULL）全站共享，一个账本改名会污染所有账本
  if (!c || c.is_system || c.ledger_id === null || Number(c.ledger_id) !== ledgerId) {
    res.flash('error', '系统内置分类不可修改（可新建自己的分类）');
    return res.redirect('/categories');
  }
  run('UPDATE categories SET name=?, icon=?, color=? WHERE id = ?',
    String(req.body.name || c.name).slice(0, 20), req.body.icon || c.icon, u.safeColor(req.body.color || c.color, c.color), id);
  res.flash('success', '分类已更新');
  res.redirect('/categories');
});

router.post('/categories/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const c = get('SELECT * FROM categories WHERE id = ?', id);
  if (!c || Number(c.ledger_id) !== ledgerId) {
    res.flash('error', '系统内置分类不可删除');
    return res.redirect('/categories');
  }
  const used = Number(get('SELECT COUNT(*) AS c FROM transactions WHERE category_id = ?', id)?.c || 0);
  if (used > 0) {
    run('UPDATE categories SET is_archived = 1 WHERE id = ?', id);
    res.flash('success', '该分类下已有记录，已改为「归档」不再出现在选择列表');
  } else {
    run('DELETE FROM categories WHERE id = ?', id);
    run('DELETE FROM categories WHERE parent_id = ?', id);
    res.flash('success', '分类已删除');
  }
  res.redirect('/categories');
});

/* ---------------------------------- 标签 ---------------------------------- */

router.get('/tags', auth.requireLogin, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const tags = all(
    `SELECT t.*, (SELECT COUNT(*) FROM transaction_tags tt WHERE tt.tag_id = t.id) AS cnt,
       (SELECT COALESCE(SUM(x.amount_base_cents),0) FROM transaction_tags tt JOIN transactions x ON x.id = tt.transaction_id
         WHERE tt.tag_id = t.id AND x.deleted_at IS NULL) AS total
     FROM tags t WHERE t.ledger_id = ? ORDER BY cnt DESC, t.id`,
    ledgerId
  );
  res.render('tags', { title: '标签管理', activeNav: 'tags', tags });
});

router.post('/tags', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const name = String(req.body.name || '').trim();
  if (!name) { res.flash('error', '请填写标签名'); return res.redirect('/tags'); }
  if (get('SELECT id FROM tags WHERE ledger_id = ? AND name = ?', ledgerId, name)) {
    res.flash('error', '标签已存在'); return res.redirect('/tags');
  }
  run('INSERT INTO tags (ledger_id, name, color) VALUES (?,?,?)', ledgerId, name.slice(0, 20), u.safeColor(req.body.color, u.colorFor(name)));
  res.flash('success', '标签已创建');
  res.redirect('/tags');
});

router.post('/tags/:id', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  run('UPDATE tags SET name = ?, color = ? WHERE id = ? AND ledger_id = ?',
    String(req.body.name || '').slice(0, 20), u.safeColor(req.body.color, '#4f7cff'), id, ledgerId);
  res.flash('success', '标签已更新');
  res.redirect('/tags');
});

router.post('/tags/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  run('DELETE FROM transaction_tags WHERE tag_id = ?', id);
  run('DELETE FROM tags WHERE id = ? AND ledger_id = ?', id, ledgerId);
  res.flash('success', '标签已删除');
  res.redirect('/tags');
});

module.exports = router;

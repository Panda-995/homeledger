'use strict';
/** 预算 / 周期账单 / 借贷台账 / 储蓄目标 */
const express = require('express');
const { all, get, run, tx, nowStr, todayStr } = require('../db');
const auth = require('../lib/auth');
const txn = require('../lib/txn');
const fd = require('../lib/formdata');
const u = require('../lib/util');
const sch = require('../lib/scheduler');

const router = express.Router();

/* ---------------------------------- 预算 ---------------------------------- */

router.get('/budgets', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const budgets = all(
    `SELECT b.*, c.name AS category_name, c.icon AS category_icon, c.parent_id AS category_parent_id, a.name AS account_name
     FROM budgets b LEFT JOIN categories c ON c.id = b.category_id LEFT JOIN accounts a ON a.id = b.account_id
     WHERE b.ledger_id = ? ORDER BY b.is_active DESC, b.id`,
    ledgerId
  ).map((b) => {
    const range = sch.budgetPeriodRange(b, new Date());
    const used = sch.budgetUsedInRange(b, range.start, range.end);
    const amount = Number(b.amount_cents);
    // 大分类（parent_id 为空）预算统计该分类及其全部子分类，标注出来避免误解口径
    const catLabel = b.scope === 'category'
      ? `分类 · ${b.category_name || '未指定'}${b.category_parent_id === null ? '（整个大分类）' : ''}`
      : null;
    return {
      ...b, used, rangeLabel: range.label,
      ratio: amount > 0 ? (used / amount) * 100 : 0,
      remain: amount - used,
      dailyAllowance: Math.max(0, Math.round((amount - used) / Math.max(1, remainingDays(b, range)))),
      scopeLabel: b.scope === 'overall' ? '总预算' : catLabel || `账户 · ${b.account_name || '未指定'}`,
      periodLabel: { monthly: '每月', yearly: '每年', weekly: '每周', custom: '自定义' }[b.period] || '每月',
    };
  });
  const month = todayStr().slice(0, 7);
  const overall = txn.summary(ledgerId, `${month}-01`, `${month}-31`);
  const totalBudget = budgets.filter((b) => b.is_active && b.scope === 'overall').reduce((s, b) => s + Number(b.amount_cents), 0);
  res.render('budgets', {
    title: '预算管理', activeNav: 'budgets', budgets, form: fd.txFormData(ledgerId, req.session.userId),
    overall, totalBudget, month,
  });
});

function remainingDays(b, range) {
  const today = todayStr();
  if (today < range.start) return 30;
  if (today > range.end) return 1;
  const d1 = new Date(`${today}T00:00:00`);
  const d2 = new Date(`${range.end}T00:00:00`);
  return Math.max(1, Math.round((d2 - d1) / 86400000) + 1);
}

/** 分类须为系统分类或本账本自建（防跨账本/已停用 id 混入预算） */
function validCategoryId(ledgerId, rawId) {
  if (!rawId) return null;
  const c = get('SELECT id FROM categories WHERE id = ? AND is_archived = 0 AND (ledger_id IS NULL OR ledger_id = ?)', Number(rawId), ledgerId);
  return c ? Number(c.id) : null;
}
function validAccountId(ledgerId, rawId) {
  if (!rawId) return null;
  const a = get('SELECT id FROM accounts WHERE id = ? AND ledger_id = ? AND is_archived = 0', Number(rawId), ledgerId);
  return a ? Number(a.id) : null;
}

router.post('/budgets', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const name = String(req.body.name || '').trim();
  const amount = u.parseAmountToCents(req.body.amount);
  if (!name || !amount) { res.flash('error', '请填写预算名称与金额'); return res.redirect('/budgets'); }
  const scope = ['overall', 'category', 'account'].includes(req.body.scope) ? req.body.scope : 'overall';
  run(
    `INSERT INTO budgets (ledger_id, name, scope, category_id, account_id, period, amount_cents, currency,
      trigger_type, rollover, alert_pct, start_date, end_date, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
    ledgerId, name.slice(0, 30), scope,
    scope === 'category' ? validCategoryId(ledgerId, req.body.category_id) : null,
    scope === 'account' ? validAccountId(ledgerId, req.body.account_id) : null,
    ['monthly', 'yearly', 'weekly', 'custom'].includes(req.body.period) ? req.body.period : 'monthly',
    amount, req.body.currency || 'CNY',
    req.body.trigger_type === 'income' ? 'income' : 'expense',
    req.body.rollover ? 1 : 0,
    Number(req.body.alert_pct) || 80,
    req.body.start_date || null, req.body.end_date || null, nowStr()
  );
  auth.audit(req, 'budget.create', { entity: 'budget', ledgerId, detail: name });
  res.flash('success', `预算「${name}」已创建`);
  res.redirect('/budgets');
});

router.post('/budgets/:id', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const b = get('SELECT * FROM budgets WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!b) { res.flash('error', '预算不存在'); return res.redirect('/budgets'); }
  const effScope = ['overall', 'category', 'account'].includes(req.body.scope) ? req.body.scope : b.scope;
  run(
    `UPDATE budgets SET name=?, scope=?, category_id=?, account_id=?, period=?, amount_cents=?, trigger_type=?,
      rollover=?, alert_pct=?, start_date=?, end_date=?, is_active=? WHERE id=?`,
    String(req.body.name || b.name).slice(0, 30),
    effScope,
    effScope === 'category' ? validCategoryId(ledgerId, req.body.category_id) : null,
    effScope === 'account' ? validAccountId(ledgerId, req.body.account_id) : null,
    ['monthly', 'yearly', 'weekly', 'custom'].includes(req.body.period) ? req.body.period : b.period,
    req.body.amount ? u.parseAmountToCents(req.body.amount) : Number(b.amount_cents),
    req.body.trigger_type === 'income' ? 'income' : 'expense',
    req.body.rollover ? 1 : 0,
    Number(req.body.alert_pct) || Number(b.alert_pct),
    req.body.start_date || null, req.body.end_date || null,
    req.body.is_active ? 1 : 0, id
  );
  res.flash('success', '预算已更新');
  res.redirect('/budgets');
});

router.post('/budgets/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  run('DELETE FROM budgets WHERE id = ? AND ledger_id = ?', Number(req.params.id), Number(res.locals.ledger.id));
  res.flash('success', '预算已删除');
  res.redirect('/budgets');
});

router.post('/budgets/:id/toggle', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const b = get('SELECT * FROM budgets WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (b) run('UPDATE budgets SET is_active = ? WHERE id = ?', b.is_active ? 0 : 1, b.id);
  res.redirect('/budgets');
});

/* -------------------------------- 周期账单 -------------------------------- */

router.get('/recurring', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const rules = all(
    `SELECT r.*, (SELECT COUNT(*) FROM transactions t WHERE t.ledger_id = r.ledger_id AND t.source = 'recurring'
       AND t.note LIKE '%' || r.name || '%') AS posted
     FROM recurring_rules r WHERE r.ledger_id = ? ORDER BY r.is_active DESC, r.next_run_at`,
    ledgerId
  ).map((r) => {
    const items = sch.ruleItems(r.payload);
    const cats = fd.flatCategories(ledgerId);
    const accs = fd.accounts(ledgerId);
    const total = items.reduce((s, i) => s + Number(i.amount_cents || 0), 0);
    return {
      ...r, items, total,
      freqLabel: { daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年' }[r.frequency] || '每月',
      itemLabels: items.map((i) => ({
        ...i,
        category_path: cats.find((c) => Number(c.id) === Number(i.category_id))?.path || '未分类',
        account_name: accs.find((a) => Number(a.id) === Number(i.account_id))?.name || '—',
        type_label: require('../db').TXN_TYPE_MAP[i.type]?.label || i.type,
      })),
    };
  });
  res.render('recurring', {
    title: '周期账单', activeNav: 'recurring', rules,
    form: fd.txFormData(ledgerId, req.session.userId), today: todayStr(),
  });
});

router.post('/recurring', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const name = String(req.body.name || '').trim();
  if (!name) { res.flash('error', '请填写账单名称'); return res.redirect('/recurring'); }
  const types = [].concat(req.body.item_type || []);
  const amounts = [].concat(req.body.item_amount || []);
  const cats = [].concat(req.body.item_category_id || []);
  const accs = [].concat(req.body.item_account_id || []);
  const notes = [].concat(req.body.item_note || []);
  const items = [];
  types.forEach((t, i) => {
    const amt = u.parseAmountToCents(amounts[i]);
    if (!amt) return;
    items.push({
      type: t || 'expense', amount_cents: amt,
      category_id: cats[i] ? Number(cats[i]) : null,
      account_id: accs[i] ? Number(accs[i]) : null,
      note: notes[i] || name,
      currency: 'CNY',
    });
  });
  if (!items.length) { res.flash('error', '请至少填写一项金额'); return res.redirect('/recurring'); }

  const frequency = ['daily', 'weekly', 'monthly', 'yearly'].includes(req.body.frequency) ? req.body.frequency : 'monthly';
  let next = /^d{4}-d{2}-d{2}$/.test(String(req.body.next_run_at || '')) ? req.body.next_run_at : todayStr();
  // 若首次执行日已过，自动推到下一个周期
  let guard = 0;
  while (next < todayStr() && guard++ < 400) next = sch.advanceDate(next, { frequency, interval_n: Number(req.body.interval_n) || 1, day_of_month: req.body.day_of_month });

  run(
    `INSERT INTO recurring_rules (ledger_id, name, payload, frequency, interval_n, day_of_month, next_run_at,
      auto_post, is_active, created_at) VALUES (?,?,?,?,?,?,?,?,1,?)`,
    ledgerId, name.slice(0, 40), JSON.stringify({ items, user_id: req.session.userId }),
    frequency, Math.max(1, Number(req.body.interval_n) || 1),
    req.body.day_of_month ? Number(req.body.day_of_month) : Number(next.slice(8, 10)),
    next, req.body.auto_post ? 1 : 0, nowStr()
  );
  auth.audit(req, 'recurring.create', { entity: 'recurring', ledgerId, detail: name });
  res.flash('success', `周期账单「${name}」已创建，下次执行 ${next}`);
  res.redirect('/recurring');
});

router.post('/recurring/:id/toggle', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const r = get('SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (r) run('UPDATE recurring_rules SET is_active = ? WHERE id = ?', r.is_active ? 0 : 1, r.id);
  res.redirect('/recurring');
});

router.post('/recurring/:id/run', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const r = get('SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (!r) { res.flash('error', '规则不存在'); return res.redirect('/recurring'); }
  const items = sch.ruleItems(r.payload);
  tx(() => {
    for (const p of items) {
      const amt = Math.abs(Number(p.amount_cents) || 0);
      if (!amt) continue;
      run(
        `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id,
          to_account_id, category_id, user_id, txn_date, note, merchant, status, source, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ledgerId, p.type || 'expense', amt, 'CNY', 1, amt, p.account_id || null, null, p.category_id || null,
        req.session.userId, todayStr(), p.note || r.name, null, 'cleared', 'recurring', nowStr(), nowStr()
      );
    }
    run('UPDATE recurring_rules SET last_run_at = ?, next_run_at = ? WHERE id = ?', nowStr(), sch.advanceDate(r.next_run_at, r), r.id);
  });
  require('../db').recalcBalances(ledgerId);
  res.flash('success', '已立即记账一笔，下次执行日已顺延');
  res.redirect('/recurring');
});

router.post('/recurring/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  run('DELETE FROM recurring_rules WHERE id = ? AND ledger_id = ?', Number(req.params.id), Number(res.locals.ledger.id));
  res.flash('success', '周期账单已删除');
  res.redirect('/recurring');
});

/* -------------------------------- 借贷台账 -------------------------------- */

router.get('/debts', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const debts = all(
    `SELECT d.*, a.name AS account_name FROM debts d LEFT JOIN accounts a ON a.id = d.account_id
     WHERE d.ledger_id = ? ORDER BY d.status DESC, COALESCE(d.due_date, '9999') LIMIT 300`,
    ledgerId
  );
  const open = debts.filter((d) => d.status === 'open');
  const receivable = open.filter((d) => d.direction === 'receivable').reduce((s, d) => s + Number(d.balance_cents), 0);
  const payable = open.filter((d) => d.direction === 'payable').reduce((s, d) => s + Number(d.balance_cents), 0);
  res.render('debts', {
    title: '借贷台账', activeNav: 'debts', debts, receivable, payable,
    form: fd.txFormData(ledgerId, req.session.userId), today: todayStr(),
  });
});

router.post('/debts', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const counterparty = String(req.body.counterparty || '').trim();
  const amount = u.parseAmountToCents(req.body.amount);
  const direction = req.body.direction === 'receivable' ? 'receivable' : 'payable';
  if (!counterparty || !amount) { res.flash('error', '请填写对方名称与金额'); return res.redirect('/debts'); }

  if (req.body.create_txn) {
    txn.createTransaction(ledgerId, req.session.userId, {
      type: direction === 'receivable' ? 'lend' : 'borrow',
      amount_cents: amount,
      account_id: req.body.account_id || null,
      txn_date: req.body.date || todayStr(),
      merchant: counterparty,
      note: req.body.note || (direction === 'receivable' ? '借出' : '借入'),
      source: 'manual',
    });
    res.flash('success', '已记一笔并同步到借贷台账');
    return res.redirect('/debts');
  }
  run(
    `INSERT INTO debts (ledger_id, direction, counterparty, principal_cents, balance_cents, currency, account_id, due_date, status, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ledgerId, direction, counterparty.slice(0, 40), amount, amount, req.body.currency || 'CNY',
    req.body.account_id || null, req.body.due_date || null, 'open',
    req.body.note ? String(req.body.note).slice(0, 200) : null, nowStr()
  );
  res.flash('success', '已新增台账记录（未生成流水）');
  res.redirect('/debts');
});

/** 收/还款：核销台账 + 生成流水 */
router.post('/debts/:id/settle', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const d = get('SELECT * FROM debts WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!d) { res.flash('error', '台账不存在'); return res.redirect('/debts'); }
  const amount = Math.min(u.parseAmountToCents(req.body.amount) || Number(d.balance_cents), Number(d.balance_cents));
  if (!amount) { res.flash('error', '金额无效'); return res.redirect('/debts'); }

  txn.createTransaction(ledgerId, req.session.userId, {
    type: d.direction === 'receivable' ? 'repay_receive' : 'repay_pay',
    amount_cents: amount,
    account_id: req.body.account_id || d.account_id,
    txn_date: req.body.date || todayStr(),
    merchant: d.counterparty,
    note: (d.direction === 'receivable' ? '收回借款 · ' : '偿还借款 · ') + d.counterparty,
    source: 'manual',
  });
  // 优先核销手工台账
  const newBalance = Math.max(0, Number(d.balance_cents) - amount);
  if (d.note !== '系统自动汇总') {
    run('UPDATE debts SET balance_cents = ?, status = ? WHERE id = ?', newBalance, newBalance <= 0 ? 'closed' : 'open', id);
  } else {
    txn.syncDebts(ledgerId);
  }
  auth.audit(req, 'debt.settle', { entity: 'debt', entityId: id, ledgerId, detail: String(amount) });
  res.flash('success', `已${d.direction === 'receivable' ? '收款' : '还款'} ${u.money(amount)}`);
  res.redirect('/debts');
});

router.post('/debts/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  run('DELETE FROM debts WHERE id = ? AND ledger_id = ? AND note != ?', Number(req.params.id), Number(res.locals.ledger.id), '系统自动汇总');
  res.flash('success', '台账已删除');
  res.redirect('/debts');
});

/* -------------------------------- 储蓄目标 -------------------------------- */

router.get('/goals', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const goals = all(
    `SELECT g.*, a.name AS account_name FROM goals g LEFT JOIN accounts a ON a.id = g.account_id
     WHERE g.ledger_id = ? ORDER BY CASE g.status WHEN 'active' THEN 0 ELSE 1 END, g.id`,
    ledgerId
  ).map((g) => {
    const target = Number(g.target_cents);
    const saved = Number(g.saved_cents);
    let daysLeft = null;
    if (g.target_date) daysLeft = Math.round((new Date(`${g.target_date}T00:00:00`) - new Date(`${todayStr()}T00:00:00`)) / 86400000);
    return {
      ...g, target, saved,
      pct: target > 0 ? Math.min(100, (saved / target) * 100) : 0,
      remain: Math.max(0, target - saved),
      daysLeft,
      needPerMonth: daysLeft && daysLeft > 0 ? Math.ceil((target - saved) / Math.max(1, daysLeft / 30)) : null,
    };
  });
  res.render('goals', { title: '储蓄目标', activeNav: 'goals', goals, form: fd.txFormData(ledgerId, req.session.userId) });
});

router.post('/goals', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const name = String(req.body.name || '').trim();
  const target = u.parseAmountToCents(req.body.target_amount);
  if (!name || !target) { res.flash('error', '请填写目标名称与目标金额'); return res.redirect('/goals'); }
  run(
    'INSERT INTO goals (ledger_id, name, icon, target_cents, saved_cents, account_id, target_date, status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ledgerId, name.slice(0, 30), req.body.icon || '🎯', target, u.parseAmountToCents(req.body.saved_amount),
    req.body.account_id || null, req.body.target_date || null, 'active',
    req.body.note ? String(req.body.note).slice(0, 200) : null, nowStr()
  );
  res.flash('success', `储蓄目标「${name}」已创建`);
  res.redirect('/goals');
});

router.post('/goals/:id/deposit', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const g = get('SELECT * FROM goals WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (!g) { res.flash('error', '目标不存在'); return res.redirect('/goals'); }
  const delta = u.parseAmountToCents(req.body.amount);
  if (!delta) { res.flash('error', '请填写金额（取出请填负数）'); return res.redirect('/goals'); }
  const saved = Math.max(0, Number(g.saved_cents) + delta);
  const status = saved >= Number(g.target_cents) ? 'done' : 'active';
  run('UPDATE goals SET saved_cents = ?, status = ? WHERE id = ?', saved, status, g.id);
  if (req.body.create_txn) {
    txn.createTransaction(ledgerId, req.session.userId, {
      type: delta > 0 ? 'expense' : 'income',
      amount_cents: Math.abs(delta),
      account_id: req.body.account_id || g.account_id || null,
      txn_date: todayStr(),
      note: `储蓄目标「${g.name}」${delta > 0 ? '存入' : '取出'}`,
      source: 'manual',
    });
  }
  if (status === 'done') {
    for (const uid of auth.ledgerWriterIds(ledgerId)) {
      auth.notify(uid, { kind: 'success', ledgerId, title: `🎉 储蓄目标达成：${g.name}`, link: '/goals' });
    }
  }
  res.flash('success', status === 'done' ? '目标已达成 🎉' : '进度已更新');
  res.redirect('/goals');
});

router.post('/goals/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  run('DELETE FROM goals WHERE id = ? AND ledger_id = ?', Number(req.params.id), Number(res.locals.ledger.id));
  res.flash('success', '目标已删除');
  res.redirect('/goals');
});

module.exports = router;

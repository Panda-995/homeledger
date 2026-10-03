'use strict';
/** 交易：列表 / 记一笔 / 编辑 / 批量操作 / 报销 */
const express = require('express');
const { all, get, run, todayStr, TXN_TYPE_MAP } = require('../db');
const auth = require('../lib/auth');
const txn = require('../lib/txn');
const fd = require('../lib/formdata');
const u = require('../lib/util');
const att = require('../lib/attachments');

const router = express.Router();

/** 从表单解析出标准记账号 */
function readForm(body) {
  const splits = [];
  const names = [].concat(body.split_name || []);
  const amounts = [].concat(body.split_amount || []);
  names.forEach((n, i) => {
    const amt = u.parseAmountToCents(amounts[i]);
    if (n && amt) splits.push({ member_name: String(n).slice(0, 30), share_cents: amt });
  });
  return {
    // type 走白名单：透传任意值会在编辑失败回显时进入内嵌 <script> 的 JSON
    type: TXN_TYPE_MAP[body.type] ? body.type : 'expense',
    amount_cents: u.parseAmountToCents(body.amount),
    currency: body.currency || 'CNY',
    rate: body.rate ? Number(body.rate) : 1,
    account_id: body.account_id || null,
    to_account_id: body.to_account_id || null,
    category_id: body.category_id || null,
    txn_date: body.txn_date || todayStr(),
    note: body.note || '',
    merchant: body.merchant || '',
    status: body.status || 'cleared',
    is_reimbursable: body.is_reimbursable ? 1 : 0,
    tags: body.tags || '',
    splits,
    group_id: body.group_id || null,
    source: body.source || 'manual',
  };
}

/** back 只接受站内相对路径，避免 POST 参数被构造成开放重定向 */
function safeBack(back) {
  const s = String(back || '');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/transactions';
}

/* ---------------------------------- 列表 ---------------------------------- */

router.get('/', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const f = {
    type: req.query.type || '',
    kind: req.query.kind || '',
    categoryId: req.query.category_id ? Number(req.query.category_id) : null,
    accountId: req.query.account_id ? Number(req.query.account_id) : null,
    memberId: req.query.member_id ? Number(req.query.member_id) : null,
    tagId: req.query.tag_id ? Number(req.query.tag_id) : null,
    source: req.query.source || '',
    month: req.query.month || '',
    from: req.query.from || '',
    to: req.query.to || '',
    keyword: req.query.q || '',
    reimbursable: req.query.reimbursable || '',
    sort: req.query.sort || 'date_desc',
    page: Number(req.query.page) || 1,
    pageSize: 40,
  };
  const result = txn.listTransactions(ledgerId, f);
  const form = fd.txFormData(ledgerId, req.session.userId);
  res.render('transactions', {
    title: '账单明细', activeNav: 'transactions',
    f, result, groups: txn.groupByDate(result.rows), form,
    totalPages: result.pages,
  });
});

/* --------------------------------- 记一笔 --------------------------------- */

router.get('/new', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const type = TXN_TYPE_MAP[req.query.type] ? req.query.type : 'expense';
  const form = fd.txFormData(ledgerId, req.session.userId);
  const prefill = {
    type,
    amount: req.query.amount || '',
    txn_date: req.query.date || todayStr(),
    category_id: req.query.category_id || '',
    account_id: req.query.account_id || (form.accounts[0] ? form.accounts[0].id : ''),
    to_account_id: '',
    note: req.query.note || '',
    merchant: '',
    tags: '',
    is_reimbursable: 0,
    currency: 'CNY',
    rate: 1,
    status: 'cleared',
  };
  if (req.query.from_ai) {
    prefill.note = req.query.note || prefill.note;
  }
  res.render('txn-form', {
    title: '记一笔', activeNav: 'new', mode: 'create', form, t: prefill,
    splitRows: [], splits: [], back: req.query.back || '/transactions',
  });
});

router.post('/', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const data = readForm(req.body);
  const wantsJson = req.body._json === '1' || (req.headers.accept || '').includes('application/json');
  try {
    const id = txn.createTransaction(ledgerId, req.session.userId, data);
    auth.audit(req, 'txn.create', { entity: 'transaction', entityId: id, ledgerId, detail: `${data.type} ${(data.amount_cents / 100).toFixed(2)}` });
    if (wantsJson) return res.json({ ok: true, id, redirect: '/transactions' });
    res.flash('success', '已记一笔 ✓');
    res.redirect(safeBack(req.body.back));
  } catch (e) {
    if (wantsJson) return res.status(400).json({ ok: false, error: e.message });
    const form = fd.txFormData(ledgerId, req.session.userId);
    res.status(400).render('txn-form', {
      title: '记一笔', activeNav: 'new', mode: 'create', form,
      t: { ...data, amount: (data.amount_cents / 100).toFixed(2) },
      splitRows: data.splits, splits: [], back: safeBack(req.body.back), error: e.message,
    });
  }
});

/* ---------------------------------- 编辑 ---------------------------------- */

router.get('/:id/edit', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const t = txn.getTransaction(Number(req.params.id), ledgerId);
  if (!t) return res.status(404).render('error', { title: '记录不存在', message: '该笔记录可能已被删除。' });
  const form = fd.txFormData(ledgerId, req.session.userId);
  res.render('txn-form', {
    title: '编辑记录', activeNav: 'transactions', mode: 'edit', form, t,
    splitRows: txn.splitsOf(t.id),
    splits: txn.splitsOf(t.id),
    images: att.listByTxn(t.id),
    back: req.query.back || '/transactions',
  });
});

router.post('/:id', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const data = readForm(req.body);
  try {
    txn.updateTransaction(id, ledgerId, req.session.userId, data);
    auth.audit(req, 'txn.update', { entity: 'transaction', entityId: id, ledgerId });
    res.flash('success', '已保存修改');
    res.redirect(safeBack(req.body.back));
  } catch (e) {
    const form = fd.txFormData(ledgerId, req.session.userId);
    const t = txn.getTransaction(id, ledgerId);
    res.status(400).render('txn-form', {
      title: '编辑记录', activeNav: 'transactions', mode: 'edit', form,
      t: { ...t, ...data, amount: (data.amount_cents / 100).toFixed(2) },
      splitRows: data.splits, splits: data.splits, back: safeBack(req.body.back), error: e.message,
    });
  }
});

router.post('/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const ok = txn.softDelete(Number(req.params.id), ledgerId);
  auth.audit(req, 'txn.delete', { entity: 'transaction', entityId: Number(req.params.id), ledgerId });
  if (req.body._json === '1') return res.json({ ok });
  res.flash(ok ? 'success' : 'error', ok ? '已删除' : '记录不存在');
  res.redirect(safeBack(req.body.back));
});

/* --------------------------------- 批量操作 -------------------------------- */

router.post('/bulk', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const action = req.body.action || '';
  if (!ids.length) {
    res.flash('error', '请先勾选记录');
    return res.redirect(safeBack(req.body.back));
  }
  const placeholders = ids.map(() => '?').join(',');
  switch (action) {
    case 'delete': {
      const n = txn.bulkDelete(ids, ledgerId);
      res.flash('success', `已删除 ${n} 笔记录`);
      break;
    }
    case 'category': {
      const cid = req.body.category_id ? Number(req.body.category_id) : null;
      const c = cid ? get('SELECT id FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)', cid, ledgerId) : null;
      if (!c) { res.flash('error', '请选择要改成的分类'); break; }
      run(`UPDATE transactions SET category_id = ?, updated_at = ? WHERE ledger_id = ? AND id IN (${placeholders})`, cid, require('../db').nowStr(), ledgerId, ...ids);
      res.flash('success', `已修改 ${ids.length} 笔的分类`);
      break;
    }
    case 'tag': {
      const tag = String(req.body.tag || '').trim();
      if (!tag) { res.flash('error', '请输入标签名'); break; }
      for (const id of ids) txn.applyTags(id, ledgerId, tag, false);
      res.flash('success', `已为 ${ids.length} 笔添加标签「${tag}」`);
      break;
    }
    case 'reimburse': {
      try {
        const r = txn.markReimbursed(ids, ledgerId, req.session.userId, req.body.account_id ? Number(req.body.account_id) : null);
        res.flash('success', `已标记 ${r.count} 笔为已报销，生成入账 ${(r.total / 100).toFixed(2)}`);
      } catch (e) {
        res.flash('error', e.message);
      }
      break;
    }
    case 'reimbursable': {
      run(`UPDATE transactions SET is_reimbursable = 1, updated_at = ? WHERE ledger_id = ? AND id IN (${placeholders})`, require('../db').nowStr(), ledgerId, ...ids);
      res.flash('success', `已标记 ${ids.length} 笔为待报销`);
      break;
    }
    case 'restore': {
      run(`UPDATE transactions SET deleted_at = NULL WHERE ledger_id = ? AND id IN (${placeholders})`, ledgerId, ...ids);
      require('../db').recalcBalances(ledgerId);
      res.flash('success', '已恢复');
      break;
    }
    default:
      res.flash('error', '未知操作');
  }
  res.redirect(safeBack(req.body.back));
});

module.exports = router;

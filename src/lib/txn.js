'use strict';
/** 记账服务层：交易查询、写入、统计聚合 */
const { all, get, run, tx, nowStr, todayStr, TXN_TYPE_MAP, recalcBalances } = require('../db');
const { monthOf, pad, lastMonths, toBase } = require('./util');
const attach = require('./attachments');

/** 计入「收入」统计的类型 */
const INCOME_TYPES = ['income', 'interest', 'refund', 'reimburse'];
/** 计入「支出」统计的类型（转账、借贷、投资不计入，避免虚增） */
const EXPENSE_TYPES = ['expense', 'fee'];

const TXN_SELECT = `
SELECT t.*,
  c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
  pc.name AS category_parent,
  a.name AS account_name, a.icon AS account_icon, a.type AS account_type,
  ta.name AS to_account_name, ta.icon AS to_account_icon,
  u.display_name AS member_name, u.avatar_color AS member_color,
  (SELECT GROUP_CONCAT(tg.name, ' ') FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = t.id) AS tag_names
FROM transactions t
LEFT JOIN categories c ON c.id = t.category_id
LEFT JOIN categories pc ON pc.id = c.parent_id
LEFT JOIN accounts a ON a.id = t.account_id
LEFT JOIN accounts ta ON ta.id = t.to_account_id
LEFT JOIN users u ON u.id = t.user_id
`;

function decorate(t) {
  if (!t) return t;
  t.type_label = TXN_TYPE_MAP[t.type]?.label || t.type;
  t.type_icon = TXN_TYPE_MAP[t.type]?.icon || '•';
  t.type_color = TXN_TYPE_MAP[t.type]?.color || '#8c8c8c';
  t.flow = TXN_TYPE_MAP[t.type]?.flow || 'out';
  t.category_path = t.category_parent ? `${t.category_parent}/${t.category_name}` : (t.category_name || '未分类');
  // is_income/is_expense = 余额方向（供 UI 符号/配色用，含借入/收还款等入出账类型），
  // 统计口径仍以 INCOME_TYPES/EXPENSE_TYPES 为准（borrow 等不计收支）
  t.is_income = INCOME_TYPES.includes(t.type) || ['repay_receive', 'borrow'].includes(t.type);
  t.is_expense = EXPENSE_TYPES.includes(t.type) || ['lend', 'repay_pay'].includes(t.type);
  return t;
}

/* -------------------------------- 查询构建 -------------------------------- */

function buildWhere(ledgerId, f = {}) {
  const where = ['t.ledger_id = ?', 't.deleted_at IS NULL'];
  const params = [ledgerId];

  if (f.types && f.types.length) {
    where.push(`t.type IN (${f.types.map(() => '?').join(',')})`);
    params.push(...f.types);
  } else if (f.type) {
    where.push('t.type = ?');
    params.push(f.type);
  } else if (f.kind === 'expense') {
    where.push(`t.type IN (${EXPENSE_TYPES.map(() => '?').join(',')})`);
    params.push(...EXPENSE_TYPES);
  } else if (f.kind === 'income') {
    where.push(`t.type IN (${INCOME_TYPES.map(() => '?').join(',')})`);
    params.push(...INCOME_TYPES);
  }

  if (f.categoryId) {
    where.push('(t.category_id = ? OR t.category_id IN (SELECT id FROM categories WHERE parent_id = ?))');
    params.push(f.categoryId, f.categoryId);
  }
  if (f.accountId) {
    where.push('(t.account_id = ? OR t.to_account_id = ?)');
    params.push(f.accountId, f.accountId);
  }
  if (f.memberId) { where.push('t.user_id = ?'); params.push(f.memberId); }
  if (f.source) { where.push('t.source = ?'); params.push(f.source); }
  if (f.tagId) {
    where.push('EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.tag_id = ?)');
    params.push(f.tagId);
  }
  if (f.month) {
    where.push("strftime('%Y-%m', t.txn_date) = ?");
    params.push(f.month);
  }
  if (f.from) { where.push('t.txn_date >= ?'); params.push(f.from); }
  if (f.to) { where.push('t.txn_date <= ?'); params.push(f.to); }
  if (f.minCents) { where.push('t.amount_base_cents >= ?'); params.push(f.minCents); }
  if (f.maxCents) { where.push('t.amount_base_cents <= ?'); params.push(f.maxCents); }
  if (f.keyword) {
    where.push('(t.note LIKE ? OR t.merchant LIKE ? OR c.name LIKE ? OR pc.name LIKE ? OR a.name LIKE ? OR CAST(t.amount_base_cents AS TEXT) LIKE ?)');
    const kw = `%${f.keyword}%`;
    params.push(kw, kw, kw, kw, kw, kw);
  }
  if (f.reimbursable === 'yes') where.push('t.is_reimbursable = 1 AND t.reimbursed_at IS NULL');
  if (f.reimbursable === 'done') where.push('t.is_reimbursable = 1 AND t.reimbursed_at IS NOT NULL');
  return { sql: where.join(' AND '), params };
}

function listTransactions(ledgerId, f = {}) {
  const { sql, params } = buildWhere(ledgerId, f);
  const pageSize = Math.min(Math.max(Number(f.pageSize) || 30, 1), 200);
  const page = Math.max(Number(f.page) || 1, 1);
  const total = Number(get(`SELECT COUNT(*) AS c FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN categories pc ON pc.id = c.parent_id WHERE ${sql}`, ...params)?.c || 0);

  const sortMap = {
    date_desc: 't.txn_date DESC, t.id DESC',
    date_asc: 't.txn_date ASC, t.id ASC',
    amount_desc: 't.amount_base_cents DESC',
    amount_asc: 't.amount_base_cents ASC',
  };
  const order = sortMap[f.sort] || sortMap.date_desc;
  const rows = all(
    `${TXN_SELECT} WHERE ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize
  ).map(decorate);

  const sum = get(
    `SELECT
       COALESCE(SUM(CASE WHEN t.type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS income,
       COALESCE(SUM(CASE WHEN t.type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS expense
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN categories pc ON pc.id = c.parent_id WHERE ${sql}`,
    ...INCOME_TYPES, ...EXPENSE_TYPES, ...params
  );
  return {
    rows, total, page, pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    sum: { income: Number(sum?.income || 0), expense: Number(sum?.expense || 0) },
  };
}

function groupByDate(rows) {
  const groups = [];
  let cur = null;
  for (const r of rows) {
    if (!cur || cur.date !== r.txn_date) {
      cur = { date: r.txn_date, items: [], income: 0, expense: 0 };
      groups.push(cur);
    }
    cur.items.push(r);
    if (INCOME_TYPES.includes(r.type)) cur.income += Number(r.amount_base_cents);
    if (EXPENSE_TYPES.includes(r.type)) cur.expense += Number(r.amount_base_cents);
  }
  // 给每笔带上「关联了几张账单截图」，列表页据此显示 📎 标记（一次查询，避免 N+1）
  attach.attachCounts(rows);
  return groups;
}

function getTransaction(id, ledgerId) {
  const t = get(`${TXN_SELECT} WHERE t.id = ? AND t.ledger_id = ? AND t.deleted_at IS NULL`, id, ledgerId);
  return decorate(t);
}

/* -------------------------------- 写入逻辑 -------------------------------- */

function pickAccount(ledgerId, id) {
  if (!id) return null;
  const a = get('SELECT id FROM accounts WHERE id = ? AND ledger_id = ?', Number(id), ledgerId);
  return a ? Number(a.id) : null;
}
function pickCategory(ledgerId, id) {
  if (!id) return null;
  const c = get('SELECT id FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)', Number(id), ledgerId);
  return c ? Number(c.id) : null;
}

/**
 * 写入一笔交易
 * @param {object} d 表单数据
 */
function createTransaction(ledgerId, userId, d) {
  const type = TXN_TYPE_MAP[d.type] ? d.type : 'expense';
  // 余额调整（adjust）的金额是带符号的差额（调减为负），其余类型一律取绝对值
  const isAdjust = type === 'adjust';
  const rawAmount = Math.round(Number(d.amount_cents) || 0);
  const amount = isAdjust ? rawAmount : Math.abs(rawAmount);
  if (!amount) throw new Error('金额必须大于 0');
  const rate = Number(d.rate) > 0 ? Number(d.rate) : 1;
  const currency = d.currency || 'CNY';
  const accountId = pickAccount(ledgerId, d.account_id);
  const toAccountId = pickAccount(ledgerId, d.to_account_id);
  if (['expense', 'income', 'lend', 'borrow', 'repay_pay', 'repay_receive', 'fee', 'interest'].includes(type) && !accountId) {
    throw new Error('请选择账户');
  }
  if (isAdjust && !accountId) throw new Error('余额调整需要指定账户');
  if (type === 'transfer' && (!accountId || !toAccountId)) throw new Error('转账需要选择转出与转入账户');
  if (type === 'transfer' && accountId === toAccountId) throw new Error('转出与转入账户不能相同');
  // 投资买卖同样是双边交易：缺转入/转出账户会导致资金凭空蒸发或净效果为 0
  if ((type === 'invest_buy' || type === 'invest_sell') && (!accountId || !toAccountId)) throw new Error('投资买入/卖出需要选择付款与入账账户');
  if ((type === 'invest_buy' || type === 'invest_sell') && accountId === toAccountId) throw new Error('投资交易的双方账户不能相同');

  const txnDate = /^\d{4}-\d{2}-\d{2}$/.test(String(d.txn_date || '')) ? d.txn_date : todayStr();
  const info = run(
    `INSERT INTO transactions
     (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
      user_id, txn_date, note, merchant, status, is_reimbursable, group_id, source, ai_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ledgerId, type, amount, currency, rate, toBase(amount, rate), accountId, toAccountId,
    pickCategory(ledgerId, d.category_id), userId, txnDate,
    d.note ? String(d.note).slice(0, 300) : null,
    d.merchant ? String(d.merchant).slice(0, 60) : null,
    d.status === 'pending' ? 'pending' : 'cleared',
    d.is_reimbursable ? 1 : 0,
    d.group_id || null,
    d.source || 'manual',
    d.ai_json || null,
    nowStr(), nowStr()
  );
  const id = info.lastInsertRowid;
  applyTags(id, ledgerId, d.tags);
  if (d.splits && d.splits.length) saveSplits(ledgerId, id, d.group_id, d.splits);
  recalcBalances(ledgerId);
  syncDebts(ledgerId);
  return id;
}

function updateTransaction(id, ledgerId, userId, d) {
  const old = get('SELECT * FROM transactions WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL', id, ledgerId);
  if (!old) throw new Error('记录不存在');
  const type = TXN_TYPE_MAP[d.type] ? d.type : old.type;
  const rawAmount = Math.round(Number(d.amount_cents) || 0);
  const amount = type === 'adjust' ? rawAmount : Math.abs(rawAmount);
  if (!amount) throw new Error('金额必须大于 0');
  const rate = Number(d.rate) > 0 ? Number(d.rate) : 1;
  const accountId = pickAccount(ledgerId, d.account_id);
  const toAccountId = pickAccount(ledgerId, d.to_account_id);
  if (type === 'transfer' && (!accountId || !toAccountId)) throw new Error('转账需要选择转出与转入账户');
  if (type === 'transfer' && accountId === toAccountId) throw new Error('转出与转入账户不能相同');
  run(
    `UPDATE transactions SET type=?, amount_cents=?, currency=?, rate=?, amount_base_cents=?, account_id=?,
       to_account_id=?, category_id=?, txn_date=?, note=?, merchant=?, status=?, is_reimbursable=?,
       updated_at=? WHERE id=?`,
    type, amount, d.currency || old.currency, rate, toBase(amount, rate),
    accountId, toAccountId,
    pickCategory(ledgerId, d.category_id),
    /^\d{4}-\d{2}-\d{2}$/.test(String(d.txn_date || '')) ? d.txn_date : old.txn_date,
    d.note ? String(d.note).slice(0, 300) : null,
    d.merchant ? String(d.merchant).slice(0, 60) : null,
    d.status === 'pending' ? 'pending' : 'cleared',
    d.is_reimbursable ? 1 : 0,
    nowStr(), id
  );
  applyTags(id, ledgerId, d.tags, true);
  if (d.splits && d.splits.length) saveSplits(ledgerId, id, old.group_id, d.splits);
  else if (Array.isArray(d.splits) && old.group_id) run('DELETE FROM splits WHERE transaction_id = ?', id);
  recalcBalances(ledgerId);
  syncDebts(ledgerId);
  return id;
}

function softDelete(id, ledgerId) {
  const t = get('SELECT * FROM transactions WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!t) return false;
  run('UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?', nowStr(), nowStr(), id);
  // 分账数据保留（物理删除后「恢复」就找不回来了）；列表/统计均按 deleted_at 过滤，无副作用
  recalcBalances(ledgerId);
  syncDebts(ledgerId);
  return true;
}

function bulkDelete(ids, ledgerId) {
  let n = 0;
  tx(() => {
    for (const id of ids) {
      const t = get('SELECT id FROM transactions WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL', Number(id), ledgerId);
      if (!t) continue;
      run('UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?', nowStr(), nowStr(), Number(id));
      n++;
    }
    // 整批只重算一次；软删不物理清分账，恢复后数据完整
    recalcBalances(ledgerId);
    syncDebts(ledgerId);
  });
  return n;
}

/** 报销：把若干笔标记为已报销，并生成一笔报销入账 */
function markReimbursed(ids, ledgerId, userId, accountId) {
  if (!ids || !ids.length) throw new Error('没有可报销的记录');
  const rows = all(
    `SELECT * FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL
       AND is_reimbursable = 1 AND reimbursed_at IS NULL
       AND type IN ('expense', 'fee')
       AND id IN (${ids.map(() => '?').join(',')})`,
    ledgerId, ...ids
  );
  const total = rows.reduce((a, b) => a + Number(b.amount_base_cents), 0);
  if (!rows.length || !total) throw new Error('没有可报销的记录');
  return tx(() => {
    const txnId = createTransaction(ledgerId, userId, {
      type: 'reimburse',
      amount_cents: total,
      account_id: accountId,
      category_id: null,
      txn_date: todayStr(),
      note: `报销 ${rows.length} 笔，合计 ${(total / 100).toFixed(2)}`,
      source: 'manual',
    });
    for (const r of rows) {
      run('UPDATE transactions SET reimbursed_at = ?, related_id = ? WHERE id = ?', nowStr(), txnId, r.id);
    }
    return { txnId, total, count: rows.length };
  });
}

/* ---------------------------------- 标签 ---------------------------------- */

function applyTags(txnId, ledgerId, tagsInput, replace = false) {
  const names = String(tagsInput || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (replace) run('DELETE FROM transaction_tags WHERE transaction_id = ?', txnId);
  if (!names.length) return;
  for (const name of names) {
    let tag = get('SELECT * FROM tags WHERE ledger_id = ? AND name = ?', ledgerId, name);
    if (!tag) {
      const info = run('INSERT INTO tags (ledger_id, name, color) VALUES (?,?,?)', ledgerId, name, colorFromName(name));
      tag = { id: info.lastInsertRowid };
    }
    try { run('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?,?)', txnId, tag.id); } catch { /* ignore */ }
  }
}

function colorFromName(name) {
  const palette = ['#4f7cff', '#13c2c2', '#52c41a', '#fa8c16', '#eb2f96', '#722ed1', '#fa541c'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997;
  return palette[h % palette.length];
}

/* ---------------------------------- 分账 ---------------------------------- */

function saveSplits(ledgerId, txnId, groupId, splits) {
  const gid = groupId || `sp_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  // 只替换本笔交易的分账：按 transaction_id 删，避免 group_id 被多笔共享时误删他人分账
  run('DELETE FROM splits WHERE transaction_id = ?', txnId);
  for (const s of splits) {
    const share = Math.round(Number(s.share_cents) || 0);
    if (!share) continue;
    run(
      `INSERT INTO splits (group_id, transaction_id, ledger_id, user_id, member_name, share_cents, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      gid, txnId, ledgerId, s.user_id || null, String(s.member_name || '成员').slice(0, 30), share, nowStr()
    );
  }
  run('UPDATE transactions SET group_id = ? WHERE id = ?', gid, txnId);
  return gid;
}

function splitsOf(txnId) {
  return all('SELECT * FROM splits WHERE transaction_id = ? ORDER BY id', txnId);
}

/* ------------------------------- 借贷台账同步 ------------------------------ */

/**
 * 根据借贷类交易自动维护 debts 台账：
 * 借出 → 生成应收；借入 → 生成应付。同一 (方向, 对手方) 未结清的台账自动累加。
 */
function syncDebts(ledgerId) {
  const rows = all(
    `SELECT * FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND type IN ('lend','borrow')`,
    ledgerId
  );
  // 已结清台账不重建，简单策略：按 对手方+方向 聚合未结清
  const map = new Map();
  for (const t of rows) {
    const key = `${t.type}|${t.merchant || '未指定'}`;
    const cur = map.get(key) || { direction: t.type === 'lend' ? 'receivable' : 'payable', counterparty: t.merchant || '未指定', principal: 0, account_id: t.account_id, earliest: t.txn_date };
    cur.principal += Number(t.amount_base_cents);
    if (t.txn_date < cur.earliest) cur.earliest = t.txn_date;
    map.set(key, cur);
  }
  // 还款金额
  const repay = new Map();
  for (const t of all(
    `SELECT * FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND type IN ('repay_receive','repay_pay')`,
    ledgerId
  )) {
    const key = `${t.type === 'repay_receive' ? 'lend' : 'borrow'}|${t.merchant || '未指定'}`;
    repay.set(key, (repay.get(key) || 0) + Number(t.amount_base_cents));
  }
  // 清掉自动生成的（note 标记）再重建
  run("DELETE FROM debts WHERE ledger_id = ? AND note = '系统自动汇总'", ledgerId);
  for (const [key, v] of map) {
    const paid = repay.get(key) || 0;
    const balance = Math.max(0, v.principal - paid);
    run(
      `INSERT INTO debts (ledger_id, direction, counterparty, principal_cents, balance_cents, account_id, status, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      ledgerId, v.direction, v.counterparty, v.principal, balance, v.account_id,
      balance <= 0 ? 'closed' : 'open', '系统自动汇总', nowStr()
    );
  }
}

/* --------------------------------- 统计聚合 -------------------------------- */

function rangeOf(month) {
  return { start: `${month}-01`, end: `${month}-31`, month };
}

/** 区间收支合计 */
function summary(ledgerId, start, end) {
  const row = get(
    `SELECT
      COALESCE(SUM(CASE WHEN type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS expense,
      COUNT(*) AS count
     FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ?`,
    ...INCOME_TYPES, ...EXPENSE_TYPES, ledgerId, start, end
  );
  const income = Number(row?.income || 0);
  const expense = Number(row?.expense || 0);
  return { income, expense, net: income - expense, count: Number(row?.count || 0) };
}

/** 按一级分类聚合 */
function categoryBreakdown(ledgerId, start, end, kind = 'expense') {
  const types = kind === 'income' ? INCOME_TYPES : EXPENSE_TYPES;
  const rows = all(
    `SELECT COALESCE(pc.name, c.name, '未分类') AS name,
            COALESCE(pc.icon, c.icon, '🏷️') AS icon,
            COALESCE(pc.color, c.color, '#8c8c8c') AS color,
            SUM(t.amount_base_cents) AS total, COUNT(*) AS cnt
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN categories pc ON pc.id = c.parent_id
     WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
       AND t.type IN (${types.map(() => '?').join(',')})
     GROUP BY COALESCE(pc.name, c.name, '未分类')
     ORDER BY total DESC`,
    ledgerId, start, end, ...types
  );
  return rows.map((r) => ({ ...r, total: Number(r.total), cnt: Number(r.cnt) }));
}

/** 按二级分类聚合（用于下钻） */
function subcategoryBreakdown(ledgerId, start, end, kind = 'expense', topName = null) {
  const types = kind === 'income' ? INCOME_TYPES : EXPENSE_TYPES;
  let sql = `SELECT c.name AS name, c.icon AS icon, c.color AS color, COALESCE(pc.name,'未分类') AS parent,
              SUM(t.amount_base_cents) AS total, COUNT(*) AS cnt
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN categories pc ON pc.id = c.parent_id
       WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
         AND t.type IN (${types.map(() => '?').join(',')})`;
  const params = [ledgerId, start, end, ...types];
  if (topName) { sql += ' AND COALESCE(pc.name, c.name) = ?'; params.push(topName); }
  sql += ' GROUP BY c.id ORDER BY total DESC';
  return all(sql, ...params).map((r) => ({ ...r, total: Number(r.total), cnt: Number(r.cnt) }));
}

/** 最近 n 个月收支趋势 */
function monthlyTrend(ledgerId, months = 6, ref = new Date()) {
  const list = lastMonths(months, ref);
  const from = `${list[0]}-01`;
  const to = `${list[list.length - 1]}-31`;
  const rows = all(
    `SELECT strftime('%Y-%m', txn_date) AS m,
      COALESCE(SUM(CASE WHEN type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS expense
     FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ?
     GROUP BY m`,
    ...INCOME_TYPES, ...EXPENSE_TYPES, ledgerId, from, to
  );
  const map = new Map(rows.map((r) => [r.m, r]));
  return list.map((m) => {
    const r = map.get(m) || { income: 0, expense: 0 };
    return { month: m, income: Number(r.income), expense: Number(r.expense) };
  });
}

/** 按成员聚合 */
function memberBreakdown(ledgerId, start, end) {
  return all(
    `SELECT u.id, u.display_name AS name, u.avatar_color AS color,
       COALESCE(SUM(CASE WHEN t.type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS expense,
       COALESCE(SUM(CASE WHEN t.type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS income,
       COUNT(*) AS cnt
     FROM transactions t JOIN users u ON u.id = t.user_id
     WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
     GROUP BY u.id ORDER BY expense DESC`,
    ...EXPENSE_TYPES, ...INCOME_TYPES, ledgerId, start, end
  ).map((r) => ({ ...r, expense: Number(r.expense), income: Number(r.income), cnt: Number(r.cnt) }));
}

/** 每日聚合（日历/趋势） */
function dailyBreakdown(ledgerId, start, end) {
  return all(
    `SELECT txn_date AS date,
      COALESCE(SUM(CASE WHEN type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS expense,
      COALESCE(SUM(CASE WHEN type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS income,
      COUNT(*) AS count
     FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ?
     GROUP BY txn_date ORDER BY txn_date`,
    ...EXPENSE_TYPES, ...INCOME_TYPES, ledgerId, start, end
  ).map((r) => ({ date: r.date, expense: Number(r.expense), income: Number(r.income), count: Number(r.count) }));
}

/** 账户概览 */
function accountOverview(ledgerId) {
  const accounts = all('SELECT * FROM accounts WHERE ledger_id = ? AND is_archived = 0 ORDER BY sort_order, id', ledgerId);
  let assets = 0, liabilities = 0;
  for (const a of accounts) {
    const b = Number(a.balance_cents);
    // 统一口径：正余额计资产、负余额计负债（含透支的虚拟账户），
    // 保证「净资产 = 资产 − 负债」与逐账户求和恒等；负债类账户的溢缴款（正余额）计资产
    if (b > 0) assets += b;
    else liabilities += -b;
  }
  const net = accounts.filter((a) => a.include_in_net).reduce((s, a) => s + Number(a.balance_cents), 0);
  return { accounts, assets, liabilities, net };
}

/** 累计净支出（用于净资产走势的近似） */
function netWorthTrend(ledgerId, months = 6) {
  const list = lastMonths(months);
  const allTxns = all(
    `SELECT txn_date, type, amount_base_cents, account_id, to_account_id FROM transactions
     WHERE ledger_id = ? AND deleted_at IS NULL ORDER BY txn_date`,
    ledgerId
  );
  const accounts = all('SELECT id, initial_cents FROM accounts WHERE ledger_id = ?', ledgerId);
  const initial = accounts.reduce((s, a) => s + Number(a.initial_cents), 0);
  const { txnEffects } = require('../db');
  const out = [];
  let cum = initial;
  let idx = 0;
  for (const m of list) {
    const end = `${m}-31`;
    while (idx < allTxns.length && allTxns[idx].txn_date <= end) {
      for (const e of txnEffects(allTxns[idx])) cum += e.delta;
      idx++;
    }
    out.push({ month: m, value: cum });
  }
  return out;
}

module.exports = {
  INCOME_TYPES, EXPENSE_TYPES, TXN_SELECT, decorate,
  listTransactions, groupByDate, getTransaction,
  createTransaction, updateTransaction, softDelete, bulkDelete, markReimbursed,
  applyTags, saveSplits, splitsOf,
  summary, categoryBreakdown, subcategoryBreakdown, monthlyTrend, memberBreakdown,
  dailyBreakdown, accountOverview, netWorthTrend, rangeOf, syncDebts,
};

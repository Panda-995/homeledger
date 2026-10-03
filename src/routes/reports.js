'use strict';
/** 报表与图表 */
const express = require('express');
const { all, get, todayStr } = require('../db');
const auth = require('../lib/auth');
const txn = require('../lib/txn');
const fd = require('../lib/formdata');
const u = require('../lib/util');

const router = express.Router();

function parseRange(q, ledgerId = 0) {
  const today = todayStr();
  const curMonth = today.slice(0, 7);
  const preset = q.preset || 'month';
  if (preset === 'year') {
    const y = /^\d{4}$/.test(String(q.year || '')) ? q.year : today.slice(0, 4);
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: `${y}年`, preset, key: y };
  }
  if (preset === 'custom' && q.from && q.to) {
    return { start: q.from, end: q.to, label: `${q.from} ~ ${q.to}`, preset, key: `${q.from}_${q.to}` };
  }
  if (preset === 'quarter') {
    const m = Number(curMonth.slice(5, 7));
    const qn = Math.floor((m - 1) / 3);
    const startM = qn * 3 + 1;
    const y = curMonth.slice(0, 4);
    return {
      start: `${y}-${u.pad(startM)}-01`,
      end: `${y}-${u.pad(startM + 2)}-31`,
      label: `${y}年 第${qn + 1} 季度`, preset, key: `${y}Q${qn + 1}`,
    };
  }
  if (preset === 'all') {
    // 始终用当前会话账本，query 里的 ledger_id 不参与（避免跨账本探测）
    const first = get('SELECT MIN(txn_date) AS d FROM transactions WHERE ledger_id = ?', Number(ledgerId) || 0);
    return { start: first?.d || `${curMonth}-01`, end: today, label: '全部时间', preset, key: 'all' };
  }
  const month = /^\d{4}-\d{2}$/.test(String(q.month || '')) ? q.month : curMonth;
  return { start: `${month}-01`, end: `${month}-31`, label: u.monthLabel(month), preset: 'month', key: month, month };
}

router.get('/reports', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const range = parseRange(req.query, ledgerId);
  const kind = req.query.kind === 'income' ? 'income' : 'expense';

  const sum = txn.summary(ledgerId, range.start, range.end);
  const cats = txn.categoryBreakdown(ledgerId, range.start, range.end, kind);
  const subcats = txn.subcategoryBreakdown(ledgerId, range.start, range.end, kind, req.query.top || null);
  const trend = txn.monthlyTrend(ledgerId, 12);
  const days = txn.dailyBreakdown(ledgerId, range.start, range.end);
  const members = txn.memberBreakdown(ledgerId, range.start, range.end);
  const netWorth = txn.netWorthTrend(ledgerId, 12);
  const overview = txn.accountOverview(ledgerId);

  // 同期对比
  let compare = null;
  if (range.preset === 'month' && range.month) {
    const prevMonth = u.addMonths(range.month, -1);
    const prev = txn.summary(ledgerId, `${prevMonth}-01`, `${prevMonth}-31`);
    const lastYearMonth = `${Number(range.month.slice(0, 4)) - 1}-${range.month.slice(5, 7)}`;
    const lastYear = txn.summary(ledgerId, `${lastYearMonth}-01`, `${lastYearMonth}-31`);
    compare = {
      prevMonth: { label: u.monthLabel(prevMonth), ...prev },
      lastYear: { label: u.monthLabel(lastYearMonth), ...lastYear },
    };
  }

  // 星期分布
  const weekday = new Array(7).fill(0);
  for (const d of days) {
    const wd = new Date(`${d.date}T00:00:00`).getDay();
    weekday[wd] += d.expense;
  }

  // 消费笔数 & 均值
  const expenseCount = get(
    `SELECT COUNT(*) AS c, COALESCE(AVG(amount_base_cents),0) AS avg FROM transactions
     WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ? AND type IN ('expense','fee')`,
    ledgerId, range.start, range.end
  );
  const maxDay = days.reduce((a, b) => (b.expense > (a?.expense || 0) ? b : a), null);

  // 记账天数
  const activeDays = days.filter((d) => d.count > 0).length;

  res.render('reports', {
    title: '报表分析', activeNav: 'reports',
    range, kind, sum, cats, subcats, trend, days, members, netWorth, overview,
    compare, weekday, expenseCount, maxDay, activeDays,
    top: req.query.top || null,
    today: todayStr(),
  });
});

module.exports = router;

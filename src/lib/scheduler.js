'use strict';
/**
 * 后台定时任务
 *  - 周期账单自动记账
 *  - 预算超支 / 额度预警
 *  - 借贷到期提醒
 *  - 失效邀请码与会话清理
 * 每天执行一次 + 每 30 分钟兜底轮询
 */
const { all, get, run, tx, nowStr, todayStr } = require('../db');
const { notify, ledgerWriterIds, alreadyNotified } = require('./auth');
const { addMonths, pad, monthOf } = require('./util');

/* ------------------------------ 周期账单自动记账 ----------------------------- */

function advanceDate(dateStr, rule) {
  const d = new Date(`${dateStr}T00:00:00`);
  const n = Math.max(1, Number(rule.interval_n) || 1);
  switch (rule.frequency) {
    case 'daily':
      d.setDate(d.getDate() + n);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7 * n);
      break;
    case 'yearly':
      d.setFullYear(d.getFullYear() + n);
      break;
    case 'monthly':
    default: {
      const day = Number(rule.day_of_month) || d.getDate();
      d.setMonth(d.getMonth() + n);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, last));
      break;
    }
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 解包周期账单 payload：兼容 {items:[…], user_id} 包装、纯数组、单对象三种历史格式 */
function ruleItems(payload) {
  let p = payload;
  try { p = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch { return []; }
  if (Array.isArray(p)) return p;
  if (p && Array.isArray(p.items)) return p.items;
  return p ? [p] : [];
}

function runDueRecurring(today = todayStr()) {
  const rules = all('SELECT * FROM recurring_rules WHERE is_active = 1 AND next_run_at <= ?', today);
  const { recalcBalances } = require('../db');
  let created = 0;
  const touchedLedgers = new Set();
  for (const rule of rules) {
    const items = ruleItems(rule.payload);
    tx(() => {
      // 仅自动记账规则真正落库；非自动模式只提醒（否则不推进 next_run_at 会被 30 分钟轮询反复记账）
      if (rule.auto_post) {
        for (const p of items) {
          const amount = Math.abs(Number(p.amount_cents) || 0);
          if (!amount) continue;
          run(
            `INSERT INTO transactions
             (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
              user_id, txn_date, note, merchant, status, source, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            rule.ledger_id, p.type || 'expense', amount, p.currency || 'CNY', 1, amount,
            p.account_id || null, p.to_account_id || null, p.category_id || null,
            rule.created_by_user_id || 1, rule.next_run_at,
            p.note || rule.name, p.merchant || null, 'cleared', 'recurring', nowStr(), nowStr()
          );
          created++;
        }
      }
      if (rule.auto_post) {
        run('UPDATE recurring_rules SET last_run_at = ?, next_run_at = ? WHERE id = ?', rule.next_run_at, advanceDate(rule.next_run_at, rule), rule.id);
      }
    });
    touchedLedgers.add(Number(rule.ledger_id));
    if (rule.auto_post) continue;
    // 非自动模式：只提醒（dedupe key 按计划日期去重，避免每 30 分钟轮询重复轰炸）
    const dedupeKey = `recurring:${rule.id}:${rule.next_run_at}`;
    if (!alreadyNotified(dedupeKey)) {
      for (const uid of ledgerWriterIds(rule.ledger_id)) {
        notify(uid, {
          kind: 'recurring', ledgerId: rule.ledger_id,
          title: `周期账单待确认：${rule.name}`,
          body: `计划日期 ${rule.next_run_at} |${dedupeKey}`,
          link: '/recurring',
        });
      }
    }
    run('UPDATE recurring_rules SET last_run_at = ? WHERE id = ?', nowStr(), rule.id);
  }
  // 自动记账后余额必须重算（手动记账/订阅扣费路径都会重算，这里此前漏了）
  for (const lid of touchedLedgers) {
    try { recalcBalances(lid); } catch { /* 单账本失败不影响其他任务 */ }
  }
  return created;
}

/* -------------------------------- 预算预警 -------------------------------- */

/** 计算某预算在指定月的已用金额（分） */
function budgetUsed(b, month) {
  const start = `${month}-01`;
  const end = `${month}-31`;
  const params = [b.ledger_id, start, end];
  let sql = `SELECT COALESCE(SUM(amount_base_cents),0) AS s FROM transactions
             WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date >= ? AND txn_date <= ?`;
  const typeCond = b.trigger_type === 'income' ? "AND type IN ('income')" : "AND type IN ('expense','lend','repay_pay','fee','invest_buy')";
  sql += ` ${typeCond}`;
  if (b.scope === 'category' && b.category_id) {
    sql += ' AND (category_id = ? OR category_id IN (SELECT id FROM categories WHERE parent_id = ?))';
    params.push(b.category_id, b.category_id);
  }
  if (b.scope === 'account' && b.account_id) {
    sql += ' AND account_id = ?';
    params.push(b.account_id);
  }
  const r = get(sql, ...params);
  return Number(r?.s || 0);
}

function budgetPeriodRange(b, ref = new Date()) {
  const month = `${ref.getFullYear()}-${pad(ref.getMonth() + 1)}`;
  switch (b.period) {
    case 'yearly':
      return { start: `${ref.getFullYear()}-01-01`, end: `${ref.getFullYear()}-12-31`, label: `${ref.getFullYear()}年`, key: String(ref.getFullYear()) };
    case 'weekly': {
      const d = new Date(ref);
      const wd = (d.getDay() + 6) % 7; // 周一为一周开始
      const s = new Date(d.getTime() - wd * 86400000);
      const e = new Date(s.getTime() + 6 * 86400000);
      const f = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
      const monday = f(s);
      return { start: f(s), end: f(e), label: `${monday} 当周`, key: monday };
    }
    case 'custom':
      return { start: b.start_date || `${month}-01`, end: b.end_date || `${month}-31`, label: '自定义周期', key: `${b.start_date}_${b.end_date}` };
    case 'monthly':
    default:
      return { start: `${month}-01`, end: `${month}-31`, label: `${month}`, key: month };
  }
}

function budgetUsedInRange(b, start, end) {
  const params = [b.ledger_id, start, end];
  const typeCond = b.trigger_type === 'income' ? "AND type IN ('income')" : "AND type IN ('expense','lend','repay_pay','fee','invest_buy')";
  let sql = `SELECT COALESCE(SUM(amount_base_cents),0) AS s FROM transactions
             WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ? ${typeCond}`;
  if (b.scope === 'category' && b.category_id) {
    sql += ' AND (category_id = ? OR category_id IN (SELECT id FROM categories WHERE parent_id = ?))';
    params.push(b.category_id, b.category_id);
  }
  if (b.scope === 'account' && b.account_id) {
    sql += ' AND account_id = ?';
    params.push(b.account_id);
  }
  return Number(get(sql, ...params)?.s || 0);
}

function checkBudgets() {
  const budgets = all('SELECT * FROM budgets WHERE is_active = 1');
  const ref = new Date();
  let alerted = 0;
  for (const b of budgets) {
    const range = budgetPeriodRange(b, ref);
    const used = budgetUsedInRange(b, range.start, range.end);
    const amount = Number(b.amount_cents) || 0;
    if (amount <= 0) continue;
    const ratio = (used / amount) * 100;
    const alertAt = Number(b.alert_pct) || 80;
    let level = null;
    if (ratio >= 100) level = 'over';
    else if (ratio >= alertAt) level = 'warn';
    if (!level) continue;
    const dedupeKey = `budget:${b.id}:${range.key}:${level}`;
    if (alreadyNotified(dedupeKey)) continue;
    const title = level === 'over'
      ? `预算超支：${b.name}`
      : `预算预警：${b.name}`;
    const body = `已用 ${(used / 100).toFixed(2)} / ${(amount / 100).toFixed(2)}（${ratio.toFixed(0)}%）|${dedupeKey}`;
    for (const uid of ledgerWriterIds(b.ledger_id)) {
      notify(uid, { kind: level === 'over' ? 'danger' : 'warn', ledgerId: b.ledger_id, title, body, link: '/budgets' });
    }
    alerted++;
  }
  return alerted;
}

/* -------------------------------- 借贷到期 -------------------------------- */

function checkDebts() {
  const today = todayStr();
  const soon = all(
    `SELECT * FROM debts WHERE status = 'open' AND due_date IS NOT NULL AND due_date <= date(?, '+3 day')`,
    today
  );
  let n = 0;
  for (const d of soon) {
    const dedupeKey = `debt:${d.id}:${d.due_date}`;
    if (alreadyNotified(dedupeKey)) continue;
    const overdue = d.due_date < today;
    const who = d.direction === 'receivable' ? `应收 ${d.counterparty}` : `应付 ${d.counterparty}`;
    for (const uid of ledgerWriterIds(d.ledger_id)) {
      notify(uid, {
        kind: overdue ? 'danger' : 'warn',
        ledgerId: d.ledger_id,
        title: `${overdue ? '已逾期' : '即将到期'}：${who}`,
        body: `金额 ${(d.balance_cents / 100).toFixed(2)}，到期日 ${d.due_date} |${dedupeKey}`,
        link: '/debts',
      });
    }
    n++;
  }
  return n;
}

/* ------------------------------- 储蓄目标提醒 ------------------------------ */

function checkGoals() {
  const today = todayStr();
  const goals = all("SELECT * FROM goals WHERE status = 'active' AND target_date IS NOT NULL AND target_date <= date(?, '+7 day')", today);
  let n = 0;
  for (const g of goals) {
    const dedupeKey = `goal:${g.id}:${g.target_date}`;
    if (alreadyNotified(dedupeKey)) continue;
    const left = Math.max(0, Number(g.target_cents) - Number(g.saved_cents));
    for (const uid of ledgerWriterIds(g.ledger_id)) {
      notify(uid, {
        kind: 'info', ledgerId: g.ledger_id,
        title: `储蓄目标临近：${g.name}`,
        body: `还差 ${(left / 100).toFixed(2)}，目标日 ${g.target_date} |${dedupeKey}`,
        link: '/goals',
      });
    }
    n++;
  }
  return n;
}

/* -------------------------------- 订阅扣费 --------------------------------- */

/**
 * 订阅扣费（到期自动记账）与提醒
 * 逻辑都在 lib/subscriptions.js，这里只做调度兜底与日志
 */
function runSubscriptions(today = todayStr()) {
  const subs = require('./subscriptions');
  const r = subs.runDue(today);
  const reminded = subs.checkReminders(today);
  return { charged: r.charged, renewed: r.renewed, notified: r.notified + reminded };
}

/* -------------------------------- 清理任务 -------------------------------- */

function cleanup() {
  try {
    run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    run("DELETE FROM ledger_invites WHERE expires_at IS NOT NULL AND expires_at < ?", todayStr());
  } catch { /* ignore */ }
}

/* --------------------------------- 调度入口 -------------------------------- */

function runDaily() {
  const r = { recurring: 0, budgets: 0, debts: 0, goals: 0, subscriptions: { charged: 0, renewed: 0, notified: 0 } };
  try { r.recurring = runDueRecurring(); } catch (e) { console.error('[scheduler] 周期账单失败:', e.message); }
  try { r.subscriptions = runSubscriptions(); } catch (e) { console.error('[scheduler] 订阅扣费失败:', e.message); }
  try { r.budgets = checkBudgets(); } catch (e) { console.error('[scheduler] 预算检查失败:', e.message); }
  try { r.debts = checkDebts(); } catch (e) { console.error('[scheduler] 借贷检查失败:', e.message); }
  try { r.goals = checkGoals(); } catch (e) { console.error('[scheduler] 目标检查失败:', e.message); }
  try { cleanup(); } catch { /* ignore */ }
  return r;
}

function initScheduler() {
  // 启动时先跑一次（补上次停机期间漏掉的周期账单与订阅扣费）
  setTimeout(() => {
    const r = runDaily();
    const sub = r.subscriptions || {};
    if (r.recurring || r.budgets || r.debts || r.goals || sub.charged || sub.notified) {
      console.log(
        `[scheduler] 启动检查完成：周期账单 ${r.recurring} 笔 / 订阅扣费 ${sub.charged} 笔（转正 ${sub.renewed}）/ ` +
        `提醒 ${sub.notified} / 预算预警 ${r.budgets} / 借贷提醒 ${r.debts} / 目标提醒 ${r.goals}`
      );
    }
  }, 3000).unref?.();

  const timer = setInterval(() => {
    runDaily();
  }, 30 * 60 * 1000);
  timer.unref?.();
  return timer;
}

module.exports = { initScheduler, runDaily, runDueRecurring, runSubscriptions, checkBudgets, checkDebts, checkGoals, budgetPeriodRange, budgetUsedInRange, budgetUsed, advanceDate, ruleItems };

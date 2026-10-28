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
const u = require('./util');

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
    case 'yearly': {
      // 2/29 年付钳到 02/28，避免 setFullYear 溢出成 3/1 后永久漂移
      const y2 = d.getFullYear() + n;
      const last = new Date(y2, 2, 0).getDate();
      d.setFullYear(y2, d.getMonth(), Math.min(d.getDate(), last));
      break;
    }
    case 'monthly':
    default: {
      // 月末锚点必须用纯算术先定年月再钳日：
      // setMonth 在 1/31 + 1 个月时会溢出成 3/2，后续再钳日就永远停在 3 月（整月跳账）
      const day = Number(rule.day_of_month) || d.getDate();
      const total = d.getMonth() + n;
      const y2 = d.getFullYear() + Math.floor(total / 12);
      const m2 = (total % 12) + 1;
      const last = new Date(y2, m2, 0).getDate();
      return `${y2}-${pad(m2)}-${pad(Math.min(day, last))}`;
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
  const typeCond = b.trigger_type === 'income' ? "AND type IN ('income')" : "AND type IN ('expense','fee')";
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
      const cs = b.start_date || `${month}-01`;
      const ce = b.end_date || `${month}-31`;
      // 起止填反时自动交换，否则统计区间恒空
      return ce < cs
        ? { start: ce, end: cs, label: '自定义周期', key: `${ce}_${cs}` }
        : { start: cs, end: ce, label: '自定义周期', key: `${cs}_${ce}` };
    case 'monthly':
    default:
      return { start: `${month}-01`, end: `${month}-31`, label: `${month}`, key: month };
  }
}

function budgetUsedInRange(b, start, end) {
  const params = [b.ledger_id, start, end];
  const typeCond = b.trigger_type === 'income' ? "AND type IN ('income')" : "AND type IN ('expense','fee')";
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

function monthlyOverview(ledgerId, ref = new Date()) {
  const rows = all(
    "SELECT * FROM budgets WHERE ledger_id = ? AND is_active = 1 AND period = 'monthly' AND trigger_type != 'income'",
    ledgerId
  );
  if (!rows.length) return null;
  const overall = rows.filter((b) => b.scope === 'overall');
  const use = overall.length ? overall : rows;
  const range = budgetPeriodRange(use[0], ref);
  const total = use.reduce((s, b) => s + Number(b.amount_cents || 0), 0);
  // scope='overall' 的多条预算看到的是同一批流水，只能计一次，否则已花会重复累加
  const used = overall.length
    ? budgetUsedInRange(overall[0], range.start, range.end)
    : use.reduce((s, b) => s + budgetUsedInRange(b, range.start, range.end), 0);
  const ratio = total > 0 ? (used / total) * 100 : 0;
  const alertAt = Math.min(...use.map((b) => Number(b.alert_pct) || 80));
  const remain = total - used;

  const today = todayStr();
  let daysLeft = 0;
  if (today < range.start) daysLeft = Math.round((new Date(`${range.end}T00:00:00`) - new Date(`${range.start}T00:00:00`)) / 86400000) + 1;
  else if (today <= range.end) daysLeft = Math.round((new Date(`${range.end}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86400000) + 1;

  return {
    total, used, remain, ratio, alertAt, daysLeft, count: use.length,
    dailyAllowance: daysLeft > 0 ? Math.max(0, Math.round(remain / daysLeft)) : 0,
    level: ratio >= 100 ? 'over' : ratio >= alertAt ? 'warn' : 'ok',
    scopeLabel: overall.length ? '总预算口径' : '分类/账户预算汇总',
    rangeLabel: range.label,
  };
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
    // 外部推送：开启「即时预警」时同步推一条到企业微信
    try {
      const nc = require('./notify-channels');
      const cfg = nc.getConfig();
      if (cfg.enabled && cfg.instant) {
        const icon = level === 'over' ? '🚨' : '⚠️';
        nc.push(
          `## ${icon} ${title}\n> 已用 ${(used / 100).toFixed(2)} / ${(amount / 100).toFixed(2)}（${ratio.toFixed(0)}%）\n` +
          `- 预警线：${alertAt}%\n- ${level === 'over' ? `已超支 ${((used - amount) / 100).toFixed(2)}` : `剩余 ${((amount - used) / 100).toFixed(2)}`}`
        ).catch(() => {});
      }
    } catch { /* 推送失败不影响主流程 */ }
    alerted++;
  }
  return alerted;
}

/* ----------------------------- 每日预算汇总推送 ---------------------------- */

/**
 * 构造某个账本的「本月预算日报」markdown。
 * 返回 null 表示该账本没有可汇总的月度预算（不推送）。
 *
 * 内容（Q3「全要」）：
 *   本月预算 / 已花 / 剩余 / 剩余每天可用 / 超支金额 / 按当前速度预测月底
 */
function buildBudgetDigest(ledgerId, ref = new Date(), { forecast = true } = {}) {
  const ov = monthlyOverview(ledgerId, ref);
  if (!ov) return null;

  const ledger = get('SELECT name, icon, currency FROM ledgers WHERE id = ?', ledgerId);
  const cur = ledger?.currency || 'CNY';
  const today = todayStr();
  const range = budgetPeriodRange({ period: 'monthly' }, ref);

  // 本月已过天数：用于「按当前速度」预测
  const startD = new Date(`${range.start}T00:00:00`);
  const todayD = new Date(`${today}T00:00:00`);
  const elapsedRaw = Math.round((todayD - startD) / 86400000) + 1;
  const totalDays = Math.round((new Date(`${range.end}T00:00:00`) - startD) / 86400000) + 1;
  const elapsed = Math.min(Math.max(elapsedRaw, 1), Math.max(totalDays, 1));

  const pct = ov.ratio.toFixed(0);
  const icon = ov.level === 'over' ? '🔴' : ov.level === 'warn' ? '🟡' : '🟢';

  const lines = [];
  lines.push(`## ${icon} 本月预算日报 · ${ledger?.icon || '📒'} ${ledger?.name || '家账簿'}`);
  lines.push(`> ${range.label} · ${ov.scopeLabel}`);
  lines.push('');
  lines.push(`- **本月预算**：${u.money(ov.total, cur)}`);
  lines.push(`- **已花**：${u.money(ov.used, cur)}（${pct}%）`);
  if (ov.remain >= 0) {
    lines.push(`- **剩余**：${u.money(ov.remain, cur)}`);
  } else {
    lines.push(`- **已超支**：${u.money(-ov.remain, cur)}（超出 ${pct}%）`);
  }
  if (ov.daysLeft > 0) {
    lines.push(`- **剩余每天可用**：${u.money(ov.dailyAllowance, cur)}（本月还剩 ${ov.daysLeft} 天）`);
  } else {
    lines.push('- 本月已结束');
  }

  // 按当前速度预测月底
  if (forecast && elapsed > 0 && ov.used > 0) {
    const projected = Math.round((ov.used / elapsed) * totalDays);
    const diff = projected - ov.total;
    lines.push('');
    if (diff > 0) {
      lines.push(`📈 按当前速度（日均 ${u.money(Math.round(ov.used / elapsed), cur)}），预计月底花费 **${u.money(projected, cur)}**，` +
        `将超支 **${u.money(diff, cur)}**，建议放慢节奏。`);
    } else {
      lines.push(`📉 按当前速度（日均 ${u.money(Math.round(ov.used / elapsed), cur)}），预计月底花费 **${u.money(projected, cur)}**，` +
        `在预算内，预计结余 ${u.money(-diff, cur)}。`);
    }
  }

  if (ov.level === 'warn') lines.push(`\n⚠️ 已超过预警线 ${ov.alertAt}%`);
  if (ov.level === 'over') lines.push('\n🚨 本月预算已超支');

  return lines.join('\n');
}

/**
 * 构造某个账本的「本月支出简报」——该账本**没有月度预算**时用。
 * 返回 null 表示本月没有任何支出（不推送，避免空账本每天收 0 元）。
 *
 * 内容：本月支出（含笔数）/ 日均支出 / 最近一笔 / 一句「去设预算」的建议。
 */
function buildSpendDigest(ledgerId, ref = new Date()) {
  const range = budgetPeriodRange({ period: 'monthly' }, ref);
  const row = get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM transactions
      WHERE ledger_id = ? AND deleted_at IS NULL AND type = 'expense' AND txn_date >= ? AND txn_date <= ?`,
    ledgerId, range.start, range.end
  );
  const n = Number(row?.n || 0);
  if (!n) return null;

  const ledger = get('SELECT name, icon, currency FROM ledgers WHERE id = ?', ledgerId);
  const cur = ledger?.currency || 'CNY';
  const used = Number(row?.cents) || 0;

  const today = todayStr();
  const startD = new Date(`${range.start}T00:00:00`);
  const todayD = new Date(`${today}T00:00:00`);
  const elapsedRaw = Math.round((todayD - startD) / 86400000) + 1;
  const totalDays = Math.round((new Date(`${range.end}T00:00:00`) - startD) / 86400000) + 1;
  const elapsed = Math.min(Math.max(elapsedRaw, 1), Math.max(totalDays, 1));

  const last = get(
    `SELECT txn_date, amount_cents, merchant, note FROM transactions
      WHERE ledger_id = ? AND deleted_at IS NULL AND type = 'expense' AND txn_date >= ? AND txn_date <= ?
      ORDER BY txn_date DESC, id DESC LIMIT 1`,
    ledgerId, range.start, range.end
  );

  const lines = [];
  lines.push(`## 📊 本月支出简报 · ${ledger?.icon || '📒'} ${ledger?.name || '家账簿'}`);
  lines.push(`> ${range.label} · 还没有设置月度预算`);
  lines.push('');
  lines.push(`- **本月支出**：${u.money(used, cur)}（${n} 笔）`);
  lines.push(`- **日均支出**：${u.money(Math.round(used / elapsed), cur)}（本月已过 ${elapsed} 天）`);
  if (last) {
    const who = String(last.merchant || last.note || '一笔支出').slice(0, 20);
    lines.push(`- **最近一笔**：${u.money(last.amount_cents, cur)} ${who}（${last.txn_date}）`);
  }
  lines.push('');
  lines.push('💡 在「预算管理」里设一个月度预算后，这条简报会升级成预算日报（含剩余、剩余每天可用、月底预测）。');
  return lines.join('\n');
}

/**
 * 每日推送：有月度预算的账本发「预算日报」，只有支出没有预算的账本发「支出简报」。
 * 去重键按「日期 + 账本 + 类型」——同一天重复调度只推一次。
 * 返回推送成功的条数。
 */
async function pushDailyBudgetDigest(ref = new Date()) {
  const nc = require('./notify-channels');
  const cfg = nc.getConfig();
  if (!cfg.enabled || !cfg.digest) return 0;

  const key = `${todayStr()}`;
  const range = budgetPeriodRange({ period: 'monthly' }, ref);
  let sent = 0;
  const handled = new Set();

  /** 推送成功后在站内留痕（正文转纯文本，并把去重键留在 body 末尾） */
  function leaveTrace(ledgerId, title, md, dedupeKey) {
    const plain = typeof nc.mdToText === 'function' ? nc.mdToText(md) : md;
    for (const uid of ledgerWriterIds(ledgerId)) {
      notify(uid, { kind: 'info', ledgerId, title, body: `${plain.slice(0, 300)} |${dedupeKey}`, link: '/budgets' });
    }
  }

  // 1) 有月度预算的账本 → 预算日报
  const budgetLedgers = all('SELECT DISTINCT ledger_id FROM budgets WHERE is_active = 1 AND period = ?', 'monthly');
  for (const { ledger_id: ledgerId } of budgetLedgers) {
    handled.add(ledgerId);
    const dedupeKey = `budget-digest:${ledgerId}:${key}`;
    if (alreadyNotified(dedupeKey)) continue;
    const md = buildBudgetDigest(ledgerId, ref, { forecast: cfg.forecast });
    if (!md) continue;
    const r = await nc.push(md);
    if (r.ok) {
      sent++;
      leaveTrace(ledgerId, '本月预算日报已推送', md, dedupeKey);
    }
  }

  // 2) 本月有支出、但没设预算的账本 → 支出简报（不再无声跳过）
  const spendLedgers = all(
    `SELECT DISTINCT ledger_id FROM transactions
      WHERE deleted_at IS NULL AND type = 'expense' AND txn_date >= ? AND txn_date <= ?`,
    range.start, range.end
  );
  for (const { ledger_id: ledgerId } of spendLedgers) {
    if (handled.has(ledgerId)) continue;
    const dedupeKey = `spend-digest:${ledgerId}:${key}`;
    if (alreadyNotified(dedupeKey)) continue;
    const md = buildSpendDigest(ledgerId, ref);
    if (!md) continue;
    const r = await nc.push(md);
    if (r.ok) {
      sent++;
      leaveTrace(ledgerId, '本月支出简报已推送', md, dedupeKey);
    }
  }
  return sent;
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

/**
 * 定时钩子：到点后推送每日预算日报。
 * 每 30 分钟的轮询调用本函数；由「配置的推送时间 + 当天已推去重键」保证一天只推一次。
 */
function tickDigest() {
  let cfg;
  try { cfg = require('./notify-channels').getConfig(); } catch { return; }
  if (!cfg.enabled || !cfg.digest) return;
  const now = nowStr();
  const hhmm = now.slice(11, 16);
  if (hhmm < cfg.time) return; // 未到推送时间
  pushDailyBudgetDigest().catch((e) => console.error('[scheduler] 预算日报推送失败:', e.message));
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
    tickDigest();
  }, 3000).unref?.();

  const timer = setInterval(() => {
    runDaily();
    tickDigest();
  }, 30 * 60 * 1000);
  timer.unref?.();
  return timer;
}

module.exports = {
  initScheduler, runDaily, runDueRecurring, runSubscriptions, checkBudgets, checkDebts, checkGoals,
  budgetPeriodRange, budgetUsedInRange, budgetUsed, monthlyOverview, advanceDate,
  buildBudgetDigest, buildSpendDigest, pushDailyBudgetDigest, tickDigest,
  ruleItems,
};

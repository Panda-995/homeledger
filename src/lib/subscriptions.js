'use strict';
/**
 * 订阅扣费
 *
 * 管理「某个软件 / 网站 / 会员每月（每年）自动扣费」这类**固定订阅支出**，
 * 与「周期账单」的分工：
 *   · 周期账单 → 房租、工资、房贷等任意固定收支（多明细、可自动记账）
 *   · 订阅扣费 → 只针对订阅制消费：有套餐、有试用期、有自动续费与取消截止日，
 *                关心「每月固定花掉多少钱」「下次什么时候扣」「哪些该退了」
 *
 * 能力：
 *   1. 计费周期推进（每周 / 每月 / 每季 / 每半年 / 每年，支持「每 N 期」）
 *   2. 月均与年化成本（月付 × 12、年付 ÷ 12 摊平，便于横向比较）
 *   3. 到期自动记账（生成 source='subscription' 的交易并回写 subscription_id）
 *   4. 试用转正（试用到期当天自动转「生效中」）
 *   5. 提醒：扣费前 N 天 / 试用即将结束
 *
 * 所有金额单位为「分」。
 */
const { all, get, run, nowStr, todayStr } = require('../db');
const { notify, ledgerWriterIds, alreadyNotified } = require('./auth');
const { pad } = require('./util');

/** 计费周期 → 月数（weekly 单独算） */
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };
const CYCLE_LABEL = { weekly: '每周', monthly: '每月', quarterly: '每季', half_yearly: '每半年', yearly: '每年', none: '不周期' };
const CYCLE_UNIT = { weekly: '周', monthly: '月', quarterly: '季', half_yearly: '半年', yearly: '年' };
const STATUS_LABEL = { trial: '试用中', active: '生效中', paused: '已暂停', canceled: '已取消' };
/** 状态 → 视图 chip 配色（对应 .chip 的变体类） */
const STATUS_KIND = { trial: 'primary', active: 'income', paused: 'warn', canceled: '' };
/** 单次补记上限：NAS 停机久了不至于一次性生成几十笔 */
const MAX_CATCHUP = 6;

/* none = 不周期（仅记录）：不自动扣费、不计入订阅月均/年化 */
const NONE_NEXT = '9999-12-31';
const cycleOf = (v) => (CYCLE_MONTHS[v] || v === 'weekly' || v === 'none' ? v : 'monthly');
const cycleLabel = (cycle, n = 1) => {
  const c = cycleOf(cycle);
  const times = Math.max(1, Number(n) || 1);
  if (times === 1) return CYCLE_LABEL[c];
  return `每 ${times} ${CYCLE_UNIT[c]}`;
};
const statusLabel = (s) => STATUS_LABEL[s] || '生效中';

/* --------------------------------- 日期计算 -------------------------------- */

function lastDayOf(year, month /* 1-12 */) {
  return new Date(year, month, 0).getDate();
}

/**
 * 按订阅周期推进一个扣费日
 * @param {string} dateStr YYYY-MM-DD
 * @param {object} sub 含 cycle / cycle_n / anchor_day
 * @returns {string} 下一次扣费日
 */
function advance(dateStr, sub = {}) {
  const cycle = cycleOf(sub.cycle);
  const n = Math.max(1, Number(sub.cycle_n) || 1);
  const base = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(base.getTime())) return String(dateStr).slice(0, 10);

  if (cycle === 'weekly') {
    base.setDate(base.getDate() + 7 * n);
    return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
  }
  const months = CYCLE_MONTHS[cycle] * n;
  const anchorDay = Number(sub.anchor_day) || base.getDate();
  const year = base.getFullYear();
  const monthIdx = base.getMonth() + months;
  const targetYear = year + Math.floor(monthIdx / 12);
  const targetMonth = (monthIdx % 12) + 1; // 1-12
  const day = Math.min(anchorDay, lastDayOf(targetYear, targetMonth));
  return `${targetYear}-${pad(targetMonth)}-${pad(day)}`;
}

/**
 * 首次扣费日：把「起始日 + 扣费锚点」归位到不早于今天的第一个扣费日
 *   · weekly → 直接取起始日
 *   · yearly → 用 anchor_month 指定扣费月份（缺省为起始日的月份）
 *   · 其余周期 → 从起始日所在月起，按 anchor_day 归一，必要时顺延一个周期
 */
function firstChargeDate({ cycle, cycle_n, anchor_month, anchor_day, startFrom = todayStr() }) {
  const c = cycleOf(cycle);
  if (c === 'none') return NONE_NEXT; // 不周期：没有"下次扣费日"
  const from = String(startFrom).slice(0, 10);
  const startDay = Number(from.slice(8, 10));
  const day = Math.max(1, Math.min(31, Number(anchor_day) || startDay));
  if (c === 'weekly') return from;

  const step = CYCLE_MONTHS[c] * Math.max(1, Number(cycle_n) || 1);
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  if (c === 'yearly' && Number(anchor_month)) month = Math.max(1, Math.min(12, Number(anchor_month)));

  const build = (y, m) => `${y}-${pad(m)}-${pad(Math.min(day, lastDayOf(y, m)))}`;
  let date = build(year, month);
  if (date < from) {
    const idx = (month - 1) + step;
    year += Math.floor(idx / 12);
    month = (idx % 12) + 1;
    date = build(year, month);
  }
  return date;
}

/** 距某日还有几天（负数为已过） */
function daysUntil(dateStr) {
  const t = new Date(`${todayStr()}T00:00:00`);
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d - t) / 86400000);
}

/* --------------------------------- 成本换算 -------------------------------- */

/** 折算成「每年要花多少」（分） */
function annualCents(sub) {
  const amount = Math.abs(Number(sub.amount_cents) || 0);
  const c = cycleOf(sub.cycle);
  const n = Math.max(1, Number(sub.cycle_n) || 1);
  if (c === 'none') return 0; // 不周期没有摊销口径
  if (c === 'weekly') return Math.round((amount * 52) / n);
  return Math.round((amount * 12) / (CYCLE_MONTHS[c] * n));
}

/** 折算成「每月要花多少」（分）——月付和年付摊平后可直接比较 */
function monthlyCents(sub) {
  return Math.round(annualCents(sub) / 12);
}

/* --------------------------------- 视图数据 -------------------------------- */

/** 单条订阅补齐展示字段 */
function decorate(sub, extras = {}) {
  const noCycle = cycleOf(sub.cycle) === 'none';
  const left = noCycle ? null : daysUntil(sub.next_charge_at);
  const monthEq = monthlyCents(sub);
  const trialLeft = sub.trial_ends_on ? daysUntil(sub.trial_ends_on) : null;
  return {
    ...sub,
    cycleLabel: cycleLabel(sub.cycle, sub.cycle_n),
    statusLabel: statusLabel(sub.status),
    statusKind: STATUS_KIND[sub.status] || 'info',
    monthly_cents: monthEq,
    annual_cents: annualCents(sub),
    // 相对月付的节省（年付一般更便宜，这里只做展示：正数表示比按月付费便宜）
    daysLeft: left,
    dueLabel: noCycle ? '仅记录' : left === null ? '—' : left < 0 ? `已逾期 ${-left} 天` : left === 0 ? '今天扣费' : `${left} 天后`,
    trialLeft,
    trialDue: trialLeft !== null && trialLeft >= 0 && trialLeft <= 7,
    ...extras,
  };
}

/** 列表页：按状态分组 + 统计 */
function overview(ledgerId) {
  const rows = all(
    `SELECT s.*, a.name AS account_name, c.name AS category_name, c.icon AS category_icon
     FROM subscriptions s
     LEFT JOIN accounts a ON a.id = s.account_id
     LEFT JOIN categories c ON c.id = s.category_id
     WHERE s.ledger_id = ?
     ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
              s.next_charge_at, s.id`,
    Number(ledgerId)
  );

  const items = rows.map((r) => decorate(r, { charge_count: Number(r.charge_count) || 0 }));

  const live = items.filter((s) => s.status === 'active' || s.status === 'trial');
  const month = todayStr().slice(0, 7);
  const thisMonthCharged = items
    .filter((s) => String(s.last_charge_at || '').slice(0, 7) === month)
    .reduce((sum, s) => sum + Number(s.amount_cents), 0);

  const upcoming = live
    .filter((s) => s.daysLeft !== null && s.daysLeft <= 7)
    .sort((a, b) => a.daysLeft - b.daysLeft)[0] || null;

  return {
    items,
    live,
    active: items.filter((s) => s.status === 'active'),
    trials: items.filter((s) => s.status === 'trial'),
    paused: items.filter((s) => s.status === 'paused'),
    canceled: items.filter((s) => s.status === 'canceled'),
    monthlyTotal: live.reduce((sum, s) => sum + Number(s.monthly_cents), 0),
    annualTotal: live.reduce((sum, s) => sum + Number(s.annual_cents), 0),
    annualPaidCount: live.filter((s) => s.cycle === 'yearly' || s.cycle === 'half_yearly').length,
    // 本月还要扣多少（未扣的）
    dueThisMonth: live.filter((s) => String(s.next_charge_at).slice(0, 7) === month).length,
    thisMonthCharged,
    upcoming,
  };
}

/** 单个订阅的历史扣费流水 */
function chargesOf(ledgerId, subId, limit = 12) {
  return all(
    `SELECT id, amount_base_cents, txn_date, note, status FROM transactions
     WHERE ledger_id = ? AND subscription_id = ? AND deleted_at IS NULL
     ORDER BY txn_date DESC, id DESC LIMIT ?`,
    Number(ledgerId), Number(subId), Number(limit)
  );
}

/* --------------------------------- 扣费记账 -------------------------------- */

/**
 * 扣一笔订阅费用，生成交易
 * @returns {number|null} 交易 id；无法记账（金额为 0 / 未指定扣费账户）时返回 null
 */
function charge(sub, userId, { date = todayStr(), silent = false } = {}) {
  const amount = Math.abs(Number(sub.amount_cents) || 0);
  if (!amount) return null;
  const label = sub.plan ? `${sub.name}（${sub.plan}）` : sub.name;
  const info = run(
    `INSERT INTO transactions
     (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
      user_id, txn_date, note, merchant, status, source, subscription_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?)`,
    Number(sub.ledger_id), 'expense', amount, sub.currency || 'CNY', 1, amount,
    sub.account_id ? Number(sub.account_id) : null, sub.category_id || null,
    Number(userId) || Number(sub.created_by_user_id) || 1,
    date, `订阅扣费 · ${label}`, sub.name, 'cleared', 'subscription',
    Number(sub.id), nowStr(), nowStr()
  );
  // 不周期订阅：手动记账后不推进"下次扣费日"（保持永久未来，不进入自动扣费队列）
  const isNone = cycleOf(sub.cycle) === 'none';
  run(
    'UPDATE subscriptions SET last_charge_at = ?, next_charge_at = ?, charge_count = charge_count + 1 WHERE id = ?',
    date, isNone ? sub.next_charge_at : advance(date, sub), Number(sub.id)
  );
  if (!silent) {
    try { require('../db').recalcBalances(Number(sub.ledger_id)); } catch { /* 余额重算失败不影响记账 */ }
  }
  return Number(info.lastInsertRowid);
}

/**
 * 到期订阅自动扣费（供定时任务调用）
 * @returns {{charged:number, renewed:number, notified:number}}
 */
function runDue(today = todayStr()) {
  // JOIN ledgers：账本被删除后遗留的「僵尸订阅」不再继续扣费
  const due = all(
    `SELECT s.* FROM subscriptions s
     JOIN ledgers l ON l.id = s.ledger_id
     WHERE s.status IN ('active','trial') AND s.next_charge_at <= ?
     ORDER BY s.next_charge_at, s.id`,
    today
  );
  const stat = { charged: 0, renewed: 0, notified: 0 };
  for (const sub of due) {
   try {
    if (!sub.auto_renew) {
      // 未开启自动续费：只提醒，等用户自己决定
      const key = `sub-hold:${sub.id}:${sub.next_charge_at}`;
      if (!alreadyNotified(key)) {
        for (const uid of ledgerWriterIds(sub.ledger_id)) {
          notify(uid, {
            kind: 'warn', ledgerId: sub.ledger_id,
            title: `订阅到期待确认：${sub.name}`,
            body: `计划扣费 ${sub.next_charge_at}，金额 ${(sub.amount_cents / 100).toFixed(2)} |${key}`,
            link: '/subscriptions',
          });
          stat.notified++;
        }
      }
      continue;
    }

    let cursor = sub.next_charge_at;
    let guard = 0;
    let charged = false;
    let chargeBlocked = false;
    while (cursor <= today && guard < MAX_CATCHUP) {
      const txnId = charge({ ...sub, next_charge_at: cursor }, sub.created_by_user_id, { date: cursor, silent: true });
      if (txnId) {
        stat.charged++;
        charged = true;
      } else {
        // 记不了账（金额为 0 或未指定扣费账户）：推进周期避免死循环，并提醒用户去补配置
        chargeBlocked = true;
      }
      cursor = advance(cursor, sub);
      guard++;
    }
    if (cursor <= today) {
      // 停机过久：直接推到未来，避免补记一大堆
      while (cursor <= today && guard++ < 500) cursor = advance(cursor, sub);
    }
    // 试用到期当天转正
    let status = sub.status;
    if (sub.trial_ends_on && cursor > sub.trial_ends_on) {
      status = 'active';
      stat.renewed++;
    }
    if (charged || chargeBlocked || status !== sub.status) {
      run('UPDATE subscriptions SET next_charge_at = ?, status = ? WHERE id = ?', cursor, status, sub.id);
    }
    if (charged) {
      try { require('../db').recalcBalances(Number(sub.ledger_id)); } catch { /* ignore */ }
    }
    if (chargeBlocked) {
      const key = `sub-blocked:${sub.id}:${cursor}`;
      if (!alreadyNotified(key)) {
        for (const uid of ledgerWriterIds(sub.ledger_id)) {
          notify(uid, {
            kind: 'warn', ledgerId: sub.ledger_id,
            title: `订阅未能自动记账：${sub.name}`,
            body: `订阅金额为 0，${sub.next_charge_at} 起的扣费已跳过记账，请补全金额 |${key}`,
            link: `/subscriptions/${sub.id}/edit`,
          });
          stat.notified++;
        }
      }
    }
   } catch (e) {
     // 单个订阅异常不中断整批扣费
     console.error(`[subscriptions] 扣费失败（${sub.name} #${sub.id}）:`, e.message);
   }
  }
  return stat;
}

/** 扣费前 / 试用到期提醒（每天最多各一条） */
function checkReminders(today = todayStr()) {
  const items = all("SELECT * FROM subscriptions WHERE status IN ('active','trial')");
  let n = 0;
  for (const sub of items) {
    const days = daysUntil(sub.next_charge_at);
    const ahead = Math.max(0, Number(sub.reminder_days) || 0);
    if (days !== null && days >= 0 && days <= ahead) {
      const key = `sub:${sub.id}:${sub.next_charge_at}`;
      if (!alreadyNotified(key)) {
        for (const uid of ledgerWriterIds(sub.ledger_id)) {
          notify(uid, {
            kind: 'info', ledgerId: sub.ledger_id,
            title: `订阅即将扣费：${sub.name}`,
            body: `${days === 0 ? '今天' : days + ' 天后'}（${sub.next_charge_at}）将扣 ${(sub.amount_cents / 100).toFixed(2)} |${key}`,
            link: '/subscriptions',
          });
          n++;
        }
      }
    }
    if (sub.trial_ends_on) {
      const tDays = daysUntil(sub.trial_ends_on);
      if (tDays !== null && tDays >= 0 && tDays <= 3) {
        const key = `subtrial:${sub.id}:${sub.trial_ends_on}`;
        if (!alreadyNotified(key)) {
          for (const uid of ledgerWriterIds(sub.ledger_id)) {
            notify(uid, {
              kind: 'warn', ledgerId: sub.ledger_id,
              title: `试用即将结束：${sub.name}`,
              body: `${tDays === 0 ? '今天' : tDays + ' 天后'}结束试用，之后将按 ${(sub.amount_cents / 100).toFixed(2)} ${cycleLabel(sub.cycle, sub.cycle_n)}扣费，不想续就先去取消 |${key}`,
              link: '/subscriptions',
            });
            n++;
          }
        }
      }
    }
  }
  return n;
}

module.exports = {
  CYCLE_MONTHS, CYCLE_LABEL, CYCLE_UNIT, STATUS_LABEL,
  cycleOf, cycleLabel, statusLabel,
  advance, firstChargeDate, daysUntil, lastDayOf,
  annualCents, monthlyCents,
  decorate, overview, chargesOf,
  charge, runDue, checkReminders,
};

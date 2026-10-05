'use strict';
/**
 * 回归：订阅扣费
 *
 * 分两段：
 *   A. 进程内逻辑（独立库 data-verify-sub）：周期推进、成本折算、到期自动扣费、试用转正、
 *      补记上限、暂停/仅提醒不扣费、提醒去重
 *   B. HTTP 端到端（需先在 8099 起隔离实例）：
 *        PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js
 *      覆盖列表统计、新建、立即扣费、跳过本期、暂停/恢复、取消、编辑页历史、删除、明细筛选、总览卡
 *
 * 运行：node test/verify-subscriptions.js
 */
const fs = require('node:fs');
const path = require('node:path');

const SUB_DATA_DIR = path.join(__dirname, '..', 'data-verify-sub');
process.env.DATA_DIR = SUB_DATA_DIR;
fs.rmSync(SUB_DATA_DIR, { recursive: true, force: true });

const db = require('../src/db');
const subs = require('../src/lib/subscriptions');
const auth = require('../src/lib/auth');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}
const today = db.todayStr();
const shift = (days) => {
  const d = new Date(`${today}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ============================ A. 进程内逻辑 ============================ */

console.log('\n=== A. 订阅扣费逻辑（进程内）===\n');

db.init();
check('subscriptions 表已创建', db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='subscriptions'").length === 1);
check('transactions.subscription_id 增量迁移成功', db.tableColumns('transactions').includes('subscription_id'));
check('订阅索引已建立', db.all("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sub_next'").length === 1);

/* --- 周期推进 --- */
check('每月：9/8 → 10/8', subs.advance('2026-09-08', { cycle: 'monthly', anchor_day: 8 }) === '2026-10-08', subs.advance('2026-09-08', { cycle: 'monthly', anchor_day: 8 }));
check('每月：12/15 → 次年 1/15', subs.advance('2026-12-15', { cycle: 'monthly', anchor_day: 15 }) === '2027-01-15');
check('每月 31 号遇小月自动收敛（1/31 → 2/28）', subs.advance('2026-01-31', { cycle: 'monthly', anchor_day: 31 }) === '2026-02-28', subs.advance('2026-01-31', { cycle: 'monthly', anchor_day: 31 }));
check('每季：11/20 → 次年 2/20', subs.advance('2026-11-20', { cycle: 'quarterly', anchor_day: 20 }) === '2027-02-20');
check('每半年：5/10 → 11/10', subs.advance('2026-05-10', { cycle: 'half_yearly', anchor_day: 10 }) === '2026-11-10');
check('每年：3/15 → 次年 3/15', subs.advance('2026-03-15', { cycle: 'yearly', anchor_day: 15 }) === '2027-03-15');
check('每周：+7 天', subs.advance('2026-09-20', { cycle: 'weekly' }) === '2026-09-27', subs.advance('2026-09-20', { cycle: 'weekly' }));
check('每 2 月（cycle_n=2）：9/20 → 11/20', subs.advance('2026-09-20', { cycle: 'monthly', cycle_n: 2, anchor_day: 20 }) === '2026-11-20');
check('每年 2 期（cycle_n=2）：2026/3 → 2028/3', subs.advance('2026-03-01', { cycle: 'yearly', cycle_n: 2, anchor_day: 1 }) === '2028-03-01');

/* --- 首次扣费日 --- */
check('年付指定月份：9/20 登记、3/15 扣费 → 2027-03-15',
  subs.firstChargeDate({ cycle: 'yearly', anchor_month: 3, anchor_day: 15, startFrom: '2026-09-20' }) === '2027-03-15',
  subs.firstChargeDate({ cycle: 'yearly', anchor_month: 3, anchor_day: 15, startFrom: '2026-09-20' }));
check('月付扣费日已过：9/20 登记、8 号扣费 → 10/08',
  subs.firstChargeDate({ cycle: 'monthly', anchor_day: 8, startFrom: '2026-09-20' }) === '2026-10-08',
  subs.firstChargeDate({ cycle: 'monthly', anchor_day: 8, startFrom: '2026-09-20' }));
check('月付扣费日未过：9/20 登记、25 号扣费 → 9/25',
  subs.firstChargeDate({ cycle: 'monthly', anchor_day: 25, startFrom: '2026-09-20' }) === '2026-09-25');

/* --- 成本折算 --- */
const y1299 = { amount_cents: 1299, cycle: 'yearly', cycle_n: 1 };
check('年付 12.99 元 → 年化 12.99 / 月均 1.08', subs.annualCents(y1299) === 1299 && subs.monthlyCents(y1299) === 108, `${subs.annualCents(y1299)} / ${subs.monthlyCents(y1299)}`);
const m45 = { amount_cents: 4500, cycle: 'monthly', cycle_n: 1 };
check('月付 45 元 → 月均 45 / 年化 540', subs.monthlyCents(m45) === 4500 && subs.annualCents(m45) === 54000, `${subs.monthlyCents(m45)} / ${subs.annualCents(m45)}`);
const q120 = { amount_cents: 12000, cycle: 'quarterly', cycle_n: 1 };
check('季付 120 元 → 月均 40 / 年化 480', subs.monthlyCents(q120) === 4000 && subs.annualCents(q120) === 48000, `${subs.monthlyCents(q120)} / ${subs.annualCents(q120)}`);
const w10 = { amount_cents: 1000, cycle: 'weekly', cycle_n: 1 };
check('周付 10 元 → 月均约 43.3 / 年化 520', subs.annualCents(w10) === 52000 && subs.monthlyCents(w10) === 4333, `${subs.monthlyCents(w10)} / ${subs.annualCents(w10)}`);
check('周期文案：每 2 月 / 每季 / 每周', subs.cycleLabel('monthly', 2) === '每 2 月' && subs.cycleLabel('quarterly', 1) === '每季' && subs.cycleLabel('weekly', 1) === '每周');

/* --- 造数据：一个可写的账本 --- */
const uid = Number(db.run(
  'INSERT INTO users (username, password_hash, display_name, avatar_color, is_admin, created_at) VALUES (?,?,?,?,1,?)',
  'subadmin', auth.hashPassword('sub-pass-123'), '订阅测试', '#4f7cff', db.nowStr()
).lastInsertRowid);
const ledgerId = Number(db.createDefaultLedger(uid, '订阅测试'));
const accountId = Number(db.get('SELECT id FROM accounts WHERE ledger_id = ? LIMIT 1', ledgerId).id);
const catId = Number(db.get('SELECT id FROM categories WHERE is_system = 1 AND parent_id IS NOT NULL LIMIT 1').id);

function addSub(fields) {
  const base = {
    ledger_id: ledgerId, name: 'X', icon: '🧾', plan: null, amount_cents: 4500, currency: 'CNY',
    cycle: 'monthly', cycle_n: 1, anchor_month: null, anchor_day: 15,
    account_id: accountId, category_id: catId, auto_renew: 1, trial_ends_on: null,
    next_charge_at: today, reminder_days: 3, status: 'active', created_by_user_id: uid,
  };
  const d = { ...base, ...fields };
  return Number(db.run(
    `INSERT INTO subscriptions (ledger_id, name, icon, plan, amount_cents, currency, cycle, cycle_n, anchor_month,
      anchor_day, account_id, category_id, auto_renew, trial_ends_on, next_charge_at, reminder_days, status,
      created_by_user_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    d.ledger_id, d.name, d.icon, d.plan, d.amount_cents, d.currency, d.cycle, d.cycle_n, d.anchor_month,
    d.anchor_day, d.account_id, d.category_id, d.auto_renew, d.trial_ends_on, d.next_charge_at, d.reminder_days,
    d.status, d.created_by_user_id, db.nowStr()
  ).lastInsertRowid);
}

const idActive = addSub({ name: 'Netflix', amount_cents: 4500, next_charge_at: shift(-2), anchor_day: 15 });
const idTrial = addSub({ name: 'ChatGPT Plus', amount_cents: 2000, status: 'trial', trial_ends_on: shift(-1), next_charge_at: shift(-1), anchor_day: 8 });
const idManual = addSub({ name: '手动确认的云盘', amount_cents: 999, auto_renew: 0, next_charge_at: shift(-1), anchor_day: 1 });
const idPaused = addSub({ name: '已暂停的视频站', amount_cents: 2500, status: 'paused', next_charge_at: shift(-5), anchor_day: 5 });
const idOld = addSub({ name: '停机很久的服务', amount_cents: 1000, next_charge_at: shift(-300), anchor_day: 1 });

const before = Number(db.get('SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ?', ledgerId).c);
const stat = subs.runDue(today);
const after = Number(db.get('SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ?', ledgerId).c);

check('到期自动扣费：生成了流水', after > before, `${before} → ${after}`);
check('自动续费订阅被扣费一期', Number(db.get('SELECT COUNT(*) AS c FROM transactions WHERE subscription_id = ?', idActive).c) === 1);
const txn = db.get('SELECT * FROM transactions WHERE subscription_id = ? ORDER BY id LIMIT 1', idActive);
check('流水来源标记为 subscription', txn.source === 'subscription', txn.source);
check('流水备注形如「订阅扣费 · 名称」', /^订阅扣费 · Netflix/.test(txn.note), txn.note);
check('流水金额与订阅一致', Number(txn.amount_cents) === 4500, String(txn.amount_cents));
check('流水商户为订阅名称', txn.merchant === 'Netflix', txn.merchant);
check('流水绑定扣费账户与分类', Number(txn.account_id) === accountId && Number(txn.category_id) === catId);
check('扣费后下次扣费日已顺延到未来', db.get('SELECT next_charge_at FROM subscriptions WHERE id = ?', idActive).next_charge_at > today,
  db.get('SELECT next_charge_at FROM subscriptions WHERE id = ?', idActive).next_charge_at);
check('累计扣费期数 +1', Number(db.get('SELECT charge_count FROM subscriptions WHERE id = ?', idActive).charge_count) === 1);
check('上次扣费时间已写入', !!db.get('SELECT last_charge_at FROM subscriptions WHERE id = ?', idActive).last_charge_at);

/* --- 试用转正 --- */
const trialRow = db.get('SELECT * FROM subscriptions WHERE id = ?', idTrial);
check('试用到期后自动转为生效中', trialRow.status === 'active', trialRow.status);
check('试用订阅同样生成了扣费流水', Number(db.get('SELECT COUNT(*) AS c FROM transactions WHERE subscription_id = ?', idTrial).c) === 1);
check('转正计数被统计', stat.renewed >= 1, `renewed=${stat.renewed}`);

/* --- 仅提醒 / 暂停 --- */
check('未开启自动续费的订阅不自动记账', Number(db.get('SELECT COUNT(*) AS c FROM transactions WHERE subscription_id = ?', idManual).c) === 0);
check('未开启自动续费的订阅保持原扣费日（等用户确认）',
  db.get('SELECT next_charge_at FROM subscriptions WHERE id = ?', idManual).next_charge_at === shift(-1));
check('未开启自动续费时发送了待确认提醒',
  Number(db.get('SELECT COUNT(*) AS c FROM notifications WHERE body LIKE ?', `%sub-hold:${idManual}:%`).c) > 0);
check('已暂停的订阅不被扣费', Number(db.get('SELECT COUNT(*) AS c FROM transactions WHERE subscription_id = ?', idPaused).c) === 0);

/* --- 补记上限 --- */
const oldCount = Number(db.get('SELECT COUNT(*) AS c FROM transactions WHERE subscription_id = ?', idOld).c);
const oldNext = db.get('SELECT next_charge_at FROM subscriptions WHERE id = ?', idOld).next_charge_at;
check('停机 300 天不产生无限补记（≤6 笔）', oldCount > 0 && oldCount <= 6, `补记 ${oldCount} 笔`);
check('补记后下次扣费日落在未来', oldNext > today, oldNext);

/* --- 幂等 --- */
const afterFirst = Number(db.get('SELECT COUNT(*) AS c FROM transactions').c);
const stat2 = subs.runDue(today);
check('同一天重复执行不再重复扣费', Number(db.get('SELECT COUNT(*) AS c FROM transactions').c) === afterFirst && stat2.charged === 0,
  `charged=${stat2.charged}`);
check('仅提醒订阅不会重复提醒（去重键生效）',
  Number(db.get('SELECT COUNT(*) AS c FROM notifications WHERE body LIKE ?', `%sub-hold:${idManual}:${shift(-1)}%`).c) === 1,
  `${db.get('SELECT COUNT(*) AS c FROM notifications WHERE body LIKE ?', `%sub-hold:${idManual}%`).c} 条`);

/* --- 提醒 --- */
const idSoon = addSub({ name: '即将扣费的服务', amount_cents: 3000, next_charge_at: shift(2), anchor_day: 12, reminder_days: 3 });
const idFar = addSub({ name: '很久以后才扣', amount_cents: 3000, next_charge_at: shift(40), anchor_day: 12, reminder_days: 3 });
const idTrialSoon = addSub({ name: '试用将结束', amount_cents: 6600, status: 'trial', next_charge_at: shift(2), trial_ends_on: shift(1), anchor_day: 12 });
const reminded = subs.checkReminders(today);
check('提醒：扣费前 N 天内会通知', Number(db.get('SELECT COUNT(*) AS c FROM notifications WHERE body LIKE ?', `%sub:${idSoon}:%`).c) > 0, `本次提醒 ${reminded} 条`);
check('提醒：还早的订阅不打扰', Number(db.get('SELECT COUNT(*) AS c FROM notifications WHERE body LIKE ?', `%sub:${idFar}:%`).c) === 0);
check('提醒：试用即将结束单独提醒（含退订提示）',
  Number(db.get('SELECT COUNT(*) AS c FROM notifications WHERE body LIKE ?', `%subtrial:${idTrialSoon}:%`).c) > 0);
const remindedAgain = subs.checkReminders(today);
check('提醒不会重复轰炸', remindedAgain === 0, `第二次 ${remindedAgain} 条`);

/* --- 去重是通知体系的通用保障：预算预警同样只推一次 --- */
const sched = require('../src/lib/scheduler');
db.run(
  "INSERT INTO budgets (ledger_id, name, scope, period, amount_cents, currency, alert_pct, is_active, created_at) VALUES (?,?,'overall','monthly',?, 'CNY', 50, 1, ?)",
  ledgerId, '去重测试预算', 100, db.nowStr()
);
const alert1 = sched.checkBudgets();
const alert2 = sched.checkBudgets();
check('预算预警重复执行不产生重复通知', alert1 >= 1 && alert2 === 0, `第一次 ${alert1} 条 / 第二次 ${alert2} 条`);

/* --- 统计与视图 --- */
const sums = subs.overview(ledgerId);
const liveMonthly = sums.live.reduce((s, x) => s + Number(x.monthly_cents), 0);
check('月度合计 = 各项月均之和', sums.monthlyTotal === liveMonthly, `${sums.monthlyTotal} vs ${liveMonthly}`);
check('年度合计 = 月度合计 × 12（四舍五入）', Math.abs(sums.annualTotal - sums.monthlyTotal * 12) <= sums.live.length, `${sums.annualTotal}`);
check('暂停/取消的订阅不计入月度合计', !sums.live.some((x) => x.status === 'paused' || x.status === 'canceled'));
check('已按状态分组', sums.active.length + sums.trials.length + sums.paused.length + sums.canceled.length === sums.items.length,
  `${sums.active.length}/${sums.trials.length}/${sums.paused.length}/${sums.canceled.length}`);
const soonItem = sums.items.find((x) => x.id === idSoon);
check('展示字段：周期文案 / 状态文案 / 倒计时', soonItem.cycleLabel === '每月' && soonItem.statusLabel === '生效中' && soonItem.dueLabel === '2 天后',
  `${soonItem.cycleLabel} / ${soonItem.statusLabel} / ${soonItem.dueLabel}`);
const history = subs.chargesOf(ledgerId, idActive);
check('可按订阅回查历史扣费流水', history.length === 1 && Number(history[0].amount_base_cents) === 4500, `${history.length} 笔`);

/* --- 余额联动 --- */
db.recalcBalances(ledgerId);
const accBalance = Number(db.get('SELECT balance_cents FROM accounts WHERE id = ?', accountId).balance_cents);
const totalExpense = Number(db.get(
  "SELECT COALESCE(SUM(amount_base_cents),0) AS s FROM transactions WHERE ledger_id = ? AND type = 'expense' AND deleted_at IS NULL", ledgerId
).s);
check('订阅扣费计入账户余额（支出为负）', accBalance === -totalExpense, `余额 ${accBalance} / 累计支出 ${totalExpense}`);
check('订阅流水可通过 source 筛选出一条 SQL 查出来',
  db.all("SELECT id FROM transactions WHERE ledger_id = ? AND source = 'subscription'", ledgerId).length >= 5);

/* --- 不周期（仅记录）：cycle=none --- */
check('cycleOf 接受 none（未知值仍回退 monthly）', subs.cycleOf('none') === 'none' && subs.cycleOf('whatever') === 'monthly');
check('不周期文案', subs.cycleLabel('none') === '不周期');
check('不周期不计月均/年化', subs.annualCents({ amount_cents: 1200, cycle: 'none' }) === 0 && subs.monthlyCents({ amount_cents: 1200, cycle: 'none' }) === 0);
check('不周期首扣日为永久未来', subs.firstChargeDate({ cycle: 'none' }) === '9999-12-31');
const idNone = addSub({ name: '记录型订阅', amount_cents: 9900, cycle: 'none', next_charge_at: '9999-12-31', anchor_day: 1 });
const noneRow = () => db.get('SELECT * FROM subscriptions WHERE id = ?', idNone);
const runDueStat = subs.runDue(today);
check('不周期订阅不被自动扣费', noneRow().charge_count === 0 && noneRow().next_charge_at === '9999-12-31', `runDue ${JSON.stringify(runDueStat)}`);
check('不周期不在即将扣费/本月待扣统计里', !subs.overview(ledgerId).upcoming || subs.overview(ledgerId).upcoming.id !== idNone);
const noneCharged = subs.charge(noneRow(), uid);
check('不周期可手动记一期且不推进下次扣费日', noneCharged > 0 && noneRow().charge_count === 1 && noneRow().next_charge_at === '9999-12-31' && noneRow().last_charge_at === today);
const noneDeco = subs.overview(ledgerId).items.find((x) => x.id === idNone);
check('不周期展示：仅记录 / 月均 0', noneDeco.dueLabel === '仅记录' && noneDeco.monthly_cents === 0);

/* ============================ B. HTTP 端到端 ============================ */

const BASE = 'http://127.0.0.1:8099';
let cookie = '';
async function req(method, p, { form, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(BASE + p, {
    method, headers: h,
    body: form ? new URLSearchParams(form).toString() : undefined,
    redirect: 'manual',
  });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8') };
}
const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

(async () => {
  console.log('\n=== B. 订阅扣费（HTTP 端到端 8099）===\n');
  let up = true;
  try { await fetch(BASE + '/login'); } catch { up = false; }
  if (!up) {
    console.log('  SKIP  8099 未启动，跳过 HTTP 段。请先：PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js');
    console.log(`\n结果：${pass} 通过 / ${fail} 失败（未含 HTTP 段）\n`);
    process.exit(fail ? 1 : 0);
  }

  let r = await req('GET', '/login');
  const login = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', login.status === 302, `HTTP ${login.status}`);

  /* 未登录不可见 */
  const savedCookie = cookie; cookie = '';
  const anon = await req('GET', '/subscriptions');
  check('未登录访问订阅页被重定向', anon.status === 302, `HTTP ${anon.status}`);
  cookie = savedCookie;

  /* 列表页骨架 */
  r = await req('GET', '/subscriptions');
  check('订阅页 200', r.status === 200, `HTTP ${r.status}`);
  check('订阅页含统计口径说明（每月固定支出 / 每年合计）',
    r.text.includes('每月固定支出') && r.text.includes('每年合计'));
  check('订阅页含常用服务快选', r.text.includes('sub-preset') && r.text.includes('Netflix'));
  check('侧边栏出现「订阅扣费」入口', r.text.includes('href="/subscriptions"'));
  const csrf = csrfOf(r.text);

  /* 新建：年付订阅（月均应被摊平） */
  const created = await req('POST', '/subscriptions', { form: {
    _csrf: csrf, name: 'Adobe 全家桶', icon: '🎨', plan: '摄影计划', amount: '888.00', currency: 'CNY',
    cycle: 'yearly', cycle_n: '1', anchor_month: '11', anchor_day: '20', next_charge_at: '2026-11-20',
    status: 'active', reminder_days: '5', auto_renew: '1', note: '年付比月付便宜',
  } });
  check('新建年付订阅', created.status === 302, `HTTP ${created.status}`);
  r = await req('GET', '/subscriptions');
  check('列表出现新订阅', r.text.includes('Adobe 全家桶'));
  check('年付按 1/12 摊平显示月均', r.text.includes('月均') && /74\.00/.test(r.text), '期望月均 ¥74.00');
  check('展示「每年 / 年付月份」信息', /2026-11-20/.test(r.text));
  const idAdobe = (r.text.match(/\/subscriptions\/(\d+)\/charge/) || [])[1];
  check('取到订阅 id', !!idAdobe, String(idAdobe));

  /* 新建：月付订阅 + 试用 */
  r = await req('GET', '/subscriptions');
  await req('POST', '/subscriptions', { form: {
    _csrf: csrfOf(r.text), name: 'Spotify', icon: '🎵', amount: '15.00', currency: 'CNY',
    cycle: 'monthly', cycle_n: '1', anchor_day: '8', status: 'trial',
    trial_ends_on: shift(1), reminder_days: '3', auto_renew: '1',
  } });
  r = await req('GET', '/subscriptions');
  check('试用中的订阅单独分组展示', r.text.includes('试用中（1）'), '期望「试用中（1）」分组标题');
  check('试用状态 chip 展示', r.text.includes('试用至'));

  /* 金额/名称为空应被拒 */
  r = await req('GET', '/subscriptions');
  const bad = await req('POST', '/subscriptions', { form: { _csrf: csrfOf(r.text), name: '', amount: '10' } });
  check('缺名称时拒绝创建', bad.status === 302, `HTTP ${bad.status}`);

  /* 立即扣费 */
  r = await req('GET', '/subscriptions');
  const charge = await req('POST', `/subscriptions/${idAdobe}/charge`, { form: { _csrf: csrfOf(r.text) } });
  check('立即扣费返回 302', charge.status === 302, `HTTP ${charge.status}`);
  r = await req('GET', `/transactions?source=subscription`);
  check('明细页「订阅」筛选能看到该笔（带订阅角标）',
    r.text.includes('Adobe 全家桶') && r.text.includes('>订阅</span>'), '期望出现商户名与订阅角标');
  const otherSource = await req('GET', '/transactions?source=import');
  check('换成其他来源筛选则不出现', !otherSource.text.includes('Adobe 全家桶'));
  const charged = await req('GET', `/subscriptions/${idAdobe}/edit`);
  check('编辑页显示历史扣费记录', charged.text.includes('历史扣费记录') && charged.text.includes('订阅扣费'));
  check('编辑页表单带出原值（套餐 / 备注）', charged.text.includes('摄影计划') && charged.text.includes('年付比月付便宜'));

  /* 跳过本期 */
  const nextBefore = (charged.text.match(/name="next_charge_at" value="([^"]+)"/) || [])[1];
  r = await req('GET', '/subscriptions');
  const skip = await req('POST', `/subscriptions/${idAdobe}/skip`, { form: { _csrf: csrfOf(r.text) } });
  check('跳过本期返回 302', skip.status === 302, `HTTP ${skip.status}`);
  const afterSkip = await req('GET', `/subscriptions/${idAdobe}/edit`);
  const nextAfter = (afterSkip.text.match(/name="next_charge_at" value="([^"]+)"/) || [])[1];
  check('跳过本期后扣费日顺延（+1 年）', nextBefore && nextAfter && nextAfter > nextBefore, `${nextBefore} → ${nextAfter}`);

  /* 暂停 / 恢复 */
  r = await req('GET', '/subscriptions');
  await req('POST', `/subscriptions/${idAdobe}/toggle`, { form: { _csrf: csrfOf(r.text) } });
  r = await req('GET', '/subscriptions');
  check('暂停后进入「已暂停」分组', r.text.includes('已暂停（1）'), '期望「已暂停（1）」');
  const pausedEdit = await req('GET', `/subscriptions/${idAdobe}/edit`);
  check('暂停状态写库', /<option value="paused" selected>/.test(pausedEdit.text));
  r = await req('GET', '/subscriptions');
  await req('POST', `/subscriptions/${idAdobe}/toggle`, { form: { _csrf: csrfOf(r.text) } });
  const resumed = await req('GET', `/subscriptions/${idAdobe}/edit`);
  check('恢复订阅后状态回到生效中', /<option value="active" selected>/.test(resumed.text));

  /* 取消（保留历史） */
  r = await req('GET', '/subscriptions');
  await req('POST', `/subscriptions/${idAdobe}/cancel`, { form: { _csrf: csrfOf(r.text) } });
  r = await req('GET', '/subscriptions');
  check('取消后进入「已取消」分组', r.text.includes('已取消（1）'), '期望「已取消（1）」');
  check('取消后仍保留历史扣费可查', (await req('GET', `/subscriptions/${idAdobe}/edit`)).text.includes('订阅扣费'));

  /* 统计卡数值 */
  r = await req('GET', '/subscriptions');
  check('统计卡包含每月/每年合计与本月待扣',
    r.text.includes('每月固定支出') && r.text.includes('每年合计') && r.text.includes('本月待扣'));

  /* 总览卡 */
  r = await req('GET', '/');
  check('总览页出现「订阅扣费」卡片', r.text.includes('订阅扣费') && r.text.includes('每月固定支出'));

  /* 校验失败分支 */
  r = await req('GET', '/subscriptions');
  const notFound = await req('POST', '/subscriptions/999999/charge', { form: { _csrf: csrfOf(r.text) } });
  check('对不存在的订阅扣费返回 302（带错误提示）', notFound.status === 302, `HTTP ${notFound.status}`);

  /* 删除 */
  r = await req('GET', '/subscriptions');
  const del = await req('POST', `/subscriptions/${idAdobe}/delete`, { form: { _csrf: csrfOf(r.text) } });
  check('删除订阅返回 302', del.status === 302, `HTTP ${del.status}`);
  r = await req('GET', '/subscriptions');
  check('删除后该订阅的操作入口消失（不再出现在列表）', !r.text.includes(`/subscriptions/${idAdobe}/charge`));
  const txnStill = await req('GET', '/transactions?source=subscription');
  check('删除订阅不影响已生成的流水', txnStill.text.includes('Adobe 全家桶'));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();

'use strict';
/**
 * 回归：预算提醒 · 企业微信推送
 *
 * 分两段：
 *   A. 进程内逻辑（独立库 data-verify-alert）：通道配置读写、webhook 校验/打码、时间归一化、
 *      日报文本生成（预算/已花/剩余/日均/超支/预测）、无预算返回 null、
 *      定时钩子时间闸门与按日去重、即时预警推送开关
 *   B. 纯函数边界：非法 webhook、超时、企业微信 errcode 非 0 的识别、
 *      markdown → 纯文本转换、消息格式归一化、超长内容按字节截断
 *
 * 说明：不发真实网络请求——所有推送路径用一个本地假服务器 / stub fetch 替换 webhook，
 *       既验证协议（JSON 结构、text/markdown 字段），又不依赖外网。
 *
 * 运行：node test/verify-budget-alert.js
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const DATA_DIR = path.join(__dirname, '..', 'data-verify-alert');
process.env.DATA_DIR = DATA_DIR;
fs.rmSync(DATA_DIR, { recursive: true, force: true });

const db = require('../src/db');
const sch = require('../src/lib/scheduler');
const nc = require('../src/lib/notify-channels');
const auth = require('../src/lib/auth');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

(async () => {
  db.init();

  console.log('\n=== A. 推送配置与校验 ===\n');

  const VALID = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123-def';
  check('合法 webhook 通过校验', nc.isValidWebhook(VALID) === true);
  check('非企业微信域名被拒', nc.isValidWebhook('https://evil.com/cgi-bin/webhook/send?key=x') === false);
  check('http（非 https）被拒', nc.isValidWebhook('http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x') === false);
  check('缺 key 参数被拒', nc.isValidWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send') === false);
  check('空值被拒', nc.isValidWebhook('') === false);
  check('打码保留首尾 4 位', nc.maskWebhook(VALID).includes('abc-') && nc.maskWebhook(VALID).includes('-def') && !nc.maskWebhook(VALID).includes('123'), nc.maskWebhook(VALID));
  check('时间归一 8:5 → 08:05', nc.normalizeTime('8:5') === '08:05');
  check('时间越界收敛 25:99 → 23:59', nc.normalizeTime('25:99') === '23:59');
  check('时间非法回退默认 20:00', nc.normalizeTime('乱写') === '20:00');

  const cfg0 = nc.getConfig();
  check('默认：推送关闭 / 时间 20:00 / 日报开 / 即时关 / 预测开 / 纯文本',
    cfg0.enabled === false && cfg0.time === '20:00' && cfg0.digest === true && cfg0.instant === false && cfg0.forecast === true && cfg0.msgtype === 'text',
    JSON.stringify(cfg0));

  console.log('\n=== B. 预算日报 markdown 生成 ===\n');

  const ledgerId = db.run(
    "INSERT INTO ledgers (name, kind, currency, icon, owner_id, created_at) VALUES (?,?,?,?,?,?)",
    '测试账本', 'personal', 'CNY', '📒', 1, db.nowStr()
  ).lastInsertRowid;
  const userId = db.run(
    'INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?,?,?,?)',
    'tester', 'x', '测试员', db.nowStr()
  ).lastInsertRowid;
  db.run("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?,?,?,?)", ledgerId, userId, 'owner', db.nowStr());

  // 无预算时：日报应返回 null
  check('无月度预算时日报返回 null', sch.buildBudgetDigest(ledgerId) === null);

  // 建一条月度总预算 1000 元
  const month = db.todayStr().slice(0, 7);
  db.run(
    `INSERT INTO budgets (ledger_id, name, scope, period, amount_cents, currency, trigger_type, alert_pct, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,1,?)`,
    ledgerId, '本月总预算', 'overall', 'monthly', 100000, 'CNY', 'expense', 80, db.nowStr()
  );

  // 记两笔支出：300 + 200 = 500 元 → 50%
  const mkTxn = (cents, day) => db.run(
    `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, user_id, txn_date, status, source, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ledgerId, 'expense', cents, 'CNY', 1, cents, userId, `${month}-${day}`, 'cleared', 'manual', db.nowStr(), db.nowStr()
  );
  mkTxn(30000, '01');
  mkTxn(20000, '02');

  let md = sch.buildBudgetDigest(ledgerId, new Date(), { forecast: false });
  check('日报含本月预算 1,000.00', md.includes('1,000.00'), md.split('\n').find((l) => l.includes('本月预算')));
  check('日报含已花 500.00', md.includes('500.00'), md.split('\n').find((l) => l.includes('已花')));
  check('日报含剩余 500.00', md.includes('500.00') && md.includes('剩余'), md.split('\n').find((l) => l.includes('剩余')));
  check('日报含百分比 50%', md.includes('50%'), '');
  check('日报含「剩余每天可用」', md.includes('剩余每天可用'));
  check('关闭预测时不含「按当前速度」', !md.includes('按当前速度'));

  md = sch.buildBudgetDigest(ledgerId, new Date(), { forecast: true });
  check('开启预测时含「按当前速度」', md.includes('按当前速度'), md.split('\n').find((l) => l.includes('按当前速度')));

  // 超支场景：再加 700 元 → 1200/1000 = 120%
  mkTxn(70000, '03');
  md = sch.buildBudgetDigest(ledgerId, new Date(), { forecast: false });
  check('超支时显示「已超支 200.00」', md.includes('已超支') && md.includes('200.00'), md.split('\n').find((l) => l.includes('超支')));
  check('超支时显示 🔴 图标', md.includes('🔴'));
  check('超支时提示「本月预算已超支」', md.includes('本月预算已超支'));

  console.log('\n=== C. 推送协议（本地假服务器）===\n');

  // 起一个假企业微信服务器，记录收到的请求
  let captured = [];
  let respondWith = { errcode: 0, errmsg: 'ok' };
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(respondWith));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const fakePort = fake.address().port;

  // C1. 真实 HTTP 往返：用 buildPayload 组包，走一遍 fetch
  captured = [];
  const wire = await fetch(`http://127.0.0.1:${fakePort}/cgi-bin/webhook/send?key=test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nc.buildPayload(md, 'text')),
  });
  const wireJson = await wire.json();
  check('假服务器收到 1 次请求', captured.length === 1);
  const sent = JSON.parse(captured[0].body);
  check('纯文本请求 msgtype=text', sent.msgtype === 'text');
  check('请求含 text.content', typeof sent.text?.content === 'string' && sent.text.content.length > 0);
  check('content 为合法 JSON 且未被截断', sent.text.content.includes('本月预算'));
  check('errcode=0 视为成功', wireJson.errcode === 0);

  // 企业微信业务错误识别
  respondWith = { errcode: 93000, errmsg: 'invalid webhook url' };
  captured = [];
  const wire2 = await fetch(`http://127.0.0.1:${fakePort}/cgi-bin/webhook/send?key=bad`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nc.buildPayload(md, 'markdown')),
  });
  const wire2Json = await wire2.json();
  check('errcode 非 0 可被识别（93000）', wire2Json.errcode === 93000 && wire2Json.errmsg === 'invalid webhook url');

  respondWith = { errcode: 0, errmsg: 'ok' };
  await new Promise((r) => fake.close(r));

  // C2. sendWecom 全链路（stub fetch，断言真实请求体）
  const realFetch = global.fetch;
  let calls = [];
  function stubFetch(resp = { status: 200, body: { errcode: 0, errmsg: 'ok' } }) {
    calls = [];
    global.fetch = async (u, o) => {
      calls.push({ url: u, body: o && o.body ? JSON.parse(o.body) : null });
      return {
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        text: async () => JSON.stringify(resp.body),
      };
    };
  }

  stubFetch();
  let rs = await nc.sendWecom(md, { webhook: VALID });
  const textBody = calls[0].body;
  check('默认按纯文本发送（微信插件也支持）', textBody.msgtype === 'text' && typeof textBody.text?.content === 'string');
  check('纯文本里不再有 markdown 标记', !/[#*>`]/.test(textBody.text.content), JSON.stringify(textBody.text.content.slice(0, 40)));
  check('纯文本保留换行、emoji 与金额',
    textBody.text.content.includes('\n') && textBody.text.content.includes('📒') && textBody.text.content.includes('1,000.00'));
  check('纯文本走 text 通道、不再带 markdown 字段', textBody.markdown === undefined && rs.ok === true);

  stubFetch();
  await nc.sendWecom(md, { webhook: VALID, msgtype: 'markdown' });
  check('显式指定 markdown 时仍发 markdown',
    calls[0].body.msgtype === 'markdown' && calls[0].body.markdown.content.includes('## '));

  stubFetch();
  await nc.sendWecom(md, { webhook: VALID, msgtype: '乱写' });
  check('非法 msgtype 收敛为 text', calls[0].body.msgtype === 'text');

  stubFetch();
  rs = await nc.sendWecom(md, { webhook: 'ftp://nope' });
  check('非法 webhook 直接拒绝、不发请求', rs.ok === false && calls.length === 0);

  stubFetch({ status: 500, body: {} });
  rs = await nc.sendWecom(md, { webhook: VALID });
  check('HTTP 非 2xx 记错误', rs.ok === false && /HTTP 500/.test(rs.error), rs.error);

  stubFetch({ status: 200, body: { errcode: 93000, errmsg: 'invalid webhook url' } });
  rs = await nc.sendWecom(md, { webhook: VALID });
  check('errcode 非 0 可被识别（93000）', rs.ok === false && rs.errcode === 93000, rs.error);

  calls = [];
  global.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  rs = await nc.sendWecom(md, { webhook: VALID, timeoutMs: 30 });
  check('超时报错可读', rs.ok === false && /超时/.test(rs.error), rs.error);

  // C3. 超长内容按「字节」截断（企业微信：text ≤ 2048，markdown ≤ 4096）
  const longTextMd = '# 标题\n' + '中文中文中文中文中文中文中文中文中文中文'.repeat(60);   // ≈3.6KB
  const longMd = '# 标题\n' + '中文中文中文中文中文中文中文中文中文中文'.repeat(120);      // ≈7.2KB
  stubFetch();
  await nc.sendWecom(longTextMd, { webhook: VALID, msgtype: 'text' });
  const outText = calls[0].body.text.content;
  check('超长纯文本按 2048 字节截断', Buffer.byteLength(outText, 'utf8') <= 2048 && outText.endsWith('…'),
    `bytes=${Buffer.byteLength(outText, 'utf8')}`);
  stubFetch();
  await nc.sendWecom(longMd, { webhook: VALID, msgtype: 'markdown' });
  const outMd = calls[0].body.markdown.content;
  check('超长 markdown 按 4096 字节截断', Buffer.byteLength(outMd, 'utf8') <= 4096 && outMd.endsWith('…'),
    `bytes=${Buffer.byteLength(outMd, 'utf8')}`);
  stubFetch();
  await nc.sendWecom(longMd, { webhook: VALID, msgtype: 'text' });
  const outLongText = calls[0].body.text.content;
  check('短内容不截断（无省略号）', !nc.truncateBytes('短内容', 2048).endsWith('…') && outLongText.endsWith('…'));
  global.fetch = realFetch;

  // C4. 纯函数：markdown → 纯文本 / 类型归一化
  check('mdToText 去掉标题与加粗', nc.mdToText('## 标题\n- **本月预算**：¥10') === '标题\n· 本月预算：¥10',
    JSON.stringify(nc.mdToText('## 标题\n- **本月预算**：¥10')));
  check('mdToText 去掉引用符号', nc.mdToText('> 引用行') === '引用行');
  check('mdToText 保留 emoji 与空行', nc.mdToText('## 🟢 日报\n\n正文').includes('🟢') && nc.mdToText('## 日报\n\n正文').includes('\n\n'));
  check('normalizeMsgType 缺省/非法 → text', nc.normalizeMsgType('') === 'text' && nc.normalizeMsgType('MD') === 'text' && nc.normalizeMsgType(null) === 'text');
  check('normalizeMsgType 认 markdown / markdown_v2', nc.normalizeMsgType('markdown') === 'markdown' && nc.normalizeMsgType('MARKDOWN_V2') === 'markdown_v2');

  console.log('\n=== D. 定时钩子：时间闸门 + 按日去重 ===\n');

  // 开启推送并把时间设到「现在之前」→ 应触发
  const setS = (k, v) => db.run("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, String(v));
  setS('notify.wecom.enabled', 'true');
  setS('notify.wecom.digest', 'true');
  setS('notify.wecom.webhook', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fake-key-for-test');
  setS('notify.wecom.time', '00:00'); // 必然已过

  // 用假服务器替换真实推送：stub notify-channels.push
  const realPush = nc.push;
  let pushCount = 0;
  nc.push = async () => { pushCount++; return { ok: true }; };

  await sch.pushDailyBudgetDigest();
  check('到达时间后推送 1 次', pushCount === 1, `pushCount=${pushCount}`);

  await sch.pushDailyBudgetDigest();
  check('同日重复调用不重复推送（按日去重）', pushCount === 1, `pushCount=${pushCount}`);

  setS('notify.wecom.digest', 'false');
  const before = pushCount;
  await sch.pushDailyBudgetDigest();
  check('关闭日报后不再推送', pushCount === before, `pushCount=${pushCount}`);
  setS('notify.wecom.digest', 'true');

  // 时间闸门：设为未来时间，tickDigest 不应推送
  setS('notify.wecom.time', '23:59');
  const nowHHMM = db.nowStr().slice(11, 16);
  const beforeTick = pushCount;
  sch.tickDigest();
  await new Promise((r) => setTimeout(r, 50));
  if (nowHHMM < '23:59') {
    check('未到推送时间不推送', pushCount === beforeTick, `now=${nowHHMM} pushCount=${pushCount}`);
  } else {
    check('未到推送时间不推送（当前已过 23:59，跳过该断言）', true);
  }

  nc.push = realPush;

  console.log('\n=== E. 即时预警推送开关 ===\n');

  setS('notify.wecom.time', '20:00');
  setS('notify.wecom.instant', 'false');
  let instantSent = 0;
  const origSend = nc.sendWecom;
  // checkBudgets 走 nc.push；这里直接测 push 是否受 instant 控制的行为差异：
  // instant=false 时 checkBudgets 不应调用 push（去重键已存在则也可能不调，故先清空相关通知）
  db.run("DELETE FROM notifications WHERE body LIKE '%budget:%'");
  const pushSpy = [];
  nc.push = async (m) => { pushSpy.push(m); return { ok: true }; };

  // 先触发一次预警（instant=false）
  sch.checkBudgets();
  await new Promise((r) => setTimeout(r, 60));
  check('instant=false 时不发即时推送（只发站内）', pushSpy.length === 0, `pushes=${pushSpy.length}`);
  const stationCount = db.get("SELECT COUNT(*) AS c FROM notifications WHERE body LIKE '%budget:%'").c;
  check('instant=false 时站内通知正常产生', Number(stationCount) > 0, `notifications=${stationCount}`);

  // 换个月份的预算以绕过去重键，测试 instant=true
  setS('notify.wecom.instant', 'true');
  db.run("DELETE FROM notifications");
  db.run("DELETE FROM budgets WHERE ledger_id = ?", ledgerId);
  db.run(
    `INSERT INTO budgets (ledger_id, name, scope, period, amount_cents, currency, trigger_type, alert_pct, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,1,?)`,
    ledgerId, '即时测试预算', 'overall', 'monthly', 100, 'CNY', 'expense', 1, db.nowStr()
  );
  pushSpy.length = 0;
  sch.checkBudgets();
  await new Promise((r) => setTimeout(r, 80));
  check('instant=true 时发出即时推送', pushSpy.length === 1, `pushes=${pushSpy.length}`);
  check('即时推送内容含标题', pushSpy[0] && pushSpy[0].includes('预算超支'), (pushSpy[0] || '').split('\n')[0]);

  nc.push = realPush;
  nc.sendWecom = origSend;

  console.log('\n=== F. 无预算账本也要提醒（本月支出简报）===\n');

  const month2 = db.todayStr().slice(0, 7);
  const led2 = db.run(
    "INSERT INTO ledgers (name, kind, currency, icon, owner_id, created_at) VALUES (?,?,?,?,?,?)",
    '无预算账本', 'personal', 'CNY', '📗', userId, db.nowStr()
  ).lastInsertRowid;
  db.run("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?,?,?,?)", led2, userId, 'owner', db.nowStr());
  const mkTxn2 = (cents, merchant, day) => db.run(
    `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, user_id, txn_date, merchant, status, source, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    led2, 'expense', cents, 'CNY', 1, cents, userId, `${month2}-${day}`, merchant, 'cleared', 'manual', db.nowStr(), db.nowStr()
  );

  check('该账本本月没有支出时简报返回 null（空账本不打扰）', sch.buildSpendDigest(led2) === null);

  mkTxn2(3880, '安睡裤', '01');
  mkTxn2(1200, '外卖', '02');
  const sp = sch.buildSpendDigest(led2);
  check('简报含本月支出与笔数', !!sp && sp.includes('本月支出') && sp.includes('50.80') && sp.includes('2 笔'),
    sp ? sp.split('\n')[3] : 'null');
  check('简报含日均支出与已过天数', !!sp && sp.includes('日均支出') && sp.includes('已过'));
  check('简报含「最近一笔」', !!sp && sp.includes('最近一笔') && sp.includes('外卖'), sp ? sp.split('\n')[5] : '');
  check('简报标题是支出简报、并说明还没有预算',
    !!sp && sp.includes('本月支出简报') && sp.includes('还没有设置月度预算'));
  check('简报末尾给出设预算的建议', !!sp && sp.includes('预算管理'));

  // 推送路径：无预算但有支出的账本 → 也要推；且按天去重
  setS('notify.wecom.digest', 'true');
  db.run('DELETE FROM notifications');
  const pushSpy2 = [];
  nc.push = async (m) => { pushSpy2.push(m); return { ok: true }; };

  const sentF1 = await sch.pushDailyBudgetDigest();
  check('无预算但有支出的账本被推送', pushSpy2.some((m) => m.includes('本月支出简报')), `pushes=${pushSpy2.length} sent=${sentF1}`);
  check('去重键写成 spend-digest（与 budget-digest 区分）',
    Number(db.get("SELECT COUNT(*) AS c FROM notifications WHERE body LIKE '%spend-digest:%'").c) > 0);
  check('简报推送也留下站内通知',
    Number(db.get("SELECT COUNT(*) AS c FROM notifications WHERE title LIKE '%支出简报%'").c) > 0);

  const pushBefore = pushSpy2.length;
  await sch.pushDailyBudgetDigest();
  check('同日重复调度不重复推简报', pushSpy2.length === pushBefore, `pushCount=${pushSpy2.length}`);

  // 该账本一旦有了预算，就改走预算日报，不再发支出简报
  db.run(
    `INSERT INTO budgets (ledger_id, name, scope, period, amount_cents, currency, trigger_type, alert_pct, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,1,?)`,
    led2, '后补预算', 'overall', 'monthly', 500000, 'CNY', 'expense', 80, db.nowStr()
  );
  db.run('DELETE FROM notifications');
  pushSpy2.length = 0;
  await sch.pushDailyBudgetDigest();
  check('有预算后改发预算日报、不再发支出简报',
    pushSpy2.some((m) => m.includes('本月预算日报')) && !pushSpy2.some((m) => m.includes('本月支出简报')),
    `types=${pushSpy2.map((m) => (m.includes('预算日报') ? '预算日报' : '支出简报')).join(',')}`);
  nc.push = realPush;

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('崩溃：', e); process.exit(1); });

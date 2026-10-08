'use strict';
/**
 * 回归：账单明细商家/备注直显 + 点击行详情弹窗接口
 *
 * 覆盖：
 *   - 列表行同时渲染商家（.txn-merchant）与备注（.note），行带 data-txn-id
 *   - GET /transactions/:id/json 返回全字段（分类/账户/成员/标签/商家/备注/附件）
 *   - 转账带 to_account_name；删除后 404
 *
 * 运行：node test/verify-txn-detail.js（需 8099 实例，run-all 自动拉起）
 */
const BASE = 'http://127.0.0.1:8099';
let cookie = '';
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}
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
  return { status: res.status, text: buf.toString('utf8'), json: (() => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } })() };
}
const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

(async () => {
  console.log('\n=== 明细详情（HTTP 端到端 8099）===\n');
  let up = true;
  try { await fetch(BASE + '/login'); } catch { up = false; }
  if (!up) {
    console.log('  SKIP  8099 未启动。请先：PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js');
    console.log(`\n结果：${pass} 通过 / ${fail} 失败（未运行）\n`);
    process.exit(fail ? 1 : 0);
  }

  let r = await req('GET', '/login');
  const login = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', login.status === 302, `HTTP ${login.status}`);

  // 从记一笔页解析分类/账户 id
  r = await req('GET', '/transactions/new');
  const catId = (r.text.match(/name="category_id"[\s\S]*?<option value="(\d+)"/) || [])[1];
  const accId = (r.text.match(/name="account_id"[\s\S]*?<option value="(\d+)"/) || [])[1];
  check('解析到分类/账户', !!catId && !!accId, `cat=${catId} acc=${accId}`);
  const csrf = csrfOf(r.text);

  // 新库默认只有一个账户：建第二个账户供转账测试
  await req('POST', '/accounts', { form: { _csrf: csrf, name: '支付宝', type: 'virtual', icon: '📱', currency: 'CNY', include_in_net: '1' } });
  r = await req('GET', '/accounts');
  const toAccId = ([...r.text.matchAll(/\/accounts\/(\d+)"/g)].map((m) => m[1]).find((x) => x !== accId));
  check('已具备两个账户', !!toAccId, `acc=${accId} to=${toAccId}`);
  const today = new Date();
  const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // 支出：带商家+备注+标签
  const created = await req('POST', '/transactions', { form: {
    _csrf: csrf, type: 'expense', amount: '38.50', currency: 'CNY',
    category_id: catId, account_id: accId, txn_date: d,
    merchant: '沃尔玛', note: '周末采购', tags: '生活 采购', status: 'cleared',
  }, headers: { accept: 'application/json' } });
  check('创建支出记录', created.json && created.json.ok === true, JSON.stringify(created.json || {}).slice(0, 60));
  const id = created.json && created.json.id;

  // 列表直显商家与备注
  r = await req('GET', '/transactions');
  check('列表行带 data-txn-id', r.text.includes(`data-txn-id="${id}"`), '');
  check('商家直接显示（txn-merchant）', /class="txn-merchant"[^>]*>沃尔玛</.test(r.text), '');
  check('备注同时直接显示', /class="note"[^>]*>周末采购</.test(r.text), '');

  // 详情 JSON
  r = await req('GET', `/transactions/${id}/json`);
  check('详情接口 200', r.status === 200 && r.json && r.json.ok === true, `HTTP ${r.status}`);
  const t = r.json && r.json.txn;
  check('详情含商家/备注/标签', !!t && t.merchant === '沃尔玛' && t.note === '周末采购' && /生活/.test(t.tag_names || ''), `${t && t.merchant} / ${t && t.note} / ${t && t.tag_names}`);
  check('详情含分类/账户/类型', !!t && !!t.category_name && !!t.account_name && !!t.type_label, `${t && t.category_name} / ${t && t.account_name} / ${t && t.type_label}`);
  check('详情含创建时间/收支方向', !!t && !!t.created_at && (t.is_expense === 1 || t.is_expense === true), '');
  check('详情附件字段为数组', r.json && Array.isArray(r.json.attachments), `${r.json && r.json.attachments && r.json.attachments.length} 个`);

  // 转账：to_account_name
  const tr = await req('POST', '/transactions', { form: {
    _csrf: csrf, type: 'transfer', amount: '500', currency: 'CNY',
    account_id: accId, to_account_id: toAccId, txn_date: d, status: 'cleared',
  }, headers: { accept: 'application/json' } });
  check('创建转账', tr.json && tr.json.ok === true, '');
  r = await req('GET', `/transactions/${tr.json.id}/json`);
  check('转账详情含双账户', r.json && r.json.txn && !!r.json.txn.to_account_name, r.json && r.json.txn && `${r.json.txn.account_name} → ${r.json.txn.to_account_name}`);

  // 删除后 404
  await req('POST', `/transactions/${id}/delete`, { form: { _csrf: csrf, _json: '1' } });
  r = await req('GET', `/transactions/${id}/json`);
  check('删除后详情 404', r.status === 404, `HTTP ${r.status}`);

  // 越权：不存在/他人账本 id
  r = await req('GET', '/transactions/999999/json');
  check('不存在的记录 404', r.status === 404, `HTTP ${r.status}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

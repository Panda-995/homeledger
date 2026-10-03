'use strict';
/**
 * 回归：关于页（GET /about + 反馈配置）
 *
 * 需先在 8099 起隔离实例：
 *   PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js
 * 覆盖：未登录跳转、页面挂载（版本/亮点/日志/隐私/统计）、
 *       侧栏入口、反馈按钮未配置仓库的降级展示、issuesUrl 两种状态
 *
 * 运行：node test/verify-about.js
 */
const BASE = 'http://127.0.0.1:8099';
const { issuesUrl } = require('../src/lib/about');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

let jar = '';
async function req(method, p, { form, headers = {}, cookie } = {}) {
  const h = { ...headers };
  h.cookie = cookie || jar;
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(BASE + p, {
    method, headers: h,
    body: form ? new URLSearchParams(form).toString() : undefined,
    redirect: 'manual',
  });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length && !cookie) jar = sc.map((c) => c.split(';')[0]).join('; ');
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), setCookie: sc };
}

const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

(async () => {
  console.log('\n=== 关于页（HTTP 端到端）===\n');

  /* --- issuesUrl 单元（两种状态）--- */
  const saved = process.env.HOMELEDGER_GITHUB_REPO;
  delete process.env.HOMELEDGER_GITHUB_REPO;
  check('未设环境变量时回退到内置 GITHUB_REPO', issuesUrl() === 'https://github.com/Panda-995/homeledger/issues', String(issuesUrl()));
  process.env.HOMELEDGER_GITHUB_REPO = 'https://github.com/su-xiansheng/homeledger/';
  check('配置仓库后返回规范 Issues 地址', issuesUrl() === 'https://github.com/su-xiansheng/homeledger/issues', String(issuesUrl()));
  process.env.HOMELEDGER_GITHUB_REPO = 'javascript:alert(1)';
  check('非法仓库地址被拒绝', issuesUrl() === null, String(issuesUrl()));
  if (saved === undefined) delete process.env.HOMELEDGER_GITHUB_REPO; else process.env.HOMELEDGER_GITHUB_REPO = saved;

  /* --- 未登录 --- */
  let r = await req('GET', '/about');
  check('未登录访问 /about 被重定向', r.status === 302, `HTTP ${r.status}`);

  /* --- 登录 --- */
  r = await req('GET', '/login');
  const loginRes = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', loginRes.status === 302, `HTTP ${loginRes.status}`);
  const cookie = loginRes.setCookie.map((c) => c.split(';')[0]).join('; ');

  /* --- 页面挂载 --- */
  r = await req('GET', '/');
  check('侧栏出现「关于」入口', r.text.includes('href="/about"'));
  r = await req('GET', '/about', { cookie });
  check('关于页可访问', r.status === 200, `HTTP ${r.status}`);
  check('显示当前版本号 v1.0.0', r.text.includes('v1.0.0'));
  check('产品介绍渲染', r.text.includes('家账簿 HomeLedger') && r.text.includes('自托管'));
  check('功能亮点卡片渲染（6 个）', (r.text.match(/about-feature"/g) || []).length === 6, String((r.text.match(/about-feature"/g) || []).length));
  check('版本日志渲染（含 1.0.0 首发）', r.text.includes('版本日志') && r.text.includes('v1.0.0') && r.text.includes('首个公开发布版本'));
  check('统计卡渲染（记录笔数/陪伴天数）', r.text.includes('记录笔数') && r.text.includes('陪伴天数'));
  check('隐私声明渲染', r.text.includes('数据与隐私') && r.text.includes('不上传任何第三方服务器'));
  check('技术栈渲染', r.text.includes('技术栈') && r.text.includes('Node.js'));
  check('作者与 AI 辅助声明渲染', r.text.includes('Panda-995') && r.text.includes('AI 辅助') && r.text.includes('sucraft-hub/homeledger'));
  check('维护者声明为 fork 身份', r.text.includes('由 Panda-995 维护') && r.text.includes('原项目'));

  /* --- 反馈区：仓库已配置 → 渲染 GitHub Issues 外链 --- */
  check('已配置仓库时渲染 GitHub Issues 外链', r.text.includes('href="https://github.com/Panda-995/homeledger/issues"'));
  check('外链新窗口打开且安全属性', /target="_blank"[^>]*rel="noopener"/.test(r.text));
  check('未配置降级提示不再出现', !r.text.includes('仓库地址暂未配置'));

  /* --- 样式发布 --- */
  r = await req('GET', '/static/css/app.css');
  check('关于页样式已发布', r.status === 200 && r.text.includes('.about-hero') && r.text.includes('.tl-dot'), `HTTP ${r.status}`);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

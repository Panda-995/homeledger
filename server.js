'use strict';
/**
 * 家账簿 HomeLedger —— 服务端入口
 * 纯后端：Express + EJS 服务端渲染 + SQLite，零前端框架、零原生依赖
 */
const path = require('node:path');
const express = require('express');
const session = require('express-session');

const db = require('./src/db');
const auth = require('./src/lib/auth');
const util = require('./src/lib/util');
const charts = require('./src/lib/charts');
const scheduler = require('./src/lib/scheduler');

const PORT = Number(process.env.PORT || 5111);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const APP_VERSION = require('./package.json').version;

/** 静态资源缓存戳：应用版本 + 文件 mtime（36 进制），文件一改就变 */
function assetStamp(rel) {
  try {
    return Math.floor(require('node:fs').statSync(path.join(ROOT, 'public', rel)).mtimeMs / 1000).toString(36);
  } catch (e) {
    return '0';
  }
}

/* ---------------------------------- 初始化 --------------------------------- */

db.init();
bootstrapAdmin();

/** 首次启动且库中无任何用户时，按环境变量自动创建管理员 */
function bootstrapAdmin() {
  const c = db.get('SELECT COUNT(*) AS c FROM users');
  if (Number(c?.c || 0) > 0) return;
  const username = (process.env.ADMIN_USER || 'admin').trim();
  const password = process.env.ADMIN_PASSWORD || 'admin888';
  const info = db.run(
    'INSERT INTO users (username, password_hash, display_name, avatar_color, is_admin, created_at) VALUES (?,?,?,?,1,?)',
    username, auth.hashPassword(password), username, util.colorFor(username), db.nowStr()
  );
  db.createDefaultLedger(info.lastInsertRowid, username);
  db.setSetting('site.initialized', 'true');
  console.log('');
  console.log('  ✅ 已为你创建初始管理员账号');
  console.log(`     用户名：${username}`);
  console.log(`     密  码：${password}`);
  console.log('     ⚠️  请登录后立即在「设置 → 账号安全」中修改密码');
  console.log('');
}

/* ---------------------------------- 应用 ---------------------------------- */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'src', 'views'));

app.use(express.urlencoded({ extended: false, limit: '30mb' }));
app.use(express.json({ limit: '30mb' }));
app.use('/static', express.static(path.join(ROOT, 'public'), { maxAge: '7d' }));
// SVG 可内嵌脚本：上传侧已禁止，历史遗留的 .svg 附件也一律不再回显
app.use('/uploads', (req, res, next) => {
  if (/\.svg$/i.test(req.path || '')) return res.status(403).end('Forbidden');
  next();
});
app.use('/uploads', express.static(path.join(db.DATA_DIR, 'uploads'), { maxAge: '30d' }));

app.use(
  session({
    name: 'hl.sid',
    store: new auth.SqliteSessionStore(),
    secret: process.env.SESSION_SECRET || 'homeledger-dev-secret-please-change',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: String(process.env.COOKIE_SECURE || 'false') === 'true',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

/* --------------------------------- 全局上下文 -------------------------------- */

app.use((req, res, next) => {
  // 一次性提示消息
  if (req.session?.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  } else {
    res.locals.flash = null;
  }
  auth.context(req, res, next);
});

app.use((req, res, next) => {
  res.locals.appVersion = APP_VERSION;
  // 静态资源版本参数 = 应用版本 + 文件修改时间。
  // 只用应用版本会在"版本没变但文件改了"时继续命中浏览器缓存（换头像按钮无反应就是这个问题），
  // 拼上 mtime 后任何一次文件改动都会自动失效旧缓存。
  res.locals.assetV = {
    css: APP_VERSION + '-' + assetStamp('css/app.css'),
    js: APP_VERSION + '-' + assetStamp('js/app.js'),
    assistant: APP_VERSION + '-' + assetStamp('js/assistant.js'),
  };
  res.locals.helpers = util;
  res.locals.charts = charts;
  res.locals.TXN_TYPES = db.TXN_TYPES;
  res.locals.TXN_TYPE_MAP = db.TXN_TYPE_MAP;
  res.locals.PRIMARY_TXN_TYPES = db.PRIMARY_TXN_TYPES;
  res.locals.ACCOUNT_TYPES = db.ACCOUNT_TYPES;
  res.locals.ACCOUNT_TYPE_MAP = db.ACCOUNT_TYPE_MAP;
  res.locals.ROLE_LABEL = auth.ROLE_LABEL;
  res.locals.canWrite = auth.canWrite;
  res.locals.canManage = auth.canManage;
  res.locals.siteName = db.getSetting('site.name', '家账簿');
  res.locals.baseCurrency = db.getSetting('site.currency', 'CNY');
  res.locals.today = db.todayStr();
  res.locals.now = db.nowStr();
  res.locals.activeNav = '';
  res.locals.aiUsable = require('./src/lib/ai').isAiUsable();
  next();
});

/**
 * 零依赖布局机制：视图先渲染成 body，再套进 layout.ejs
 * （传 { layout: false } 可关闭；传 { layout: 'layout-blank' } 换壳）
 */
app.use((req, res, next) => {
  const rawRender = res.render.bind(res);
  res.render = function render(view, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    const opts = options || {};
    const layout = opts.layout === undefined ? 'layout' : opts.layout;
    if (!layout) return rawRender(view, opts, cb);
    rawRender(view, opts, (err, html) => {
      if (err) return cb ? cb(err) : next(err);
      rawRender(layout, { ...opts, body: html }, (err2, full) => {
        if (err2) return cb ? cb(err2) : next(err2);
        if (cb) return cb(null, full);
        res.send(full);
      });
    });
  };
  next();
});

/** 开放 API（小龙虾等外部工具）：Bearer 令牌鉴权，不走会话与 CSRF，需在 csrfProtect 之前挂载 */
app.use('/api/open', require('./src/routes/openapi'));

app.use(auth.csrfProtect);

/** 通用：注入提示消息 */
app.use((req, res, next) => {
  res.flash = (type, message) => {
    if (req.session) req.session.flash = { type, message };
  };
  next();
});

/** 首次运行且无用户 → 强制进入初始化 */
app.use((req, res, next) => {
  const hasUser = Number(db.get('SELECT COUNT(*) AS c FROM users')?.c || 0) > 0;
  res.locals.needsSetup = !hasUser;
  if (!hasUser && !['/setup', '/healthz'].includes(req.path) && !req.path.startsWith('/static')) {
    return res.redirect('/setup');
  }
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, app: 'homeledger', time: db.nowStr() }));

/* ---------------------------------- 路由 ---------------------------------- */

app.use('/', require('./src/routes/auth'));
app.use('/', require('./src/routes/dashboard'));
app.use('/transactions', require('./src/routes/transactions'));
app.use('/', require('./src/routes/accounts'));
app.use('/', require('./src/routes/planning'));
app.use('/', require('./src/routes/subscriptions'));
app.use('/', require('./src/routes/ai'));
app.use('/', require('./src/routes/reports'));
app.use('/', require('./src/routes/admin'));
app.use('/', require('./src/routes/about'));

/* --------------------------------- 错误处理 -------------------------------- */

app.use((req, res) => {
  res.status(404).render('error', { title: '页面不存在', message: `找不到 ${req.path}，可能是链接已失效。` });
});

app.use((err, req, res, _next) => {
  console.error('[error]', err);
  const message = err?.message || '服务器内部错误';
  if ((req.headers.accept || '').includes('application/json') || req.xhr) {
    return res.status(500).json({ ok: false, error: message });
  }
  res.status(500).render('error', { title: '出错了', message });
});

/* ---------------------------------- 启动 ---------------------------------- */

const server = app.listen(PORT, HOST, () => {
  const name = db.getSetting('site.name', '家账簿');
  console.log('');
  console.log(`  📒 ${name} 已启动`);
  console.log(`     本机访问：http://localhost:${PORT}`);
  console.log(`     局域网/ NAS 访问：http://<设备IP>:${PORT}`);
  console.log(`     数据目录：${db.DATA_DIR}`);
  console.log('');
});

scheduler.initScheduler();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在关闭服务…');
    server.close(() => {
      try { db.db.close(); } catch { /* ignore */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref?.();
  });
}

module.exports = app;

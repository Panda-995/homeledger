'use strict';
/**
 * 数据层：SQLite（Node 内置 node:sqlite，零原生依赖）
 * 包含：建表、索引、系统分类树种子、系统设置、账户类型常量、余额重算引擎
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'homeledger.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

/* ---------------------------------- 小工具 --------------------------------- */

const pad = (n) => String(n).padStart(2, '0');
function nowStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const todayStr = () => nowStr().slice(0, 10);
/** JS 布尔值不能直接绑定进 node:sqlite，统一转换 */
const B = (v) => (v ? 1 : 0);
const N = (v) => (v === undefined || v === null || v === '' ? null : v);

/* ------------------------------ 预编译语句缓存 ------------------------------ */

const cache = new Map();
function prep(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}
const all = (sql, ...p) => prep(sql).all(...p);
const get = (sql, ...p) => prep(sql).get(...p);
const run = (sql, ...p) => {
  const r = prep(sql).run(...p);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
};
function tx(fn) {
  // 可重入：批量操作会在事务里再次调用走 tx 的写入函数（createTransaction → recalcBalances），
  // SQLite 不允许嵌套 BEGIN，此时直接沿用在当前事务内执行。
  let nested = false;
  try {
    db.exec('BEGIN');
  } catch (e) {
    if (/within a transaction/i.test(e.message)) nested = true;
    else throw e;
  }
  if (nested) return fn();
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

/* ---------------------------------- 建表 ---------------------------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_color  TEXT NOT NULL DEFAULT '#4f7cff',
  theme         TEXT NOT NULL DEFAULT 'light',
  is_admin      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  last_login_at TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  user_id    INTEGER,
  expires_at INTEGER NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledgers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'personal',
  currency    TEXT NOT NULL DEFAULT 'CNY',
  icon        TEXT NOT NULL DEFAULT '📒',
  color       TEXT NOT NULL DEFAULT '#4f7cff',
  owner_id    INTEGER NOT NULL,
  note        TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_members (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  role      TEXT NOT NULL DEFAULT 'member',
  nickname  TEXT,
  joined_at TEXT NOT NULL,
  UNIQUE(ledger_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_lm_user ON ledger_members(user_id);

CREATE TABLE IF NOT EXISTS ledger_invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id  INTEGER NOT NULL,
  code       TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'member',
  created_by INTEGER NOT NULL,
  expires_at TEXT,
  used_by    INTEGER,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id       INTEGER NOT NULL,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'cash',
  icon            TEXT NOT NULL DEFAULT '💵',
  currency        TEXT NOT NULL DEFAULT 'CNY',
  initial_cents   INTEGER NOT NULL DEFAULT 0,
  balance_cents   INTEGER NOT NULL DEFAULT 0,
  credit_limit    INTEGER,
  bill_day        INTEGER,
  due_day         INTEGER,
  institution     TEXT,
  card_no         TEXT,
  note            TEXT,
  include_in_net  INTEGER NOT NULL DEFAULT 1,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acc_ledger ON accounts(ledger_id);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id  INTEGER,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'expense',
  parent_id  INTEGER,
  icon       TEXT NOT NULL DEFAULT '🏷️',
  color      TEXT NOT NULL DEFAULT '#8c8c8c',
  is_system  INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cat_kind ON categories(kind, parent_id);

CREATE TABLE IF NOT EXISTS tags (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  name      TEXT NOT NULL,
  color     TEXT NOT NULL DEFAULT '#4f7cff',
  UNIQUE(ledger_id, name)
);

CREATE TABLE IF NOT EXISTS transactions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id        INTEGER NOT NULL,
  type             TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'CNY',
  rate             REAL NOT NULL DEFAULT 1,
  amount_base_cents INTEGER NOT NULL,
  account_id       INTEGER,
  to_account_id    INTEGER,
  category_id      INTEGER,
  user_id          INTEGER NOT NULL,
  txn_date         TEXT NOT NULL,
  note             TEXT,
  merchant         TEXT,
  status           TEXT NOT NULL DEFAULT 'cleared',
  is_reimbursable  INTEGER NOT NULL DEFAULT 0,
  reimbursed_at    TEXT,
  related_id       INTEGER,
  group_id         TEXT,
  source           TEXT NOT NULL DEFAULT 'manual',
  ai_json          TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_txn_ledger_date ON transactions(ledger_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_txn_cat ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_txn_group ON transactions(group_id);

CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id INTEGER NOT NULL,
  tag_id         INTEGER NOT NULL,
  PRIMARY KEY (transaction_id, tag_id)
);

CREATE TABLE IF NOT EXISTS splits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id     TEXT NOT NULL,
  transaction_id INTEGER,
  ledger_id    INTEGER NOT NULL,
  user_id      INTEGER,
  member_name  TEXT NOT NULL,
  share_cents  INTEGER NOT NULL,
  is_settled   INTEGER NOT NULL DEFAULT 0,
  settled_at   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_split_group ON splits(group_id);

CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id  INTEGER NOT NULL,
  txn_id     INTEGER,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'screenshot',
  file_name  TEXT NOT NULL,
  rel_path   TEXT NOT NULL,
  mime       TEXT,
  size       INTEGER,
  ai_status  TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_txn ON attachments(txn_id);

CREATE TABLE IF NOT EXISTS budgets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id   INTEGER NOT NULL,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'overall',
  category_id INTEGER,
  account_id  INTEGER,
  period      TEXT NOT NULL DEFAULT 'monthly',
  amount_cents INTEGER NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'CNY',
  trigger_type TEXT NOT NULL DEFAULT 'expense',
  rollover    INTEGER NOT NULL DEFAULT 0,
  alert_pct   INTEGER NOT NULL DEFAULT 80,
  start_date  TEXT,
  end_date    TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recurring_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id   INTEGER NOT NULL,
  name        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  frequency   TEXT NOT NULL DEFAULT 'monthly',
  interval_n  INTEGER NOT NULL DEFAULT 1,
  day_of_month INTEGER,
  weekday     INTEGER,
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  auto_post   INTEGER NOT NULL DEFAULT 1,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id     INTEGER NOT NULL,
  name          TEXT NOT NULL,
  icon          TEXT NOT NULL DEFAULT '🎯',
  target_cents  INTEGER NOT NULL,
  saved_cents   INTEGER NOT NULL DEFAULT 0,
  account_id    INTEGER,
  target_date   TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  note          TEXT,
  created_at    TEXT NOT NULL
);

-- 订阅扣费：软件 / 网站 / 会员的周期性自动扣费管理
--   cycle 计费周期（monthly/quarterly/half_yearly/yearly/weekly），cycle_n 为「每 N 个周期」
--   anchor_month + anchor_day 描述扣费锚点（年付时 anchor_month 决定扣费月份）
--   status：trial 试用中 / active 生效 / paused 暂停 / canceled 已取消
CREATE TABLE IF NOT EXISTS subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id     INTEGER NOT NULL,
  name          TEXT NOT NULL,
  icon          TEXT NOT NULL DEFAULT '🧾',
  plan          TEXT,
  vendor_url    TEXT,
  amount_cents  INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'CNY',
  cycle         TEXT NOT NULL DEFAULT 'monthly',
  cycle_n       INTEGER NOT NULL DEFAULT 1,
  anchor_month  INTEGER,
  anchor_day    INTEGER,
  account_id    INTEGER,
  category_id   INTEGER,
  auto_renew    INTEGER NOT NULL DEFAULT 1,
  trial_ends_on TEXT,
  next_charge_at TEXT NOT NULL,
  last_charge_at TEXT,
  reminder_days INTEGER NOT NULL DEFAULT 3,
  charge_count  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  note          TEXT,
  created_by_user_id INTEGER,
  canceled_at   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_ledger ON subscriptions(ledger_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_next ON subscriptions(next_charge_at);

CREATE TABLE IF NOT EXISTS debts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id     INTEGER NOT NULL,
  direction     TEXT NOT NULL,
  counterparty  TEXT NOT NULL,
  principal_cents INTEGER NOT NULL,
  balance_cents INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'CNY',
  account_id    INTEGER,
  due_date      TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  note          TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  ledger_id  INTEGER,
  kind       TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  ledger_id  INTEGER,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  detail     TEXT,
  ip         TEXT,
  ua         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS exchange_rates (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  base   TEXT NOT NULL,
  quote  TEXT NOT NULL,
  rate   REAL NOT NULL,
  noted_at TEXT NOT NULL,
  UNIQUE(base, quote)
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id  INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  source     TEXT NOT NULL,
  file_name  TEXT,
  total      INTEGER NOT NULL DEFAULT 0,
  imported   INTEGER NOT NULL DEFAULT 0,
  skipped    INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'done',
  message    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  ledger_id    INTEGER,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  token_tail   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);
`);

/* ----------------------------- 增量迁移（幂等） ----------------------------- */

/** 读出某张表的现有列 */
function tableColumns(table) {
  return all(`PRAGMA table_info(${table})`).map((r) => String(r.name));
}

/** 只加不改：列不存在才 ALTER TABLE，老库升级可安全重复执行 */
function ensureColumn(table, column, ddl) {
  if (tableColumns(table).includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

const migrated = [];
if (ensureColumn('transactions', 'subscription_id', 'INTEGER')) migrated.push('transactions.subscription_id');
if (ensureColumn('users', 'avatar_path', 'TEXT')) migrated.push('users.avatar_path');
if (ensureColumn('users', 'avatar_ver', 'INTEGER')) migrated.push('users.avatar_ver');
if (migrated.length) console.log(`[db] 已补齐字段：${migrated.join('、')}`);
// 订阅扣费生成的流水按订阅维度回查（必须在 ensureColumn 之后建索引）
db.exec('CREATE INDEX IF NOT EXISTS idx_txn_subscription ON transactions(subscription_id);');

/* ------------------------------- 账户类型常量 ------------------------------- */

const ACCOUNT_TYPES = [
  { key: 'cash', label: '现金', icon: '💵', nature: 'asset' },
  { key: 'debit', label: '储蓄卡', icon: '🏦', nature: 'asset' },
  { key: 'credit', label: '信用卡', icon: '💳', nature: 'liability' },
  { key: 'virtual', label: '虚拟账户（支付宝/微信）', icon: '📱', nature: 'asset' },
  { key: 'prepaid', label: '储值卡/预付', icon: '🎫', nature: 'asset' },
  { key: 'investment', label: '投资账户', icon: '📈', nature: 'asset' },
  { key: 'receivable', label: '应收款（别人欠我）', icon: '📥', nature: 'asset' },
  { key: 'payable', label: '应付款（我欠别人）', icon: '📤', nature: 'liability' },
  { key: 'loan', label: '贷款/负债', icon: '🏚️', nature: 'liability' },
  { key: 'other', label: '其他', icon: '📦', nature: 'asset' },
];
const ACCOUNT_TYPE_MAP = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t.key, t]));

/* -------------------------------- 交易类型常量 ------------------------------- */

const TXN_TYPES = [
  { key: 'expense', label: '支出', icon: '💸', color: '#f5222d', flow: 'out', group: '日常' },
  { key: 'income', label: '收入', icon: '💰', color: '#52c41a', flow: 'in', group: '日常' },
  { key: 'transfer', label: '转账', icon: '🔄', color: '#1677ff', flow: 'move', group: '日常' },
  { key: 'lend', label: '借出', icon: '📤', color: '#fa8c16', flow: 'out', group: '借贷' },
  { key: 'borrow', label: '借入', icon: '📥', color: '#fa8c16', flow: 'in', group: '借贷' },
  { key: 'repay_receive', label: '收回借款', icon: '↩️', color: '#13c2c2', flow: 'in', group: '借贷' },
  { key: 'repay_pay', label: '偿还借款', icon: '↪️', color: '#13c2c2', flow: 'out', group: '借贷' },
  { key: 'reimburse', label: '报销入账', icon: '🧾', color: '#722ed1', flow: 'in', group: '报销' },
  { key: 'refund', label: '退款', icon: '↩️', color: '#52c41a', flow: 'in', group: '日常' },
  { key: 'fee', label: '手续费', icon: '🏷️', color: '#8c8c8c', flow: 'out', group: '金融' },
  { key: 'interest', label: '利息收入', icon: '🏦', color: '#52c41a', flow: 'in', group: '金融' },
  { key: 'invest_buy', label: '投资买入', icon: '📉', color: '#1677ff', flow: 'move', group: '投资' },
  { key: 'invest_sell', label: '投资卖出', icon: '📈', color: '#fa541c', flow: 'move', group: '投资' },
  { key: 'adjust', label: '余额调整', icon: '⚖️', color: '#8c8c8c', flow: 'adjust', group: '其他' },
];
const TXN_TYPE_MAP = Object.fromEntries(TXN_TYPES.map((t) => [t.key, t]));
/** 记一笔时最常见的四项，其余收在“更多类型”里 */
const PRIMARY_TXN_TYPES = ['expense', 'income', 'transfer', 'lend'];

/* --------------------------------- 分类种子 -------------------------------- */

const EXPENSE_SEED = [
  ['餐饮', '🍽️', '#ff7a45', ['早餐:🥣', '午餐:🍚', '晚餐:🍜', '外卖:🛵', '零食:🍪', '饮料:🧋', '咖啡:☕', '水果:🍎', '下馆子:🍢', '烟酒:🚬']],
  ['交通', '🚗', '#1677ff', ['公交:🚌', '地铁:🚇', '打车:🚕', '加油:⛽', '停车:🅿️', '过路费:🛣️', '洗车:🚿', '车辆保养:🔧', '车辆维修:🛠️', '车险:🛡️', '年检:📋', '火车:🚄', '飞机:✈️', '共享单车:🚲']],
  ['购物', '🛍️', '#eb2f96', ['日用百货:🧺', '个护清洁:🧴', '家居用品:🛋️', '数码电器:📺', '家纺布艺:🧵', '五金工具:🔨', '礼品:🎁', '其他购物:🛒']],
  ['服饰', '👕', '#f759ab', ['上衣:👕', '裤装:👖', '鞋靴:👟', '内衣袜:🧦', '外套:🧥', '配饰:💍', '箱包:👜', '理发美发:💇']],
  ['居住', '🏠', '#722ed1', ['房租:🏠', '房贷:🏦', '物业费:🏢', '水费:🚰', '电费:💡', '燃气费:🔥', '取暖费:♨️', '宽带费:📶', '家政保洁:🧹', '家电维修:🛠️', '装修:🧱']],
  ['通讯', '📱', '#13c2c2', ['手机话费:📱', '流量充值:🌐', '宽带:📡', '快递邮费:📮', '云服务:☁️']],
  ['娱乐', '🎮', '#fa541c', ['电影:🎬', '游戏:🎮', '演出展览:🎤', '会员订阅:📺', '酒吧:🍺', 'KTV:🎙️', '玩具:🧸', '书籍影音:📚', '旅游门票:🎫']],
  ['医疗健康', '🏥', '#ff4d4f', ['门诊:🩺', '药品:💊', '住院:🛏️', '体检:📋', '牙科:🦷', '眼科:👁️', '保健品:🧴', '医疗器械:🩹', '心理咨询:🧠']],
  ['保险', '🛡️', '#40a9ff', ['重疾险:🛡️', '医疗险:🏥', '寿险:📜', '意外险:⚠️', '车险:🚗', '财产险:🏠', '社保:🏛️', '公积金:🏦']],
  ['教育', '🎓', '#2f54eb', ['学费:🎓', '培训费:📖', '教材文具:📕', '课外班:✏️', '在线课程:💻', '考试报名:📝', '考证:🎯']],
  ['人情往来', '🧧', '#f5222d', ['红包:🧧', '礼金:🎁', '请客:🍻', '孝敬长辈:👴', '随份子:💐', '慈善捐赠:❤️', '送礼:🎀']],
  ['育儿', '🍼', '#fa8c16', ['奶粉:🍼', '尿不湿:🧷', '童装:👶', '玩具:🧸', '早教:🎨', '托育:🏫', '儿童医疗:🏥', '儿童保险:🛡️']],
  ['宠物', '🐾', '#faad14', ['宠物主粮:🥫', '宠物零食:🦴', '宠物医疗:💉', '宠物用品:🧶', '宠物美容:✂️', '宠物寄养:🏠']],
  ['运动健身', '🏀', '#52c41a', ['健身卡:🏋️', '运动装备:👟', '球类:🏀', '场地费:⚽', '户外露营:⛺', '游泳:🏊', '赛事报名:🏅']],
  ['旅行', '✈️', '#08979c', ['机票:✈️', '酒店:🏨', '当地交通:🚗', '景点门票:🎫', '跟团游:🧳', '签证:📄', '旅行购物:🛍️', '旅行保险:🛡️']],
  ['美容护理', '💄', '#eb2f96', ['化妆品:💄', '护肤品:🧴', '美甲:💅', '美容SPA:💆', '医美:✨', '美睫:👁️']],
  ['数码科技', '💻', '#597ef7', ['手机:📱', '电脑:💻', '外设配件:🖱️', '软件购买:💿', '智能家居:🏠', '游戏设备:🕹️', '充电设备:🔌']],
  ['办公经营', '💼', '#1d39c4', ['办公用品:🖇️', '打印耗材:🖨️', '差旅:🧳', '团建:🎉', '软件服务:💻', '广告推广:📣', '设备采购:🖥️', '商务招待:🤝']],
  ['金融支出', '🧾', '#8c8c8c', ['手续费:🧾', '利息支出:💸', '税费:🧮', '罚款违约金:🚨', '信用卡年费:💳', '投资亏损:📉', '兑换损失:💱']],
  ['其他支出', '❓', '#8c8c8c', ['待分类:📦', '丢失:🔍', '其他:❓']],
];

const INCOME_SEED = [
  ['职业收入', '💼', '#52c41a', ['工资:💰', '奖金:🏆', '加班费:⏰', '补贴:🎫', '年终奖:🎊', '提成:📈', '公积金提取:🏛️']],
  ['经营收入', '🏪', '#13c2c2', ['营业收入:🏪', '项目款:📄', '分销分成:🤝', '带货佣金:🛒']],
  ['投资理财', '📈', '#fa541c', ['基金收益:📊', '股票收益:📈', '利息收入:🏦', '理财收益:💹', '债券收益:📜', '黄金收益:🥇', '房租收入:🏘️', '分红:🍰']],
  ['其他收入', '✨', '#722ed1', ['兼职外快:💼', '报销回款:🧾', '退款:↩️', '红包:🧧', '礼金:🎁', '中奖:🎰', '二手闲置:♻️', '保险理赔:🛡️', '赔偿:⚖️', '其他收入:❓']],
];

/* ---------------------------------- 系统设置 -------------------------------- */

const DEFAULT_SETTINGS = {
  'site.name': '家账簿',
  'site.currency': 'CNY',
  'site.allow_register': (process.env.ALLOW_REGISTER || 'true') === 'true' ? 'true' : 'false',
  'ai.enabled': 'false',
  'ai.base_url': 'https://open.bigmodel.cn/api/paas/v4',
  'ai.api_key': '',
  'ai.model': 'glm-4v-flash',
  'ai.vision': 'true',
  'ai.timeout_ms': '90000',
  'ai.auto_save': 'false',
  'security.login_max_fail': '10',
  'security.force_https': 'false',
};

function getSetting(key, def = null) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : def;
}
function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, String(value ?? '')
  );
}
function allSettings() {
  const o = {};
  for (const r of all('SELECT key, value FROM settings')) o[r.key] = r.value;
  return o;
}

/* --------------------------------- 初始化逻辑 -------------------------------- */

function seedSystemCategories() {
  const count = get('SELECT COUNT(*) AS c FROM categories WHERE is_system = 1');
  if (count && Number(count.c) > 0) return;
  tx(() => {
    const insert = (name, kind, parentId, icon, color) =>
      run(
        'INSERT INTO categories (ledger_id, name, kind, parent_id, icon, color, is_system, sort_order) VALUES (NULL,?,?,?,?,?,1,?)',
        name, kind, parentId, icon, color, 0
      ).lastInsertRowid;

    const walk = (seed, kind) => {
      seed.forEach(([top, topIcon, color, children], i) => {
        const pid = insert(top, kind, null, topIcon, color);
        run('UPDATE categories SET sort_order = ? WHERE id = ?', i, pid);
        children.forEach((c, j) => {
          const [cname, cicon] = c.split(':');
          const cid = insert(cname, kind, pid, cicon || topIcon, color);
          run('UPDATE categories SET sort_order = ? WHERE id = ?', j, cid);
        });
      });
    };
    walk(EXPENSE_SEED, 'expense');
    walk(INCOME_SEED, 'income');
  });
}

function seedSettings() {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (get('SELECT key FROM settings WHERE key = ?', k) === undefined) setSetting(k, v);
  }
}

function seedExchangeRates() {
  const c = get('SELECT COUNT(*) AS c FROM exchange_rates');
  if (c && Number(c.c) > 0) return;
  const list = [
    ['USD', 'CNY', 7.15], ['EUR', 'CNY', 7.8], ['HKD', 'CNY', 0.92],
    ['JPY', 'CNY', 0.047], ['GBP', 'CNY', 9.1], ['KRW', 'CNY', 0.0052],
    ['SGD', 'CNY', 5.35], ['AUD', 'CNY', 4.7], ['CAD', 'CNY', 5.2], ['TWD', 'CNY', 0.22],
  ];
  tx(() => {
    for (const [b, q, r] of list) {
      run('INSERT OR REPLACE INTO exchange_rates (base, quote, rate, noted_at) VALUES (?,?,?,?)', b, q, r, todayStr());
    }
  });
}

/** 为新账本创建默认账户 */
function createDefaultAccounts(ledgerId, currency = 'CNY', userId) {
  const presets = [
    ['现金', 'cash', '💵'],
    ['支付宝', 'virtual', '📱'],
    ['微信钱包', 'virtual', '💬'],
    ['银行卡', 'debit', '🏦'],
    ['信用卡', 'credit', '💳'],
  ];
  tx(() => {
    presets.forEach(([name, type, icon], i) => {
      run(
        `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, sort_order, created_at)
         VALUES (?,?,?,?,?,0,0,?,?)`,
        ledgerId, name, type, icon, currency, i, nowStr()
      );
    });
  });
}

/** 账本默认成员（拥有者） */
function addLedgerMember(ledgerId, userId, role = 'member', nickname = null) {
  run(
    `INSERT INTO ledger_members (ledger_id, user_id, role, nickname, joined_at) VALUES (?,?,?,?,?)
     ON CONFLICT(ledger_id, user_id) DO UPDATE SET role = excluded.role`,
    ledgerId, userId, role, nickname, nowStr()
  );
}

/** 新用户注册后自动给一个默认账本 */
function createDefaultLedger(userId, displayName) {
  const id = run(
    `INSERT INTO ledgers (name, kind, currency, icon, color, owner_id, note, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    `${displayName}的账本`, 'personal', getSetting('site.currency', 'CNY'), '📒', '#4f7cff', userId, '注册时自动创建', nowStr()
  ).lastInsertRowid;
  addLedgerMember(id, userId, 'owner');
  createDefaultAccounts(id, getSetting('site.currency', 'CNY'), userId);
  return id;
}

/* ------------------------------- 余额重算引擎 -------------------------------- */

/**
 * 单笔交易对账户余额的影响（返回 [{accountId, delta}]）
 * 所有金额均为「分」
 */
function txnEffects(t) {
  const a = t.amount_base_cents;
  const out = [];
  const push = (id, d) => { if (id) out.push({ accountId: Number(id), delta: d }); };
  switch (t.type) {
    case 'expense':
    case 'lend':
    case 'repay_pay':
    case 'fee':
      push(t.account_id, -a);
      break;
    case 'income':
    case 'borrow':
    case 'repay_receive':
    case 'reimburse':
    case 'refund':
    case 'interest':
      push(t.account_id, a);
      break;
    case 'transfer':
      push(t.account_id, -a);
      push(t.to_account_id, a);
      break;
    case 'invest_buy':
      // 资金从出资账户流向投资账户
      push(t.account_id, -a);
      push(t.to_account_id, a);
      break;
    case 'invest_sell':
      push(t.to_account_id || t.account_id, -a);
      push(t.account_id, a);
      break;
    case 'adjust':
      push(t.account_id, a);
      break;
    default:
      push(t.account_id, -a);
  }
  return out;
}

/** 重算某账本全部账户余额（幂等，写入后调用） */
function recalcBalances(ledgerId) {
  const accounts = all('SELECT id, initial_cents FROM accounts WHERE ledger_id = ?', ledgerId);
  const rows = all(
    'SELECT * FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL',
    ledgerId
  );
  const delta = new Map();
  for (const t of rows) {
    for (const e of txnEffects(t)) {
      delta.set(e.accountId, (delta.get(e.accountId) || 0) + e.delta);
    }
  }
  tx(() => {
    for (const acc of accounts) {
      const v = Number(acc.initial_cents) + (delta.get(Number(acc.id)) || 0);
      run('UPDATE accounts SET balance_cents = ? WHERE id = ?', v, acc.id);
    }
  });
}

/* --------------------------------- 对外导出 -------------------------------- */

let initialized = false;
function init() {
  if (initialized) return;
  seedSystemCategories();
  seedSettings();
  seedExchangeRates();
  initialized = true;
  // 清理过期会话
  run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
}

module.exports = {
  db, all, get, run, tx, prep,
  DATA_DIR, DB_FILE, nowStr, todayStr, B, N,
  tableColumns, ensureColumn,
  ACCOUNT_TYPES, ACCOUNT_TYPE_MAP,
  TXN_TYPES, TXN_TYPE_MAP, PRIMARY_TXN_TYPES,
  getSetting, setSetting, allSettings,
  init, seedSystemCategories,
  createDefaultLedger, createDefaultAccounts, addLedgerMember,
  txnEffects, recalcBalances,
};

'use strict';
/**
 * 外部推送通道
 *  目前支持：企业微信群机器人 webhook、通用 JSON webhook
 *
 * 设计要点：
 *  - 通知是「尽力而为」的旁路能力：任何失败只记日志，绝不抛异常打断主流程（尤其是定时任务）。
 *  - 配置统一存 settings 表（键前缀 notify.*），与 AI 配置同一套机制。
 *  - 默认发 text 消息：企业微信「微信插件」转发到微信时只认 text，
 *    markdown 会被拒（微信里显示「不支持此消息类型」）。想要排版可切 notify.wecom.msgtype。
 *  - 三类错误分开报：网络/超时、HTTP 非 2xx、企业微信业务 errcode 非 0。
 *  - 显式 trust/proxy 处理：node 原生 fetch（undici）默认**不认** HTTP_PROXY 环境变量，
 *    所以本模块天然直连，不受宿主 HTTP_PROXY 影响——这与 mcp-server 里 trust_env=False 是同一考虑。
 */

const { getSetting } = require('../db');

/* ------------------------------- 配置读写 ------------------------------- */

const KEYS = {
  enabled: 'notify.wecom.enabled',
  webhook: 'notify.wecom.webhook',
  time: 'notify.wecom.time',
  digest: 'notify.wecom.digest',
  instant: 'notify.wecom.instant',
  forecast: 'notify.wecom.forecast',
  msgtype: 'notify.wecom.msgtype',
};

const DEFAULTS = {
  [KEYS.enabled]: 'false',
  [KEYS.webhook]: '',
  [KEYS.time]: '20:00',
  [KEYS.digest]: 'true',
  [KEYS.instant]: 'false',
  [KEYS.forecast]: 'true',
  // 默认 text：企业微信「微信插件」把消息转发到微信时只认 text，
  // markdown 会被拒（用户侧看到「不支持此消息类型」）。
  [KEYS.msgtype]: 'text',
};

/**
 * 企业微信机器人支持的消息类型。
 *  - text：纯文本，微信插件（微信里收企业微信消息）也支持 ← 默认
 *  - markdown：仅企业微信客户端内正常渲染，转发到微信会报「不支持此消息类型」
 *  - markdown_v2：同上，且不支持部分旧语法
 */
const MSG_TYPES = ['text', 'markdown', 'markdown_v2'];

/** 消息体上限（企业微信按 UTF-8 字节计） */
const LIMITS = { text: 2048, markdown: 4096, markdown_v2: 4096 };

/** 非法/缺省一律收敛为 text */
function normalizeMsgType(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return MSG_TYPES.includes(s) ? s : 'text';
}

/** 读取全部推送配置（带默认值兜底） */
function getConfig() {
  const cfg = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    cfg[k] = getSetting(k, v);
  }
  return {
    enabled: cfg[KEYS.enabled] === 'true',
    webhook: String(cfg[KEYS.webhook] || '').trim(),
    time: normalizeTime(cfg[KEYS.time]),
    digest: cfg[KEYS.digest] === 'true',
    instant: cfg[KEYS.instant] === 'true',
    forecast: cfg[KEYS.forecast] === 'true',
    msgtype: normalizeMsgType(cfg[KEYS.msgtype]),
  };
}

const DEFAULT_SETTINGS = { ...DEFAULTS };

/** "20:00" / "8:5" → "20:00" / "08:05"；非法值回退 20:00 */
function normalizeTime(v) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v || '').trim());
  if (!m) return '20:00';
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const min = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** webhook 地址合法性：企业微信机器人固定前缀 */
function isValidWebhook(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return false;
    if (!/^qyapi\.weixin\.qq\.com$/i.test(u.hostname)) return false;
    return /^\/cgi-bin\/webhook\/send/.test(u.pathname) && !!u.searchParams.get('key');
  } catch {
    return false;
  }
}

/** 打码展示，避免设置页直接暴露完整 key */
function maskWebhook(url) {
  try {
    const u = new URL(String(url || ''));
    const key = u.searchParams.get('key') || '';
    if (!key) return url;
    const masked = key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '****';
    u.searchParams.set('key', masked);
    return u.toString();
  } catch {
    return '';
  }
}

/* ------------------------------- 发送实现 ------------------------------- */

const TIMEOUT_MS = 8000;

/** 按 UTF-8 字节截断（企业微信的限制按字节算，中文 1 字 = 3 字节） */
function truncateBytes(str, maxBytes) {
  const s = String(str == null ? '' : str);
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const ell = '…';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(ell, 'utf8'));
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return out + ell;
}

/**
 * markdown → 纯文本。
 * 保留 emoji、换行与缩进结构，只去掉渲染语法（标题 #、引用 >、加粗 **、行内代码 `）。
 * 列表项前缀统一成「· 」，比 "- " 在手机端更好认。
 */
function mdToText(md) {
  return String(md == null ? '' : md)
    .split('\n')
    .map((line) => {
      let s = line;
      s = s.replace(/^\s{0,3}#{1,6}\s*/, '');       // 标题
      s = s.replace(/^\s{0,3}>\s?/, '');            // 引用
      s = s.replace(/^\s{0,3}[-*+]\s+/, '· ');      // 列表
      s = s.replace(/\*\*(.+?)\*\*/g, '$1');        // 加粗
      s = s.replace(/__(.+?)__/g, '$1');
      s = s.replace(/`([^`]+)`/g, '$1');            // 行内代码
      s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');// 链接
      return s.replace(/\s+$/, '');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 按消息类型组装请求体（text 走纯文本渲染 + 更小的字节上限） */
function buildPayload(content, msgtype = 'text') {
  const t = normalizeMsgType(msgtype);
  if (t === 'text') {
    return { msgtype: 'text', text: { content: truncateBytes(mdToText(content), LIMITS.text) } };
  }
  return { msgtype: t, [t]: { content: truncateBytes(content, LIMITS[t]) } };
}

/**
 * 发送一条企业微信消息。
 * 永不抛异常；返回 { ok, error?, errcode? }。
 * msgtype 缺省 text（微信插件兼容）：传 'markdown' 才发 markdown。
 */
async function sendWecom(content, { webhook, msgtype = 'text', timeoutMs = TIMEOUT_MS } = {}) {
  const url = String(webhook || '').trim();
  if (!url) return { ok: false, error: '未配置企业微信 webhook 地址' };
  if (!isValidWebhook(url)) return { ok: false, error: 'webhook 地址格式不正确（应为 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...）' };

  const body = buildPayload(content, msgtype);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await resp.text();
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}：${text.slice(0, 200)}` };
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
    if (json && Number(json.errcode) !== 0) {
      return { ok: false, errcode: Number(json.errcode), error: `企业微信返回 errcode=${json.errcode}：${json.errmsg || ''}` };
    }
    return { ok: true };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : (e?.message || String(e));
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** 按当前配置发送（配置未开启则直接跳过） */
async function push(content, { force = false, msgtype = null } = {}) {
  const cfg = getConfig();
  if (!cfg.enabled && !force) return { ok: false, skipped: true, error: '推送未开启' };
  if (!cfg.webhook) return { ok: false, skipped: true, error: '未配置 webhook' };
  const r = await sendWecom(content, { webhook: cfg.webhook, msgtype: msgtype || cfg.msgtype });
  if (!r.ok) console.error('[notify] 企业微信推送失败：', r.error);
  return r;
}

module.exports = {
  getConfig, isValidWebhook, maskWebhook, normalizeTime,
  sendWecom, push,
  mdToText, buildPayload, truncateBytes, normalizeMsgType,
  MSG_TYPES, LIMITS,
  KEYS, DEFAULT_SETTINGS,
};

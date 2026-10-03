'use strict';
/**
 * 账单截图附件
 *
 * 职责：把前端/外部工具传来的 dataURL 图片落盘、写入 attachments 表，
 * 并在记账成功后把附件关联到对应交易（txn_id）。
 *
 * 两条链路共用本模块，避免行为分叉：
 *   · 网页端  POST /api/ai/scan  → POST /api/ai/confirm
 *   · 开放 API POST /api/open/ai/bill（小龙虾等）
 *
 * 存储：文件落在 DATA_DIR/uploads/YYYYMM/，库里只记相对路径；
 * 备份时 data 目录整体拷贝即可，图片与记录不会脱节。
 */
const fs = require('node:fs');
const path = require('node:path');
const { all, get, run, nowStr, todayStr, DATA_DIR } = require('../db');
const { uid } = require('./util');

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 单张 8MB
const MAX_IMAGES = 6;

const uploadsRoot = () => path.join(DATA_DIR, 'uploads');

/** 附件在网页端的访问地址 */
const webUrl = (rel) => `/uploads/${String(rel).split(path.sep).join('/')}`;

/**
 * 解析 dataURL → { mime, buf }
 * 非法时抛错（错误信息面向用户，可直接展示）
 */
function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || '').trim());
  if (!m) throw new Error('图片格式无法识别（需要 data:image/...;base64,xxx）');
  const mime = m[1].toLowerCase().split(';')[0];
  // 只接受白名单位图格式：SVG 可内嵌脚本，若允许上传，
  // 经 /uploads 与 /api/open/attachments 回显时会在同源执行任意 JS（存储型 XSS）
  if (!MIME_EXT[mime]) {
    if (mime.startsWith('image/')) throw new Error(`不支持的图片类型：${mime}（SVG 存在脚本风险，已禁止）`);
    throw new Error(`不支持的图片类型：${mime}`);
  }
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('图片内容为空');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('单张图片请小于 8MB');
  return { mime, buf };
}

/**
 * 保存一张 dataURL 图片：落盘 + 写 attachments 行（txn_id 先留空，记账成功后关联）
 * @returns {{id:number, rel:string, url:string, size:number, mime:string, file_name:string}}
 */
function saveDataUrlImage({ dataUrl, ledgerId, userId, name, kind = 'screenshot', aiStatus = 'pending' }) {
  const { mime, buf } = parseDataUrl(dataUrl);
  const ext = MIME_EXT[mime] || 'png';
  const ym = todayStr().slice(0, 4) + todayStr().slice(5, 7);
  const dir = path.join(uploadsRoot(), ym);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${Date.now()}_${uid(8)}.${ext}`;
  const abs = path.join(dir, fileName);
  fs.writeFileSync(abs, buf);

  const rel = path.relative(uploadsRoot(), abs).split(path.sep).join('/');
  const info = run(
    `INSERT INTO attachments (ledger_id, txn_id, user_id, kind, file_name, rel_path, mime, size, ai_status, created_at)
     VALUES (?,NULL,?,?,?,?,?,?,?,?)`,
    Number(ledgerId), Number(userId), kind, name || fileName, rel, mime, buf.length, aiStatus, nowStr()
  );
  return { id: Number(info.lastInsertRowid), rel, url: webUrl(rel), size: buf.length, mime, file_name: name || fileName };
}

/**
 * 把附件关联到交易。
 * 数量一致时一一对应（一图一笔），否则全部挂到第一笔（一组图说明一笔账）。
 * @returns {Array<{image_id:number, txn_id:number}>}
 */
function linkImagesToTxns({ ledgerId, imageIds = [], txnIds = [], aiStatus = 'linked' }) {
  const ids = imageIds.map(Number).filter(Boolean);
  const txns = txnIds.map(Number).filter(Boolean);
  if (!ids.length || !txns.length) return [];
  const pairs = [];
  ids.forEach((aid, i) => {
    const target = txns.length === ids.length ? txns[i] : txns[0];
    run(
      'UPDATE attachments SET txn_id = ?, ai_status = ? WHERE id = ? AND ledger_id = ?',
      target, aiStatus, aid, Number(ledgerId)
    );
    pairs.push({ image_id: aid, txn_id: target });
  });
  return pairs;
}

/** 批量查附件（按 txn_id 归组），供列表页显示「有几张图」 */
function listByTxnIds(txnIds = []) {
  const ids = txnIds.map(Number).filter(Boolean);
  const map = new Map();
  if (!ids.length) return map;
  const rows = all(
    `SELECT id, txn_id, file_name, rel_path, mime, size, ai_status, created_at
     FROM attachments WHERE txn_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ...ids
  );
  for (const r of rows) {
    r.url = webUrl(r.rel_path);
    const k = Number(r.txn_id);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

/** 单笔交易的附件列表 */
function listByTxn(txnId) {
  return all(
    `SELECT id, txn_id, file_name, rel_path, mime, size, ai_status, created_at
     FROM attachments WHERE txn_id = ? ORDER BY id`,
    Number(txnId)
  ).map((r) => ({ ...r, url: webUrl(r.rel_path) }));
}

/** { txnId: count } —— 轻量，只数数量 */
function countByTxnIds(txnIds = []) {
  const ids = txnIds.map(Number).filter(Boolean);
  const map = new Map();
  if (!ids.length) return map;
  const rows = all(
    `SELECT txn_id, COUNT(*) AS c FROM attachments
     WHERE txn_id IN (${ids.map(() => '?').join(',')}) GROUP BY txn_id`,
    ...ids
  );
  for (const r of rows) map.set(Number(r.txn_id), Number(r.c));
  return map;
}

/** 给一批交易对象补 attachment_count 字段（原地修改，返回同一数组） */
function attachCounts(items = []) {
  const counts = countByTxnIds(items.map((t) => t && t.id));
  for (const t of items) {
    if (t && t.id != null) t.attachment_count = counts.get(Number(t.id)) || 0;
  }
  return items;
}

function getById(ledgerId, id) {
  const row = get('SELECT * FROM attachments WHERE id = ? AND ledger_id = ?', Number(id), Number(ledgerId));
  if (row) row.url = webUrl(row.rel_path);
  return row || null;
}

/** 取附件的磁盘路径（做目录穿越校验），文件不存在返回 null */
function resolveFile(ledgerId, id) {
  const row = getById(ledgerId, id);
  if (!row) return null;
  const root = path.resolve(uploadsRoot());
  const abs = path.resolve(root, String(row.rel_path));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(abs)) return null;
  return { abs, row };
}

/** 附件回显时的安全 Content-Type：库里记录的 mime 只允许位图白名单，其余按二进制流下发 */
function safeMime(mime) {
  const m = String(mime || '').toLowerCase();
  return MIME_EXT[m] ? m : 'application/octet-stream';
}

/** 删除附件：先删文件再删行 */
function removeById(ledgerId, id) {
  const row = get('SELECT * FROM attachments WHERE id = ? AND ledger_id = ?', Number(id), Number(ledgerId));
  if (!row) return false;
  const root = path.resolve(uploadsRoot());
  const abs = path.resolve(root, String(row.rel_path));
  if (abs.startsWith(root + path.sep)) {
    try { fs.unlinkSync(abs); } catch { /* 文件可能已被手工删除 */ }
  }
  run('DELETE FROM attachments WHERE id = ?', row.id);
  return true;
}

module.exports = {
  MIME_EXT, MAX_IMAGE_BYTES, MAX_IMAGES,
  uploadsRoot, webUrl, parseDataUrl, safeMime,
  saveDataUrlImage, linkImagesToTxns,
  listByTxnIds, listByTxn, countByTxnIds, attachCounts,
  getById, resolveFile, removeById,
};

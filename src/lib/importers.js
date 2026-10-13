'use strict';
/**
 * 账单导入 / 导出
 *  - 支付宝账单 CSV（GBK 编码，含表头说明行）
 *  - 微信支付账单 CSV（UTF-8）或 xlsx（微信 App/PC 导出，零依赖解析）
 *  - 通用 CSV（按表头智能匹配）
 * 自动识别编码、自动映射分类与账户、自动去重
 */
const zlib = require('node:zlib');
const { all, get, run, tx, nowStr, todayStr, recalcBalances } = require('../db');
const { parseAmountToCents } = require('./util');
const { classifyByKeywords, guessAccountName, resolveCategoryId, resolveAccountId } = require('./ai');

/* ------------------------------- xlsx（零依赖） ------------------------------- */

/** 解 xlsx（ZIP + sharedStrings + sheet1 XML），只依赖 node:zlib。
    微信账单 xlsx 的交易时间是 Excel 序列数，转成 YYYY-MM-DD HH:mm:ss 字符串 */
function xlsxToRows(buf) {
  // 1) 手撕 ZIP（local file headers），只取需要的成员
  const files = {};
  let off = 0;
  while (off < buf.length - 4) {
    if (buf.readUInt32LE(off) !== 0x04034b50) { off++; continue; }
    const method = buf.readUInt16LE(off + 8);
    let csize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString();
    const dataStart = off + 30 + nameLen + extraLen;
    if (!csize) {
      let next = dataStart;
      while (next < buf.length - 4 && buf.readUInt32LE(next) !== 0x04034b50 && buf.readUInt32LE(next) !== 0x02014b50) next++;
      csize = next - dataStart;
    }
    const raw = buf.slice(dataStart, dataStart + csize);
    try { files[name] = method === 8 ? zlib.inflateRawSync(raw) : raw; } catch { /* 坏成员忽略 */ }
    off = dataStart + csize;
  }
  const sheetName = Object.keys(files).find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n))
    || Object.keys(files).find((n) => /^xl\/worksheets\/.*\.xml$/.test(n));
  if (!sheetName) return null;
  // 2) 共享字符串表
  const xmlEntities = (s) => String(s || '')
    .replace(/&(lt|gt|amp|quot|apos|#x?[0-9a-fA-F]+);/g, (_, e) => {
      if (e === 'lt') return '<';
      if (e === 'gt') return '>';
      if (e === 'amp') return '&';
      if (e === 'quot') return '"';
      if (e === 'apos') return "'";
      if (e[0] === 'x' || e[0] === 'X') return String.fromCharCode(parseInt(e.slice(1), 16));
      return String.fromCharCode(parseInt(e.slice(1), 10));
    });
  const strings = [];
  if (files['xl/sharedStrings.xml']) {
    const ssXml = files['xl/sharedStrings.xml'].toString('utf8');
    for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      let s = '';
      for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += t[1];
      strings.push(xmlEntities(s));
    }
  }
  // 3) 工作表 → 行数组（稀疏单元格按列号归位）
  const sheet = files[sheetName].toString('utf8');
  const colIndex = (letters) => {
    let i = 0;
    for (const ch of letters) i = i * 26 + (ch.charCodeAt(0) - 64);
    return i - 1;
  };
  const excelSerialToText = (v) => {
    // Excel 日期序列：1900 日期系统，1 = 1900-01-01；含闰年 bug（序列 ≥60 需多减一天）。
    // 小数部分为当日时间比例。
    const num = Number(v);
    if (!Number.isFinite(num)) return String(v);
    let days = Math.floor(num);
    let frac = num - days;
    // 序列 60 是不存在的 1900-02-29
    if (days >= 60) days -= 1;
    const d = new Date(Date.UTC(1899, 11, 31) + days * 86400000);
    const secs = Math.round(frac * 86400);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
  };
  const rows = [];
  for (const rm of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\s+[^>]*?r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>|<c\s+[^>]*?r="([A-Z]+)\d+"([^>]*)\/>/g)) {
      const col = cm[1] || cm[4];
      const attrs = cm[2] || cm[5] || '';
      const inner = cm[3] || '';
      const typeM = attrs.match(/t="(\w+)"/);
      const type = typeM ? typeM[1] : '';
      const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
      let val = '';
      if (type === 's' && vm) val = strings[Number(vm[1])] || '';
      else if (type === 'inlineStr') {
        const tm = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        val = tm ? xmlEntities(tm[1]) : '';
      } else if (vm) {
        val = xmlEntities(vm[1]);
        // 无类型且是纯数字日期样式无法从样式表可靠判断，靠值形态兜底：
        // 微信账单的交易时间是 4 万多的大数带小数（>40000 即 2009 年以后）
        if (!type && /^\d{5}(\.\d+)?$/.test(val)) val = excelSerialToText(val);
      }
      cells[colIndex(col)] = val;
    }
    rows.push(cells);
  }
  return rows;
}

/* ------------------------------- 编码与 CSV ------------------------------- */

/** 支付宝导出为 GBK，微信为 UTF-8：先按 UTF-8 解，出现替换字符则按 GBK 重解 */
function decodeBuffer(buf) {
  const tryDecode = (enc) => {
    try { return new TextDecoder(enc, { fatal: false }).decode(buf); } catch { return null; }
  };
  const utf8 = tryDecode('utf-8');
  if (utf8 && !utf8.includes('\uFFFD')) return { text: utf8.replace(/^\uFEFF/, ''), encoding: 'utf-8' };
  const gbk = tryDecode('gbk') || tryDecode('gb18030');
  if (gbk) return { text: gbk.replace(/^\uFEFF/, ''), encoding: 'gbk' };
  return { text: utf8 || '', encoding: 'utf-8' };
}

/** 支持引号包裹与转义的 CSV 行解析 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map(parseCsvLine);
}

const HEADER_KEYS = ['交易时间', '交易分类', '交易类型', '金额', '收/支', '收/付款方式', '支付方式', '日期', '时间', 'amount', 'date'];

function isHeaderRow(cells) {
  const joined = cells.join(',');
  return HEADER_KEYS.some((k) => joined.includes(k)) && cells.length >= 4;
}

/** 表头名 → 索引（支持模糊） */
function headerIndex(header, candidates) {
  for (const c of candidates) {
    const i = header.findIndex((h) => h === c);
    if (i >= 0) return i;
  }
  for (const c of candidates) {
    const i = header.findIndex((h) => h && h.includes(c));
    if (i >= 0) return i;
  }
  return -1;
}

function detectSource(headerLine, fullText) {
  const h = headerLine.join(',');
  if (h.includes('交易分类') || /支付宝/.test(fullText.slice(0, 2000))) return 'alipay';
  // 微信 xlsx 表头：交易类型/交易对方/商品/当前状态；CSV 表头：交易类型/当前状态
  if (h.includes('交易类型') || h.includes('当前状态') || h.includes('交易对方') || /微信支付账单|微信/.test(fullText.slice(0, 2000))) return 'wechat';
  return 'generic';
}

/* ------------------------------- 单条规范化 ------------------------------- */

const SKIP_STATUS = /已关闭|交易关闭|已退款|全额退款|退款成功|失败|已撤销|已取消|待付款|待收货|银行处理中|已退回/;

/** 导出 CSV type_key 列的合法值 */
const TXN_KEYS = new Set(['expense','income','transfer','lend','borrow','repay_receive','repay_pay','reimburse','refund','fee','interest','invest_buy','invest_sell','adjust']);

function normalizeRow({ date, direction, amountText, merchant, desc, categoryText, accountText, status, orderNo, typeKey }) {
  const amountCents = parseAmountToCents(amountText);
  const dir = String(direction || '').trim();
  let type = 'expense';
  let neutral = false;
  // type_key 精确类型优先（家账簿导出的 CSV 回导），收支方向仅作兜底
  if (TXN_KEYS.has(typeKey)) {
    type = typeKey;
  } else if (/不计/.test(dir)) {
    // 转账 / 提现 / 充值 等「不计收支」记录：默认不导入（成对记录只导一半会破坏余额）
    type = 'transfer';
    neutral = true;
  } else if (/^\/?$/.test(dir) || !dir) {
    // 微信账单里零钱充值/提现/亲属卡等行的「收/支」列是 "/"——同属资金搬移，归入不计收支
    type = 'transfer';
    neutral = true;
  } else if (/收入|收/.test(dir)) type = 'income';
  else if (/支出|支/.test(dir)) type = 'expense';
  const text = `${categoryText || ''} ${desc || ''} ${merchant || ''}`;
  return {
    skip: false,
    neutral,
    type,
    amount_cents: amountCents,
    txn_date: normalizeDate(date),
    merchant: (merchant || desc || '').slice(0, 60) || null,
    note: [categoryText, desc, status].filter(Boolean).join(' · ').slice(0, 200) || null,
    category_hint: categoryText || null,
    text,
    account_hint: accountText || guessAccountName(text) || null,
    order_no: orderNo || null,
  };
}

function normalizeDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/(20\d{2})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/(\d{1,2})[-\/](\d{1,2})[-\/](20\d{2})/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  return todayStr();
}

/* --------------------------------- 主解析器 -------------------------------- */

function parseBill(buffer) {
  // xlsx 是 ZIP 容器（PK 魔数）：转成行数组后与 CSV 走同一套表头识别逻辑
  let text, encoding, rows;
  if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    rows = xlsxToRows(buffer);
    if (!rows) return { source: 'unknown', encoding: 'xlsx', header: [], records: [], totalLines: 0, error: 'xlsx 文件解析失败，请确认文件完整（或改导出为 CSV）' };
    text = rows.map((r) => r.join(',')).join('\n');
    encoding = 'xlsx';
  } else {
    const decoded = decodeBuffer(buffer);
    text = decoded.text;
    encoding = decoded.encoding;
    rows = parseCsv(text);
  }
  const headerIdx = rows.findIndex(isHeaderRow);
  if (headerIdx < 0) {
    return { source: 'unknown', encoding, header: [], records: [], totalLines: rows.length, error: '未找到有效表头，请确认为支付宝/微信导出的账单文件（CSV 或 xlsx）' };
  }
  const header = rows[headerIdx].map((h) => String(h || '').trim());
  const source = detectSource(header, text);
  const body = rows.slice(headerIdx + 1).filter((r) => r.length > 2 && r.join('').replace(/[-,\s]/g, '').length > 0);

  const iDate = headerIndex(header, ['交易时间', '交易日期', '日期', '时间', 'date']);
  const iDir = headerIndex(header, ['收/支', '收支', '类型', '方向']);
  const iAmount = headerIndex(header, ['金额(元)', '金额', 'amount']);
  const iMerchant = headerIndex(header, ['交易对方', '对方', 'merchant', '商家']);
  const iDesc = headerIndex(header, ['商品说明', '商品', '备注', '描述', '说明', 'note', 'detail']);
  const iCategory = headerIndex(header, ['交易分类', '分类', 'category']);
  const iAccount = headerIndex(header, ['收/付款方式', '支付方式', '付款方式', '账户', 'account']);
  const iStatus = headerIndex(header, ['当前状态', '交易状态', '状态', 'status']);
  const iOrder = headerIndex(header, ['交易订单号', '交易单号', '订单号', 'order']);
  const iTypeKey = headerIndex(header, ['type_key']);

  const records = [];
  const neutralRecords = []; // 提现 / 充值 / 余额宝转出等「不计收支」记录，默认不入库
  let skipped = 0;
  for (const r of body) {
    const status = iStatus >= 0 ? r[iStatus] : '';
    if (status && SKIP_STATUS.test(status)) { skipped++; continue; }
    const norm = normalizeRow({
      date: iDate >= 0 ? r[iDate] : '',
      direction: iDir >= 0 ? r[iDir] : '',
      amountText: iAmount >= 0 ? r[iAmount] : '',
      merchant: iMerchant >= 0 ? r[iMerchant] : '',
      desc: iDesc >= 0 ? r[iDesc] : '',
      categoryText: iCategory >= 0 ? r[iCategory] : '',
      accountText: iAccount >= 0 ? r[iAccount] : '',
      status,
      orderNo: iOrder >= 0 ? r[iOrder] : '',
      // 家账簿自己导出的 CSV 带 type_key 精确类型列：回导时优先还原（借贷/报销等不会退化为支出）
      typeKey: iTypeKey >= 0 ? r[iTypeKey] : '',
    });
    if (norm.skip || !norm.amount_cents) { skipped++; continue; }
    if (norm.neutral) neutralRecords.push(norm);
    else records.push(norm);
  }
  return { source, encoding, header, records, neutralRecords, totalLines: rows.length, skipped };
}

/* --------------------------------- 执行导入 -------------------------------- */

function ensureAccount(ledgerId, name, createdList) {
  if (!name) return null;
  const n = String(name).trim();
  // "/" 是账单里「无对方/匿名」的占位符，不能当成账户名
  if (!n || n === '/' || n === '-') return null;
  const id = resolveAccountId(ledgerId, n);
  if (id) return id;
  const type = /信用/.test(n) ? 'credit' : /支付宝|微信|京东|云闪付/.test(n) ? 'virtual' : /银行|卡/.test(n) ? 'debit' : 'other';
  const icon = type === 'credit' ? '💳' : type === 'virtual' ? '📱' : type === 'debit' ? '🏦' : '📦';
  const r = run(
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, sort_order, note, created_at)
     VALUES (?,?,?,?,?,0,0,999,?,?)`,
    ledgerId, n.slice(0, 30), type, icon, 'CNY', '由账单导入自动创建', nowStr()
  );
  createdList.push(n);
  return r.lastInsertRowid;
}

/** 「不计收支」记录（提现/充值）找不到对方账户时使用的兜底账户，保证转账双边平衡 */
const NEUTRAL_FALLBACK_ACCOUNT = '外部往来账户';

/**
 * 把解析结果写入数据库
 * @param {object} o
 * @param {boolean} [o.includeNeutral] 是否同时导入「不计收支」记录（提现 / 充值等）
 * @param {Object<number,number>} [o.ledgerOverrides] 记录索引 → 目标账本 id（调用方已校验写权限；
 *   家庭账单导入时把水电暖等共用支出改记到家庭账本、个人消费留在个人账本）
 * @returns {{imported:number, skipped:number, failed:number, createdAccounts:string[], jobId:number, ledgerSplit:Object}}
 */
function importRecords({
  ledgerId, userId, records, neutralRecords = [], includeNeutral = false,
  source, fileName, autoCreateAccount = true, defaultAccountId = null, ledgerOverrides = {},
}) {
  const createdAccounts = [];
  let imported = 0, skipped = 0, failed = 0;
  const list = includeNeutral ? records.concat(neutralRecords) : records.slice();
  // 按目标账本分组：无覆盖的进当前账本，有覆盖的进指定账本
  const buckets = new Map();
  list.forEach((rec, i) => {
    const target = Number(ledgerOverrides[i]) || Number(ledgerId);
    if (!buckets.has(target)) buckets.set(target, []);
    buckets.get(target).push(rec);
  });
  const importedPerLedger = {};

  tx(() => {
    for (const [lid, recs] of buckets) {
      const dupSet = new Set();
      // 预载该账本已有记录指纹，避免重复导入（分账本判重）
      for (const t of all(
        'SELECT txn_date, amount_base_cents, merchant FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND source = ?',
        lid, 'import'
      )) {
        dupSet.add(`${t.txn_date}|${t.amount_base_cents}|${t.merchant || ''}`);
      }

      for (const rec of recs) {
        try {
          const fp = `${rec.txn_date}|${rec.amount_cents}|${rec.merchant || ''}`;
          if (dupSet.has(fp)) { skipped++; continue; }

          let categoryId = null;
          let toAccountId = null;
          const accountId = autoCreateAccount
            ? ensureAccount(lid, rec.account_hint, createdAccounts)
            : resolveAccountId(lid, rec.account_hint) || defaultAccountId;

          if (rec.neutral) {
            // 提现 / 充值：账户之间搬钱，不计入收支。对方账户优先从说明文字推断
            const cpName = guessAccountName(rec.text) || NEUTRAL_FALLBACK_ACCOUNT;
            toAccountId = autoCreateAccount
              ? ensureAccount(lid, cpName, createdAccounts) || ensureAccount(lid, NEUTRAL_FALLBACK_ACCOUNT, createdAccounts)
              : resolveAccountId(lid, cpName) || null;
          } else if (rec.type === 'transfer' || rec.type === 'invest_buy' || rec.type === 'invest_sell' || rec.type === 'lend' || rec.type === 'borrow') {
            // 回导的双边类型（转账/借贷）：对方账户从说明文字推断；推不出就按 transfer 兜底（一方账户仍保留）
            const cpName = guessAccountName(rec.text) || NEUTRAL_FALLBACK_ACCOUNT;
            toAccountId = autoCreateAccount
              ? ensureAccount(lid, cpName, createdAccounts)
              : resolveAccountId(lid, cpName) || null;
            if (!toAccountId) rec.type = 'transfer';
          } else {
            const kind = rec.type === 'income' ? 'income' : 'expense';
            const kw = classifyByKeywords(rec.text);
            if (rec.category_hint) categoryId = resolveCategoryId(lid, rec.category_hint, kind);
            if (!categoryId && kw) categoryId = resolveCategoryId(lid, kw.category, kw.kind === 'income' ? 'income' : kind);
            if (!categoryId) categoryId = resolveCategoryId(lid, kind === 'income' ? '其他收入' : '其他支出', kind);
          }
          // 余额调整回导保留负金额（调减为带符号数），方向不能翻转；
          // 但 expense/income 直接以负数入库会把方向写反（txnEffects 对 expense 取 -a），钳回正数
          const signedAmount = rec.type === 'adjust' ? rec.amount_cents : Math.abs(rec.amount_cents);

          run(
            `INSERT INTO transactions
             (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
              user_id, txn_date, note, merchant, status, source, ai_json, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            lid, rec.type, signedAmount, 'CNY', 1, signedAmount,
            accountId, toAccountId, categoryId, userId, rec.txn_date, rec.note, rec.merchant,
            'cleared', 'import', JSON.stringify({ source, order_no: rec.order_no, neutral: !!rec.neutral }),
            nowStr(), nowStr()
          );
          dupSet.add(fp);
          imported++;
          importedPerLedger[lid] = (importedPerLedger[lid] || 0) + 1;
        } catch {
          failed++;
        }
      }
    }
  });

  // 导入是直接写表，必须重算账户余额，否则余额与流水不一致（涉及到的每个账本都要）
  for (const lid of Object.keys(importedPerLedger)) recalcBalances(Number(lid));

  const otherLedgers = Object.entries(importedPerLedger).filter(([lid]) => Number(lid) !== Number(ledgerId));
  const job = run(
    `INSERT INTO import_jobs (ledger_id, user_id, source, file_name, total, imported, skipped, failed, status, message, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ledgerId, userId, source, fileName, list.length, imported, skipped, failed, 'done',
    (createdAccounts.length ? `自动创建账户：${createdAccounts.join('、')}` : null)
      || (otherLedgers.length ? `另有 ${otherLedgers.reduce((s, [, n]) => s + n, 0)} 笔记入其他账本` : null),
    nowStr()
  );
  return { imported, skipped, failed, createdAccounts, jobId: job.lastInsertRowid, ledgerSplit: importedPerLedger };
}

/* --------------------------------- 导出 ---------------------------------- */

function csvEscape(v) {
  let s = v === null || v === undefined ? '' : String(v);
  // 公式注入防护：以 = + - @ 开头的单元格加前缀，防止 Excel/WPS 打开时当公式执行
  if (/^[=+\-@]/.test(s)) s = `'` + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  // 加 BOM 让 Excel 正确识别 UTF-8
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// 第二列「类型」是人读中文 label，第十六列 type_key 是机读枚举（回导时优先用它精确还原类型）
const EXPORT_HEADER = ['日期', '类型', '金额', '币种', '折算金额', '分类', '账户', '转入账户', '成员', '商家', '备注', '标签', '来源', '状态', '备注2', 'type_key'];

function exportRows(ledgerId, rows) {
  return rows.map((t) => [
    t.txn_date, t.type_label || t.type, (t.amount_cents / 100).toFixed(2), t.currency,
    (t.amount_base_cents / 100).toFixed(2), t.category_path || '', t.account_name || '',
    t.to_account_name || '', t.member_name || '', t.merchant || '', t.note || '',
    t.tag_names || '', t.source, t.status, '', t.type,
  ]);
}

module.exports = { parseBill, importRecords, toCsv, csvEscape, EXPORT_HEADER, exportRows, decodeBuffer, normalizeDate };

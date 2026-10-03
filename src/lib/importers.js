'use strict';
/**
 * 账单导入 / 导出
 *  - 支付宝账单 CSV（GBK 编码，含表头说明行）
 *  - 微信支付账单 CSV（UTF-8）
 *  - 通用 CSV（按表头智能匹配）
 * 自动识别编码、自动映射分类与账户、自动去重
 */
const { all, get, run, tx, nowStr, todayStr, recalcBalances } = require('../db');
const { parseAmountToCents, monthOf } = require('./util');
const { classifyByKeywords, guessAccountName, resolveCategoryId, resolveAccountId } = require('./ai');

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
  if (h.includes('交易类型') || h.includes('当前状态') || /微信/.test(fullText.slice(0, 2000))) return 'wechat';
  return 'generic';
}

/* ------------------------------- 单条规范化 ------------------------------- */

const SKIP_STATUS = /已关闭|交易关闭|已退款|全额退款|退款成功|失败|已撤销|已取消|待付款|待收货|银行处理中|已退回/;

/** 导出 CSV type_key 列的合法值 */
const TXN_KEYS = new Set(['expense','income','transfer','lend','borrow','repay_receive','repay_pay','reimburse','refund','fee','interest','invest_buy','invest_sell','adjust']);

function normalizeRow({ date, direction, amountText, merchant, desc, categoryText, accountText, status, orderNo }) {
  const amountCents = parseAmountToCents(amountText);
  const dir = String(direction || '').trim();
  let type = 'expense';
  let neutral = false;
  if (/不计/.test(dir)) {
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
  const { text, encoding } = decodeBuffer(buffer);
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex(isHeaderRow);
  if (headerIdx < 0) {
    return { source: 'unknown', encoding, header: [], records: [], totalLines: rows.length, error: '未找到有效表头，请确认为支付宝/微信导出的 CSV 账单' };
  }
  const header = rows[headerIdx];
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
  const id = resolveAccountId(ledgerId, name);
  if (id) return id;
  const type = /信用/.test(name) ? 'credit' : /支付宝|微信|京东|云闪付/.test(name) ? 'virtual' : /银行|卡/.test(name) ? 'debit' : 'other';
  const icon = type === 'credit' ? '💳' : type === 'virtual' ? '📱' : type === 'debit' ? '🏦' : '📦';
  const r = run(
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, sort_order, note, created_at)
     VALUES (?,?,?,?,?,0,0,999,?,?)`,
    ledgerId, String(name).slice(0, 30), type, icon, 'CNY', '由账单导入自动创建', nowStr()
  );
  createdList.push(name);
  return r.lastInsertRowid;
}

/** 「不计收支」记录（提现/充值）找不到对方账户时使用的兜底账户，保证转账双边平衡 */
const NEUTRAL_FALLBACK_ACCOUNT = '外部往来账户';

/**
 * 把解析结果写入数据库
 * @param {object} o
 * @param {boolean} [o.includeNeutral] 是否同时导入「不计收支」记录（提现 / 充值等）
 * @returns {{imported:number, skipped:number, failed:number, createdAccounts:string[], jobId:number}}
 */
function importRecords({
  ledgerId, userId, records, neutralRecords = [], includeNeutral = false,
  source, fileName, autoCreateAccount = true, defaultAccountId = null,
}) {
  const createdAccounts = [];
  let imported = 0, skipped = 0, failed = 0;
  const list = includeNeutral ? records.concat(neutralRecords) : records.slice();
  const dupSet = new Set();
  // 预载已有记录指纹，避免重复导入
  for (const t of all(
    'SELECT txn_date, amount_base_cents, merchant FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND source = ?',
    ledgerId, 'import'
  )) {
    dupSet.add(`${t.txn_date}|${t.amount_base_cents}|${t.merchant || ''}`);
  }

  tx(() => {
    for (const rec of list) {
      try {
        const fp = `${rec.txn_date}|${rec.amount_cents}|${rec.merchant || ''}`;
        if (dupSet.has(fp)) { skipped++; continue; }

        let categoryId = null;
        let toAccountId = null;
        const accountId = autoCreateAccount
          ? ensureAccount(ledgerId, rec.account_hint, createdAccounts)
          : resolveAccountId(ledgerId, rec.account_hint) || defaultAccountId;

        if (rec.neutral) {
          // 提现 / 充值：账户之间搬钱，不计入收支。对方账户优先从说明文字推断
          const cpName = guessAccountName(rec.text) || NEUTRAL_FALLBACK_ACCOUNT;
          toAccountId = autoCreateAccount
            ? ensureAccount(ledgerId, cpName, createdAccounts) || ensureAccount(ledgerId, NEUTRAL_FALLBACK_ACCOUNT, createdAccounts)
            : resolveAccountId(ledgerId, cpName) || null;
        } else if (rec.type === 'transfer' || rec.type === 'invest_buy' || rec.type === 'invest_sell' || rec.type === 'lend' || rec.type === 'borrow') {
          // 回导的双边类型（转账/借贷）：对方账户从说明文字推断；推不出就按 transfer 兜底（一方账户仍保留）
          const cpName = guessAccountName(rec.text) || NEUTRAL_FALLBACK_ACCOUNT;
          toAccountId = autoCreateAccount
            ? ensureAccount(ledgerId, cpName, createdAccounts)
            : resolveAccountId(ledgerId, cpName) || null;
          if (!toAccountId) rec.type = 'transfer';
        } else {
          const kind = rec.type === 'income' ? 'income' : 'expense';
          const kw = classifyByKeywords(rec.text);
          if (rec.category_hint) categoryId = resolveCategoryId(ledgerId, rec.category_hint, kind);
          if (!categoryId && kw) categoryId = resolveCategoryId(ledgerId, kw.category, kw.kind === 'income' ? 'income' : kind);
          if (!categoryId) categoryId = resolveCategoryId(ledgerId, kind === 'income' ? '其他收入' : '其他支出', kind);
        }
        // 余额调整回导保留负金额（调减为带符号数），方向不能翻转；
        // 但 expense/income 直接以负数入库会把方向写反（txnEffects 对 expense 取 -a），钳回正数
        const signedAmount = rec.type === 'adjust' ? rec.amount_cents : Math.abs(rec.amount_cents);

        run(
          `INSERT INTO transactions
           (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
            user_id, txn_date, note, merchant, status, source, ai_json, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ledgerId, rec.type, signedAmount, 'CNY', 1, signedAmount,
          accountId, toAccountId, categoryId, userId, rec.txn_date, rec.note, rec.merchant,
          'cleared', 'import', JSON.stringify({ source, order_no: rec.order_no, neutral: !!rec.neutral }),
          nowStr(), nowStr()
        );
        dupSet.add(fp);
        imported++;
      } catch {
        failed++;
      }
    }
  });

  // 导入是直接写表，必须重算账户余额，否则余额与流水不一致
  if (imported > 0) recalcBalances(ledgerId);

  const job = run(
    `INSERT INTO import_jobs (ledger_id, user_id, source, file_name, total, imported, skipped, failed, status, message, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ledgerId, userId, source, fileName, list.length, imported, skipped, failed, 'done',
    createdAccounts.length ? `自动创建账户：${createdAccounts.join('、')}` : null, nowStr()
  );
  return { imported, skipped, failed, createdAccounts, jobId: job.lastInsertRowid };
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
    t.tag_names || '', t.source, t.status,
  ]);
}

module.exports = { parseBill, importRecords, toCsv, csvEscape, EXPORT_HEADER, exportRows, decodeBuffer, normalizeDate };

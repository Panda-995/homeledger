'use strict';
/**
 * 演示数据种子脚本（仅用于演示/截图，独立 DATA_DIR，不影响真实数据）
 * 用法：DATA_DIR=./data-demo node scripts/seed-demo.js
 */
const path = require('node:path');
const fs = require('node:fs');

const db = require('../src/db');
const auth = require('../src/lib/auth');
const util = require('../src/lib/util');
const txn = require('../src/lib/txn');
const att = require('../src/lib/attachments');

function d(offsetDays) {
  const t = new Date(Date.now() - offsetDays * 86400000);
  return t.toISOString().slice(0, 10);
}

function main() {
  if (Number(db.get('SELECT COUNT(*) AS c FROM users')?.c || 0) > 0) {
    console.log('已有用户，跳过种子');
    return;
  }
  // 1. 管理员 + 默认账本/账户
  const info = db.run(
    'INSERT INTO users (username, password_hash, display_name, avatar_color, is_admin, created_at) VALUES (?,?,?,?,1,?)',
    'admin', auth.hashPassword('admin123456'), '小夏', util.colorFor('demo'), db.nowStr()
  );
  const uid = Number(info.lastInsertRowid);
  const ledgerId = Number(db.createDefaultLedger(uid, '小夏'));
  db.run('UPDATE ledgers SET name = ? WHERE id = ?', '家的账本', ledgerId);
  db.setSetting('site.name', '家账簿');
  db.setSetting('ai.enabled', 'true');
  db.setSetting('ai.auto_save', 'true');
  db.setSetting('ai.api_key', 'sk-demo-key-0000000000000000');
  db.setSetting('ai.model', 'glm-4v-flash');

  const acc = {};
  for (const r of db.all('SELECT id, name FROM accounts WHERE ledger_id = ?', ledgerId)) acc[r.name] = Number(r.id);
  const cat = {};
  for (const r of db.all("SELECT id, name, kind FROM categories WHERE parent_id IS NOT NULL AND is_system = 1")) {
    if (!cat[r.name]) cat[r.name] = Number(r.id);
  }
  const topCat = {};
  for (const r of db.all("SELECT id, name FROM categories WHERE parent_id IS NULL AND is_system = 1")) topCat[r.name] = Number(r.id);
  const cid = (name) => cat[name] || topCat[name] || null;

  // 2. 账单图片（演示收据）
  const receiptPath = path.join(__dirname, '..', 'test', 'fixtures', 'receipt.png');
  let receiptDataUrl = null;
  if (fs.existsSync(receiptPath)) {
    receiptDataUrl = 'data:image/png;base64,' + fs.readFileSync(receiptPath).toString('base64');
  } else {
    console.log('⚠️ 未找到 receipt.png，将跳过附件演示');
  }

  // 3. 交易流水：近 30 天
  const T = (date, type, yuan, accName, catName, opt = {}) => txn.createTransaction(ledgerId, uid, {
    type, amount_cents: Math.round(yuan * 100), account_id: acc[accName],
    category_id: cid(catName), txn_date: date, currency: 'CNY',
    note: opt.note || null, merchant: opt.merchant || null, source: opt.source || 'manual',
    to_account_id: opt.to ? acc[opt.to] : null, ai_json: opt.ai || null,
  });

  // 工资 + 房租 + 大额
  T(d(15), 'income', 18500, '银行卡', '工资', { note: '9月工资', merchant: '公司' });
  T(d(15), 'expense', 4200, '银行卡', '房租', { note: '9月房租', merchant: '房东' });
  T(d(14), 'transfer', 5000, '银行卡', null, { to: '微信钱包', note: '补充零钱' });
  T(d(13), 'transfer', 2000, '银行卡', null, { to: '支付宝', note: '充值' });
  T(d(12), 'income', 200, '现金', '红包', { note: '生日红包' });
  T(d(24), 'transfer', 3000, '微信钱包', null, { to: '银行卡', note: '零钱转入银行卡' });
  T(d(23), 'expense', 299, '支付宝', '手机话费', { note: '宽带年费摊销', merchant: '运营商' });
  T(d(22), 'expense', 168.5, '微信钱包', '水果', { merchant: '盒马鲜生' });
  T(d(21), 'expense', 35.8, '微信钱包', '早餐', { merchant: '巴比馒头' });
  T(d(20), 'expense', 226, '支付宝', '水费', { note: '8月电费', merchant: '国家电网' });
  T(d(19), 'expense', 89, '信用卡', '餐饮', { merchant: '海底捞' });
  T(d(18), 'expense', 45.9, '支付宝', '打车', { merchant: '滴滴出行' });
  T(d(17), 'expense', 132.4, '微信钱包', '水果', { merchant: '鲜丰超市' });
  T(d(16), 'expense', 1200, '信用卡', '服饰', { merchant: '优衣库' });
  T(d(15), 'expense', 58, '微信钱包', '午餐', { merchant: '公司食堂' });
  T(d(14), 'expense', 99, '支付宝', '娱乐', { note: '视频网站年卡', merchant: '爱奇艺' });
  T(d(13), 'expense', 328, '信用卡', '餐饮', { merchant: '西贝莜面村' });
  T(d(12), 'expense', 46.5, '微信钱包', '水果', { merchant: '叮咚买菜' });
  T(d(11), 'expense', 200, '银行卡', '孝敬长辈', { note: '每月孝亲' });
  T(d(10), 'expense', 15, '现金', '零食', { merchant: '便利店' });
  T(d(9), 'expense', 3699, '信用卡', '数码电器', { merchant: '京东', note: '空气炸锅+吸尘器' });
  T(d(8), 'expense', 76.8, '微信钱包', '午餐', { merchant: '外婆家' });
  T(d(7), 'expense', 42.3, '支付宝', '打车', { merchant: '滴滴出行' });
  T(d(6), 'transfer', 6000, '银行卡', null, { to: '信用卡', note: '信用卡还款' });
  T(d(6), 'expense', 86.5, '微信钱包', '水果', { merchant: '鲜丰超市', source: 'ai_screenshot', note: 'AI 识别：鲜丰超市账单截图' });
  T(d(5), 'expense', 129, '信用卡', '育儿', { merchant: '孩子王' });
  T(d(4), 'expense', 66.6, '支付宝', '午餐', { merchant: '美团外卖' });
  T(d(3), 'expense', 158, '微信钱包', '餐饮', { merchant: '本地宝烧烤' });
  T(d(2), 'expense', 23.9, '微信钱包', '早餐', { merchant: '肯德基' });
  T(d(1), 'expense', 452.3, '信用卡', '加油', { merchant: '中石化' });
  T(d(0), 'expense', 38.5, '微信钱包', '午餐', { merchant: '公司食堂' });

  // 4. 把演示收据挂到 AI 识别的那笔（鲜丰超市 86.5）
  if (receiptDataUrl) {
    const row = db.get(
      "SELECT id FROM transactions WHERE ledger_id = ? AND source = 'ai_screenshot' ORDER BY id DESC LIMIT 1", ledgerId
    );
    if (row) {
      const img = att.saveDataUrlImage({
        dataUrl: receiptDataUrl, ledgerId, userId: uid,
        name: '鲜丰超市-账单截图.png', kind: 'screenshot', aiStatus: 'linked',
      });
      att.linkImagesToTxns({ ledgerId, imageIds: [img.id], txnIds: [Number(row.id)] });
      console.log(`✅ 收据图片 #${img.id} 已关联到交易 #${row.id}`);
    }
  }

  // 5. 预算（本月总预算 8000，餐饮子预算 1500）
  db.run(
    "INSERT INTO budgets (ledger_id, name, scope, period, amount_cents, currency, alert_pct, is_active, created_at) VALUES (?,?,'overall','monthly',?, 'CNY', 80, 1, ?)",
    ledgerId, '每月总预算', 1200000, db.nowStr()
  );
  const foodId = cid('餐饮');
  if (foodId) {
    db.run(
      "INSERT INTO budgets (ledger_id, name, scope, category_id, period, amount_cents, currency, alert_pct, is_active, created_at) VALUES (?,?,'category',?,'monthly',?, 'CNY', 80, 1, ?)",
      ledgerId, '餐饮预算', foodId, 150000, db.nowStr()
    );
  }

  const n = Number(db.get('SELECT COUNT(*) AS c FROM transactions')?.c || 0);
  console.log(`✅ 演示数据就绪：${n} 笔交易，账本 #${ledgerId}`);
}

main();

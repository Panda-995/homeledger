'use strict';
/**
 * 订阅扣费：列表 / 新建 / 编辑 / 暂停 / 取消 / 立即扣费 / 跳过本期 / 删除
 */
const express = require('express');
const { get, run, nowStr, todayStr } = require('../db');
const auth = require('../lib/auth');
const fd = require('../lib/formdata');
const u = require('../lib/util');
const subs = require('../lib/subscriptions');

const router = express.Router();

/** 常用订阅服务快选（点一下自动带出名称/图标/计费周期） */
const PRESETS = [
  { name: 'Netflix', icon: '🎬', cycle: 'monthly' },
  { name: 'Spotify', icon: '🎵', cycle: 'monthly' },
  { name: 'YouTube Premium', icon: '▶️', cycle: 'monthly' },
  { name: 'iCloud+', icon: '☁️', cycle: 'monthly' },
  { name: '百度网盘', icon: '🗂️', cycle: 'yearly' },
  { name: '爱奇艺', icon: '📺', cycle: 'monthly' },
  { name: '腾讯视频', icon: '📺', cycle: 'monthly' },
  { name: 'ChatGPT Plus', icon: '🤖', cycle: 'monthly' },
  { name: 'Adobe 全家桶', icon: '🎨', cycle: 'yearly' },
  { name: 'Notion', icon: '📝', cycle: 'monthly' },
  { name: '1Password', icon: '🔐', cycle: 'yearly' },
  { name: '域名 / 服务器', icon: '🌐', cycle: 'yearly' },
];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 表单 → 订阅字段 */
function readForm(body, userId) {
  const name = String(body.name || '').trim();
  const amount = u.parseAmountToCents(body.amount);
  const cycle = subs.cycleOf(body.cycle);
  const cycleN = Math.max(1, Math.min(12, Number(body.cycle_n) || 1));
  const anchorDay = Math.max(1, Math.min(31, Number(body.anchor_day) || Number(todayStr().slice(8, 10))));
  const anchorMonth = body.anchor_month ? Math.max(1, Math.min(12, Number(body.anchor_month))) : null;
  const trialEnds = DAY_RE.test(String(body.trial_ends_on || '')) ? body.trial_ends_on : null;
  const status = ['trial', 'active', 'paused'].includes(body.status) ? body.status : 'active';

  // 首次扣费日：填了就用，填的日期已过则按周期顺延；试用中且未填则默认试用结束日
  let next = DAY_RE.test(String(body.next_charge_at || '')) ? body.next_charge_at : '';
  if (!next && trialEnds) next = trialEnds;
  if (!next) next = todayStr();
  let guard = 0;
  while (next < todayStr() && guard++ < 500) next = subs.advance(next, { cycle, cycle_n: cycleN, anchor_day: anchorDay });

  return {
    name: name.slice(0, 40),
    icon: String(body.icon || '🧾').slice(0, 8) || '🧾',
    plan: body.plan ? String(body.plan).slice(0, 40) : null,
    vendor_url: u.safeExternalUrl(body.vendor_url),
    amount_cents: Math.abs(amount),
    currency: body.currency || 'CNY',
    cycle, cycle_n: cycleN,
    anchor_month: anchorMonth, anchor_day: anchorDay,
    account_id: body.account_id ? Number(body.account_id) : null,
    category_id: body.category_id ? Number(body.category_id) : null,
    auto_renew: body.auto_renew ? 1 : 0,
    trial_ends_on: trialEnds,
    next_charge_at: next,
    reminder_days: Math.max(0, Math.min(60, Number(body.reminder_days ?? 3) || 0)),
    status,
    note: body.note ? String(body.note).slice(0, 200) : null,
    created_by_user_id: userId,
  };
}

/* ---------------------------------- 列表 ---------------------------------- */

router.get('/subscriptions', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const sums = subs.overview(ledgerId);
  res.render('subscriptions', {
    title: '订阅扣费', activeNav: 'subscriptions',
    sums, presets: PRESETS, today: todayStr(),
    form: fd.txFormData(ledgerId, req.session.userId),
    edit: null,
  });
});

/* --------------------------------- 编辑页 --------------------------------- */

router.get('/subscriptions/:id/edit', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const row = get('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (!row) { res.flash('error', '订阅不存在'); return res.redirect('/subscriptions'); }
  const sums = subs.overview(ledgerId);
  res.render('subscriptions', {
    title: '编辑订阅', activeNav: 'subscriptions',
    sums, presets: PRESETS, today: todayStr(),
    form: fd.txFormData(ledgerId, req.session.userId),
    edit: subs.decorate(row),
    history: subs.chargesOf(ledgerId, row.id),
  });
});

/* ---------------------------------- 新建 ---------------------------------- */

router.post('/subscriptions', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const d = readForm(req.body, req.session.userId);
  if (!d.name) { res.flash('error', '请填写订阅名称'); return res.redirect('/subscriptions'); }
  if (!d.amount_cents) { res.flash('error', '请填写每期扣费金额'); return res.redirect('/subscriptions'); }
  run(
    `INSERT INTO subscriptions (ledger_id, name, icon, plan, vendor_url, amount_cents, currency, cycle, cycle_n,
      anchor_month, anchor_day, account_id, category_id, auto_renew, trial_ends_on, next_charge_at,
      reminder_days, status, note, created_by_user_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ledgerId, d.name, d.icon, d.plan, d.vendor_url, d.amount_cents, d.currency, d.cycle, d.cycle_n,
    d.anchor_month, d.anchor_day, d.account_id, d.category_id, d.auto_renew, d.trial_ends_on, d.next_charge_at,
    d.reminder_days, d.status, d.note, d.created_by_user_id, nowStr()
  );
  auth.audit(req, 'subscription.create', { entity: 'subscription', ledgerId, detail: d.name });
  res.flash('success', `订阅「${d.name}」已添加，下次扣费 ${d.next_charge_at}` + (d.auto_renew ? '（到期自动记账）' : '（仅提醒，不自动记账）'));
  res.redirect('/subscriptions');
});

/* ---------------------------------- 更新 ---------------------------------- */

router.post('/subscriptions/:id', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const old = get('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!old) { res.flash('error', '订阅不存在'); return res.redirect('/subscriptions'); }
  const d = readForm(req.body, req.session.userId);
  if (!d.name || !d.amount_cents) { res.flash('error', '名称与金额不能为空'); return res.redirect(`/subscriptions/${id}/edit`); }
  // 已取消订阅不随表单复活：编辑页状态下拉没有「已取消」选项，保存时沿用原状态
  if (old.status === 'canceled') d.status = 'canceled';
  run(
    `UPDATE subscriptions SET name=?, icon=?, plan=?, vendor_url=?, amount_cents=?, currency=?, cycle=?, cycle_n=?,
      anchor_month=?, anchor_day=?, account_id=?, category_id=?, auto_renew=?, trial_ends_on=?, next_charge_at=?,
      reminder_days=?, status=?, note=? WHERE id=? AND ledger_id=?`,
    d.name, d.icon, d.plan, d.vendor_url, d.amount_cents, d.currency, d.cycle, d.cycle_n,
    d.anchor_month, d.anchor_day, d.account_id, d.category_id, d.auto_renew, d.trial_ends_on, d.next_charge_at,
    d.reminder_days, d.status, d.note, id, ledgerId
  );
  auth.audit(req, 'subscription.update', { entity: 'subscription', entityId: id, ledgerId, detail: d.name });
  res.flash('success', '订阅已更新');
  res.redirect('/subscriptions');
});

/* ------------------------------- 立即扣费一期 ------------------------------ */

router.post('/subscriptions/:id/charge', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const sub = get('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (!sub) { res.flash('error', '订阅不存在'); return res.redirect('/subscriptions'); }
  const txnId = subs.charge(sub, req.session.userId, { date: DAY_RE.test(String(req.body.date || '')) ? req.body.date : todayStr() });
  if (!txnId) { res.flash('error', '订阅金额为 0，无法记账'); return res.redirect('/subscriptions'); }
  // subs.charge 非 silent 内部已重算余额，这里不再重复
  auth.audit(req, 'subscription.charge', { entity: 'subscription', entityId: sub.id, ledgerId, detail: String(sub.amount_cents) });
  res.flash('success', `已记一笔订阅扣费 ${u.money(sub.amount_cents)}，下次扣费日已顺延`);
  res.redirect('/subscriptions');
});

/* -------------------------------- 跳过本期 --------------------------------- */

router.post('/subscriptions/:id/skip', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const sub = get('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (!sub) { res.flash('error', '订阅不存在'); return res.redirect('/subscriptions'); }
  const next = subs.advance(sub.next_charge_at, sub);
  run('UPDATE subscriptions SET next_charge_at = ? WHERE id = ?', next, sub.id);
  res.flash('success', `已跳过本期，下次扣费顺延至 ${next}`);
  res.redirect('/subscriptions');
});

/* ------------------------------ 暂停 / 恢复 -------------------------------- */

router.post('/subscriptions/:id/toggle', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const sub = get('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (!sub) { res.flash('error', '订阅不存在'); return res.redirect('/subscriptions'); }
  const back = sub.status === 'paused' || sub.status === 'canceled';
  run(
    'UPDATE subscriptions SET status = ?, canceled_at = ? WHERE id = ?',
    back ? 'active' : 'paused', back ? null : sub.canceled_at, sub.id
  );
  res.flash('success', back ? `「${sub.name}」已恢复订阅` : `「${sub.name}」已暂停，不再自动扣费`);
  res.redirect('/subscriptions');
});

/* --------------------------------- 取消订阅 -------------------------------- */

router.post('/subscriptions/:id/cancel', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const sub = get('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (!sub) { res.flash('error', '订阅不存在'); return res.redirect('/subscriptions'); }
  run("UPDATE subscriptions SET status = 'canceled', canceled_at = ? WHERE id = ?", nowStr(), sub.id);
  auth.audit(req, 'subscription.cancel', { entity: 'subscription', entityId: sub.id, ledgerId, detail: sub.name });
  res.flash('success', `「${sub.name}」已标记为取消，历史扣费记录保留`);
  res.redirect('/subscriptions');
});

/* ---------------------------------- 删除 ---------------------------------- */

router.post('/subscriptions/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const sub = get('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (!sub) { res.flash('error', '订阅不存在'); return res.redirect('/subscriptions'); }
  run('DELETE FROM subscriptions WHERE id = ? AND ledger_id = ?', sub.id, ledgerId);
  auth.audit(req, 'subscription.delete', { entity: 'subscription', entityId: sub.id, ledgerId, detail: sub.name });
  res.flash('success', '订阅已删除（已生成的流水不受影响）');
  res.redirect('/subscriptions');
});

module.exports = router;

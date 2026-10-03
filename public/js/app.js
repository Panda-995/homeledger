/* ============================================================
   家账簿 HomeLedger — 前端增强脚本
   仅做「渐进增强」：页面在无 JS 时依然完整可用
   ============================================================ */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const csrf = (document.querySelector('meta[name="csrf"]') || {}).content || '';
  const money = (cents) => '¥' + (Math.abs(Number(cents) || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ------------------------------ Toast ------------------------------ */
  function toast(message, type) {
    let box = $('#toast-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toast-box';
      box.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:200;display:flex;flex-direction:column;gap:8px;pointer-events:none';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'flash ' + (type || 'info');
    el.style.cssText = 'box-shadow:var(--shadow);margin:0;min-width:220px;max-width:90vw';
    el.innerHTML = '<span>' + esc(message) + '</span>';
    box.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, 3200);
  }
  window.hlToast = toast;

  /* ---------------------------- 图片读取 ---------------------------- */
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsDataURL(file);
    });
  }

  /* ------------------------ 自定义下拉框（桌面端） ------------------------ */
  /* 原生 select 保留在 DOM（隐藏）负责取值与提交；触发态由 .hl-select 渲染。
     触屏设备保持原生选择器（系统滚轮更好用），加 data-native 可强制跳过增强。 */
  function isTouch() {
    return window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  }

  function optionLabel(opt) {
    return (opt ? opt.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function enhanceSelect(sel) {
    if (sel.dataset.hlEnhanced || sel.multiple || sel.closest('.hl-select')) return;
    sel.dataset.hlEnhanced = '1';
    const wrap = document.createElement('span');
    wrap.className = 'hl-select';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('hidden');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hl-select-trigger';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.innerHTML =
      '<span class="hl-select-label"></span>' +
      '<span class="hl-select-caret"><svg class="icon sm"><use href="#i-chevron-down"></use></svg></span>';
    // 禁用下拉（如「成员」占位）保留可见但不可展开，避免留下空白缺口
    if (sel.disabled) { btn.disabled = true; wrap.classList.add('hl-disabled'); }
    wrap.appendChild(btn);
    const labelEl = $('.hl-select-label', btn);

    let open = false;
    // 菜单容器懒创建：未展开时不渲染空壳，避免页面残留空白胶囊
    let menu = null;
    function ensureMenu() {
      if (menu) return menu;
      menu = document.createElement('div');
      menu.className = 'hl-select-menu';
      menu.setAttribute('role', 'listbox');
      menu.addEventListener('keydown', onMenuKey);
      wrap.appendChild(menu);
      return menu;
    }

    function renderLabel() {
      const opt = sel.options[sel.selectedIndex];
      labelEl.textContent = optionLabel(opt);
      labelEl.classList.toggle('ph', !sel.value);
    }

    function buildMenu() {
      menu.innerHTML = '';
      let empty = true;
      const addOpt = (opt) => {
        if (!opt) return;
        empty = false;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hl-select-opt' + (opt.selected ? ' selected' : '');
        b.setAttribute('role', 'option');
        b.innerHTML = '<span>' + esc(optionLabel(opt)) + '</span>' +
          '<svg class="icon sm checkmark"><use href="#i-check"></use></svg>';
        b.addEventListener('click', () => {
          if (sel.value !== opt.value) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          toggle(false);
          btn.focus();
        });
        menu.appendChild(b);
      };
      Array.prototype.forEach.call(sel.children, (child) => {
        if (child.tagName === 'OPTGROUP') {
          const g = document.createElement('div');
          g.className = 'hl-select-group';
          g.textContent = child.label;
          menu.appendChild(g);
          Array.prototype.forEach.call(child.children, addOpt);
        } else if (child.tagName === 'OPTION') {
          addOpt(child);
        }
      });
      if (empty) menu.innerHTML = '<div class="hl-select-empty">暂无可选项</div>';
    }

    function place() {
      menu.classList.remove('up');
      const r = wrap.getBoundingClientRect();
      if (window.innerHeight - r.bottom < Math.min(320, menu.scrollHeight + 12) && r.top > menu.scrollHeight + 12) {
        menu.classList.add('up');
      }
    }

    function toggle(force) {
      const want = force === undefined ? !open : force;
      if (want === open || btn.disabled) return;
      open = want;
      if (open) {
        $$('body .hl-select.open').forEach((w) => { if (w !== wrap) w.classList.remove('open'); });
        ensureMenu();
        buildMenu();
        wrap.classList.add('open');
        place();
        const cur = $('.hl-select-opt.selected', menu) || $('.hl-select-opt', menu);
        if (cur) cur.focus();
      } else {
        wrap.classList.remove('open');
      }
    }

    function onMenuKey(e) {
      const opts = $$('.hl-select-opt', menu);
      const idx = opts.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); toggle(false); btn.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); const n = opts[idx + 1] || opts[0]; if (n) n.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); const n = opts[idx - 1] || opts[opts.length - 1]; if (n) n.focus(); }
      else if (e.key === 'Tab') { toggle(false); }
    }

    btn.addEventListener('click', () => toggle());
    btn.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); toggle(true); }
    });
    // 外部点击关闭 / 窗口缩放重定位：用单例委托（注册一次），避免每个实例往 document/window
    // 挂常驻监听——AI 页反复识别会不断新建实例，逐实例监听只增不减（内存泄漏）
    wrap._hlPlace = place;
    if (!document._hlSelectDelegated) {
      document._hlSelectDelegated = true;
      document.addEventListener('click', (e) => {
        $$('.hl-select.open').forEach((w) => { if (!w.contains(e.target)) w.classList.remove('open'); });
      });
      window.addEventListener('resize', () => {
        $$('.hl-select.open').forEach((w) => { if (w._hlPlace) w._hlPlace(); });
      });
    }
    sel.addEventListener('change', renderLabel);
    // 外部脚本改 innerHTML / value 后调用 sel._hlRefresh() 同步触发态
    sel._hlRefresh = () => { renderLabel(); if (open) buildMenu(); };

    renderLabel();
  }

  function enhanceSelects(root) {
    if (isTouch()) return;
    $$('select:not([data-native])', root || document).forEach(enhanceSelect);
  }
  window.hlEnhanceSelects = enhanceSelects;

  /* ------------------------------ 确认弹窗 ------------------------------ */
  function hlConfirm(message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      const danger = !!opts.danger;
      mask.innerHTML =
        '<div class="modal' + (danger ? ' danger' : '') + '" role="alertdialog" aria-modal="true">' +
          '<div class="modal-title"><svg class="icon"><use href="#' + (danger ? 'i-triangle-alert' : 'i-circle-alert') + '"></use></svg>' + esc(opts.title || (danger ? '危险操作' : '请确认')) + '</div>' +
          '<div class="modal-body">' + esc(message) + '</div>' +
          '<div class="modal-actions">' +
            '<button type="button" class="btn btn-ghost" data-act="cancel">' + esc(opts.cancelText || '取消') + '</button>' +
            '<button type="button" class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" data-act="ok">' + esc(opts.okText || '确定') + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(mask);
      const done = (val) => { mask.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      mask.addEventListener('click', (e) => {
        if (e.target === mask) return done(false);
        const act = e.target.closest && e.target.closest('[data-act]');
        if (act) done(act.dataset.act === 'ok');
      });
      document.addEventListener('keydown', onKey);
      ($('[data-act="' + (danger ? 'cancel' : 'ok') + '"]', mask) || {}).focus && $('[data-act="' + (danger ? 'cancel' : 'ok') + '"]', mask).focus();
    });
  }
  window.hlConfirm = hlConfirm;

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = { ok: false, error: '服务器返回异常（' + res.status + '）' }; }
    if (!res.ok && !data.error) data.error = '请求失败（' + res.status + '）';
    return data;
  }

  /* ============================ 记账表单 ============================ */
  function initTxnForm() {
    const form = $('#txn-form');
    if (!form) return;

    // 类型切换（保留已填内容）
    $$('.type-tabs [data-type]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const type = btn.dataset.type;
        $('#f-type').value = type;
        $$('.type-tabs [data-type]').forEach((b) => b.classList.toggle('active', b === btn));
        $$('[data-for-type]').forEach((el) => {
          const kinds = el.dataset.forType.split(',');
          el.classList.toggle('hidden', !kinds.includes(type));
        });
        $$('[data-not-type]').forEach((el) => {
          const kinds = el.dataset.notType.split(',');
          el.classList.toggle('hidden', kinds.includes(type));
        });
        if (type === 'transfer') $('#f-cat-wrap') && $('#f-cat-wrap').classList.add('hidden');
        else $('#f-cat-wrap') && $('#f-cat-wrap').classList.remove('hidden');
        // 分类区块按 data-cat-kind 切换（.cat-kind 是历史遗留的死选择器，已移除）
      });
    });

    // 分类选择
    $$('.cat-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        $('#f-category').value = item.dataset.id;
        $$('.cat-item').forEach((i) => i.classList.toggle('selected', i === item));
        const hint = $('#cat-hint');
        if (hint) hint.textContent = item.dataset.path || item.dataset.name || '';
      });
    });
    $$('.cat-parent').forEach((p) => {
      p.addEventListener('click', (e) => {
        e.preventDefault();
        const wrap = p.closest('.cat-group');
        $$('.cat-children', wrap).forEach((c) => c.classList.toggle('hidden'));
      });
    });

    // 分账行
    const splitWrap = $('#split-rows');
    const addSplit = $('#add-split');
    function bindSplitRow(row) {
      const del = $('.del-split', row);
      if (del) del.addEventListener('click', () => row.remove());
    }
    $$('.split-row', splitWrap).forEach(bindSplitRow);
    if (addSplit && splitWrap) {
      addSplit.addEventListener('click', (e) => {
        e.preventDefault();
        const row = document.createElement('div');
        row.className = 'row split-row mb8';
        row.innerHTML = '<input type="text" name="split_name" placeholder="成员" style="flex:1">' +
          '<input type="text" name="split_amount" placeholder="金额" inputmode="decimal" style="flex:1">' +
          '<button type="button" class="btn btn-sm btn-ghost del-split">✕</button>';
        splitWrap.appendChild(row);
        bindSplitRow(row);
      });
    }

    // 一键均摊
    const avgBtn = $('#split-average');
    if (avgBtn) {
      avgBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const total = Math.round(parseFloat(($('#f-amount') || {}).value || 0) * 100);
        const rows = $$('.split-row', splitWrap);
        if (!rows.length || !total) return toast('请先填写金额并添加成员', 'warn');
        const per = Math.floor(total / rows.length);
        let rest = total - per * rows.length;
        rows.forEach((r) => {
          const inp = $('input[name="split_amount"]', r);
          if (inp) { const v = per + (rest > 0 ? 1 : 0); if (rest > 0) rest--; inp.value = (v / 100).toFixed(2); }
        });
      });
    }

    // 金额输入：只允许数字
    const amt = $('#f-amount');
    if (amt) {
      amt.addEventListener('input', () => { amt.value = amt.value.replace(/[^\d.]/g, ''); });
      if (!amt.value) setTimeout(() => amt.focus(), 120);
    }

    // 提交防重复
    form.addEventListener('submit', () => {
      const btn = $('#submit-btn');
      if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    });
  }

  /* ============================ AI 截图记账 ============================ */
  function initAiPage() {
    const zone = $('#ai-dropzone');
    if (!zone) return;

    const input = $('#ai-file');
    const thumbs = $('#ai-thumbs');
    const state = { images: [] }; // {dataUrl, name}
    let lastScanIds = [];

    function renderThumbs() {
      thumbs.innerHTML = state.images.map((img, i) =>
        '<div class="thumb"><img src="' + img.dataUrl + '" alt=""><button type="button" data-i="' + i + '">✕</button></div>'
      ).join('');
      $$('button[data-i]', thumbs).forEach((b) => b.addEventListener('click', () => {
        state.images.splice(Number(b.dataset.i), 1);
        renderThumbs();
      }));
      const btn = $('#ai-scan-btn');
      if (btn) btn.disabled = state.images.length === 0 && !($('#ai-text') || {}).value.trim();
    }

    async function addFiles(files) {
      for (const f of Array.prototype.slice.call(files)) {
        if (!/^image\//.test(f.type)) { toast('只支持图片文件：' + f.name, 'warn'); continue; }
        if (f.size > 8 * 1024 * 1024) { toast('图片请小于 8MB：' + f.name, 'warn'); continue; }
        if (state.images.length >= 6) { toast('一次最多 6 张截图', 'warn'); break; }
        try { state.images.push({ dataUrl: await fileToDataUrl(f), name: f.name }); } catch (e) { toast(e.message, 'error'); }
      }
      renderThumbs();
    }

    zone.addEventListener('click', () => input && input.click());
    if (input) input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
    zone.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });

    // 支持直接 Ctrl+V 粘贴截图
    document.addEventListener('paste', (e) => {
      if (!e.clipboardData) return;
      const items = Array.prototype.slice.call(e.clipboardData.items || []);
      const files = items.filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
      if (files.length) { addFiles(files); toast('已粘贴 ' + files.length + ' 张截图'); }
    });

    const textEl = $('#ai-text');
    if (textEl) textEl.addEventListener('input', renderThumbs);

    const scanBtn = $('#ai-scan-btn');
    const resultBox = $('#ai-result');

    if (scanBtn) {
      scanBtn.addEventListener('click', async () => {
        const text = (textEl && textEl.value.trim()) || '';
        if (!state.images.length && !text) return toast('请上传截图或输入账单文字', 'warn');
        scanBtn.disabled = true;
        const oldLabel = scanBtn.textContent;
        scanBtn.textContent = '识别中…';
        resultBox.innerHTML = '<div class="card"><div class="row"><span class="muted">AI 正在识别账单，请稍候…</span></div></div>';
        try {
          const data = await postJson('/api/ai/scan', { images: state.images, text });
          if (!data.ok) throw new Error(data.error || '识别失败');
          lastScanIds = (data.images || []).map((i) => i.id);
          renderDrafts(data);
        } catch (e) {
          resultBox.innerHTML = '<div class="flash error">识别失败：' + esc(e.message) + '</div>';
        } finally {
          scanBtn.disabled = false;
          scanBtn.textContent = oldLabel;
        }
      });
    }

    function renderDrafts(data) {
      const engines = { llm: 'AI 视觉模型', rule: '内置规则引擎' };
      let html = '';
      html += '<div class="row between mb12"><h2>识别结果（' + data.items.length + ' 笔）</h2>' +
        '<span class="chip primary">' + esc(engines[data.engine] || data.engine) + (data.model ? ' · ' + esc(data.model) : '') + '</span></div>';
      (data.warnings || []).forEach((w) => { html += '<div class="flash warn">' + esc(w) + '</div>'; });
      if (!data.items.length) {
        html += '<div class="card"><div class="empty"><span class="big">🤔</span>没有识别出可记账的交易<br><span class="small">可以换个更清晰的截图，或直接手动输入账单文字</span></div></div>';
        resultBox.innerHTML = html;
        return;
      }
      html += '<form id="ai-confirm-form">';
      data.items.forEach((it, i) => {
        const conf = Number(it.confidence) || 0;
        const cls = conf >= 0.8 ? 'high' : conf >= 0.5 ? 'mid' : 'low';
        html += '<div class="draft" data-i="' + i + '">' +
          '<div class="draft-head">' +
            '<span class="chip ' + (it.type === 'income' ? 'income' : 'expense') + '">' + (it.type === 'income' ? '收入' : it.type === 'transfer' ? '转账' : '支出') + '</span>' +
            '<span class="chip">' + esc(it.category_path) + '</span>' +
            '<span class="confidence ' + cls + '">把握 ' + Math.round(conf * 100) + '%</span>' +
            '<span class="spacer"></span>' +
            '<button type="button" class="btn btn-sm btn-ghost draft-del">删除</button>' +
          '</div>' +
          '<div class="draft-grid">' +
            '<div class="field"><label>金额</label><input type="text" inputmode="decimal" class="d-amount" value="' + (it.amount_cents / 100).toFixed(2) + '"></div>' +
            '<div class="field"><label>日期</label><input type="date" class="d-date" value="' + esc(it.txn_date) + '"></div>' +
            '<div class="field d-type-wrap"><label>类型</label><select class="d-type">' +
              ['expense', 'income', 'transfer'].map((t) => '<option value="' + t + '"' + (t === it.type ? ' selected' : '') + '>' + ({ expense: '支出', income: '收入', transfer: '转账' }[t]) + '</option>').join('') +
            '</select></div>' +
            '<div class="field"><label>分类</label><select class="d-category"></select></div>' +
            '<div class="field"><label>账户</label><select class="d-account"></select></div>' +
            '<div class="field"><label>商家 / 备注</label><input type="text" class="d-note" value="' + esc((it.merchant || '') + (it.note && it.note !== it.merchant ? ' ' + it.note : '')) + '"></div>' +
          '</div>' +
        '</div>';
      });
      html += '<div class="row mt16"><button type="submit" class="btn btn-primary btn-lg" id="ai-save">确认并保存 ' + data.items.length + ' 笔</button>' +
        '<button type="button" class="btn btn-ghost" id="ai-clear">清空重来</button>' +
        '<span class="muted small" id="ai-save-hint"></span></div></form>';
      resultBox.innerHTML = html;

      // 填充下拉
      const cfg = window.__AI_FORM__ || { categories: [], accounts: [] };
      $$('.draft', resultBox).forEach((card) => {
        const it = data.items[Number(card.dataset.i)];
        const catSel = $('.d-category', card);
        const accSel = $('.d-account', card);
        const kind = it.type === 'income' ? 'income' : 'expense';
        catSel.innerHTML = '<option value="">未分类</option>' + cfg.categories
          .filter((c) => c.kind === kind)
          .map((c) => '<option value="' + c.id + '"' + (Number(c.id) === Number(it.category_id) ? ' selected' : '') + '>' + esc(c.path) + '</option>').join('');
        accSel.innerHTML = '<option value="">未指定</option>' + cfg.accounts
          .map((a) => '<option value="' + a.id + '"' + (Number(a.id) === Number(it.account_id) ? ' selected' : '') + '>' + esc(a.icon + ' ' + a.name) + '</option>').join('');
        // 切换类型时联动分类
        $('.d-type', card).addEventListener('change', (e) => {
          const k = e.target.value === 'income' ? 'income' : 'expense';
          catSel.innerHTML = '<option value="">未分类</option>' + cfg.categories.filter((c) => c.kind === k)
            .map((c) => '<option value="' + c.id + '">' + esc(c.path) + '</option>').join('');
          if (catSel._hlRefresh) catSel._hlRefresh();
        });
        $('.draft-del', card).addEventListener('click', () => card.remove());
      });
      if (window.hlEnhanceSelects) window.hlEnhanceSelects(resultBox);

      const clearBtn = $('#ai-clear');
      if (clearBtn) clearBtn.addEventListener('click', () => {
        resultBox.innerHTML = '';
        state.images = [];
        thumbs.innerHTML = '';
        if (textEl) textEl.value = '';
      });

      const confirmForm = $('#ai-confirm-form');
      confirmForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const items = $$('.draft', resultBox).map((card) => ({
          type: $('.d-type', card).value,
          amount_cents: Math.round(parseFloat($('.d-amount', card).value || '0') * 100),
          txn_date: $('.d-date', card).value,
          category_id: $('.d-category', card).value || null,
          account_id: $('.d-account', card).value || null,
          note: $('.d-note', card).value,
          merchant: $('.d-note', card).value,
        })).filter((it) => it.amount_cents > 0);
        if (!items.length) return toast('请至少保留一笔有效金额', 'warn');
        const saveBtn = $('#ai-save');
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
        const res = await postJson('/api/ai/confirm', { items, image_ids: lastScanIds, source: 'ai_screenshot' });
        if (res.ok) {
          toast('已保存 ' + res.created + ' 笔' + (res.errors && res.errors.length ? '，' + res.errors.length + ' 笔失败' : ''), 'success');
          if (res.errors && res.errors.length) $('#ai-save-hint').textContent = res.errors.join('；');
          setTimeout(() => { window.location.href = '/transactions'; }, 800);
        } else {
          toast('保存失败：' + (res.error || (res.errors || []).join('；')), 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = '确认并保存';
        }
      });
    }

    // 文本快速记账
    const quickBtn = $('#ai-text-quick');
    if (quickBtn) {
      quickBtn.addEventListener('click', async () => {
        const text = ($('#ai-quick-text') || {}).value || '';
        if (!text.trim()) return toast('请输入内容', 'warn');
        quickBtn.disabled = true;
        const res = await postJson('/api/ai/text', { text });
        quickBtn.disabled = false;
        if (!res.ok) return toast('识别失败：' + res.error, 'error');
        resultBox.innerHTML = '';
        (res.warnings || []).forEach((w) => toast(w, 'warn'));
        if (!res.items.length) return toast('没能识别出金额，请换个说法，例如「午饭 35 元 支付宝」', 'warn');
        const single = res.items[0];
        const url = '/transactions/new?type=' + encodeURIComponent(single.type) +
          '&amount=' + encodeURIComponent((single.amount_cents / 100).toFixed(2)) +
          '&date=' + encodeURIComponent(single.txn_date) +
          (single.category_id ? '&category_id=' + single.category_id : '') +
          (single.account_id ? '&account_id=' + single.account_id : '') +
          '&note=' + encodeURIComponent(single.note || single.merchant || '') + '&from_ai=1';
        if (res.items.length === 1) { window.location.href = url; return; }
        // 多笔：走草稿确认
        lastScanIds = [];
        renderDrafts({ items: res.items, engine: res.engine, warnings: res.warnings || [] });
      });
    }

    renderThumbs();
  }

  /* ============================ 账单导入 ============================ */
  function initImportPage() {
    const zone = $('#import-dropzone');
    if (!zone) return;
    const input = $('#import-file');
    const preview = $('#import-preview');
    const state = { token: null };

    async function handle(file) {
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) return toast('文件请小于 20MB', 'warn');
      preview.innerHTML = '<div class="card"><span class="muted">正在解析账单文件…</span></div>';
      try {
        const dataUrl = await fileToDataUrl(file);
        const res = await postJson('/api/import/preview', { dataUrl, fileName: file.name });
        if (!res.ok) throw new Error(res.error);
        state.token = res.token;
        renderPreview(res, file.name);
      } catch (e) {
        preview.innerHTML = '<div class="flash error">解析失败：' + esc(e.message) + '</div>';
      }
    }

    function renderPreview(res, fileName) {
      let html = '<div class="card">';
      html += '<div class="card-head"><h2>解析结果</h2><span class="chip primary">' + esc(res.sourceLabel) + '</span>' +
        '<span class="chip">编码 ' + esc(res.encoding) + '</span><span class="chip">共 ' + res.count + ' 条</span></div>';
      html += '<div class="grid grid-4 mb16">' +
        '<div class="stat"><div class="label">支出合计</div><div class="value amount expense">' + money(res.stat.expense) + '</div></div>' +
        '<div class="stat"><div class="label">收入合计</div><div class="value amount income">' + money(res.stat.income) + '</div></div>' +
        '<div class="stat"><div class="label">转账合计</div><div class="value amount neutral">' + money(res.stat.transfer) + '</div></div>' +
        '<div class="stat"><div class="label">时间范围</div><div class="value tiny" style="font-size:13px">' + esc(res.stat.minDate || '—') + '<br>' + esc(res.stat.maxDate || '—') + '</div></div>' +
      '</div>';
      if (res.skipped) html += '<div class="notice mb12">已自动跳过 ' + res.skipped + ' 条（交易关闭 / 已退款 / 失败）不参与导入的记录。</div>';
      html += '<div class="row mb12"><label class="check"><input type="checkbox" id="imp-auto-acc" checked> 自动创建缺失的支付账户</label>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-primary" id="imp-commit">确认导入 ' + res.count + ' 条</button></div>';
      html += '</div>';

      if (res.neutralCount) {
        html += '<div class="card">';
        html += '<div class="card-head"><h2>「不计收支」记录</h2><span class="chip">' + res.neutralCount + ' 条</span></div>';
        html += '<div class="notice mb12">提现、充值、零钱通转出等记录属于<b>账户之间搬钱</b>，导入后会记成转账、不计入收支统计。' +
          '默认不导入，若你的账户余额需要与账单对齐，可勾选下方选项一并导入。</div>';
        html += '<div class="row mb12"><label class="check"><input type="checkbox" id="imp-include-neutral"> 一并导入这 ' + res.neutralCount + ' 条「不计收支」记录（记作账户间转账）</label></div>';
        html += '<div class="scroll-x"><table class="table responsive"><thead><tr><th>日期</th><th class="num">金额</th><th>说明</th><th>账户</th></tr></thead><tbody>';
        res.neutralSample.forEach((r) => {
          html += '<tr><td class="nowrap">' + esc(r.txn_date) + '</td>' +
            '<td class="num amount neutral">' + money(r.amount_cents) + '</td>' +
            '<td>' + esc(r.merchant || r.note || '—') + '</td>' +
            '<td class="small muted">' + esc(r.guess_account || '—') + '</td></tr>';
        });
        html += '</tbody></table></div>';
        if (res.neutralCount > res.neutralSample.length) {
          html += '<p class="small muted mt8">仅预览前 ' + res.neutralSample.length + ' 条，导入时会包含全部 ' + res.neutralCount + ' 条。</p>';
        }
        html += '</div>';
      }

      html += '<div class="card">';
      html += '<div class="card-head"><h2>将导入的明细</h2></div>';
      html += '<div class="scroll-x"><table class="table responsive"><thead><tr><th>日期</th><th>类型</th><th class="num">金额</th><th>商家/说明</th><th>建议分类</th><th>账户</th></tr></thead><tbody>';
      res.sample.slice(0, 60).forEach((r) => {
        html += '<tr><td class="nowrap">' + esc(r.txn_date) + '</td>' +
          '<td><span class="chip ' + (r.type === 'income' ? 'income' : r.type === 'transfer' ? '' : 'expense') + '">' + esc(r.type_label) + '</span></td>' +
          '<td class="num amount ' + (r.type === 'income' ? 'income' : 'expense') + '">' + money(r.amount_cents) + '</td>' +
          '<td>' + esc(r.merchant || r.note || '—') + '</td>' +
          '<td class="small muted">' + esc(r.guess_category || '—') + '</td>' +
          '<td class="small muted">' + esc(r.guess_account || '—') + '</td></tr>';
      });
      html += '</tbody></table></div>';
      if (res.count > 60) html += '<p class="small muted mt8">仅预览前 60 条，导入时会包含全部 ' + res.count + ' 条。</p>';
      html += '</div>';
      preview.innerHTML = html;

      const neutralBox = $('#imp-include-neutral');
      if (neutralBox) {
        neutralBox.addEventListener('change', () => {
          const btn = $('#imp-commit');
          if (btn) btn.textContent = '确认导入 ' + (res.count + (neutralBox.checked ? res.neutralCount : 0)) + ' 条';
        });
      }

      $('#imp-commit').addEventListener('click', async () => {
        const btn = $('#imp-commit');
        btn.disabled = true; btn.textContent = '导入中…';
        const r = await postJson('/api/import/commit', {
          token: state.token,
          auto_create_account: $('#imp-auto-acc').checked,
          include_neutral: !!($('#imp-include-neutral') && $('#imp-include-neutral').checked),
        });
        if (r.ok) {
          toast('成功导入 ' + r.imported + ' 条，跳过重复 ' + r.skipped + ' 条', 'success');
          setTimeout(() => { window.location.href = '/transactions'; }, 900);
        } else {
          toast('导入失败：' + r.error, 'error');
          btn.disabled = false; btn.textContent = '重试导入';
        }
      });
    }

    zone.addEventListener('click', () => input && input.click());
    if (input) input.addEventListener('change', () => { handle(input.files[0]); input.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
    zone.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); });
  }

  /* ============================ AI 设置测试 ============================ */
  function initSettings() {
    const testBtn = $('#ai-test-btn');
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const out = $('#ai-test-result');
        testBtn.disabled = true;
        out.textContent = '正在测试连接…';
        out.className = 'notice info mt8';
        const res = await postJson('/api/ai/test', {
          base_url: ($('#ai-base-url') || {}).value,
          model: ($('#ai-model') || {}).value,
          api_key: ($('#ai-api-key') || {}).value,
        });
        testBtn.disabled = false;
        if (res.ok) { out.className = 'notice mt8'; out.textContent = '✅ 连接成功：' + (res.raw || ''); }
        else { out.className = 'notice warn mt8'; out.textContent = '❌ 连接失败：' + res.error; }
      });
    }

    /* 获取可用模型：读 /models → 下拉选择 → 联动「模型支持图片（视觉）」勾选 */
    const modelsBtn = $('#ai-models-btn');
    if (modelsBtn) {
      const sel = $('#ai-model-select');
      const modelInput = $('#ai-model');
      const out = $('#ai-models-result');
      const visionBox = $('input[name="ai.vision"]');

      modelsBtn.addEventListener('click', async () => {
        modelsBtn.disabled = true;
        out.className = 'notice info mt8';
        out.textContent = '正在读取该接口的模型列表…';
        const res = await postJson('/api/ai/models', {
          base_url: ($('#ai-base-url') || {}).value,
          api_key: ($('#ai-api-key') || {}).value,
        });
        modelsBtn.disabled = false;
        if (!res.ok) { out.className = 'notice warn mt8'; out.textContent = '❌ ' + res.error; return; }
        if (!res.models || !res.models.length) {
          out.className = 'notice warn mt8';
          out.textContent = '该接口没有返回任何模型，请手动填写模型名';
          return;
        }
        sel.textContent = '';
        const ph = document.createElement('option');
        ph.value = '';
        ph.textContent = '— 选择模型（共 ' + res.models.length + ' 个）—';
        sel.appendChild(ph);
        res.models.forEach((m) => {
          const o = document.createElement('option');
          o.value = m.id;
          o.textContent = m.id + (m.vision === true ? '  ✅ 可读图' : (m.vision === false ? '  （非对话模型）' : ''));
          if (m.vision === true) o.dataset.vision = '1';
          else if (m.vision === false) o.dataset.vision = '0';
          sel.appendChild(o);
        });
        sel.classList.remove('hidden');
        if (modelInput.value && res.models.some((m) => m.id === modelInput.value)) sel.value = modelInput.value;
        if (sel._hlRefresh) sel._hlRefresh(); // 动态填充后同步 hl-select 触发器标签
        out.className = 'notice mt8';
        out.textContent = '✅ 读到 ' + res.models.length + ' 个模型，请在下拉框中选择要用的那个';
      });

      sel.addEventListener('change', () => {
        const opt = sel.options[sel.selectedIndex];
        if (!opt || !opt.value) return;
        modelInput.value = opt.value;
        const v = opt.dataset.vision;
        let note = '（无法自动判断是否支持图片，请按模型说明勾选）';
        if (visionBox) {
          if (v === '1') { visionBox.checked = true; note = '（疑似支持图片，已自动勾选视觉）'; }
          else if (v === '0') { visionBox.checked = false; note = '（非对话/视觉模型，已取消视觉勾选）'; }
        }
        out.className = 'notice mt8';
        out.textContent = '已填入模型：' + opt.value + note + '。别忘了点「保存配置」生效。';
      });
    }
    // 恢复备份
    const restoreInput = $('#restore-file');
    if (restoreInput) {
      restoreInput.addEventListener('change', async () => {
        const f = restoreInput.files[0];
        if (!f) return;
        const okGo = await hlConfirm('确定要用该备份覆盖当前数据吗？\n当前数据会自动先备份一份，但仍建议你手动下载一份当前数据。', { danger: true, okText: '覆盖恢复', title: '恢复备份' });
        if (!okGo) { restoreInput.value = ''; return; }
        const dataUrl = await fileToDataUrl(f);
        const res = await postJson('/backup/restore', { dataUrl });
        toast(res.ok ? '已接收，请按提示完成恢复' : '失败：' + res.error, res.ok ? 'success' : 'error');
        restoreInput.value = '';
        setTimeout(() => window.location.reload(), 1500);
      });
    }
  }

  /* ============================ 批量选择 ============================ */
  // 单笔删除后也要刷新批量条状态，通过闭包里的 refreshBulk 互通
  let refreshBulk = null;
  function initBulk() {
    const master = $('#bulk-all');
    const boxes = $$('.bulk-item');
    if (!master || !boxes.length) return;
    const bar = $('#bulk-bar');
    master.addEventListener('change', () => {
      boxes.forEach((b) => { b.checked = master.checked; });
      update();
    });
    // 「全选本日」：勾选该日期组内的全部交易
    $$('.bulk-all-day').forEach((dayBox) => {
      dayBox.addEventListener('change', () => {
        const day = dayBox.closest('.txn-day');
        if (!day) return;
        $$('.bulk-item', day).forEach((b) => { b.checked = dayBox.checked; });
        update();
      });
    });
    boxes.forEach((b) => b.addEventListener('change', update));
    function update() {
      const liveBoxes = $$('.bulk-item'); // 行可能被单笔删除移除，实时收集
      const n = liveBoxes.filter((b) => b.checked).length;
      if (bar) {
        bar.classList.toggle('hidden', n === 0);
        const cnt = $('#bulk-count');
        if (cnt) cnt.textContent = n;
      }
      master.indeterminate = n > 0 && n < liveBoxes.length;
      master.checked = n === liveBoxes.length && n > 0;
    }
    refreshBulk = update;
  }

  /* ============================ 确认危险操作 ============================ */
  function initConfirm() {
    $$('form[data-confirm]').forEach((f) => {
      f.addEventListener('submit', (e) => {
        if (f._confirmPass) { f._confirmPass = false; return; }
        e.preventDefault();
        const msg = f.dataset.confirm || '确定执行该操作？';
        const danger = /删除|清空|吊销|重置|⚠️|覆盖/.test(msg);
        hlConfirm(msg, { danger }).then((ok) => {
          if (!ok) return;
          f._confirmPass = true;
          if (e.submitter) f.requestSubmit(e.submitter); else f.requestSubmit();
        });
      });
    });
  }

  /* ============================ 图片灯箱 ============================ */
  function initLightbox() {
    const imgs = $$('[data-zoom]');
    if (!imgs.length) return;
    imgs.forEach((img) => img.addEventListener('click', () => {
      const mask = document.createElement('div');
      mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:300;display:grid;place-items:center;cursor:zoom-out;padding:20px';
      const big = document.createElement('img');
      big.src = img.dataset.zoom || img.src;
      big.style.cssText = 'max-width:96vw;max-height:92vh;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.5)';
      mask.appendChild(big);
      mask.addEventListener('click', () => mask.remove());
      document.body.appendChild(mask);
    }));
  }

  /* ============================ 列表页快捷操作 ============================ */
  function initListActions() {
    $$('[data-del-txn]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!(await hlConfirm('删除这笔记录？', { danger: true, okText: '删除' }))) return;
        const res = await postJson('/transactions/' + btn.dataset.delTxn + '/delete', { _json: '1' });
        if (res.ok) {
          const row = btn.closest('.txn');
          if (row) row.remove();
          if (refreshBulk) refreshBulk();
          toast('已删除', 'success');
        } else toast('删除失败', 'error');
      });
    });
  }

  /* ============================ 数字输入美化 ============================ */
  function initNumberInputs() {
    $$('input[inputmode="decimal"]').forEach((inp) => {
      inp.addEventListener('blur', () => {
        const v = parseFloat(inp.value);
        if (!isNaN(v) && inp.dataset.fixed !== '0') inp.value = v.toFixed(2);
      });
    });
  }

  /* ============================ 侧栏滚动记忆 ============================ */
  function initSidebar() {
    const sb = document.querySelector('.sidebar');
    if (!sb) return;
    const KEY = 'hl-sidebar-scroll';
    // 跳转后恢复上次的内部滚动位置，菜单不会"跳回开头"
    const saved = sessionStorage.getItem(KEY);
    if (saved) sb.scrollTop = Number(saved) || 0;
    sb.addEventListener('scroll', () => {
      try { sessionStorage.setItem(KEY, String(sb.scrollTop)); } catch (e) { /* 隐私模式下忽略 */ }
    }, { passive: true });
    // 保证当前高亮项在可视范围内
    const active = sb.querySelector('.nav-item.active');
    if (active) {
      const r = active.getBoundingClientRect();
      const sr = sb.getBoundingClientRect();
      if (r.top < sr.top + 8) sb.scrollTop += r.top - sr.top - 8;
      else if (r.bottom > sr.bottom - 8) sb.scrollTop += r.bottom - sr.bottom + 8;
    }
  }

  /* ============================ 顶栏用户菜单 ============================ */
  function initUserMenu() {
    const btn = $('#userMenuBtn');
    const drop = $('#userMenuDrop');
    if (!btn || !drop) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      drop.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!drop.classList.contains('hidden') && !drop.contains(e.target)) drop.classList.add('hidden');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') drop.classList.add('hidden');
    });
  }

  /* ============================ 头像上传 ============================ */
  /** 通用头像选择绑定：pickEl 点击弹文件框，fileEl 选中后上传。任何页面都可调用 */
  function bindAvatarPicker(pickEl, fileEl) {
    if (!pickEl || !fileEl) return;
    pickEl.addEventListener('click', (e) => {
      e.stopPropagation(); // 头像在用户菜单按钮内：只开文件框，不展开下拉
      fileEl.click();
    });
    fileEl.addEventListener('change', async () => {
      const f = fileEl.files[0];
      fileEl.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type)) return toast('请选择图片文件', 'warn');
      if (f.size > 2 * 1024 * 1024) return toast('头像请小于 2MB', 'warn');
      try {
        const dataUrl = await fileToDataUrl(f);
        const res = await postJson('/settings/avatar', { dataUrl });
        if (!res.ok) return toast(res.error || '上传失败', 'error');
        toast('头像已更新', 'success');
        setTimeout(() => window.location.reload(), 600);
      } catch (e) {
        toast('上传失败：' + e.message, 'error');
      }
    });
  }

  function initAvatarUpload() {
    // 设置页的「换头像」按钮
    bindAvatarPicker($('#avatarPick'), $('#avatarFile'));
    // 顶栏：点击头像或下拉里的「更换头像」，全站任何页面都可直接换
    bindAvatarPicker($('#userMenuAvatar'), $('#userAvatarFile'));
    const clearBtn = $('#avatarClear');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (!confirm('恢复为默认头像（首字母色块）？')) return;
        const res = await postJson('/settings/avatar/clear', {});
        if (!res.ok) return toast(res.error || '操作失败', 'error');
        toast('已恢复默认头像', 'success');
        setTimeout(() => window.location.reload(), 600);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initSidebar();
    initUserMenu();
    initAvatarUpload();
    initTxnForm();
    initAiPage();
    initImportPage();
    initSettings();
    initBulk();
    initConfirm();
    initLightbox();
    initListActions();
    initNumberInputs();
    enhanceSelects();
    // 记一笔/编辑页本身就是记账界面，AI 悬浮球会遮挡底部按钮，不出现
    if ($('#txn-form')) { const f = $('#aiFab'); if (f) f.remove(); }
  });
})();

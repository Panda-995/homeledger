/* ============================================================
   家账簿 · AI 记账助手（全局浮动面板）
   依赖 layout.ejs 注入的 #aiFab / #aiPanel 结构与 meta[name=csrf]
   ============================================================ */
'use strict';
(function () {
  const fab = document.getElementById('aiFab');
  const panel = document.getElementById('aiPanel');
  if (!fab || !panel) return;

  const $ = (id) => document.getElementById(id);
  const msgs = $('aiMsgs');
  const textEl = $('aiText');
  const sendBtn = $('aiSend');
  const attachBtn = $('aiAttach');
  const fileEl = $('aiFile');
  const thumbsEl = $('aiThumbs');
  const csrf = (document.querySelector('meta[name="csrf"]') || {}).content || '';

  const pendingImages = []; // { dataUrl, name }
  let busy = false;

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  /* ------------------------------ 开合 ------------------------------ */
  function open() {
    panel.classList.remove('hidden');
    fab.classList.add('hidden');
    msgs.scrollTop = msgs.scrollHeight;
    textEl.focus();
  }
  function close() {
    panel.classList.add('hidden');
    fab.classList.remove('hidden');
  }
  fab.addEventListener('click', open);
  // 桌面端顶栏入口（悬浮球仅移动端显示）
  const topBtn = document.getElementById('aiTopBtn');
  if (topBtn) topBtn.addEventListener('click', open);
  $('aiClose').addEventListener('click', close);
  $('aiClear').addEventListener('click', () => {
    while (msgs.children.length > 1) msgs.removeChild(msgs.lastChild);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.classList.contains('hidden')) close();
  });

  /* --------------------------- 输入与附件 --------------------------- */
  textEl.addEventListener('input', () => {
    textEl.style.height = 'auto';
    textEl.style.height = Math.min(textEl.scrollHeight, 110) + 'px';
  });
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener('click', send);
  attachBtn.addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', async () => {
    for (const f of Array.from(fileEl.files || [])) {
      if (pendingImages.length >= 6) break;
      const dataUrl = await readImage(f);
      if (dataUrl) pendingImages.push({ dataUrl, name: f.name });
    }
    fileEl.value = '';
    renderThumbs();
  });

  function readImage(file) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => resolve('');
      fr.readAsDataURL(file);
    });
  }

  function renderThumbs() {
    thumbsEl.innerHTML = '';
    thumbsEl.classList.toggle('hidden', !pendingImages.length);
    pendingImages.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 't';
      const img = document.createElement('img');
      img.src = p.dataUrl;
      img.alt = '';
      d.appendChild(img);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '✕';
      b.title = '移除';
      b.addEventListener('click', () => { pendingImages.splice(i, 1); renderThumbs(); });
      d.appendChild(b);
      thumbsEl.appendChild(d);
    });
  }

  /* ------------------------------ 气泡 ------------------------------ */
  function addBubble(cls, html) {
    const d = document.createElement('div');
    d.className = 'ai-bubble ' + cls;
    d.innerHTML = html;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  function showTyping() {
    const d = document.createElement('div');
    d.className = 'ai-bubble bot';
    d.id = 'aiTyping';
    d.innerHTML = '<span class="ai-typing"><i></i><i></i><i></i></span>';
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }
  function hideTyping() {
    const t = document.getElementById('aiTyping');
    if (t) t.remove();
  }

  function fmtCents(c) {
    return '¥' + (Number(c || 0) / 100).toFixed(2);
  }

  function resultHtml(data) {
    let h = '';
    if (Array.isArray(data.items) && data.items.length) {
      h += '<div>';
      for (const it of data.items) {
        const income = it.type === 'income';
        const title = it.merchant || it.note || (income ? '一笔收入' : '一笔支出');
        const sub = [it.category_path || '未分类', it.account_name_resolved, it.txn_date]
          .filter(Boolean).map(esc).join(' · ');
        h += '<div class="ai-record">'
          + `<span class="ico">${income ? '💰' : '💸'}</span>`
          + `<div class="m"><b>${esc(title)}</b><span>${sub}</span></div>`
          + `<span class="amt ${income ? 'income' : 'expense'}">${income ? '+' : '−'}${fmtCents(it.amount_cents)}</span>`
          + '</div>';
      }
      h += '</div>';
      const tag = data.engine === 'llm' ? (data.model ? `模型 ${data.model}` : 'AI 识别') : '规则解析';
      h += `<div class="ai-meta"><span>已记 ${data.created} 笔</span><span>·</span><span>${esc(tag)}</span><span>·</span><a href="/transactions">查看明细 →</a></div>`;
    }
    if (data.errors && data.errors.length) {
      h += `<div class="ai-warn">⚠ ${esc(data.errors.join('；'))}</div>`;
    }
    if (data.warnings && data.warnings.length) {
      h += `<div class="ai-warn">⚠ ${esc(data.warnings.join('；'))}</div>`;
    }
    return h;
  }

  /* ------------------------------ 发送 ------------------------------ */
  async function send() {
    if (busy) return;
    const text = textEl.value.trim();
    if (!text && !pendingImages.length) return;
    busy = true;
    sendBtn.disabled = true;

    let userHtml = esc(text || '(发来一张截图)');
    for (const p of pendingImages) userHtml += `<img src="${p.dataUrl}" alt="">`;
    addBubble('user', userHtml);

    textEl.value = '';
    textEl.style.height = 'auto';
    const images = pendingImages.splice(0);
    renderThumbs();
    showTyping();

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' },
        body: JSON.stringify({ text, images }),
      });
      const data = await res.json().catch(() => ({}));
      hideTyping();
      if (!res.ok || !data.ok) {
        const msg = data.error || (data.errors && data.errors.join('；')) || '识别失败，请稍后重试';
        const isCfg = data.code === 'not_configured' || /尚未配置|未配置/.test(msg);
        addBubble('bot error', esc(msg) + (isCfg ? ' <a href="/settings">去配置 →</a>' : ''));
      } else if (!data.items || !data.items.length) {
        addBubble('bot', '没有识别到可记账的内容 🤔 试试像这样描述：<em>午饭 35 元</em>、<em>昨天加油 300</em>，或发一张账单截图。');
      } else {
        addBubble('bot', resultHtml(data));
      }
    } catch (e) {
      hideTyping();
      addBubble('bot error', '网络异常：' + esc(e.message));
    } finally {
      busy = false;
      sendBtn.disabled = false;
      msgs.scrollTop = msgs.scrollHeight;
    }
  }
})();

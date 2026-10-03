'use strict';
/**
 * 服务端 SVG 图表引擎
 * 全部图表在服务端渲染成内联 SVG：无需前端图表库、无外网依赖、NAS 离线可用
 */
const { esc, fmtAmount, monthShort, relDate, safeColor } = require('./util');

/** 渲染前统一过颜色白名单：调用方漏校验也不会变成 SVG/HTML 属性注入 */
const col = (v, fallback) => safeColor(v, fallback || '#8c8c8c');

const C = {
  grid: '#eceff4',
  axis: '#98a2b3',
  text: '#667085',
  textStrong: '#1f2937',
  income: '#52c41a',
  expense: '#f5222d',
  primary: '#4f7cff',
};

function nf(n, d = 2) {
  return Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 取一个好看的 Y 轴上界 */
function niceMax(v) {
  if (v <= 0) return 100;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const m = v / base;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return step * base;
}

/* ------------------------------ 柱状图（收支趋势） ----------------------------- */

/**
 * @param {object} o
 * @param {string[]} o.labels   横轴标签
 * @param {Array<{name:string,color:string,data:number[],dashed?:boolean}>} o.series 数据（单位为元）
 */
function barChart({ labels = [], series = [], height = 240, showLegend = true, valueUnit = '' } = {}) {
  const W = 720, H = height;
  const padL = 52, padR = 16, padT = showLegend ? 34 : 16, padB = 30;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const allVals = series.flatMap((s) => s.data.map((v) => Math.abs(Number(v) || 0)));
  const max = niceMax(Math.max(...allVals, 0));
  const n = Math.max(labels.length, 1);
  const groupW = innerW / n;
  const barW = Math.min(18, (groupW * 0.62) / Math.max(series.length, 1));
  const gap = 4;

  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" role="img" style="display:block">`;
  // 网格线 + Y 轴刻度
  for (let i = 0; i <= 4; i++) {
    const y = padT + (innerH * i) / 4;
    const val = max - (max * i) / 4;
    s += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`;
    s += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" font-size="11" fill="${C.axis}" text-anchor="end">${nf(val, val >= 1000 ? 0 : 0)}</text>`;
  }
  // 柱子
  labels.forEach((lab, i) => {
    const cx = padL + groupW * i + groupW / 2;
    const totalW = series.length * barW + (series.length - 1) * gap;
    let x0 = cx - totalW / 2;
    series.forEach((se) => {
      const v = Math.abs(Number(se.data[i]) || 0);
      const h = max > 0 ? (v / max) * innerH : 0;
      const y = padT + innerH - h;
      if (h > 0.5) {
        s += `<rect x="${x0.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${col(se.color)}"><title>${esc(se.name)} ${esc(lab)}：${nf(v)}${esc(valueUnit)}</title></rect>`;
      } else {
        s += `<rect x="${x0.toFixed(1)}" y="${(padT + innerH - 1.5).toFixed(1)}" width="${barW.toFixed(1)}" height="1.5" rx="0.75" fill="${col(se.color)}" opacity="0.25"/>`;
      }
      x0 += barW + gap;
    });
    s += `<text x="${cx.toFixed(1)}" y="${H - 10}" font-size="11" fill="${C.axis}" text-anchor="middle">${esc(lab)}</text>`;
  });
  // 图例
  if (showLegend) {
    let lx = padL;
    series.forEach((se) => {
      s += `<rect x="${lx}" y="10" width="10" height="10" rx="2" fill="${col(se.color)}"/>`;
      s += `<text x="${lx + 15}" y="19" font-size="12" fill="${C.text}">${esc(se.name)}</text>`;
      lx += 15 + se.name.length * 12 + 22;
    });
  }
  s += `</svg>`;
  return s;
}

/* ------------------------------ 折线图（余额/走势） ---------------------------- */

function lineChart({ labels = [], series = [], height = 220, fill = true, valueUnit = '' } = {}) {
  const W = 720, H = height;
  const padL = 58, padR = 16, padT = 32, padB = 30;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const allVals = series.flatMap((s) => s.data.map((v) => Number(v) || 0));
  const rawMax = Math.max(...allVals, 0);
  const rawMin = Math.min(...allVals, 0);
  const max = niceMax(rawMax);
  const min = rawMin < 0 ? -niceMax(Math.abs(rawMin)) : 0;
  const span = max - min || 1;
  const n = labels.length;
  const xAt = (i) => padL + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const yAt = (v) => padT + innerH - ((Number(v || 0) - min) / span) * innerH;

  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" role="img" style="display:block">`;
  s += `<defs>`;
  series.forEach((se, si) => {
    s += `<linearGradient id="lg${si}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${col(se.color)}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${col(se.color)}" stop-opacity="0.02"/></linearGradient>`;
  });
  s += `</defs>`;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (innerH * i) / 4;
    const val = max - (span * i) / 4;
    s += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="${C.grid}"/>`;
    s += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" font-size="11" fill="${C.axis}" text-anchor="end">${nf(val, 0)}</text>`;
  }
  series.forEach((se, si) => {
    const pts = se.data.map((v, i) => [xAt(i), yAt(v)]);
    if (!pts.length) return;
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    if (fill) {
      s += `<path d="${d} L${pts[pts.length - 1][0].toFixed(1)},${(padT + innerH).toFixed(1)} L${pts[0][0].toFixed(1)},${(padT + innerH).toFixed(1)} Z" fill="url(#lg${si})"/>`;
    }
    s += `<path d="${d}" fill="none" stroke="${col(se.color)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    pts.forEach((p, i) => {
      s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.8" fill="#fff" stroke="${col(se.color)}" stroke-width="2"><title>${esc(se.name)} ${esc(labels[i])}：${nf(se.data[i])}${esc(valueUnit)}</title></circle>`;
    });
  });
  labels.forEach((lab, i) => {
    if (n > 14 && i % 2 !== 0 && i !== n - 1) return;
    s += `<text x="${xAt(i).toFixed(1)}" y="${H - 10}" font-size="11" fill="${C.axis}" text-anchor="middle">${esc(lab)}</text>`;
  });
  let lx = padL;
  series.forEach((se) => {
    s += `<line x1="${lx}" y1="14" x2="${lx + 14}" y2="14" stroke="${col(se.color)}" stroke-width="2.5" stroke-linecap="round"/>`;
    s += `<text x="${lx + 19}" y="18" font-size="12" fill="${C.text}">${esc(se.name)}</text>`;
    lx += 19 + se.name.length * 12 + 20;
  });
  s += `</svg>`;
  return s;
}

/* ------------------------------ 环形图（分类占比） ---------------------------- */

function donutChart(items = [], { size = 200, thickness = 26, centerTitle = '', centerValue = '', valueUnit = '' } = {}) {
  const total = items.reduce((a, b) => a + Math.abs(Number(b.value) || 0), 0);
  const r = size / 2 - thickness / 2 - 2;
  const cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  let s = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" style="display:block">`;
  if (total <= 0) {
    s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.grid}" stroke-width="${thickness}"/>`;
  } else {
    items.forEach((it) => {
      const v = Math.abs(Number(it.value) || 0);
      if (v <= 0) return;
      const len = (v / total) * circ;
      s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col(it.color)}"
        stroke-width="${thickness}" stroke-dasharray="${(len - 2).toFixed(2)} ${(circ - len + 2).toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt">
        <title>${esc(it.name)}：${nf(v)}${esc(valueUnit)}（${((v / total) * 100).toFixed(1)}%）</title></circle>`;
      offset += len;
    });
  }
  if (centerValue) {
    s += `<text x="${cx}" y="${cy - 2}" font-size="16" font-weight="700" fill="${C.textStrong}" text-anchor="middle">${esc(centerValue)}</text>`;
  }
  if (centerTitle) {
    s += `<text x="${cx}" y="${cy + 16}" font-size="11" fill="${C.axis}" text-anchor="middle">${esc(centerTitle)}</text>`;
  }
  s += `</svg>`;
  return s;
}

/** 环形图配套图例列表（HTML） */
function donutLegend(items = [], total = null, valueUnit = '') {
  const sum = total === null ? items.reduce((a, b) => a + Math.abs(Number(b.value) || 0), 0) : total;
  return items
    .map((it) => {
      const v = Math.abs(Number(it.value) || 0);
      const p = sum ? ((v / sum) * 100).toFixed(1) : '0.0';
      return `<div class="legend-row">
        <span class="legend-dot" style="background:${col(it.color)}"></span>
        <span class="legend-name">${esc(it.name)}</span>
        <span class="legend-bar"><i style="width:${p}%;background:${col(it.color)}"></i></span>
        <span class="legend-pct">${p}%</span>
        <span class="legend-val">${nf(v)}${esc(valueUnit)}</span>
      </div>`;
    })
    .join('');
}

/* ----------------------------- 水平条形排行（TOP N） ---------------------------- */

function rankBars(items = [], { valueUnit = '', max: maxOverride = null } = {}) {
  const max = maxOverride !== null ? maxOverride : Math.max(...items.map((i) => Math.abs(Number(i.value) || 0)), 1);
  return items
    .map(
      (it, idx) => `<div class="rank-row">
      <span class="rank-idx">${idx + 1}</span>
      <span class="rank-name" title="${esc(it.name)}">${esc(it.name)}</span>
      <span class="rank-track"><i style="width:${Math.max((Math.abs(it.value) / max) * 100, 1.5).toFixed(1)}%;background:${col(it.color, C.primary)}"></i></span>
      <span class="rank-val">${nf(it.value)}${esc(valueUnit)}</span>
    </div>`
    )
    .join('');
}

/* ------------------------------ 日历热力图（记账日历） ---------------------------- */

/**
 * @param {object} o
 * @param {string} o.month  YYYY-MM
 * @param {Array<{date:string,income:number,expense:number,count:number}>} o.days
 */
function calendarHeatmap({ month, days = [], today = '' } = {}) {
  const { firstWeekday, daysInMonth, fmtAmount } = require('./util');
  const [y, m] = month.split('-').map(Number);
  const total = daysInMonth(month);
  const startWd = firstWeekday(month);
  const maxExpense = Math.max(...days.map((d) => d.expense || 0), 1);
  const map = new Map(days.map((d) => [d.date, d]));
  const cell = 74, gapY = 6;
  const cols = 7, rows = Math.ceil((startWd + total) / 7);
  const W = cols * cell + (cols - 1) * 0;
  const H = rows * (cell * 0.86 + gapY) + 26;

  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" role="img" style="display:block">`;
  ['日', '一', '二', '三', '四', '五', '六'].forEach((wd, i) => {
    s += `<text x="${i * cell + cell / 2}" y="12" font-size="12" fill="${C.axis}" text-anchor="middle">${wd}</text>`;
  });
  for (let i = 0; i < startWd + total; i++) {
    const col = i % 7, row = Math.floor(i / 7);
    const dayNum = i - startWd + 1;
    const x = col * cell + 3;
    const y0 = 22 + row * (cell * 0.86 + gapY);
    const w = cell - 6, h = cell * 0.86;
    if (dayNum < 1 || dayNum > total) continue;
    const dateStr = `${month}-${String(dayNum).padStart(2, '0')}`;
    const d = map.get(dateStr) || { expense: 0, income: 0, count: 0 };
    const intensity = Math.min((d.expense || 0) / maxExpense, 1);
    const bg = d.expense > 0 ? `rgba(245,34,45,${(0.06 + intensity * 0.16).toFixed(3)})` : '#fafbfc';
    const isToday = dateStr === today;
    s += `<rect x="${x}" y="${y0}" width="${w}" height="${h}" rx="8" fill="${bg}" stroke="${isToday ? C.primary : '#eef1f5'}" stroke-width="${isToday ? 1.6 : 1}"/>`;
    s += `<text x="${x + 9}" y="${y0 + 17}" font-size="12" font-weight="600" fill="${isToday ? C.primary : '#475467'}">${dayNum}</text>`;
    if (d.count > 0) {
      s += `<text x="${x + 9}" y="${(y0 + h - 18).toFixed(1)}" font-size="10.5" fill="${C.expense}" font-weight="600">-${fmtAmount(d.expense, d.expense >= 100000 ? 0 : 2)}</text>`;
      if (d.income > 0) s += `<text x="${x + 9}" y="${(y0 + h - 6).toFixed(1)}" font-size="10.5" fill="${C.income}" font-weight="600">+${fmtAmount(d.income, 2)}</text>`;
    }
    s += `<title>${relDate(dateStr)} 支出 ${fmtAmount(d.expense)} 收入 ${fmtAmount(d.income)} 共 ${d.count} 笔</title>`;
  }
  s += `</svg>`;
  return s;
}

/* --------------------------------- 进度条 --------------------------------- */

function progressBar(used, total, { color = C.primary, height = 8, warn = false } = {}) {
  const p = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  const over = used > total;
  const c = over || warn ? '#f5222d' : p > 80 ? '#fa8c16' : color;
  return `<div class="progress" style="height:${height}px"><i style="width:${p.toFixed(1)}%;background:${c}"></i></div>`;
}

module.exports = { barChart, lineChart, donutChart, donutLegend, rankBars, calendarHeatmap, progressBar };

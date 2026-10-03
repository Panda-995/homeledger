'use strict';
/**
 * 重新生成 src/views/partials/icons.ejs（Lucide 图标 sprite）。
 *
 * 用法：
 *   1. 在 scripts/ 同级准备一个目录放 lucide-static 的 SVG（unpkg.com/lucide-static@<ver>/icons/<name>.svg）
 *   2. node scripts/build-icons.mjs /path/to/svg-dir [输出.ejs]
 *
 * 图标清单在下方 ICONS 数组里维护；页面里用 <svg class="icon"><use href="#i-<name>"></use></svg> 引用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ICONS = [
  'menu', 'house', 'pencil', 'list', 'calendar-days', 'bot', 'chart-column', 'search',
  'credit-card', 'target', 'repeat', 'receipt', 'users-round', 'piggy-bank',
  'tag', 'tags', 'download', 'upload', 'library', 'bell', 'settings', 'info',
  'sun', 'moon', 'plus', 'user-round', 'log-out', 'trash-2', 'x', 'paperclip',
  'send', 'camera', 'sparkles', 'chevron-down', 'check', 'chevron-left', 'chevron-right',
  'triangle-alert', 'external-link', 'wallet', 'key-round', 'plug',
  'refresh-cw', 'arrow-left-right', 'hand-coins', 'trending-up', 'trending-down',
  'chart-pie', 'filter', 'eye', 'lock', 'scale', 'banknote', 'image',
  'circle-alert', 'circle-check', 'arrow-right', 'arrow-up-right', 'file-text',
  'clipboard-list', 'shield',
];

const LUCIDE_VERSION = '0.545.0';

const srcDir = process.argv[2];
const outFile = process.argv[3] || path.join(__dirname, '..', 'src', 'views', 'partials', 'icons.ejs');
if (!srcDir) {
  console.error('用法：node scripts/build-icons.mjs <lucide-svg目录> [输出.ejs]');
  process.exit(1);
}

const symbols = [];
for (const name of ICONS) {
  const file = path.join(srcDir, `${name}.svg`);
  if (!fs.existsSync(file)) {
    console.error(`缺少图标：${name}（${file}）`);
    process.exit(1);
  }
  const svg = fs.readFileSync(file, 'utf8');
  const m = svg.match(/<svg[\s\S]*?>([\s\S]*?)<\/svg>/);
  if (!m) { console.error(`解析失败：${name}`); process.exit(1); }
  const inner = m[1].replace(/\s+/g, ' ').trim();
  symbols.push(
    `<symbol id="i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</symbol>`
  );
}

const banner = `<%# 图标库：Lucide v${LUCIDE_VERSION}（ISC License）https://lucide.dev · 本文件由 scripts/build-icons.mjs 生成，勿手改 %>\n`;
const body = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" data-icons="lucide">\n  ${symbols.join('\n  ')}\n</svg>\n`;
fs.writeFileSync(outFile, banner + body);
console.log(`已生成 ${outFile}（${symbols.length} 个图标，${body.length} 字节）`);

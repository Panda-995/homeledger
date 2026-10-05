/**
 * 全量回归跑批：依次为每个 verify 套件起独立实例（干净数据目录），跑完即停。
 * 用法：node test/run-all.js
 * 约定：套件一律打 http://127.0.0.1:8099；本脚本负责实例生命周期，互不串数据。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 8099;
const SUITES = [
  'verify-about.js',
  'verify-settings-admin.js',
  'verify-ai-chat.js',
  'verify-ai-image.js',
  'verify-ai-attachments.js',
  'verify-model-list.js',
  'verify-subscriptions.js',
  'verify-budgets.js',
];

function healthz(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function probe() {
      const req = http.get(`http://127.0.0.1:${PORT}/healthz`, (res) => {
        res.resume();
        res.statusCode === 200 ? resolve() : retry();
      });
      req.on('error', retry);
      function retry() {
        if (Date.now() > deadline) return reject(new Error('healthz 超时'));
        setTimeout(probe, 300);
      }
    })();
  });
}

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

(async () => {
  const results = [];
  for (const suite of SUITES) {
    const dataDir = path.join(ROOT, 'data-verify-runall');
    fs.rmSync(dataDir, { recursive: true, force: true });
    const server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, NODE_ENV: 'test' },
      stdio: 'ignore',
    });
    try {
      await healthz(15000);
      // DATA_DIR 必须同步传给套件进程：部分套件（如 ai-attachments）要读服务端的上传目录核对落盘文件
      const { code, out } = await run(process.execPath, [path.join('test', suite)], { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir } });
      const m = out.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
      results.push({ suite, ok: code === 0, pass: m ? Number(m[1]) : null, fail: m ? Number(m[2]) : null, tail: out.trim().split('\n').slice(-3).join(' | ') });
    } catch (e) {
      results.push({ suite, ok: false, pass: null, fail: null, tail: 'SERVER_FAIL ' + e.message });
    } finally {
      server.kill();
      await new Promise((r) => setTimeout(r, 500));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  console.log('\n===== 全量回归汇总 =====');
  let totalPass = 0, totalFail = 0, bad = 0;
  for (const r of results) {
    const mark = r.ok ? 'GREEN' : 'RED  ';
    console.log(`${mark}  ${r.suite.padEnd(28)} ${r.pass ?? '-'} 通过 / ${r.fail ?? '-'} 失败${r.ok ? '' : '  << ' + r.tail}`);
    totalPass += r.pass || 0;
    totalFail += r.fail || 0;
    if (!r.ok) bad++;
  }
  console.log(`\n套件：${results.length - bad}/${results.length} 绿；断言合计：${totalPass} 通过 / ${totalFail} 失败`);
  process.exit(bad ? 1 : 0);
})();

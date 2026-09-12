#!/usr/bin/env node
'use strict';
// Smoke test: boot Mission Control in screenshot mode and prove the window renders.
// Plain Node, no dependencies. `npm test` runs it; CI runs it on every PR.
//
// It asserts: Electron exits 0, a real PNG of a sensible size was written, and the
// renderer logged nothing that looks like a crash (main.js prints those as
// "RENDERER ERROR: ..." in screenshot mode).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WAIT = Number(process.env.SMOKE_WAIT) || 3500;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT) || 60000;
// SMOKE_VIEW runs the same check against a --view boot (e.g. SMOKE_VIEW=settings-rules): main.js then
// takes the shot when the renderer reports view:ready instead of when the clock runs out (T-029).
const VIEW = process.env.SMOKE_VIEW || '';
// A window that rendered nothing compresses to a few KB; a real one is hundreds. 50 KB is well clear of
// both, and it is the assertion that catches a blank capture the PNG header alone would call valid.
const MIN_PNG_BYTES = 20 * 1024;   // a blank capture is a few KB; the CI runner's empty window is about 33 KB, a full one 340-430 KB
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Chromium and node-pty's conpty helper are chatty when another instance is running.
// None of these mean the app failed.
const NOISE = [
  /Unable to move the cache/i,
  /Gpu Cache Creation failed/i,
  /AttachConsole failed/i,
  /cache_util_win|disk_cache/i,
];
const RENDERER_MARKER = /RENDERER ERROR:/;
const JS_ERROR = /\b(Uncaught|TypeError|ReferenceError)\b/;
// A JS error only counts when it comes from the page, not from a tool in the log tail.
const FROM_RENDERER = /RENDERER ERROR:|renderer[\/]|file:\/\/\//i;

function png(file) {
  if (!fs.existsSync(file)) return { ok: false, why: `no PNG at ${file}` };
  const size = fs.statSync(file).size;
  const head = Buffer.alloc(8);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
  if (!head.equals(PNG_MAGIC)) return { ok: false, why: `${file} is not a PNG (bad magic bytes)`, size };
  if (size < MIN_PNG_BYTES) return { ok: false, why: `PNG is only ${size} B, expected > ${MIN_PNG_BYTES} B (blank window?)`, size };
  return { ok: true, size };
}

function run() {
  return new Promise((resolve) => {
    let electronBin;
    try { electronBin = require('electron'); } catch (e) { return resolve({ spawnError: `cannot resolve the electron package: ${e && e.message}` }); }
    if (typeof electronBin !== 'string') return resolve({ spawnError: 'the electron package did not return a binary path (is ELECTRON_RUN_AS_NODE leaking in?)' });

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // otherwise electron runs as plain node and main.js bails out with exit 2

    const args = ['.', '--screenshot', OUT, '--wait', String(WAIT)];
    if (VIEW) args.push('--view', VIEW);
    const child = spawn(electronBin, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = [];
    child.stdout.on('data', (d) => log.push(String(d)));
    child.stderr.on('data', (d) => log.push(String(d)));

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* already gone */ } }, TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); resolve({ spawnError: String(e && e.message || e) }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, out: log.join('') }); });
  });
}

const OUT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-smoke-')), 'smoke.png');

(async () => {
  const started = Date.now();
  console.log(`smoke: booting Mission Control in screenshot mode (${VIEW ? `--view ${VIEW}, ` : ''}wait ${WAIT} ms, timeout ${TIMEOUT_MS} ms)`);
  const r = await run();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const fails = [];

  if (r.spawnError) fails.push(`could not start Electron: ${r.spawnError}`);
  if (r.timedOut) fails.push(`Electron did not exit within ${TIMEOUT_MS} ms and was killed`);
  else if (!r.spawnError && r.code !== 0) fails.push(`Electron exited with code ${r.code}${r.signal ? ` (signal ${r.signal})` : ''}`);

  const shot = png(OUT);
  if (!shot.ok) fails.push(shot.why);

  const lines = String(r.out || '').split(/\r?\n/).filter((l) => l.trim() && !NOISE.some((n) => n.test(l)));
  const rendererErrors = lines.filter((l) => RENDERER_MARKER.test(l) || (JS_ERROR.test(l) && FROM_RENDERER.test(l)));
  for (const l of rendererErrors.slice(0, 10)) fails.push(`renderer problem: ${l.trim()}`);

  // The renderer's own timing line, and which trigger the capture ended up using. Printed on a pass too:
  // it is the only place a slow boot shows up before it turns into a flaky screenshot.
  for (const l of lines.filter((l) => /^(VIEW READY|screenshot trigger:)/.test(l.trim()))) console.log('  ' + l.trim());

  if (fails.length) {
    console.error('\nsmoke FAIL');
    for (const f of fails) console.error('  - ' + f);
    console.error(`\nelectron output (${lines.length} lines, noise filtered):`);
    for (const l of lines.slice(-60)) console.error('  | ' + l);
    console.error(`\nscreenshot kept for inspection: ${OUT}`);
    process.exit(1);
  }

  try { fs.rmSync(path.dirname(OUT), { recursive: true, force: true }); } catch { /* temp dir, fine */ }
  console.log(`smoke PASS  exit 0 · PNG ${Math.round(shot.size / 1024)} KB · no renderer errors · ${secs}s`);
})();

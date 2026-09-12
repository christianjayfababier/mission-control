'use strict';
/* Crash evidence (T-024).

   On 2026-09-12 Mission Control restarted twice and left nothing behind: `render-process-gone`,
   renderer console errors, uncaught exceptions and unhandled rejections were only ever printed in
   `--screenshot` mode, the launcher `start`s electron.exe so stderr goes nowhere, and Windows logged
   nothing. The cause turned out to be system memory pressure (commit charge 52 of 65 GB from stale
   dev servers) — invisible from inside the app.

   This module is the black box. Two halves, like updater.js:

   `formatLine`, `rotate` and `memoryVerdict` are pure (or file-only) and have no Electron in them, so
   `node test/unit.js` drives them directly and `require('./diag')` works under plain node.

   `installHandlers({ app, win })` is the wiring: it subscribes to every way this process can die,
   writes one line per event to DATA_DIR/logs/main.log, samples memory every minute, and pushes a
   `diag` payload to the renderer so the header can say "Low system memory" before the machine wedges.

   Every line carries the pid: the owner's installed Mission Control and a builder's worktree run share
   DATA_DIR, so two processes append to the same file and the reader must be able to tell them apart.  */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MAX_BYTES = 1024 * 1024;              // rotate at 1 MB, keeping exactly one .1 file
const SAMPLE_EVERY_MS = 60 * 1000;          // memory sample cadence
const REPORT_EVERY_MS = 5 * 60 * 1000;      // but a `memory` warning line at most this often
const COMMIT_CACHE_MS = 30 * 1000;          // the PowerShell query is not free; one answer serves 30 s
const COMMIT_TIMEOUT_MS = 5000;
// Set from the 2026-09-12 crash, not from a round number: the machine was at 52 of 65 GB committed
// (80.0 %) with about 4 GB free when it started to wobble, and under 1 GB free by the time the window
// died. Both rules have to catch that sample, so the commit rule fires AT 80 % as well as above it.
const COMMIT_PCT_HIGH = 80;                 // the commit limit is 80 % or more spoken for
const FREE_MB_LOW = 1536;                   // fewer than 1.5 GB of free physical RAM left
const RELOAD_DELAY_MS = 1000;               // let the GPU/renderer teardown finish before reloading
const RELOAD_QUIET_MS = 60 * 1000;          // one reload per minute: a crash loop must not spin

// ───────────────────────── pure helpers (tested in test/unit.js)

const oneLine = (s) => String(s).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();

/** An error, an object of fields, or a string → the one-line tail of a log line. */
function detailText(detail) {
  if (detail == null || detail === '') return '';
  if (detail instanceof Error) {
    const stack = oneLine(detail.stack || '').slice(0, 900);
    return oneLine(`${detail.name || 'Error'}: ${detail.message || ''}` + (stack ? ` | ${stack}` : ''));
  }
  if (typeof detail === 'object') {
    const parts = [];
    for (const [k, v] of Object.entries(detail)) {
      if (v === undefined) continue;
      const text = v instanceof Error ? detailText(v) : oneLine(v === null ? 'null' : String(v));
      parts.push(`${k}=${/\s/.test(text) ? JSON.stringify(text) : text}`);
    }
    return parts.join(' ');
  }
  return oneLine(detail);
}

/**
 * One log line, always exactly one line: `<iso> pid=<pid> <level> <event> <detail>`.
 * Pure: give it a `time` and a `pid` and it is fully deterministic.
 */
function formatLine({ time, pid, level, event, detail } = {}) {
  const t = time || new Date().toISOString();
  const p = pid == null ? process.pid : pid;
  const lv = oneLine(level || 'info').toLowerCase() || 'info';
  const ev = oneLine(event || 'event').replace(/\s+/g, '-') || 'event';
  const d = detailText(detail);
  return `${t} pid=${p} ${lv} ${ev}${d ? ' ' + d : ''}`;
}

/**
 * Keep the log from growing without bound: at `maxBytes` the current file becomes `<file>.1` and the
 * previous `.1` is dropped. Never throws — losing the log must never take the app with it.
 * @returns {boolean} true when a rotation actually happened.
 */
function rotate(file, maxBytes = MAX_BYTES) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size < maxBytes) return false;
  } catch { return false; }                       // no file yet, or unreadable: nothing to rotate
  const old = file + '.1';
  try { fs.rmSync(old, { force: true }); } catch { /* a viewer has it open; the rename below decides */ }
  try { fs.renameSync(file, old); return true; }
  catch { return false; }                          // locked: keep appending rather than lose the evidence
}

/**
 * Is this machine short of memory right now?
 * `commitUsedMb`/`commitLimitMb` are the Windows commit charge (the number that actually ran out on
 * 2026-09-12); `freeMb` is free physical RAM. Either one alone is enough to raise the flag. Any
 * missing input is simply not considered — never a guess, never a throw.
 * The commit rule is inclusive: the crash this exists for sat at exactly 80.0 %, and a guard that lets
 * its own motivating incident through is not a guard.
 * @returns {{low: boolean, commitPct: number|null, freeMb: number|null, reasons: string[]}}
 */
function memoryVerdict({ commitUsedMb, commitLimitMb, freeMb } = {}) {
  const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null);
  const used = num(commitUsedMb), limit = num(commitLimitMb), free = num(freeMb);
  const commitPct = limit && limit > 0 && used != null ? Math.round((used / limit) * 1000) / 10 : null;
  const reasons = [];
  if (commitPct != null && commitPct >= COMMIT_PCT_HIGH) reasons.push(`commit ${commitPct}% of ${Math.round(limit)} MB`);
  if (free != null && free < FREE_MB_LOW) reasons.push(`${Math.round(free)} MB free RAM`);
  return { low: reasons.length > 0, commitPct, freeMb: free, reasons };
}

// ───────────────────────── the log file

class DiagLog {
  /** @param {string} dir the directory the log lives in (DATA_DIR/logs) */
  constructor(dir, { maxBytes = MAX_BYTES } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'main.log');
    this.maxBytes = maxBytes;
    this.broken = null;   // the reason logging gave up, if it ever did
  }
  /** Append one line. Never throws: the first failure is remembered and the rest are silent. */
  write(level, event, detail) {
    const line = formatLine({ level, event, detail });
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      rotate(this.file, this.maxBytes);
      fs.appendFileSync(this.file, line + '\n');           // append: two Mission Controls may share this file
    } catch (e) { this.broken = String((e && e.message) || e); }
    return line;
  }
  /** What Settings › About shows: where the log is and how big it got. */
  info() {
    let bytes = null, mtime = null;
    try { const st = fs.statSync(this.file); bytes = st.size; mtime = st.mtimeMs; } catch { /* not written yet */ }
    return { file: this.file, dir: this.dir, bytes, mtime, error: this.broken };
  }
}

// ───────────────────────── memory sampling

let commitCache = { at: 0, value: null };
/**
 * Windows commit charge, in MB, via CIM (`wmic` is deprecated and gone from recent Windows).
 * Win32_OperatingSystem reports kilobytes: TotalVirtualMemorySize is the commit limit,
 * FreeVirtualMemory the part of it still uncommitted. Cached, timed out, and it never rejects.
 * @returns {Promise<{commitUsedMb: number, commitLimitMb: number}|null>}
 */
function commitCharge() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (commitCache.value && Date.now() - commitCache.at < COMMIT_CACHE_MS) return Promise.resolve(commitCache.value);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (v) commitCache = { at: Date.now(), value: v }; resolve(v); };
    try {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        "$o = Get-CimInstance Win32_OperatingSystem; '{0} {1}' -f $o.TotalVirtualMemorySize, $o.FreeVirtualMemory",
      ], { timeout: COMMIT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (err) return finish(null);
        const m = /(\d+)\s+(\d+)/.exec(String(stdout || ''));
        if (!m) return finish(null);
        const limitKb = Number(m[1]), freeKb = Number(m[2]);
        if (!isFinite(limitKb) || !isFinite(freeKb) || limitKb <= 0) return finish(null);
        finish({ commitLimitMb: limitKb / 1024, commitUsedMb: Math.max(0, limitKb - freeKb) / 1024 });
      });
    } catch { finish(null); }
  });
}

/** One memory sample: this process, the machine's RAM, and (on Windows) the commit charge. */
async function sampleMemory() {
  const mb = (b) => Math.round(b / (1024 * 1024));
  let mem = {};
  try { mem = process.memoryUsage(); } catch { mem = {}; }
  const totalMb = mb(os.totalmem()), freeMb = mb(os.freemem());
  const commit = await commitCharge();
  const verdict = memoryVerdict({ commitUsedMb: commit && commit.commitUsedMb, commitLimitMb: commit && commit.commitLimitMb, freeMb });
  return {
    at: Date.now(),
    rssMb: mem.rss ? mb(mem.rss) : null,
    heapMb: mem.heapUsed ? mb(mem.heapUsed) : null,
    totalMb, freeMb,
    commitUsedMb: commit ? Math.round(commit.commitUsedMb) : null,
    commitLimitMb: commit ? Math.round(commit.commitLimitMb) : null,
    commitPct: verdict.commitPct,
    low: verdict.low,
    reasons: verdict.reasons,
  };
}

/** The one-line summary the log and Settings › About both show. */
function memoryText(s) {
  if (!s) return 'no sample yet';
  const bits = [`rss ${s.rssMb == null ? '?' : s.rssMb} MB`, `free RAM ${s.freeMb} of ${s.totalMb} MB`];
  if (s.commitPct != null) bits.push(`commit ${s.commitUsedMb} of ${s.commitLimitMb} MB (${s.commitPct}%)`);
  if (s.low) bits.push('LOW: ' + s.reasons.join(', '));
  return bits.join(' · ');
}

// ───────────────────────── the wiring

/**
 * Subscribe to every way this process can die and start the memory guard.
 *
 * @param {{app: object, win?: object, dataDir: string, dialog?: object, packaged?: boolean,
 *          screenshot?: boolean, recover?: boolean, send?: (payload: object) => void,
 *          showDialog?: boolean, sampleEveryMs?: number, onFatal?: (err: Error) => void}} opts
 * @returns {{log: DiagLog, write: Function, setWindow: Function, state: Function, info: Function, stop: Function}}
 */
function installHandlers(opts = {}) {
  const app = opts.app;
  const dataDir = opts.dataDir || path.join(os.homedir(), '.claude', 'mission-control');
  const log = new DiagLog(path.join(dataDir, 'logs'));
  const write = (level, event, detail) => log.write(level, event, detail);
  const send = typeof opts.send === 'function' ? opts.send : () => {};
  const packaged = opts.packaged != null ? !!opts.packaged : !!(app && app.isPackaged);
  const screenshot = !!opts.screenshot;
  const recover = opts.recover != null ? !!opts.recover : !screenshot;
  // A packaged app must never stop at Electron's "A JavaScript error occurred in the main process"
  // box: nobody is there to click it. A development run keeps the box — except in screenshot mode,
  // where a modal dialog would hang the smoke test (and pop up on the owner's screen).
  const showDialog = opts.showDialog != null ? !!opts.showDialog : (!packaged && !screenshot);
  const dialog = opts.dialog || null;
  // Installing an 'uncaughtException' listener is what suppresses Electron's dialog — which also means
  // the process no longer dies on its own. Screenshot mode needs it to: the smoke test's whole verdict is
  // the exit code. main.js passes an onFatal that ends the run there, and nothing at all in a real run.
  const onFatal = typeof opts.onFatal === 'function' ? opts.onFatal : null;

  let win = opts.win || null;
  let lastSample = null;
  let lastWarnAt = 0;
  let lastReloadAt = 0;
  let crashes = 0;
  let timer = null;
  let stopped = false;
  const flag = { lowMemory: false, commitPct: null, freeMb: null, crashed: false, crashReason: null };

  write('info', 'startup', {
    version: (app && app.getVersion && app.getVersion()) || 'unknown',
    electron: process.versions.electron || 'none',
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    os: `${os.release()} ${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB`,
    packaged,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE ? '1' : '0',
    screenshot: screenshot ? '1' : '0',
    argv: process.argv.slice(1).join(' ') || '(none)',
  });

  // ── the process itself
  // Adding these listeners is what suppresses Electron's default error dialog; everything after is ours.
  process.on('uncaughtException', (err) => {
    write('error', 'uncaught-exception', err);
    if (showDialog && dialog && typeof dialog.showErrorBox === 'function') {
      try { dialog.showErrorBox('A JavaScript error occurred in the main process', String((err && err.stack) || err)); } catch { /* the log already has it */ }
    }
    // Deliberately no exit: a packaged app that logged the error keeps the window and the terminals
    // alive. An error that really is fatal takes the process down on its own.
    if (onFatal) { try { onFatal(err); } catch { /* we are already handling a crash */ } }
  });
  process.on('unhandledRejection', (reason) => write('error', 'unhandled-rejection', reason instanceof Error ? reason : { reason: String(reason) }));
  process.on('warning', (w) => write('warn', 'process-warning', w));

  // ── the renderer
  /** The one thing that must never be silent again: the window dying. */
  function onRenderProcessGone(_e, details) {
    crashes++;
    const reason = (details && details.reason) || 'unknown';
    const exitCode = details && details.exitCode;
    write('error', 'render-process-gone', { reason, exitCode, crashes, memory: memoryText(lastSample) });
    if (!recover || !win || win.isDestroyed()) return;
    const now = Date.now();
    if (now - lastReloadAt < RELOAD_QUIET_MS) { write('warn', 'render-process-gone', { skipped: 'reload', why: 'crashed again within ' + Math.round(RELOAD_QUIET_MS / 1000) + 's' }); return; }
    lastReloadAt = now;
    flag.crashed = true; flag.crashReason = `${reason}${exitCode == null ? '' : ' (exit ' + exitCode + ')'}`;
    setTimeout(() => {
      if (stopped || !win || win.isDestroyed()) return;
      try { win.webContents.reload(); write('info', 'render-reloaded', { after: reason }); }
      catch (e) { write('error', 'render-reload-failed', e); }
    }, RELOAD_DELAY_MS);
  }
  function attach(w) {
    win = w || null;
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.on('render-process-gone', onRenderProcessGone);
      win.webContents.on('unresponsive', () => write('warn', 'window-unresponsive', {}));
      win.webContents.on('responsive', () => write('info', 'window-responsive', {}));
      win.on('closed', () => write('info', 'window-closed', {}));
    } catch (e) { write('error', 'diag-attach-failed', e); }
  }
  attach(win);

  // ── the app's own exit, so a clean quit never looks like a crash in the log
  if (app && typeof app.on === 'function') {
    try {
      app.on('child-process-gone', (_e, d) => write('error', 'child-process-gone', { type: d && d.type, reason: d && d.reason, exitCode: d && d.exitCode, name: d && d.name }));
      app.on('window-all-closed', () => write('info', 'window-all-closed', {}));
      app.on('before-quit', () => write('info', 'before-quit', {}));
      app.on('will-quit', () => write('info', 'will-quit', { clean: true, uptimeS: Math.round(process.uptime()) }));
      app.on('quit', (_e, code) => write('info', 'quit', { exitCode: code, uptimeS: Math.round(process.uptime()) }));
    } catch (e) { write('error', 'diag-app-hooks-failed', e); }
  }

  // ── the memory guard
  async function tick() {
    let s = null;
    try { s = await sampleMemory(); } catch (e) { write('error', 'memory-sample-failed', e); return; }
    lastSample = s;
    const changed = s.low !== flag.lowMemory;
    flag.lowMemory = s.low; flag.commitPct = s.commitPct; flag.freeMb = s.freeMb;
    if (s.low && (changed || Date.now() - lastWarnAt > REPORT_EVERY_MS)) { lastWarnAt = Date.now(); write('warn', 'memory', memoryText(s)); }
    if (!s.low && changed) write('info', 'memory', 'recovered · ' + memoryText(s));
    if (changed) push();
  }
  function push() { try { send({ lowMemory: flag.lowMemory, commitPct: flag.commitPct, freeMb: flag.freeMb, crashed: flag.crashed, crashReason: flag.crashReason }); } catch { /* the window went away */ } }

  if (!screenshot) {
    timer = setInterval(() => { tick().catch(() => {}); }, opts.sampleEveryMs || SAMPLE_EVERY_MS);
    if (timer.unref) timer.unref();
    const first = setTimeout(() => { tick().catch(() => {}); }, 3000); if (first.unref) first.unref();   // one early sample, after the boot rush
  }

  return {
    log,
    write,
    setWindow: attach,
    /** What the renderer gets on `did-finish-load`, so a reloaded window redraws its chips. */
    state: () => ({ lowMemory: flag.lowMemory, commitPct: flag.commitPct, freeMb: flag.freeMb, crashed: flag.crashed, crashReason: flag.crashReason }),
    /** What Settings › About shows. */
    info: () => ({ ...log.info(), memory: memoryText(lastSample), sample: lastSample, crashes }),
    /** The same, but never "no sample yet": the dialog may open before the first minute is up. */
    async infoNow() {
      if (!lastSample) { try { await tick(); } catch { /* info() reports what it has */ } }
      return { ...log.info(), memory: memoryText(lastSample), sample: lastSample, crashes };
    },
    /** The banner is a one-shot: the renderer acknowledges it and it never comes back on its own. */
    clearCrash: () => { flag.crashed = false; flag.crashReason = null; },
    sample: tick,
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = {
  formatLine, detailText, rotate, memoryVerdict, sampleMemory, memoryText, commitCharge,
  DiagLog, installHandlers,
  MAX_BYTES, SAMPLE_EVERY_MS, REPORT_EVERY_MS, COMMIT_PCT_HIGH, FREE_MB_LOW,
};

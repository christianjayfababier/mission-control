'use strict';
/* Auto-update from GitHub Releases (T-022).

   Two halves, on purpose:

   `UpdaterState` is a pure state machine with no Electron and no network in it, so test/unit.js can
   drive every transition. States: `disabled | idle | checking | available | downloading | ready | error`.
   Nothing moves once it is `disabled`: a development run must never pretend it can update itself.

   `start()` is the wiring. It requires `electron-updater` lazily (in a plain `node` process
   `require('electron')` is a path string and the adapter would throw), points it at the GitHub release
   feed electron-builder baked into `app-update.yml`, and pushes every state change to the renderer.

   Busy means "a worker is mid-task" and nothing else (T-028). An open terminal never blocks the
   restart: quitting kills terminals anyway and a Claude session is resumable, while a worker that is
   running has unfinished work. The counts travel in the payload (`workers`, `terminals`) so the
   renderer can say what a restart costs, and `installNow({ force: true })` is the owner overruling
   the running workers on purpose. `autoInstallOnAppQuit` stays off: closing the window must not
   silently swap the app out.

   `MC_UPDATE_FAKE_READY=<version>` puts an *unpackaged* run into `ready` for that version so the
   chip and the confirmation dialog can be proved in development. It never downloads and never
   restarts: `installNow()` there answers `{ error: 'not packaged' }`.  */

const CHECK_DELAY_MS = 20 * 1000;             // after startup: let the sessions and probes settle first
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;    // and every four hours after that

const STATES = ['disabled', 'idle', 'checking', 'available', 'downloading', 'ready', 'error'];

/** A counter option that may be missing: always a whole number >= 0, never NaN. */
const counter = (fn) => (typeof fn === 'function' ? () => Math.max(0, Math.round(Number(fn()) || 0)) : () => 0);

class UpdaterState {
  /** @param {{current?: string, packaged?: boolean, runningWorkers?: () => number, openTerminals?: () => number, onChange?: (s: object) => void, log?: (...a: any[]) => void}} opts */
  constructor(opts = {}) {
    this.current = String(opts.current || '0.0.0');
    this.packaged = !!opts.packaged;
    this.runningWorkers = counter(opts.runningWorkers);   // busy is this one, and only this one
    this.openTerminals = counter(opts.openTerminals);     // reported so the owner sees what closing costs
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    this.log = typeof opts.log === 'function' ? opts.log : (...a) => console.log('updater', ...a);
    this.state = this.packaged ? 'idle' : 'disabled';
    this.reason = this.packaged ? null : 'not packaged';
    this.version = null;      // the version on offer, not ours; null until a check finds one
    this.percent = 0;
    this.error = null;
    this.checkedAt = 0;       // ms epoch of the last answered check; 0 = never checked
  }

  /** Busy = at least one worker is running. Terminals are counted, never a blocker (T-028). */
  isBusy() { return this.runningWorkers() > 0; }

  /** The payload the renderer and the IPC handlers see. The counts are asked fresh every time. */
  snapshot() {
    const workers = this.runningWorkers(), terminals = this.openTerminals(), busy = workers > 0;
    return {
      state: this.state, reason: this.reason, current: this.current, version: this.version,
      percent: this.percent, error: this.error, checkedAt: this.checkedAt,
      busy, workers, terminals, canInstall: this.state === 'ready' && !busy,
    };
  }

  /** The only way the state ever changes: one log line per transition, one push to the renderer. */
  to(state, patch = {}) {
    if (this.state === 'disabled') return this.snapshot();   // dev runs stay put, whatever happens
    if (!STATES.includes(state)) throw new Error('unknown updater state ' + state);
    const from = this.state;
    this.state = state;
    if ('version' in patch) this.version = patch.version;
    if ('percent' in patch) this.percent = patch.percent;
    if ('error' in patch) this.error = patch.error;
    if ('checkedAt' in patch) this.checkedAt = patch.checkedAt;
    const s = this.snapshot();
    this.log(`${from} -> ${state}` + (s.version ? ` v${s.version}` : '') + (state === 'downloading' ? ` ${s.percent}%` : '') + (s.error ? ` error=${s.error}` : '') + (s.busy ? ` (${s.workers} workers running)` : ''));
    this.onChange(s);
    return s;
  }

  // -- the transitions, one per electron-updater event
  checking() { return this.to('checking', { error: null }); }
  available(version) { return this.to('available', { version: version || null, percent: 0, error: null, checkedAt: Date.now() }); }
  notAvailable() { return this.to('idle', { version: null, percent: 0, error: null, checkedAt: Date.now() }); }
  progress(percent) { return this.to('downloading', { percent: Math.max(0, Math.min(100, Math.round(Number(percent) || 0))) }); }
  downloaded(version) { return this.to('ready', { version: version || this.version, percent: 100, error: null, checkedAt: Date.now() }); }
  failed(message) {
    // electron-updater reports a failed check twice: the `error` event and the rejected
    // `checkForUpdates()` promise. The same message twice is one failure, so log and push it once.
    const text = String((message && message.message) || message || 'update failed');
    if (this.state === 'error' && this.error === text) return this.snapshot();
    return this.to('error', { error: text });
  }

  /**
   * Why `installNow()` would refuse right now, or null when it may go ahead.
   * @param {boolean} [force] the owner said "restart anyway": running workers stop being a blocker.
   */
  installBlocker(force) {
    if (this.state === 'disabled') return 'updates are disabled: ' + (this.reason || 'not packaged');
    if (this.state !== 'ready') return 'no update is ready';
    const workers = this.runningWorkers();
    if (workers > 0 && !force) return `${workers} worker${workers === 1 ? ' is' : 's are'} still running`;
    return null;
  }
}

/**
 * Wire electron-updater to an UpdaterState and return the handle main.js keeps.
 * @param {{app: object, runningWorkers?: () => number, openTerminals?: () => number, send?: (s: object) => void, autoUpdater?: object, fakeReady?: string}} deps
 */
function start(deps = {}) {
  const app = deps.app;
  const send = typeof deps.send === 'function' ? deps.send : () => {};
  const log = (...a) => console.log('updater', ...a);
  const packaged = !!(app && app.isPackaged);
  // development-only fixture: prove the chip and the restart dialog without a release to download
  const fakeReady = packaged ? null : String(deps.fakeReady || process.env.MC_UPDATE_FAKE_READY || '') || null;
  const st = new UpdaterState({
    current: (app && app.getVersion && app.getVersion()) || '0.0.0',
    packaged: packaged || !!fakeReady,
    runningWorkers: deps.runningWorkers,
    openTerminals: deps.openTerminals,
    onChange: send,
    log,
  });
  let timer = null, interval = null, au = deps.autoUpdater || null;

  /** One line per attempt, whatever the answer is: the log has to show the owner did ask. */
  function logAttempt(force) {
    const s = st.snapshot();
    log(`install requested for ${s.version || 'nothing'}: ${s.workers} worker${s.workers === 1 ? '' : 's'} running, ${s.terminals} terminal${s.terminals === 1 ? '' : 's'} open${force ? ', forced' : ''}`);
    if (force && s.workers > 0) log(`install forced with ${s.workers} worker${s.workers === 1 ? '' : 's'} running`);
    return s;
  }

  if (fakeReady) {
    log(`MC_UPDATE_FAKE_READY=${fakeReady}: pretending that version is downloaded (unpackaged run — no download, no restart)`);
    st.downloaded(fakeReady);
    return {
      state: () => st.snapshot(),
      check: () => st.snapshot(),
      installNow(opts) {
        logAttempt(!!(opts && opts.force));
        log('install refused: not packaged');
        return { error: 'not packaged' };
      },
      stop: () => {},
      _state: st,
    };
  }

  if (!st.packaged) {
    log('disabled: not packaged (a development run never updates itself)');
    return {
      state: () => st.snapshot(),
      check: () => st.snapshot(),
      installNow: (opts) => { logAttempt(!!(opts && opts.force)); const error = st.installBlocker(!!(opts && opts.force)); log('install refused: ' + error); return { error }; },
      stop: () => {},
      _state: st,
    };
  }

  try {
    if (!au) au = require('electron-updater').autoUpdater;
    au.autoDownload = true;            // fetch in the background; the owner only ever picks the moment to restart
    au.autoInstallOnAppQuit = false;   // closing the window must not swap the app out behind the owner's back
    au.logger = { info: (m) => log('lib', m), warn: (m) => log('lib warn', m), error: (m) => log('lib error', (m && m.message) || m) };
    au.on('checking-for-update', () => st.checking());
    au.on('update-available', (info) => st.available(info && info.version));
    au.on('update-not-available', () => st.notAvailable());
    au.on('download-progress', (p) => st.progress(p && p.percent));
    au.on('update-downloaded', (e) => st.downloaded(e && e.version));
    au.on('error', (e) => st.failed(e));
    log(`armed for ${st.current}, first check in ${Math.round(CHECK_DELAY_MS / 1000)} s, then every ${Math.round(CHECK_EVERY_MS / 3600000)} h`);
  } catch (e) {
    log('could not load electron-updater: ' + (e && e.message));
    st.failed(e);
    return { state: () => st.snapshot(), check: () => st.snapshot(), installNow: () => { log('install refused: the updater failed to load'); return { error: 'the updater failed to load' }; }, stop: () => {}, _state: st };
  }

  /** Ask GitHub. Never throws: a check that cannot reach the network is an `error` state, not a crash. */
  function check() {
    if (st.state === 'checking' || st.state === 'downloading') return st.snapshot();
    try { Promise.resolve(au.checkForUpdates()).catch((e) => st.failed(e)); }
    catch (e) { st.failed(e); }
    return st.snapshot();
  }

  timer = setTimeout(() => { check(); interval = setInterval(check, CHECK_EVERY_MS); }, CHECK_DELAY_MS);
  if (timer.unref) timer.unref();

  return {
    state: () => st.snapshot(),
    check,
    installNow(opts) {
      const force = !!(opts && opts.force);
      logAttempt(force);
      const blocker = st.installBlocker(force);
      if (blocker) { log('install refused: ' + blocker); return { error: blocker }; }
      log('installing ' + st.version + ' and restarting');
      try { au.quitAndInstall(false, true); return { ok: true }; }
      catch (e) { log('install failed: ' + String((e && e.message) || e)); st.failed(e); return { error: String((e && e.message) || e) }; }
    },
    stop() { if (timer) clearTimeout(timer); if (interval) clearInterval(interval); timer = interval = null; },
    _state: st,
  };
}

module.exports = { UpdaterState, STATES, start, CHECK_DELAY_MS, CHECK_EVERY_MS };

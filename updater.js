'use strict';
/* Auto-update from GitHub Releases (T-022).

   Two halves, on purpose:

   `UpdaterState` is a pure state machine with no Electron and no network in it, so test/unit.js can
   drive every transition. States: `disabled | idle | checking | available | downloading | ready | error`.
   Nothing moves once it is `disabled`: a development run must never pretend it can update itself.

   `start()` is the wiring. It requires `electron-updater` lazily (in a plain `node` process
   `require('electron')` is a path string and the adapter would throw), points it at the GitHub release
   feed electron-builder baked into `app-update.yml`, and pushes every state change to the renderer.

   Busy means "the owner is in the middle of something": a terminal is open or a worker is running.
   We never restart under those, so `installNow()` refuses while `isBusy()` is true -- the download is
   already on disk, the restart just waits for a quiet moment. `autoInstallOnAppQuit` is off for the
   same reason: closing the window must not silently swap the app out.  */

const CHECK_DELAY_MS = 20 * 1000;             // after startup: let the sessions and probes settle first
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;    // and every four hours after that

const STATES = ['disabled', 'idle', 'checking', 'available', 'downloading', 'ready', 'error'];

class UpdaterState {
  /** @param {{current?: string, packaged?: boolean, isBusy?: () => boolean, onChange?: (s: object) => void, log?: (...a: any[]) => void}} opts */
  constructor(opts = {}) {
    this.current = String(opts.current || '0.0.0');
    this.packaged = !!opts.packaged;
    this.isBusy = typeof opts.isBusy === 'function' ? opts.isBusy : () => false;
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    this.log = typeof opts.log === 'function' ? opts.log : (...a) => console.log('updater', ...a);
    this.state = this.packaged ? 'idle' : 'disabled';
    this.reason = this.packaged ? null : 'not packaged';
    this.version = null;      // the version on offer, not ours; null until a check finds one
    this.percent = 0;
    this.error = null;
    this.checkedAt = 0;       // ms epoch of the last answered check; 0 = never checked
  }

  /** The payload the renderer and the IPC handlers see. `busy` is asked fresh every time. */
  snapshot() {
    const busy = !!this.isBusy();
    return {
      state: this.state, reason: this.reason, current: this.current, version: this.version,
      percent: this.percent, error: this.error, checkedAt: this.checkedAt,
      busy, canInstall: this.state === 'ready' && !busy,
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
    this.log(`${from} -> ${state}` + (s.version ? ` v${s.version}` : '') + (state === 'downloading' ? ` ${s.percent}%` : '') + (s.error ? ` error=${s.error}` : '') + (s.busy ? ' (busy)' : ''));
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

  /** Why `installNow()` would refuse right now, or null when it may go ahead. */
  installBlocker() {
    if (this.state === 'disabled') return 'updates are disabled: ' + (this.reason || 'not packaged');
    if (this.state !== 'ready') return 'no update is ready';
    if (this.isBusy()) return 'sessions are running';
    return null;
  }
}

/**
 * Wire electron-updater to an UpdaterState and return the handle main.js keeps.
 * @param {{app: object, isBusy?: () => boolean, send?: (s: object) => void, autoUpdater?: object}} deps
 */
function start(deps = {}) {
  const app = deps.app;
  const send = typeof deps.send === 'function' ? deps.send : () => {};
  const log = (...a) => console.log('updater', ...a);
  const st = new UpdaterState({
    current: (app && app.getVersion && app.getVersion()) || '0.0.0',
    packaged: !!(app && app.isPackaged),
    isBusy: deps.isBusy,
    onChange: send,
    log,
  });
  let timer = null, interval = null, au = deps.autoUpdater || null;

  if (!st.packaged) {
    log('disabled: not packaged (a development run never updates itself)');
    return {
      state: () => st.snapshot(),
      check: () => st.snapshot(),
      installNow: () => ({ error: st.installBlocker() }),
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
    return { state: () => st.snapshot(), check: () => st.snapshot(), installNow: () => ({ error: 'the updater failed to load' }), stop: () => {}, _state: st };
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
    installNow() {
      const blocker = st.installBlocker();
      if (blocker) { log('install refused: ' + blocker); return { error: blocker }; }
      log('installing ' + st.version + ' and restarting');
      try { au.quitAndInstall(false, true); return { ok: true }; }
      catch (e) { st.failed(e); return { error: String((e && e.message) || e) }; }
    },
    stop() { if (timer) clearTimeout(timer); if (interval) clearInterval(interval); timer = interval = null; },
    _state: st,
  };
}

module.exports = { UpdaterState, STATES, start, CHECK_DELAY_MS, CHECK_EVERY_MS };

'use strict';
const electron = require('electron');
if (!electron || !electron.app) {
  console.error('Mission Control must run under Electron. If ELECTRON_RUN_AS_NODE is set in this shell, unset it first.');
  process.exit(2);
}
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = electron;
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { TranscriptWatcher } = require('./transcripts');
const { CheckpointWriter } = require('./checkpoint');
const { Settings, GitHub, gitInfo, parseRepo, Notes, keyOf } = require('./integrations');
const { Boards } = require('./boards');
const { Rules, renderOwnerRules, sources: ruleSources, readText: readRuleText } = require('./rules');
const { PrWatch } = require('./prwatch');
const explorer = require('./explorer');
const team = require('./team');
const providers = require('./providers');
const globalsettings = require('./globalsettings');
const { Secrets, electronEncryptor } = require('./secrets');

let pty = null, ptyError = null;
try { pty = require('node-pty'); } catch (e) { ptyError = String(e && e.message || e); }

const DATA_DIR = path.join(os.homedir(), '.claude', 'mission-control');
const PROJ_DIR_ROOT = path.join(os.homedir(), '.claude', 'projects');
const START_VIEW = (() => { const i = process.argv.indexOf('--view'); return i >= 0 ? process.argv[i + 1] : null; })();
const REGISTRY = path.join(DATA_DIR, 'projects.json');
const SEEN = path.join(DATA_DIR, 'seen-projects.json');
const WINSTATE = path.join(DATA_DIR, 'window.json');
const SCREENSHOT = (() => { const i = process.argv.indexOf('--screenshot'); return i >= 0 ? (process.argv[i + 1] || 'screenshot.png') : null; })();
const SCREENSHOT_WAIT = (() => { const i = process.argv.indexOf('--wait'); return i >= 0 ? Number(process.argv[i + 1]) || 4500 : 4500; })();
// Screenshot mode is the smoke test (test/smoke.js). Give it its own Chromium profile so it never
// fights the cache of a Mission Control that is already running. setPath must happen before app ready.
// DATA_DIR is untouched: the shot must show the real projects and boards.
let rendererFailed = false, shotProfile = null;
if (SCREENSHOT) {
  try { shotProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-shot-')); app.setPath('userData', shotProfile); app.setPath('sessionData', shotProfile); }
  catch (e) { console.error('screenshot profile', e && e.message); }
}
/** Screenshot mode only: bin this run's throwaway profile, and stale ones earlier runs could not delete. */
function sweepShotProfiles() {
  let names = []; try { names = fs.readdirSync(os.tmpdir()); } catch { return; }
  for (const d of names) {
    if (!d.startsWith('mc-shot-')) continue;
    const dir = path.join(os.tmpdir(), d);
    // leave alone anything a concurrent run may still be using
    try { if (dir !== shotProfile && Date.now() - fs.statSync(dir).mtimeMs < 10 * 60 * 1000) continue; } catch { continue; }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use; the next run gets it */ }
  }
}
/** Screenshot mode only: print renderer problems where the smoke test can see them, and fail the run. */
function rendererError(text) { rendererFailed = true; console.error('RENDERER ERROR: ' + String(text).replace(/[\r\n]+/g, ' ')); } // one line, so the test can grep for it
function watchRendererErrors(wc) {
  // Electron 38: the listener gets a details object ({ message, level, lineNumber, sourceId }); the old
  // positional (level, message, line, sourceId) args are deprecated.
  wc.on('console-message', (details) => { if (details && details.level === 'error') rendererError(`console ${details.sourceId || '?'}:${details.lineNumber || 0} ${details.message}`); });
  wc.on('render-process-gone', (_e, details) => rendererError(`render process gone: ${details && details.reason} (exit ${details && details.exitCode})`));
  wc.on('preload-error', (_e, preloadPath, error) => rendererError(`preload ${preloadPath}: ${(error && error.stack) || error}`));
}
// Orchestrator rules: appended to the lead session's system prompt (claude --append-system-prompt-file).
// The default ships in ./kit; the copy under DATA_DIR is the one that is used, so the owner can edit it.
const KIT_DIR = path.join(__dirname, 'kit');
const KIT_FILE = path.join(DATA_DIR, 'orchestrator-system.md');         // shipped rules, refreshed at every start ({{DATA_DIR}} filled in)
const KIT_LOCAL = path.join(DATA_DIR, 'orchestrator-system.local.md');  // the owner's additions, never overwritten
const NOTE_SCRIPT = path.join(DATA_DIR, 'mc-note.js');                  // the orchestrator's line to the inbox
function ensureKit() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KIT_FILE, fs.readFileSync(path.join(KIT_DIR, 'orchestrator-system.md'), 'utf8').split('{{DATA_DIR}}').join(DATA_DIR));
    fs.copyFileSync(path.join(KIT_DIR, 'mc-note.js'), NOTE_SCRIPT);
    fs.copyFileSync(path.join(KIT_DIR, 'mc-board.js'), path.join(DATA_DIR, 'mc-board.js'));
    if (!fs.existsSync(KIT_LOCAL)) fs.writeFileSync(KIT_LOCAL, '# Your additions to the orchestrator rules\n\nEverything below is appended to every lead session\'s system prompt after the Mission Control rules. Edit freely; Mission Control never overwrites this file.\n');
  } catch (e) { console.error('kit', e && e.message); }
}
const settings = new Settings(path.join(DATA_DIR, 'project-settings.json'));
// Accounts & AI (docs/ACCOUNTS-CONTRACT.md): API keys encrypted with safeStorage, and the machine-wide
// defaults (which providers a project may use when its own settings say nothing).
const GLOBAL_SETTINGS = path.join(DATA_DIR, 'settings.json');
const secrets = new Secrets(path.join(DATA_DIR, 'secrets.json'), electronEncryptor(safeStorage));
function globalSettings() { const d = readJson(GLOBAL_SETTINGS, {}); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; }
const github = new GitHub();
const notes = new Notes(path.join(DATA_DIR, 'notes.jsonl'));
const boards = new Boards(path.join(DATA_DIR, 'boards'));
const rules = new Rules(path.join(DATA_DIR, 'rules'));
const BOARD_SCRIPT = path.join(DATA_DIR, 'mc-board.js');
const gitCache = new Map(); // project key -> { remote, branch, at }
const prCache = new Map();  // project key -> { prs, error, at }
/** The account for a project: the chosen one, else the login embedded in the remote URL (https://login@github.com/...) if gh knows it. */
async function effectiveAccount(s, remote) {
  if (s.ghAccount) return s.ghAccount;
  const m = /\/\/([^@/:]+)@github\.com/i.exec(remote || ''); if (!m) return null;
  const known = (await github.listAccounts(false)).find((a) => a.login.toLowerCase() === m[1].toLowerCase());
  return known ? known.login : null;
}

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); }

let win = null;
const watcher = new TranscriptWatcher({ hours: 48 });
// memory: checkpoint (current state) + journal (history) per project, fed by transcripts and by everything below
const checkpoints = new CheckpointWriter(watcher, {
  projRoot: PROJ_DIR_ROOT,
  context: (p) => { const k = keyOf(p); const s = settings.get(p); const g = gitCache.get(k); const pr = prCache.get(k); const repo = parseRepo(s.repo || (g && g.remote)); return { board: boards.load(p), notes: notes.forProject(p), inflight: repo ? prwatch.inflight(repo.full) : [], repo, account: (pr && pr.account) || s.ghAccount || null, branch: g && g.branch, settings: s }; },
});
const prwatch = new PrWatch({ github, notes, boards, file: path.join(DATA_DIR, 'prwatch.json'), onNote: (p, text) => checkpoints.journal(p, `PR watch · ${text}`) });
const ptys = new Map(); // id -> { proc, cwd, projectKey }
let ptySeq = 0;

function registry() { const r = readJson(REGISTRY, []); return Array.isArray(r) ? r : []; }

// ── seen projects: every project Mission Control has ever watched a session in, so the sidebar never loses one.
// Transcript discovery only reaches back 48 h, so without this an auto-discovered project disappears after two idle
// days. Seen projects are merged into the snapshot (flag `seen: true`, `pinned` untouched) and never drive polling.
const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
let seenCache = null;
function seenStore() {
  if (!seenCache) {
    const r = readJson(SEEN, null);
    seenCache = r && typeof r === 'object' && !Array.isArray(r) ? r : { projects: Array.isArray(r) ? r : [], hidden: [] };
    if (!Array.isArray(seenCache.projects)) seenCache.projects = [];
    if (!Array.isArray(seenCache.hidden)) seenCache.hidden = [];
  }
  return seenCache;
}
function saveSeen() { try { writeJson(SEEN, seenStore()); } catch (e) { console.error('seen-projects', e && e.message); } }
function hiddenSet() { return new Set(seenStore().hidden.map(norm)); }
/** Seen projects worth injecting into a snapshot: known path, not hidden. */
function seenList() { const hid = hiddenSet(); return seenStore().projects.filter((x) => x.path && !hid.has(norm(x.path))); }
// lastSeen only has to be good enough for the sidebar's "idle since" badge, so it is written at most once a minute
// per project: without this the file is rewritten on nearly every snapshot tick while a session is talking.
const SEEN_LAST_MS = 60 * 1000;
/** Record (or refresh) every project the snapshot actually has sessions for. */
function recordSeen(snap) {
  const st = seenStore(); let dirty = false; const now = Date.now();
  for (const p of snap.projects) {
    if (!p.path || !p.sessions.length) continue; // only real, observed projects — not the ones we just injected
    const k = norm(p.path);
    const lastMs = p.lastActivity || now;
    const last = new Date(lastMs).toISOString();
    let rec = st.projects.find((x) => norm(x.path) === k);
    if (!rec) { st.projects.push({ path: p.path, name: p.name, slug: p.slug || null, firstSeen: last, lastSeen: last }); dirty = true; continue; }
    if (Math.abs(lastMs - (Date.parse(rec.lastSeen) || 0)) > SEEN_LAST_MS) { rec.lastSeen = last; dirty = true; }
    if (p.slug && rec.slug !== p.slug) { rec.slug = p.slug; dirty = true; }
    if (p.name && rec.name !== p.name) { rec.name = p.name; dirty = true; }
  }
  if (dirty) saveSeen();
}
function enrich(snap) {
  for (const p of snap.projects) {
    if (!p.path) { p.notes = []; continue; }
    const k = keyOf(p.path); const s = settings.get(p.path); const g = gitCache.get(k); const pr = prCache.get(k);
    p.settings = { ...s, account: (pr && pr.account) || s.ghAccount || null }; p.branch = g ? g.branch : null; p.remote = g ? g.remote : null;
    p.repo = parseRepo(s.repo || (g && g.remote));
    p.prs = pr ? pr.prs : []; p.prsError = pr ? pr.error || null : null; p.prsAt = pr ? pr.at : 0;
    p.inflight = p.repo ? prwatch.inflight(p.repo.full) : [];
    p.notes = notes.forProject(p.path);
    p.boardCounts = boards.counts(p.path);
    p.ruleCount = rules.count(p.path);   // Rules tab badge; read every time on purpose: same-millisecond writes share an mtime, so a cache showed a stale badge
  }
  snap.openNotes = notes.open().length;
  return snap;
}
function snapshot() {
  const snap = watcher.snapshot(registry(), seenList());
  recordSeen(snap);
  const hid = hiddenSet();
  snap.projects = snap.projects.filter((p) => p.pinned || !hid.has(norm(p.path))); // "Hide" only applies to unpinned projects
  return enrich(snap);
}
function sendSnapshot() { if (win && !win.isDestroyed()) win.webContents.send('snapshot', snapshot()); }
// git remotes/branches and open PRs for projects that matter right now (active in the last 12 h or pinned)
let refreshing = false;
async function refreshIntegrations(force) {
  if (refreshing) return; refreshing = true;
  try {
    // deliberately without seenList(): a project that is only remembered for the sidebar never costs a git or gh call
    const snap = watcher.snapshot(registry()); const now = Date.now(); let changed = false;
    for (const p of snap.projects) {
      if (!p.path || !(p.pinned || now - p.lastActivity < 12 * 3600 * 1000)) continue;
      const k = keyOf(p.path); const g = gitCache.get(k);
      if (force || !g || now - g.at > 30000) { gitCache.set(k, await gitInfo(p.path)); changed = true; }
      const s = settings.get(p.path); const repo = parseRepo(s.repo || (gitCache.get(k) || {}).remote);
      if (!repo) { if (prCache.delete(k)) changed = true; continue; }
      const pr = prCache.get(k);
      if (force || !pr || now - pr.at > 60000) {
        const account = await effectiveAccount(s, (gitCache.get(k) || {}).remote); const r = await github.prList(repo.full, account); prCache.set(k, { ...r, account, at: Date.now() }); changed = true;
        if (!r.error) { try { await prwatch.tick({ project: p.path, repo, account, prs: r.prs, workers: p.workers }); } catch (e) { console.error('prwatch', e && e.message); } }
      }
    }
    if (changed) sendSnapshot();
  } catch (e) { console.error('integrations', e && e.message); }
  finally { refreshing = false; }
}

function createWindow() {
  const st = readJson(WINSTATE, {});
  win = new BrowserWindow({
    width: st.width || 1680, height: st.height || 980, x: st.x, y: st.y,
    minWidth: 1100, minHeight: 640,
    backgroundColor: '#0d1117', title: 'Mission Control', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  if (SCREENSHOT) watchRendererErrors(win.webContents);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  const save = () => { if (!win || win.isDestroyed() || win.isMinimized()) return; const b = win.getBounds(); writeJson(WINSTATE, b); };
  win.on('resize', save); win.on('move', save);
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('env', { ptyAvailable: !!pty, ptyError, home: os.homedir(), platform: process.platform, startView: START_VIEW, dataDir: DATA_DIR, kitFile: KIT_FILE, kitLocal: KIT_LOCAL, noteScript: NOTE_SCRIPT, version: app.getVersion(), electron: process.versions.electron });
    sendSnapshot();
    setTimeout(() => probeProviders(false), 600);   // accounts & AI: first probe round, pushed result by result
    if (SCREENSHOT) setTimeout(async () => {
      let shotFailed = false;
      try {
        // An occluded or not-yet-composited window captures as an empty image (seen roughly 1 run in 6),
        // which would make the smoke test flaky. Retry until there are real pixels.
        let buf = null;
        for (let i = 0; i < 10 && !(buf && buf.length > 1024); i++) {
          if (i) await new Promise((r) => setTimeout(r, 300));
          const img = await win.webContents.capturePage();
          buf = img.isEmpty() ? null : img.toPNG();
        }
        if (!buf || !buf.length) throw new Error('capturePage kept returning an empty image');
        fs.writeFileSync(path.resolve(SCREENSHOT), buf); console.log('screenshot written', path.resolve(SCREENSHOT));
      }
      catch (e) { shotFailed = true; console.error('screenshot failed', e); }
      killAllPtys(); watcher.stop(); sweepShotProfiles(); app.exit(rendererFailed || shotFailed ? 1 : 0); // the PNG is written either way, so a human can look
    }, SCREENSHOT_WAIT);
  });
}

// ── transcripts → renderer
let snapshotTimer = null;
watcher.on('changed', () => { if (snapshotTimer) return; snapshotTimer = setTimeout(() => { snapshotTimer = null; sendSnapshot(); }, 400); });
watcher.on('lines', (payload) => { if (win && !win.isDestroyed()) win.webContents.send('lines', payload); });
watcher.on('error', (e) => console.error('watcher', e));
setInterval(sendSnapshot, 5000); // statuses age even without new lines

ipcMain.handle('snapshot', () => snapshot());
setInterval(() => refreshIntegrations(false), 15000);
setInterval(() => { if (notes.poll()) sendSnapshot(); }, 1500);
const boardSeen = new Map(); // project key -> { tickets: Map id->status, todos: Map id->done } to journal changes made by mc-board.js
function journalBoardDiff(b) {
  const k = keyOf(b.project); const prev = boardSeen.get(k);
  const cur = { tickets: new Map(b.tickets.map((t) => [t.id, t.status])), todos: new Map(b.todos.map((t) => [t.id, !!t.done])) };
  if (prev) {
    for (const t of b.tickets) { const was = prev.tickets.get(t.id); if (was === undefined) checkpoints.journal(b.project, `board · ticket added ${t.id} [${t.status}] ${t.title}${t.risk ? ' · risk ' + t.risk : ''}`); else if (was !== t.status) checkpoints.journal(b.project, `board · ${t.id} ${was} → ${t.status}: ${t.title}${t.pr ? ' · ' + t.pr : ''}`); }
    for (const t of b.todos) { const was = prev.todos.get(t.id); if (was === undefined) checkpoints.journal(b.project, `board · todo added ${t.id} ${t.text} (${t.owner})`); else if (was !== !!t.done) checkpoints.journal(b.project, `board · todo ${t.id} ${t.done ? 'done' : 'reopened'}: ${t.text}`); }
  }
  boardSeen.set(k, cur);
}
setInterval(() => {
  const changed = boards.poll(); if (changed.length) { for (const b of changed) journalBoardDiff(b); if (win && !win.isDestroyed()) { for (const b of changed) win.webContents.send('board', b); sendSnapshot(); } }
  // the same cadence for the owner's rules: kit/mc-board.js writes that file too (docs/RULES-CONTRACT.md)
  const rulesChanged = rules.poll(); if (rulesChanged.length && win && !win.isDestroyed()) for (const r of rulesChanged) win.webContents.send('rules', { path: r.project, rules: r });
}, 2000);

// ── tickets & todos board
ipcMain.handle('board:get', (_e, p) => boards.load(p));
ipcMain.handle('board:add', (_e, { path: p, kind, items }) => { checkpoints.journal(p, `board · owner added ${items.length} ${kind}${items.length === 1 ? '' : 's'}: ${items.map((i) => typeof i === 'string' ? i : i.title).join('; ').slice(0, 200)}`); return kind === 'todo' ? boards.addTodos(p, items, 'owner') : boards.addTickets(p, items, 'owner'); });
ipcMain.handle('board:patch', (_e, { path: p, kind, id, patch }) => { const b = boards.patch(p, kind, id, patch); const it = (kind === 'todo' ? b.todos : b.tickets).find((x) => x.id === id); if (it && (patch.status || patch.done !== undefined)) checkpoints.journal(p, `board · owner marked ${id} ${patch.status || (patch.done ? 'done' : 'reopened')}: ${it.title || it.text}`); return b; });
ipcMain.handle('board:remove', (_e, { path: p, kind, id }) => boards.remove(p, kind, id));

// ── owner rules per project (docs/RULES-CONTRACT.md). The same file is written by kit/mc-board.js.
ipcMain.handle('rules:get', (_e, p) => rules.load(p));
ipcMain.handle('rules:add', (_e, { path: p, text }) => { const before = rules.load(p).rules.length; const r = rules.add(p, text, 'owner', 'ui'); const added = r.rules.length > before ? r.rules[r.rules.length - 1] : null; if (added) checkpoints.journal(p, `rules · owner added ${added.id}: ${added.text.slice(0, 200)}`); return r; });
ipcMain.handle('rules:patch', (_e, { path: p, id, patch }) => rules.patch(p, id, patch || {}));
ipcMain.handle('rules:remove', (_e, { path: p, id }) => { const before = rules.load(p).rules.find((x) => x.id === id); const r = rules.remove(p, id); if (before) checkpoints.journal(p, `rules · owner removed ${before.id}: ${String(before.text || '').slice(0, 200)}`); return r; });
ipcMain.handle('rules:reorder', (_e, { path: p, ids }) => rules.reorder(p, ids));
ipcMain.handle('rules:sources', (_e, p) => ruleSources(p, { kitFile: KIT_FILE, kitLocal: KIT_LOCAL, generatedDir: path.join(DATA_DIR, 'generated'), key: keyOf(p) }));
// The viewer reads only inside a known project, the two kit files, or DATA_DIR/generated — nothing else in
// DATA_DIR (tokens live in project-settings.json). `project` is optional; the registry covers the one-arg call.
function readerRoots(project) {
  const known = [...registry().map((x) => x.path), ...seenList().map((x) => x.path)].filter(Boolean);
  return [KIT_FILE, KIT_LOCAL, path.join(DATA_DIR, 'generated'), ...(project ? [project] : []), ...known];
}
ipcMain.handle('rules:read', (_e, arg) => { const p = typeof arg === 'string' ? arg : (arg && arg.path); const project = typeof arg === 'object' && arg ? arg.project : null; return readRuleText(p, readerRoots(project)); });
// Settings -> Global rules edits exactly one file, the owner's additions to every lead's rulebook. The
// renderer sends the path it was given in `env`; globalsettings.writeLocalRules refuses anything else.
ipcMain.handle('rules:writeLocal', (_e, { path: p, text } = {}) => globalsettings.writeLocalRules(p, KIT_LOCAL, text));

// ── repo, GitHub account, git identity per project
ipcMain.handle('gh:accounts', () => github.listAccounts(true));
ipcMain.handle('settings:get', (_e, p) => settings.get(p));
ipcMain.handle('settings:set', async (_e, { path: p, patch }) => {
  const cur = settings.get(p); const next = { ...patch };
  if (next.ghAccount && (next.ghAccount !== cur.ghAccount || !cur.gitName) && !next.gitName) { const u = await github.user(next.ghAccount); if (u) { next.gitName = next.gitName || u.name; next.gitEmail = next.gitEmail || u.email; } }
  const saved = settings.set(p, next); refreshIntegrations(true); return saved;
});
ipcMain.handle('open:url', (_e, u) => { if (/^https:\/\//i.test(String(u))) shell.openExternal(String(u)); return true; });

// ── team & models: roles the lead can dispatch, each with its model and effort
ipcMain.handle('team:get', (_e, p) => ({ roster: team.roster(p, settings.get(p).models || {}), models: team.MODELS, efforts: team.EFFORTS }));
ipcMain.handle('team:set', (_e, { path: p, name, model, effort }) => {
  const r = team.roster(p, settings.get(p).models || {}).find((x) => x.name === name); if (!r) return null;
  if (r.source === 'agent') team.setAgentModel(r.file, { model: model || '', effort: effort || '' });
  else { const s = settings.get(p); const models = { ...(s.models || {}) }; if (model || effort) models[name] = { model: model || null, effort: effort || null }; else delete models[name]; settings.set(p, { models }); }
  checkpoints.journal(p, `team · owner set ${name} → ${model || 'inherit'} / ${effort || 'default'}`);
  return team.roster(p, settings.get(p).models || {});
});

// ── accounts & AI: the provider registry, its status probes, the API keys and per-project enablement
// (docs/ACCOUNTS-CONTRACT.md). Nothing here throws across IPC and no key value ever crosses it: the
// renderer learns `has` and `setAt`, the plain text only ever reaches a terminal's environment.
// The dialogs must never wait for a probe: `providers:list` answers from the cache in the same tick, with
// `checking` for anything nobody has asked yet, and the probe round pushes each answer as it lands.
function providersPayload() {
  let status = {};
  try { status = providers.cachedStatus(secrets.info()); } catch (e) { console.error('providers', e && e.message); }
  return { providers: providers.list(), status, secrets: secrets.info(), encryption: secrets.available(), global: globalSettings().providers || {} };
}
let probing = false;
/** Start a probe round if one is not already running; every result is pushed the moment it arrives. */
function probeProviders(force) {
  if (probing && !force) return;
  probing = true;
  providers.refreshStatuses({
    force,
    onResult: (id, st) => { if (win && !win.isDestroyed()) win.webContents.send('providers', { status: { [id]: st }, partial: true }); },
  }).catch((e) => console.error('providers', e && e.message)).then(() => { probing = false; });
}
/** Push what we know now, and (optionally) start a fresh round behind it. */
function sendProviders(force) {
  if (win && !win.isDestroyed()) win.webContents.send('providers', providersPayload());
  setTimeout(() => probeProviders(!!force), 0);
}
ipcMain.handle('providers:list', () => { const p = providersPayload(); setTimeout(() => probeProviders(false), 0); return p; });
ipcMain.handle('providers:refresh', () => { const p = providersPayload(); setTimeout(() => probeProviders(true), 0); return p; });
/** A login or install runs where the owner can see it and answer it: a real terminal tab in the project. */
async function providerTerminal(id, projectPath, line) {
  if (!line) return { error: 'nothing to run for ' + id };
  const dir = projectPath && fs.existsSync(projectPath) ? projectPath : os.homedir();
  try {
    const ptyId = await spawnPty({ cwd: dir, provider: id });
    // the shell needs a moment before it reads stdin, or the line lands in front of the prompt
    setTimeout(() => { const p = ptys.get(ptyId); if (p) p.proc.write(line + '\r'); }, 400);
    return { ptyId, line, cwd: dir };
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 200) }; }
}
ipcMain.handle('providers:login', async (_e, { id, path: projectPath } = {}) => {
  const status = (await providers.statusAll({ keyInfo: secrets.info() }))[id] || null;
  return providerTerminal(id, projectPath, providers.loginLine(id, status));
});
ipcMain.handle('providers:install', async (_e, { id, path: projectPath } = {}) => providerTerminal(id, projectPath, providers.installLine(id)));
ipcMain.handle('secrets:set', async (_e, { id, value } = {}) => {
  if (!providers.byId(id) || providers.byId(id).kind !== 'key') return { error: 'unknown key provider: ' + id };
  const r = secrets.set(id, value);
  if (r.ok && win && !win.isDestroyed()) win.webContents.send('providers', providersPayload());   // key rows only; no re-probe
  return r;
});
ipcMain.handle('secrets:remove', (_e, { id } = {}) => { const r = secrets.remove(id); if (r.ok && win && !win.isDestroyed()) win.webContents.send('providers', providersPayload()); return r; });
/** `path` null means the machine-wide default; a project's own setting always wins over it. */
ipcMain.handle('providers:enable', (_e, { path: p, id, enabled } = {}) => {
  if (!providers.byId(id)) return { error: 'unknown provider: ' + id };
  if (p) { const s = settings.get(p); const next = { ...(s.providers || {}), [id]: !!enabled }; settings.set(p, { providers: next }); return { path: p, providers: next }; }
  const g = globalSettings(); g.providers = { ...(g.providers || {}), [id]: !!enabled }; writeJson(GLOBAL_SETTINGS, g);
  return { path: null, providers: g.providers };
});

// ── inbox: the owner answers or dismisses the orchestrator's notes
ipcMain.handle('notes:answer', (_e, { id, answer }) => {
  const n = notes.get(id); if (!n) return null;
  const ts = new Date().toISOString();
  notes.append({ kind: 'answer', id, ts, answer: String(answer || '').slice(0, 4000), by: 'owner' });
  notes.append({ kind: 'dismiss', id, ts });
  checkpoints.journal(n.project, `inbox · owner answered ${n.type} "${n.title}" → ${answer}`);
  sendSnapshot(); return { ...n, answer };
});
// the orchestrator's own notes reach the journal when they appear in notes.jsonl
let journaledNotes = new Set();
setInterval(() => { for (const n of notes.open()) { if (journaledNotes.has(n.id)) continue; journaledNotes.add(n.id); if (n.source !== 'mission-control') checkpoints.journal(n.project, `inbox · orchestrator posted ${n.type} "${n.title}"`, new Date(n.ts).getTime()); } if (journaledNotes.size > 5000) journaledNotes = new Set([...journaledNotes].slice(-2000)); }, 3000);
ipcMain.handle('notes:dismiss', (_e, { id }) => { if (notes.get(id)) { notes.append({ kind: 'dismiss', id, ts: new Date().toISOString() }); sendSnapshot(); } return true; });

// ── lead launch: rules + the owner's additions + this project's context, in one file for --append-system-prompt-file
ipcMain.handle('lead:prepare', async (_e, arg) => {
  const p = typeof arg === 'string' ? arg : arg.path; const leadName = (arg && arg.name) || null;
  const k = keyOf(p); const s = settings.get(p);
  const g = gitCache.get(k) || await gitInfo(p); gitCache.set(k, g);
  const repo = parseRepo(s.repo || g.remote);
  const account = await effectiveAccount(s, g.remote);
  if (account && !s.ghAccount) { const u = await github.user(account); if (u) Object.assign(s, { ghAccount: account, gitName: s.gitName || u.name, gitEmail: s.gitEmail || u.email, inferred: true }); }
  const ownerRules = renderOwnerRules(rules.load(p));
  const base = fs.readFileSync(KIT_FILE, 'utf8');
  let local = ''; try { local = fs.readFileSync(KIT_LOCAL, 'utf8'); } catch { local = ''; }
  const ctx = [
    '', '', '# This project (filled in by Mission Control at launch)', '',
    `- Project: ${path.basename(p)} · path: ${p}`,
    leadName ? `- Your name in Mission Control is **${leadName}**, Lead Orchestrator of this project. Workers appear with their own generated names and titles; the owner will refer to you and to them by those names. Sign inbox notes and plans as ${leadName}.` : '',
    repo ? `- GitHub repository: ${repo.full} (${repo.url}). Current branch: ${g.branch || '?'}.` : '- No GitHub remote is configured for this project. Do not create one on your own; post a decision note first.',
    s.ghAccount
      ? `- GitHub account for this project: "${s.ghAccount}"${s.inferred ? ' (taken from the remote URL; the owner can change it in Mission Control)' : ''}, git identity ${s.gitName || s.ghAccount} <${s.gitEmail || ''}>. Its token is in this terminal's environment (GH_TOKEN${s.inferred ? '' : ', GIT_AUTHOR_* and GIT_COMMITTER_*'}), so gh and git push act as that account. Never run "gh auth switch" and never change git config user.* globally; other projects use other accounts at the same time.`
      : '- No GitHub account was chosen for this project in Mission Control, so the machine default applies. Before the first push or PR, post a decision note asking which account to use.',
    `- Inbox script: node "${NOTE_SCRIPT}" (see the Inbox section of your rules). Mission Control's owner reads that inbox.`,
    `- Tickets & todos board: node "${BOARD_SCRIPT}" (see the Tickets section of your rules). The owner sees it in the Tickets and Todos tabs.`,
    '',
    // the owner's rules for this project, between the project block and the model assignments (docs/RULES-CONTRACT.md)
    ...(ownerRules ? [ownerRules, ''] : []),
    '## Model assignments for workers (owner-controlled in Mission Control → Team & models)',
    'Dispatch each role at the model and effort below: custom roles carry them in their .claude/agents frontmatter already; for built-in types pass the model with the Agent tool. "recommended" means the owner has not overridden Mission Control\'s recommendation. Escalation of a stuck worker to fable stays allowed per your rules.',
    ...team.roster(p, s.models || {}).map((r) => `- ${r.name}: ${r.model || r.recommended.model}${r.effort || r.recommended.effort ? ' / ' + (r.effort || r.recommended.effort) : ''}${r.model ? (r.source === 'agent' ? ' (agent file)' : ' (owner-set)') : ' (recommended)'}`),
    '',
  ].join('\n');
  const dir = path.join(DATA_DIR, 'generated'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, k.replace(/[^a-z0-9]+/gi, '-') + '.md');
  fs.writeFileSync(file, base.trimEnd() + '\n\n' + local.trim() + ctx);
  return file;
});
ipcMain.handle('lines', (_e, { kind, id, afterSeq }) => watcher.lines(kind, id, afterSeq || 0));
// --view telemetry: the renderer reports when the requested view was actually on screen, and how long the
// first snapshot and the first project selection took. One line, so a screenshot run can be diagnosed.
ipcMain.on('view:ready', (_e, m = {}) => {
  const ms = (x) => (x == null ? '?' : Math.round(x) + 'ms');
  console.log(`VIEW READY ${m.view || '?'}${m.gaveUp ? ' (gave up waiting)' : ''} · env\u2192snapshot ${ms(m.toSnapshot)} · env\u2192selected ${ms(m.toSelected)} · env\u2192view ${ms(m.toView)} · env\u2192painted ${ms(m.toPainted)} · first render ${ms(m.render)} (workers ${ms(m.workers)}, ${m.workerCount == null ? '?' : m.workerCount} panes)`);
});

// ── project registry
ipcMain.handle('projects:add', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add a project folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  const reg = registry();
  if (!reg.some((x) => x.path.toLowerCase() === p.toLowerCase())) { reg.push({ path: p, name: path.basename(p), addedAt: new Date().toISOString() }); writeJson(REGISTRY, reg); }
  unhideProject(p); // re-adding a folder undoes a "Hide"
  sendSnapshot();
  return p;
});
ipcMain.handle('projects:remove', (_e, p) => { writeJson(REGISTRY, registry().filter((x) => x.path.toLowerCase() !== String(p).toLowerCase())); sendSnapshot(); return true; });
// "Hide" for a project Mission Control only remembers (not pinned): it stays in seen-projects.json but leaves the sidebar
function unhideProject(p) { const st = seenStore(); const n = st.hidden.filter((x) => norm(x) !== norm(p)); if (n.length !== st.hidden.length) { st.hidden = n; saveSeen(); } }
ipcMain.handle('projects:hide', (_e, p) => { const st = seenStore(); if (p && !st.hidden.some((x) => norm(x) === norm(p))) { st.hidden.push(String(p)); saveSeen(); } sendSnapshot(); return true; });
// Settings -> Hidden projects: the list the sidebar is not showing, and the way back into it
ipcMain.handle('projects:hidden', () => { const st = seenStore(); return globalsettings.hiddenRows(st.hidden, st.projects); });
ipcMain.handle('projects:unhide', (_e, p) => { const st = seenStore(); const next = globalsettings.unhide(st.hidden, p); if (next !== st.hidden) { st.hidden = next; saveSeen(); sendSnapshot(); } return globalsettings.hiddenRows(st.hidden, st.projects); });
ipcMain.handle('open:code', (_e, p) => { try { spawn('cmd.exe', ['/c', 'code', p], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; } catch (e) { return String(e); } });
ipcMain.handle('open:folder', (_e, p) => shell.openPath(p));

// ── explorer: files, git status, branches and branch diffs for the Explorer panel (docs/EXPLORER-CONTRACT.md).
// Thin wrappers; explorer.js never throws, so a failure arrives as an `error` field the renderer draws.
ipcMain.handle('explorer:list', (_e, { root, rel } = {}) => explorer.listDir(root, rel));
ipcMain.handle('explorer:status', (_e, root) => explorer.status(root));
ipcMain.handle('explorer:branches', (_e, root) => explorer.branches(root));
ipcMain.handle('explorer:diff', (_e, { root, branch } = {}) => explorer.diff(root, branch));
ipcMain.handle('open:file', (_e, { path: p, line } = {}) => explorer.openFile(p, line));

// ── memory (per-project notes under ~/.claude/projects/<slug>/memory)
function slugCandidates(projectPath, knownSlug) {
  const out = [];
  if (knownSlug) out.push(knownSlug);
  if (projectPath) {
    const base = projectPath.replace(/[\\/]+$/, '').replace(/[:\\/]/g, '-');
    out.push(base, base.charAt(0).toLowerCase() + base.slice(1), base.charAt(0).toUpperCase() + base.slice(1));
  }
  return [...new Set(out)];
}
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let curKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    const sub = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (kv) { curKey = kv[1]; meta[curKey] = kv[2].trim(); }
    else if (sub && curKey) { meta[curKey + '.' + sub[1]] = sub[2].trim(); }
  }
  return { meta, body: text.slice(m[0].length) };
}
ipcMain.handle('memory:read', (_e, { path: projectPath, slug }) => {
  for (const s of slugCandidates(projectPath, slug)) {
    const dir = path.join(PROJ_DIR_ROOT, s, 'memory');
    if (!fs.existsSync(dir)) continue;
    let index = ''; try { index = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'); } catch { /* none */ }
    const notes = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/\.md$/i.test(f) || /^MEMORY\.md$/i.test(f)) continue;
      const full = path.join(dir, f);
      let text = ''; let st = null;
      try { text = fs.readFileSync(full, 'utf8'); st = fs.statSync(full); } catch { continue; }
      const { meta, body } = parseFrontmatter(text);
      const links = [...new Set([...body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((x) => x[1].trim()))];
      notes.push({ file: full, filename: f, name: meta.name || f.replace(/\.md$/i, ''), description: meta.description || '', type: meta['metadata.type'] || meta.type || 'note', body, links, mtime: st ? st.mtimeMs : 0 });
    }
    return { exists: true, dir, slug: s, index, notes };
  }
  return { exists: false, dir: projectPath ? path.join(PROJ_DIR_ROOT, slugCandidates(projectPath, slug)[0], 'memory') : null, slug: null, index: '', notes: [] };
});
ipcMain.handle('open:path', (_e, p) => shell.openPath(p));

// ── terminals (node-pty)
/** One terminal. `provider` marks a login/install shell so its exit re-probes the accounts (T-019). */
async function spawnPty({ cwd, cols, rows, shellPath, provider = null } = {}) {
  if (!pty) throw new Error('node-pty unavailable: ' + ptyError);
  const id = 'pty' + (++ptySeq);
  const sh = shellPath || (process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash'));
  const args = process.platform === 'win32' && /powershell/i.test(sh) ? ['-NoLogo'] : [];
  let dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  // per-project GitHub account and git identity, scoped to this terminal only
  const base = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  const s = settings.get(dir);
  const account = await effectiveAccount(s, (gitCache.get(keyOf(dir)) || await gitInfo(dir)).remote);
  if (account) { const t = await github.token(account); if (t) base.GH_TOKEN = t; }
  if (s.gitName) { base.GIT_AUTHOR_NAME = s.gitName; base.GIT_COMMITTER_NAME = s.gitName; }
  if (s.gitEmail) { base.GIT_AUTHOR_EMAIL = s.gitEmail; base.GIT_COMMITTER_EMAIL = s.gitEmail; }
  // … then the stored API keys of every provider this project may use. assembleEnv never overwrites a
  // variable that already has a value, so a key exported in the owner's own shell still wins.
  const env = providers.assembleEnv({ base, secrets: secrets.map(), projectSettings: s, globalSettings: globalSettings() });
  const proc = pty.spawn(sh, args, { name: 'xterm-256color', cols: cols || 120, rows: rows || 30, cwd: dir, env, useConpty: true });
  ptys.set(id, { proc, cwd: dir, provider });
  proc.onData((d) => { if (win && !win.isDestroyed()) win.webContents.send('pty:data', { id, data: d }); });
  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (win && !win.isDestroyed()) win.webContents.send('pty:exit', { id, exitCode });
    // a login or install shell just ended: the tool's state has probably changed, so re-probe and push
    if (provider) setTimeout(() => sendProviders(true), 800);
  });
  return id;
}
ipcMain.handle('pty:create', async (_e, opts) => spawnPty(opts || {}));
ipcMain.on('pty:write', (_e, { id, data }) => { const p = ptys.get(id); if (p) p.proc.write(data); });
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => { const p = ptys.get(id); if (p && cols > 0 && rows > 0) { try { p.proc.resize(cols, rows); } catch { /* ignore */ } } });
ipcMain.on('pty:kill', (_e, { id }) => { const p = ptys.get(id); if (p) { try { p.proc.kill(); } catch { /* ignore */ } ptys.delete(id); } });

function killAllPtys() { for (const p of ptys.values()) { try { p.proc.kill(); } catch { /* ignore */ } } ptys.clear(); }
app.whenReady().then(() => { ensureKit(); notes.poll(); watcher.start(); checkpoints.start(); createWindow(); setTimeout(() => refreshIntegrations(true), 1500); });
app.on('window-all-closed', () => { killAllPtys(); watcher.stop(); checkpoints.stop(); app.quit(); });
app.on('before-quit', () => { killAllPtys(); });

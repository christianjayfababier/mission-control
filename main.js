'use strict';
const electron = require('electron');
if (!electron || !electron.app) {
  console.error('Mission Control must run under Electron. If ELECTRON_RUN_AS_NODE is set in this shell, unset it first.');
  process.exit(2);
}
const { app, BrowserWindow, ipcMain, dialog, shell } = electron;
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { TranscriptWatcher } = require('./transcripts');
const { CheckpointWriter } = require('./checkpoint');
const { Settings, GitHub, gitInfo, parseRepo, Notes, keyOf } = require('./integrations');

let pty = null, ptyError = null;
try { pty = require('node-pty'); } catch (e) { ptyError = String(e && e.message || e); }

const DATA_DIR = path.join(os.homedir(), '.claude', 'mission-control');
const PROJ_DIR_ROOT = path.join(os.homedir(), '.claude', 'projects');
const START_VIEW = (() => { const i = process.argv.indexOf('--view'); return i >= 0 ? process.argv[i + 1] : null; })();
const REGISTRY = path.join(DATA_DIR, 'projects.json');
const WINSTATE = path.join(DATA_DIR, 'window.json');
const SCREENSHOT = (() => { const i = process.argv.indexOf('--screenshot'); return i >= 0 ? (process.argv[i + 1] || 'screenshot.png') : null; })();
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
    if (!fs.existsSync(KIT_LOCAL)) fs.writeFileSync(KIT_LOCAL, '# Your additions to the orchestrator rules\n\nEverything below is appended to every lead session\'s system prompt after the Mission Control rules. Edit freely; Mission Control never overwrites this file.\n');
  } catch (e) { console.error('kit', e && e.message); }
}
const settings = new Settings(path.join(DATA_DIR, 'project-settings.json'));
const github = new GitHub();
const notes = new Notes(path.join(DATA_DIR, 'notes.jsonl'));
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
const ptys = new Map(); // id -> { proc, cwd, projectKey }
let ptySeq = 0;

function registry() { const r = readJson(REGISTRY, []); return Array.isArray(r) ? r : []; }
function enrich(snap) {
  for (const p of snap.projects) {
    if (!p.path) { p.notes = []; continue; }
    const k = keyOf(p.path); const s = settings.get(p.path); const g = gitCache.get(k); const pr = prCache.get(k);
    p.settings = { ...s, account: (pr && pr.account) || s.ghAccount || null }; p.branch = g ? g.branch : null; p.remote = g ? g.remote : null;
    p.repo = parseRepo(s.repo || (g && g.remote));
    p.prs = pr ? pr.prs : []; p.prsError = pr ? pr.error || null : null; p.prsAt = pr ? pr.at : 0;
    p.notes = notes.forProject(p.path);
  }
  snap.openNotes = notes.open().length;
  return snap;
}
function snapshot() { return enrich(watcher.snapshot(registry())); }
function sendSnapshot() { if (win && !win.isDestroyed()) win.webContents.send('snapshot', snapshot()); }
// git remotes/branches and open PRs for projects that matter right now (active in the last 12 h or pinned)
let refreshing = false;
async function refreshIntegrations(force) {
  if (refreshing) return; refreshing = true;
  try {
    const snap = watcher.snapshot(registry()); const now = Date.now(); let changed = false;
    for (const p of snap.projects) {
      if (!p.path || !(p.pinned || now - p.lastActivity < 12 * 3600 * 1000)) continue;
      const k = keyOf(p.path); const g = gitCache.get(k);
      if (force || !g || now - g.at > 30000) { gitCache.set(k, await gitInfo(p.path)); changed = true; }
      const s = settings.get(p.path); const repo = parseRepo(s.repo || (gitCache.get(k) || {}).remote);
      if (!repo) { if (prCache.delete(k)) changed = true; continue; }
      const pr = prCache.get(k);
      if (force || !pr || now - pr.at > 60000) { const account = await effectiveAccount(s, (gitCache.get(k) || {}).remote); const r = await github.prList(repo.full, account); prCache.set(k, { ...r, account, at: Date.now() }); changed = true; }
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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  const save = () => { if (!win || win.isDestroyed() || win.isMinimized()) return; const b = win.getBounds(); writeJson(WINSTATE, b); };
  win.on('resize', save); win.on('move', save);
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('env', { ptyAvailable: !!pty, ptyError, home: os.homedir(), platform: process.platform, startView: START_VIEW, dataDir: DATA_DIR, kitFile: KIT_FILE, kitLocal: KIT_LOCAL, noteScript: NOTE_SCRIPT });
    sendSnapshot();
    if (SCREENSHOT) setTimeout(async () => {
      try { const img = await win.webContents.capturePage(); fs.writeFileSync(path.resolve(SCREENSHOT), img.toPNG()); console.log('screenshot written', path.resolve(SCREENSHOT)); }
      catch (e) { console.error('screenshot failed', e); }
      killAllPtys(); watcher.stop(); app.exit(0);
    }, 4500);
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

// ── repo, GitHub account, git identity per project
ipcMain.handle('gh:accounts', () => github.listAccounts(true));
ipcMain.handle('settings:get', (_e, p) => settings.get(p));
ipcMain.handle('settings:set', async (_e, { path: p, patch }) => {
  const cur = settings.get(p); const next = { ...patch };
  if (next.ghAccount && (next.ghAccount !== cur.ghAccount || !cur.gitName) && !next.gitName) { const u = await github.user(next.ghAccount); if (u) { next.gitName = next.gitName || u.name; next.gitEmail = next.gitEmail || u.email; } }
  const saved = settings.set(p, next); refreshIntegrations(true); return saved;
});
ipcMain.handle('open:url', (_e, u) => { if (/^https:\/\//i.test(String(u))) shell.openExternal(String(u)); return true; });

// ── inbox: the owner answers or dismisses the orchestrator's notes
ipcMain.handle('notes:answer', (_e, { id, answer }) => {
  const n = notes.get(id); if (!n) return null;
  const ts = new Date().toISOString();
  notes.append({ kind: 'answer', id, ts, answer: String(answer || '').slice(0, 4000), by: 'owner' });
  notes.append({ kind: 'dismiss', id, ts });
  sendSnapshot(); return { ...n, answer };
});
ipcMain.handle('notes:dismiss', (_e, { id }) => { if (notes.get(id)) { notes.append({ kind: 'dismiss', id, ts: new Date().toISOString() }); sendSnapshot(); } return true; });

// ── lead launch: rules + the owner's additions + this project's context, in one file for --append-system-prompt-file
ipcMain.handle('lead:prepare', async (_e, p) => {
  const k = keyOf(p); const s = settings.get(p);
  const g = gitCache.get(k) || await gitInfo(p); gitCache.set(k, g);
  const repo = parseRepo(s.repo || g.remote);
  const account = await effectiveAccount(s, g.remote);
  if (account && !s.ghAccount) { const u = await github.user(account); if (u) Object.assign(s, { ghAccount: account, gitName: s.gitName || u.name, gitEmail: s.gitEmail || u.email, inferred: true }); }
  const base = fs.readFileSync(KIT_FILE, 'utf8');
  let local = ''; try { local = fs.readFileSync(KIT_LOCAL, 'utf8'); } catch { local = ''; }
  const ctx = [
    '', '', '# This project (filled in by Mission Control at launch)', '',
    `- Name: ${path.basename(p)} · path: ${p}`,
    repo ? `- GitHub repository: ${repo.full} (${repo.url}). Current branch: ${g.branch || '?'}.` : '- No GitHub remote is configured for this project. Do not create one on your own; post a decision note first.',
    s.ghAccount
      ? `- GitHub account for this project: "${s.ghAccount}"${s.inferred ? ' (taken from the remote URL; the owner can change it in Mission Control)' : ''}, git identity ${s.gitName || s.ghAccount} <${s.gitEmail || ''}>. Its token is in this terminal's environment (GH_TOKEN${s.inferred ? '' : ', GIT_AUTHOR_* and GIT_COMMITTER_*'}), so gh and git push act as that account. Never run "gh auth switch" and never change git config user.* globally; other projects use other accounts at the same time.`
      : '- No GitHub account was chosen for this project in Mission Control, so the machine default applies. Before the first push or PR, post a decision note asking which account to use.',
    `- Inbox script: node "${NOTE_SCRIPT}" (see the Inbox section of your rules). Mission Control's owner reads that inbox.`,
    '',
  ].join('\n');
  const dir = path.join(DATA_DIR, 'generated'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, k.replace(/[^a-z0-9]+/gi, '-') + '.md');
  fs.writeFileSync(file, base.trimEnd() + '\n\n' + local.trim() + ctx);
  return file;
});
ipcMain.handle('lines', (_e, { kind, id, afterSeq }) => watcher.lines(kind, id, afterSeq || 0));

// ── project registry
ipcMain.handle('projects:add', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add a project folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  const reg = registry();
  if (!reg.some((x) => x.path.toLowerCase() === p.toLowerCase())) { reg.push({ path: p, name: path.basename(p), addedAt: new Date().toISOString() }); writeJson(REGISTRY, reg); }
  sendSnapshot();
  return p;
});
ipcMain.handle('projects:remove', (_e, p) => { writeJson(REGISTRY, registry().filter((x) => x.path.toLowerCase() !== String(p).toLowerCase())); sendSnapshot(); return true; });
ipcMain.handle('open:code', (_e, p) => { try { spawn('cmd.exe', ['/c', 'code', p], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; } catch (e) { return String(e); } });
ipcMain.handle('open:folder', (_e, p) => shell.openPath(p));

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
ipcMain.handle('pty:create', async (_e, { cwd, cols, rows, shellPath }) => {
  if (!pty) throw new Error('node-pty unavailable: ' + ptyError);
  const id = 'pty' + (++ptySeq);
  const sh = shellPath || (process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash'));
  const args = process.platform === 'win32' && /powershell/i.test(sh) ? ['-NoLogo'] : [];
  let dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  // per-project GitHub account and git identity, scoped to this terminal only
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  const s = settings.get(dir);
  const account = await effectiveAccount(s, (gitCache.get(keyOf(dir)) || await gitInfo(dir)).remote);
  if (account) { const t = await github.token(account); if (t) env.GH_TOKEN = t; }
  if (s.gitName) { env.GIT_AUTHOR_NAME = s.gitName; env.GIT_COMMITTER_NAME = s.gitName; }
  if (s.gitEmail) { env.GIT_AUTHOR_EMAIL = s.gitEmail; env.GIT_COMMITTER_EMAIL = s.gitEmail; }
  const proc = pty.spawn(sh, args, { name: 'xterm-256color', cols: cols || 120, rows: rows || 30, cwd: dir, env, useConpty: true });
  ptys.set(id, { proc, cwd: dir });
  proc.onData((d) => { if (win && !win.isDestroyed()) win.webContents.send('pty:data', { id, data: d }); });
  proc.onExit(({ exitCode }) => { ptys.delete(id); if (win && !win.isDestroyed()) win.webContents.send('pty:exit', { id, exitCode }); });
  return id;
});
ipcMain.on('pty:write', (_e, { id, data }) => { const p = ptys.get(id); if (p) p.proc.write(data); });
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => { const p = ptys.get(id); if (p && cols > 0 && rows > 0) { try { p.proc.resize(cols, rows); } catch { /* ignore */ } } });
ipcMain.on('pty:kill', (_e, { id }) => { const p = ptys.get(id); if (p) { try { p.proc.kill(); } catch { /* ignore */ } ptys.delete(id); } });

function killAllPtys() { for (const p of ptys.values()) { try { p.proc.kill(); } catch { /* ignore */ } } ptys.clear(); }
const checkpoints = new CheckpointWriter(watcher, { projRoot: PROJ_DIR_ROOT });
app.whenReady().then(() => { ensureKit(); notes.poll(); watcher.start(); checkpoints.start(); createWindow(); setTimeout(() => refreshIntegrations(true), 1500); });
app.on('window-all-closed', () => { killAllPtys(); watcher.stop(); checkpoints.stop(); app.quit(); });
app.on('before-quit', () => { killAllPtys(); });

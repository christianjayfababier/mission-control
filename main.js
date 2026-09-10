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
const KIT_FILE = path.join(DATA_DIR, 'orchestrator-system.md');
function ensureKit() {
  try { if (!fs.existsSync(KIT_FILE)) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.copyFileSync(path.join(__dirname, 'kit', 'orchestrator-system.md'), KIT_FILE); } }
  catch (e) { console.error('kit', e && e.message); }
}

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); }

let win = null;
const watcher = new TranscriptWatcher({ hours: 48 });
const ptys = new Map(); // id -> { proc, cwd, projectKey }
let ptySeq = 0;

function registry() { const r = readJson(REGISTRY, []); return Array.isArray(r) ? r : []; }
function sendSnapshot() { if (win && !win.isDestroyed()) win.webContents.send('snapshot', watcher.snapshot(registry())); }

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
    win.webContents.send('env', { ptyAvailable: !!pty, ptyError, home: os.homedir(), platform: process.platform, startView: START_VIEW, dataDir: DATA_DIR, kitFile: KIT_FILE });
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

ipcMain.handle('snapshot', () => watcher.snapshot(registry()));
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
ipcMain.handle('pty:create', (_e, { cwd, cols, rows, shellPath }) => {
  if (!pty) throw new Error('node-pty unavailable: ' + ptyError);
  const id = 'pty' + (++ptySeq);
  const sh = shellPath || (process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash'));
  const args = process.platform === 'win32' && /powershell/i.test(sh) ? ['-NoLogo'] : [];
  let dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const proc = pty.spawn(sh, args, { name: 'xterm-256color', cols: cols || 120, rows: rows || 30, cwd: dir, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, useConpty: true });
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
app.whenReady().then(() => { ensureKit(); watcher.start(); checkpoints.start(); createWindow(); });
app.on('window-all-closed', () => { killAllPtys(); watcher.stop(); checkpoints.stop(); app.quit(); });
app.on('before-quit', () => { killAllPtys(); });

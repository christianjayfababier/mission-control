'use strict';
/*
 explorer — read-only git and filesystem queries behind the Explorer panel (docs/EXPLORER-CONTRACT.md).

 Rules of the house:
 - Nothing here throws across IPC. Every entry point resolves to a plain object; failures come back as an
   `error` string with the rest of the shape still valid (empty list, null branch), so the renderer can
   draw something either way.
 - Nothing is cached. The renderer polls `status` every few seconds and re-lists dirs when `at` moves.
 - Every git call is spawned with execFile (no shell), `windowsHide: true`, and a 10 s timeout.
 - `-z` output is parsed from a Buffer; the pure parsers (parsePorcelain, parseNameStatus, parseWorktrees,
   safeRel) are exported so test/unit.js can check them without a repo.
*/
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const GIT_TIMEOUT = 10000;
const MAX_BUFFER = 32 * 1024 * 1024;
const FANOUT = 6; // parallel `git rev-list` calls when counting ahead/behind

/** execFile in the style of integrations.run(), but with Buffer output (git -z writes NUL-separated
    records) and an optional stdin payload. Never rejects. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const done = (err, stdout, stderr) => resolve({
      ok: !err,
      code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || '')),
      stderr: String(stderr || ''),
    });
    let child;
    try {
      child = execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || GIT_TIMEOUT, cwd: opts.cwd, maxBuffer: MAX_BUFFER, encoding: 'buffer' }, done);
    } catch (e) { resolve({ ok: false, code: -1, stdout: Buffer.alloc(0), stderr: String((e && e.message) || e) }); return; }
    child.on('error', () => { /* reported through the callback */ });
    if (opts.input !== undefined && child.stdin) { child.stdin.on('error', () => { /* git can exit before the write finishes */ }); child.stdin.end(opts.input); }
  });
}
const git = (root, args, opts) => run('git', ['-C', String(root || '.'), ...args], opts);
const text = (r) => r.stdout.toString('utf8');
const errText = (r) => (String(r.stderr || '') + '\n' + text(r)).trim().split('\n')[0].slice(0, 200) || 'git failed';
const slash = (s) => String(s || '').replace(/\\/g, '/');

/** Map with a concurrency cap, results in input order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const lanes = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k], k); }
  });
  await Promise.all(lanes);
  return out;
}

// listDir ────────────────────────────────────────────────────────────────────────────────────────
/** A `rel` that cannot escape `root`: no drive letter, no leading slash, no '..' segment. */
function safeRel(rel) {
  const raw = slash(rel == null ? '' : rel);
  if (/^([a-zA-Z]:|\/)/.test(raw)) return { error: 'path must be relative to the root' };
  const s = raw.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!s || s === '.') return { rel: '' };
  if (s.split('/').some((seg) => seg === '..')) return { error: 'path escapes the root' };
  return { rel: s };
}
const isDirSafe = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** One batched `git check-ignore` for a whole directory listing; a failure just means "nothing ignored". */
async function markIgnored(root, entries) {
  if (!entries.length) return;
  const input = Buffer.from(entries.map((e) => e.rel).join('\0') + '\0', 'utf8');
  const r = await run('git', ['-C', root, 'check-ignore', '--stdin', '-z', '--no-index'], { input });
  if (!r.ok && r.code !== 1) return; // exit 1 = none of them ignored; anything else (no git, no repo) = leave them false
  const ignored = new Set(text(r).split('\0').map(slash).filter(Boolean));
  for (const e of entries) if (ignored.has(e.rel)) e.ignored = true;
}

/** Entry[] for one directory: dirs first, then files, case-insensitive; `.git` is never listed. */
async function listDir(root, rel) {
  if (!root || typeof root !== 'string') return { entries: [], error: 'no root' };
  const r = safeRel(rel);
  if (r.error) return { entries: [], error: r.error };
  const base = path.resolve(root);
  const dir = path.resolve(base, r.rel);
  if (dir !== base && !dir.toLowerCase().startsWith(base.toLowerCase() + path.sep)) return { entries: [], error: 'path escapes the root' };
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return { entries: [], error: String((e && e.message) || e).slice(0, 200) }; }
  const entries = [];
  for (const e of ents) {
    if (e.name === '.git') continue;
    // a Windows junction (a worktree's node_modules) reports as a symlink, not as a directory
    const isDir = e.isDirectory() || (!e.isFile() && isDirSafe(path.join(dir, e.name)));
    entries.push({ name: e.name, rel: r.rel ? r.rel + '/' + e.name : e.name, type: isDir ? 'dir' : 'file', ignored: false });
  }
  entries.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  await markIgnored(base, entries);
  return { entries };
}

// status ─────────────────────────────────────────────────────────────────────────────────────────
const MARKS = new Set(['M', 'A', 'D', 'U', 'R', 'C']);
/** One letter out of the two porcelain columns (X = index, Y = worktree).
    The worktree column wins when both are set, except that a staged add/rename/copy is not downgraded
    to 'M' by a later worktree edit — the contract's worked example is 'AM' -> 'A'. */
function markOf(x, y) {
  if (x === '?' || y === '?') return 'U';
  if (x === '!' || y === '!') return null; // only with --ignored, and never a change
  const norm = (c) => (c && c !== ' ' ? (MARKS.has(c) ? c : 'M') : null); // 'T' (typechange) and friends read as a modification
  const X = norm(x), Y = norm(y);
  if (X && Y === 'M' && (X === 'A' || X === 'R' || X === 'C')) return X;
  return Y || X || null;
}
function addDirs(dirs, rel) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) dirs[parts.slice(0, i).join('/')] = true;
}
/** `git status --porcelain=v1 -z -uall` -> { files: { rel: Mark }, dirs: { relDir: true } }.
    In -z form a record is "XY <path>\0"; for a rename/copy the field order is reversed, so the NEW path
    comes first and the original follows in the next NUL field. */
function parsePorcelain(buf) {
  const parts = (Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '')).split('\0');
  const files = {}, dirs = {};
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue; // "XY p" is the shortest record there is
    const x = rec[0], y = rec[1];
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++; // skip the original path of a rename/copy
    const mark = markOf(x, y);
    if (!mark) continue;
    const rel = slash(rec.slice(3)).replace(/^\.\//, '');
    if (!rel) continue;
    files[rel] = mark;
    addDirs(dirs, rel);
  }
  return { files, dirs };
}

async function status(root) {
  const out = { root: String(root || ''), branch: null, files: {}, dirs: {}, at: Date.now() };
  if (!root || typeof root !== 'string') return { ...out, error: 'no root' };
  const [st, br] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '-uall']),
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  out.at = Date.now();
  if (br.ok) { const b = text(br).trim(); out.branch = b && b !== 'HEAD' ? b : null; }
  if (!st.ok) return { ...out, error: errText(st) };
  const parsed = parsePorcelain(st.stdout);
  out.files = parsed.files; out.dirs = parsed.dirs;
  return out;
}

// branches ───────────────────────────────────────────────────────────────────────────────────────
/** `git worktree list --porcelain`: blank-line separated records of "worktree <path>", "HEAD <sha>",
    and either "branch refs/heads/<name>" or "detached". */
function parseWorktrees(txt) {
  const out = [];
  let cur = null;
  const push = () => { if (cur && cur.path) out.push(cur); cur = null; };
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { push(); continue; }
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1).trim();
    if (k === 'worktree') { push(); cur = { path: v, head: null, branch: null, detached: false }; }
    else if (!cur) continue;
    else if (k === 'HEAD') cur.head = v;
    else if (k === 'branch') cur.branch = v.replace(/^refs\/heads\//, '');
    else if (k === 'detached') cur.detached = true;
  }
  push();
  return out;
}

/** origin/HEAD when the remote advertises one, else a local main, else a local master, else 'main'. */
async function defaultBranch(root) {
  const sym = await git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (sym.ok) { const s = text(sym).trim(); if (s) return s.replace(/^refs\/remotes\/origin\//, '').replace(/^refs\/heads\//, ''); }
  for (const name of ['main', 'master']) {
    const v = await git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + name]);
    if (v.ok && text(v).trim()) return name;
  }
  return 'main';
}

/** `git rev-list --left-right --count base...branch`: left = commits only on base = behind. */
async function aheadBehind(root, base, name) {
  if (!base || base === name) return { ahead: 0, behind: 0 };
  const r = await git(root, ['rev-list', '--left-right', '--count', `${base}...${name}`]);
  if (!r.ok) return { ahead: 0, behind: 0 };
  const m = /(\d+)\s+(\d+)/.exec(text(r));
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : { ahead: 0, behind: 0 };
}

async function branches(projectRoot) {
  const out = { default: 'main', branches: [], at: Date.now() };
  if (!projectRoot || typeof projectRoot !== 'string') return { ...out, error: 'no project root' };
  const [base, wt, refs, head] = await Promise.all([
    defaultBranch(projectRoot),
    git(projectRoot, ['worktree', 'list', '--porcelain']),
    git(projectRoot, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%00%(objectname:short)%00%(upstream:short)']),
    git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  out.default = base;
  if (!refs.ok) return { ...out, at: Date.now(), error: errText(refs) };
  const byBranch = new Map();
  if (wt.ok) for (const w of parseWorktrees(text(wt))) if (w.branch) byBranch.set(w.branch, path.normalize(w.path));
  const current = head.ok ? text(head).trim() : '';
  const rows = text(refs).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('\0'));
  const counts = await mapLimit(rows, FANOUT, (r) => aheadBehind(projectRoot, base, r[0]));
  out.branches = rows.map((r, i) => ({
    name: r[0], sha: r[1] || '', current: !!current && current !== 'HEAD' && current === r[0],
    worktree: byBranch.get(r[0]) || null, upstream: r[2] || null,
    ahead: counts[i].ahead, behind: counts[i].behind,
  }));
  out.at = Date.now();
  return out;
}

// diff ───────────────────────────────────────────────────────────────────────────────────────────
/** `git diff --name-status -z`: a status field, then one path ("M\0a.js\0") or two for a rename/copy
    ("R100\0old\0new\0"), where the new path comes second. The similarity score is dropped. */
function parseNameStatus(buf) {
  const parts = (Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '')).split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const field = parts[i];
    if (!field) continue;
    const letter = field[0].toUpperCase();
    if (!/^[A-Z]$/.test(letter)) continue;
    const two = letter === 'R' || letter === 'C';
    const a = parts[++i];
    const b = two ? parts[++i] : null;
    const rel = two ? b : a;
    if (!rel) continue;
    out.push({ rel: slash(rel), status: letter !== 'U' && MARKS.has(letter) ? letter : 'M' });
  }
  return out;
}

async function diff(projectRoot, branch) {
  if (!projectRoot || typeof projectRoot !== 'string') return { files: [], error: 'no project root' };
  if (!branch || typeof branch !== 'string') return { files: [], error: 'no branch' };
  const base = await defaultBranch(projectRoot);
  const r = await git(projectRoot, ['diff', '--name-status', '-z', `${base}...${branch}`]);
  if (!r.ok) return { files: [], base, error: errText(r) };
  return { files: parseNameStatus(r.stdout), base };
}

// open in VS Code ────────────────────────────────────────────────────────────────────────────────
/** `code -g <path>[:line]`, detached, exactly like the open:code handler in main.js. */
function openFile(p, line) {
  if (!p || typeof p !== 'string') return 'no path';
  try { if (!fs.existsSync(p)) return 'not found: ' + p; } catch (e) { return String((e && e.message) || e); }
  const n = Number(line);
  const target = Number.isFinite(n) && n > 0 ? `${p}:${Math.floor(n)}` : p;
  try { spawn('cmd.exe', ['/c', 'code', '-g', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; }
  catch (e) { return String((e && e.message) || e); }
}

module.exports = { listDir, status, branches, diff, openFile, parsePorcelain, parseNameStatus, parseWorktrees, safeRel, markOf, defaultBranch };

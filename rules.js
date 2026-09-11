'use strict';
/*
 rules — the Rules tab's data layer (docs/RULES-CONTRACT.md). Three unrelated jobs in one small module:

 1. `Rules`: the owner's per-project rules, one JSON file per project under
    ~/.claude/mission-control/rules/<project-key>.json. Same conventions as boards.js (safeKey, whole-file
    write, missing file = empty, poll() for files written by kit/mc-board.js or another instance).
 2. `sources()`: read-only discovery of the rule files that already exist in a repo (CLAUDE.md and friends,
    .claude/agents, .claude/skills, .claude/commands) plus Mission Control's own rulebook paths.
 3. `readText()` / `renderOwnerRules()`: a sandboxed file reader for the viewer pane, and the pure function
    that turns the owner's rules into the block appended to a lead's system prompt.

 Rules of the house, as in explorer.js: nothing here throws across IPC — a failure comes back as an `error`
 field with the rest of the shape still valid. Nothing is cached except poll mtimes. No dependencies.
*/
const fs = require('fs');
const path = require('path');

const safeKey = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
const now = () => new Date().toISOString();
const pad = (n) => String(n).padStart(3, '0');
const MAX_TEXT = 2000;          // one rule, per the contract
const MAX_READ = 512 * 1024;    // viewer pane cap, per the contract
const HEAD_BYTES = 8 * 1024;    // enough of a file to find its description / first line

// ── the owner's rules ────────────────────────────────────────────────────────────────────────────
class Rules {
  constructor(dir) { this.dir = dir; this.mtimes = new Map(); }
  file(p) { return path.join(this.dir, safeKey(p) + '.json'); }
  empty(p) { return { version: 1, project: String(p), seq: 0, rules: [] }; }
  load(p) {
    try {
      const r = JSON.parse(fs.readFileSync(this.file(p), 'utf8'));
      r.rules = Array.isArray(r.rules) ? r.rules : [];
      r.seq = Number(r.seq) || r.rules.length;
      r.project = r.project || String(p);
      r.rules.forEach((x, i) => { if (typeof x.order !== 'number') x.order = i; });
      r.rules.sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
      return r;
    } catch { return this.empty(p); }
  }
  save(p, r) {
    fs.mkdirSync(this.dir, { recursive: true });
    r.updatedAt = now();
    const f = this.file(p);
    fs.writeFileSync(f, JSON.stringify(r, null, 2));
    try { this.mtimes.set(f, fs.statSync(f).mtimeMs); } catch { /* ignore */ }
    return r;
  }
  /** One rule. `by` is 'owner' from the UI, the lead's name (or 'orchestrator') from the CLI. */
  add(p, text, by = 'owner', source = 'ui') {
    const t = String(text == null ? '' : text).trim().slice(0, MAX_TEXT);
    const r = this.load(p);
    if (!t) return r;
    r.seq++;
    r.rules.push({ id: 'R-' + pad(r.seq), text: t, by: String(by || 'owner'), source: source === 'script' ? 'script' : 'ui', createdAt: now(), updatedAt: now(), order: r.rules.length });
    return this.save(p, r);
  }
  patch(p, id, patch = {}) {
    const r = this.load(p);
    const it = r.rules.find((x) => x.id === id); if (!it) return r;
    if (patch.text !== undefined) it.text = String(patch.text).trim().slice(0, MAX_TEXT);
    if (patch.order !== undefined && Number.isFinite(Number(patch.order))) it.order = Number(patch.order);
    it.updatedAt = now();
    r.rules.sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
    return this.save(p, r);
  }
  remove(p, id) { const r = this.load(p); const i = r.rules.findIndex((x) => x.id === id); if (i >= 0) r.rules.splice(i, 1); r.rules.forEach((x, n) => { x.order = n; }); return this.save(p, r); }
  /** `ids` in the new display order; anything the caller left out keeps its relative place at the end. */
  reorder(p, ids) {
    const r = this.load(p);
    const want = (Array.isArray(ids) ? ids : []).filter((id) => r.rules.some((x) => x.id === id));
    const rest = r.rules.filter((x) => !want.includes(x.id)).map((x) => x.id);
    const order = [...want, ...rest];
    r.rules.forEach((x) => { x.order = order.indexOf(x.id); });
    r.rules.sort((a, b) => a.order - b.order);
    return this.save(p, r);
  }
  /** Tab badge, called for every project on every snapshot tick. It reads the file every time, exactly like
      boards.counts(): an mtime cache looks cheaper but NTFS gives two writes in the same millisecond the same
      mtimeMs, so the badge would sit on a stale number until the next write. The file is a few hundred bytes
      and load() never throws, so this costs less than the board count already taken on the same line. */
  count(p) { return this.load(p).rules.length; }
  /** Files changed since the last poll (written by mc-board.js or another instance). Returns their RulesFiles. */
  poll() {
    let files = []; try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const changed = [];
    for (const f of files) {
      const full = path.join(this.dir, f); let st; try { st = fs.statSync(full); } catch { continue; }
      if (this.mtimes.get(full) === st.mtimeMs) continue;
      this.mtimes.set(full, st.mtimeMs);
      try { const r = JSON.parse(fs.readFileSync(full, 'utf8')); if (r && r.project) { r.rules = Array.isArray(r.rules) ? r.rules : []; changed.push(r); } } catch { /* half-written; next poll */ }
    }
    return changed;
  }
}

// ── the lead's prompt block ──────────────────────────────────────────────────────────────────────
/** An ISO timestamp as the owner's own calendar day (YYYY-MM-DD, local): a rule saved at 22:00 here is
    dated tomorrow by the UTC string, and the lead reads these dates as the owner's days. */
function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '').slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Pure: the markdown appended to a lead's system prompt, '' when the project has no rules.
    Exactly the block in docs/RULES-CONTRACT.md — three spaces before the "(by, date)" tail. */
function renderOwnerRules(rulesFile) {
  const list = (rulesFile && Array.isArray(rulesFile.rules) ? rulesFile.rules : [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id)));
  if (!list.length) return '';
  return ['## Owner rules for this project — binding, they win over the general rules above']
    .concat(list.map((r) => `- ${r.id} ${String(r.text || '').trim()}   (${r.by || 'owner'}, ${localDay(r.createdAt)})`))
    .join('\n');
}

// ── the viewer's file reader ─────────────────────────────────────────────────────────────────────
const inside = (abs, root) => {
  if (!root) return false;
  const r = path.resolve(String(root));
  const a = abs.toLowerCase(), b = r.toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};
/** `{ text, size, mtime }` for a file inside one of `allowedRoots`, `{ error }` for anything else.
    The renderer may hand us any path (a row the user clicked); this is the only gate. */
function readText(absPath, allowedRoots = []) {
  if (!absPath || typeof absPath !== 'string') return { error: 'no path' };
  const abs = path.resolve(absPath);
  const roots = (Array.isArray(allowedRoots) ? allowedRoots : [allowedRoots]).filter(Boolean);
  if (!roots.some((r) => inside(abs, r))) return { error: 'path is outside this project, the kit and the generated prompts' };
  let st; try { st = fs.statSync(abs); } catch (e) { return { error: String((e && e.message) || e).slice(0, 200) }; }
  if (st.isDirectory()) return { error: 'that is a directory' };
  if (st.size > MAX_READ) return { error: `file is ${Math.round(st.size / 1024)} KB; the viewer reads at most ${MAX_READ / 1024} KB` };
  try { return { text: fs.readFileSync(abs, 'utf8'), size: st.size, mtime: st.mtimeMs }; }
  catch (e) { return { error: String((e && e.message) || e).slice(0, 200) }; }
}

// ── discovery ────────────────────────────────────────────────────────────────────────────────────
// The rule files a Recall reads, in the order the tab shows them. present=false rows stay in the list.
const CANDIDATES = [
  'CLAUDE.md',
  'docs/ORCHESTRATOR.md',
  'docs/PLAN.md',
  'docs/PROGRESS.md',
  'docs/TEAM-OPERATIONS.md',
  '.claude/orchestrator.md',
  'CONTRIBUTING.md',
  'docs/PITFALLS.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
];

/** The first line worth showing: frontmatter `description:` when the file opens with `---`, else the
    first non-empty line (after the frontmatter block, if there is one). Trimmed to 160 chars. */
function firstLineOf(abs) {
  let head = '';
  try {
    const fd = fs.openSync(abs, 'r');
    try { const buf = Buffer.alloc(HEAD_BYTES); const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0); head = buf.slice(0, n).toString('utf8'); }
    finally { fs.closeSync(fd); }
  } catch { return null; }
  const lines = head.replace(/^﻿/, '').split(/\r?\n/);
  let body = lines;
  if (lines[0] && lines[0].trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    const fm = end > 0 ? lines.slice(1, end) : lines.slice(1);
    for (const l of fm) { const m = /^\s*description\s*:\s*(.+)$/i.exec(l); if (m) return clip(unquote(m[1])); }
    if (end > 0) body = lines.slice(end + 1);
  }
  const first = body.find((l) => l.trim().length);
  return first === undefined ? null : clip(first);
}
const unquote = (s) => String(s).trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
const clip = (s) => { const t = String(s).trim(); return t.length > 160 ? t.slice(0, 160) : t; };

function row(projectPath, rel, group, { onlyPresent = false } = {}) {
  const abs = path.join(projectPath, rel.split('/').join(path.sep));
  let st = null; try { st = fs.statSync(abs); } catch { st = null; }
  const present = !!(st && st.isFile());
  if (!present && onlyPresent) return null;
  return { rel, path: abs, present, group, firstLine: present ? firstLineOf(abs) : null, size: present ? st.size : null, mtime: present ? st.mtimeMs : null };
}
const ls = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
const fileIfPresent = (p) => { try { return p && fs.statSync(p).isFile() ? p : null; } catch { return null; } };

/**
 * Sources for the Rules tab: the repo's own rule files plus Mission Control's rulebook paths.
 * `opts` = { kitFile, kitLocal, generatedDir, key } — main.js passes its KIT_FILE / KIT_LOCAL /
 * DATA_DIR+'/generated' and keyOf(projectPath); the generated prompt's name matches lead:prepare.
 */
function sources(projectPath, opts = {}) {
  const { kitFile = null, kitLocal = null, generatedDir = null, key = null } = opts;
  const repo = [];
  if (projectPath && typeof projectPath === 'string') {
    const root = path.resolve(projectPath);
    for (const rel of CANDIDATES) {
      const r = row(root, rel, 'rules');
      // Windows matches file names case-insensitively, so PULL_REQUEST_TEMPLATE.md and its lowercase
      // twin are one file: keep a second spelling only if it is the one that actually exists.
      const dup = repo.find((x) => x.path.toLowerCase() === r.path.toLowerCase());
      if (dup && !(r.present && !dup.present)) continue;
      if (dup) repo.splice(repo.indexOf(dup), 1);
      repo.push(r);
    }
    for (const e of ls(path.join(root, '.claude', 'agents')).filter((e) => e.isFile() && /\.md$/i.test(e.name)).sort(byName)) {
      const r = row(root, `.claude/agents/${e.name}`, 'agents', { onlyPresent: true }); if (r) repo.push(r);
    }
    for (const e of ls(path.join(root, '.claude', 'skills')).filter((e) => e.isDirectory() || !e.isFile()).sort(byName)) {
      const r = row(root, `.claude/skills/${e.name}/SKILL.md`, 'skills', { onlyPresent: true }); if (r) repo.push(r);
    }
    for (const e of ls(path.join(root, '.claude', 'commands')).filter((e) => e.isFile() && /\.md$/i.test(e.name)).sort(byName)) {
      const r = row(root, `.claude/commands/${e.name}`, 'commands', { onlyPresent: true }); if (r) repo.push(r);
    }
  }
  const generated = generatedDir && key ? fileIfPresent(path.join(generatedDir, String(key).replace(/[^a-z0-9]+/gi, '-') + '.md')) : null;
  return { repo, kit: { rules: kitFile || null, local: fileIfPresent(kitLocal), generated }, at: Date.now() };
}

module.exports = { Rules, safeKey, renderOwnerRules, readText, sources, firstLineOf, localDay, CANDIDATES, MAX_READ, MAX_TEXT };

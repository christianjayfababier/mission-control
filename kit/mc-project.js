'use strict';
/*
 mc-project — which project a kit CLI is talking about (shared by mc-board.js and mc-note.js).

 Leads and workers work in git worktrees (C:\ClaudeApps\worktrees\<name>), so the current directory
 is usually NOT the project the owner sees in Mission Control. Keying the board or a note by
 process.cwd() there creates a phantom board for the worktree path (T-026). Resolution order:

   1. an explicit path — the --project flag, else the MC_PROJECT env var;
   2. cwd (or the nearest ancestor) is a git worktree — a `.git` FILE holding `gitdir: ...` — then
      the main checkout that owns it, read from the worktree's `commondir`/`gitdir` path, no git binary;
   3. the nearest ancestor holding a `.git` directory, so a subfolder of a project still lands on it;
   4. cwd, as the scripts behaved before.

 The result is normalised (absolute, no trailing separator) so it keys the same file the app keys
 with boards.js safeKey() and integrations.js keyOf().
*/
const fs = require('fs');
const path = require('path');

/** Absolute, no trailing separator, native separators — the form the app stores project paths in. */
function normalizeProjectPath(p) {
  const abs = path.resolve(String(p == null ? '.' : p));
  const cut = abs.replace(/[\\/]+$/, '');
  return cut && !/^[A-Za-z]:$/.test(cut) ? cut : abs;   // never strip a drive root ("C:\")
}

/** `<main>/.git/worktrees/<name>` → `<main>`, or null when this is not a worktree gitdir. */
function mainCheckoutOf(gitdir) {
  let common = null;
  try {
    const c = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
    if (c) common = path.isAbsolute(c) ? path.normalize(c) : path.resolve(gitdir, c);
  } catch { /* older or hand-made worktrees have no commondir */ }
  if (!common) {
    const m = /^(.*)[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitdir);
    if (m && m[1]) common = m[1];
  }
  if (!common || path.basename(common).toLowerCase() !== '.git') return null;
  return normalizeProjectPath(path.dirname(common));
}

/** The main checkout for a `.git` file (`gitdir: <path>`), or null when it points nowhere useful. */
function mainCheckoutForGitFile(dir, file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const m = /^[\s\ufeff]*gitdir\s*:\s*(.+?)\s*$/im.exec(text);
  if (!m) return null;
  let gitdir = m[1].replace(/^["']|["']$/g, '');
  gitdir = path.isAbsolute(gitdir) ? path.normalize(gitdir) : path.resolve(dir, gitdir);
  return mainCheckoutOf(gitdir);
}

/**
 * resolveProjectPath(cwd, env, explicit) — the project a CLI call belongs to.
 * `explicit` is the --project flag (wins); env.MC_PROJECT is the fallback override.
 */
function resolveProjectPath(cwd, env, explicit) {
  const e = env || process.env;
  const forced = explicit != null && String(explicit).trim() ? explicit : (e.MC_PROJECT && String(e.MC_PROJECT).trim() ? e.MC_PROJECT : null);
  if (forced) return normalizeProjectPath(forced);
  const start = normalizeProjectPath(cwd == null ? process.cwd() : cwd);
  let dir = start;
  for (let i = 0; i < 64; i++) {
    const g = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(g); } catch { st = null; }
    if (st && st.isDirectory()) return dir;
    if (st && st.isFile()) return mainCheckoutForGitFile(dir, g) || dir;
    const up = path.dirname(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return start;
}

module.exports = { resolveProjectPath, normalizeProjectPath };

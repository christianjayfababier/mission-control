'use strict';
/*
 newproject-lib — the parts of "Add/create a project" that are pure enough to run (and be tested) under
 plain node: name and target validation, the starter CLAUDE.md, the registry entry, the folder creation
 itself and the clone command. main.js owns the Electron half (dialogs, IPC, the pty, sendSnapshot);
 everything below is required by main.js and by test/unit.js, so the rules are checked once, in one place.

 Nothing here throws: every entry point returns `{ error }` or a value.
*/
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { parseRepo } = require('./integrations');

// Windows reserved device names: a folder called CON or LPT1 cannot be created, whatever the API says.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const BAD_CHARS = /[<>:"|?*]/;

/** A folder name the owner may type for a new project. Returns null when it is fine, else why not. */
function validateProjectName(name) {
  const s = String(name == null ? '' : name);
  if (!s.trim()) return 'Enter a project name.';
  if (s !== s.trim()) return 'The name cannot start or end with a space.';
  if (/[\\/]/.test(s)) return 'The name cannot contain a path separator - pick the parent folder above instead.';
  if (/[\`\r\n]/.test(s)) return 'The name cannot contain a backtick or a line break.';
  if (s.startsWith('.')) return 'The name cannot start with a dot.';
  if (s.endsWith('.')) return 'The name cannot end with a dot.';
  if (BAD_CHARS.test(s)) return 'The name cannot contain any of < > : " | ? *';
  if (RESERVED.test(s)) return `"${s}" is a reserved Windows name.`;
  if (s.length > 100) return 'The name is too long (100 characters max).';
  return null;
}

/** parent must exist and be a directory, name must be valid, and parent\name must not exist yet. */
function validateTarget(parent, name) {
  const p = String(parent == null ? '' : parent).trim();
  if (!p) return { error: 'Choose a parent folder.' };
  let st = null; try { st = fs.statSync(p); } catch { return { error: 'That parent folder does not exist.' }; }
  if (!st.isDirectory()) return { error: 'The parent is not a folder.' };
  const bad = validateProjectName(name); if (bad) return { error: bad };
  const target = path.join(p, String(name).trim());
  if (fs.existsSync(target)) return { error: 'A folder with that name already exists here.' };
  return { path: target };
}

/** The file a brand-new project starts with. Kept deliberately short: the lead fills it in. */
function starterClaudeMd(name) {
  return [
    `# ${name}`,
    '',
    `${name} is a new project. Say here in one or two lines what it is and who it is for.`,
    '',
    'Rules for Claude sessions in this repo go here.',
    '',
  ].join('\r\n');
}

const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
/** The registry entry for a path, appended only when the path is not already in the list. Returns the new array. */
function addToRegistry(reg, p, now) {
  const list = Array.isArray(reg) ? reg.slice() : [];
  if (list.some((x) => norm(x && x.path) === norm(p))) return list;
  list.push({ path: String(p), name: path.basename(String(p).replace(/[\\/]+$/, '')), addedAt: (now || new Date()).toISOString() });
  return list;
}

/** Repository input: a GitHub URL, a git@ URL, or owner/name. null when it is not one. */
function parseRepoInput(s) { return parseRepo(s); }

/**
 * What Mission Control types into the clone terminal.
 * Both arguments are always one single-quoted literal: a folder name may legally hold ; & $ ( ) and
 * an apostrophe on Windows, and typing one of those unquoted would hand the shell a second command
 * to run. Single quotes are literal in PowerShell (an embedded one is doubled) and in sh (an embedded
 * one is closed, escaped and reopened), so nothing inside either argument is ever expanded.
 * The pty is a shell, so the shell's exit code is the only one main sees: the line ends by handing
 * gh’s code back, which is what turns the clone into "added to the sidebar" or "see the terminal".
 */
function cloneCommand(full, folder, { powershell = true } = {}) {
  const q = powershell
    ? (s) => "'" + String(s).replace(/'/g, "''") + "'"                 // PowerShell: '' is a literal quote
    : (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";             // sh: close, escape, reopen
  return `gh repo clone ${q(full)} ${q(folder)}; exit ${powershell ? '$LASTEXITCODE' : '$?'}`;
}

const run = (cmd, args, cwd) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

/**
 * Create <parent>\<name>, optionally `git init` it and write a starter CLAUDE.md.
 * Returns { path } or { error }. The folder is removed again when git init fails, so a half-made
 * project never lands in the sidebar.
 */
async function createProjectFolder({ parent, name, git = true, claudeMd = true } = {}) {
  const v = validateTarget(parent, name); if (v.error) return v;
  const target = v.path;
  try { fs.mkdirSync(target, { recursive: false }); } catch (e) { return { error: 'Could not create the folder: ' + (e && e.message) }; }
  if (git) {
    const r = await run('git', ['init', '-q'], target);
    if (!r.ok) { try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* leave it */ } return { error: 'git init failed: ' + (r.stderr || r.stdout || 'unknown').trim().split('\n')[0] }; }
  }
  if (claudeMd) {
    try { fs.writeFileSync(path.join(target, 'CLAUDE.md'), starterClaudeMd(String(name).trim())); }
    catch (e) { return { error: 'The folder was created but CLAUDE.md could not be written: ' + (e && e.message) }; }
  }
  return { path: target };
}

module.exports = { validateProjectName, validateTarget, starterClaudeMd, addToRegistry, parseRepoInput, cloneCommand, createProjectFolder };

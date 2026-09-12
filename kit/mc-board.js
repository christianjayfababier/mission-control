#!/usr/bin/env node
/*
 mc-board — the project's Tickets and Todos board, shared between the owner (Mission Control's
 Tickets / Todos tabs) and the orchestrator and its workers (this script).

   node mc-board.js ticket list [--all]
   node mc-board.js ticket show T-003
   node mc-board.js ticket add "Title" ["Body"] [--type bug|feature|task] [--priority p1|p2|p3]
   node mc-board.js ticket update T-003 [--status new|analyzed|planned|in-progress|in-review|blocked|done]
        [--risk low|medium|high] [--doable yes|effort|no] [--effort "2d"] [--migration yes|no] [--db yes|no] [--heavy yes|no]
        [--eta "3 days"] [--eta-notes "..."] [--areas "auth,billing"] [--analysis "..."] [--plan "..."] [--pr <url>] [--branch <name>] [--title "..."] [--body "..."]
        (--status in-progress stamps startedAt and computes dueAt from the eta; the owner shows dueAt to the requester)
   node mc-board.js ticket done T-003 [--pr <url>]
   node mc-board.js todo list [--all]
   node mc-board.js todo add "text" [--owner orchestrator|worker|owner]
   node mc-board.js todo done D-002
   node mc-board.js todo remove D-002
   node mc-board.js watch add <pr number|url> [--ticket T-003]   # Mission Control follows the PR: checks → merge reminder → merge → deployment, into the owner's inbox
   node mc-board.js rule list
   node mc-board.js rule add "text" [--by Skye]      # the owner's standing rules for this project; --by defaults to 'orchestrator'
   node mc-board.js rule remove R-003
        (rules are appended to this project's lead system prompt at its next launch; the owner sees and edits them in the Rules tab)

 Board file: ~/.claude/mission-control/boards/<project-key>.json, rules file
 ~/.claude/mission-control/rules/<project-key>.json.

 The project: `--project <path>` (optional on every verb) wins, then the MC_PROJECT env var, else it is
 resolved from the current directory — a git worktree resolves to the main checkout it belongs to, a
 subfolder to the project root — so you can run mc-board.js from anywhere in the project, a worktree included.
 MC_DEBUG=1 prints the resolved project on stderr (so does a --project that disagrees with the directory
 you are in).
 Set MC_DATA_DIR to point the board and rules files somewhere else (tests only; unset it and the real
 data dir is used).
 Mission Control shows changes within two seconds. Exit code is always 0.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = process.env.MC_DATA_DIR || path.join(os.homedir(), '.claude', 'mission-control');
const DIR = path.join(ROOT, 'boards');
const RULES_DIR = path.join(ROOT, 'rules');
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) { if (!args[i].startsWith('--')) continue; const k = args[i].slice(2); const hasVal = args[i + 1] !== undefined && !String(args[i + 1]).startsWith('--'); flags[k] = hasVal ? args[i + 1] : 'yes'; args.splice(i, hasVal ? 2 : 1); i--; }
// T-026: run from a worktree and write the MAIN checkout's project, never a phantom one for the worktree path.
let resolveProjectPath;
try { ({ resolveProjectPath } = require('./mc-project.js')); }
catch { resolveProjectPath = (cwd, env, x) => path.resolve(String((x && String(x).trim() ? x : (env || {}).MC_PROJECT) || cwd || '.')); }
const project = resolveProjectPath(process.cwd(), process.env, flags.project);
if (process.env.MC_DEBUG || (flags.project && project !== resolveProjectPath(process.cwd(), { ...process.env, MC_PROJECT: '' })))
  console.error('mc-board: project ' + project + ' (cwd ' + process.cwd() + ')');
const key = project.toLowerCase().replace(/[^a-z0-9]+/g, '-');   // boards.js safeKey(): the app keys the same file
const FILE = path.join(DIR, key + '.json');
const RULES_FILE = path.join(RULES_DIR, key + '.json');
const now = () => new Date().toISOString();
const pad = (n) => String(n).padStart(3, '0');

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { version: 1, project, tickets: [], todos: [], seq: { ticket: 0, todo: 0 } }; } }
function save(b) { fs.mkdirSync(DIR, { recursive: true }); b.updatedAt = now(); fs.writeFileSync(FILE, JSON.stringify(b, null, 2)); }
// the Rules tab's file: same id scheme (R-001...), same whole-file write, read by rules.js in the app
function loadRules() { try { const r = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')); r.rules = Array.isArray(r.rules) ? r.rules : []; r.seq = Number(r.seq) || r.rules.length; return r; } catch { return { version: 1, project, seq: 0, rules: [] }; } }
function saveRules(r) { fs.mkdirSync(RULES_DIR, { recursive: true }); r.project = r.project || project; r.updatedAt = now(); fs.writeFileSync(RULES_FILE, JSON.stringify(r, null, 2)); }
/** '2 hours' | '3 days' | '1-2 weeks' | '90 min' → milliseconds (upper bound of a range; business weeks = 5 working days). */
function etaMs(text) { const m = /(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s*(min|minute|hour|hr|h|day|d|week|wk|w|month|mo)/i.exec(String(text)); if (!m) return 0; const n = Number(m[2] || m[1]); const u = m[3].toLowerCase(); const H = 3600e3; return u.startsWith('min') ? n * 60e3 : /^h/.test(u) ? n * H : /^d/.test(u) ? n * 24 * H : /^w/.test(u) ? n * 7 * 24 * H : n * 30 * 24 * H; }
const yn = (v) => v === undefined ? undefined : /^(y|yes|true|1)$/i.test(v) ? true : /^(n|no|false|0)$/i.test(v) ? false : null;
const row = (t) => `${t.id}  [${t.status}]  ${t.type}/${t.priority || 'p2'}  ${t.title}` + (t.risk ? `  · risk ${t.risk}` : '') + (t.doable ? ` · doable ${t.doable}` : '') + (t.effort ? ` · ${t.effort}` : '') + (t.eta ? ` · ETA ${t.eta}` : '') + (t.dueAt ? ` · due ${t.dueAt.slice(0, 16).replace('T', ' ')}` : '') + (t.migration ? ' · MIGRATION' : '') + (t.db ? ' · DB' : '') + (t.heavy ? ' · HEAVY' : '') + (t.pr ? `  ${t.pr}` : '');

try {
  const [kind, cmd, a1, a2] = args;
  const b = load();
  if (kind === 'ticket') {
    if (cmd === 'list') { const list = b.tickets.filter((t) => flags.all || t.status !== 'done'); console.log(list.length ? list.map(row).join('\n') : 'no tickets'); }
    else if (cmd === 'show') { const t = b.tickets.find((x) => x.id === a1); console.log(t ? JSON.stringify(t, null, 2) : 'not found'); }
    else if (cmd === 'add') {
      if (!a1) { console.log('usage: ticket add "Title" ["Body"] [--type bug|feature|task] [--priority p1|p2|p3]'); process.exit(0); }
      b.seq.ticket++; const t = { id: 'T-' + pad(b.seq.ticket), title: String(a1).slice(0, 200), body: String(a2 || '').slice(0, 8000), type: flags.type || 'task', priority: flags.priority || 'p2', status: 'new', risk: null, doable: null, effort: null, migration: null, db: null, heavy: null, areas: [], analysis: '', plan: '', eta: null, etaNotes: '', startedAt: null, dueAt: null, pr: '', branch: '', source: flags.source || 'orchestrator', createdAt: now(), updatedAt: now(), doneAt: null };
      b.tickets.push(t); save(b); console.log('added ' + t.id);
    } else if (cmd === 'update' || cmd === 'done') {
      const t = b.tickets.find((x) => x.id === a1); if (!t) { console.log('not found: ' + a1); process.exit(0); }
      for (const k of ['status', 'risk', 'doable', 'effort', 'analysis', 'plan', 'pr', 'branch', 'title', 'body', 'type', 'priority', 'eta']) if (flags[k] !== undefined) t[k] = String(flags[k]);
      if (flags['eta-notes'] !== undefined) t.etaNotes = String(flags['eta-notes']);
      if (t.status === 'in-progress' && !t.startedAt) t.startedAt = now();
      if (t.startedAt && t.eta) { const ms = etaMs(t.eta); t.dueAt = ms ? new Date(new Date(t.startedAt).getTime() + ms).toISOString() : t.dueAt; }
      for (const k of ['migration', 'db', 'heavy']) if (flags[k] !== undefined) t[k] = yn(flags[k]);
      if (flags.areas !== undefined) t.areas = String(flags.areas).split(',').map((s) => s.trim()).filter(Boolean);
      if (cmd === 'done') { t.status = 'done'; t.doneAt = now(); }
      if (t.status === 'new' && (t.risk || t.doable || t.analysis)) t.status = 'analyzed';
      t.updatedAt = now(); save(b); console.log('updated ' + t.id + ' → ' + row(t));
    } else console.log('usage: ticket list|show|add|update|done');
  } else if (kind === 'todo') {
    if (cmd === 'list') { const list = b.todos.filter((t) => flags.all || !t.done); console.log(list.length ? list.map((t) => `${t.id}  [${t.done ? 'x' : ' '}]  ${t.text}  (${t.owner})`).join('\n') : 'no todos'); }
    else if (cmd === 'add') { if (!a1) { console.log('usage: todo add "text" [--owner orchestrator|worker|owner]'); process.exit(0); } b.seq.todo++; const t = { id: 'D-' + pad(b.seq.todo), text: String(a1).slice(0, 1000), done: false, owner: flags.owner || 'orchestrator', source: 'script', createdAt: now(), doneAt: null }; b.todos.push(t); save(b); console.log('added ' + t.id); }
    else if (cmd === 'done') { const t = b.todos.find((x) => x.id === a1); if (t) { t.done = true; t.doneAt = now(); save(b); console.log('done ' + t.id); } else console.log('not found'); }
    else if (cmd === 'remove') { const i = b.todos.findIndex((x) => x.id === a1); if (i >= 0) { b.todos.splice(i, 1); save(b); console.log('removed ' + a1); } else console.log('not found'); }
    else console.log('usage: todo list|add|done|remove');
  } else if (kind === 'watch') {
    // node mc-board.js watch add <pr number or url> [--ticket T-003]   — Mission Control then reports checks, merge and deployment to the owner's inbox
    b.watches = b.watches || [];
    const num = a1 ? Number((String(a1).match(/(\d+)\s*$/) || [])[1]) : NaN;
    if (cmd === 'add' && num) { if (!b.watches.some((w) => w.pr === num)) b.watches.push({ pr: num, ticket: flags.ticket || null, since: now() }); save(b); console.log(`watching PR #${num}: Mission Control will post checks, merge and deployment updates to the owner's inbox`); }
    else if (cmd === 'remove' && num) { b.watches = b.watches.filter((w) => w.pr !== num); save(b); console.log('removed watch for PR #' + num); }
    else if (cmd === 'list') console.log(b.watches.length ? b.watches.map((w) => `PR #${w.pr}${w.ticket ? ' (' + w.ticket + ')' : ''} since ${w.since}`).join('\n') : 'no watches');
    else console.log('usage: watch add <pr number|url> [--ticket T-003] | watch remove <pr> | watch list');
  } else if (kind === 'rule') {
    const r = loadRules();
    if (cmd === 'list') console.log(r.rules.length ? r.rules.map((x) => `${x.id}  ${x.text}  (${x.by})`).join('\n') : 'no rules');
    else if (cmd === 'add') {
      const text = String(a1 || '').trim();
      if (!text) { console.log('usage: rule add "text" [--by Skye]'); process.exit(0); }
      r.seq++; const x = { id: 'R-' + pad(r.seq), text: text.slice(0, 2000), by: String(flags.by || 'orchestrator'), source: 'script', createdAt: now(), updatedAt: now(), order: r.rules.length };
      r.rules.push(x); saveRules(r); console.log('added ' + x.id);
    } else if (cmd === 'remove') {
      const i = r.rules.findIndex((x) => x.id === a1);
      if (i < 0) { console.log('not found: ' + a1); process.exit(0); }
      r.rules.splice(i, 1); r.rules.forEach((x, n) => { x.order = n; }); saveRules(r); console.log('removed ' + a1);
    } else console.log('usage: rule list | rule add "text" [--by Skye] | rule remove R-003');
  } else console.log('usage: mc-board.js ticket ... | todo ... | watch ... | rule ...   (see header of this file)');
} catch (e) { console.log('mc-board: ' + (e && e.message)); }
process.exit(0);

#!/usr/bin/env node
/*
 mc-note — the orchestrator's line to the owner's Mission Control inbox.

   node mc-note.js decision "Title" "Body" [--options "Approve|Reject|Discuss"] [--project <path>]
   node mc-note.js question "Title" "Body"
   node mc-note.js announce "Title" "Body"          # e.g. "PR #12 ready for review and merge"
   node mc-note.js blocker  "Title" "Body"
   node mc-note.js answers                          # print the owner's answers to your notes (marks them read)
   node mc-note.js list                             # your open notes

 Notes are appended to ~/.claude/mission-control/notes.jsonl; Mission Control shows them in the sidebar inbox and
 types the owner's answer into your session when it runs inside Mission Control. If it does not, run `answers`.
 The project is the current directory unless --project is given. Never fails the caller: exit code is always 0.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.claude', 'mission-control', 'notes.jsonl');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const project = (flag('--project') || process.cwd()).replace(/[\\/]+$/, '');
const options = flag('--options');
const session = flag('--session') || process.env.CLAUDE_SESSION_ID || null;
const cmd = (args.shift() || '').toLowerCase();
const key = project.toLowerCase();

function readAll() { try { return fs.readFileSync(FILE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
function append(o) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.appendFileSync(FILE, JSON.stringify(o) + '\n'); }
function reduce(events) {
  const notes = new Map();
  for (const e of events) {
    if (e.kind === 'note') notes.set(e.id, { ...e, status: 'open', answer: null, read: false });
    else if (e.kind === 'answer' && notes.has(e.id)) Object.assign(notes.get(e.id), { status: 'answered', answer: e.answer, answeredAt: e.ts });
    else if (e.kind === 'dismiss' && notes.has(e.id)) notes.get(e.id).status = 'dismissed';
    else if (e.kind === 'read' && notes.has(e.id)) notes.get(e.id).read = true;
  }
  return [...notes.values()];
}

try {
  const types = { decision: 'decision', question: 'question', announce: 'announcement', announcement: 'announcement', blocker: 'blocker' };
  if (types[cmd]) {
    const [title, body] = args;
    if (!title) { console.log('usage: mc-note.js ' + cmd + ' "Title" "Body" [--options "A|B"]'); process.exit(0); }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    append({ kind: 'note', id, ts: new Date().toISOString(), project, type: types[cmd], title: String(title).slice(0, 200), body: String(body || '').slice(0, 4000), options: options ? options.split('|').map((s) => s.trim()).filter(Boolean).slice(0, 6) : [], session });
    console.log(`noted (${types[cmd]} ${id}). The owner sees it in Mission Control's inbox; the answer is typed into this session, or run: node mc-note.js answers`);
  } else if (cmd === 'answers') {
    const mine = reduce(readAll()).filter((n) => n.project.toLowerCase() === key && n.answer != null && !n.read);
    if (!mine.length) console.log('no new answers');
    for (const n of mine) { console.log(`ANSWER to "${n.title}" (${n.type}, ${n.answeredAt}): ${n.answer}`); append({ kind: 'read', id: n.id, ts: new Date().toISOString() }); }
  } else if (cmd === 'list') {
    const mine = reduce(readAll()).filter((n) => n.project.toLowerCase() === key && n.status === 'open');
    if (!mine.length) console.log('no open notes');
    for (const n of mine) console.log(`[${n.type}] ${n.title} (${n.id}, ${n.ts})`);
  } else {
    console.log('usage: mc-note.js decision|question|announce|blocker "Title" "Body" [--options "A|B"] | answers | list');
  }
} catch (e) { console.log('mc-note: ' + (e && e.message)); }
process.exit(0);

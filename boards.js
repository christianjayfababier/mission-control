'use strict';
/*
 Boards — per-project Tickets and Todos, stored as one JSON file per project under
 ~/.claude/mission-control/boards/<project-key>.json. The same file is written by kit/mc-board.js from
 the orchestrator's terminal, so the app polls mtimes and pushes changes to the window.
*/
const fs = require('fs');
const path = require('path');

const safeKey = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
const now = () => new Date().toISOString();
/** '2 hours' | '3 days' | '1-2 weeks' → ms (upper bound of a range). Kept in sync with kit/mc-board.js. */
function etaMs(text) { const m = /(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s*(min|minute|hour|hr|h|day|d|week|wk|w|month|mo)/i.exec(String(text)); if (!m) return 0; const n = Number(m[2] || m[1]); const u = m[3].toLowerCase(); const H = 3600e3; return u.startsWith('min') ? n * 60e3 : /^h/.test(u) ? n * H : /^d/.test(u) ? n * 24 * H : /^w/.test(u) ? n * 7 * 24 * H : n * 30 * 24 * H; }
const pad = (n) => String(n).padStart(3, '0');

class Boards {
  constructor(dir) { this.dir = dir; this.mtimes = new Map(); }
  file(p) { return path.join(this.dir, safeKey(p) + '.json'); }
  empty(p) { return { version: 1, project: String(p), tickets: [], todos: [], watches: [], seq: { ticket: 0, todo: 0 } }; }
  load(p) { try { const b = JSON.parse(fs.readFileSync(this.file(p), 'utf8')); b.tickets = b.tickets || []; b.todos = b.todos || []; b.watches = b.watches || []; b.seq = b.seq || { ticket: b.tickets.length, todo: b.todos.length }; return b; } catch { return this.empty(p); } }
  save(p, b) { fs.mkdirSync(this.dir, { recursive: true }); b.updatedAt = now(); const f = this.file(p); fs.writeFileSync(f, JSON.stringify(b, null, 2)); try { this.mtimes.set(f, fs.statSync(f).mtimeMs); } catch { /* ignore */ } return b; }
  addTickets(p, items, source = 'owner') {
    const b = this.load(p);
    for (const it of items) { b.seq.ticket++; b.tickets.push({ id: 'T-' + pad(b.seq.ticket), title: String(it.title || '').slice(0, 200), body: String(it.body || '').slice(0, 8000), type: it.type || 'task', priority: it.priority || 'p2', status: 'new', risk: null, doable: null, effort: null, migration: null, db: null, heavy: null, areas: [], analysis: '', plan: '', eta: null, etaNotes: '', startedAt: null, dueAt: null, pr: '', branch: '', source, createdAt: now(), updatedAt: now(), doneAt: null }); }
    return this.save(p, b);
  }
  addTodos(p, items, owner = 'owner') {
    const b = this.load(p);
    for (const text of items) { b.seq.todo++; b.todos.push({ id: 'D-' + pad(b.seq.todo), text: String(text).slice(0, 1000), done: false, owner, source: 'app', createdAt: now(), doneAt: null }); }
    return this.save(p, b);
  }
  patch(p, kind, id, patch) {
    const b = this.load(p); const list = kind === 'todo' ? b.todos : b.tickets;
    const it = list.find((x) => x.id === id); if (!it) return b;
    Object.assign(it, patch, { updatedAt: now() });
    if (kind === 'ticket') { if (it.status === 'in-progress' && !it.startedAt) it.startedAt = now(); if (it.startedAt && it.eta) { const ms = etaMs(it.eta); if (ms) it.dueAt = new Date(new Date(it.startedAt).getTime() + ms).toISOString(); } }
    if (kind === 'ticket' && patch.status === 'done' && !it.doneAt) it.doneAt = now();
    if (kind === 'ticket' && patch.status && patch.status !== 'done') it.doneAt = null;
    if (kind === 'todo' && patch.done !== undefined) it.doneAt = patch.done ? now() : null;
    return this.save(p, b);
  }
  remove(p, kind, id) { const b = this.load(p); const list = kind === 'todo' ? b.todos : b.tickets; const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); return this.save(p, b); }
  counts(p) { const b = this.load(p); return { tickets: b.tickets.filter((t) => t.status !== 'done').length, todos: b.todos.filter((t) => !t.done).length }; }
  /** Files changed since the last poll (written by mc-board.js or another instance). Returns their boards. */
  poll() {
    let files = []; try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const changed = [];
    for (const f of files) {
      const full = path.join(this.dir, f); let st; try { st = fs.statSync(full); } catch { continue; }
      if (this.mtimes.get(full) === st.mtimeMs) continue;
      this.mtimes.set(full, st.mtimeMs);
      try { const b = JSON.parse(fs.readFileSync(full, 'utf8')); if (b && b.project) changed.push(b); } catch { /* half-written; next poll */ }
    }
    return changed;
  }
}

module.exports = { Boards, safeKey };

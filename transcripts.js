'use strict';
/*
 TranscriptWatcher — discovers Claude Code sessions (orchestrators) and their subagents (workers)
 under ~/.claude/projects and streams incremental, display-ready lines.

   ~/.claude/projects/<slug>/<session>.jsonl
   ~/.claude/projects/<slug>/<session>/subagents/agent-<id>.jsonl (+ .meta.json)

 Emits:
   'lines'    { kind: 'session'|'worker', id, lines: [{seq, ts, type, text}] }
   'changed'  (snapshot is stale; call snapshot())
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

const HOME = os.homedir();
const PROJ_DIR = path.join(HOME, '.claude', 'projects');
const LIVE_MS = 90 * 1000;
const WORKER_LIVE_MS = 20 * 1000;
const WAITING_MS = 6 * 3600 * 1000;
const LINE_CAP = 3000;

function contentItems(msg) {
  const c = msg && msg.content;
  if (Array.isArray(c)) return c;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return [];
}
function textOf(x) { if (typeof x === 'string') return x; if (Array.isArray(x)) return x.map((i) => (i && i.text) || '').join('\n'); return ''; }
function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (input.description) return input.description;
  if (name === 'Bash' || name === 'PowerShell') return input.command || '';
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return input.pattern;
  if (input.query) return input.query;
  if (input.skill) return '/' + input.skill;
  if (input.url) return input.url;
  if (input.prompt) return String(input.prompt).slice(0, 120);
  return '';
}

// Files an agent touched (docs/EXPLORER-CONTRACT.md). Bash/PowerShell edits stay invisible on purpose:
// only the file tools carry a path we can trust.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const FILES_CAP = 100;
/** The file path relative to an agent's cwd (forward slashes), or null when it lies outside cwd.
    Case-insensitive and slash-agnostic, because cwd and the tool input disagree about both on Windows. */
function relTo(cwd, filePath) {
  if (!cwd || !filePath || typeof cwd !== 'string' || typeof filePath !== 'string') return null;
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const file = filePath.replace(/\\/g, '/');
  if (!base) return null;
  const b = base.toLowerCase(), f = file.toLowerCase();
  if (f === b) return '';
  if (!f.startsWith(b + '/')) return null;
  return file.slice(base.length + 1);
}
/** One entry per (op, path): a repeated edit refreshes `ts` and moves the entry to the front (= the end
    of the Map, which `filesOf` reverses). */
function trackFile(agent, name, input, ts) {
  if (!input || typeof input !== 'object') return;
  const op = EDIT_TOOLS.has(name) ? 'edit' : name === 'Read' ? 'read' : null;
  if (!op) return;
  const p = input.file_path || input.notebook_path;
  if (!p || typeof p !== 'string') return;
  const key = op + '\0' + p;
  agent.files.delete(key);
  agent.files.set(key, { path: p, rel: relTo(agent.cwd, p), op, ts: ts || Date.now(), tool: name });
  while (agent.files.size > FILES_CAP) agent.files.delete(agent.files.keys().next().value);
}
/** Newest first, at most FILES_CAP. `rel` is recomputed here because cwd can arrive after the first call. */
function filesOf(agent) {
  const out = [];
  for (const f of agent.files.values()) out.push({ path: f.path, rel: relTo(agent.cwd, f.path), op: f.op, ts: f.ts, tool: f.tool });
  return out.reverse().slice(0, FILES_CAP);
}

class Tailer {
  constructor(file) { this.file = file; this.offset = 0; this.buf = ''; this.mtime = 0; }
  read() {
    let st; try { st = fs.statSync(this.file); } catch { return []; }
    this.mtime = st.mtimeMs;
    if (st.size < this.offset) { this.offset = 0; this.buf = ''; }
    if (st.size === this.offset) return [];
    const len = st.size - this.offset;
    const fd = fs.openSync(this.file, 'r');
    const b = Buffer.alloc(len);
    try { fs.readSync(fd, b, 0, len, this.offset); } finally { fs.closeSync(fd); }
    this.offset = st.size;
    this.buf += b.toString('utf8');
    const parts = this.buf.split('\n');
    this.buf = parts.pop();
    const out = [];
    for (const l of parts) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* skip */ } }
    return out;
  }
}

class LineBuffer {
  constructor() { this.seq = 0; this.lines = []; }
  push(ts, type, text) {
    const l = { seq: ++this.seq, ts: ts ? +ts : Date.now(), type, text: String(text || '').slice(0, 4000) };
    this.lines.push(l);
    if (this.lines.length > LINE_CAP) this.lines.splice(0, this.lines.length - LINE_CAP);
    return l;
  }
}

class Session {
  constructor(id, slug, file) {
    this.id = id; this.slug = slug; this.file = file; this.tailer = new Tailer(file);
    this.cwd = null; this.title = null; this.firstPrompt = null; this.lastActivity = 0; this.lastText = '';
    this.model = null; this.outTokens = 0; this.toolCount = 0; this.gitBranch = null;
    this.pending = new Map(); this.spawns = new Map(); this.agentByToolUse = new Map();
    this.lastStop = null; this.lastLineType = null; this.startedAt = 0;
    this.files = new Map(); // `${op}\0${path}` -> TouchedFile, oldest first
    this.buf = new LineBuffer();
  }
  apply(o, out) {
    const ts = o.timestamp ? new Date(o.timestamp).getTime() : 0;
    if (o.cwd && !this.cwd) this.cwd = o.cwd;
    if (o.gitBranch) this.gitBranch = o.gitBranch;
    if (o.type === 'ai-title') { const t = o.title || o.aiTitle || o.text; if (typeof t === 'string') this.title = t; return; }
    if (o.type !== 'user' && o.type !== 'assistant') return;
    if (ts) { this.lastActivity = Math.max(this.lastActivity, ts); if (!this.startedAt) this.startedAt = ts; }
    this.lastLineType = o.type;
    const msg = o.message || {};
    if (o.type === 'assistant') {
      if (msg.model) this.model = msg.model;
      if (msg.usage && msg.usage.output_tokens) this.outTokens += msg.usage.output_tokens;
      if (msg.stop_reason) this.lastStop = msg.stop_reason;
      for (const it of contentItems(msg)) {
        if (it.type === 'text' && it.text && it.text.trim()) { this.lastText = it.text.trim(); out.push(this.buf.push(ts, 'text', this.lastText)); }
        if (it.type === 'tool_use') {
          this.toolCount++;
          const desc = summarizeToolInput(it.name, it.input);
          trackFile(this, it.name, it.input, ts);
          this.pending.set(it.id, { name: it.name, desc, ts });
          if (it.name === 'Agent' || it.name === 'Task') {
            const sp = { desc: (it.input && it.input.description) || '', type: (it.input && it.input.subagent_type) || 'general-purpose', ts };
            this.spawns.set(it.id, sp);
            out.push(this.buf.push(ts, 'spawn', `spawned ${sp.type} — ${sp.desc}`));
          } else out.push(this.buf.push(ts, 'tool', `${it.name}  ${desc}`));
        }
      }
    } else {
      for (const it of contentItems(msg)) {
        if (it.type === 'tool_result') {
          const p = this.pending.get(it.tool_use_id); this.pending.delete(it.tool_use_id);
          const txt = textOf(it.content);
          const m = /agentId:\s*([0-9a-f]{6,})/i.exec(txt);
          if (m && this.spawns.has(it.tool_use_id)) this.agentByToolUse.set(it.tool_use_id, m[1]);
          if (it.is_error && p) out.push(this.buf.push(ts, 'error', `${p.name} failed: ${txt.slice(0, 300)}`));
        } else if (it.type === 'text' && it.text) {
          const t = it.text;
          if (/<task-notification>/.test(t)) {
            const status = (/<status>([^<]+)<\/status>/.exec(t) || [])[1] || '';
            const sum = (/<summary>([^<]+)<\/summary>/.exec(t) || [])[1] || 'task';
            out.push(this.buf.push(ts, 'note', `${sum} [${status}]`));
          } else if (/<system-reminder>|<command-name>|<local-command/.test(t)) {
            /* harness noise */
          } else {
            const clean = t.replace(/<[^>]+>/g, ' ').trim();
            if (clean) { if (!this.firstPrompt) this.firstPrompt = clean; out.push(this.buf.push(ts, 'you', clean)); }
          }
        }
      }
    }
  }
  get status() {
    const age = Date.now() - this.lastActivity;
    const busy = this.pending.size > 0 || this.lastLineType === 'user';
    if (age < LIVE_MS && busy) return 'working';
    if (age < LIVE_MS) return 'live';
    if (this.lastStop === 'end_turn' && this.pending.size === 0 && age < WAITING_MS) return 'waiting';
    return 'idle';
  }
  get currentTool() { const a = [...this.pending.values()]; return a.length ? a[a.length - 1] : null; }
  summary(workerIds) {
    const ct = this.currentTool;
    return {
      id: this.id, title: this.title || (this.firstPrompt || '').slice(0, 120) || '(new session)', status: this.status,
      lastActivity: this.lastActivity, startedAt: this.startedAt, model: this.model, outTokens: this.outTokens, toolCount: this.toolCount,
      currentTool: ct ? `${ct.name} ${ct.desc || ''}`.trim() : null, lastText: (this.lastText || '').slice(0, 300), gitBranch: this.gitBranch, workerIds,
      cwd: this.cwd, files: filesOf(this),
    };
  }
}

class Worker {
  constructor(id, sessionId, file, metaFile) {
    this.id = id; this.sessionId = sessionId; this.file = file; this.metaFile = metaFile; this.tailer = new Tailer(file);
    this.meta = null; this.startTs = 0; this.lastTs = 0; this.toolCount = 0; this.lastTool = null; this.lastText = ''; this.lastStop = null; this.lastLineType = null; this.outTokens = 0; this.model = null;
    this.pending = new Map(); this.buf = new LineBuffer(); this.sawPrompt = false; this.gitBranch = null; this.cwd = null; this.resumedAt = 0;
    this.files = new Map(); // `${op}\0${path}` -> TouchedFile, oldest first
  }
  loadMeta() { if (this.meta) return; try { this.meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')); } catch { this.meta = {}; } }
  apply(o, out) {
    if (o.gitBranch && o.gitBranch !== 'HEAD') this.gitBranch = o.gitBranch;
    if (o.cwd) this.cwd = o.cwd;
    if (o.type !== 'user' && o.type !== 'assistant') return;
    const ts = o.timestamp ? new Date(o.timestamp).getTime() : 0;
    if (ts) { if (!this.startTs) this.startTs = ts; this.lastTs = Math.max(this.lastTs, ts); }
    this.lastLineType = o.type;
    const msg = o.message || {};
    if (o.type === 'assistant') {
      if (msg.model) this.model = msg.model;
      if (msg.usage && msg.usage.output_tokens) this.outTokens += msg.usage.output_tokens;
      if (msg.stop_reason) this.lastStop = msg.stop_reason;
      for (const it of contentItems(msg)) {
        if (it.type === 'text' && it.text && it.text.trim()) { this.lastText = it.text.trim(); out.push(this.buf.push(ts, 'text', this.lastText)); }
        if (it.type === 'tool_use') {
          this.toolCount++;
          const desc = summarizeToolInput(it.name, it.input);
          trackFile(this, it.name, it.input, ts);
          this.lastTool = { name: it.name, desc, ts }; this.pending.set(it.id, this.lastTool);
          out.push(this.buf.push(ts, 'tool', `${it.name}  ${desc}`));
        }
      }
    } else {
      for (const it of contentItems(msg)) {
        if (it.type === 'tool_result') {
          const p = this.pending.get(it.tool_use_id); this.pending.delete(it.tool_use_id);
          if (it.is_error && p) out.push(this.buf.push(ts, 'error', `${p.name} failed: ${textOf(it.content).slice(0, 300)}`));
        } else if (it.type === 'text' && it.text && (!this.sawPrompt || !/<system-reminder>/.test(it.text))) {
          // a new prompt after the worker ended its turn means it was continued (SendMessage to the same agent id):
          // clear the finished marker so `status` reports 'running' again and the card leaves the Finished list
          if (this.lastStop === 'end_turn') { this.lastStop = null; this.resumedAt = ts || Date.now(); }
          this.sawPrompt = true; out.push(this.buf.push(ts, 'you', it.text.replace(/<[^>]+>/g, ' ').trim()));
        }
      }
    }
  }
  get status() {
    const now = Date.now();
    const fresh = now - this.tailer.mtime < WORKER_LIVE_MS;
    if (this.lastLineType === 'user' || this.pending.size > 0 || this.lastStop === 'tool_use') return fresh || now - this.lastTs < LIVE_MS ? 'running' : 'stalled';
    // a continued worker writes into the same agent-<id>.jsonl: new content after it was done means it is alive again
    if (this.resumedAt && this.lastStop !== 'end_turn' && (fresh || now - this.lastTs < LIVE_MS)) return 'running';
    if (this.lastStop === 'end_turn') return 'done';
    return fresh ? 'running' : 'unknown';
  }
  summary(session) {
    this.loadMeta();
    let sp = null; if (session) for (const [tu, aid] of session.agentByToolUse) if (aid === this.id) sp = session.spawns.get(tu);
    const st = this.status;
    return {
      id: this.id, sessionId: this.sessionId, role: (this.meta && this.meta.agentType) || (sp && sp.type) || 'agent', task: (this.meta && this.meta.description) || (sp && sp.desc) || '',
      status: st, startTs: this.startTs, lastTs: this.lastTs, endTs: st === 'running' ? null : this.lastTs, toolCount: this.toolCount, outTokens: this.outTokens, model: this.model,
      lastTool: this.lastTool ? `${this.lastTool.name} ${this.lastTool.desc || ''}`.trim() : null, lastText: (this.lastText || '').slice(0, 300),
      gitBranch: this.gitBranch, cwd: this.cwd, files: filesOf(this),
    };
  }
}

class TranscriptWatcher extends EventEmitter {
  constructor({ hours = 24 } = {}) {
    super();
    this.hours = hours; this.sessions = new Map(); this.workers = new Map(); this.timers = [];
  }
  start() {
    this.discover(); this.poll();
    this.timers.push(setInterval(() => { try { this.discover(); } catch (e) { this.emit('error', e); } }, 5000));
    this.timers.push(setInterval(() => { try { this.poll(); } catch (e) { this.emit('error', e); } }, 700));
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }
  discover() {
    let slugs = []; try { slugs = fs.readdirSync(PROJ_DIR); } catch { return; }
    const cutoff = Date.now() - this.hours * 3600 * 1000;
    let changed = false;
    for (const slug of slugs) {
      const dir = path.join(PROJ_DIR, slug);
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isFile() || !/^[0-9a-f-]{36}\.jsonl$/i.test(e.name)) continue;
        const file = path.join(dir, e.name);
        let st; try { st = fs.statSync(file); } catch { continue; }
        if (st.mtimeMs < cutoff) continue;
        const id = e.name.replace(/\.jsonl$/, '');
        if (!this.sessions.has(id)) { this.sessions.set(id, new Session(id, slug, file)); changed = true; }
        const subDir = path.join(dir, id, 'subagents');
        let subs = []; try { subs = fs.readdirSync(subDir); } catch { subs = []; }
        for (const f of subs) {
          const m = /^agent-([0-9a-f]+)\.jsonl$/i.exec(f); if (!m) continue;
          if (!this.workers.has(m[1])) { this.workers.set(m[1], new Worker(m[1], id, path.join(subDir, f), path.join(subDir, `agent-${m[1]}.meta.json`))); changed = true; }
        }
      }
    }
    if (changed) this.emit('changed');
  }
  poll() {
    let changed = false;
    for (const s of this.sessions.values()) {
      const lines = s.tailer.read(); if (!lines.length) continue;
      const out = []; for (const o of lines) s.apply(o, out);
      changed = true; if (out.length) this.emit('lines', { kind: 'session', id: s.id, lines: out });
    }
    for (const w of this.workers.values()) {
      const lines = w.tailer.read(); if (!lines.length) continue;
      const out = []; for (const o of lines) w.apply(o, out);
      changed = true; if (out.length) this.emit('lines', { kind: 'worker', id: w.id, lines: out });
    }
    if (changed) this.emit('changed');
  }
  /** Lines for replay when a pane opens. */
  lines(kind, id, afterSeq = 0) {
    const t = kind === 'worker' ? this.workers.get(id) : this.sessions.get(id);
    if (!t) return [];
    return t.buf.lines.filter((l) => l.seq > afterSeq);
  }
  /** Group into projects keyed by lower-cased cwd (or slug). `seenProjects` are ones Mission Control remembers
      from earlier days: merged in so they never vanish, flagged `seen`, and left unpinned. */
  snapshot(extraProjects = [], seenProjects = []) {
    const projects = new Map();
    const ensure = (cwd, slug) => {
      const key = cwd ? cwd.replace(/[\\/]+$/, '').toLowerCase() : 'slug:' + slug;
      let p = projects.get(key);
      if (!p) { p = { key, name: cwd ? path.basename(cwd) : slug, path: cwd || null, slug: slug || null, sessions: [], workers: [], pinned: false, seen: false, lastActivity: 0 }; projects.set(key, p); }
      return p;
    };
    for (const ep of extraProjects) { const p = ensure(ep.path, null); p.pinned = true; if (ep.name) p.name = ep.name; }
    for (const sp of seenProjects) {
      if (!sp.path) continue;
      const p = ensure(sp.path, sp.slug || null);
      p.seen = true;
      if (!p.pinned && sp.name) p.name = sp.name;
      if (sp.slug && !p.slug) p.slug = sp.slug;
      const t = Date.parse(sp.lastSeen || sp.firstSeen || ''); if (t) p.lastActivity = Math.max(p.lastActivity, t);
    }
    const workersBySession = new Map();
    for (const w of this.workers.values()) { if (!workersBySession.has(w.sessionId)) workersBySession.set(w.sessionId, []); workersBySession.get(w.sessionId).push(w); }
    for (const s of this.sessions.values()) {
      const p = ensure(s.cwd, s.slug);
      const ws = workersBySession.get(s.id) || [];
      p.sessions.push(s.summary(ws.map((w) => w.id)));
      for (const w of ws) p.workers.push(w.summary(s));
    }
    const arr = [...projects.values()];
    for (const p of arr) {
      p.sessions.sort((a, b) => b.lastActivity - a.lastActivity);
      p.workers.sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.lastTs - a.lastTs);
      p.lastActivity = Math.max(p.lastActivity || 0, ...p.sessions.map((s) => s.lastActivity));
      p.live = p.sessions.filter((s) => s.status === 'working' || s.status === 'live').length;
      p.waiting = p.sessions.filter((s) => s.status === 'waiting').length;
      p.running = p.workers.filter((w) => w.status === 'running').length;
    }
    arr.sort((a, b) => (b.live + b.running) - (a.live + a.running) || (b.pinned - a.pinned) || b.lastActivity - a.lastActivity);
    return { generatedAt: Date.now(), projects: arr };
  }
}

module.exports = { TranscriptWatcher, relTo };

'use strict';
/*
 CheckpointWriter — turns what the TranscriptWatcher knows into a memory note per project.

 Claude Code loads ~/.claude/projects/<slug>/memory/MEMORY.md into every session for that project,
 so a note there is the one place a fresh orchestrator is guaranteed to look. After every turn and
 every worker change we rewrite `mission-control-checkpoint.md` (latest state, not a diary) and make
 sure MEMORY.md points at it. Purely mechanical: no model calls, no cost, always current.
*/
const fs = require('fs');
const path = require('path');

const NOTE = 'mission-control-checkpoint.md';
const POINTER = `- [Mission Control checkpoint](${NOTE}) — auto-updated after every turn and worker change: last request, session state, every worker's task/status/result. Read first at session start.`;
const HOURS = 48;

const pad = (n) => String(n).padStart(2, '0');
function stamp(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function clock(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function dur(ms) { if (!isFinite(ms) || ms < 0) return '?'; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm'; return Math.floor(m / 60) + 'h' + pad(m % 60) + 'm'; }
function one(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

class CheckpointWriter {
  constructor(watcher, { projRoot, debounceMs = 15000 } = {}) {
    this.watcher = watcher; this.projRoot = projRoot; this.debounceMs = debounceMs;
    this.dirty = new Set(); this.timer = null; this.lastBody = new Map(); this.disabled = false;
  }
  start() {
    const mark = (slugs) => { for (const s of slugs) this.dirty.add(s); this.schedule(); };
    this.watcher.on('lines', ({ kind, id }) => {
      const s = kind === 'session' ? this.watcher.sessions.get(id) : (() => { const w = this.watcher.workers.get(id); return w && this.watcher.sessions.get(w.sessionId); })();
      if (s) mark([s.slug]);
    });
    this.watcher.on('changed', () => mark([...this.watcher.sessions.values()].filter((s) => Date.now() - s.lastActivity < 10 * 60 * 1000).map((s) => s.slug)));
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  schedule() { if (this.timer || this.disabled) return; this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.debounceMs); }
  flush() {
    const slugs = [...this.dirty]; this.dirty.clear();
    for (const slug of slugs) { try { this.writeSlug(slug); } catch (e) { console.error('checkpoint', slug, e && e.message); } }
  }

  writeSlug(slug) {
    const cutoff = Date.now() - HOURS * 3600 * 1000;
    const sessions = [...this.watcher.sessions.values()].filter((s) => s.slug === slug && s.lastActivity > cutoff).sort((a, b) => b.lastActivity - a.lastActivity);
    if (!sessions.length) return;
    const body = this.render(slug, sessions);
    if (this.lastBody.get(slug) === body) return;
    const dir = path.join(this.projRoot, slug, 'memory');
    fs.mkdirSync(dir, { recursive: true });
    const cwd = sessions.find((s) => s.cwd)?.cwd || '';
    const head = `---\nname: mission-control-checkpoint\ndescription: "Auto-written by Mission Control: latest state of this project's Claude sessions and workers (last request, last message, every worker's task/status/result). Read first at session start."\nmetadata:\n  type: project\n  source: mission-control\n---\n\n`;
    const intro = `Updated ${stamp(Date.now())} by Mission Control. Automatic; do not edit by hand (it is overwritten). Project: ${cwd || slug}\n\n`;
    fs.writeFileSync(path.join(dir, NOTE), head + intro + body);
    this.lastBody.set(slug, body);
    const idx = path.join(dir, 'MEMORY.md');
    let index = ''; try { index = fs.readFileSync(idx, 'utf8'); } catch { index = ''; }
    if (!index.includes(`(${NOTE})`)) fs.writeFileSync(idx, (index.trimEnd() + (index.trim() ? '\n' : '') + POINTER + '\n'));
  }

  render(slug, sessions) {
    const out = [];
    const workersBySession = new Map();
    for (const w of this.watcher.workers.values()) { if (!workersBySession.has(w.sessionId)) workersBySession.set(w.sessionId, []); workersBySession.get(w.sessionId).push(w); }
    sessions.slice(0, 3).forEach((s, i) => {
      const lines = s.buf.lines;
      const isNoise = (l) => /^\[Image:/.test(l.text) || !l.text.trim();
      const lastYou = [...lines].reverse().find((l) => l.type === 'you' && !isNoise(l));
      const title = s.title || one(s.firstPrompt, 100) || '(untitled)';
      out.push(`## ${i === 0 ? 'Latest session' : 'Earlier session'}: ${one(title, 120)}`);
      out.push(`- id: ${s.id} · status: ${s.status} · model: ${s.model || '?'} · started ${s.startedAt ? stamp(s.startedAt) : '?'} · last activity ${stamp(s.lastActivity)} · ${s.toolCount} tool calls${s.gitBranch ? ' · branch ' + s.gitBranch : ''}`);
      if (lastYou) out.push(`- **Last request from the owner (${clock(lastYou.ts)}):** ${one(lastYou.text, 600)}`);
      if (s.lastText) out.push(`- **Last message from the orchestrator:** ${one(s.lastText, 900)}`);
      const ct = s.currentTool; if (ct) out.push(`- **Was in the middle of:** ${one(ct.name + ' ' + (ct.desc || ''), 200)}`);
      const ws = (workersBySession.get(s.id) || []).sort((a, b) => a.startTs - b.startTs);
      if (ws.length) {
        out.push('', `### Workers (${ws.length})`);
        for (const w of ws) {
          const sm = w.summary(s);
          const status = sm.status.toUpperCase();
          const time = dur((sm.status === 'running' ? Date.now() : sm.lastTs) - sm.startTs);
          out.push(`- [${status} · ${time} · ${sm.toolCount} tools] **${sm.role}** — ${one(sm.task, 160) || '(no description)'}`);
          if (sm.status === 'running' && sm.lastTool) out.push(`  - now: ${one(sm.lastTool, 160)}`);
          if (sm.lastText) out.push(`  - last message: ${one(sm.lastText, 400)}`);
        }
      }
      const recent = lines.filter((l) => (l.type === 'you' || l.type === 'text' || l.type === 'spawn' || l.type === 'note' || l.type === 'error') && !isNoise(l)).slice(-14);
      if (recent.length) {
        out.push('', '### Recent activity');
        for (const l of recent) out.push(`- ${clock(l.ts)} ${l.type === 'text' ? 'orchestrator' : l.type === 'you' ? 'owner' : l.type}: ${one(l.text, 180)}`);
      }
      out.push('');
    });
    return out.join('\n');
  }
}

module.exports = { CheckpointWriter };

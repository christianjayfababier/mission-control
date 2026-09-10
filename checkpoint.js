'use strict';
/*
 CheckpointWriter — turns what Mission Control knows into two memory notes per project.

 Claude Code loads ~/.claude/projects/<slug>/memory/MEMORY.md into every session for that project, so a
 note there is the one place a fresh orchestrator is guaranteed to look. Purely mechanical: no model calls.

   mission-control-checkpoint.md  — the CURRENT state, rewritten after every turn and worker change: last
                                    request, last message, workers, board (tickets/todos), inbox, PRs in flight,
                                    repo and account.
   mission-control-journal.md     — HISTORY, appended day by day: owner requests, orchestrator answers, worker
                                    completions, inbox decisions and answers, PR/deploy events, ticket changes.
*/
const fs = require('fs');
const path = require('path');

const NOTE = 'mission-control-checkpoint.md';
const JOURNAL = 'mission-control-journal.md';
const POINTER = `- [Mission Control checkpoint](${NOTE}) — auto-updated after every turn and worker change: last request, session state, workers, tickets/todos, inbox, PRs in flight, repo and account. Read first at session start.`;
const JPOINTER = `- [Mission Control journal](${JOURNAL}) — auto-appended history, day by day: owner requests, orchestrator answers, worker results, decisions answered in the inbox, PR and deployment events, ticket changes. Skim the last days at standup.`;
const HOURS = 48;
const JOURNAL_DAYS = 45;

const pad = (n) => String(n).padStart(2, '0');
function stamp(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function day(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function clock(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function dur(ms) { if (!isFinite(ms) || ms < 0) return '?'; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm'; return Math.floor(m / 60) + 'h' + pad(m % 60) + 'm'; }
function one(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
const isNoise = (l) => /^\[Image:/.test(l.text) || !String(l.text || '').trim();
const keyOf = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();

class CheckpointWriter {
  /**
   * @param watcher TranscriptWatcher
   * @param opts.projRoot   ~/.claude/projects
   * @param opts.context    (projectPath) => { board, notes, inflight, repo, account, settings }  — what lives outside the transcripts
   */
  constructor(watcher, { projRoot, debounceMs = 15000, context = null } = {}) {
    this.watcher = watcher; this.projRoot = projRoot; this.debounceMs = debounceMs; this.context = context;
    this.dirty = new Set(); this.timer = null; this.lastBody = new Map(); this.disabled = false;
    this.jstate = new Map(); // sessionId -> { youSeq, lastText, workersDone:Set }
  }
  start() {
    const mark = (slugs) => { for (const s of slugs) this.dirty.add(s); this.schedule(); };
    this.watcher.on('lines', ({ kind, id }) => {
      const s = kind === 'session' ? this.watcher.sessions.get(id) : (() => { const w = this.watcher.workers.get(id); return w && this.watcher.sessions.get(w.sessionId); })();
      if (s) mark([s.slug]);
    });
    this.watcher.on('changed', () => mark([...this.watcher.sessions.values()].filter((s) => Date.now() - s.lastActivity < 10 * 60 * 1000).map((s) => s.slug)));
    // at startup, bring every project with recent sessions up to date (the app may have been closed while they worked)
    setTimeout(() => { mark([...this.watcher.sessions.values()].map((s) => s.slug)); }, 8000);
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  schedule() { if (this.timer || this.disabled) return; this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.debounceMs); }
  flush() {
    const slugs = [...this.dirty]; this.dirty.clear();
    for (const slug of slugs) { try { this.writeSlug(slug); } catch (e) { console.error('checkpoint', slug, e && e.message); } }
  }

  /** Memory directory slug for a project path: the one its sessions use, else an existing dir in either case, else the lowercase form. */
  slugFor(projectPath) {
    const k = keyOf(projectPath);
    for (const s of this.watcher.sessions.values()) if (s.cwd && keyOf(s.cwd) === k) return s.slug;
    const base = String(projectPath).replace(/[\\/]+$/, '').replace(/[:\\/]/g, '-');
    for (const c of [base, base.charAt(0).toLowerCase() + base.slice(1), base.charAt(0).toUpperCase() + base.slice(1)]) if (fs.existsSync(path.join(this.projRoot, c))) return c;
    return base.charAt(0).toLowerCase() + base.slice(1);
  }
  memDir(slug) { const dir = path.join(this.projRoot, slug, 'memory'); fs.mkdirSync(dir, { recursive: true }); return dir; }
  ensurePointer(dir, pointer, marker) {
    const idx = path.join(dir, 'MEMORY.md');
    let index = ''; try { index = fs.readFileSync(idx, 'utf8'); } catch { index = ''; }
    if (!index.includes(marker)) fs.writeFileSync(idx, index.trimEnd() + (index.trim() ? '\n' : '') + pointer + '\n');
  }

  // ── journal (history)
  /** Append one line to the project's journal under today's date. `projectOrSlug` may be a path or a slug. */
  journal(projectOrSlug, text, ts = Date.now()) {
    try {
      const slug = /[\\/]/.test(projectOrSlug) ? this.slugFor(projectOrSlug) : projectOrSlug;
      const dir = this.memDir(slug); const file = path.join(dir, JOURNAL);
      let body = ''; try { body = fs.readFileSync(file, 'utf8'); } catch { body = ''; }
      if (!body) body = `---\nname: mission-control-journal\ndescription: "Auto-written by Mission Control: day-by-day history of this project — owner requests, orchestrator answers, worker results, inbox decisions and answers, PR and deployment events, ticket changes. The checkpoint has the current state; this has how we got here."\nmetadata:\n  type: project\n  source: mission-control\n---\n\nAutomatic; do not edit by hand. Newest day last.\n`;
      const head = `\n## ${day(ts)}\n`;
      if (!body.includes(head)) body = body.trimEnd() + '\n' + head;
      body = body.trimEnd() + `\n- ${clock(ts)} ${one(text, 320)}\n`;
      // keep the file bounded: drop the oldest days beyond the limit
      const parts = body.split(/\n(?=## \d{4}-\d{2}-\d{2}\n)/);
      if (parts.length - 1 > JOURNAL_DAYS) body = [parts[0], ...parts.slice(parts.length - JOURNAL_DAYS)].join('\n');
      fs.writeFileSync(file, body);
      this.ensurePointer(dir, JPOINTER, `(${JOURNAL})`);
    } catch (e) { console.error('journal', e && e.message); }
  }
  journalHas(slug, sessionId) { try { return fs.readFileSync(path.join(this.projRoot, slug, 'memory', JOURNAL), 'utf8').includes(`session ${sessionId.slice(0, 8)} `); } catch { return false; } }
  /** Transcript-derived journal entries for one session: new owner requests, the orchestrator's answer when the turn ended, workers that finished. */
  journalSession(s, workers) {
    const js = this.jstate.get(s.id) || { youSeq: 0, lastText: '', workersDone: new Set(), primed: false };
    if (!js.primed) {
      // first sight of this session: backfill the last 24 h (owner requests and the answers that preceded the next request), then follow live
      js.primed = true; const since = Date.now() - 24 * 3600 * 1000; const lines = s.buf.lines; let n = 0;
      if (!this.journalHas(s.slug, s.id)) {
        for (let i = 0; i < lines.length && n < 60; i++) {
          const l = lines[i]; if (l.ts < since || isNoise(l)) continue;
          if (l.type === 'you') { this.journal(s.slug, `owner: ${l.text}`, l.ts); n++; }
          else if (l.type === 'text' && lines[i + 1] && lines[i + 1].type === 'you') { this.journal(s.slug, `orchestrator: ${l.text}`, l.ts); n++; }
        }
        this.journal(s.slug, `session ${s.id.slice(0, 8)} "${one(s.title || s.firstPrompt, 60)}" now followed by Mission Control${n ? ` (${n} earlier entries backfilled above)` : ''}`);
      }
      js.youSeq = Math.max(0, ...lines.map((l) => l.seq)); js.lastText = s.lastText; for (const w of workers) if (w.status !== 'running') js.workersDone.add(w.id); this.jstate.set(s.id, js);
      if (Date.now() - s.lastActivity > 30 * 60 * 1000) return;
    }
    for (const l of s.buf.lines) { if (l.seq > js.youSeq && l.type === 'you' && !isNoise(l)) this.journal(s.slug, `owner: ${l.text}`, l.ts); if (l.seq > js.youSeq) js.youSeq = Math.max(js.youSeq, l.seq); }
    const st = s.status;
    if (s.lastText && s.lastText !== js.lastText && (st === 'waiting' || st === 'idle' || st === 'live')) { js.lastText = s.lastText; this.journal(s.slug, `orchestrator: ${s.lastText}`, s.lastActivity); }
    for (const w of workers) { if (w.status === 'running' || js.workersDone.has(w.id)) continue; js.workersDone.add(w.id); const sm = w.summary(s); this.journal(s.slug, `worker ${sm.status} · ${sm.role} — ${one(sm.task, 120)}${sm.gitBranch ? ' · ' + sm.gitBranch : ''} → ${one(sm.lastText, 160)}`, sm.lastTs || Date.now()); }
    this.jstate.set(s.id, js);
  }

  // ── checkpoint (current state)
  writeSlug(slug) {
    const cutoff = Date.now() - HOURS * 3600 * 1000;
    const sessions = [...this.watcher.sessions.values()].filter((s) => s.slug === slug && s.lastActivity > cutoff).sort((a, b) => b.lastActivity - a.lastActivity);
    if (!sessions.length) return;
    const workersBySession = new Map();
    for (const w of this.watcher.workers.values()) { if (!workersBySession.has(w.sessionId)) workersBySession.set(w.sessionId, []); workersBySession.get(w.sessionId).push(w); }
    for (const s of sessions) this.journalSession(s, workersBySession.get(s.id) || []);
    const cwd = (sessions.find((s) => s.cwd) || {}).cwd || '';
    const ctx = cwd && this.context ? (this.context(cwd) || {}) : {};
    const body = this.render(sessions, workersBySession, ctx);
    if (this.lastBody.get(slug) === body) return;
    const dir = this.memDir(slug);
    const head = `---\nname: mission-control-checkpoint\ndescription: "Auto-written by Mission Control: current state of this project — last request, last message, workers, tickets and todos, inbox, PRs in flight, repo and account. Read first at session start."\nmetadata:\n  type: project\n  source: mission-control\n---\n\n`;
    const intro = `Updated ${stamp(Date.now())} by Mission Control. Automatic; do not edit by hand (it is overwritten). Project: ${cwd || slug}\n\n`;
    fs.writeFileSync(path.join(dir, NOTE), head + intro + body);
    this.lastBody.set(slug, body);
    this.ensurePointer(dir, POINTER, `(${NOTE})`);
  }

  render(sessions, workersBySession, ctx) {
    const out = [];
    // project facts that live outside the transcripts
    if (ctx.repo || ctx.account) out.push('## Repository', `- ${ctx.repo ? `GitHub ${ctx.repo.full} (${ctx.repo.url})` : 'no GitHub remote'}${ctx.account ? ` · commits and PRs as ${ctx.account}` : ''}${ctx.branch ? ` · local branch ${ctx.branch}` : ''}`, '');
    if (ctx.inflight && ctx.inflight.length) { out.push('## Pull requests in flight'); for (const x of ctx.inflight) out.push(`- PR #${x.number} ${one(x.title, 80)} · ${x.stage === 'merged' ? 'merged, deploying' : 'open, checks ' + (x.checks || 'unknown')} · ${x.branch || ''} · ${x.url}`); out.push(''); }
    if (ctx.board) {
      const open = ctx.board.tickets.filter((t) => t.status !== 'done'); const todos = ctx.board.todos.filter((t) => !t.done);
      if (open.length) { out.push(`## Tickets (${open.length} open, ${ctx.board.tickets.length - open.length} done)`); for (const t of open.slice(0, 40)) out.push(`- ${t.id} [${t.status}] ${t.type}/${t.priority} ${one(t.title, 100)}${t.risk ? ` · risk ${t.risk}` : ''}${t.doable ? ` · doable ${t.doable}` : ''}${t.effort ? ` · ${t.effort}` : ''}${t.migration ? ' · MIGRATION' : ''}${t.db ? ' · DB' : ''}${t.heavy ? ' · HEAVY' : ''}${t.branch ? ' · ' + t.branch : ''}${t.pr ? ' · ' + t.pr : ''}`); out.push(''); }
      if (todos.length) { out.push(`## Todos (${todos.length} open)`); for (const t of todos.slice(0, 40)) out.push(`- ${t.id} ${one(t.text, 160)} (${t.owner})`); out.push(''); }
    }
    if (ctx.notes && ctx.notes.length) { out.push(`## Inbox: waiting for the owner (${ctx.notes.length})`); for (const n of ctx.notes.slice(0, 20)) out.push(`- [${n.type}] ${one(n.title, 100)}${n.options && n.options.length ? ' · options: ' + n.options.join(' | ') : ''} (${stamp(new Date(n.ts).getTime())})`); out.push(''); }
    sessions.slice(0, 3).forEach((s, i) => {
      const lines = s.buf.lines;
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
          const sm = w.summary(s); const status = sm.status.toUpperCase(); const time = dur((sm.status === 'running' ? Date.now() : sm.lastTs) - sm.startTs);
          const model = (sm.model || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
          out.push(`- [${status} · ${time} · ${sm.toolCount} tools${model ? ' · ' + model : ''}${sm.gitBranch ? ' · branch ' + sm.gitBranch : ''}] **${sm.role}** — ${one(sm.task, 160) || '(no description)'}`);
          if (sm.status === 'running' && sm.lastTool) out.push(`  - now: ${one(sm.lastTool, 160)}`);
          if (sm.lastText) out.push(`  - last message: ${one(sm.lastText, 400)}`);
        }
      }
      const recent = lines.filter((l) => (l.type === 'you' || l.type === 'text' || l.type === 'spawn' || l.type === 'note' || l.type === 'error') && !isNoise(l)).slice(-14);
      if (recent.length) { out.push('', '### Recent activity'); for (const l of recent) out.push(`- ${clock(l.ts)} ${l.type === 'text' ? 'orchestrator' : l.type === 'you' ? 'owner' : l.type}: ${one(l.text, 180)}`); }
      out.push('');
    });
    return out.join('\n');
  }
}

module.exports = { CheckpointWriter };

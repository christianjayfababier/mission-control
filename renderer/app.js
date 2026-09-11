/* global Terminal, FitAddon, WebLinksAddon */
'use strict';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmtAgo = (ms) => { if (ms == null || !isFinite(ms)) return ''; const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's'; const h = Math.floor(m / 60); return h < 48 ? h + 'h' + String(m % 60).padStart(2, '0') + 'm' : Math.floor(h / 24) + 'd'; };
const fmtTok = (n) => !n ? '0' : n < 1000 ? String(n) : n < 1e6 ? (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k' : (n / 1e6).toFixed(2) + 'M';
const clock = (ts) => new Date(ts).toTimeString().slice(0, 8);

const state = {
  env: { ptyAvailable: false }, snapshot: { projects: [] }, selected: null, showFinished: true,
  idleOpen: false,       // sidebar "Idle" group expanded? (remembered in localStorage)
  terms: new Map(),      // projectKey -> [{ptyId, term, fit, el, tab}]
  activeTab: new Map(),  // projectKey -> tab id ('pty1' | 'sess:<id>')
  panes: new Map(),      // paneId -> {el, body, lastSeq, kind, id}
  dismissed: new Set(),  // worker ids hidden by user
  hosts: new Map(),      // sessionId -> ptyId of the terminal running that Claude session (lets the Session tab talk to it)
  lead: new Map(),       // projectKey -> sessionId of the project's orchestrator (lead) session; persisted in localStorage
  leadPanes: new Map(),  // projectKey -> launcher pane element shown on the Orchestrator tab when no lead session is running here
  maximized: null,
};
try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem('mc.lead') || '{}'))) state.lead.set(k, v); } catch { /* fresh */ }
function saveLead() { try { localStorage.setItem('mc.lead', JSON.stringify(Object.fromEntries(state.lead))); } catch { /* ignore */ } }
const prefGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } };
const prefSet = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* ignore */ } };
state.idleOpen = prefGet('mc.idleOpen', false);
const termTheme = { background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff', selectionBackground: '#264f78', black: '#0d1117', brightBlack: '#6e7681', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4', brightWhite: '#f0f6fc' };

// ───────────── sidebar
// Nothing is ever dropped: every project Mission Control has seen a session in stays in the list. The ones that are
// quiet right now sit in a collapsed "Idle" group instead of disappearing (main.js remembers them in seen-projects.json).
const ACTIVE_MS = 6 * 3600 * 1000;
function isActiveProject(p) { return !!(p.live || p.running || p.waiting || (Date.now() - (p.lastActivity || 0) < ACTIVE_MS)); }
function projectRow(p) {
  const li = el('li', 'proj' + (p.key === state.selected ? ' sel' : ''));
  li.appendChild(el('span', 'dot' + (p.live ? ' live' : p.waiting ? ' waiting' : '')));
  const mid = el('div'); mid.appendChild(el('div', 'proj-name', p.name)); mid.appendChild(el('div', 'proj-path', p.path || ('~/.claude/projects/' + p.slug)));
  li.appendChild(mid);
  const b = el('div', 'proj-badges');
  if (p.live) b.appendChild(el('span', 'badge live', p.live + ' live'));
  if (p.running) b.appendChild(el('span', 'badge run', p.running + ' running'));
  if (!p.live && !p.running) b.appendChild(el('span', 'badge', p.lastActivity ? fmtAgo(Date.now() - p.lastActivity) : p.pinned ? 'pinned' : 'seen'));
  li.appendChild(b);
  li.title = (p.path || '') + (p.pinned ? '\nAdded by you · right-click to remove from the sidebar' : p.seen ? '\nRemembered from an earlier session · right-click to hide' : '');
  li.onclick = () => selectProject(p.key);
  li.oncontextmenu = (e) => {
    e.preventDefault();
    if (p.pinned) { if (confirm(`Remove "${p.name}" from the sidebar? (Sessions are not affected.)`)) window.mc.removeProject(p.path); return; }
    if (p.path && confirm(`Hide "${p.name}" from the sidebar? Mission Control keeps remembering it; add the folder again to bring it back.`)) window.mc.hideProject(p.path);
  };
  return li;
}
function renderSidebar() {
  const ul = $('#projects'); ul.innerHTML = '';
  const all = state.snapshot.projects || [];
  const active = all.filter(isActiveProject);   // snapshot order is kept: live+running, then pinned, then last activity
  const idle = all.filter((p) => !isActiveProject(p));
  if (state.selected && !all.some((p) => p.key === state.selected)) state.selected = null;
  if (!state.selected) state.selected = (active[0] || idle[0] || {}).key || null;
  if (active.length) { ul.appendChild(el('li', 'proj-grp', 'Active')); for (const p of active) ul.appendChild(projectRow(p)); }
  if (idle.length) {
    const h = el('li', 'proj-grp toggle' + (state.idleOpen ? ' open' : ''));
    h.appendChild(el('span', 'caret', state.idleOpen ? '▾' : '▸')); h.appendChild(el('span', null, 'Idle'));
    h.appendChild(el('span', 'badge', String(idle.length)));
    h.title = 'Projects with nothing running and no activity in the last 6 hours. They are never dropped.';
    h.onclick = () => { state.idleOpen = !state.idleOpen; prefSet('mc.idleOpen', state.idleOpen); renderSidebar(); };
    ul.appendChild(h);
    if (state.idleOpen) for (const p of idle) ul.appendChild(projectRow(p));
    else { const sel = idle.find((p) => p.key === state.selected); if (sel) ul.appendChild(projectRow(sel)); } // the open project stays visible
  }
  if (!all.length) ul.appendChild(el('li', 'proj-grp', 'No projects yet'));
  const live = all.reduce((a, p) => a + p.live, 0), run = all.reduce((a, p) => a + p.running, 0), wait = all.reduce((a, p) => a + p.waiting, 0);
  const notes = state.snapshot.openNotes || 0;
  $('#totals').innerHTML = `<b>${live}</b> live · <b>${run}</b> workers running · <b>${wait}</b> waiting for you${notes ? ` · <b>${notes}</b> in your inbox` : ''}`;
}

// ───────────── project selection / header
function currentProject() { return (state.snapshot.projects || []).find((p) => p.key === state.selected) || null; }
window.MC = {
  currentProject: () => currentProject(), state,
  /** Type a message into the project's lead session (or any Claude session hosted here). Returns the terminal title, or null. */
  sendToLead(p, msg) {
    let host = null; const lead = state.lead.get(p.key); if (lead) host = hostOf(lead);
    if (!host) for (const t of state.terms.get(p.key) || []) if (t.sessionId && hostOf(t.sessionId)) { host = t; break; }
    if (!host) return null; sendToSession(host.sessionId, msg); return host.title;
  },
};
function selectProject(key) {
  state.selected = key; state.maximized = null;
  const p = currentProject();
  document.dispatchEvent(new CustomEvent('mc:project-selected', { detail: { key } }));
  renderSidebar();
  $('#ph-name').textContent = p ? p.name : 'Select a project';
  $('#ph-path').textContent = p ? (p.path || '') : '';
  renderHeader(p); renderPrStrip(p);
  if (window.Explorer) window.Explorer.render(p, state.snapshot);   // files/branches panel follows the selection
  // show this project's panes, hide the others
  for (const [k, list] of state.terms) for (const t of list) t.el.classList.toggle('active', false);
  renderTabs();
  if (p && p.path && !state.terms.has(key) && state.env.ptyAvailable) newTerminal(p, { activate: false });
  activateTab(state.activeTab.get(key) || firstTabId(key));
  renderWorkers();
}
function firstTabId(key) { const p = currentProject(); return p ? 'lead' : null; }

// ───────────── tabs: terminals + session monitors
function renderTabs() {
  const tabs = $('#orch-tabs'); tabs.innerHTML = '';
  const p = currentProject(); if (!p) return;
  const active = state.activeTab.get(p.key);
  // Orchestrator (lead) tab first: the one place to command this project's lead session
  const leadSid = state.lead.get(p.key) || null;
  const leadSess = leadSid ? p.sessions.find((s) => s.id === leadSid) : null;
  const leadHost = leadSid ? hostOf(leadSid) : null;
  const lt = el('div', 'tab lead' + (active === 'lead' ? ' active' : ''));
  lt.appendChild(el('span', 'st ' + (leadSess ? leadSess.status : leadHost ? 'live' : '')));
  lt.appendChild(el('span', null, `${window.Persona.forLead(p).name} · Orchestrator`));
  lt.title = leadSess ? `${leadSess.status} · ${leadSess.title}` : 'Start or resume the lead session for this project';
  lt.onclick = () => activateTab('lead'); tabs.appendChild(lt);
  const counts = (window.Board && window.Board.counts(p)) || p.boardCounts || { tickets: 0, todos: 0 };
  for (const [id, label, n] of [['tickets', 'Tickets', counts.tickets], ['todos', 'Todos', counts.todos]]) {
    const bt = el('div', 'tab board-tab' + (active === id ? ' active' : ''));
    bt.appendChild(el('span', null, label)); if (n) bt.appendChild(el('span', 'badge', String(n)));
    bt.onclick = () => activateTab(id); tabs.appendChild(bt);
  }
  for (const t of state.terms.get(p.key) || []) {
    const tab = el('div', 'tab' + (active === t.ptyId ? ' active' : ''));
    tab.appendChild(el('span', null, t.title + (t.lead ? ' ▸ ' + window.Persona.forLead(p).name : t.sessionId || t.claudeAt ? ' ▸ claude' : '')));
    const x = el('span', 'x', '×'); x.title = 'Close terminal'; x.onclick = (e) => { e.stopPropagation(); closeTerminal(p.key, t.ptyId); };
    tab.appendChild(x); tab.onclick = () => activateTab(t.ptyId); tabs.appendChild(tab);
  }
  p.sessions.filter((s) => s.id !== leadSid).slice(0, 6).forEach((s, i) => {
    const id = 'sess:' + s.id;
    const tab = el('div', 'tab' + (active === id ? ' active' : ''));
    tab.appendChild(el('span', 'st ' + s.status)); tab.appendChild(el('span', null, `Session ${i + 1}: ${s.title.slice(0, 40)}`));
    tab.title = `${s.status} · ${s.model || ''} · ${s.toolCount} tools · ${fmtTok(s.outTokens)} out`;
    tab.onclick = () => activateTab(id); tabs.appendChild(tab);
  });
  matchHosts(p); refreshSessionFooters(p);
}
function activateTab(id) {
  const p = currentProject(); if (!p) return;
  state.activeTab.set(p.key, id);
  $('#orch-empty').style.display = id ? 'none' : 'flex';
  for (const pane of $('#orch-body').querySelectorAll('.pane')) pane.classList.remove('active');
  if (!id) { renderTabs(); return; }
  if (id === 'lead') {
    const sid = state.lead.get(p.key);
    const hosted = sid && hostOf(sid) && p.sessions.some((s) => s.id === sid);
    if (hosted) { const pane = ensurePane('session', sid, $('#orch-body'), 'pane sess'); pane.el.classList.add('active'); }
    else { renderLeadPane(p).classList.add('active'); }
  } else if (id === 'tickets' || id === 'todos') {
    if (window.Board) window.Board.pane(id, p).classList.add('active');
  } else if (id.startsWith('sess:')) {
    const sid = id.slice(5);
    const pane = ensurePane('session', sid, $('#orch-body'), 'pane sess');
    pane.el.classList.add('active');
  } else {
    const t = (state.terms.get(p.key) || []).find((x) => x.ptyId === id);
    if (t) { t.el.classList.add('active'); setTimeout(() => { try { t.fit.fit(); window.mc.ptyResize(t.ptyId, t.term.cols, t.term.rows); t.term.focus(); } catch { /* ignore */ } }, 0); }
  }
  renderTabs();
}

// ───────────── terminals
async function newTerminal(p, { activate = true } = {}) {
  if (!state.env.ptyAvailable) { alert('Terminals are unavailable: ' + (state.env.ptyError || 'node-pty failed to load')); return; }
  if (!state.terms.has(p.key)) state.terms.set(p.key, []); // claim the slot synchronously so a racing snapshot does not open a second terminal
  const container = el('div', 'pane term');
  $('#orch-body').appendChild(container);
  const term = new Terminal({ theme: termTheme, fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: true });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(container); fit.fit();
  const ptyId = await window.mc.ptyCreate({ cwd: p.path, cols: term.cols, rows: term.rows });
  const list = state.terms.get(p.key) || []; const n = list.length + 1;
  const rec = { ptyId, term, fit, el: container, title: `Terminal ${n}`, projectKey: p.key, sessionId: null, claudeAt: 0, typed: '' };
  list.push(rec); state.terms.set(p.key, list);
  term.onData((d) => { window.mc.ptyWrite(ptyId, d); trackTyped(rec, d); });
  new ResizeObserver(() => { if (container.classList.contains('active')) { try { fit.fit(); window.mc.ptyResize(ptyId, term.cols, term.rows); } catch { /* ignore */ } } }).observe(container);
  if (activate) activateTab(ptyId); else renderTabs();
  return rec;
}
function closeTerminal(key, ptyId) {
  const list = state.terms.get(key) || []; const i = list.findIndex((t) => t.ptyId === ptyId); if (i < 0) return;
  const t = list[i]; window.mc.ptyKill(ptyId); t.term.dispose(); t.el.remove(); list.splice(i, 1); unhost(t);
  if (state.activeTab.get(key) === ptyId) state.activeTab.set(key, firstTabId(key));
  activateTab(state.activeTab.get(key));
}
function unhost(rec) { rec.sessionId = null; rec.claudeAt = 0; rec.lead = false; for (const [sid, pid] of state.hosts) if (pid === rec.ptyId) state.hosts.delete(sid); }
window.mc.onPtyData(({ id, data }) => { for (const list of state.terms.values()) for (const t of list) if (t.ptyId === id) t.term.write(data); });
window.mc.onPtyExit(({ id, exitCode }) => { for (const list of state.terms.values()) for (const t of list) if (t.ptyId === id) { t.term.write(`\r\n\x1b[90m[process exited with code ${exitCode}] — close this tab or press + Terminal\x1b[0m\r\n`); unhost(t); } });

// ───────────── talking to the orchestrator
// A Session tab can only send input to a Claude session that runs inside one of this app's terminals.
// launchClaude() pins the session id (claude --session-id / --resume) so the link is exact; typing `claude` by hand
// is matched by start time instead (trackTyped + matchHosts).
function trackTyped(rec, d) {
  for (const ch of d) {
    if (ch === '\r' || ch === '\n') {
      const line = rec.typed.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[^\x20-\x7e]/g, '').trim(); rec.typed = '';
      if (/^\/(exit|quit)$/i.test(line) && (rec.sessionId || rec.claudeAt)) { unhost(rec); renderTabs(); continue; } // Claude left; the shell is back
      if (!/(^|\s)claude(\s|$)/.test(line)) continue;
      const m = /--session-id\s+([0-9a-f-]{36})|(?:--resume|-r)\s+([0-9a-f-]{36})/i.exec(line);
      rec.claudeAt = Date.now(); rec.sessionId = m ? (m[1] || m[2]).toLowerCase() : null;
      if (rec.sessionId) state.hosts.set(rec.sessionId, rec.ptyId);
      renderTabs();
    } else if (ch === '\x7f' || ch === '\b') rec.typed = rec.typed.slice(0, -1);
    else if (rec.typed.length < 2000) rec.typed += ch;
  }
}
function hostOf(sid) { const pid = state.hosts.get(sid); if (!pid) return null; for (const list of state.terms.values()) for (const t of list) if (t.ptyId === pid) return t; state.hosts.delete(sid); return null; }
function matchHosts(p) {
  for (const t of state.terms.get(p.key) || []) {
    if (t.sessionId || !t.claudeAt) continue;
    const cands = p.sessions.filter((s) => s.startedAt >= t.claudeAt - 5000 && !state.hosts.has(s.id)).sort((a, b) => a.startedAt - b.startedAt);
    if (cands[0]) { t.sessionId = cands[0].id; state.hosts.set(t.sessionId, t.ptyId); }
  }
}
async function launchClaude(p, opts = {}) {
  if (!state.env.ptyAvailable) { alert('Terminals are unavailable: ' + (state.env.ptyError || 'node-pty failed to load')); return null; }
  const list = state.terms.get(p.key) || [];
  let t = list.find((x) => x.ptyId === state.activeTab.get(p.key)) || list[0];
  if (!t || t.sessionId || t.claudeAt) t = await newTerminal(p); // never type into a terminal that already runs Claude
  if (!t) return null;
  const sid = (opts.resume || crypto.randomUUID()).toLowerCase();
  t.sessionId = sid; t.claudeAt = Date.now(); t.lead = !!opts.lead; state.hosts.set(sid, t.ptyId);
  if (!opts.stay) activateTab(t.ptyId);
  const q = (s) => '"' + String(s).replace(/["`$]/g, '') + '"'; // PowerShell double-quoted argument; strip what it would interpret
  let cmd = opts.resume ? `claude --resume ${sid}` : `claude --session-id ${sid}`;
  if (opts.systemPromptFile) cmd += ` --append-system-prompt-file ${q(opts.systemPromptFile)}`;
  if (opts.prompt) cmd += ' ' + q(opts.prompt); // positional prompt: the first message, sent as soon as Claude is up
  window.mc.ptyWrite(t.ptyId, cmd + '\r');
  return t;
}

// ───────────── Orchestrator (lead) tab
// One lead session per project. Started with the Mission Control orchestrator rules appended to its system prompt and
// a Recall as its first message, so it reads its memory brain (checkpoint, journal, handover note, repo map), the
// project's rules and plan, maps the repo through a worker if needed, reports where things stand, and waits for orders.
const RECALL_NEW = 'Start of day in Mission Control. Run the Recall from your orchestrator rules: it is Mission Control\'s own procedure, not any /standup or /wrapup skill. Memory brain first: checkpoint, journal, handover note and repo map; then the project\'s own rules and plan; map the repo with a worker if the map is missing or stale. Report where the project stands and what you propose next, then wait for my instructions.';
const RECALL_RESUME = 'Resumed in Mission Control. Run a short Recall from your orchestrator rules: re-read the checkpoint, journal and handover note, tell me briefly where we are and what is unfinished, then wait for my instructions.';
async function launchLead(p, opts = {}) {
  let sys = state.env.kitFile;
  try { sys = (await window.mc.leadPrepare(p.path, window.Persona.forLead(p).name)) || sys; } catch { /* fall back to the plain rules file */ }
  const t = await launchClaude(p, { resume: opts.resume, lead: true, stay: true, systemPromptFile: sys, prompt: opts.resume ? RECALL_RESUME : RECALL_NEW });
  if (!t) return;
  state.lead.set(p.key, t.sessionId); saveLead();
  activateTab('lead');
}
function renderLeadPane(p) {
  let pane = state.leadPanes.get(p.key);
  if (!pane) { pane = el('div', 'pane lead'); $('#orch-body').appendChild(pane); state.leadPanes.set(p.key, pane); }
  const sid = state.lead.get(p.key) || null;
  const host = sid ? hostOf(sid) : null;
  const sess = sid ? p.sessions.find((s) => s.id === sid) : null;
  const mode = host && !sess ? 'starting' : sess && !host ? 'remote' : 'idle';
  const key = mode + ':' + (sid || '') + ':' + (sess ? sess.status : '');
  if (pane.dataset.key === key) return pane;
  pane.dataset.key = key; pane.innerHTML = '';
  const card = el('div', 'lead-card'); pane.appendChild(card);
  const who = window.Persona.forLead(p);
  const h = el('div', 'lead-h'); const av = el('img', 'sess-avatar'); av.src = who.avatar; av.alt = who.name; h.appendChild(av);
  const ht = el('div'); ht.appendChild(el('h2', null, `${who.name} — ${who.title}`)); ht.appendChild(el('div', 'muted', p.name)); h.appendChild(ht); card.appendChild(h);
  if (mode === 'starting') {
    card.appendChild(el('p', 'lead-sub', `Starting the lead session in ${host.title} and briefing it. This tab switches to the conversation as soon as it answers.`));
    const b = el('button', 'btn', `Watch ${host.title}`); b.onclick = () => activateTab(host.ptyId); card.appendChild(b);
    return pane;
  }
  card.appendChild(el('p', 'lead-sub', 'The lead session for this project. It starts with a Recall: the memory brain first — checkpoint, journal, handover note and repo map — then the project’s own rules, plan and board, with a fresh repo map from a worker when the map is missing or stale. Then it reports where things stand and takes your instructions, planning first and leading the workers.'));
  if (mode === 'remote') {
    card.appendChild(el('p', 'lead-warn', `Your lead session (${sess.title.slice(0, 60)}) is running outside Mission Control${sess.status === 'working' || sess.status === 'live' ? ' and is active right now. Close it there first, then' : '.'} take it over here to continue with the full conversation.`));
  }
  const row = el('div', 'lead-actions');
  const bNew = el('button', 'btn primary', 'Start a new day'); bNew.title = 'New session with the orchestrator rules; runs the Recall first'; bNew.onclick = () => launchLead(p); row.appendChild(bNew);
  const recent = p.sessions.slice(0, 8);
  if (recent.length) {
    const sel = el('select', 'lead-select');
    for (const s of recent) { const o = el('option', null, `${s.id === sid ? '★ ' : ''}${fmtAgo(Date.now() - s.lastActivity)} ago · ${s.title.slice(0, 70)}`); o.value = s.id; if (s.id === sid) o.selected = true; sel.appendChild(o); }
    const bRes = el('button', 'btn', 'Resume selected'); bRes.title = 'Continue that conversation here with its full history'; bRes.onclick = () => launchLead(p, { resume: sel.value });
    row.appendChild(sel); row.appendChild(bRes);
  }
  card.appendChild(row);
  const cp = el('div', 'lead-cp'); cp.appendChild(el('div', 'lead-cp-title', 'Latest checkpoint (auto-written to memory)')); const pre = el('pre', 'lead-cp-body', 'Loading…'); cp.appendChild(pre); card.appendChild(cp);
  window.mc.readMemory({ path: p.path, slug: p.slug }).then((m) => {
    const note = (m.notes || []).find((n) => n.name === 'mission-control-checkpoint');
    pre.textContent = note ? note.body.trim().split('\n').slice(0, 40).join('\n') : 'No checkpoint yet. Mission Control writes one after the first turn of any session in this project.';
  }).catch(() => { pre.textContent = 'Could not read memory.'; });
  const foot = el('div', 'lead-foot');
  foot.appendChild(el('span', null, 'Rules the lead follows: '));
  const a = el('a', null, state.env.kitFile || 'orchestrator-system.md'); a.href = '#'; a.onclick = (e) => { e.preventDefault(); if (state.env.kitFile) window.mc.openPath(state.env.kitFile); };
  foot.appendChild(a); foot.appendChild(el('span', null, ' · project-specific rules win: CLAUDE.md, docs/ORCHESTRATOR.md, .claude/agents'));
  card.appendChild(foot);
  return pane;
}
function sendToSession(sid, text) {
  const t = hostOf(sid); if (!t) return false;
  const body = text.replace(/\r\n?/g, '\n');
  window.mc.ptyWrite(t.ptyId, body.includes('\n') ? '\x1b[200~' + body + '\x1b[201~' : body); // bracketed paste keeps newlines from submitting early
  setTimeout(() => window.mc.ptyWrite(t.ptyId, '\r'), 120);
  return true;
}
function refreshSessionFooters(p) {
  for (const s of p.sessions) {
    const pane = state.panes.get('session:' + s.id); if (!pane || !pane.foot) continue;
    const host = hostOf(s.id);
    renderSessionHead(pane, p, s, host);
    const mode = host ? 'host' : 'remote';
    if (pane.foot.dataset.mode !== mode) {
      pane.foot.dataset.mode = mode; pane.foot.innerHTML = '';
      if (host) {
        const ta = el('textarea', 'composer'); ta.placeholder = 'Message the orchestrator… (Enter to send, Shift+Enter for a new line)'; ta.rows = 2;
        const send = () => { const v = ta.value.trim(); if (!v) return; if (sendToSession(s.id, v)) { ta.value = ''; ta.rows = 2; } else renderTabs(); };
        ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
        ta.oninput = () => { ta.rows = Math.min(8, Math.max(2, ta.value.split('\n').length)); };
        const btn = el('button', 'btn primary', 'Send'); btn.onclick = send;
        const hint = el('div', 'foot-hint');
        pane.foot.appendChild(ta); pane.foot.appendChild(btn); pane.foot.appendChild(hint);
      } else {
        const msg = el('div', 'foot-msg'); const warn = el('div', 'foot-warn');
        const btn = el('button', 'btn', 'Take over here'); btn.title = 'Open a terminal in this project and run claude --resume for this session';
        btn.onclick = () => launchClaude(p, { resume: s.id });
        pane.foot.appendChild(msg); pane.foot.appendChild(warn); pane.foot.appendChild(btn);
      }
    }
    if (host) pane.foot.querySelector('.foot-hint').textContent = `→ ${host.title}`;
    else {
      pane.foot.querySelector('.foot-msg').textContent = 'This session runs outside Mission Control (VS Code or another terminal). Reply there, or resume it in a terminal here:';
      const active = s.status === 'working' || s.status === 'live';
      pane.foot.querySelector('.foot-warn').textContent = active ? 'It is active right now. Close it where it runs first, otherwise two copies will write to the same transcript.' : '';
    }
  }
}

// ───────────── transcript panes (session monitors + worker windows)
function ensurePane(kind, id, parent, cls) {
  const paneId = kind + ':' + id;
  let pane = state.panes.get(paneId);
  if (pane) { if (pane.el.parentElement !== parent) parent.appendChild(pane.el); return pane; }
  const wrap = el('div', cls || 'pane');
  let head = null; if (kind === 'session') { head = el('div', 'sess-head'); wrap.appendChild(head); }
  const body = el('div', 'wk-body');
  wrap.appendChild(body);
  let foot = null;
  if (kind === 'session') { foot = el('div', 'sess-foot'); wrap.appendChild(foot); }
  parent.appendChild(wrap);
  pane = { el: wrap, body, head, foot, lastSeq: 0, kind, id };
  state.panes.set(paneId, pane);
  window.mc.lines(kind, id, 0).then((lines) => appendLines(pane, lines));
  return pane;
}
function appendLines(pane, lines) {
  if (!lines || !lines.length) return;
  const atBottom = pane.body.scrollHeight - pane.body.scrollTop - pane.body.clientHeight < 40;
  for (const l of lines) {
    if (l.seq <= pane.lastSeq) continue; pane.lastSeq = l.seq;
    const row = el('div', 'ln ' + l.type);
    row.appendChild(el('span', 't', clock(l.ts)));
    row.appendChild(el('span', 'k', { tool: 'tool', text: 'claude', you: l.seq === 1 || pane.kind === 'worker' ? 'task' : 'you', spawn: 'spawn', error: 'error', note: 'note' }[l.type] || l.type));
    row.appendChild(el('span', 'x', l.text));
    pane.body.appendChild(row);
  }
  while (pane.body.childElementCount > 3000) pane.body.firstElementChild.remove();
  if (atBottom) pane.body.scrollTop = pane.body.scrollHeight;
}
window.mc.onLines(({ kind, id, lines }) => { const pane = state.panes.get(kind + ':' + id); if (pane) appendLines(pane, lines); });

// ───────────── workers grid
/** Copy to the clipboard, with a textarea fallback for when the file:// origin has no clipboard API. */
function copyText(t) {
  const fallback = () => { const ta = el('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove(); };
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).catch(fallback); return; } } catch { /* ignore */ }
  fallback();
}
function renderWorkers() {
  const grid = $('#workers-grid'); const p = currentProject();
  grid.classList.toggle('max', !!state.maximized);
  const wanted = new Set();
  if (p) {
    const workers = p.workers.filter((w) => !state.dismissed.has(w.id) && (state.showFinished || w.status === 'running'));
    for (const w of workers) {
      if (state.maximized && state.maximized !== w.id) continue;
      wanted.add('wk:' + w.id);
      let card = grid.querySelector(`[data-id="${w.id}"]`);
      if (!card) {
        card = el('div', 'wk'); card.dataset.id = w.id;
        const who = window.Persona.forWorker(w);
        const head = el('div', 'wk-head');
        const av = el('img', 'wk-avatar'); av.src = who.avatar; av.alt = who.name; av.title = `${who.name} · ${who.title}`; head.appendChild(av);
        const line1 = el('div', 'wk-who'); line1.appendChild(el('span', 'wk-status')); line1.appendChild(el('span', 'wk-name', who.name)); line1.appendChild(el('span', 'wk-role', who.title));
        // a finished worker can be continued: the Mission Control worker id is the Agent tool id, so the lead can
        // SendMessage to it and the same transcript (and this window) comes back to life. Click copies the id.
        const res = el('span', 'wk-res', '↻ resumable'); res.hidden = true;
        res.title = `The lead can continue this worker with SendMessage to agent ${w.id}; its window reopens here.\nClick to copy the id.`;
        res.onclick = () => { copyText(w.id); const t = res.textContent; res.textContent = '↻ id copied'; setTimeout(() => { res.textContent = t; }, 1500); };
        line1.appendChild(res); head.appendChild(line1);
        head.appendChild(el('span', 'wk-task')); head.appendChild(el('span', 'wk-meta')); head.appendChild(el('span', 'wk-work'));
        const bMax = el('button', 'btn small', '⤢'); bMax.title = 'Maximize / restore'; bMax.onclick = () => { state.maximized = state.maximized === w.id ? null : w.id; renderWorkers(); };
        const bX = el('button', 'btn small', '×'); bX.title = 'Hide this worker window'; bX.onclick = () => { state.dismissed.add(w.id); if (state.maximized === w.id) state.maximized = null; renderWorkers(); };
        head.appendChild(bMax); head.appendChild(bX);
        card.appendChild(head);
        grid.appendChild(card);
        const pane = ensurePane('worker', w.id, card, 'wk-pane');
        pane.el.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;';
      }
      card.className = 'wk ' + w.status;
      card.querySelector('.wk-status').className = 'wk-status ' + w.status;
      card.querySelector('.wk-res').hidden = w.status === 'running' || w.status === 'stalled';
      card.querySelector('.wk-task').textContent = w.task || '(no description)'; card.querySelector('.wk-task').title = w.task || '';
      const dur = fmtAgo((w.status === 'running' ? Date.now() : w.lastTs) - w.startTs);
      const meta = card.querySelector('.wk-meta');
      const sig = `${w.status}|${dur}|${w.toolCount}|${w.outTokens}|${w.model}|${w.lastTool}`;
      if (meta.dataset.sig !== sig) { meta.dataset.sig = sig; meta.textContent = `${w.status.toUpperCase()} · ${dur} · ${modelShort(w.model)} · ${w.toolCount} tools · ${fmtTok(w.outTokens)} out${w.status === 'running' && w.lastTool ? ' · now: ' + w.lastTool.slice(0, 40) : ''}`; }
      renderWorkLine(card.querySelector('.wk-work'), p, { branch: w.gitBranch, cwd: w.cwd });
    }
  }
  for (const card of [...grid.children]) if (!wanted.has('wk:' + card.dataset.id)) card.remove();
  $('#workers-count').textContent = p ? `${p.running} running · ${p.workers.length} total` : '';
}

// ───────────── header actions
$('#btn-add').onclick = () => window.mc.addProject();
$('#btn-term').onclick = () => { const p = currentProject(); if (p) newTerminal(p); };
$('#btn-claude').onclick = () => { const p = currentProject(); if (p) launchClaude(p); };
$('#btn-code').onclick = () => { const p = currentProject(); if (p && p.path) window.mc.openInCode(p.path); };
$('#btn-folder').onclick = () => { const p = currentProject(); if (p && p.path) window.mc.openFolder(p.path); };
$('#chk-finished').onchange = (e) => { state.showFinished = e.target.checked; renderWorkers(); };

// session pane header: who this is (lead or plain session), and what they are on
function renderSessionHead(pane, p, s, host) {
  const isLead = state.lead.get(p.key) === s.id;
  const who = isLead ? window.Persona.forLead(p) : window.Persona.forSession(s);
  const running = (p.workers || []).filter((w) => w.status === 'running').length;
  const sig = `${isLead}|${s.status}|${s.gitBranch}|${running}|${(p.inflight || []).length}|${host ? host.title : ''}|${s.model}`;
  if (pane.head.dataset.sig === sig) return; pane.head.dataset.sig = sig; pane.head.innerHTML = '';
  const av = el('img', 'sess-avatar'); av.src = who.avatar; av.alt = who.name; pane.head.appendChild(av);
  const col = el('div', 'sess-who');
  const l1 = el('div', 'sess-name'); l1.appendChild(el('span', 'st ' + s.status)); l1.appendChild(el('span', 'nm', who.name)); l1.appendChild(el('span', 'ttl', who.title)); l1.appendChild(el('span', 'muted', `· ${modelShort(s.model)} · ${s.status}${host ? ' · ' + host.title : ' · running outside Mission Control'}`)); col.appendChild(l1);
  const l2 = el('div', 'sess-work wk-work'); col.appendChild(l2); pane.head.appendChild(col);
  renderWorkLine(l2, p, { branch: s.gitBranch, cwd: null });
  if (isLead) {
    l2.appendChild(el('span', 'muted', `· ${running} worker${running === 1 ? '' : 's'} running`));
    for (const x of (p.inflight || []).slice(0, 4)) { const a = el('a', 'pr-link', `PR #${x.number} ${x.stage === 'merged' ? 'deploying' : x.checks === 'passed' ? 'green' : x.checks === 'failed' ? 'red' : 'checks running'}`); a.title = x.title || ''; a.onclick = () => window.mc.openUrl(x.url); l2.appendChild(a); }
  }
}

// ───────────── "working on": branch · PR · ticket · worktree, for workers and sessions
function renderWorkLine(node, p, { branch, cwd }) {
  const pr = branch ? (p.prs || []).find((x) => x.branch === branch) : null;
  const ticket = window.Board && window.Board.ticketFor ? window.Board.ticketFor(p, { branch, pr: pr && pr.url }) : null;
  const wt = cwd && p.path && cwd.replace(/[\\/]+$/, '').toLowerCase() !== p.path.replace(/[\\/]+$/, '').toLowerCase() ? cwd.split(/[\\/]/).pop() : null;
  const sig = `${branch}|${pr ? pr.number + ':' + JSON.stringify(pr.checks) + pr.review : ''}|${ticket ? ticket.id + ticket.status : ''}|${wt}`;
  if (node.dataset.sig === sig) return; node.dataset.sig = sig; node.innerHTML = '';
  if (!branch && !pr && !ticket) { node.appendChild(el('span', 'muted', 'no branch yet')); return; }
  if (branch) { node.appendChild(el('span', 'lbl', 'on')); node.appendChild(el('span', 'branch' + (branch === p.branch ? ' main' : ''), '⎇ ' + branch)); }
  if (wt) node.appendChild(el('span', 'muted', `worktree ${wt}`));
  if (pr) {
    const a = el('a', 'pr-link', `PR #${pr.number}${pr.draft ? ' draft' : ''}`); a.title = pr.title; a.onclick = () => window.mc.openUrl(pr.url); node.appendChild(a);
    const c = pr.checks || {}; const ck = c.fail ? el('span', 'ck fail', `✗ ${c.fail} failing`) : c.pending ? el('span', 'ck pending', `⏳ ${c.pending} running`) : c.pass ? el('span', 'ck pass', `✓ ${c.pass} checks`) : null; if (ck) node.appendChild(ck);
    if (pr.review === 'APPROVED') node.appendChild(el('span', 'ck pass', 'approved')); else if (pr.review === 'CHANGES_REQUESTED') node.appendChild(el('span', 'ck fail', 'changes requested'));
  }
  if (ticket) { const t = el('span', 'ticket', `${ticket.id} · ${ticket.status}`); t.title = ticket.title; t.onclick = () => activateTab('tickets'); node.appendChild(t); }
}

// ───────────── repo, account, pull requests
function modelShort(m) { m = String(m || ''); return /fable/i.test(m) ? 'fable' : /opus/i.test(m) ? 'opus' : /sonnet/i.test(m) ? 'sonnet' : /haiku/i.test(m) ? 'haiku' : m ? m.replace(/^claude-/, '').slice(0, 14) : '?'; }
function renderHeader(p) {
  const r = $('#ph-repo'); r.innerHTML = ''; if (!p || !p.path) return;
  if (p.repo) { const a = el('a', null, '⎇ ' + p.repo.full); a.title = p.repo.url; a.onclick = () => window.mc.openUrl(p.repo.url); r.appendChild(a); }
  else r.appendChild(el('span', null, p.remote ? 'remote: ' + p.remote : 'no GitHub remote'));
  if (p.branch) r.appendChild(el('span', null, 'on ' + p.branch));
  const s = p.settings || {};
  r.appendChild(el('span', 'acct', s.ghAccount ? `commits as ${s.ghAccount}${s.gitName ? ' · ' + s.gitName : ''}` : s.account ? `GitHub as ${s.account} (from the remote URL)` : 'GitHub as machine default'));
  // team status: busy while workers run or the team's PRs are not yet live
  const inflight = p.inflight || []; const opening = inflight.filter((x) => x.stage === 'open'), deploying = inflight.filter((x) => x.stage === 'merged');
  const busy = p.running > 0 || inflight.length > 0;
  const parts = [];
  if (p.running) parts.push(`${p.running} worker${p.running === 1 ? '' : 's'} running`);
  if (opening.length) parts.push(`${opening.length} PR${opening.length === 1 ? '' : 's'} awaiting merge`);
  if (deploying.length) parts.push(`${deploying.length} deploying`);
  const team = el('span', 'team ' + (busy ? 'busy' : 'free'), busy ? 'Team busy: ' + parts.join(' · ') : 'Team free');
  team.title = busy ? 'Wait for the current work to be merged and live before giving a new task, or ask the orchestrator to queue it.' : 'No workers running and no PRs in flight.';
  r.appendChild(team);
}
function renderPrStrip(p) {
  const strip = $('#pr-strip'); strip.innerHTML = '';
  const show = p && p.repo && ((p.prs && p.prs.length) || p.prsError);
  strip.hidden = !show; if (!show) return;
  if (p.prsError) strip.appendChild(el('span', 'pr-chip err', 'PRs: ' + p.prsError));
  for (const pr of p.prs || []) {
    const chip = el('span', 'pr-chip' + (pr.draft ? ' draft' : '')); chip.title = `${pr.title}\n${pr.url}\nby ${pr.author || '?'} · ${pr.review || 'no review yet'}`;
    chip.appendChild(el('span', 'n', `#${pr.number}`)); chip.appendChild(el('span', null, pr.title.slice(0, 48) + (pr.draft ? ' (draft)' : '')));
    chip.appendChild(el('span', 'b', pr.branch));
    const c = pr.checks || { pass: 0, fail: 0, pending: 0 };
    if (c.fail) chip.appendChild(el('span', 'ck fail', `✗ ${c.fail}`)); if (c.pending) chip.appendChild(el('span', 'ck pending', `⏳ ${c.pending}`)); if (c.pass) chip.appendChild(el('span', 'ck pass', `✓ ${c.pass}`));
    if (pr.review === 'APPROVED') chip.appendChild(el('span', 'ck pass', 'approved')); else if (pr.review === 'CHANGES_REQUESTED') chip.appendChild(el('span', 'ck fail', 'changes requested'));
    const who = (p.workers || []).filter((w) => w.gitBranch === pr.branch).map((w) => w.role + (w.status === 'running' ? ' ●' : ''));
    if (who.length) chip.appendChild(el('span', 'who', who.join(', ')));
    chip.onclick = () => window.mc.openUrl(pr.url); strip.appendChild(chip);
  }
}
// settings dialog
(() => {
  const dlg = $('#dlg-repo'); if (!dlg) return;
  $('#btn-repo').onclick = async () => {
    const p = currentProject(); if (!p || !p.path) return;
    $('#dlg-repo-project').textContent = `${p.name} — ${p.path}`;
    const s = p.settings || {};
    $('#f-repo').value = s.repo || (p.repo ? p.repo.url : '') || ''; $('#f-name').value = s.gitName || ''; $('#f-email').value = s.gitEmail || '';
    const sel = $('#f-account'); sel.innerHTML = '<option value="">Machine default (active gh account)</option>';
    try { for (const a of await window.mc.ghAccounts()) { const o = el('option', null, a.login + (a.active ? ' (active on this machine)' : '')); o.value = a.login; sel.appendChild(o); } } catch { /* gh missing */ }
    sel.value = s.ghAccount || '';
    dlg.dataset.path = p.path; dlg.showModal();
  };
  $('#f-account').onchange = () => { $('#f-name').value = ''; $('#f-email').value = ''; }; // let the account fill them in
  $('#f-cancel').onclick = () => dlg.close();
  $('#frm-repo').onsubmit = async (e) => {
    e.preventDefault();
    const patch = { repo: $('#f-repo').value.trim(), ghAccount: $('#f-account').value, gitName: $('#f-name').value.trim(), gitEmail: $('#f-email').value.trim() };
    if (!patch.ghAccount) { patch.gitName = patch.gitName || ''; patch.gitEmail = patch.gitEmail || ''; }
    await window.mc.settingsSet(dlg.dataset.path, patch); dlg.close();
  };
})();

// team & models dialog
(() => {
  const dlg = $('#dlg-team'); if (!dlg) return;
  let cur = null; // { p, roster, models, efforts }
  const status = (m) => { const s = $('#team-status'); s.textContent = m; setTimeout(() => { if (s.textContent === m) s.textContent = ''; }, 4000); };
  function row(r) {
    const tr = el('div', 'team-row' + (r.source === 'builtin' ? ' builtin' : ''));
    const who = el('div', 'team-who'); who.appendChild(el('div', 'team-name', r.name)); who.appendChild(el('div', 'team-title', window.Persona.title(r.name) + (r.source === 'builtin' ? ' · built-in' : ' · .claude/agents')));
    const d = el('div', 'team-desc', r.description); d.title = r.description; who.appendChild(d); tr.appendChild(who);
    const sel = (opts, val, label) => { const s = el('select', 'team-sel'); const o0 = el('option', null, label); o0.value = ''; s.appendChild(o0); for (const o of opts) { const e = el('option', null, o); e.value = o; if (o === val) e.selected = true; s.appendChild(e); } return s; };
    const ms = sel(cur.models, r.model, 'lead decides'); const es = sel(cur.efforts, r.effort, 'default');
    const save = async () => { cur.roster = await window.mc.teamSet(cur.p.path, r.name, ms.value, es.value); status(`saved ${r.name}: ${ms.value || 'lead decides'} / ${es.value || 'default'}`); render(); };
    ms.onchange = save; es.onchange = save;
    const ctl = el('div', 'team-ctl'); ctl.appendChild(el('label', null, 'Model')); ctl.appendChild(ms); ctl.appendChild(el('label', null, 'Effort')); ctl.appendChild(es); tr.appendChild(ctl);
    const rec = el('div', 'team-rec');
    const match = r.model === r.recommended.model && (r.effort || r.recommended.effort) === r.recommended.effort;
    const head = el('div', 'team-rec-head'); head.appendChild(el('span', 'team-rec-model ' + r.recommended.model, `${r.recommended.model} / ${r.recommended.effort}`)); head.appendChild(el('span', 'muted', match ? '✓ in use' : 'recommended'));
    if (!match) { const b = el('button', 'btn small', 'Use'); b.onclick = async () => { cur.roster = await window.mc.teamSet(cur.p.path, r.name, r.recommended.model, r.recommended.effort); status(`${r.name} → ${r.recommended.model} / ${r.recommended.effort}`); render(); }; head.appendChild(b); }
    rec.appendChild(head); rec.appendChild(el('div', 'team-reason', r.recommended.reason)); tr.appendChild(rec);
    return tr;
  }
  function render() { const list = $('#team-list'); list.innerHTML = ''; if (!cur.roster.length) list.appendChild(el('div', 'muted', 'No roles found.')); for (const r of cur.roster) list.appendChild(row(r)); }
  $('#btn-team').onclick = async () => {
    const p = currentProject(); if (!p || !p.path) return;
    const t = await window.mc.teamGet(p.path); cur = { p, roster: t.roster, models: t.models, efforts: t.efforts };
    $('#dlg-team-project').textContent = `${p.name} — ${p.path}`; render(); dlg.showModal();
  };
  $('#team-recommend-all').onclick = async () => { for (const r of cur.roster) if (!(r.model === r.recommended.model && (r.effort || r.recommended.effort) === r.recommended.effort)) cur.roster = await window.mc.teamSet(cur.p.path, r.name, r.recommended.model, r.recommended.effort); status('all roles set to the recommendation'); render(); };
  $('#team-close').onclick = () => dlg.close();
})();

// ───────────── inbox: notes, questions and decisions from the orchestrators
function renderInbox(snap) {
  const box = $('#inbox'); const all = [];
  for (const p of snap.projects || []) for (const n of p.notes || []) all.push({ ...n, projectName: p.name, projectKey: p.key });
  all.sort((a, b) => b.ts.localeCompare(a.ts));
  $('#inbox-count').textContent = all.length ? String(all.length) : '';
  const seen = new Set();
  for (const n of all) {
    seen.add(n.id);
    let card = box.querySelector(`[data-id="${n.id}"]`);
    if (card) continue; // cards are static once rendered; answers remove them
    card = el('div', 'note ' + n.type); card.dataset.id = n.id;
    const top = el('div', 'note-top'); top.appendChild(el('span', 'note-type', n.type)); top.appendChild(el('span', null, n.projectName)); top.appendChild(el('span', null, '· ' + fmtAgo(Date.now() - new Date(n.ts).getTime()) + ' ago'));
    top.appendChild(el('span', 'note-src', n.source === 'mission-control' ? '· PR watch' : '· orchestrator'));
    card.appendChild(top);
    const title = el('div', 'note-title', n.title);
    if (n.url) { title.classList.add('link'); title.title = n.url; title.onclick = () => window.mc.openUrl(n.url); }
    card.appendChild(title);
    if (n.body) { const b = el('div', 'note-body', n.body); b.title = 'Click to expand'; b.onclick = () => b.classList.toggle('open'); card.appendChild(b); }
    const opts = el('div', 'note-opts');
    const options = n.options && n.options.length ? n.options : n.type === 'decision' ? ['Approve', 'Reject'] : [];
    for (const o of options) { const b = el('button', 'btn small' + (o === options[0] && n.type === 'decision' ? ' primary' : ''), o); b.onclick = () => answerNote(n, o); opts.appendChild(b); }
    if (n.type === 'announcement') { const d = el('button', 'btn small', 'Dismiss'); d.onclick = () => window.mc.notesDismiss(n.id); opts.appendChild(d); }
    else { const d = el('button', 'btn small', 'Dismiss'); d.title = 'Remove without answering'; d.onclick = () => window.mc.notesDismiss(n.id); opts.appendChild(d); }
    card.appendChild(opts);
    if (n.type !== 'announcement') {
      const row = el('div', 'note-reply'); const ta = el('textarea'); ta.rows = 1; ta.placeholder = 'Reply or add a comment… (Enter to send)';
      ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (ta.value.trim()) answerNote(n, ta.value.trim()); } };
      ta.oninput = () => { ta.rows = Math.min(5, Math.max(1, ta.value.split('\n').length)); };
      const send = el('button', 'btn small', 'Send'); send.onclick = () => { if (ta.value.trim()) answerNote(n, ta.value.trim()); };
      row.appendChild(ta); row.appendChild(send); card.appendChild(row);
    }
    box.prepend(card);
  }
  for (const card of [...box.children]) if (!seen.has(card.dataset.id)) card.remove();
}
async function answerNote(n, answer) {
  await window.mc.notesAnswer(n.id, answer);
  // deliver into the orchestrator's conversation when it runs here: the note's own session, else the project's lead, else any hosted session of the project
  const p = (state.snapshot.projects || []).find((x) => x.key === n.projectKey);
  let host = n.session ? hostOf(n.session) : null;
  if (!host && p) { const lead = state.lead.get(p.key); if (lead) host = hostOf(lead); }
  if (!host && p) for (const t of state.terms.get(p.key) || []) if (t.sessionId && hostOf(t.sessionId)) { host = t; break; }
  const label = n.type === 'decision' ? 'Decision' : n.type === 'question' ? 'Answer' : 'Reply';
  const msg = `${label} on "${n.title}": ${answer}`;
  const st = $('#inbox-status');
  if (host) { sendToSession(host.sessionId, msg); st.textContent = `sent to ${host.title}`; }
  else st.textContent = 'saved · orchestrator reads it with mc-note answers';
  setTimeout(() => { st.textContent = ''; }, 6000);
}

// splitter drag
(() => {
  const sp = $('#splitter'); let dragging = false;
  sp.onmousedown = () => { dragging = true; document.body.style.cursor = 'row-resize'; };
  window.onmouseup = () => { dragging = false; document.body.style.cursor = ''; };
  window.onmousemove = (e) => { if (!dragging) return; const body = $('#body'); const r = body.getBoundingClientRect(); const head = $('#proj-head').getBoundingClientRect().height; const h = Math.max(120, Math.min(r.height - head - 160, e.clientY - r.top - head)); body.style.setProperty('--orch-h', h + 'px'); };
})();

// ───────────── data feed
window.mc.onEnv((env) => { state.env = env;
  if (env.startView) setTimeout(() => {
    // --view idle expands the sidebar's Idle group, which is collapsed by default (not persisted: a flag, not a preference)
    if (env.startView === 'idle') { state.idleOpen = true; renderSidebar(); return; }
    const p = currentProject(); if (!p) return;
    // --view explorer opens the Explorer panel; --view explorer-branches opens it on the Branches tab
    if (String(env.startView).startsWith('explorer')) { if (window.Explorer) window.Explorer.openFromStartView(env.startView); return; }
    if (env.startView === 'session') { if (p.sessions[0]) activateTab('sess:' + p.sessions[0].id); }
    else if (env.startView !== 'memory') activateTab(env.startView);
  }, 1500); if (!env.ptyAvailable) $('#orch-empty').innerHTML = `Terminals are unavailable (node-pty failed to load: <code>${env.ptyError || ''}</code>). Session monitors and worker windows still work.`; });
window.mc.onSnapshot((snap) => {
  state.snapshot = snap; renderSidebar(); renderInbox(snap);
  const p = currentProject();
  if (window.Explorer) window.Explorer.render(p, snap);
  if (p) {
    $('#ph-name').textContent = p.name; $('#ph-path').textContent = p.path || ''; renderHeader(p); renderPrStrip(p); renderTabs(); renderWorkers();
    if (!state.activeTab.get(p.key)) activateTab(firstTabId(p.key));
    else if (state.activeTab.get(p.key) === 'lead') activateTab('lead'); // swaps launcher → conversation once the lead session's transcript appears
    if (p.path && !state.terms.has(p.key) && state.env.ptyAvailable) newTerminal(p, { activate: false });
  }
});
setInterval(() => { renderWorkers(); }, 1000);
window.mc.snapshot().then((snap) => { state.snapshot = snap; renderSidebar(); if (state.selected) selectProject(state.selected); });

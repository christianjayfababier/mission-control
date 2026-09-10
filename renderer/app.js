/* global Terminal, FitAddon, WebLinksAddon */
'use strict';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmtAgo = (ms) => { if (ms == null || !isFinite(ms)) return ''; const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's'; const h = Math.floor(m / 60); return h < 48 ? h + 'h' + String(m % 60).padStart(2, '0') + 'm' : Math.floor(h / 24) + 'd'; };
const fmtTok = (n) => !n ? '0' : n < 1000 ? String(n) : n < 1e6 ? (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k' : (n / 1e6).toFixed(2) + 'M';
const clock = (ts) => new Date(ts).toTimeString().slice(0, 8);

const state = {
  env: { ptyAvailable: false }, snapshot: { projects: [] }, selected: null, showIdle: false, showFinished: true,
  terms: new Map(),      // projectKey -> [{ptyId, term, fit, el, tab}]
  activeTab: new Map(),  // projectKey -> tab id ('pty1' | 'sess:<id>')
  panes: new Map(),      // paneId -> {el, body, lastSeq, kind, id}
  dismissed: new Set(),  // worker ids hidden by user
  hosts: new Map(),      // sessionId -> ptyId of the terminal running that Claude session (lets the Session tab talk to it)
  maximized: null,
};
const termTheme = { background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff', selectionBackground: '#264f78', black: '#0d1117', brightBlack: '#6e7681', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4', brightWhite: '#f0f6fc' };

// ───────────── sidebar
function visibleProjects() {
  const list = state.snapshot.projects || [];
  return state.showIdle ? list : list.filter((p) => p.pinned || p.live || p.running || p.waiting || Date.now() - p.lastActivity < 6 * 3600 * 1000);
}
function renderSidebar() {
  const ul = $('#projects'); ul.innerHTML = '';
  const list = visibleProjects();
  if (state.selected && !list.some((p) => p.key === state.selected)) state.selected = list[0] ? list[0].key : null;
  if (!state.selected && list[0]) state.selected = list[0].key;
  for (const p of list) {
    const li = el('li', 'proj' + (p.key === state.selected ? ' sel' : ''));
    li.appendChild(el('span', 'dot' + (p.live ? ' live' : p.waiting ? ' waiting' : '')));
    const mid = el('div'); mid.appendChild(el('div', 'proj-name', p.name)); mid.appendChild(el('div', 'proj-path', p.path || ('~/.claude/projects/' + p.slug)));
    li.appendChild(mid);
    const b = el('div', 'proj-badges');
    if (p.live) b.appendChild(el('span', 'badge live', p.live + ' live'));
    if (p.running) b.appendChild(el('span', 'badge run', p.running + ' running'));
    if (!p.live && !p.running) b.appendChild(el('span', 'badge', p.sessions.length ? fmtAgo(Date.now() - p.lastActivity) : 'pinned'));
    li.appendChild(b);
    li.title = p.path || ''; li.onclick = () => selectProject(p.key);
    li.oncontextmenu = (e) => { e.preventDefault(); if (p.pinned && confirm(`Remove "${p.name}" from the sidebar? (Sessions are not affected.)`)) window.mc.removeProject(p.path); };
    ul.appendChild(li);
  }
  const all = state.snapshot.projects || [];
  const live = all.reduce((a, p) => a + p.live, 0), run = all.reduce((a, p) => a + p.running, 0), wait = all.reduce((a, p) => a + p.waiting, 0);
  $('#totals').innerHTML = `<b>${live}</b> live · <b>${run}</b> workers running · <b>${wait}</b> waiting for you`;
}

// ───────────── project selection / header
function currentProject() { return (state.snapshot.projects || []).find((p) => p.key === state.selected) || null; }
window.MC = { currentProject: () => currentProject(), state };
function selectProject(key) {
  state.selected = key; state.maximized = null;
  const p = currentProject();
  document.dispatchEvent(new CustomEvent('mc:project-selected', { detail: { key } }));
  renderSidebar();
  $('#ph-name').textContent = p ? p.name : 'Select a project';
  $('#ph-path').textContent = p ? (p.path || '') : '';
  // show this project's panes, hide the others
  for (const [k, list] of state.terms) for (const t of list) t.el.classList.toggle('active', false);
  renderTabs();
  if (p && p.path && !state.terms.has(key) && state.env.ptyAvailable) newTerminal(p);
  activateTab(state.activeTab.get(key) || firstTabId(key));
  renderWorkers();
}
function firstTabId(key) { const t = state.terms.get(key); if (t && t[0]) return t[0].ptyId; const p = currentProject(); return p && p.sessions[0] ? 'sess:' + p.sessions[0].id : null; }

// ───────────── tabs: terminals + session monitors
function renderTabs() {
  const tabs = $('#orch-tabs'); tabs.innerHTML = '';
  const p = currentProject(); if (!p) return;
  const active = state.activeTab.get(p.key);
  for (const t of state.terms.get(p.key) || []) {
    const tab = el('div', 'tab' + (active === t.ptyId ? ' active' : ''));
    tab.appendChild(el('span', null, t.title + (t.sessionId || t.claudeAt ? ' ▸ claude' : '')));
    const x = el('span', 'x', '×'); x.title = 'Close terminal'; x.onclick = (e) => { e.stopPropagation(); closeTerminal(p.key, t.ptyId); };
    tab.appendChild(x); tab.onclick = () => activateTab(t.ptyId); tabs.appendChild(tab);
  }
  p.sessions.slice(0, 6).forEach((s, i) => {
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
  if (id.startsWith('sess:')) {
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
async function newTerminal(p) {
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
  activateTab(ptyId);
  return rec;
}
function closeTerminal(key, ptyId) {
  const list = state.terms.get(key) || []; const i = list.findIndex((t) => t.ptyId === ptyId); if (i < 0) return;
  const t = list[i]; window.mc.ptyKill(ptyId); t.term.dispose(); t.el.remove(); list.splice(i, 1); unhost(t);
  if (state.activeTab.get(key) === ptyId) state.activeTab.set(key, firstTabId(key));
  activateTab(state.activeTab.get(key));
}
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
function unhost(rec) { rec.sessionId = null; rec.claudeAt = 0; for (const [sid, pid] of state.hosts) if (pid === rec.ptyId) state.hosts.delete(sid); }
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
  t.sessionId = sid; t.claudeAt = Date.now(); state.hosts.set(sid, t.ptyId);
  activateTab(t.ptyId);
  window.mc.ptyWrite(t.ptyId, (opts.resume ? `claude --resume ${sid}` : `claude --session-id ${sid}`) + '\r');
  return t;
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
  const body = el('div', 'wk-body');
  wrap.appendChild(body);
  let foot = null;
  if (kind === 'session') { foot = el('div', 'sess-foot'); wrap.appendChild(foot); }
  parent.appendChild(wrap);
  pane = { el: wrap, body, foot, lastSeq: 0, kind, id };
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
        const head = el('div', 'wk-head');
        head.appendChild(el('span', 'wk-status')); head.appendChild(el('span', 'wk-role')); head.appendChild(el('span', 'wk-task')); head.appendChild(el('span', 'wk-meta'));
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
      card.querySelector('.wk-role').textContent = w.role;
      card.querySelector('.wk-task').textContent = w.task || '(no description)'; card.querySelector('.wk-task').title = w.task || '';
      const dur = fmtAgo((w.status === 'running' ? Date.now() : w.lastTs) - w.startTs);
      card.querySelector('.wk-meta').textContent = `${w.status.toUpperCase()} · ${dur} · ${w.toolCount} tools · ${fmtTok(w.outTokens)} out${w.status === 'running' && w.lastTool ? ' · now: ' + w.lastTool.slice(0, 40) : ''}`;
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
$('#chk-all').onchange = (e) => { state.showIdle = e.target.checked; renderSidebar(); };
$('#chk-finished').onchange = (e) => { state.showFinished = e.target.checked; renderWorkers(); };

// splitter drag
(() => {
  const sp = $('#splitter'); let dragging = false;
  sp.onmousedown = () => { dragging = true; document.body.style.cursor = 'row-resize'; };
  window.onmouseup = () => { dragging = false; document.body.style.cursor = ''; };
  window.onmousemove = (e) => { if (!dragging) return; const body = $('#body'); const r = body.getBoundingClientRect(); const head = $('#proj-head').getBoundingClientRect().height; const h = Math.max(120, Math.min(r.height - head - 160, e.clientY - r.top - head)); body.style.setProperty('--orch-h', h + 'px'); };
})();

// ───────────── data feed
window.mc.onEnv((env) => { state.env = env;
  if (env.startView === 'session') setTimeout(() => { const p = currentProject(); if (p && p.sessions[0]) activateTab('sess:' + p.sessions[0].id); }, 1500); if (!env.ptyAvailable) $('#orch-empty').innerHTML = `Terminals are unavailable (node-pty failed to load: <code>${env.ptyError || ''}</code>). Session monitors and worker windows still work.`; });
window.mc.onSnapshot((snap) => {
  state.snapshot = snap; renderSidebar();
  const p = currentProject();
  if (p) { $('#ph-name').textContent = p.name; $('#ph-path').textContent = p.path || ''; renderTabs(); renderWorkers(); if (!state.activeTab.get(p.key)) activateTab(firstTabId(p.key)); if (p.path && !state.terms.has(p.key) && state.env.ptyAvailable) newTerminal(p); }
});
setInterval(() => { renderWorkers(); }, 1000);
window.mc.snapshot().then((snap) => { state.snapshot = snap; renderSidebar(); if (state.selected) selectProject(state.selected); });

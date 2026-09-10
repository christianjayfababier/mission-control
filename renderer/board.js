/* Tickets and Todos tabs — one board per project, shared with the orchestrator through mc-board.js */
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const panes = new Map();   // `${kind}:${projectKey}` -> { el, p, board, filter, selected:Set }
  const boards = new Map();  // projectKey -> board
  const keyOf = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  const STATUSES = ['new', 'analyzed', 'planned', 'in-progress', 'in-review', 'blocked', 'done'];
  const ago = (iso) => { if (!iso) return ''; const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 3600 ? Math.round(s / 60) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd'; };
  const tri = (v) => v === true ? '✓ yes' : v === false ? '– no' : '?';

  /** Paste parser: numbered / bulleted lines become items; otherwise blank-line separated blocks (first line = title). */
  function parsePaste(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    const bullets = lines.filter((l) => l.trim()).every((l) => /^\s*([-*•]|\d+[.)]|#\d+|T-\d+|\[.\])\s+/.test(l));
    if (bullets) return lines.filter((l) => l.trim()).map((l) => ({ title: l.replace(/^\s*([-*•]|\d+[.)]|#\d+|T-\d+|\[.\])\s+/, '').trim(), body: '' }));
    return text.split(/\n\s*\n/).map((blk) => blk.trim()).filter(Boolean).map((blk) => { const [first, ...rest] = blk.split('\n'); return { title: first.trim().slice(0, 200), body: rest.join('\n').trim() }; });
  }
  function guessType(title) { return /\b(bug|error|crash|broken|fails?|fix|wrong|not working|issue)\b/i.test(title) ? 'bug' : /\b(feature|add|new|support|allow|enable|request|implement)\b/i.test(title) ? 'feature' : 'task'; }

  async function ensureBoard(p) { if (!boards.has(p.key)) { try { boards.set(p.key, await window.mc.boardGet(p.path)); } catch { boards.set(p.key, { tickets: [], todos: [] }); } } return boards.get(p.key); }

  function pane(kind, p) {
    const id = kind + ':' + p.key;
    let st = panes.get(id);
    if (!st) {
      const wrap = el('div', 'pane board'); $('#orch-body').appendChild(wrap);
      st = { el: wrap, p, kind, filter: 'open', selected: new Set(), pasteOpen: false };
      panes.set(id, st);
      ensureBoard(p).then(() => render(st));
    }
    st.p = p; render(st);
    return st.el;
  }

  function toolbar(st) {
    const bar = el('div', 'bd-bar'); const p = st.p; const kind = st.kind;
    const b = boards.get(p.key) || { tickets: [], todos: [] };
    const list = kind === 'tickets' ? b.tickets : b.todos;
    const open = kind === 'tickets' ? list.filter((t) => t.status !== 'done') : list.filter((t) => !t.done);
    bar.appendChild(el('span', 'bd-count', `${open.length} open · ${list.length - open.length} done`));
    const seg = el('div', 'seg');
    for (const f of ['open', 'all', 'done']) { const bt = el('button', 'seg-btn' + (st.filter === f ? ' active' : ''), f); bt.onclick = () => { st.filter = f; render(st); }; seg.appendChild(bt); }
    bar.appendChild(seg);
    const paste = el('button', 'btn small' + (st.pasteOpen ? ' primary' : ''), st.pasteOpen ? 'Close paste' : 'Paste ' + kind); paste.onclick = () => { st.pasteOpen = !st.pasteOpen; render(st); }; bar.appendChild(paste);
    if (kind === 'tickets') {
      const send = el('button', 'btn small', st.selected.size ? `Send ${st.selected.size} selected to orchestrator` : 'Send open tickets to orchestrator');
      send.title = 'Asks the lead to analyze them (risk, doability, effort, migration / DB / heavy work) and record the results here';
      send.onclick = () => sendTickets(st, st.selected.size ? open.filter((t) => st.selected.has(t.id)) : open);
      bar.appendChild(send);
    } else {
      const send = el('button', 'btn small', 'Send open todos to orchestrator'); send.onclick = () => sendTodos(st, open); bar.appendChild(send);
    }
    const copy = el('button', 'btn small', 'Copy as text'); copy.title = 'Copy the visible items as text, to paste anywhere'; copy.onclick = () => { navigator.clipboard.writeText(asText(kind, visible(st))).then(() => flash(st, 'copied')); }; bar.appendChild(copy);
    const help = el('span', 'bd-help', kind === 'tickets' ? 'Orchestrator & workers write here with: node ~/.claude/mission-control/mc-board.js ticket …' : 'node ~/.claude/mission-control/mc-board.js todo add "…"');
    bar.appendChild(help);
    const fl = el('span', 'bd-flash'); fl.id = 'flash-' + st.kind + '-' + st.p.key.replace(/[^a-z0-9]/gi, ''); bar.appendChild(fl);
    return bar;
  }
  function flash(st, msg) { const f = st.el.querySelector('.bd-flash'); if (f) { f.textContent = msg; setTimeout(() => { if (f.textContent === msg) f.textContent = ''; }, 5000); } }
  function visible(st) {
    const b = boards.get(st.p.key) || { tickets: [], todos: [] };
    if (st.kind === 'tickets') return b.tickets.filter((t) => st.filter === 'all' || (st.filter === 'done' ? t.status === 'done' : t.status !== 'done'));
    return b.todos.filter((t) => st.filter === 'all' || (st.filter === 'done' ? t.done : !t.done));
  }
  function asText(kind, items) {
    if (kind === 'tickets') return items.map((t) => `${t.id} [${t.type}/${t.priority}] ${t.title}${t.body ? '\n    ' + t.body.replace(/\n/g, '\n    ') : ''}${t.risk ? `\n    risk ${t.risk} · doable ${t.doable || '?'} · effort ${t.effort || '?'} · migration ${tri(t.migration)} · db ${tri(t.db)} · heavy ${tri(t.heavy)}` : ''}`).join('\n');
    return items.map((t) => `- [${t.done ? 'x' : ' '}] ${t.id} ${t.text}`).join('\n');
  }

  function pasteBox(st) {
    const box = el('div', 'bd-paste');
    const ta = el('textarea'); ta.placeholder = st.kind === 'tickets'
      ? 'Paste tickets: one per line (bullets or numbers), or blocks separated by a blank line (first line = title, rest = details).'
      : 'Paste todos or follow-ups, one per line.';
    ta.rows = 6; box.appendChild(ta);
    const row = el('div', 'bd-paste-actions');
    const preview = el('span', 'muted', ''); row.appendChild(preview);
    ta.oninput = () => { const n = parsePaste(ta.value).length; preview.textContent = n ? `${n} item${n === 1 ? '' : 's'} detected` : ''; };
    const add = el('button', 'btn primary small', st.kind === 'tickets' ? 'Add as tickets' : 'Add as todos');
    add.onclick = async () => {
      const items = parsePaste(ta.value); if (!items.length) return;
      if (st.kind === 'tickets') boards.set(st.p.key, await window.mc.boardAddTickets(st.p.path, items.map((it) => ({ ...it, type: guessType(it.title) }))));
      else boards.set(st.p.key, await window.mc.boardAddTodos(st.p.path, items.map((it) => it.title + (it.body ? ' — ' + it.body : ''))));
      st.pasteOpen = false; render(st); flash(st, `added ${items.length}`);
    };
    row.appendChild(add); box.appendChild(row);
    return box;
  }

  function ticketsTable(st) {
    const items = visible(st); const p = st.p;
    if (!items.length) return el('div', 'bd-empty', st.filter === 'open' ? 'No open tickets. Paste some, or let the orchestrator add them with mc-board.js.' : 'Nothing here.');
    const table = el('table', 'bd-table'); const thead = el('thead'); const hr = el('tr');
    for (const h of ['', 'ID', 'Title', 'Type', 'Pri', 'Status', 'Risk', 'Doable', 'Effort', 'Migration', 'DB', 'Heavy', 'PR', '']) hr.appendChild(el('th', null, h));
    thead.appendChild(hr); table.appendChild(thead);
    const tb = el('tbody');
    for (const t of items) {
      const tr = el('tr', 'tk ' + t.status + (t.risk ? ' risk-' + t.risk : ''));
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = st.selected.has(t.id); cb.onchange = () => { if (cb.checked) st.selected.add(t.id); else st.selected.delete(t.id); render(st); };
      const c0 = el('td'); c0.appendChild(cb); tr.appendChild(c0);
      tr.appendChild(el('td', 'mono', t.id));
      const tt = el('td', 'bd-title'); tt.appendChild(el('span', null, t.title)); tt.title = 'Click for details'; tt.onclick = () => { st.open = st.open === t.id ? null : t.id; render(st); }; tr.appendChild(tt);
      tr.appendChild(el('td', 'bd-type ' + t.type, t.type));
      tr.appendChild(el('td', null, t.priority || ''));
      const sel = el('select', 'bd-status'); for (const s of STATUSES) { const o = el('option', null, s); o.value = s; if (s === t.status) o.selected = true; sel.appendChild(o); }
      sel.onchange = async () => { boards.set(p.key, await window.mc.boardPatch(p.path, 'ticket', t.id, { status: sel.value })); render(st); };
      const cs = el('td'); cs.appendChild(sel); tr.appendChild(cs);
      tr.appendChild(el('td', 'risk ' + (t.risk || ''), t.risk || '?'));
      tr.appendChild(el('td', null, t.doable || '?'));
      tr.appendChild(el('td', null, t.effort || '?'));
      tr.appendChild(el('td', 'tri ' + (t.migration === true ? 'yes' : ''), tri(t.migration)));
      tr.appendChild(el('td', 'tri ' + (t.db === true ? 'yes' : ''), tri(t.db)));
      tr.appendChild(el('td', 'tri ' + (t.heavy === true ? 'yes' : ''), tri(t.heavy)));
      const cp = el('td'); if (t.pr) { const a = el('a', 'pr-link', t.pr.replace(/.*\/pull\//, 'PR #')); a.onclick = () => window.mc.openUrl(t.pr); cp.appendChild(a); } tr.appendChild(cp);
      const ca = el('td', 'bd-actions');
      const done = el('button', 'btn small', t.status === 'done' ? 'Reopen' : 'Done'); done.onclick = async () => { boards.set(p.key, await window.mc.boardPatch(p.path, 'ticket', t.id, { status: t.status === 'done' ? 'new' : 'done' })); render(st); }; ca.appendChild(done);
      const del = el('button', 'btn small', '✕'); del.title = 'Delete ticket'; del.onclick = async () => { if (confirm(`Delete ${t.id} "${t.title}"?`)) { boards.set(p.key, await window.mc.boardRemove(p.path, 'ticket', t.id)); render(st); } }; ca.appendChild(del);
      tr.appendChild(ca); tb.appendChild(tr);
      if (st.open === t.id) {
        const dr = el('tr', 'bd-detail'); const td = el('td'); td.colSpan = 14;
        const grid = el('div', 'bd-detail-grid');
        const block = (label, text) => { const d = el('div'); d.appendChild(el('div', 'bd-label', label)); d.appendChild(el('div', 'bd-text', text || '—')); return d; };
        grid.appendChild(block('Details', t.body)); grid.appendChild(block('Analysis (risk, dependencies, data)', t.analysis)); grid.appendChild(block('Plan', t.plan));
        grid.appendChild(block('Areas', (t.areas || []).join(', '))); grid.appendChild(block('Branch', t.branch)); grid.appendChild(block('Timeline', `created ${ago(t.createdAt)} ago · updated ${ago(t.updatedAt)} ago${t.doneAt ? ' · done ' + ago(t.doneAt) + ' ago' : ''} · source ${t.source}`));
        td.appendChild(grid); dr.appendChild(td); tb.appendChild(dr);
      }
    }
    table.appendChild(tb); return table;
  }

  function todosList(st) {
    const items = visible(st); const p = st.p;
    const wrap = el('div', 'bd-todos');
    const addRow = el('div', 'bd-add'); const inp = el('input'); inp.placeholder = 'Add a todo or follow-up… (Enter)';
    const add = async () => { const v = inp.value.trim(); if (!v) return; boards.set(p.key, await window.mc.boardAddTodos(p.path, [v])); inp.value = ''; render(st); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') add(); }; const bt = el('button', 'btn small', 'Add'); bt.onclick = add;
    addRow.appendChild(inp); addRow.appendChild(bt); wrap.appendChild(addRow);
    if (!items.length) { wrap.appendChild(el('div', 'bd-empty', 'Nothing here.')); return wrap; }
    for (const t of items) {
      const row = el('div', 'todo' + (t.done ? ' done' : ''));
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!t.done; cb.onchange = async () => { boards.set(p.key, await window.mc.boardPatch(p.path, 'todo', t.id, { done: cb.checked })); render(st); };
      row.appendChild(cb); row.appendChild(el('span', 'mono muted', t.id)); row.appendChild(el('span', 'todo-text', t.text)); row.appendChild(el('span', 'badge', t.owner)); row.appendChild(el('span', 'muted small', ago(t.createdAt) + ' ago'));
      const del = el('button', 'btn small', '✕'); del.onclick = async () => { boards.set(p.key, await window.mc.boardRemove(p.path, 'todo', t.id)); render(st); }; row.appendChild(del);
      wrap.appendChild(row);
    }
    return wrap;
  }

  function render(st) {
    st.el.innerHTML = '';
    st.el.appendChild(toolbar(st));
    if (st.pasteOpen) st.el.appendChild(pasteBox(st));
    const scroll = el('div', 'bd-scroll'); scroll.appendChild(st.kind === 'tickets' ? ticketsTable(st) : todosList(st)); st.el.appendChild(scroll);
  }

  function sendTickets(st, items) {
    if (!items.length) return flash(st, 'nothing to send');
    const msg = `Tickets to analyze, from the Tickets tab in Mission Control:\n${items.map((t) => `- ${t.id} [${t.type}/${t.priority}] ${t.title}${t.body ? ' — ' + t.body.replace(/\s+/g, ' ').slice(0, 400) : ''}`).join('\n')}\nFollow the Tickets procedure in your rules: inspect the repo for each, then record risk, doability, effort, whether a migration, database update or heavy task is needed, affected areas, analysis and plan with mc-board.js ticket update. Then give me a comparison table and a recommended order. Do not start building yet.`;
    deliver(st, msg);
  }
  function sendTodos(st, items) {
    if (!items.length) return flash(st, 'nothing to send');
    deliver(st, `Open todos from the Todos tab in Mission Control:\n${items.map((t) => `- ${t.id} ${t.text}`).join('\n')}\nTell me which you can take now, which need a decision from me, and mark each done with mc-board.js todo done <id> when finished.`);
  }
  function deliver(st, msg) {
    const sent = window.MC && window.MC.sendToLead ? window.MC.sendToLead(st.p, msg) : null;
    if (sent) flash(st, 'sent to ' + sent);
    else navigator.clipboard.writeText(msg).then(() => flash(st, 'no orchestrator running here — copied to clipboard, paste it into the lead'));
  }

  window.mc.onBoard((board) => {
    const k = keyOf(board.project); boards.set(k, board);
    for (const st of panes.values()) if (st.p.key === k) render(st);
  });
  window.Board = { pane, ticketFor: (p, { branch, pr }) => { const b = boards.get(p.key); if (!b) { ensureBoard(p); return null; } return b.tickets.find((t) => (pr && t.pr && t.pr === pr) || (branch && t.branch && t.branch === branch)) || null; }, counts: (p) => { const b = boards.get(p.key); return b ? { tickets: b.tickets.filter((t) => t.status !== 'done').length, todos: b.todos.filter((t) => !t.done).length } : (p.boardCounts || null); } };
})();

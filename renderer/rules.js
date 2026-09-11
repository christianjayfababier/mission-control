/* Rules tab — what the lead of this project is told to obey, in three sections:
   the repo's own rule files (read-only), Mission Control's rulebook, and the owner's rules for this project.
   Data comes from the main process over the contract in docs/RULES-CONTRACT.md:
   window.mc.rulesGet / rulesAdd / rulesPatch / rulesRemove / rulesReorder / rulesSources / readText / onRules.
   Load order: persona.js → app.js → explorer.js → board.js → rules.js. It reads window.MC (app.js) lazily;
   app.js mounts a pane with window.Rules.pane(project) when the Rules tab is activated. */
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  /** compare-only form of a path: no trailing slash, forward slashes, lower case (Windows is case-insensitive) */
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const base = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const ago = (iso) => { if (!iso) return ''; const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
  const agoMs = (ms) => { if (!ms) return ''; const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
  const size = (n) => n == null ? '' : n < 1024 ? n + ' B' : n < 1024 * 1024 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

  /* The whole tab talks to the backend through this one object, so the surface it needs is visible in one place
     and a missing backend is a single check instead of a guard on every call. window.mc is a frozen
     contextBridge object and cannot be extended; replacing Rules.api is how this file is driven from a fixture. */
  const api = {
    get: (p) => window.mc.rulesGet(p),
    add: (p, text) => window.mc.rulesAdd(p, text),
    patch: (p, id, patch) => window.mc.rulesPatch(p, id, patch),
    remove: (p, id) => window.mc.rulesRemove(p, id),
    reorder: (p, ids) => window.mc.rulesReorder(p, ids),
    sources: (p) => window.mc.rulesSources(p),
    readText: (abs, project) => window.mc.readText(abs, project),
    openFile: (abs) => window.mc.openFile(abs),
  };
  const hasBackend = () => !!(window.mc && typeof window.mc.rulesGet === 'function' && typeof window.mc.rulesSources === 'function');

  const GROUPS = { rules: 'Rule files', agents: '.claude/agents', skills: '.claude/skills', commands: '.claude/commands' };
  const panes = new Map();      // projectKey -> pane state
  const open = { repo: true, kit: true, own: true };   // which sections are expanded (all of them, to start)

  // ───────── light markdown, by hand: headings, bold, inline code, fenced code, lists, links as text.
  // Everything is escaped before a single tag is added, so a rule file can hold any HTML it likes.
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  /** Inline spans of an already-escaped line. Code spans are lifted out first so `**` inside them stays literal. */
  function inline(s) {
    const code = [];
    let t = String(s).replace(/`([^`]+)`/g, (_m, c) => { code.push(c); return '\u0000' + (code.length - 1) + '\u0000'; });
    t = t.replace(/!?\[([^\]]*)\]\(([^)\s]*)(?:\s+&quot;[^&]*&quot;)?\)/g, '$1');   // links and images: the text only
    t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])__([^_]+)__(?=$|[\s).,;:!?])/g, '$1<b>$2</b>');
    return t.replace(/\u0000(\d+)\u0000/g, (_m, n) => '<code>' + code[Number(n)] + '</code>');
  }
  const STRUCTURAL = /^\s*```|^#{1,6}\s|^\s*[-*•]\s|^\s*\d+[.)]\s|^\s*\|/;
  function mdToHtml(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = []; let i = 0, list = null;
    const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
    while (i < lines.length) {
      const raw = lines[i];
      const fence = /^\s*```(.*)$/.exec(raw);
      if (fence) {
        closeList(); const buf = []; i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;                                                    // the closing fence, if there is one
        out.push('<pre class="rl-code"><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(raw);
      if (h) { closeList(); const n = h[1].length; out.push(`<h${n} class="rl-h">` + inline(esc(h[2].replace(/\s+#+\s*$/, ''))) + `</h${n}>`); i++; continue; }
      if (/^\s*(?:[-*_]\s*){3,}$/.test(raw)) { closeList(); out.push('<hr class="rl-hr">'); i++; continue; }
      const ul = /^\s*[-*•]\s+(.*)$/.exec(raw), ol = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
      if (ul || ol) {
        const want = ul ? 'ul' : 'ol';
        if (list !== want) { closeList(); out.push('<' + want + ' class="rl-ul">'); list = want; }
        out.push('<li>' + inline(esc((ul || ol)[1])) + '</li>'); i++; continue;
      }
      // A markdown table is not in the contract's list; keeping the pipe rows preformatted at least keeps the
      // columns aligned instead of collapsing a plan table into one run-on paragraph.
      if (/^\s*\|/.test(raw)) {
        closeList(); const buf = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) buf.push(lines[i++]);
        out.push('<pre class="rl-code rl-table"><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      if (!raw.trim()) { closeList(); i++; continue; }
      closeList();
      const buf = [raw]; i++;
      while (i < lines.length && lines[i].trim() && !STRUCTURAL.test(lines[i])) buf.push(lines[i++]);
      out.push('<p>' + inline(esc(buf.join('\n'))) + '</p>');
    }
    closeList();
    return out.join('\n');
  }

  // ───────── the lead session this project's rules can be typed into
  /** The terminal hosting this project's lead (or any Claude session hosted here), without touching app.js state.
      Same order as MC.sendToLead: the remembered lead session first, then any hosted session of the project. */
  function leadHost(p) {
    const S = window.MC && window.MC.state; if (!S || !p) return null;
    const termOf = (sid) => { const pid = sid && S.hosts.get(sid); if (!pid) return null; for (const list of S.terms.values()) for (const t of list) if (t.ptyId === pid) return t; return null; };
    const lead = termOf(S.lead.get(p.key)); if (lead) return lead;
    for (const t of S.terms.get(p.key) || []) if (t.sessionId && termOf(t.sessionId)) return t;
    return null;
  }

  // ───────── pane
  function pane(p) {
    let st = panes.get(p.key);
    if (!st) {
      const wrap = el('div', 'pane rules'); $('#orch-body').appendChild(wrap);
      st = { el: wrap, p, file: null, sources: null, viewer: null, editing: null, adding: '', flash: '', loading: true };
      panes.set(p.key, st);
      render(st); load(st);
    } else { st.p = p; render(st); refreshSources(st); }
    return st.el;
  }
  async function load(st) {
    if (!hasBackend()) { st.loading = false; render(st); return; }
    try { st.file = await api.get(st.p.path); } catch { st.file = { rules: [] }; }
    try { st.sources = await api.sources(st.p.path); } catch { st.sources = { repo: [], kit: { rules: null, local: null, generated: null } }; }
    st.loading = false; render(st);
  }
  /** The repo's files change under us (a worker writes CLAUDE.md); re-read them whenever the tab is opened. */
  async function refreshSources(st) {
    if (!hasBackend()) return;
    try { st.sources = await api.sources(st.p.path); render(st); } catch { /* keep what we had */ }
  }
  function flash(st, msg) { st.flash = msg; render(st); setTimeout(() => { if (st.flash === msg) { st.flash = ''; render(st); } }, 4000); }

  function section(st, key, title, hint) {
    const sec = el('div', 'rl-sec' + (open[key] ? ' open' : ''));
    const head = el('div', 'rl-sec-head');
    head.appendChild(el('span', 'caret', open[key] ? '▾' : '▸'));
    head.appendChild(el('span', 'rl-sec-title', title));
    if (hint) head.appendChild(el('span', 'rl-sec-hint muted', hint));
    head.onclick = () => { open[key] = !open[key]; render(st); };
    sec.appendChild(head);
    return sec;
  }

  // 1 ─ the repo's own rule files
  function repoSection(st) {
    const rows = (st.sources && st.sources.repo) || [];
    const sec = section(st, 'repo', 'From the repo', `${rows.filter((r) => r.present).length} present · read-only`);
    if (!open.repo) return sec;
    const body = el('div', 'rl-sec-body');
    if (!rows.length) body.appendChild(el('div', 'rl-empty muted', 'No project folder for this project, so there is nothing to read here.'));
    for (const g of Object.keys(GROUPS)) {
      const list = rows.filter((r) => r.group === g);
      if (!list.length) continue;                                  // .claude/* is missing in most repos: no empty headers
      body.appendChild(el('div', 'rl-group', GROUPS[g]));
      for (const r of list) body.appendChild(repoRow(st, r));
    }
    sec.appendChild(body);
    return sec;
  }
  function repoRow(st, r) {
    const row = el('div', 'rl-row' + (r.present ? '' : ' missing') + (st.viewer && norm(st.viewer.path) === norm(r.path) ? ' sel' : ''));
    row.appendChild(el('span', 'rl-rel mono', r.rel));
    row.appendChild(el('span', 'rl-first muted', r.present ? (r.firstLine || '') : 'not present'));
    row.appendChild(el('span', 'rl-size muted', r.present ? size(r.size) : ''));
    row.title = r.present ? r.path + '\nClick to read it here' : r.path + '\nThis file does not exist in the project';
    if (r.present) row.onclick = () => view(st, r.path, r.rel);
    return row;
  }

  // 2 ─ Mission Control's own rulebook
  function kitSection(st) {
    const kit = (st.sources && st.sources.kit) || { rules: null, local: null, generated: null };
    const sec = section(st, 'kit', 'Mission Control rules', 'appended to every lead session');
    if (!open.kit) return sec;
    const body = el('div', 'rl-sec-body');
    if (kit.rules) body.appendChild(kitRow(st, kit.rules, 'The rulebook', 'Shipped with Mission Control and rewritten at every app start — edit kit/orchestrator-system.md in the repo, not this copy.'));
    if (kit.local) body.appendChild(kitRow(st, kit.local, 'Your additions (all projects)', 'Appended after the rulebook for every project. Mission Control never overwrites this file.'));
    else {
      const row = el('div', 'rl-row');
      row.appendChild(el('span', 'rl-rel mono', 'Your additions (all projects)'));
      row.appendChild(el('span', 'rl-first muted', 'none yet'));
      const mk = el('button', 'btn small', 'create'); mk.title = 'Open orchestrator-system.local.md in VS Code';
      mk.onclick = (e) => { e.stopPropagation(); const local = (window.MC && window.MC.state.env && window.MC.state.env.kitLocal) || null; if (local) api.openFile(local); else flash(st, 'the app has not reported its data dir yet'); };
      row.appendChild(mk); body.appendChild(row);
    }
    if (kit.generated) body.appendChild(kitRow(st, kit.generated, 'Latest generated prompt for this project', 'Exactly what the last lead launched here was given: the rulebook, your additions, this project\'s context and the rules below.'));
    else {
      const row = el('div', 'rl-row missing');
      row.appendChild(el('span', 'rl-rel mono', 'Generated prompt for this project'));
      row.appendChild(el('span', 'rl-first muted', 'none yet — it is written the first time a lead is launched here'));
      body.appendChild(row);
    }
    sec.appendChild(body);
    return sec;
  }
  function kitRow(st, abs, label, hint) {
    const row = el('div', 'rl-row' + (st.viewer && norm(st.viewer.path) === norm(abs) ? ' sel' : ''));
    row.appendChild(el('span', 'rl-rel mono', label));
    row.appendChild(el('span', 'rl-first muted', hint || ''));
    row.appendChild(el('span', 'rl-size muted', base(abs)));
    row.title = abs + '\nClick to read it here';
    row.onclick = () => view(st, abs, label);
    return row;
  }

  // 3 ─ the owner's rules for this project
  function ownSection(st) {
    const list = (st.file && st.file.rules) || [];
    const sec = section(st, 'own', 'Your rules for this project', `${list.length} rule${list.length === 1 ? '' : 's'} · binding for the lead`);
    if (!open.own) return sec;
    const body = el('div', 'rl-sec-body');

    const add = el('div', 'rl-add');
    const ta = el('textarea'); ta.rows = 2; ta.value = st.adding || '';
    ta.placeholder = 'A rule for this project — plain language. "Never touch the payments schema without asking me first."';
    const bt = el('button', 'btn primary small', 'Add rule'); bt.disabled = !String(st.adding || '').trim();
    ta.oninput = () => { st.adding = ta.value; bt.disabled = !ta.value.trim(); };            // no re-render: the caret stays put
    ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); bt.onclick(); } };
    bt.onclick = async () => {
      const text = String(ta.value || '').trim(); if (!text) return;                          // rulesAdd ignores blank text anyway
      bt.disabled = true;
      st.file = await api.add(st.p.path, text); st.adding = '';
      flash(st, 'added');
    };
    add.appendChild(ta); add.appendChild(bt); body.appendChild(add);

    if (!list.length) {
      body.appendChild(el('div', 'rl-empty muted',
        'No rules yet. A rule is a standing instruction for this project that the lead must follow — how to branch, what never to touch, who to ask before a migration. '
        + 'Rules are handed to the lead in its system prompt at every launch, above the model assignments, and they win over Mission Control\'s general rules. '
        + 'You can also tell the lead "save this as a rule" in a conversation and it will write one here itself.'));
    }
    list.forEach((r, i) => body.appendChild(ruleRow(st, r, i, list)));
    body.appendChild(el('div', 'rl-note muted', 'New rules reach the lead at its next launch or resume. Use Tell the lead now to give a running lead a rule immediately.'));
    sec.appendChild(body);
    return sec;
  }
  function ruleRow(st, r, i, list) {
    const row = el('div', 'rl-rule');
    const ord = el('div', 'rl-ord');
    const up = el('button', 'btn small', '↑'); up.title = 'Move up'; up.disabled = i === 0;
    const dn = el('button', 'btn small', '↓'); dn.title = 'Move down'; dn.disabled = i === list.length - 1;
    const move = async (to) => { const ids = list.map((x) => x.id); const [id] = ids.splice(i, 1); ids.splice(to, 0, id); st.file = await api.reorder(st.p.path, ids); render(st); };
    up.onclick = () => move(i - 1); dn.onclick = () => move(i + 1);
    ord.appendChild(up); ord.appendChild(dn); row.appendChild(ord);

    const mid = el('div', 'rl-rule-mid');
    if (st.editing === r.id) {
      const ta = el('textarea', 'rl-edit'); ta.value = r.text; ta.rows = Math.min(8, Math.max(2, r.text.split('\n').length + 1));
      const save = async () => { const v = ta.value.trim(); st.editing = null; if (v && v !== r.text) { st.file = await api.patch(st.p.path, r.id, { text: v }); } render(st); };
      ta.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); st.editing = null; render(st); } else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } };
      ta.onblur = save;
      mid.appendChild(ta); setTimeout(() => { ta.focus(); ta.selectionStart = ta.value.length; }, 0);
    } else {
      const txt = el('div', 'rl-rule-text', r.text); txt.title = 'Click to edit';
      txt.onclick = () => { st.editing = r.id; render(st); };
      mid.appendChild(txt);
    }
    const meta = el('div', 'rl-meta muted');
    meta.appendChild(el('span', 'mono', r.id));
    meta.appendChild(el('span', null, '· by ' + (r.by || 'owner')));
    meta.appendChild(el('span', null, '· ' + ago(r.createdAt)));
    if (r.source === 'script') meta.appendChild(el('span', 'badge', 'from the lead'));
    if (r.updatedAt && r.updatedAt !== r.createdAt) meta.appendChild(el('span', null, '· edited ' + ago(r.updatedAt)));
    mid.appendChild(meta); row.appendChild(mid);

    const acts = el('div', 'rl-rule-acts');
    const host = leadHost(st.p);
    const tell = el('button', 'btn small rl-tell', 'Tell the lead now');
    tell.disabled = !host;
    tell.title = host ? `Type this rule into ${host.title} now, so the running lead has it before its next launch` : 'No lead session is running in one of this app\'s terminals for this project. Launch one from the Orchestrator tab, or the rule reaches the lead at its next launch.';
    tell.onclick = () => {
      const sent = window.MC && window.MC.sendToLead ? window.MC.sendToLead(st.p, `Owner rule ${r.id} (also saved to your Owner rules): ${r.text}`) : null;
      flash(st, sent ? `sent to ${sent}` : 'no lead session running here');
    };
    acts.appendChild(tell);
    const del = el('button', 'btn small', '✕'); del.title = 'Remove this rule';
    del.onclick = async () => { if (!confirm(`Remove ${r.id}?\n\n${r.text}`)) return; st.file = await api.remove(st.p.path, r.id); render(st); };
    acts.appendChild(del); row.appendChild(acts);
    return row;
  }

  // ───────── the viewer, on the right half
  async function view(st, abs, label) {
    st.viewer = { path: abs, label: label || base(abs), loading: true }; render(st);
    let res; try { res = await api.readText(abs, st.p.path); } catch (e) { res = { error: String((e && e.message) || e) }; }
    if (!st.viewer || norm(st.viewer.path) !== norm(abs)) return;                 // the user moved on while we read
    st.viewer = { path: abs, label: label || base(abs), ...res, loading: false }; render(st);
  }
  function closeViewer(st) { if (!st.viewer) return; st.viewer = null; render(st); }
  function viewerPane(st) {
    const v = st.viewer;
    const box = el('div', 'rl-viewer');
    const head = el('div', 'rl-vhead');
    head.appendChild(el('span', 'rl-vname', v.label));
    head.appendChild(el('span', 'rl-vspacer'));
    if (!v.error) { const mt = el('span', 'muted small', [v.size != null ? size(v.size) : '', v.mtime ? 'changed ' + agoMs(v.mtime) : ''].filter(Boolean).join(' · ')); head.appendChild(mt); }
    const oc = el('button', 'btn small', 'Open in VS Code'); oc.onclick = () => api.openFile(v.path); head.appendChild(oc);
    const x = el('button', 'btn small', '×'); x.title = 'Close (Esc)'; x.onclick = () => closeViewer(st); head.appendChild(x);
    box.appendChild(head);
    const path = el('div', 'rl-vpath mono muted', v.path); box.appendChild(path);
    const body = el('div', 'rl-vbody');
    if (v.loading) body.appendChild(el('div', 'rl-empty muted', 'Reading…'));
    else if (v.error) body.appendChild(el('div', 'rl-empty muted', v.error));
    else body.innerHTML = mdToHtml(v.text);
    box.appendChild(body);
    return box;
  }

  function render(st) {
    st.el.innerHTML = '';
    const bar = el('div', 'rl-bar');
    const n = ((st.file && st.file.rules) || []).length;
    bar.appendChild(el('span', 'bd-count', `${n} rule${n === 1 ? '' : 's'} for this project`));
    const rf = el('button', 'btn small', '⟳'); rf.title = 'Re-read the repo\'s rule files and your rules';
    rf.onclick = () => { load(st); }; bar.appendChild(rf);
    bar.appendChild(el('span', 'bd-help', 'The lead writes here too: node ~/.claude/mission-control/mc-board.js rule add "…"'));
    bar.appendChild(el('span', 'bd-flash', st.flash || ''));
    st.el.appendChild(bar);

    const body = el('div', 'rl-body'); st.el.appendChild(body);
    const list = el('div', 'rl-list'); body.appendChild(list);
    if (!hasBackend()) { list.appendChild(el('div', 'rl-empty muted', 'Rules backend not loaded.')); return; }
    if (st.loading) { list.appendChild(el('div', 'rl-empty muted', 'Reading the rules…')); return; }
    list.appendChild(repoSection(st));
    list.appendChild(kitSection(st));
    list.appendChild(ownSection(st));
    if (st.viewer) body.appendChild(viewerPane(st));
  }

  // Escape closes the viewer of the visible pane. Never a confirm()/alert() from here: this is a key handler.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const st of panes.values()) if (st.viewer && st.el.classList.contains('active')) { closeViewer(st); return; }
  });
  // The Tell-the-lead buttons depend on a terminal that can appear at any moment; refresh just their state.
  setInterval(() => {
    for (const st of panes.values()) {
      if (!st.el.classList.contains('active')) continue;
      const enabled = !!leadHost(st.p);
      for (const b of st.el.querySelectorAll('.rl-tell')) if (b.disabled === enabled) b.disabled = !enabled;
    }
  }, 2000);

  if (window.mc && typeof window.mc.onRules === 'function') {
    window.mc.onRules(({ path, rules }) => {                // the file changed on disk (mc-board.js, or another window)
      for (const st of panes.values()) if (norm(st.p.path) === norm(path)) { st.file = rules; render(st); }
    });
  }

  window.Rules = {
    pane,
    api,                                        // swappable for a fixture; see the note on the adapter above
    /** `--view rules`: open the first repo rule file that exists, so the screenshot shows the viewer too. */
    openFromStartView() {
      const p = window.MC && window.MC.currentProject(); if (!p) return;
      const st = panes.get(p.key); if (!st) return;
      setTimeout(() => {
        if (st.viewer) return;
        const first = ((st.sources && st.sources.repo) || []).find((r) => r.present);
        if (first) view(st, first.path, first.rel);
      }, 1200);
    },
    state: panes,
  };
})();

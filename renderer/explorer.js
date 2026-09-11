/* Explorer — the project's files and branches, with who is touching what.
   Data comes from the main process over the contract in docs/EXPLORER-CONTRACT.md:
   window.mc.explorerList / explorerStatus / explorerBranches / explorerDiff / openFile.
   Load order: persona.js → app.js → explorer.js. It reads window.MC (app.js) and window.Persona
   (persona.js) lazily, and app.js calls window.Explorer.render(project, snapshot) on every snapshot. */
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ago = (ms) => { if (ms == null || !isFinite(ms)) return ''; const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); return h < 48 ? h + 'h' : Math.floor(h / 24) + 'd'; };
  /** compare-only form of a path: no trailing slash, forward slashes, lower case (Windows is case-insensitive) */
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const base = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  /** join `rel` (forward slashes) onto `root` in the root's own slash style, so the path is the one the OS wants */
  const joinPath = (root, rel) => { const sep = String(root).includes('\\') ? '\\' : '/'; const r = String(root).replace(/[\\/]+$/, ''); if (!rel) return r; return r + sep + (sep === '\\' ? rel.replace(/\//g, '\\') : rel); };
  const parentRel = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
  const hasBackend = () => !!(window.mc && typeof window.mc.explorerStatus === 'function' && typeof window.mc.explorerList === 'function');

  const MARK_CLASS = { M: 'm', A: 'a', U: 'a', D: 'd', R: 'r', C: 'r' };
  const MARK_TITLE = { M: 'modified', A: 'added', U: 'untracked', D: 'deleted', R: 'renamed', C: 'copied' };
  const STATUS_MS = 3000, BRANCH_MS = 15000, MAX_PILLS = 3;

  const E = {
    open: false, tab: 'files', projectKey: null, project: null,
    root: null, rootIsWorktree: false, showIgnored: false,
    expanded: new Set(['']),     // rels of open directories ('' is the root level)
    list: new Map(),             // rel -> { entries, error }
    loading: new Set(),          // rels with an explorerList in flight
    status: null, statusSig: null,   // Status from explorer:status, and a signature of what it says
    statusBusy: false,
    branches: null, branchesAt: 0, branchesBusy: false,
    openBranches: new Set(), diffs: new Map(), diffLoading: new Set(),
    menu: null,
  };

  // ───────── preference: the panel is remembered per project
  const prefKey = (key) => 'mc.explorer.' + key;
  const prefGet = (key) => { try { return localStorage.getItem(prefKey(key)) === '1'; } catch { return false; } };
  const prefSet = (key, v) => { try { localStorage.setItem(prefKey(key), v ? '1' : '0'); } catch { /* private mode / quota */ } };

  // ───────── panel
  function ensurePanel() {
    if ($('#explorer')) return;
    const app = $('#app'), body = $('#body');
    if (!app || !body) return;

    const sec = el('section', 'explorer'); sec.id = 'explorer'; sec.hidden = true;

    const head = el('div', 'ex-head');
    head.title = 'Pills come from the agents’ own tool calls (Edit, Write, MultiEdit, NotebookEdit, Read).\nFiles changed by shell commands (git, npm, sed in a terminal) are invisible here — only the git marks show those.';
    const seg = el('div', 'seg');
    const bf = el('button', 'seg-btn active', 'Files'); bf.id = 'ex-tab-files';
    const bb = el('button', 'seg-btn', 'Branches'); bb.id = 'ex-tab-branches';
    seg.appendChild(bf); seg.appendChild(bb); head.appendChild(seg);
    head.appendChild(el('span', 'ex-spacer'));
    const rf = el('button', 'btn small', '⟳'); rf.id = 'ex-refresh'; rf.title = 'Re-read the tree, the git status and the branches';
    const mr = el('button', 'btn small', '⋯'); mr.id = 'ex-more'; mr.title = 'More';
    head.appendChild(rf); head.appendChild(mr);
    sec.appendChild(head);

    const rootLine = el('div', 'ex-root'); rootLine.id = 'ex-root'; sec.appendChild(rootLine);
    const bodyEl = el('div', 'ex-body'); bodyEl.id = 'ex-body'; sec.appendChild(bodyEl);

    app.insertBefore(sec, body);

    bf.onclick = () => setTab('files');
    bb.onclick = () => setTab('branches');
    rf.onclick = () => refresh(true);
    mr.onclick = (ev) => {
      const r = mr.getBoundingClientRect();
      openMenu(r.left, r.bottom + 2, [[(E.showIgnored ? '☑' : '☐') + ' show ignored', () => { E.showIgnored = !E.showIgnored; draw(); }]]);
    };
  }

  function setOpen(v) {
    ensurePanel();
    E.open = !!v;
    const sec = $('#explorer'); if (sec) sec.hidden = !E.open;
    const app = $('#app'); if (app) app.classList.toggle('explorer-open', E.open);
    const btn = $('#btn-explorer'); if (btn) btn.classList.toggle('active', E.open);
    if (E.projectKey) prefSet(E.projectKey, E.open);
    if (E.open) { draw(); refresh(false); } else closeMenu();
  }
  function toggle() { setOpen(!E.open); }

  function setTab(tab) {
    E.tab = tab;
    const bf = $('#ex-tab-files'), bb = $('#ex-tab-branches');
    if (bf) bf.classList.toggle('active', tab === 'files');
    if (bb) bb.classList.toggle('active', tab === 'branches');
    draw();
    if (tab === 'branches') loadBranches(false);
  }

  /** Point the Files tree at another directory (a worktree of the same repo, or back at the project). */
  function setRoot(root, isWorktree) {
    E.root = root; E.rootIsWorktree = !!isWorktree;
    E.expanded = new Set(['']); E.list.clear(); E.loading.clear(); E.status = null; E.statusSig = null;
    setTab('files');
    refresh(false);
  }

  // ───────── the project this panel is showing
  function resetFor(project) {
    E.projectKey = project ? project.key : null;
    E.root = project && project.path ? project.path : null;
    E.rootIsWorktree = false;
    E.expanded = new Set(['']); E.list.clear(); E.loading.clear(); E.status = null; E.statusSig = null;
    E.branches = null; E.branchesAt = 0; E.openBranches.clear(); E.diffs.clear();
    E.tab = 'files';
    const bf = $('#ex-tab-files'), bb = $('#ex-tab-branches');
    if (bf) bf.classList.add('active'); if (bb) bb.classList.remove('active');
    setOpen(E.projectKey ? prefGet(E.projectKey) && !!E.root : false);
  }

  /** app.js calls this on every snapshot and on project selection. */
  function render(project, snapshot) {
    ensurePanel();
    const key = project ? project.key : null;
    E.project = project || null;
    if (key !== E.projectKey) { resetFor(project); return; }
    if (E.open) draw();
  }

  function refresh(force) {
    if (!E.open) return;
    if (force) { E.list.clear(); E.diffs.clear(); }
    pollStatus(true);
    loadBranches(!!force);   // also the Files view needs it: the worktree list maps touched files to tree rows
    draw();
  }

  // ───────── data
  async function ensureList(rel) {
    if (!hasBackend() || !E.root) return;
    if (E.list.has(rel) || E.loading.has(rel)) return;
    E.loading.add(rel);
    const root = E.root;
    let res = null;
    try { res = await window.mc.explorerList(root, rel); }
    catch (e) { res = { entries: [], error: String((e && e.message) || e) }; }
    E.loading.delete(rel);
    if (root !== E.root) return;                       // the root changed while we waited
    E.list.set(rel, res && typeof res === 'object' ? res : { entries: [] });
    draw();
  }

  async function pollStatus(force) {
    if (!hasBackend() || !E.root || E.statusBusy) return;
    E.statusBusy = true;
    const root = E.root;
    let st = null;
    try { st = await window.mc.explorerStatus(root); } catch { st = null; }
    E.statusBusy = false;
    if (!st || root !== E.root) return;
    // `at` is the time of the call, not of a change, so compare what the status actually says
    const sig = JSON.stringify([st.branch, st.files, st.dirs, st.error || '']);
    const changed = E.statusSig !== sig;
    E.status = st; E.statusSig = sig;
    if (changed || force) {
      for (const rel of [...E.expanded]) if (E.list.has(rel)) { E.list.delete(rel); ensureList(rel); }
      draw();
    }
  }

  async function loadBranches(force) {
    const p = E.project;
    if (!hasBackend() || !p || !p.path || E.branchesBusy) return;
    if (typeof window.mc.explorerBranches !== 'function') return;
    if (!force && E.branchesAt && Date.now() - E.branchesAt < BRANCH_MS) return;
    E.branchesBusy = true;
    const root = p.path;
    let b = null;
    try { b = await window.mc.explorerBranches(root); }
    catch (e) { b = { branches: [], error: String((e && e.message) || e) }; }
    E.branchesBusy = false;
    if (!E.project || E.project.path !== root) return;
    E.branches = b && typeof b === 'object' ? b : { branches: [] };
    E.branchesAt = Date.now();
    draw();
  }

  async function loadDiff(name) {
    const p = E.project;
    if (!p || !p.path || E.diffs.has(name) || E.diffLoading.has(name)) return;
    if (!window.mc || typeof window.mc.explorerDiff !== 'function') { E.diffs.set(name, { files: [], error: 'Explorer backend not loaded' }); draw(); return; }
    E.diffLoading.add(name);
    let d = null;
    try { d = await window.mc.explorerDiff(p.path, name); }
    catch (e) { d = { files: [], error: String((e && e.message) || e) }; }
    E.diffLoading.delete(name);
    E.diffs.set(name, d && typeof d === 'object' ? d : { files: [] });
    draw();
  }

  // status is polled only while the panel is open and the window has focus (see the contract)
  setInterval(() => { if (E.open && document.hasFocus()) pollStatus(false); }, STATUS_MS);

  // ───────── agents: the workers of this project and its lead session, with the files they touched
  function agents() {
    const p = E.project; if (!p) return [];
    const out = [];
    const P = window.Persona;
    for (const w of p.workers || []) {
      if (!P) break;
      out.push({ key: 'w:' + w.id, who: P.forWorker(w), role: P.title(w.role), files: w.files || [], cwd: w.cwd || null, branch: w.gitBranch || null, running: w.status === 'running', lastTool: w.lastTool || '' });
    }
    const leadId = window.MC && window.MC.state && window.MC.state.lead ? window.MC.state.lead.get(p.key) : null;
    const s = leadId ? (p.sessions || []).find((x) => x.id === leadId) : null;
    if (s && P) out.push({ key: 's:' + s.id, who: P.forLead(p), role: 'Lead Orchestrator', files: s.files || [], cwd: s.cwd || null, branch: s.gitBranch || null, running: s.status === 'working', lastTool: s.lastTool || '' });
    return out;
  }

  /** Every directory we know to be a checkout of this repo: the Files root, the project, and every worktree
      from Branches. Longest path first, so a worktree nested under the project still wins the prefix test. */
  function checkouts() {
    const out = []; const seen = new Set(); const p = E.project;
    const add = (dir) => { if (!dir) return; const n = norm(dir); if (!n || seen.has(n)) return; seen.add(n); out.push({ path: dir, n }); };
    add(E.root); add(p && p.path);
    for (const b of (E.branches && E.branches.branches) || []) if (b.worktree) add(b.worktree);
    out.sort((a, b) => b.n.length - a.n.length);
    return out;
  }
  /** Which checkout a touched file belongs to, and its path inside it. An agent's `cwd` is usually the project
      root even while it edits inside a worktree, so `f.rel` is only a fast path; otherwise the absolute `path`
      is matched against every checkout we know. Returns null for a file outside all of them. */
  function locate(f, agent) {
    if (!f) return null;
    if (f.rel && agent && agent.cwd) return { rel: String(f.rel).toLowerCase(), root: agent.cwd, n: norm(agent.cwd) };
    const full = norm(f.path);
    if (!full) return null;
    for (const c of checkouts()) if (full.startsWith(c.n + '/')) return { rel: full.slice(c.n.length + 1), root: c.path, n: c.n };
    return null;
  }

  /** pills for one `rel` under the current Files root: one per agent that touched it, edits winning over reads */
  function pillsFor(rel) {
    if (!rel) return [];
    const want = String(rel).toLowerCase();
    const here = norm(E.root);
    const out = [];
    for (const a of agents()) {
      if (!a.files.length) continue;
      let hit = null, loc = null;
      for (const f of a.files) {
        const at = locate(f, a);
        if (!at || at.rel !== want) continue;
        if (!hit || (f.op === 'edit' && hit.op !== 'edit')) { hit = f; loc = at; }
      }
      if (!hit) continue;
      if (!a.running && hit.op !== 'edit') continue;          // a finished agent only keeps its edits
      const foreign = loc.n !== here;
      out.push({ a, op: hit.op, ts: hit.ts, tool: hit.tool || '', foreign, wt: foreign ? base(loc.root) : null });
    }
    out.sort((x, y) => (y.a.running - x.a.running) || (y.ts || 0) - (x.ts || 0));
    return out;
  }

  function pillEl(pl) {
    const s = el('span', 'ex-pill ' + (pl.op === 'edit' ? 'edit' : 'read') + (pl.a.running ? '' : ' done'));
    if (pl.foreign) s.appendChild(el('span', 'fk', '⑂'));
    s.appendChild(el('span', 'nm', pl.a.who.name));
    s.title = [
      `${pl.a.who.name} · ${pl.a.role}`,
      `${pl.op === 'edit' ? 'edited' : 'read'}${pl.ts ? ' ' + ago(Date.now() - pl.ts) + ' ago' : ''}${pl.tool ? ' (' + pl.tool + ')' : ''}`,
      pl.a.running ? (pl.a.lastTool ? 'now: ' + String(pl.a.lastTool).slice(0, 60) : 'running') : 'finished',
      pl.wt ? 'worktree ' + pl.wt : (pl.a.cwd || ''),
    ].filter(Boolean).join('\n');
    return s;
  }

  function pillsInto(node, pills) {
    if (!pills.length) return;
    const box = el('span', 'ex-pills');
    for (const pl of pills.slice(0, MAX_PILLS)) box.appendChild(pillEl(pl));
    if (pills.length > MAX_PILLS) {
      const more = el('span', 'ex-pill more', '+' + (pills.length - MAX_PILLS));
      more.title = pills.slice(MAX_PILLS).map((pl) => `${pl.a.who.name} · ${pl.op}`).join('\n');
      box.appendChild(more);
    }
    node.appendChild(box);
  }

  function markInto(node, mark) {
    if (!mark) return;
    const m = el('span', 'ex-mark ' + (MARK_CLASS[mark] || 'm'), mark);
    m.title = MARK_TITLE[mark] || mark;
    node.appendChild(m);
  }

  // ───────── context menu (a positioned div; no library, and Escape closes it)
  function closeMenu() { if (E.menu) { E.menu.remove(); E.menu = null; } }
  function openMenu(x, y, items) {
    closeMenu();
    const m = el('div', 'ex-menu');
    for (const [label, fn] of items) { const it = el('div', 'ex-mi', label); it.onclick = (ev) => { ev.stopPropagation(); closeMenu(); fn(); }; m.appendChild(it); }
    document.body.appendChild(m);
    const w = m.offsetWidth || 180, h = m.offsetHeight || 90;
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 6)) + 'px';
    m.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 6)) + 'px';
    E.menu = m;
  }
  document.addEventListener('mousedown', (e) => { if (E.menu && !E.menu.contains(e.target)) closeMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  function copyText(t) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(String(t)).catch(() => { /* denied */ }); return; } } catch { /* fall through */ }
    const ta = el('textarea'); ta.value = String(t); ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* nothing else to try */ }
    ta.remove();
  }

  function fileMenu(ev, entry) {
    ev.preventDefault(); ev.stopPropagation();
    const full = joinPath(E.root, entry.rel);
    const parent = joinPath(E.root, parentRel(entry.rel));
    openMenu(ev.clientX, ev.clientY, [
      ['Open in VS Code', () => { if (entry.type === 'dir') window.mc.openInCode(full); else if (typeof window.mc.openFile === 'function') window.mc.openFile(full); else window.mc.openInCode(full); }],
      ['Reveal in folder', () => window.mc.openFolder(entry.type === 'dir' ? full : parent)],
      ['Copy path', () => copyText(full)],
    ]);
  }

  // ───────── drawing
  function draw() {
    if (!E.open) return;
    ensurePanel();
    drawRootLine();
    const body = $('#ex-body'); if (!body) return;
    body.innerHTML = '';
    if (!E.project || !E.project.path) { body.appendChild(el('div', 'ex-msg muted', 'Select a project with a folder to browse it.')); return; }
    // no IPC and nothing cached: say so instead of throwing (the explorer:* channels may not be loaded)
    if (!hasBackend() && !E.status && !E.list.size && !E.branches) { body.appendChild(el('div', 'ex-msg muted', 'Explorer backend not loaded')); return; }
    if (E.tab === 'files') drawFiles(body); else drawBranches(body);
  }

  function drawRootLine() {
    const line = $('#ex-root'); if (!line) return;
    line.innerHTML = '';
    const p = E.project;
    if (!p) { line.appendChild(el('span', 'muted', '—')); return; }
    if (E.rootIsWorktree) {
      const lbl = el('span', 'ex-root-name wt', 'worktree: ' + base(E.root)); lbl.title = E.root || '';
      line.appendChild(lbl);
      const back = el('a', 'ex-back', 'back to project');
      back.title = p.path || ''; back.onclick = () => setRoot(p.path, false);
      line.appendChild(back);
    } else {
      const lbl = el('span', 'ex-root-name', p.name); lbl.title = E.root || '';
      line.appendChild(lbl);
      if (E.status && E.status.branch) line.appendChild(el('span', 'ex-branch', '⎇ ' + E.status.branch));
    }
    if (E.status && E.status.error) { const w = el('span', 'ex-err muted', 'git: ' + E.status.error); w.title = E.status.error; line.appendChild(w); }
  }

  // Files
  function drawFiles(body) {
    const tree = el('div', 'ex-tree');
    addLevel(tree, '', 0);
    body.appendChild(tree);
    if (!E.status) pollStatus(false);
  }

  function addLevel(node, rel, depth) {
    const c = E.list.get(rel);
    if (!c) { ensureList(rel); node.appendChild(indent(el('div', 'ex-note muted', 'loading…'), depth)); return; }
    if (c.error) node.appendChild(indent(el('div', 'ex-note err', c.error), depth));
    const entries = (c.entries || []).filter((e) => E.showIgnored || !e.ignored);
    if (!entries.length && !c.error) node.appendChild(indent(el('div', 'ex-note muted', (c.entries || []).length ? 'only ignored files' : 'empty'), depth));
    for (const e of entries) {
      node.appendChild(fileRow(e, depth));
      if (e.type === 'dir' && E.expanded.has(e.rel)) addLevel(node, e.rel, depth + 1);
    }
  }

  function indent(n, depth) { n.style.paddingLeft = (8 + depth * 13) + 'px'; return n; }

  function fileRow(entry, depth) {
    const isDir = entry.type === 'dir';
    const open = isDir && E.expanded.has(entry.rel);
    const row = indent(el('div', 'ex-row' + (isDir ? ' dir' : '') + (entry.ignored ? ' ign' : '')), depth);
    row.appendChild(el('span', 'ex-caret', isDir ? (open ? '▾' : '▸') : ''));
    const nm = el('span', 'ex-name', entry.name);
    if (isDir && E.status && E.status.dirs && E.status.dirs[entry.rel]) { const d = el('span', 'ex-dirdot'); d.title = 'contains changed files'; nm.appendChild(d); }
    row.appendChild(nm);
    pillsInto(row, pillsFor(entry.rel));
    if (!isDir) markInto(row, E.status && E.status.files ? E.status.files[entry.rel] : null);
    row.title = joinPath(E.root, entry.rel) + (entry.ignored ? '\n(git-ignored)' : '');
    row.onclick = () => {
      if (isDir) { if (open) E.expanded.delete(entry.rel); else { E.expanded.add(entry.rel); ensureList(entry.rel); } draw(); return; }
      const full = joinPath(E.root, entry.rel);
      if (typeof window.mc.openFile === 'function') window.mc.openFile(full); else window.mc.openInCode(full);
    };
    row.oncontextmenu = (ev) => fileMenu(ev, entry);
    return row;
  }

  // Branches
  function branchOrder(a, b) {
    if (a.current !== b.current) return a.current ? -1 : 1;
    const aw = !!a.worktree, bw = !!b.worktree;
    if (aw !== bw) return aw ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  }

  function drawBranches(body) {
    if (!E.branches) { loadBranches(false); body.appendChild(el('div', 'ex-msg muted', 'reading branches…')); return; }
    if (E.branches.error) body.appendChild(el('div', 'ex-note err', E.branches.error));
    const list = [...(E.branches.branches || [])].sort(branchOrder);
    if (!list.length) { body.appendChild(el('div', 'ex-msg muted', 'No branches.')); return; }
    const wrap = el('div', 'ex-tree');
    for (const b of list) {
      wrap.appendChild(branchRow(b));
      if (E.openBranches.has(b.name)) {
        const d = E.diffs.get(b.name);
        if (!d) { loadDiff(b.name); wrap.appendChild(indent(el('div', 'ex-note muted', 'reading changed files…'), 1)); continue; }
        if (d.error) wrap.appendChild(indent(el('div', 'ex-note err', d.error), 1));
        const files = d.files || [];
        const vs = d.base || E.branches.default || 'the default branch';
        if (files.length) wrap.appendChild(indent(el('div', 'ex-note muted', files.length + ' file' + (files.length === 1 ? '' : 's') + ' vs ' + vs), 1));
        else if (!d.error) wrap.appendChild(indent(el('div', 'ex-note muted', 'no changes vs ' + vs), 1));
        for (const f of files) wrap.appendChild(diffRow(f));
      }
    }
    body.appendChild(wrap);
  }

  function branchRow(b) {
    const open = E.openBranches.has(b.name);
    const row = indent(el('div', 'ex-row branch' + (b.current ? ' current' : '')), 0);
    row.appendChild(el('span', 'ex-caret', open ? '▾' : '▸'));
    const nm = el('span', 'ex-name', b.name);
    row.appendChild(nm);
    if (b.worktree) { const w = el('span', 'ex-wt', '⑂ ' + base(b.worktree)); w.title = b.worktree; row.appendChild(w); }
    const p = E.project;
    const pr = (p && p.prs || []).find((x) => (x.branch || x.headRefName) === b.name);
    if (pr) {
      const chip = el('span', 'ex-pr' + (pr.draft ? ' draft' : ''), '#' + pr.number);
      chip.title = `${pr.title || ''}${pr.draft ? ' (draft)' : ''}\n${pr.url || ''}`;
      chip.onclick = (ev) => { ev.stopPropagation(); if (pr.url) window.mc.openUrl(pr.url); };
      row.appendChild(chip);
    }
    row.appendChild(el('span', 'ex-fill'));
    const onIt = agents().filter((a) => a.branch && a.branch === b.name);
    pillsInto(row, onIt.map((a) => ({ a, op: 'edit', ts: 0, tool: '', foreign: false, wt: a.cwd && norm(a.cwd) !== norm(p && p.path) ? base(a.cwd) : null })));
    if (b.ahead || b.behind) {
      const ab = el('span', 'ex-ab', `↑${b.ahead || 0} ↓${b.behind || 0}`);
      ab.title = `${b.ahead || 0} commit(s) ahead of and ${b.behind || 0} behind ${E.branches.default || 'the default branch'}`;
      row.appendChild(ab);
    }
    if (b.worktree) {
      const sf = el('button', 'btn small ex-showfiles', 'Show files');
      sf.title = 'Browse this worktree in the Files tab';
      sf.onclick = (ev) => { ev.stopPropagation(); setRoot(b.worktree, true); };
      row.appendChild(sf);
    }
    row.title = `${b.name}${b.current ? ' (checked out here)' : ''}\n${b.sha || ''}${b.upstream ? '\nupstream ' + b.upstream : ''}`;
    row.onclick = () => { if (open) E.openBranches.delete(b.name); else { E.openBranches.add(b.name); loadDiff(b.name); } draw(); };
    return row;
  }

  function diffRow(f) {
    const row = indent(el('div', 'ex-row'), 1);
    row.appendChild(el('span', 'ex-caret', ''));
    row.appendChild(el('span', 'ex-name', f.rel));
    pillsInto(row, pillsFor(f.rel));
    markInto(row, f.status);
    row.title = f.rel;
    row.onclick = () => { const full = joinPath(E.root, f.rel); if (typeof window.mc.openFile === 'function') window.mc.openFile(full); else window.mc.openInCode(full); };
    row.oncontextmenu = (ev) => fileMenu(ev, { rel: f.rel, type: 'file' });
    return row;
  }

  // ───────── header button (self-wired, like the Work | Memory switch in memory.js)
  const btn = $('#btn-explorer');
  if (btn) btn.onclick = () => toggle();

  window.Explorer = {
    render,
    toggle,
    /** `--view explorer` opens the panel; `--view explorer-branches` opens it on the Branches tab.
        (A colon in the value makes Electron treat it as a URL and the app never starts, so the separator is a dash.) */
    openFromStartView(v) {
      ensurePanel();
      setOpen(true);
      if (!/branches/.test(String(v))) return;
      setTab('branches');
      // for the screenshot: open the first branch that has a diff against the default, so changed files are visible
      setTimeout(() => {
        const list = (E.branches && E.branches.branches) || [];
        const b = list.find((x) => x.name !== (E.branches.default || 'main'));
        if (!b || E.openBranches.size) return;
        E.openBranches.add(b.name); loadDiff(b.name); draw();
      }, 1500);
    },
    state: E,
  };
})();

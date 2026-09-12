/* Add/create a project — the dialog behind the sidebar's "+" button, in three modes:
   an existing folder (the plain picker Mission Control always had), a new folder (mkdir, optional
   `git init`, optional starter CLAUDE.md), or a clone from GitHub (runs `gh repo clone` in a real
   terminal, with the chosen account's GH_TOKEN, and pins the folder only when it exits 0).

   The dialog element is built here and appended to <body> once, so index.html carries nothing but the
   <script> line. Load order: persona.js -> app.js -> ... -> memory.js -> newproject.js; app.js's
   #btn-add calls window.NewProject.open(), and falls back to the old picker when this file is absent. */
'use strict';
(() => {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const join = (parent, name) => String(parent || '').replace(/[\\/]+$/, '') + '\\' + String(name || '');

  /* One object for everything this dialog needs from the backend, like rules.js: a missing backend is a
     single check, and a fixture can drive the dialog by replacing NewProject.api. */
  const api = {
    addFolder: () => window.mc.addProject(),
    pickFolder: (title) => window.mc.pickFolder(title),
    create: (opts) => window.mc.createProject(opts),
    clone: (opts) => window.mc.cloneProject(opts),
    accounts: () => window.mc.ghAccounts(),
    validateName: (n) => window.mc.validateProjectName(n),     // newproject-lib.js, through preload
    parseRepo: (s) => window.mc.parseRepoInput(s),             // same
    onCloned: (cb) => window.mc.onProjectCloned(cb),
    onPtyData: (cb) => window.mc.onPtyData(cb),
  };
  const hasBackend = () => !!(window.mc && typeof window.mc.createProject === 'function' && typeof window.mc.cloneProject === 'function');

  const st = { dlg: null, mode: 'existing', busy: false, cloneId: null, clonePath: null, log: [], folderTouched: false };

  // ───────── the dialog, built once
  function build() {
    const dlg = el('dialog', 'dlg np-dlg');
    dlg.appendChild(el('h3', null, 'Add or create a project'));

    const seg = el('div', 'seg np-modes');
    for (const [mode, label] of [['existing', 'Existing folder'], ['new', 'New folder'], ['clone', 'From GitHub']]) {
      const b = el('button', 'seg-btn' + (mode === 'existing' ? ' active' : ''), label);
      b.type = 'button'; b.dataset.mode = mode; b.onclick = () => setMode(mode);
      seg.appendChild(b);
    }
    dlg.appendChild(seg);

    // existing folder
    const pExisting = el('div', 'np-pane np-existing');
    pExisting.appendChild(el('p', 'muted small', 'Pin a folder you already have. It joins the sidebar and keeps its place there; Mission Control never changes anything inside it.'));
    dlg.appendChild(pExisting);

    // new folder
    const pNew = el('div', 'np-pane np-new');
    pNew.appendChild(folderRow('np-new-parent', 'Parent folder', 'Where the new folder is created'));
    const name = el('label', null); name.appendChild(el('span', null, 'Project name'));
    const nameIn = el('input'); nameIn.type = 'text'; nameIn.id = 'np-new-name'; nameIn.spellcheck = false; nameIn.placeholder = 'my-project';
    name.appendChild(nameIn); pNew.appendChild(name);
    const opts = el('div', 'np-checks');
    opts.appendChild(check('np-git', 'Initialize git', true));
    opts.appendChild(check('np-claude', 'Add a starter CLAUDE.md', true));
    pNew.appendChild(opts);
    pNew.appendChild(el('p', 'muted small mono np-preview', ''));
    dlg.appendChild(pNew);

    // clone from GitHub
    const pClone = el('div', 'np-pane np-clone');
    const repo = el('label', null); const rl = el('span', null, 'Repository ');
    rl.appendChild(el('span', 'muted', '(URL or owner/name)')); repo.appendChild(rl);
    const repoIn = el('input'); repoIn.type = 'text'; repoIn.id = 'np-repo'; repoIn.spellcheck = false; repoIn.placeholder = 'https://github.com/owner/name';
    repo.appendChild(repoIn); pClone.appendChild(repo);
    pClone.appendChild(folderRow('np-clone-parent', 'Parent folder', 'Where the clone is created'));
    const fol = el('label', null); fol.appendChild(el('span', null, 'Folder name'));
    const folIn = el('input'); folIn.type = 'text'; folIn.id = 'np-folder'; folIn.spellcheck = false; folIn.placeholder = 'defaults to the repository name';
    fol.appendChild(folIn); pClone.appendChild(fol);
    const acc = el('label', null); acc.appendChild(el('span', null, 'GitHub account'));
    const accSel = el('select'); accSel.id = 'np-account';
    acc.appendChild(accSel); pClone.appendChild(acc);
    pClone.appendChild(el('p', 'muted small', 'The clone runs as `gh repo clone` in a terminal of its own with that account’s token, so you see the progress and can answer anything gh asks. The folder joins the sidebar when it finishes.'));
    const log = el('pre', 'np-log'); log.hidden = true; pClone.appendChild(log);
    dlg.appendChild(pClone);

    const err = el('p', 'np-error small'); err.hidden = true; dlg.appendChild(err);

    const actions = el('div', 'dlg-actions');
    const cancel = el('button', 'btn', 'Cancel'); cancel.type = 'button'; cancel.onclick = () => close();
    const go = el('button', 'btn primary', 'Choose folder…'); go.type = 'button'; go.onclick = () => submit();
    actions.appendChild(cancel); actions.appendChild(go); dlg.appendChild(actions);

    // Escape must not walk away from a clone that is still running.
    dlg.addEventListener('cancel', (e) => { if (st.busy || st.cloneId) e.preventDefault(); });

    nameIn.oninput = () => { showPreview(); clearError(); };
    repoIn.oninput = () => { const r = api.parseRepo(repoIn.value); if (r && !st.folderTouched) folIn.value = r.name; clearError(); };
    folIn.oninput = () => { st.folderTouched = !!folIn.value; clearError(); };

    document.body.appendChild(dlg);
    st.dlg = dlg;
    return dlg;
  }
  /** A read-only path field with its own Browse… button. */
  function folderRow(id, label, title) {
    const wrap = el('label', null); wrap.appendChild(el('span', null, label));
    const row = el('div', 'np-row');
    const input = el('input'); input.type = 'text'; input.id = id; input.readOnly = true; input.placeholder = 'no folder chosen'; input.title = title;
    const btn = el('button', 'btn small', 'Browse…'); btn.type = 'button';
    btn.onclick = async () => { const p = await api.pickFolder(title); if (p) { input.value = p; showPreview(); clearError(); } };
    row.appendChild(input); row.appendChild(btn); wrap.appendChild(row);
    return wrap;
  }
  function check(id, label, on) {
    const l = el('label', 'chk'); const i = el('input'); i.type = 'checkbox'; i.id = id; i.checked = !!on;
    l.appendChild(i); l.appendChild(document.createTextNode(' ' + label));
    return l;
  }

  const $ = (sel) => st.dlg.querySelector(sel);
  const val = (id) => { const e = st.dlg.querySelector('#' + id); return e ? e.value.trim() : ''; };
  const on = (id) => { const e = st.dlg.querySelector('#' + id); return !!(e && e.checked); };
  function showError(msg) { const e = $('.np-error'); e.textContent = msg || ''; e.hidden = !msg; }
  function clearError() { showError(''); }

  function showPreview() {
    if (st.mode !== 'new') return;
    const parent = val('np-new-parent'), name = val('np-new-name');
    $('.np-preview').textContent = parent && name ? 'Creates ' + join(parent, name) : '';
  }

  function setMode(mode) {
    if (st.busy) return;
    st.mode = mode;
    for (const b of st.dlg.querySelectorAll('.np-modes .seg-btn')) b.classList.toggle('active', b.dataset.mode === mode);
    for (const pane of st.dlg.querySelectorAll('.np-pane')) pane.hidden = !pane.classList.contains('np-' + mode);
    $('.dlg-actions .primary').textContent = mode === 'existing' ? 'Choose folder…' : mode === 'new' ? 'Create' : 'Clone';
    clearError(); showPreview();
    const first = st.dlg.querySelector('.np-pane:not([hidden]) input:not([readonly])');
    if (first) setTimeout(() => first.focus(), 0);
  }

  function setBusy(busy, label) {
    st.busy = busy;
    const go = $('.dlg-actions .primary');
    go.disabled = busy; go.textContent = label || (st.mode === 'new' ? 'Create' : 'Clone');
    for (const b of st.dlg.querySelectorAll('.np-modes .seg-btn')) b.disabled = busy;
    for (const i of st.dlg.querySelectorAll('.np-pane input, .np-pane select, .np-row .btn')) i.disabled = busy;
  }

  // ───────── the three actions
  async function submit() {
    clearError();
    if (st.mode === 'existing') { const p = await api.addFolder(); close(); if (p) selectPath(p); return; }
    if (st.mode === 'new') return createNew();
    return startClone();
  }

  async function createNew() {
    const parent = val('np-new-parent'), name = val('np-new-name');
    if (!parent) return showError('Choose a parent folder.');
    const bad = api.validateName(name); if (bad) return showError(bad);
    setBusy(true, 'Creating…');
    let r = null;
    try { r = await api.create({ parent, name, git: on('np-git'), claudeMd: on('np-claude') }); }
    catch (e) { r = { error: String((e && e.message) || e) }; }
    setBusy(false);
    if (!r || r.error) return showError((r && r.error) || 'Could not create the project.');
    close(); selectPath(r.path);
  }

  async function startClone() {
    const repo = api.parseRepo(val('np-repo'));
    if (!repo) return showError('Enter a GitHub repository: a URL, or owner/name.');
    const parent = val('np-clone-parent');
    if (!parent) return showError('Choose a parent folder.');
    const name = val('np-folder') || repo.name;
    const bad = api.validateName(name); if (bad) return showError(bad);
    setBusy(true, 'Cloning…');
    st.log = []; const log = $('.np-log'); log.hidden = false; log.textContent = 'Starting ' + repo.full + '…';
    let r = null;
    try { r = await api.clone({ repo: repo.full, parent, name, account: val('np-account') || null }); }
    catch (e) { r = { error: String((e && e.message) || e) }; }
    if (!r || r.error) { setBusy(false); log.hidden = true; return showError((r && r.error) || 'Could not start the clone.'); }
    st.cloneId = r.ptyId; st.clonePath = r.path;
    // Give the clone a terminal tab too, when a project is open to hold one: that is where a gh prompt
    // can actually be answered. Without a selected project the log below is the whole view.
    const p = window.MC && window.MC.currentProject();
    if (p && window.MC.attachTerminal) { try { window.MC.attachTerminal(p, r.ptyId, 'Clone ' + repo.full); } catch { /* the log still shows it */ } }
  }

  // ───────── clone progress: the same pty stream the terminal draws, flattened to plain lines
  const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
  function appendLog(data) {
    const clean = String(data).replace(ANSI, '').replace(/\r\n?/g, '\n');
    const parts = (st.log.pop() || '') + clean;
    st.log = st.log.concat(parts.split('\n'));
    if (st.log.length > 200) st.log = st.log.slice(-200);
    const shown = st.log.filter((l) => l.trim()).slice(-10);
    const log = $('.np-log'); log.textContent = shown.join('\n'); log.scrollTop = log.scrollHeight;
  }
  function selectPath(p) { if (window.MC && window.MC.selectPath) window.MC.selectPath(p); }

  function wire() {
    if (!hasBackend()) return;
    api.onPtyData(({ id, data }) => { if (st.cloneId && id === st.cloneId && st.dlg && st.dlg.open) appendLog(data); });
    api.onCloned(({ path, ok }) => {
      if (!st.cloneId) return;
      st.cloneId = null; setBusy(false);
      if (ok) { close(); selectPath(path || st.clonePath); }
      else showError('Clone failed, see the terminal.');
    });
  }

  async function loadAccounts() {
    const sel = $('#np-account'); if (!sel) return;
    sel.innerHTML = '';
    const def = el('option', null, 'Machine default (active gh account)'); def.value = ''; sel.appendChild(def);
    let list = []; try { list = (await api.accounts()) || []; } catch { list = []; }
    for (const a of list) { const o = el('option', null, a.login + (a.active ? ' (active)' : '')); o.value = a.login; sel.appendChild(o); }
    const active = list.find((a) => a.active); if (active) sel.value = active.login;
  }

  function close() {
    if (!st.dlg) return;
    st.cloneId = null; st.busy = false;
    try { st.dlg.close(); } catch { /* already closed */ }
  }

  function open(mode) {
    if (!hasBackend()) return window.mc && window.mc.addProject ? window.mc.addProject() : undefined;
    if (!st.dlg) { build(); wire(); }
    st.folderTouched = false;
    $('.np-log').hidden = true; $('.np-log').textContent = '';
    setBusy(false);
    setMode(mode === 'new' || mode === 'clone' ? mode : 'existing');
    if (!st.dlg.open) st.dlg.showModal();
    loadAccounts();
  }

  window.NewProject = { open, close, api, state: st };
})();

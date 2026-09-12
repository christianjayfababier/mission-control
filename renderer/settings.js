/* Settings — the global dialog behind the cog at the bottom of the sidebar (#dlg-settings).
   Four sections, one of which is not ours: Accounts & AI is drawn by accounts.js (mount()), because the
   provider registry, the probes and the keys all belong to that module; this file owns the shell, the
   navigation, and the three sections that are purely about the app itself:
     Global rules       — read and write orchestrator-system.local.md, the owner's additions to every
                          lead's rulebook (window.mc.readText / writeLocalRules; main.js refuses any
                          other path).
     Hidden projects    — the projects taken out of the sidebar, and the way back (hiddenProjects /
                          unhideProject).
     About & diagnostics — version, the data directory and the kit files, all from the `env` payload,
                          plus Check for updates: the same updater state machine the header chip shows
                          (T-022), asked on demand and refreshed live while the dialog is open, and the
                          main-process crash log with the last memory sample (T-024, diag.js).
   Load order: … → rules.js → accounts.js → settings.js. It reads window.MC and window.Accounts lazily. */
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ago = (iso) => { if (!iso) return ''; const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };

  const SECTIONS = [
    { id: 'accounts', label: 'Accounts & AI', hint: 'CLIs, logins and API keys' },
    { id: 'rules', label: 'Global rules', hint: 'your additions to every lead' },
    { id: 'hidden', label: 'Hidden projects', hint: 'put one back in the sidebar' },
    { id: 'about', label: 'About & diagnostics', hint: 'version and file locations' },
  ];
  const dlg = () => $('#dlg-settings');
  const envOf = () => (window.MC && window.MC.state && window.MC.state.env) || {};
  let current = 'accounts';

  // ───────── the shell
  function buildNav() {
    const nav = $('#set-nav'); if (!nav || nav.dataset.built) return; nav.dataset.built = '1';
    for (const s of SECTIONS) {
      const b = el('button', 'set-nav-btn'); b.dataset.sec = s.id;
      b.appendChild(el('span', 'set-nav-label', s.label));
      b.appendChild(el('span', 'set-nav-hint', s.hint));
      b.onclick = () => show(s.id);
      nav.appendChild(b);
    }
  }
  function show(id) {
    current = SECTIONS.some((s) => s.id === id) ? id : 'accounts';
    for (const b of document.querySelectorAll('.set-nav-btn')) b.classList.toggle('active', b.dataset.sec === current);
    for (const sec of document.querySelectorAll('.set-sec')) sec.hidden = sec.dataset.sec !== current;
    const pane = $('#set-pane'); if (pane) pane.scrollTop = 0;    // a section always opens at its top
    if (current === 'accounts' && window.Accounts) window.Accounts.mount();
    else if (current === 'rules') loadRules();
    else if (current === 'hidden') loadHidden();
    else if (current === 'about') renderAbout();
  }
  /** `sec` is a section id; `--view settings-rules` and friends arrive here as 'rules'. */
  function open(sec) {
    const d = dlg(); if (!d) return;
    buildNav();
    show(sec || current || 'accounts');
    if (!d.open) d.showModal();
  }

  // ───────── global rules: the one file the owner may edit from here
  const rulesStatus = (m) => { const s = $('#set-rules-status'); if (!s) return; s.textContent = m || ''; if (m) setTimeout(() => { if (s.textContent === m) s.textContent = ''; }, 6000); };
  let rulesLoaded = false;
  async function loadRules(force) {
    const ta = $('#set-rules-text'); if (!ta) return;
    const file = envOf().kitLocal;
    const pathLine = $('#set-rules-path'); if (pathLine) pathLine.textContent = file || '(the app has not reported its data directory yet)';
    if (!file || !window.mc || typeof window.mc.readText !== 'function') { ta.value = ''; ta.placeholder = 'unavailable'; return; }
    if (rulesLoaded && !force) return;
    const r = await window.mc.readText(file);
    if (r && r.error) { ta.value = ''; ta.placeholder = r.error; rulesStatus(r.error); return; }
    ta.value = (r && r.text) || '';
    ta.placeholder = 'Anything you write here is appended to every lead session’s system prompt.';
    rulesLoaded = true;
  }
  const saveBtn = $('#set-rules-save');
  if (saveBtn) saveBtn.onclick = async () => {
    const file = envOf().kitLocal; const ta = $('#set-rules-text');
    if (!file || !ta || !window.mc || typeof window.mc.writeLocalRules !== 'function') { rulesStatus('this build cannot write that file'); return; }
    const r = await window.mc.writeLocalRules(file, ta.value);
    rulesStatus(r && r.error ? r.error : `saved · ${r.bytes} bytes · leads pick it up at their next launch`);
  };
  const reloadBtn = $('#set-rules-reload');
  if (reloadBtn) reloadBtn.onclick = () => { rulesLoaded = false; loadRules(true); rulesStatus('reloaded from disk'); };

  // ───────── hidden projects
  async function loadHidden() {
    const box = $('#set-hidden-list'); if (!box) return;
    box.innerHTML = '';
    if (!window.mc || typeof window.mc.hiddenProjects !== 'function') { box.appendChild(el('div', 'muted', 'this build cannot read the hidden list')); return; }
    let rows = [];
    try { rows = await window.mc.hiddenProjects(); } catch (e) { box.appendChild(el('div', 'muted', String((e && e.message) || e))); return; }
    if (!rows.length) { box.appendChild(el('div', 'set-empty muted', 'Nothing is hidden. Projects you hide from the sidebar show up here, with a way back.')); return; }
    for (const r of rows) {
      const row = el('div', 'set-row-item');
      const who = el('div', 'set-row-who');
      who.appendChild(el('div', 'set-row-name', r.name));
      who.appendChild(el('div', 'set-row-path mono', r.path));
      row.appendChild(who);
      if (r.lastSeen) row.appendChild(el('span', 'muted small', 'last seen ' + ago(r.lastSeen)));
      const b = el('button', 'btn small', 'Show again');
      b.onclick = async () => { b.disabled = true; await window.mc.unhideProject(r.path); loadHidden(); };
      row.appendChild(b);
      box.appendChild(row);
    }
  }

  // ───────── about & diagnostics
  function renderAbout() {
    const box = $('#set-about'); if (!box) return;
    box.innerHTML = '';
    const env = envOf();
    const line = (label, value, onOpen) => {
      const row = el('div', 'set-row-item');
      const who = el('div', 'set-row-who');
      who.appendChild(el('div', 'set-row-name', label));
      who.appendChild(el('div', 'set-row-path mono', value == null ? '—' : String(value)));
      row.appendChild(who);
      if (onOpen && value) { const b = el('button', 'btn small', 'Open folder'); b.onclick = () => onOpen(); row.appendChild(b); }
      box.appendChild(row);
    };
    line('Mission Control', env.version ? `version ${env.version}${env.electron ? ' · Electron ' + env.electron : ''}` : 'version unknown');
    line('Data directory', env.dataDir, () => window.mc.openPath(env.dataDir));
    line('Orchestrator rules (shipped, rewritten at every start)', env.kitFile);
    line('Your additions (never overwritten)', env.kitLocal);
    line('Inbox script handed to every lead', env.noteScript);
    line('Terminals', env.ptyAvailable ? 'node-pty loaded' : 'unavailable: ' + (env.ptyError || 'node-pty failed to load'));
    renderCrashLog(box);
    renderUpdates(box);
  }

  // ───────── crash evidence (T-024, diag.js): where the black box is, how big it got, and the last
  // memory sample. Asked every time the section opens, because both numbers move while the app runs.
  function renderCrashLog(box) {
    const row = el('div', 'set-row-item');
    const who = el('div', 'set-row-who');
    who.appendChild(el('div', 'set-row-name', 'Crash log (main process)'));
    const where = el('div', 'set-row-path mono', 'reading…'); who.appendChild(where);
    const mem = el('div', 'set-row-path mono', ''); who.appendChild(mem);
    row.appendChild(who);
    const btn = el('button', 'btn small', 'Open log'); btn.disabled = true;
    row.appendChild(btn);
    box.appendChild(row);
    if (!window.mc || typeof window.mc.diagInfo !== 'function') { where.textContent = 'this build does not write one'; return; }
    window.mc.diagInfo().then((d) => {
      if (!d || !d.file) { where.textContent = 'unavailable'; return; }
      const size = d.bytes == null ? 'not written yet' : d.bytes < 1024 ? d.bytes + ' B' : Math.round(d.bytes / 1024) + ' KB';
      where.textContent = `${d.file} · ${size}` + (d.error ? ' · ' + d.error : '');
      mem.textContent = 'Last memory sample: ' + (d.memory || 'no sample yet') + (d.crashes ? ` · ${d.crashes} renderer crash${d.crashes === 1 ? '' : 'es'} this run` : '');
      if (d.bytes != null) { btn.disabled = false; btn.onclick = () => window.mc.openPath(d.file); }
    }).catch((e) => { where.textContent = String((e && e.message) || e); });
  }

  // ───────── updates: one row inside About, fed by the same push the header chip listens to
  /** The one line that says where the updater stands. `env.version` is what we are running now. */
  function updateLine(u, env) {
    if (!u) return 'Checking the updater…';
    const mine = u.current || env.version || 'this build';
    if (u.state === 'disabled') return `Updates are off in this run (${u.reason || 'not packaged'}). An installed Mission Control checks GitHub Releases.`;
    if (u.state === 'checking') return 'Checking for updates…';
    if (u.state === 'available') return `${u.version} downloading`;
    if (u.state === 'downloading') return `${u.version} downloading ${u.percent}%`;
    if (u.state === 'ready') return `${u.version} ready: restart to install` + (u.busy ? ' (close terminals and wait for workers first)' : '');
    if (u.state === 'error') return u.error || 'the last check failed';
    return u.checkedAt ? `You are on ${mine}, latest` : `You are on ${mine}. No check has run yet.`;
  }
  function renderUpdates(box) {
    const env = envOf();
    const row = el('div', 'set-row-item');
    const who = el('div', 'set-row-who');
    who.appendChild(el('div', 'set-row-name', 'Updates'));
    const status = el('div', 'set-row-path mono', updateLine(window.MC && window.MC.updateState && window.MC.updateState(), env));
    status.id = 'set-update-status';
    who.appendChild(status);
    row.appendChild(who);
    const btn = el('button', 'btn small', 'Check for updates');
    btn.onclick = async () => {
      btn.disabled = true;
      try { onUpdate(await window.mc.updateCheck()); }
      catch (e) { status.textContent = String((e && e.message) || e); }
      finally { btn.disabled = false; }
    };
    row.appendChild(btn);
    box.appendChild(row);
  }
  /** app.js forwards every push here, so the line moves while the dialog stays open. */
  function onUpdate(u) { const s = $('#set-update-status'); if (s) s.textContent = updateLine(u, envOf()); }

  // ───────── wiring
  const cog = $('#btn-cog'); if (cog) cog.onclick = () => open();
  const close = $('#set-close'); if (close) close.onclick = () => dlg().close();

  window.Settings = {
    open,
    show,
    onUpdate,
    /** `--view settings`, `--view settings-rules`, `--view settings-hidden`, `--view settings-about`. */
    openFromStartView(view) { open(String(view || '').replace(/^settings-?/, '') || 'accounts'); },
    sections: SECTIONS,
  };
})();

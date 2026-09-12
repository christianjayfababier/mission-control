/* Accounts & AI — the tools Mission Control and its workers run, and the keys they run with.
   Two homes: the Accounts & AI section of the global Settings dialog (the cog in the sidebar, owned by
   settings.js, which calls mount() when that section is shown), and the per-project AI button in the
   header, which opens #dlg-ai ("AI Collaboration") with one switch per provider. Data comes from the
   main process over docs/ACCOUNTS-CONTRACT.md: window.mc.providersList / providersRefresh /
   providersLogin / providersInstall / providersSetEnabled / secretSet / secretRemove / onProviders.
   Load order: persona.js → app.js → explorer.js → board.js → rules.js → accounts.js → settings.js. It
   reads window.MC (app.js) lazily, and a key value only ever travels one way: into main, never back. */
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const day = (iso) => (iso ? String(iso).slice(0, 10) : '');

  /* One object for the whole backend surface, as in rules.js: a missing backend is one check, and a
     fixture can drive this file by replacing window.Accounts.api. */
  const api = {
    list: () => window.mc.providersList(),
    refresh: () => window.mc.providersRefresh(),
    login: (id, projectPath) => window.mc.providersLogin(id, projectPath),
    install: (id, projectPath) => window.mc.providersInstall(id, projectPath),
    setEnabled: (projectPath, id, enabled) => window.mc.providersSetEnabled(projectPath, id, enabled),
    secretSet: (id, value) => window.mc.secretSet(id, value),
    secretRemove: (id) => window.mc.secretRemove(id),
    openUrl: (u) => window.mc.openUrl(u),
  };
  const hasBackend = () => !!(window.mc && typeof window.mc.providersList === 'function' && typeof window.mc.secretSet === 'function');

  // { providers, status, secrets, encryption, global } — the last payload from the main process
  let data = null;
  let loading = null;

  const GROUPS = [
    { id: 'required', title: 'Required', hint: 'Mission Control cannot supervise anything without these two.', match: (p) => p.role === 'required' },
    { id: 'ai', title: 'AI tools', hint: 'Optional coding agents a worker may call. Install and log in here; each keeps its own account.', match: (p) => p.kind === 'cli' && p.role !== 'required' },
    { id: 'keys', title: 'API keys', hint: 'Stored encrypted on this machine (Windows DPAPI) and exported into every new terminal of a project that may use them.', match: (p) => p.kind === 'key' },
  ];

  const status = (m) => { const s = $('#acct-status'); if (!s) return; s.textContent = m || ''; if (m) setTimeout(() => { if (s.textContent === m) s.textContent = ''; }, 6000); };
  /** Is the Accounts & AI section actually on screen? (Settings dialog open, that section selected.) */
  const isOpen = () => { const d = $('#dlg-settings'); const sec = $('.set-sec[data-sec="accounts"]'); return !!(d && d.open && sec && !sec.hidden); };
  const aiOpen = () => { const d = $('#dlg-ai'); return !!(d && d.open); };

  async function load(force) {
    if (!hasBackend()) { data = { providers: [], status: {}, secrets: {}, encryption: false, global: {} }; return data; }
    if (loading) return loading;
    loading = Promise.resolve(force ? api.refresh() : api.list())
      .then((d) => { data = d || { providers: [], status: {}, secrets: {}, encryption: false, global: {} }; return data; })
      .catch((e) => { status('could not read the providers: ' + ((e && e.message) || e)); return data; })
      .finally(() => { loading = null; });
    return loading;
  }

  // ───────── a status line: a dot, the version, and the one line the probe wrote
  function dotClass(p, st) {
    if (!st) return 'unknown';
    if (p.kind === 'key') return st.installed ? 'ok' : 'off';
    if (!st.installed) return p.role === 'required' ? 'bad' : 'off';
    if (st.loggedIn === false) return 'warn';
    if (st.loggedIn === null) return 'unknown';
    return 'ok';
  }
  function statusLine(p, st) {
    const line = el('div', 'acct-status-line');
    line.appendChild(el('span', 'acct-dot ' + dotClass(p, st)));
    const detail = el('span', 'acct-detail', (st && st.detail) || 'not checked yet');
    detail.title = [(st && st.detail) || 'not checked yet', st && st.path].filter(Boolean).join('\n');
    line.appendChild(detail);
    if (st && st.error) line.appendChild(el('span', 'acct-err', st.error));
    return line;
  }

  /** The project a login or install terminal opens in: the selected one, else the first with a path. */
  function terminalProject() {
    const MC = window.MC; if (!MC) return null;
    const cur = MC.currentProject(); if (cur && cur.path) return cur;
    return ((MC.state && MC.state.snapshot && MC.state.snapshot.projects) || []).find((x) => x.path) || null;
  }
  async function runInTerminal(kind, p) {
    const proj = terminalProject();
    if (!proj) { status('Add a project first — logins and installs run in a terminal of a project.'); return; }
    let r = null;
    try { r = await (kind === 'login' ? api.login(p.id, proj.path) : api.install(p.id, proj.path)); }
    catch (e) { r = { error: String((e && e.message) || e) }; }
    if (!r || r.error) { status(r && r.error ? r.error : 'could not open a terminal'); return; }
    for (const id of ['#dlg-settings', '#dlg-ai']) { const dlg = $(id); if (dlg && dlg.open) dlg.close(); }
    try { await window.MC.adoptTerminal(proj, r.ptyId, (kind === 'login' ? 'Log in: ' : 'Install: ') + p.name); }
    catch (e) { status('the terminal did not open: ' + ((e && e.message) || e)); }
  }

  // ───────── rows
  function cliRow(p, st) {
    const row = el('div', 'acct-row');
    const who = el('div', 'acct-who');
    const nameLine = el('div', 'acct-name', p.name);
    if (st && st.version) nameLine.appendChild(el('span', 'acct-ver', 'v' + st.version));
    who.appendChild(nameLine);
    who.appendChild(el('div', 'acct-blurb', p.blurb || ''));
    if (st && st.path) { const w = el('div', 'acct-path', st.path); w.title = st.path; who.appendChild(w); }
    row.appendChild(who);

    const mid = el('div', 'acct-mid');
    mid.appendChild(statusLine(p, st));
    if (p.docs) { const a = el('a', 'acct-link', 'vendor docs'); a.title = p.docs; a.onclick = () => api.openUrl(p.docs); mid.appendChild(a); }
    row.appendChild(mid);

    const ctl = el('div', 'acct-ctl');
    if (!st || !st.installed) {
      const b = el('button', 'btn small primary', 'Install'); b.title = p.install || ''; b.onclick = () => runInTerminal('install', p); ctl.appendChild(b);
    } else if (p.login) {
      const b = el('button', 'btn small' + (st.loggedIn === false ? ' primary' : ''), st.loggedIn ? 'Log in again' : 'Log in');
      b.title = p.login; b.onclick = () => runInTerminal('login', p); ctl.appendChild(b);
    }
    const r = el('button', 'btn small', 'Refresh'); r.title = 'Run the status probes again'; r.onclick = () => reload(true); ctl.appendChild(r);
    row.appendChild(ctl);
    return row;
  }

  function keyRow(p, st) {
    const row = el('div', 'acct-row key');
    const who = el('div', 'acct-who');
    const nameLine = el('div', 'acct-name', p.name);
    nameLine.appendChild(el('span', 'acct-var', p.envVar || ''));
    who.appendChild(nameLine);
    who.appendChild(el('div', 'acct-blurb', p.blurb || ''));
    row.appendChild(who);

    const set = data && data.secrets && data.secrets[p.id];
    const mid = el('div', 'acct-mid');
    mid.appendChild(statusLine(p, st));
    if (p.docs) { const a = el('a', 'acct-link', 'where to get one'); a.title = p.docs; a.onclick = () => api.openUrl(p.docs); mid.appendChild(a); }
    row.appendChild(mid);

    const ctl = el('div', 'acct-ctl key');
    const input = el('input', 'acct-key'); input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = set ? `stored ${day(set.setAt)} — type a new key to replace it` : 'paste the key';
    const enc = !(data && data.encryption);
    if (enc) { input.disabled = true; input.placeholder = 'encryption unavailable on this machine'; }
    ctl.appendChild(input);
    const save = el('button', 'btn small primary', 'Save');
    save.disabled = enc;
    save.onclick = async () => {
      const v = input.value.trim(); if (!v) { status('paste a key first'); return; }
      const r = await api.secretSet(p.id, v);
      input.value = '';
      if (r && r.error) { status(r.error); return; }
      status(`${p.name} saved — new terminals get ${p.envVar}`);
      reload(false);
    };
    ctl.appendChild(save);
    const rm = el('button', 'btn small', 'Remove');
    rm.disabled = !set;
    rm.onclick = async () => { const r = await api.secretRemove(p.id); if (r && r.error) { status(r.error); return; } status(`${p.name} removed — new terminals no longer get ${p.envVar}`); reload(false); };
    ctl.appendChild(rm);
    row.appendChild(ctl);
    return row;
  }

  function render() {
    const box = $('#acct-groups'); if (!box) return;
    box.innerHTML = '';
    if (!hasBackend()) { box.appendChild(el('div', 'muted', 'This build has no accounts backend.')); return; }
    const list = (data && data.providers) || [];
    if (!list.length) { box.appendChild(el('div', 'muted', 'Reading the providers…')); return; }
    if (data && !data.encryption) box.appendChild(el('div', 'acct-warn', 'This machine cannot encrypt secrets (Electron safeStorage is unavailable), so Mission Control will not store an API key here. The CLI logins above are unaffected.'));
    for (const g of GROUPS) {
      const members = list.filter(g.match); if (!members.length) continue;
      const sec = el('section', 'acct-group');
      const h = el('div', 'acct-group-head'); h.appendChild(el('span', 'acct-group-title', g.title)); h.appendChild(el('span', 'muted small', g.hint));
      sec.appendChild(h);
      for (const p of members) sec.appendChild(p.kind === 'key' ? keyRow(p, data.status[p.id]) : cliRow(p, data.status[p.id]));
      box.appendChild(sec);
    }
  }

  async function reload(force) { if (force) status('running the status probes…'); await load(force); render(); if (force) status('status refreshed'); }

  // ───────── AI Collaboration: the per-project provider list behind the header button
  // One short line per provider — the long version lives in Settings → Accounts & AI.
  const AI_LINE = {
    claude: 'Runs this project’s lead and workers.',
    github: 'Branches, PRs and this project’s token.',
    codex: 'OpenAI’s coding agent.',
    gemini: 'Google’s CLI agent.',
    'anthropic-key': 'Used instead of the subscription login when set.',
    'openai-key': 'For Codex in API-key mode and OpenAI SDKs.',
    'gemini-key': 'Lets the Gemini CLI run without the browser login.',
  };
  const AI_HINT = { required: 'Mission Control’s own tools.', ai: 'Extra agents a worker may call.', keys: 'These are what actually get withheld.' };

  /** A styled checkbox: a real input (so the keyboard and the screen reader get it) behind a CSS track. */
  function switchEl(on, label, onChange) {
    const wrap = el('label', 'sw');
    const input = el('input', 'sw-input'); input.type = 'checkbox'; input.checked = !!on;
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-checked', on ? 'true' : 'false');
    input.setAttribute('aria-label', label);
    const track = el('span', 'sw-track'); track.appendChild(el('span', 'sw-knob'));
    input.onchange = () => { input.setAttribute('aria-checked', input.checked ? 'true' : 'false'); onChange(input.checked); };
    wrap.appendChild(input); wrap.appendChild(track);
    return wrap;
  }

  const aiStatus = (m) => { const s = $('#ai-status'); if (!s) return; s.textContent = m || ''; if (m) setTimeout(() => { if (s.textContent === m) s.textContent = ''; }, 4000); };

  async function projectChecklist(box, projectPath) {
    if (!box) return;
    box.innerHTML = '';
    if (!hasBackend()) return;
    if (!data) await load(false);
    // two callers can be inside that await at once (opening the dialog, and a push from main): clear again
    // here, where nothing else can come between the clear and the rows, or the list draws twice.
    box.innerHTML = '';
    const proj = (window.MC && window.MC.currentProject()) || null;
    const own = (proj && proj.settings && proj.settings.providers) || {};
    const glob = (data && data.global) || {};
    const list = (data && data.providers) || [];
    const enabledOf = (p) => (typeof own[p.id] === 'boolean' ? own[p.id] : (typeof glob[p.id] === 'boolean' ? glob[p.id] : true));
    const live = new Map(list.map((p) => [p.id, enabledOf(p)]));
    const count = () => { const on = [...live.values()].filter(Boolean).length; const s = $('#ai-status'); if (s && !s.dataset.flash) s.textContent = `${on} of ${live.size} enabled for this project`; };

    for (const g of GROUPS) {
      const members = list.filter(g.match); if (!members.length) continue;
      const sec = el('section', 'acct-group');
      const h = el('div', 'acct-group-head');
      h.appendChild(el('span', 'acct-group-title', g.title));
      h.appendChild(el('span', 'muted small', AI_HINT[g.id] || ''));
      sec.appendChild(h);
      for (const p of members) {
        const row = el('div', 'ai-row');
        const who = el('div', 'ai-who');
        const name = el('div', 'ai-name', p.name);
        if (p.envVar) name.appendChild(el('span', 'acct-var', p.envVar));
        who.appendChild(name);
        // the honest footnote: a CLI toggle records a preference, a key toggle actually withholds something
        const tail = p.kind === 'key'
          ? (data && data.secrets && data.secrets[p.id] ? '' : ' · no key stored yet')
          : ' · records the preference; keys are what get withheld';
        who.appendChild(el('div', 'ai-blurb', (AI_LINE[p.id] || p.blurb || '') + tail));
        row.appendChild(who);
        const sw = switchEl(live.get(p.id), p.name, async (on) => {
          live.set(p.id, on); row.classList.toggle('off', !on);
          const r = await api.setEnabled(projectPath, p.id, on);
          if (r && r.error) { aiStatus(r.error); return; }
          if (proj && proj.settings) proj.settings.providers = { ...(proj.settings.providers || {}), [p.id]: on };   // until the next snapshot
          const s = $('#ai-status');
          if (s) { s.dataset.flash = '1'; s.textContent = `saved · ${p.name} ${on ? 'enabled' : 'disabled'} here`; setTimeout(() => { delete s.dataset.flash; count(); }, 2500); }
        });
        row.classList.toggle('off', !live.get(p.id));
        row.appendChild(sw);
        sec.appendChild(row);
      }
      box.appendChild(sec);
    }
    count();
  }

  // ───────── wiring
  const refreshBtn = $('#acct-refresh'); if (refreshBtn) refreshBtn.onclick = () => reload(true);

  /** settings.js calls this when the Accounts & AI section is shown: draw what we know, then refresh it. */
  async function mount() { render(); await load(false); render(); }
  /** Kept for callers that just want the accounts: open the Settings dialog on this section. */
  function open() { if (window.Settings) window.Settings.open('accounts'); else mount(); }

  // the per-project AI dialog
  const aiDlg = $('#dlg-ai');
  const aiBtn = $('#btn-ai');
  if (aiBtn) aiBtn.onclick = () => openAi();
  const aiClose = $('#ai-close'); if (aiClose) aiClose.onclick = () => aiDlg.close();
  async function openAi() {
    const p = window.MC && window.MC.currentProject();
    if (!aiDlg || !p || !p.path) return;
    const label = $('#dlg-ai-project'); if (label) label.textContent = `${p.name} — ${p.path}`;
    if (!aiDlg.open) aiDlg.showModal();
    await projectChecklist($('#ai-groups'), p.path);
  }

  if (window.mc && typeof window.mc.onProviders === 'function') {
    window.mc.onProviders((payload) => {          // a refresh finished, or a login terminal exited
      if (!payload) return;
      data = { ...(data || {}), ...payload };
      if (isOpen()) render();
      if (aiOpen()) { const p = window.MC && window.MC.currentProject(); if (p && p.path) projectChecklist($('#ai-groups'), p.path); }
    });
  }

  window.Accounts = { open, openAi, mount, api, projectChecklist, reload, state: () => data, hasBackend };
})();

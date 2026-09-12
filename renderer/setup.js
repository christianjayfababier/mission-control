/* Setup — the first-run wizard (T-020), behind #dlg-setup.

   It opens by itself exactly once in the life of a machine: when settings.json carries no `setup` stamp
   AND the registry has no projects (main.js computes that as env.setupNeeded through setup-lib.js). After
   that it is only ever opened on purpose — Settings → About → "Run setup again", or `--view setup`.

   Four steps, a left step list like the Settings nav, Back / Next / Finish:
     Welcome       what Mission Control is, and what the next three screens check.
     Tools         the four REQUIRED providers. Next unlocks when Node and Git are installed and Claude
                   Code and the GitHub CLI are installed *and* logged in; until then the step says what
                   is blocking, in one sentence.
     AI tools      the optional AI TOOLS and API KEYS groups, skippable by construction.
     First project the Add/create dialog (window.NewProject), and what the registry has now.

   It owns no provider code: every row here is window.Accounts.row(), the same renderer Settings uses, so
   the Install and Log in buttons run the same terminal flows (docs/ACCOUNTS-CONTRACT.md). Finish writes
   the stamp through window.mc.setupDone().

   Load order: … → accounts.js → settings.js → memory.js → newproject.js → setup.js. Everything it reaches
   for (Accounts, NewProject, Settings) is read lazily, so a build without one of them still opens. */
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const STEPS = [
    { id: 'welcome', label: 'Welcome', hint: 'what this is' },
    { id: 'tools', label: 'Tools', hint: 'what must be installed' },
    { id: 'ai', label: 'AI tools', hint: 'optional, skippable' },
    { id: 'project', label: 'First project', hint: 'a folder to work in' },
  ];
  /** The REQUIRED providers, in the order a new machine installs them: the runtimes, then the accounts. */
  const REQUIRED_ORDER = ['node', 'git', 'github', 'claude'];
  /** These two have an account to sign in to; Node and Git only have to exist. */
  const NEEDS_LOGIN = new Set(['claude', 'github']);

  const dlg = () => $('#dlg-setup');
  let step = 'welcome';
  let firstRun = false;         // opened by itself, rather than from About or --view
  let unwatch = null;           // the Accounts push subscription, live only while we are open
  let projectTimer = null;      // the First project step polls the registry while it is showing
  let setupState = { setup: null, projects: [], needed: false };

  const setStatus = (m) => { const s = $('#setup-status'); if (s) s.textContent = m || ''; };

  // ───────── the shell
  function buildNav() {
    const nav = $('#setup-nav'); if (!nav || nav.dataset.built) return; nav.dataset.built = '1';
    STEPS.forEach((s, i) => {
      const b = el('button', 'set-nav-btn setup-nav-btn'); b.dataset.step = s.id; b.type = 'button';
      b.appendChild(el('span', 'setup-step-no', String(i + 1)));
      const who = el('span', 'setup-nav-who');
      who.appendChild(el('span', 'set-nav-label', s.label));
      who.appendChild(el('span', 'set-nav-hint', s.hint));
      b.appendChild(who);
      // the step list is a map, not a shortcut: nothing here can skip past the Tools gate
      b.onclick = () => { if (i <= STEPS.findIndex((x) => x.id === step)) show(s.id); };
      nav.appendChild(b);
    });
  }

  function show(id) {
    step = STEPS.some((s) => s.id === id) ? id : 'welcome';
    for (const b of document.querySelectorAll('#setup-nav .set-nav-btn')) b.classList.toggle('active', b.dataset.step === step);
    for (const sec of document.querySelectorAll('#setup-pane .set-sec')) sec.hidden = sec.dataset.step !== step;
    const pane = $('#setup-pane'); if (pane) pane.scrollTop = 0;
    setStatus('');
    if (step === 'tools' || step === 'ai') drawProviders();
    if (step === 'project') { drawProject(); startProjectPoll(); } else stopProjectPoll();
    drawFooter();
  }

  const index = () => STEPS.findIndex((s) => s.id === step);

  function drawFooter() {
    const back = $('#setup-back'), next = $('#setup-next'), skip = $('#setup-skip');
    if (!back || !next) return;
    back.disabled = index() <= 0;
    const last = index() === STEPS.length - 1;
    next.textContent = last ? 'Finish' : 'Next';
    const block = step === 'tools' ? toolsBlocker() : null;
    next.disabled = !!block;
    next.title = block || (last ? 'Save that setup is done and start working' : '');
    // the last step is explicitly skippable: nobody is forced to create a project to get out of here
    if (skip) { skip.hidden = !last || setupState.projects.length > 0; }
  }

  // ───────── step 2: the tools
  /** What Accounts knows right now, or an empty shape before the first payload lands. */
  const accountsData = () => (window.Accounts && window.Accounts.state()) || { providers: [], status: {}, secrets: {} };
  const required = () => {
    const list = accountsData().providers || [];
    return REQUIRED_ORDER.map((id) => list.find((p) => p.id === id)).filter(Boolean);
  };

  /**
   * One sentence saying what stands between the owner and the next step, or null when nothing does.
   * Pure enough to read: it only looks at the providers and their last status.
   */
  function toolsBlocker() {
    const data = accountsData();
    const rows = required();
    if (!rows.length) return 'Reading what is installed on this machine…';
    const checking = rows.filter((p) => (data.status[p.id] || {}).checking || !data.status[p.id]);
    if (checking.length) return 'Checking what is installed on this machine…';
    const missing = rows.filter((p) => !(data.status[p.id] || {}).installed);
    const out = rows.filter((p) => NEEDS_LOGIN.has(p.id) && (data.status[p.id] || {}).installed && (data.status[p.id] || {}).loggedIn !== true);
    const names = (l) => l.map((p) => p.name).join(' and ');
    if (missing.length && out.length) return `Install ${names(missing)}, and log in to ${names(out)}, to continue.`;
    if (missing.length) return `Install ${names(missing)} to continue — the buttons on the right open a terminal and run it.`;
    if (out.length) return `Log in to ${names(out)} to continue — the button opens a terminal and starts the browser flow.`;
    return null;
  }

  function drawProviders() {
    const A = window.Accounts;
    const toolsBox = $('#setup-tools'), aiBox = $('#setup-ai-groups');
    const box = step === 'tools' ? toolsBox : aiBox;
    if (!box) return;
    if (!A || !A.hasBackend()) { box.innerHTML = ''; box.appendChild(el('div', 'muted', 'This build has no accounts backend.')); return; }
    const data = accountsData();
    box.innerHTML = '';
    if (step === 'tools') {
      const rows = required();
      if (!rows.length) { box.appendChild(el('div', 'muted', 'Reading the providers…')); }
      else for (const p of rows) box.appendChild(A.row(p, data.status[p.id]));
      const block = toolsBlocker();
      const note = $('#setup-tools-block');
      if (note) { note.textContent = block || 'All four are ready. Next.'; note.classList.toggle('ok', !block); }
    } else {
      // the optional half of Accounts & AI, group headings and all — minus REQUIRED, which is step 2
      for (const g of (A.GROUPS || []).filter((x) => x.id !== 'required')) {
        const members = (data.providers || []).filter(g.match); if (!members.length) continue;
        const sec = el('section', 'acct-group');
        const h = el('div', 'acct-group-head');
        h.appendChild(el('span', 'acct-group-title', g.title));
        h.appendChild(el('span', 'muted small', g.hint));
        sec.appendChild(h);
        for (const p of members) sec.appendChild(A.row(p, data.status[p.id]));
        box.appendChild(sec);
      }
      if (!box.children.length) box.appendChild(el('div', 'muted', 'Reading the providers…'));
    }
    drawFooter();
  }

  // ───────── step 4: the first project
  async function refreshProjects() {
    if (!window.mc || typeof window.mc.setupState !== 'function') return setupState;
    try { setupState = (await window.mc.setupState()) || setupState; } catch { /* keep what we had */ }
    return setupState;
  }
  let drawnProjects = -1;       // what the list on screen actually shows, so a redraw is never skipped
  function drawProject() {
    const box = $('#setup-projects'); if (!box) return;
    box.innerHTML = '';
    const list = setupState.projects || [];
    drawnProjects = list.length;
    if (!list.length) {
      box.appendChild(el('div', 'set-empty muted', 'No project yet. Add one and Mission Control starts watching it: its sessions, its workers, its board and its memory.'));
    } else {
      for (const p of list) {
        const row = el('div', 'set-row-item');
        const who = el('div', 'set-row-who');
        who.appendChild(el('div', 'set-row-name', p.name));
        who.appendChild(el('div', 'set-row-path mono', p.path));
        row.appendChild(who);
        row.appendChild(el('span', 'acct-dot ok'));
        box.appendChild(row);
      }
    }
    drawFooter();
  }
  /** The Add/create dialog writes the registry behind our back, so watch it while this step is showing. */
  function startProjectPoll() {
    stopProjectPoll();
    projectTimer = setInterval(async () => {
      await refreshProjects();
      if ((setupState.projects || []).length !== drawnProjects) drawProject();
    }, 1200);
  }
  function stopProjectPoll() { if (projectTimer) { clearInterval(projectTimer); projectTimer = null; } }

  // ───────── finishing
  async function finish() {
    const next = $('#setup-next'); if (next) next.disabled = true;
    let r = null;
    try { r = window.mc && window.mc.setupDone ? await window.mc.setupDone() : { ok: true }; }
    catch (e) { r = { error: String((e && e.message) || e) }; }
    if (r && r.error) { setStatus(r.error); if (next) next.disabled = false; return; }
    close();
  }

  function close() {
    stopProjectPoll();
    if (unwatch) { try { unwatch(); } catch { /* ignore */ } unwatch = null; }
    if (window.Accounts && window.Accounts.setStatusSink) window.Accounts.setStatusSink(null);
    const d = dlg(); if (d && d.open) { try { d.close(); } catch { /* already closed */ } }
  }

  async function open(startStep, opts) {
    const d = dlg(); if (!d) return;
    firstRun = !!(opts && opts.firstRun);
    buildNav();
    const intro = $('#setup-intro');
    if (intro) intro.textContent = firstRun
      ? 'This is the first time Mission Control has run on this machine, so it is showing you the way in. It takes a couple of minutes, and you can reopen it any time from Settings → About & diagnostics.'
      : 'You can run through this whenever you like; nothing here is undone by looking at it again.';
    if (!d.open) d.showModal();
    // hear the probe pushes for as long as we are up
    if (window.Accounts && window.Accounts.onUpdate && !unwatch) {
      unwatch = window.Accounts.onUpdate(() => { if (step === 'tools' || step === 'ai') drawProviders(); else drawFooter(); });
      window.Accounts.setStatusSink((m) => setStatus(m));
    }
    show(startStep && STEPS.some((s) => s.id === startStep) ? startStep : 'welcome');
    // show() drew the project list from whatever we knew before; the registry is the truth, and it
    // arrives one IPC later. Redraw, or the step claims "no project yet" on a furnished machine.
    await refreshProjects();
    if (step === 'project') drawProject(); else drawFooter();
    if (window.Accounts && window.Accounts.ensure) { await window.Accounts.ensure(false); if (step === 'tools' || step === 'ai') drawProviders(); else drawFooter(); }
  }

  // ───────── wiring
  const back = $('#setup-back'); if (back) back.onclick = () => { const i = index(); if (i > 0) show(STEPS[i - 1].id); };
  const next = $('#setup-next'); if (next) next.onclick = () => { const i = index(); if (i >= STEPS.length - 1) finish(); else show(STEPS[i + 1].id); };
  const skip = $('#setup-skip'); if (skip) skip.onclick = () => finish();
  const addBtn = $('#setup-add'); if (addBtn) addBtn.onclick = () => { if (window.NewProject) window.NewProject.open(); else if (window.mc && window.mc.addProject) window.mc.addProject().then(() => refreshProjects().then(drawProject)); };
  const refreshBtn = $('#setup-refresh'); if (refreshBtn) refreshBtn.onclick = async () => { setStatus('running the status probes…'); if (window.Accounts) await window.Accounts.ensure(true); drawProviders(); setStatus('status refreshed'); };
  // Esc closes a <dialog> on its own; the subscription and the poll have to go with it
  const d0 = dlg(); if (d0) d0.addEventListener('close', () => { stopProjectPoll(); if (unwatch) { try { unwatch(); } catch { /* ignore */ } unwatch = null; } if (window.Accounts && window.Accounts.setStatusSink) window.Accounts.setStatusSink(null); });

  window.Setup = {
    open, close, show,
    isOpen: () => { const d = dlg(); return !!(d && d.open); },
    steps: STEPS,
    /** exported for the eye, and for anyone who wants to know why Next is grey */
    blocker: toolsBlocker,
  };
})();

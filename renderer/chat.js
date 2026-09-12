/* Team chat — the project's AI colleagues talking among themselves, in a side panel next to the
   Explorer (docs/TEAM-CHAT-CONTRACT.md, T-027).

   Read-only by construction. The panel draws what the agents said; the only thing it can do with a
   message is paste it into the lead's composer (window.MC.pasteToLead), where the human still presses
   Send. Data comes from the main process: window.mc.chatGet / chatSet / chatForwarded / chatClear /
   chatCandidates, plus the pushed `chat` event.
   Load order: persona.js → app.js → chat.js. Avatars are drawn here from the seed main.js sends, so
   the chip and the message use exactly the name and face persona.js gives that provider id. */
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const clock = (ts) => { const d = new Date(ts); return isNaN(d) ? '' : d.toTimeString().slice(0, 5); };
  const dayOf = (ts) => { const d = new Date(ts); return isNaN(d) ? '' : d.toDateString(); };
  const hasBackend = () => !!(window.mc && typeof window.mc.chatGet === 'function');
  const avatarFor = (row) => (window.Persona ? window.Persona.avatar(row.seed || ('chat:' + row.id), (row.name || '?')[0]) : '');

  const C = {
    open: false, project: null, projectKey: null,
    settings: null, roster: [], messages: [], caps: { agent: {}, today: 0 }, fixture: false,
    busy: false, clearArmed: false, menu: null, note: '',
  };

  // the panel is remembered per project, like the Explorer's — but here the remembered flag *is*
  // chat.visible in project settings, because hiding the panel is what stops the agents.
  const prefKey = (key) => 'mc.chat.' + key;
  const prefGet = (key) => { try { return localStorage.getItem(prefKey(key)) === '1'; } catch { return false; } };
  const prefSet = (key, v) => { try { localStorage.setItem(prefKey(key), v ? '1' : '0'); } catch { /* private mode */ } };

  // ───────── the panel shell
  function ensurePanel() {
    if ($('#chat')) return;
    const app = $('#app'), body = $('#body');
    if (!app || !body) return;

    const sec = el('section', 'chat'); sec.id = 'chat'; sec.hidden = true;

    const head = el('div', 'ch-head');
    const title = el('div', 'ch-title');
    title.appendChild(el('span', 'ch-name', 'Team chat'));
    const tag = el('span', 'ch-tag', 'brainstorm, unverified');
    tag.title = 'These are AI colleagues thinking out loud. They have no tools here, they change nothing, and nothing they say reaches your lead unless you send it.';
    title.appendChild(tag);
    head.appendChild(title);
    const sw = el('label', 'ch-switch');
    const cb = el('input'); cb.type = 'checkbox'; cb.id = 'ch-enable';
    sw.appendChild(cb); sw.appendChild(el('span', null, 'on'));
    sw.title = 'Switch the chat on for this project. Off means the agents never run here.';
    head.appendChild(sw);
    const hide = el('button', 'btn small', '✕'); hide.id = 'ch-hide'; hide.title = 'Hide the panel. The agents stop until you show it again.';
    head.appendChild(hide);
    sec.appendChild(head);

    const chips = el('div', 'ch-roster'); chips.id = 'ch-roster'; sec.appendChild(chips);
    const note = el('div', 'ch-note'); note.id = 'ch-note'; note.hidden = true; sec.appendChild(note);
    const list = el('div', 'ch-body'); list.id = 'ch-body'; sec.appendChild(list);

    const foot = el('div', 'ch-foot');
    foot.appendChild(el('span', 'ch-count muted', '')).id = 'ch-count';
    foot.appendChild(el('span', 'ch-spacer'));
    const clr = el('button', 'btn small', 'Clear history'); clr.id = 'ch-clear';
    clr.title = 'Move this project’s chat history aside. The file is kept as a .bak next to it.';
    foot.appendChild(clr);
    sec.appendChild(foot);

    app.insertBefore(sec, body);

    cb.onchange = () => patch({ enabled: cb.checked });
    hide.onclick = () => setOpen(false);
    clr.onclick = () => onClear();
    document.addEventListener('click', (e) => { if (C.menu && !C.menu.contains(e.target)) closeMenu(); }, true);
  }

  function setOpen(v) {
    ensurePanel();
    C.open = !!v;
    const sec = $('#chat'); if (sec) sec.hidden = !C.open;
    const app = $('#app'); if (app) app.classList.toggle('chat-open', C.open);
    const btn = $('#btn-chat'); if (btn) btn.classList.toggle('active', C.open);
    if (C.projectKey) prefSet(C.projectKey, C.open);
    if (!C.open) { closeMenu(); C.clearArmed = false; }
    if (C.open) load();          // load() reconciles `visible` once it knows what the store says
    else syncVisible();
    draw();
  }
  /** `chat.visible` is what the scheduler reads, so the panel's own open state owns it: hiding the
      panel stops the agents for this project, showing it starts them again. */
  function syncVisible() {
    if (!C.project || !C.settings || C.fixture || C.busy) return;
    if (!!C.settings.visible === C.open) return;
    patch({ visible: C.open });
  }
  function toggle() { setOpen(!C.open); }

  // ───────── data
  async function load() {
    if (!C.project || !hasBackend()) return;
    try {
      const r = await window.mc.chatGet(C.project.path);
      if (!r || r.error) { C.note = r && r.error ? 'chat unavailable: ' + r.error : ''; draw(); return; }
      apply(r);
    } catch (e) { C.note = String((e && e.message) || e); draw(); }
  }
  function apply(r) {
    C.settings = r.settings || null; C.roster = r.roster || []; C.messages = r.messages || [];
    C.caps = r.caps || { agent: {}, today: 0 }; C.fixture = !!r.fixture;
    const cb = $('#ch-enable'); if (cb && C.settings) cb.checked = !!C.settings.enabled;
    syncVisible();
    draw();
  }
  async function patch(p) {
    if (!C.project || !hasBackend() || C.busy) return;
    C.busy = true;
    try { const r = await window.mc.chatSet(C.project.path, p); if (r && !r.error) apply(r); }
    catch (e) { C.note = String((e && e.message) || e); }
    finally { C.busy = false; draw(); }
  }

  /** app.js calls this on every snapshot and on project selection. */
  function render(project) {
    ensurePanel();
    const key = project ? project.key : null;
    C.project = project || null;
    if (key === C.projectKey) return;
    C.projectKey = key;
    C.settings = null; C.roster = []; C.messages = []; C.caps = { agent: {}, today: 0 }; C.clearArmed = false; C.note = '';
    setOpen(key ? prefGet(key) && !!(project && project.path) : false);
    // even with the panel closed, one read reconciles `visible`: a project left visible in the settings
    // file by an earlier run must not keep its agents talking into a panel nobody is looking at.
    if (!C.open && C.project && C.project.path) load();
  }

  // ───────── drawing
  function drawRoster() {
    const box = $('#ch-roster'); if (!box) return;
    box.innerHTML = '';
    for (const r of C.roster) {
      const chip = el('div', 'ch-chip' + (r.muted ? ' muted-agent' : '') + (r.ready ? '' : ' notready'));
      const av = el('img', 'ch-chip-av'); av.src = avatarFor(r); av.alt = r.name; chip.appendChild(av);
      chip.appendChild(el('span', 'ch-chip-name', r.name));
      // a tool the owner switched off in AI Collaboration stays in the roster and says so, and never speaks
      const off = !r.ready && /AI Collaboration/i.test(r.reason || '');
      if (off) chip.appendChild(el('span', 'ch-chip-tag', 'disabled'));
      else if (r.muted) chip.appendChild(el('span', 'ch-chip-tag', 'muted'));
      else if (r.resting) chip.appendChild(el('span', 'ch-chip-tag', 'resting'));
      else if (!r.ready) chip.appendChild(el('span', 'ch-chip-tag', 'not ready'));
      chip.title = `${r.name} — ${r.specialty}\n${r.count} message${r.count === 1 ? '' : 's'} this hour`
        + (r.ready ? '' : `\nSilent: ${r.reason}.${off ? ' Switch it back on in AI Collaboration to let it talk again.' : ''}`)
        + '\nClick for mute and remove.';
      chip.onclick = (ev) => {
        ev.stopPropagation();
        const b = chip.getBoundingClientRect();
        openMenu(b.left, b.bottom + 4, [
          [(r.muted ? '🔈 unmute ' : '🔇 mute ') + r.name, () => patch({ muted: r.muted ? C.settings.muted.filter((x) => x !== r.id) : [...C.settings.muted, r.id] })],
          ['✕ remove ' + r.name + ' from the chat', () => patch({ remove: r.id })],
        ]);
      };
      box.appendChild(chip);
    }
    const add = el('button', 'ch-add', '+ add');
    add.title = 'Add an AI tool to this chat. Only tools with a non-interactive command can join.';
    add.onclick = async (ev) => {
      ev.stopPropagation();
      const b = add.getBoundingClientRect();
      let c = { agents: [], ollama: [] };
      try { c = (await window.mc.chatCandidates(C.project.path)) || c; } catch { /* offer nothing */ }
      const items = c.agents.map((a) => [`${a.name} · ${a.label}${a.ready ? '' : ' (not installed)'}`, () => addAgent(a, c.ollama)]);
      openMenu(b.left, b.bottom + 4, items.length ? items : [['nobody left to add — switch more tools on in AI Collaboration', () => { }]]);
    };
    box.appendChild(add);
  }
  /** Ollama is the one tool with no default model: the panel asks before it may ever run. */
  function addAgent(a, models) {
    if (a.id !== 'ollama') { patch({ add: a.id }); return; }
    if (!models || !models.length) { C.note = 'Ollama has no models pulled yet (ollama pull llama3.2), so it cannot join.'; draw(); return; }
    const b = $('#ch-roster').getBoundingClientRect();
    openMenu(b.left, b.bottom + 4, models.map((m) => ['use model ' + m, () => patch({ add: 'ollama', model: { ollama: m } })]));
  }

  function drawMessages() {
    const box = $('#ch-body'); if (!box) return;
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    box.innerHTML = '';
    if (!C.project) { box.appendChild(el('div', 'ch-msg-empty', 'Pick a project to see its team chat.')); return; }
    if (C.settings && !C.settings.enabled && !C.fixture) {
      box.appendChild(el('div', 'ch-msg-empty', 'The chat is off for this project. Switch it on above, then add a colleague or two with "+ add". They talk every few minutes while the panel is open, and stop the moment you hide it.'));
      return;
    }
    if (!C.messages.length) {
      box.appendChild(el('div', 'ch-msg-empty', C.roster.length
        ? 'Nobody has said anything yet. The first round runs within a few minutes.'
        : 'No colleagues yet. Use "+ add" above to invite an AI tool into the chat.'));
      return;
    }
    let lastDay = null;
    for (const m of C.messages) {
      const day = dayOf(m.ts);
      if (day && day !== lastDay) { lastDay = day; box.appendChild(el('div', 'ch-day', day === new Date().toDateString() ? 'Today' : day)); }
      box.appendChild(m.kind === 'system' ? systemRow(m) : messageRow(m));
    }
    if (stick) box.scrollTop = box.scrollHeight;
  }
  function systemRow(m) { const d = el('div', 'ch-system'); d.appendChild(el('span', null, m.text)); d.appendChild(el('span', 'ch-time', clock(m.ts))); return d; }
  function messageRow(m) {
    const row = el('div', 'ch-msg' + (m.kind === 'suggestion' ? ' suggestion' : '') + (m.kind === 'joke' ? ' joke' : ''));
    const av = el('img', 'ch-av'); av.src = avatarFor({ id: m.agent, name: m.name, seed: 'chat:' + m.agent }); av.alt = m.name || m.agent;
    row.appendChild(av);
    const rest = el('div', 'ch-msg-main');
    const h = el('div', 'ch-msg-head');
    h.appendChild(el('span', 'ch-who', m.name || m.agent));
    h.appendChild(el('span', 'ch-time', clock(m.ts)));
    if (m.kind === 'joke') h.appendChild(el('span', 'ch-kind joke', 'joke'));
    if (m.kind === 'suggestion') h.appendChild(el('span', 'ch-kind sugg', 'suggestion'));
    rest.appendChild(h);
    rest.appendChild(el('div', 'ch-text', m.text));
    if (m.kind === 'suggestion') {
      const act = el('div', 'ch-actions');
      const b = el('button', 'btn small' + (m.forwarded ? '' : ' primary'), m.forwarded ? 'Sent to lead ✓' : 'Send to lead');
      b.title = m.forwarded
        ? 'Already pasted into the lead’s composer at ' + clock(m.forwarded)
        : 'Paste this into the lead’s composer. Nothing is sent: you still press Send there.';
      b.onclick = () => sendToLead(m, b);
      act.appendChild(b);
      rest.appendChild(act);
    }
    row.appendChild(rest);
    return row;
  }
  function drawFoot() {
    const c = $('#ch-count'); if (!c) return;
    const cap = C.settings ? C.settings.capPerProjectPerDay : 0;
    const today = (C.caps && C.caps.today) || 0;
    c.textContent = C.settings ? `${today} of ${cap} messages today · ${C.roster.length} in the chat` : '';
    const perAgent = C.settings ? C.settings.capPerAgentPerHour : '?';
    const claudeCap = C.settings && C.settings.capPerAgent ? C.settings.capPerAgent.claude : null;
    c.title = `Hard caps keep the chat cheap: at most ${perAgent} messages per colleague per hour`
      + (claudeCap && claudeCap !== perAgent ? ` (${claudeCap} for Claude, which spends your Claude plan)` : '')
      + ` and ${cap} per project per day.`;
    const btn = $('#ch-clear');
    if (btn) { btn.textContent = C.clearArmed ? 'Really clear?' : 'Clear history'; btn.classList.toggle('danger', C.clearArmed); }
    const note = $('#ch-note');
    if (note) { note.textContent = C.note; note.hidden = !C.note; }
  }
  function draw() {
    if (!$('#chat') || !C.open) return;
    const cb = $('#ch-enable'); if (cb) cb.checked = !!(C.settings && C.settings.enabled);
    drawRoster(); drawMessages(); drawFoot();
  }

  // ───────── actions
  function sendToLead(m, btn) {
    const line = `From the team chat (${m.name || m.agent}, ${clock(m.ts)}): ${m.text}`;
    const ok = window.MC && window.MC.pasteToLead ? window.MC.pasteToLead(line) : false;
    if (!ok) { C.note = 'No lead composer to paste into: start the lead session on the Orchestrator tab first.'; drawFoot(); return; }
    C.note = '';
    btn.textContent = 'Sent to lead ✓'; btn.classList.remove('primary');
    m.forwarded = new Date().toISOString();
    try { window.mc.chatForwarded(C.project.path, m.id); } catch { /* the paste already happened */ }
    drawFoot();
  }
  /** Two steps, no confirm(): the first click arms the button, the second one moves the file aside. */
  async function onClear() {
    if (!C.project || !hasBackend()) return;
    if (!C.clearArmed) { C.clearArmed = true; drawFoot(); setTimeout(() => { if (C.clearArmed) { C.clearArmed = false; drawFoot(); } }, 4000); return; }
    C.clearArmed = false;
    try { const r = await window.mc.chatClear(C.project.path); C.note = r && r.ok ? 'History moved aside; the old file is kept as .bak.' : 'Could not clear the history.'; }
    catch (e) { C.note = String((e && e.message) || e); }
    C.messages = [];
    await load();
  }

  // ───────── the little menu (the Explorer's, kept local so neither file owns the other)
  function closeMenu() { if (C.menu) { C.menu.remove(); C.menu = null; } }
  function openMenu(x, y, items) {
    closeMenu();
    const m = el('div', 'ex-menu');
    for (const [label, fn] of items) { const it = el('div', 'ex-mi', label); it.onclick = () => { closeMenu(); fn(); }; m.appendChild(it); }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
    m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
    C.menu = m;
  }

  // ───────── pushed messages
  if (window.mc && window.mc.onChat) {
    window.mc.onChat((payload) => {
      if (!payload || !C.project || !C.open) return;
      const same = String(payload.project || '').replace(/[\\/]+$/, '').toLowerCase() === String(C.project.path || '').replace(/[\\/]+$/, '').toLowerCase();
      if (!same) return;
      if (payload.message) {
        if (C.messages.some((m) => m.id === payload.message.id)) return;
        C.messages.push(payload.message);
        if (payload.message.kind !== 'system') { C.caps.today = (C.caps.today || 0) + 1; C.caps.agent[payload.message.agent] = (C.caps.agent[payload.message.agent] || 0) + 1; }
        draw();
      } else load();
    });
  }

  // ───────── header button (self-wired, like the Explorer's)
  const btn = $('#btn-chat');
  if (btn) btn.onclick = () => toggle();

  window.Chat = {
    render,
    toggle,
    /** `--view chat` opens the panel; with MC_CHAT_FIXTURE set, main.js serves a fixture chat to it. */
    openFromStartView() { ensurePanel(); setOpen(true); load(); },
    state: C,
  };
})();

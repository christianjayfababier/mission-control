'use strict';
/*
 chat — the team chat (docs/TEAM-CHAT-CONTRACT.md, T-027).

 A hideable side panel where the project's AI agents talk to each other about the project like
 colleagues. Read-only by construction: an agent is handed a briefing on stdin, answers one JSON line,
 and that line is stored and drawn. Nothing it says reaches the lead unless the human clicks
 "Send to lead", which only pastes into the composer. No tools, no board writes, no repo access.

 Four pure pieces the unit tests drive directly — buildBriefing, parseReply, nextAgent, shouldRound —
 plus ChatStore (jsonl per project) and ChatService (the 30 s scheduler and the run step). Nothing here
 throws across IPC; a tool that is missing, slow or chatty comes back as "no message this round".

 Cost: free tiers first. Claude in the chat is a colleague persona, never the lead, and it runs with the
 cheapest model — the chat keeps its own exec template for that (CHAT_EXEC below) and never touches the
 registry's. Caps per agent per hour and per project per day are counted from the store itself.
*/
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const providers = require('./providers');

// ── shapes ───────────────────────────────────────────────────────────────────────────────────────
const safeKey = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
const KEEP_DAYS = 30;
const MAX_TEXT = 400;             // a chat line, not an essay (contract)
const BRIEF_BUDGET = 2500;
const ROUND_MIN = 3 * 60 * 1000, ROUND_MAX = 5 * 60 * 1000;
const EVENT_COALESCE_MS = 2 * 60 * 1000;
const TICK_MS = 30 * 1000;
const RUN_TIMEOUT_MS = 60 * 1000;
const KINDS = ['chat', 'suggestion', 'joke', 'system'];

// Claude in the chat spends the owner's Claude plan, which is the one budget the chat cannot make free.
// The contract's principle 4 gives it "the smallest model and the lowest cap", so it gets its own, lower
// hourly cap; every other agent uses capPerAgentPerHour. One entry per provider that needs an exception.
const CAP_PER_AGENT = { claude: 4 };
/** The per-project settings block, as it is stored under `chat` in project-settings.json. */
const DEFAULTS = () => ({
  enabled: false, visible: false, roster: [], muted: [],
  capPerAgentPerHour: 6, capPerAgent: { ...CAP_PER_AGENT }, capPerProjectPerDay: 80,
  model: { claude: 'haiku', ollama: null },
});
/** Fold a stored (or half-written, or renderer-sent) block onto the defaults. Never throws. */
function normalizeSettings(raw) {
  const d = DEFAULTS(); const s = raw && typeof raw === 'object' ? raw : {};
  const ids = (v) => (Array.isArray(v) ? [...new Set(v.map(String).filter((x) => !!providers.byId(x)))] : []);
  const num = (v, dflt, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt; };
  return {
    enabled: !!s.enabled, visible: !!s.visible,
    roster: ids(s.roster), muted: ids(s.muted),
    capPerAgentPerHour: num(s.capPerAgentPerHour, d.capPerAgentPerHour, 1, 60),
    capPerAgent: (() => {
      const src = s.capPerAgent && typeof s.capPerAgent === 'object' ? s.capPerAgent : d.capPerAgent;
      const out = {};
      for (const [id, v] of Object.entries(src)) if (providers.byId(id)) out[id] = num(v, d.capPerAgent[id] || d.capPerAgentPerHour, 1, 60);
      return out;
    })(),
    capPerProjectPerDay: num(s.capPerProjectPerDay, d.capPerProjectPerDay, 1, 1000),
    model: {
      claude: String((s.model && s.model.claude) || d.model.claude).slice(0, 40),
      ollama: s.model && s.model.ollama ? String(s.model.ollama).slice(0, 80) : null,
    },
  };
}

// ── personas ─────────────────────────────────────────────────────────────────────────────────────
// The name list and the hash are the ones in renderer/persona.js, so the chip in the panel and the
// name stored in a message are the same word. The renderer draws the avatar with Persona.avatar()
// from the same seed ('chat:<providerId>'); only the name is decided here, where a message is written.
const NAMES = ['Atlas', 'Nova', 'Orion', 'Vega', 'Juno', 'Sage', 'Ember', 'Kai', 'Lyra', 'Rowan', 'Iris', 'Felix', 'Mira', 'Theo', 'Zara', 'Idris', 'Nia', 'Cyrus', 'Wren', 'Milo',
  'Astra', 'Bodhi', 'Cleo', 'Dax', 'Elara', 'Finn', 'Gaia', 'Hugo', 'Indra', 'Jett', 'Kira', 'Leo', 'Maya', 'Nico', 'Onyx', 'Pax', 'Quinn', 'Remy', 'Sol', 'Tova',
  'Uma', 'Vale', 'Wade', 'Xena', 'Yara', 'Zed', 'Aria', 'Blaise', 'Cass', 'Dune', 'Echo', 'Faye', 'Gus', 'Hale', 'Ines', 'Jules', 'Kato', 'Lux', 'Moss', 'Nell',
  'Oda', 'Pilar', 'Rune', 'Skye', 'Tarek', 'Ursa', 'Vito', 'Willa', 'Yves', 'Zia'];
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
const seedOf = (id) => 'chat:' + id;
const personaName = (id) => NAMES[hash(seedOf(id)) % NAMES.length];
/** "Gemini, research and docs" — the vendor's name plus what the tool is good at, as the persona's job. */
const SPECIALTY = {
  claude: 'reading code and weighing trade-offs', codex: 'refactors and test scaffolding',
  gemini: 'research and docs', copilot: 'GitHub habits and review etiquette',
  cursor: 'editor workflows and quick edits', cline: 'step-by-step task breakdowns',
  opencode: 'terminal workflows', aider: 'small, surgical patches',
  ollama: 'a local model, private and cheap', goose: 'local automation',
};
function persona(id) {
  const p = providers.byId(id);
  const vendor = p ? p.name : id;
  return { id, seed: seedOf(id), name: personaName(id), specialty: `${vendor}, ${SPECIALTY[id] || 'general help'}` };
}

// ── redaction (pure) ─────────────────────────────────────────────────────────────────────────────
// Nothing key-shaped ever reaches a briefing or a stored message, whichever side it came from.
const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,            // OpenAI / Anthropic style
  /\bghp_[A-Za-z0-9]{8,}/g,             // GitHub personal token
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bAIza[A-Za-z0-9_-]{10,}/g,          // Google
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,     // Slack
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,      // a long base64 run is a secret until proven otherwise
];
/** Replace anything key-shaped with [redacted]. Used on every string that goes in or comes out. */
function redact(s) {
  let out = String(s == null ? '' : s);
  for (const re of KEY_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}
const looksSecret = (s) => KEY_PATTERNS.some((re) => { re.lastIndex = 0; return re.test(String(s || '')); });
const one = (s, n) => { const t = redact(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// ── the briefing (pure) ──────────────────────────────────────────────────────────────────────────
const HOUSE_RULES = [
  'You are chatting with colleagues in a small side panel while the work goes on. The human reads along.',
  'Say one short thing: a thought, a question to a colleague, a friendly greeting, a small joke, or a suggestion worth trying.',
  'Never claim you did any work. You have no tools here and you change nothing.',
  'Never invent facts about the project beyond this briefing. "I don\'t know" is a fine thing to say.',
  'Never give orders and never address the lead session. Disagree politely if you disagree.',
  'Sound like a person: plain words, no bullet lists, no headings, no markdown.',
];
/**
 * The whole prompt one agent gets, as plain text. Pure: everything it needs is in `input`, everything
 * it emits is redacted, and it is trimmed to `budget` from the least important section first.
 *
 * input = { persona:{name,specialty}, project, goal, tickets:[titles], todos:[texts], journal:[lines],
 *           messages:[ChatMessage], event:string|null, roster:[{name,specialty}], budget }
 */
function buildBriefing(input = {}) {
  const i = input || {};
  const me = i.persona || { name: 'Someone', specialty: 'an AI colleague' };
  const budget = Number(i.budget) > 0 ? Number(i.budget) : BRIEF_BUDGET;
  const head = [
    `You are ${me.name} (${me.specialty}), one of the AI colleagues watching the project "${one(i.project || 'this project', 80)}".`,
    '',
    ...HOUSE_RULES.map((r) => '- ' + r),
    '',
    'Answer with ONE line of JSON and nothing else:',
    '{"kind":"chat|suggestion|joke","text":"..."}  — 60 words at most.',
    'Use "suggestion" only when you have something concrete the human could hand to the lead.',
    'If there is nothing worth saying right now, answer {"kind":"skip"}.',
    '',
  ];
  // sections, least important last: they are the ones dropped when the budget is tight
  const sections = [];
  if (i.roster && i.roster.length) sections.push(['In the chat', i.roster.map((r) => `- ${r.name} (${r.specialty})`)]);
  if (i.goal) sections.push(['Goal of the project', [one(i.goal, 600)]]);
  if (i.event) sections.push(['Just happened', ['- ' + one(i.event, 220)]]);
  if (i.tickets && i.tickets.length) sections.push(['Open tickets', i.tickets.slice(0, 12).map((t) => '- ' + one(t, 120))]);
  if (i.todos && i.todos.length) sections.push(['Open todos', i.todos.slice(0, 12).map((t) => '- ' + one(t, 120))]);
  if (i.journal && i.journal.length) sections.push(['Recent history', i.journal.slice(-8).map((l) => '- ' + one(l, 160))]);
  const msgs = (i.messages || []).slice(-12);
  if (msgs.length) sections.push(['The last things said in the chat', msgs.map((m) => `- ${one(m.name || m.agent, 24)}: ${one(m.text, 200)}`)]);
  else sections.push(['The chat', ['- It is empty. You may open it with a short hello.']]);

  const render = (secs) => head.join('\n') + secs.map(([t, lines]) => `## ${t}\n${lines.join('\n')}\n`).join('\n');
  const CHAT_SECTION = 'The last things said in the chat';
  let secs = sections.slice();
  let out = render(secs);
  // Over budget, in this order: the project's history goes first, then its lists. The goal, the roster,
  // the event and the conversation itself are what the agent actually needs to sound like a colleague,
  // so the chat is shortened rather than dropped, and only then is the whole thing clipped.
  for (const name of ['Recent history', 'Open todos', 'Open tickets']) {
    if (out.length <= budget) break;
    secs = secs.filter(([t]) => t !== name);
    out = render(secs);
  }
  while (out.length > budget) {
    const chatSec = secs.find(([t]) => t === CHAT_SECTION);
    if (!chatSec || chatSec[1].length <= 3) break;
    chatSec[1] = chatSec[1].slice(Math.ceil(chatSec[1].length / 2));
    out = render(secs);
  }
  return out.length > budget ? out.slice(0, budget) : out;
}

// ── parsing a reply (pure) ───────────────────────────────────────────────────────────────────────
/** The first syntactically complete JSON object in `s`, or null. Quote- and escape-aware. */
function firstJson(s) {
  const str = String(s || '');
  for (let start = str.indexOf('{'); start >= 0; start = str.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < str.length; i++) {
      const c = str[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { if (inStr) esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (!depth) { try { return JSON.parse(str.slice(start, i + 1)); } catch { break; } } }
    }
  }
  return null;
}
/**
 * What an agent actually said, or null when the round produced nothing usable.
 * JSON first; otherwise the first non-empty line as a plain `chat`. A "skip", an empty text, anything
 * over MAX_TEXT and anything key-shaped is dropped — a chat line is never worth a leaked secret.
 */
function parseReply(stdout, { maxChars = MAX_TEXT } = {}) {
  const raw = String(stdout == null ? '' : stdout);
  const j = firstJson(raw);
  let kind = null, text = null;
  if (j && typeof j === 'object') {
    kind = String(j.kind || 'chat').toLowerCase().trim();
    if (kind === 'skip' || j.skip === true) return null;
    text = j.text == null ? '' : String(j.text);
  } else {
    const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^```/.test(l));
    if (!line) return null;
    if (/^\{?"?skip"?\}?$/i.test(line)) return null;
    kind = 'chat'; text = line;
  }
  if (!KINDS.includes(kind) || kind === 'system') kind = 'chat';
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > maxChars) return null;
  if (looksSecret(text)) return null;
  return { kind, text };
}

// ── who speaks next (pure) ───────────────────────────────────────────────────────────────────────
/**
 * Round-robin over the roster, skipping muted, capped and not-ready agents. Null when nobody may speak.
 * state = { roster, muted, ready:{id:bool}, perAgent:{id:countThisHour}, today:count,
 *           capPerAgentPerHour, capPerProjectPerDay, last:lastAgentId }
 */
function nextAgent(state = {}) {
  const roster = Array.isArray(state.roster) ? state.roster : [];
  if (!roster.length) return null;
  const capDay = Number(state.capPerProjectPerDay) || 0;
  if (capDay && Number(state.today || 0) >= capDay) return null;
  const muted = new Set(Array.isArray(state.muted) ? state.muted : []);
  const ready = state.ready || {};
  const per = state.perAgent || {};
  const cap = capFor(state.capPerAgentPerHour, state.capPerAgent);
  const start = Math.max(0, roster.indexOf(state.last) + 1);   // -1 (nobody yet) → 0
  for (let n = 0; n < roster.length; n++) {
    const id = roster[(start + n) % roster.length];
    if (muted.has(id)) continue;
    if (ready[id] === false) continue;                          // unknown readiness is not a refusal
    const c = cap(id);
    if (c && Number(per[id] || 0) >= c) continue;
    return id;
  }
  return null;
}
/** This agent's hourly cap: its own override (Claude's 4) if it has one, else the general one. */
function capFor(capPerAgentPerHour, capPerAgent) {
  const general = Number(capPerAgentPerHour) || 0;
  const over = capPerAgent && typeof capPerAgent === 'object' ? capPerAgent : {};
  return (id) => (Number(over[id]) > 0 ? Number(over[id]) : general);
}
/** Agents that are over their own hourly cap right now — the panel draws them as "resting". */
function restingAgents(perAgent = {}, capPerAgentPerHour = 0, capPerAgent = null) {
  const cap = capFor(capPerAgentPerHour, capPerAgent);
  return Object.keys(perAgent).filter((id) => { const c = cap(id); return c && Number(perAgent[id] || 0) >= c; });
}

// ── when a round may run (pure) ──────────────────────────────────────────────────────────────────
/**
 * state = { enabled, visible, hasWindow, now, lastRoundAt, interval, pendingEvent, lastEventRoundAt, force }
 * → { run, reason }. `reason` is the log line either way, so a skip is always explainable.
 */
function shouldRound(state = {}) {
  const now = Number(state.now) || Date.now();
  if (!state.enabled) return { run: false, reason: 'chat is off for this project' };
  if (!state.visible) return { run: false, reason: 'panel is hidden' };
  if (state.hasWindow === false) return { run: false, reason: 'no window' };
  const sinceEvent = now - (Number(state.lastEventRoundAt) || 0);
  if (state.pendingEvent) {
    if (sinceEvent >= EVENT_COALESCE_MS) return { run: true, reason: 'event' };
    if (!state.force) return { run: false, reason: 'event coalesced (one event round every 2 min)' };
  }
  const interval = state.force ? 0 : (Number(state.interval) > 0 ? Number(state.interval) : ROUND_MIN);
  const since = now - (Number(state.lastRoundAt) || 0);
  if (since >= interval) return { run: true, reason: state.pendingEvent ? 'event' : 'interval' };
  return { run: false, reason: `next round in ${Math.round((interval - since) / 1000)}s` };
}
/** A fresh jittered gap between two idle rounds: 3 to 5 minutes. */
const jitter = (rnd = Math.random) => ROUND_MIN + Math.floor(rnd() * (ROUND_MAX - ROUND_MIN));

// ── the store ────────────────────────────────────────────────────────────────────────────────────
/**
 * One append-only jsonl per project under DATA_DIR/chat, the same conventions as boards.js: safeKey for
 * the filename, a missing file is an empty chat, a half-written line is skipped rather than fatal.
 */
class ChatStore {
  constructor(dir) { this.dir = dir; }
  file(p) { return path.join(this.dir, safeKey(p) + '.jsonl'); }
  read(p) {
    let text = ''; try { text = fs.readFileSync(this.file(p), 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (m && m.id && m.ts) out.push(m); } catch { /* half-written line */ }
    }
    return out;
  }
  append(p, msg) {
    const m = {
      id: msg.id || 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      ts: msg.ts || new Date().toISOString(), project: String(p),
      agent: String(msg.agent || ''), name: String(msg.name || ''),
      kind: KINDS.includes(msg.kind) ? msg.kind : 'chat',
      text: one(msg.text, MAX_TEXT),
    };
    if (msg.reply_to) m.reply_to = String(msg.reply_to);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file(p), JSON.stringify(m) + '\n');
    return m;
  }
  /** Rewrite the file without anything older than `days`. Returns how many lines went. */
  prune(p, days = KEEP_DAYS, now = Date.now()) {
    const all = this.read(p);
    if (!all.length) return 0;
    const cutoff = now - days * 24 * 3600 * 1000;
    const keep = all.filter((m) => (Date.parse(m.ts) || 0) >= cutoff);
    if (keep.length === all.length) return 0;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(p), keep.map((m) => JSON.stringify(m)).join('\n') + (keep.length ? '\n' : ''));
    return all.length - keep.length;
  }
  /** Mark one message forwarded to the lead. The file is small (capped per day), so it is rewritten. */
  forwarded(p, id, ts = new Date().toISOString()) {
    const all = this.read(p);
    const hit = all.find((m) => m.id === id);
    if (!hit) return null;
    hit.forwarded = ts;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(p), all.map((m) => JSON.stringify(m)).join('\n') + '\n');
    return hit;
  }
  /** "Clear history": the file is moved aside, never deleted, so a mis-click is recoverable. */
  clear(p) {
    const f = this.file(p);
    if (!fs.existsSync(f)) return { ok: true, moved: null };
    const bak = f + '.bak';
    try { fs.rmSync(bak, { force: true }); } catch { /* replaced below anyway */ }
    try { fs.renameSync(f, bak); return { ok: true, moved: bak }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  /** { agent: {id: countInTheLastHour}, today: countSinceLocalMidnight } — the caps are counted, not stored. */
  counts(p, now = Date.now()) {
    const all = this.read(p);
    const hourAgo = now - 3600 * 1000;
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const agent = {}; let today = 0;
    for (const m of all) {
      if (m.kind === 'system') continue;                 // "X joined the chat" is not an agent's turn
      const t = Date.parse(m.ts) || 0;
      if (t >= hourAgo) agent[m.agent] = (agent[m.agent] || 0) + 1;
      if (t >= midnight.getTime()) today++;
    }
    return { agent, today };
  }
}

// ── running one agent ────────────────────────────────────────────────────────────────────────────
// The chat's own exec templates. The registry's `exec` is what the owner's terminals use and is never
// changed from here; the chat needs the cheapest form of each tool, so it keeps its own line where the
// two differ. Claude is the only one today: in the chat it is a colleague, not the lead, and it runs
// with the smallest model the owner's plan has.
const CHAT_EXEC = { claude: 'claude -p --model {model} "{prompt}"' };
/** Tools that take the prompt on stdin; everything else gets it as the {prompt} argument. */
const STDIN_TOOLS = new Set(['claude', 'codex', 'gemini']);

/** Split a command template into argv, honouring double quotes. Pure. */
function tokenize(line) {
  const out = []; let cur = ''; let q = false, has = false;
  for (const c of String(line || '')) {
    if (c === '"') { q = !q; has = true; continue; }
    if (!q && /\s/.test(c)) { if (has || cur) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}
/**
 * How this agent is run for the chat: { bin, args, stdin }. Pure apart from the binary lookup, which is
 * handed in as `resolve` so the tests can drive it. Null (with `error`) when the tool cannot run.
 */
function execPlan(id, { settings = DEFAULTS(), resolve = providers.which } = {}) {
  const p = providers.byId(id);
  if (!p) return { error: 'unknown provider: ' + id };
  const template = CHAT_EXEC[id] || p.exec;
  if (!template) return { error: p.name + ' has no non-interactive command in the registry' };
  const model = id === 'ollama' ? (settings.model && settings.model.ollama) : (settings.model && settings.model.claude) || 'haiku';
  if (id === 'ollama' && !model) return { error: 'pick an Ollama model in the panel first' };
  const tokens = tokenize(template.split('{model}').join(String(model || '')));
  const bin = resolve(tokens[0]) || (id === 'codex' ? providers.codexFromChatGptApp() : null);
  if (!bin) return { error: p.name + ' is not installed' };
  const stdin = STDIN_TOOLS.has(id);
  const args = tokens.slice(1).filter((t) => !(stdin && t.includes('{prompt}')));
  return { bin, args, stdin, template };
}
/**
 * execFile the resolved binary, prompt on stdin or as the last argument. Never rejects: a missing tool,
 * a timeout or a crash comes back as { ok:false }. A .cmd/.bat shim goes through cmd.exe, as in
 * providers.run — CreateProcess cannot start one.
 */
function runTool(plan, prompt, { env = process.env, timeout = RUN_TIMEOUT_MS, cwd } = {}) {
  return new Promise((resolve) => {
    let file = plan.bin;
    let args = plan.stdin ? plan.args.slice() : plan.args.map((a) => a.split('{prompt}').join(prompt));
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(file))) {
      const q = (s) => (/[\s"&|<>^]/.test(String(s)) ? '"' + String(s).replace(/"/g, '\\"') + '"' : String(s));
      args = ['/d', '/s', '/c', [q(file), ...args.map(q)].join(' ')];
      file = process.env.ComSpec || 'cmd.exe';
    }
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      const child = execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4e6, cwd, env },
        (err, stdout, stderr) => finish({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? String(err.message || err).slice(0, 200) : null }));
      if (plan.stdin && child.stdin) { child.stdin.on('error', () => { /* the tool closed it; the callback reports */ }); child.stdin.end(prompt); }
    } catch (e) { finish({ ok: false, stdout: '', stderr: '', error: String((e && e.message) || e).slice(0, 200) }); }
  });
}
/** Strip the variables that make a nested Claude refuse to start, whatever else the environment holds. */
function chatEnv(base) { const e = { ...(base || {}) }; delete e.CLAUDECODE; delete e.CLAUDE_CODE_ENTRYPOINT; return e; }

// ── project context (small readers, each one failure-tolerant) ───────────────────────────────────
/** The Goal paragraph of the project's docs/PLAN.md, if it has one. */
function readGoal(projectPath) {
  try {
    const text = fs.readFileSync(path.join(projectPath, 'docs', 'PLAN.md'), 'utf8');
    const at = text.search(/^#{1,6}\s+Goal\s*$/mi);
    if (at < 0) return null;
    const out = [];
    for (const line of text.slice(at).split(/\r?\n/).slice(1)) { if (/^#{1,6}\s/.test(line)) break; out.push(line); }
    return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 600) || null;
  } catch { return null; }
}
/** The last `n` journal lines from the project's memory dir (checkpoint.js writes "- HH:MM:SS text"). */
function readJournalTail(memDir, n = 8) {
  try {
    const text = fs.readFileSync(path.join(memDir, 'mission-control-journal.md'), 'utf8');
    return text.split(/\r?\n/).filter((l) => /^- \d{2}:\d{2}:\d{2}\s/.test(l)).slice(-n).map((l) => l.replace(/^- /, ''));
  } catch { return []; }
}
/** `ollama list` → model names, newest first. Pure parser; the panel offers them in a menu. */
function parseOllamaList(out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const names = [];
  for (const l of lines) {
    if (/^NAME\b/i.test(l)) continue;
    const m = /^(\S+)/.exec(l);
    if (m && m[1] && !/^error/i.test(m[1])) names.push(m[1]);
  }
  return [...new Set(names)];
}
/** A fixture chat for `--view chat` (MC_CHAT_FIXTURE): a jsonl file rendered instead of the store. */
function fixture(file) {
  const msgs = [];
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of text.split(/\r?\n/)) { if (!line.trim()) continue; try { const m = JSON.parse(line); if (m && m.id) msgs.push(m); } catch { /* skip */ } }
  return msgs;
}

// ── the service ──────────────────────────────────────────────────────────────────────────────────
/**
 * The scheduler and the run step. Everything it needs from main.js arrives as a callback, so this file
 * never reaches into the registry, the secrets or the window:
 *   getSettings(p) / setSettings(p, chat)  — the `chat` block in project-settings.json
 *   listProjects()                          — every project the settings file knows
 *   boardOf(p)                              — { tickets, todos } for the briefing
 *   memDirOf(p)                             — the project's memory dir, for the journal tail
 *   readyOf(id)                             — true | false | null (unknown), from the provider probes
 *   isEnabled(p, id)                        — is this provider switched on for the project in AI Collaboration
 *   envOf(p)                                — the assembled environment for this project
 *   send(payload)                           — push the `chat` event to the renderer
 *   hasWindow()                             — is there a window to push to
 */
class ChatService {
  constructor(opts = {}) {
    this.store = new ChatStore(opts.dir);
    this.o = opts;
    this.timer = null;
    this.rounds = new Map();   // project key -> { lastRoundAt, interval, pendingEvent, lastEventRoundAt, last, busy }
    this.force = !!process.env.MC_CHAT_ROUND_NOW;   // the proof harness: fire on the next tick, log every verdict
    this.log = opts.log || ((m) => console.log(m));
  }
  // ── settings
  get(p) { return normalizeSettings((this.o.getSettings ? this.o.getSettings(p) : null)); }
  set(p, patch) {
    const cur = this.get(p);
    const next = normalizeSettings({ ...cur, ...(patch || {}), model: { ...cur.model, ...((patch && patch.model) || {}) } });
    if (this.o.setSettings) this.o.setSettings(p, next);
    const r = this.round(p);
    if (!next.enabled || !next.visible) { r.pendingEvent = null; }
    else if (!cur.visible) { r.lastRoundAt = 0; r.interval = jitter(); }   // shown again: the chat picks straight back up
    return next;
  }
  round(p) {
    const k = safeKey(p);
    if (!this.rounds.has(k)) this.rounds.set(k, { lastRoundAt: 0, interval: jitter(), pendingEvent: null, lastEventRoundAt: 0, last: null, busy: false });
    return this.rounds.get(k);
  }
  /** Something happened in the project worth a round: a ticket, a PR, a finished worker, a note. */
  event(p, text) {
    if (!p || !text) return;
    const s = this.get(p);
    if (!s.enabled || !s.visible) return;
    const r = this.round(p);
    r.pendingEvent = one(text, 220);
  }
  // ── roster
  /**
   * May this agent speak, and if not, why? AI Collaboration comes first: that dialog is where the owner
   * decides which AIs may touch a project at all, so a provider switched off there never talks in the
   * chat either — an agent already in the roster stays listed, says why it is silent, and is skipped by
   * nextAgent. A readiness the probes cannot determine is not a refusal.
   */
  agentReady(p, id) {
    if (this.o.isEnabled && !this.o.isEnabled(p, id)) return { ready: false, reason: 'disabled in AI Collaboration' };
    const r = this.o.readyOf ? this.o.readyOf(id) : null;
    if (r === false) return { ready: false, reason: 'not installed, or not logged in' };
    return { ready: true, reason: null };
  }
  /** RosterRow[] for the panel. `avatar` is drawn by the renderer from `seed` (renderer/persona.js). */
  roster(p, counts = null) {
    const s = this.get(p);
    const c = counts || this.store.counts(p);
    const resting = new Set(restingAgents(c.agent, s.capPerAgentPerHour, s.capPerAgent));
    return s.roster.map((id) => {
      const who = persona(id);
      const st = this.agentReady(p, id);
      return { id, name: who.name, seed: who.seed, specialty: who.specialty, ready: st.ready, reason: st.reason, muted: s.muted.includes(id), resting: resting.has(id), count: c.agent[id] || 0 };
    });
  }
  /** Everything the panel draws in one call. `fixtureFile` swaps the store out for a jsonl on disk. */
  payload(p, { fixtureFile = null } = {}) {
    const settings = this.get(p);
    if (fixtureFile) {
      const msgs = fixture(fixtureFile) || [];
      const agents = [...new Set(msgs.map((m) => m.agent).filter((x) => !!providers.byId(x)))];
      const fake = { ...settings, enabled: true, visible: true, roster: settings.roster.length ? settings.roster : agents };
      const counts = { agent: {}, today: msgs.filter((m) => m.kind !== 'system').length };
      for (const m of msgs) if (m.kind !== 'system') counts.agent[m.agent] = (counts.agent[m.agent] || 0) + 1;
      const roster = fake.roster.map((id) => { const w = persona(id); return { id, name: w.name, seed: w.seed, specialty: w.specialty, ready: true, muted: false, resting: false, count: counts.agent[id] || 0 }; });
      return { settings: fake, roster, messages: msgs, caps: counts, fixture: true };
    }
    const caps = this.store.counts(p);
    return { settings, roster: this.roster(p, caps), messages: this.store.read(p), caps, fixture: false };
  }
  /**
   * Providers that could join: a non-interactive command, not already in the roster, and **enabled for
   * this project in AI Collaboration** — a provider the owner switched off there is not offered at all.
   */
  candidates(p) {
    const s = this.get(p);
    return providers.list()
      .filter((x) => x.kind === 'cli' && (CHAT_EXEC[x.id] || x.exec) && !s.roster.includes(x.id))
      .filter((x) => !this.o.isEnabled || this.o.isEnabled(p, x.id))
      .map((x) => ({ id: x.id, label: x.name, name: personaName(x.id), ready: this.agentReady(p, x.id).ready }));
  }
  /** Adding an agent posts "X joined the chat" and lets the next round greet them (contract). */
  addAgent(p, id) {
    const s = this.get(p);
    if (!providers.byId(id) || s.roster.includes(id)) return s;
    if (this.o.isEnabled && !this.o.isEnabled(p, id)) return s;   // AI Collaboration decides who may touch the project
    const next = this.set(p, { roster: [...s.roster, id] });
    const who = persona(id);
    const m = this.store.append(p, { agent: id, name: who.name, kind: 'system', text: `${who.name} (${who.specialty}) joined the chat.` });
    this.push(p, m);
    const r = this.round(p); r.lastRoundAt = 0;   // greet soon, not in five minutes
    return next;
  }
  removeAgent(p, id) {
    const s = this.get(p);
    if (!s.roster.includes(id)) return s;
    const who = persona(id);
    const next = this.set(p, { roster: s.roster.filter((x) => x !== id), muted: s.muted.filter((x) => x !== id) });
    const m = this.store.append(p, { agent: id, name: who.name, kind: 'system', text: `${who.name} left the chat.` });
    this.push(p, m);
    return next;
  }
  push(p, message) { if (this.o.send) this.o.send({ project: String(p), message }); }
  // ── the loop
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((e) => this.log('chat tick ' + (e && e.message))), TICK_MS);
    if (this.timer.unref) this.timer.unref();
    if (this.force) setTimeout(() => this.tick().catch(() => { /* logged in tick */ }), 1500);   // MC_CHAT_ROUND_NOW
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  async tick(now = Date.now()) {
    const list = this.o.listProjects ? this.o.listProjects() : [];
    for (const p of list) {
      const s = this.get(p);
      if (!s.enabled) continue;   // a project whose chat was never switched on costs nothing, ever
      const r = this.round(p);
      if (r.busy) continue;
      const v = shouldRound({ enabled: s.enabled, visible: s.visible, hasWindow: this.o.hasWindow ? this.o.hasWindow() : true, now, lastRoundAt: r.lastRoundAt, interval: r.interval, pendingEvent: r.pendingEvent, lastEventRoundAt: r.lastEventRoundAt, force: this.force });
      if (this.force) this.log(`CHAT ${v.run ? 'ROUND' : 'SKIP'} ${safeKey(p)} · ${v.reason}`);
      if (!v.run) continue;
      r.busy = true;
      try { await this.runRound(p, v.reason); } catch (e) { this.log('chat round ' + (e && e.message)); }
      finally {
        r.busy = false; r.lastRoundAt = Date.now(); r.interval = jitter();
        if (v.reason === 'event') { r.lastEventRoundAt = Date.now(); r.pendingEvent = null; }
      }
    }
  }
  /** One agent, one message. Returns the stored message, or null with a logged reason. */
  async runRound(p, reason = 'interval') {
    const s = this.get(p);
    const counts = this.store.counts(p);
    const r = this.round(p);
    const ready = {};
    for (const id of s.roster) ready[id] = this.agentReady(p, id).ready;
    const id = nextAgent({ roster: s.roster, muted: s.muted, ready, perAgent: counts.agent, today: counts.today, capPerAgentPerHour: s.capPerAgentPerHour, capPerAgent: s.capPerAgent, capPerProjectPerDay: s.capPerProjectPerDay, last: r.last });
    if (!id) { if (this.force) this.log(`CHAT SKIP ${safeKey(p)} · nobody may speak (muted, resting or not ready)`); return null; }
    const plan = execPlan(id, { settings: s });
    if (plan.error) { this.log(`chat · ${id}: ${plan.error}`); r.last = id; return null; }
    const who = persona(id);
    const board = this.o.boardOf ? this.o.boardOf(p) : { tickets: [], todos: [] };
    const brief = buildBriefing({
      persona: who, project: path.basename(String(p).replace(/[\\/]+$/, '')),
      goal: readGoal(p),
      tickets: (board.tickets || []).filter((t) => t.status !== 'done').slice(0, 12).map((t) => `${t.id} ${t.title} [${t.status}]`),
      todos: (board.todos || []).filter((t) => !t.done).slice(0, 12).map((t) => t.text),
      journal: readJournalTail(this.o.memDirOf ? this.o.memDirOf(p) : '', 8),
      messages: this.store.read(p).slice(-12),
      event: reason === 'event' ? r.pendingEvent : null,
      roster: s.roster.map((x) => persona(x)),
    });
    const env = chatEnv(this.o.envOf ? this.o.envOf(p) : process.env);
    const res = await runTool(plan, brief, { env, cwd: fs.existsSync(p) ? p : undefined });
    r.last = id;
    if (!res.ok && !res.stdout) { this.log(`chat · ${id} did not answer: ${one(res.error || res.stderr, 120)}`); return null; }
    const parsed = parseReply(res.stdout);
    if (!parsed) { this.log(`chat · ${id} said nothing usable`); return null; }
    const msg = this.store.append(p, { agent: id, name: who.name, kind: parsed.kind, text: parsed.text });
    this.store.prune(p, KEEP_DAYS);
    this.push(p, msg);
    this.log(`CHAT MESSAGE ${safeKey(p)} · ${id}/${who.name} · ${msg.kind} · ${msg.text}`);
    return msg;
  }
}

module.exports = {
  ChatService, ChatStore,
  buildBriefing, parseReply, nextAgent, shouldRound, restingAgents, capFor, jitter,
  normalizeSettings, DEFAULTS, CAP_PER_AGENT, persona, personaName, redact, looksSecret,
  execPlan, tokenize, runTool, chatEnv, CHAT_EXEC, STDIN_TOOLS,
  readGoal, readJournalTail, parseOllamaList, fixture, firstJson,
  safeKey, KEEP_DAYS, MAX_TEXT, BRIEF_BUDGET, ROUND_MIN, ROUND_MAX, EVENT_COALESCE_MS, TICK_MS,
};

'use strict';
/*
 providers — the accounts & AI registry (docs/ACCOUNTS-CONTRACT.md, T-019).

 Four jobs, none of which may throw across IPC:
 1. `PROVIDERS`: the static registry — what each tool is called, how it is installed, how it is logged in,
    which environment variable carries its API key. One plain object per tool: adding a row is adding an
    object, never a code branch. `list()` is the serializable form the renderer gets.
 2. Status probes: non-interactive `--version` / `... status` calls through child_process, four at a time,
    cached 60 s, every one wrapped so a missing binary comes back as `installed: false` and never as a
    rejected promise. The commands come from the contract's "Verified commands" table and from the lead's
    research; a field the research could not confirm is null here, never guessed.
 3. `readiness()`: pure. Is a provider the owner switched on actually usable, and if not, what fixes it.
 4. `assembleEnv()`: pure. Given the base environment, the decrypted keys and the enablement settings it
    returns the environment a new terminal gets. Unit-tested; no I/O, no Electron.

 Windows details that matter here: `claude` is an npm shim (`claude.cmd`), which CreateProcess cannot run
 directly, so every command is resolved on PATH first and .cmd/.bat shims are run through cmd.exe. And the
 ChatGPT desktop app ships Codex at %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe, which is not on PATH.
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const WINGET = (id) => `winget install --id ${id} -e --accept-source-agreements --accept-package-agreements`;
const KEY_BLURB = 'Used by Aider, Cline, Goose and OpenCode when you pick that provider.';

// ── the registry ─────────────────────────────────────────────────────────────────────────────────
// `keys` is informational: the environment variables a tool reads. It drives no UI yet; the owner's
// multi-AI work will use it to say which key makes which tool go.
// `exec` is the one-shot, non-interactive form of the tool, with a {prompt} placeholder (and {model} for
// Ollama). No UI yet either. A field the research could not verify is null, and stays null.
const PROVIDERS = [
  {
    id: 'claude', name: 'Claude Code', kind: 'cli', role: 'required', bin: 'claude',
    winget: 'Anthropic.ClaudeCode', install: WINGET('Anthropic.ClaudeCode'),
    installFallback: 'irm https://claude.ai/install.ps1 | iex',
    login: 'claude auth login',
    exec: 'claude -p "{prompt}"',            // verified locally: -p/--print runs one prompt and exits
    keys: ['ANTHROPIC_API_KEY'],
    docs: 'https://code.claude.com/docs/en/authentication',
    blurb: 'Mission Control supervises Claude Code sessions; without it nothing here runs.',
    status: probeClaude,
  },
  {
    id: 'github', name: 'GitHub CLI', kind: 'cli', role: 'required', bin: 'gh',
    winget: 'GitHub.cli', install: WINGET('GitHub.cli'),
    login: 'gh auth login -h github.com -w',
    keys: ['GH_TOKEN'],
    docs: 'https://cli.github.com/manual/gh_auth_login',
    blurb: 'Branches, pull requests and the per-project token every terminal gets.',
    status: probeGithub,
  },
  {
    id: 'codex', name: 'OpenAI Codex CLI', kind: 'cli', role: 'ai', bin: 'codex',
    winget: 'OpenAI.Codex', install: WINGET('OpenAI.Codex'),
    installFallback: 'npm install -g @openai/codex',
    login: 'codex login',
    exec: 'codex exec "{prompt}"',           // verified locally: `codex exec` runs Codex non-interactively
    keys: ['OPENAI_API_KEY'],
    docs: 'https://github.com/openai/codex/blob/main/docs/install.md',
    blurb: 'OpenAI’s coding agent. The vendor documents WSL2 as the supported Windows path, but the native codex.exe the ChatGPT desktop app installs off PATH runs here, and Mission Control finds it there.',
    status: probeCodex,
  },
  {
    id: 'gemini', name: 'Google Gemini CLI', kind: 'cli', role: 'ai', bin: 'gemini',
    winget: null, install: 'npm install -g @google/gemini-cli',
    login: 'gemini',                         // no separate login verb: the first run opens the Google flow
    exec: 'gemini -p "{prompt}"',
    keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    docs: 'https://geminicli.com/docs/get-started/authentication',
    blurb: 'Google’s CLI agent. It has no status command: the first run opens the Google login.',
    status: probeGemini,
  },
  {
    id: 'copilot', name: 'GitHub Copilot CLI', kind: 'cli', role: 'ai', bin: 'copilot',
    winget: null, install: 'npm install -g @github/copilot',
    login: 'copilot login',
    exec: 'copilot -p "{prompt}"',
    keys: ['GITHUB_TOKEN'],
    docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli',
    // the older `gh copilot` extension is deprecated, and is deliberately not probed
    blurb: 'GitHub’s own agent. It signs in with your GitHub account, so the per-project token Mission Control already injects may cover it.',
    status: versionProbe('copilot'),
  },
  {
    id: 'cursor', name: 'Cursor CLI', kind: 'cli', role: 'ai', bin: 'agent',
    winget: null, install: "irm 'https://cursor.com/install?win32=true' | iex",
    login: 'agent login',
    exec: 'agent -p "{prompt}" --output-format json',
    keys: ['CURSOR_API_KEY'],
    docs: 'https://cursor.com/docs/cli/installation',
    blurb: 'Cursor’s terminal agent. Its binary is called `agent`, so Mission Control reads the version line before believing it.',
    status: versionProbe('agent', { accept: isCursorAgent }),
  },
  {
    id: 'cline', name: 'Cline CLI', kind: 'cli', role: 'ai', bin: 'cline',
    winget: null, install: 'npm install -g cline',
    login: 'cline auth',
    exec: 'cline "{prompt}"',
    keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    docs: 'https://docs.cline.bot/cli/cli-reference',
    blurb: 'Cline in the terminal. It runs on the Anthropic or OpenAI key you give it.',
    status: versionProbe('cline'),
  },
  {
    id: 'opencode', name: 'OpenCode', kind: 'cli', role: 'ai', bin: 'opencode',
    winget: null, install: 'npm install -g opencode-ai@latest',
    login: 'opencode auth login',
    exec: 'opencode run "{prompt}" --format json',
    keys: [],
    docs: 'https://opencode.ai/docs/cli',
    blurb: 'A terminal coding agent that keeps its own provider logins.',
    status: versionProbe('opencode'),
  },
  {
    id: 'aider', name: 'Aider', kind: 'cli', role: 'ai', bin: 'aider',
    winget: null, install: 'irm https://aider.chat/install.ps1 | iex',
    login: null,                             // no account: it reads provider keys from the environment
    exec: 'aider --message "{prompt}" --yes-always',
    keys: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY'],
    docs: 'https://aider.chat/docs/install.html',
    blurb: 'Pair programming in the terminal. There is no login: it uses whichever provider key is in the environment.',
    status: versionProbe('aider'),
  },
  {
    id: 'goose', name: 'Goose', kind: 'cli', role: 'ai', bin: 'goose',
    winget: null, install: null,             // unverified: the repo moved orgs, so no install line is claimed
    login: null,                             // `goose configure` picks a provider; it is not a login
    exec: null,                              // unverified
    keys: [],
    docs: 'https://github.com/block/goose',
    blurb: 'Block’s local agent. Install it from the vendor docs, then `goose configure` picks a provider.',
    status: versionProbe('goose'),
  },
  {
    id: 'ollama', name: 'Ollama', kind: 'cli', role: 'ai', bin: 'ollama',
    winget: 'Ollama.Ollama', install: WINGET('Ollama.Ollama'),
    login: null,                             // fully local: there is no account to log in to
    exec: 'ollama run {model} "{prompt}"',   // the only exec with a second placeholder
    keys: [],
    docs: 'https://ollama.com',
    blurb: 'Runs open models locally; no account, no key.',
    status: versionProbe('ollama'),
  },
  {
    id: 'anthropic-key', name: 'Anthropic API key', kind: 'key', role: 'ai', envVar: 'ANTHROPIC_API_KEY',
    docs: 'https://console.anthropic.com/settings/keys',
    blurb: 'Claude Code uses this instead of the subscription login when it is set. Leave it empty to keep the subscription.',
  },
  {
    id: 'openai-key', name: 'OpenAI API key', kind: 'key', role: 'ai', envVar: 'OPENAI_API_KEY',
    docs: 'https://platform.openai.com/api-keys',
    blurb: 'For Codex in API-key mode and any OpenAI SDK a worker runs.',
  },
  {
    id: 'gemini-key', name: 'Google Gemini API key', kind: 'key', role: 'ai', envVar: 'GEMINI_API_KEY',
    docs: 'https://aistudio.google.com/app/apikey',
    blurb: 'Lets the Gemini CLI and the Google SDKs run without the browser login.',
  },
  { id: 'xai-key', name: 'xAI API key', kind: 'key', role: 'ai', envVar: 'XAI_API_KEY', docs: 'https://console.x.ai', blurb: KEY_BLURB },
  { id: 'mistral-key', name: 'Mistral API key', kind: 'key', role: 'ai', envVar: 'MISTRAL_API_KEY', docs: 'https://console.mistral.ai', blurb: KEY_BLURB },
  { id: 'deepseek-key', name: 'DeepSeek API key', kind: 'key', role: 'ai', envVar: 'DEEPSEEK_API_KEY', docs: 'https://platform.deepseek.com', blurb: KEY_BLURB },
  { id: 'openrouter-key', name: 'OpenRouter API key', kind: 'key', role: 'ai', envVar: 'OPENROUTER_API_KEY', docs: 'https://openrouter.ai/keys', blurb: 'One key for many models. ' + KEY_BLURB },
  { id: 'cursor-key', name: 'Cursor API key', kind: 'key', role: 'ai', envVar: 'CURSOR_API_KEY', docs: 'https://cursor.com/docs/cli', blurb: 'Lets the Cursor CLI run headless, without the browser login.' },
];
const byId = (id) => PROVIDERS.find((p) => p.id === id) || null;
/** The registry as the renderer sees it: JSON only, no probe functions. */
const list = () => PROVIDERS.map(({ status, ...rest }) => ({ ...rest }));   // eslint-disable-line no-unused-vars

// ── running a command ────────────────────────────────────────────────────────────────────────────
const isWin = process.platform === 'win32';
const quote = (s) => (/[\s"&|<>^]/.test(String(s)) ? '"' + String(s).replace(/"/g, '\\"') + '"' : String(s));
/** PATH lookup that understands PATHEXT, so `claude` resolves to `...\npm\claude.cmd`. Null when absent.
    The extensions come first on Windows on purpose: npm drops both `claude` (a bash script Windows cannot
    run) and `claude.cmd` in the same directory, and only the second one starts. */
function which(bin) {
  if (!bin) return null;
  if (bin.includes('/') || bin.includes('\\')) return fileOrNull(bin);
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? [...String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), ''] : [''];
  for (const d of dirs) for (const e of exts) { const f = fileOrNull(path.join(d, bin + e)); if (f) return f; }
  return null;
}
function fileOrNull(f) { try { return fs.statSync(f).isFile() ? f : null; } catch { return null; } }
/** execFile, but a .cmd/.bat shim goes through cmd.exe (CreateProcess cannot start one). Never rejects. */
function run(file, args = [], opts = {}) {
  return new Promise((resolve) => {
    let f = file, a = args;
    if (isWin && /\.(cmd|bat)$/i.test(String(file))) { a = ['/d', '/s', '/c', [quote(file), ...args.map(quote)].join(' ')]; f = process.env.ComSpec || 'cmd.exe'; }
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      execFile(f, a, { windowsHide: true, timeout: opts.timeout || 5000, maxBuffer: 2e6, cwd: opts.cwd, env: opts.env || process.env },
        (err, stdout, stderr) => finish({ ok: !err, code: err ? (err.code == null ? 1 : err.code) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    } catch (e) { finish({ ok: false, code: 'ESPAWN', stdout: '', stderr: String((e && e.message) || e) }); }
  });
}
/** The env a Claude probe runs in: the nested-session guard makes `claude` refuse to start inside a session. */
function cleanEnv() { const e = { ...process.env }; delete e.CLAUDECODE; delete e.CLAUDE_CODE_ENTRYPOINT; return e; }

// ── parsers (pure; fed fixture strings by the unit tests) ────────────────────────────────────────
/** First dotted number on the first line: "2.1.269 (Claude Code)" → 2.1.269, "gh version 2.97.0 (…)" → 2.97.0. */
function parseVersion(out) {
  const m = /(\d+\.\d+(?:\.\d+)*)/.exec(String(out || '').split(/\r?\n/)[0] || '');
  return m ? m[1] : null;
}
/** `claude auth status` prints one JSON object. Anything else means "cannot tell". */
function parseClaudeStatus(out) {
  let j = null;
  const s = String(out || ''); const i = s.indexOf('{'), k = s.lastIndexOf('}');
  if (i >= 0 && k > i) { try { j = JSON.parse(s.slice(i, k + 1)); } catch { j = null; } }
  if (!j || typeof j !== 'object') return { loggedIn: null, account: null, detail: null };
  const account = j.email || j.orgName || null;
  if (!j.loggedIn) return { loggedIn: false, account, detail: 'not logged in' };
  const tail = [j.orgName, j.subscriptionType ? j.subscriptionType + ' plan' : null, j.authMethod].filter(Boolean).join(' · ');
  return { loggedIn: true, account, detail: 'logged in as ' + (account || 'this machine') + (tail ? ' · ' + tail : '') };
}
/** `gh auth status`: one block per login. Exit 1 and no blocks means nobody is logged in. */
function parseGhStatus(out) {
  const s = String(out || ''); const accounts = [];
  const re = /Logged in to github\.com account (\S+)[\s\S]*?Active account: (true|false)/g; let m;
  while ((m = re.exec(s))) accounts.push({ login: m[1], active: m[2] === 'true' });
  if (!accounts.length) return { loggedIn: false, account: null, accounts, detail: 'no GitHub account is logged in' };
  const active = (accounts.find((a) => a.active) || accounts[0]).login;
  // gh lists one block per login, and the same account can appear twice (once from GH_TOKEN, once from the
  // keyring). Count the blocks, name the distinct accounts — anything else misreports one of the two.
  const names = [...new Set(accounts.map((a) => a.login))];
  const more = accounts.length > 1 ? ` · ${accounts.length} logins: ${names.join(', ')}` : '';
  return { loggedIn: true, account: active, accounts, detail: `logged in as ${active}${more}` };
}
/** `codex login status` is plain text ("Logged in using ChatGPT"); openai/codex#19866 asks for JSON. */
function parseCodexLogin(out, ok) {
  const s = String(out || '').trim();
  if (/not\s+logged\s+in|please\s+run\s+.*login|no\s+credentials/i.test(s)) return { loggedIn: false, account: null, detail: 'not logged in' };
  if (/logged\s+in/i.test(s)) {
    const line = s.split(/\r?\n/).find((l) => /logged\s+in/i.test(l)) || s;
    const mail = /([\w.+-]+@[\w.-]+\.\w+)/.exec(s);
    return { loggedIn: true, account: mail ? mail[1] : null, detail: line.trim().slice(0, 120) };
  }
  if (!ok) return { loggedIn: false, account: null, detail: 'not logged in' };
  return { loggedIn: null, account: null, detail: s ? s.split(/\r?\n/)[0].slice(0, 120) : 'login state unknown' };
}
/**
 * The Cursor CLI installs itself as `agent` — a name anything could own. Only believe a version line that
 * names the tool; otherwise an unrelated `agent` on this PATH would report Cursor as installed.
 */
function isCursorAgent(out) { return /cursor|agent/i.test(String(out || '')); }

// ── probes (each returns a Status; none of them throws) ──────────────────────────────────────────
const NOT_INSTALLED = (extra) => ({ installed: false, version: null, loggedIn: null, account: null, detail: 'not installed', ...extra });

/**
 * The probe every tool without a documented status command gets: find the binary, ask it its version, and
 * stop there. `loggedIn` stays null, so such a tool never nags the owner to log in — the dialogs only offer
 * "Log in" when the registry has a login line. `accept` is an extra check on the version output, for a
 * binary whose name is too generic to trust on its own (Cursor's `agent`).
 */
function versionProbe(bin, { accept = null, timeout = 5000 } = {}) {
  return async function probe() {
    const found = which(bin);
    if (!found) return NOT_INSTALLED();
    let r = await run(found, ['--version'], { timeout });
    let out = r.stdout + r.stderr;
    if (!parseVersion(out)) { r = await run(found, ['-v'], { timeout }); out = r.stdout + r.stderr; }   // some tools only take -v
    const version = parseVersion(out);
    if (accept && !accept(out)) return NOT_INSTALLED({ detail: `another program owns "${bin}" on this PATH` });
    if (!version && !r.ok) return NOT_INSTALLED({ detail: 'found on PATH but it did not answer --version' });
    return { installed: true, version, path: found, loggedIn: null, account: null, detail: version ? 'installed · v' + version : 'installed' };
  };
}

async function probeClaude() {
  const bin = which('claude');
  if (!bin) return NOT_INSTALLED();
  const env = cleanEnv();
  const v = await run(bin, ['--version'], { timeout: 15000, env });
  if (!v.ok && !parseVersion(v.stdout)) return NOT_INSTALLED({ detail: 'found on PATH but it did not answer --version' });
  const st = await run(bin, ['auth', 'status'], { timeout: 15000, env });
  const parsed = parseClaudeStatus(st.stdout + st.stderr);
  return { installed: true, version: parseVersion(v.stdout), path: bin, ...parsed, detail: parsed.detail || (st.ok ? 'installed' : 'installed, login state unknown') };
}
async function probeGithub() {
  const bin = which('gh');
  if (!bin) return NOT_INSTALLED();
  const v = await run(bin, ['--version']);
  const st = await run(bin, ['auth', 'status'], { timeout: 10000 });
  const parsed = parseGhStatus(st.stdout + '\n' + st.stderr);
  return { installed: true, version: parseVersion(v.stdout), path: bin, ...parsed };
}
/** %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe — the copy the ChatGPT desktop app installs. */
function codexFromChatGptApp(localAppData) {
  const root = path.join(localAppData || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  let names = []; try { names = fs.readdirSync(root); } catch { return null; }
  const hits = [];
  for (const n of names) { const f = fileOrNull(path.join(root, n, 'codex.exe')); if (f) { let m = 0; try { m = fs.statSync(f).mtimeMs; } catch { m = 0; } hits.push({ f, m }); } }
  hits.sort((a, b) => b.m - a.m);
  return hits.length ? hits[0].f : null;
}
async function probeCodex() {
  let bin = which('codex'); let viaApp = false;
  if (!bin) { bin = codexFromChatGptApp(); viaApp = !!bin; }
  if (!bin) return NOT_INSTALLED();
  const v = await run(bin, ['--version'], { timeout: 10000 });
  const st = await run(bin, ['login', 'status'], { timeout: 10000 });
  const parsed = parseCodexLogin(st.stdout + '\n' + st.stderr, st.ok);
  const where = viaApp ? 'installed via ChatGPT app' : null;
  return {
    installed: true, version: parseVersion(v.stdout), path: bin, viaApp,
    loggedIn: parsed.loggedIn, account: parsed.account,
    detail: [parsed.detail, where].filter(Boolean).join(' · '),
  };
}
async function probeGemini() {
  const bin = which('gemini');
  if (!bin) return NOT_INSTALLED();
  const v = await run(bin, ['--version'], { timeout: 10000 });
  // No documented status command (google-gemini/gemini-cli): the first run opens the Google login.
  const keyed = !!process.env.GEMINI_API_KEY;
  return { installed: true, version: parseVersion(v.stdout), path: bin, loggedIn: null, account: null, detail: keyed ? 'installed · GEMINI_API_KEY is set' : 'installed · login happens on first run' };
}
/** kind 'key': there is nothing to probe, only "is one stored". */
function keyStatus(entry) {
  const setAt = entry && entry.setAt ? entry.setAt : null;
  return { installed: !!setAt, version: null, loggedIn: setAt ? true : null, account: null, detail: setAt ? 'key stored ' + String(setAt).slice(0, 10) : 'no key stored', at: Date.now() };
}

// ── readiness: is a provider this project switched on actually usable? ────────────────────────────
/**
 * Pure. Given a registry entry, its last Status and whether a key is stored, say whether the owner still
 * has something to do, and what. A status we have not got yet (or a `loggedIn` the vendor cannot report,
 * which is every tool without a status command) is never a complaint: only a definite `false` is.
 *   reason: null | 'not-installed' | 'not-logged-in' | 'no-key'
 *   actions: the buttons the dialog should offer, in order — 'install' | 'login' | 'settings'
 */
function readiness(provider, status, hasKey) {
  const p = provider || {};
  if (p.kind === 'key') {
    return hasKey ? { ready: true, reason: null, actions: [] } : { ready: false, reason: 'no-key', actions: ['settings'] };
  }
  const st = status || {};
  if (st.installed === false) return { ready: false, reason: 'not-installed', actions: p.install ? ['install'] : [] };
  if (st.loggedIn === false) return { ready: false, reason: 'not-logged-in', actions: p.login ? ['login'] : [] };
  return { ready: true, reason: null, actions: [] };
}

// ── the cache ────────────────────────────────────────────────────────────────────────────────────
const CACHE_MS = 60 * 1000;
const PROBE_CONCURRENCY = 4;   // eleven CLIs is eleven child processes; four at a time keeps it civil
let cache = { at: 0, status: null };
/** Run `fn` over `items`, at most `n` at a time, results in the original order. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}
/**
 * Every provider's Status, four probes at a time, cached for a minute. `keyInfo` is `{ id: { setAt } }`
 * from secrets.js (never the key itself). A probe that blows up still yields a Status with `error`.
 */
async function statusAll({ force = false, keyInfo = {} } = {}) {
  const cli = PROVIDERS.filter((p) => typeof p.status === 'function');
  let probed = cache.status;
  if (force || !probed || Date.now() - cache.at > CACHE_MS) {
    const results = await pool(cli, PROBE_CONCURRENCY, (p) => Promise.resolve()
      .then(() => p.status())
      .catch((e) => ({ ...NOT_INSTALLED(), detail: 'probe failed', error: String((e && e.message) || e).slice(0, 200) })));
    probed = {}; cli.forEach((p, i) => { probed[p.id] = { ...results[i], at: Date.now() }; });
    cache = { at: Date.now(), status: probed };
  }
  const out = { ...probed };
  for (const p of PROVIDERS) if (p.kind === 'key') out[p.id] = keyStatus(keyInfo[p.id]);
  return out;
}
function invalidate() { cache = { at: 0, status: null }; }

// ── enablement + environment (pure) ──────────────────────────────────────────────────────────────
/** Is provider `id` allowed in this project? Project setting wins, then the global default, then yes. */
function isEnabled(id, projectSettings, globalSettings) {
  const pp = projectSettings && projectSettings.providers;
  if (pp && typeof pp[id] === 'boolean') return pp[id];
  const gp = globalSettings && globalSettings.providers;
  if (gp && typeof gp[id] === 'boolean') return gp[id];
  return true;
}
/**
 * Pure: the environment a new terminal gets. `secrets` is `{ providerId: plaintextKey }` (main process only).
 * A variable that already has a value in `base` is never overwritten — a key the owner exported in the shell,
 * or GH_TOKEN, wins over anything stored here.
 */
function assembleEnv({ base = {}, secrets = {}, providers = PROVIDERS, projectSettings = {}, globalSettings = {} } = {}) {
  const env = { ...base };
  for (const p of providers) {
    if (!p || p.kind !== 'key' || !p.envVar) continue;
    const val = secrets[p.id];
    if (!val) continue;
    if (env[p.envVar]) continue;                                   // base wins
    if (!isEnabled(p.id, projectSettings, globalSettings)) continue;
    env[p.envVar] = String(val);
  }
  return env;
}
/** The shell line for a login, using the binary we actually found (the ChatGPT app's codex is not on PATH). */
function loginLine(id, status) {
  const p = byId(id); if (!p || !p.login) return null;
  const bin = status && status.path;
  if (bin && p.bin && !which(p.bin)) {                              // found off PATH: call it by full path
    const rest = p.login.split(/\s+/).slice(1).join(' ');
    return (isWin ? '& ' : '') + quote(bin) + (rest ? ' ' + rest : '');
  }
  return p.login;
}
/** The shell line for an install: winget when the vendor has a package, else the vendor's own line. */
function installLine(id) { const p = byId(id); return p ? (p.install || null) : null; }

module.exports = {
  PROVIDERS, list, byId, statusAll, invalidate, keyStatus, readiness,
  assembleEnv, isEnabled, loginLine, installLine,
  parseVersion, parseClaudeStatus, parseGhStatus, parseCodexLogin, isCursorAgent,
  which, codexFromChatGptApp, run, cleanEnv, versionProbe, pool, CACHE_MS, PROBE_CONCURRENCY,
};

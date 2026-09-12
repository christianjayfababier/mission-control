# Accounts & AI — IPC and data contract (T-019, consumed by T-020 and T-021)

Written by Skye, 2026-09-12. The accounts builder implements it, the Setup wizard builder consumes it. Plain JSON everywhere.
`projectPath` is the project's absolute path (the same value the board and settings use). No new dependency: secrets use
Electron's `safeStorage` (DPAPI on Windows), status probes use `child_process`, logins run in the existing embedded terminal.

## Provider registry: `providers.js` (main process, pure data + probes)

```ts
Provider = {
  id: 'claude' | 'github' | 'codex' | 'gemini' | 'openai-key' | 'gemini-key' | 'anthropic-key',
  name: string,                      // "Claude Code", "GitHub CLI", "OpenAI Codex CLI", "Google Gemini CLI", ...
  kind: 'cli' | 'key',               // cli: installed + logged-in state; key: an API key the user pastes
  role: 'required' | 'ai' | 'vcs',   // required: Claude Code + GitHub CLI (Mission Control needs them); ai: optional AI tools
  bin?: string,                      // executable to look for on PATH ('claude', 'gh', 'codex', 'gemini')
  winget?: string,                   // winget package id, or null when the vendor has none (then `install` is the vendor command)
  install?: string,                  // shell line the wizard runs in a terminal when winget is null (e.g. an npm -g install)
  login?: string,                    // shell line run in an embedded terminal; the user finishes the browser flow there
  status?: (env) => Promise<Status>, // non-interactive probe; never throws
  envVar?: string,                   // for kind 'key': the variable injected into terminals (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY)
  docs: string                       // vendor URL shown as a link
}
Status = { installed: boolean, version: string | null, loggedIn: boolean | null,   // null = unknown / not applicable
           account: string | null,   // login or email when the tool reports one
           detail: string | null,    // one line for the UI ("logged in as x", "not installed", "key set")
           at: number }
```

The exact `install`, `login` and probe commands per provider are in the "Verified commands" section below; the builder does
not invent them. Probes run with a 5 s timeout, in parallel, and are cached 60 s; a refresh button forces them.

## Secrets: `~/.claude/mission-control/secrets.json`

```ts
SecretsFile = { version: 1, keys: { [providerId: string]: { enc: string /* base64 of safeStorage.encryptString */, setAt: string } } }
```

Plain text never touches disk. When `safeStorage.isEncryptionAvailable()` is false the tab says so and refuses to save.
`secrets.js` exports `Secrets` with `set(id, value)`, `has(id)`, `get(id)` (decrypt, main process only), `remove(id)`, `list()`
→ `{ id, setAt }[]`. The value is never sent to the renderer; the renderer only learns `has`.

## Environment injection (`pty:create` in main.js)

Today: `GH_TOKEN`, `GIT_AUTHOR_*`, `GIT_COMMITTER_*` per project. Add: every key in `secrets.json` whose provider is
enabled for the project is exported under its `envVar`. Enablement lives in project settings:
`settings.get(projectPath).providers = { [providerId]: true | false }`; a missing entry means the global default
(`SettingsGlobal.providers[id]`, default true for 'anthropic-key' only when set, true for others). A pure function
`assembleEnv({ base, secrets, providers, projectSettings, globalSettings })` → env in `providers.js`, covered by unit tests
(a disabled provider's key is absent; an enabled one is present; base vars are never overwritten).

## Renderer API (`window.mc`)

| Call | IPC | Returns |
| --- | --- | --- |
| `providersList()` | `providers:list` | `{ providers: (Provider without functions)[], status: { [id]: Status }, secrets: { [id]: { setAt } } }` |
| `providersRefresh()` | `providers:refresh` | same, after forcing every probe |
| `providersLogin(id, projectPath?)` | `providers:login` | `{ ptyId }` — opens a terminal in the project (or home) and writes the provider's `login` line; the tab activates it |
| `providersInstall(id)` | `providers:install` | `{ ptyId }` — winget or vendor install line in a terminal |
| `secretSet(id, value)` | `secrets:set` | `{ ok: true, setAt }` or `{ error }` |
| `secretRemove(id)` | `secrets:remove` | `{ ok: true }` |
| `providersSetEnabled(projectPath \| null, id, enabled)` | `providers:enable` | updated enablement (null path = global default) |
| `onProviders(cb)` | push `providers` | `{ status }` after a refresh or after a login terminal exits |

## UI: **Accounts & AI** (header button next to Team & models, opens `#dlg-accounts`, wide)

Three groups: **Required** (Claude Code, GitHub CLI: installed, version, logged-in account, buttons Install / Log in /
Refresh), **AI tools** (Codex, Gemini: same, plus "Not installed, install" when absent), **API keys** (Anthropic, OpenAI,
Gemini: masked field, Save, Remove, "set on <date>"). Per-project toggles live in the existing Repo & account dialog as a
"Providers this project may use" checklist (default: all enabled). Screenshot view: `--view accounts` opens the dialog.

## Non-goals (T-019)

No password or token typed into Mission Control except API keys. No OAuth client of our own. No provider added for a tool
without a login command. No change to `kit/`.

## Verified commands (filled by Skye from vendor docs before dispatch)

| Provider | Detect | Status probe | Login (embedded terminal) | Install | Source |
| --- | --- | --- | --- | --- | --- |
| Claude Code (`claude`) | `claude --version` | `claude auth status` → JSON `{ loggedIn, authMethod, email, orgName, subscriptionType, configDirectory, projectsDirectory }`, exit 0; run with `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` removed from the env (nested-session guard); allow 15 s | `claude auth login` (browser flow; the user finishes it in the terminal) | winget `Anthropic.ClaudeCode`; fallback `irm https://claude.ai/install.ps1 \| iex` | code.claude.com/docs/en/authentication, /cli-reference, /setup; verified locally 2026-09-12 |
| GitHub CLI (`gh`) | `gh --version` | `gh auth status` (lines "Logged in to github.com account <login>"; exit 1 when nobody is logged in); reuse `GitHub.accounts()` in integrations.js | `gh auth login -h github.com -w` | winget `GitHub.cli` | cli.github.com/manual/gh_auth_status, gh_auth_login; verified locally (three accounts logged in) |
| OpenAI Codex CLI (`codex`) | `codex --version` | `codex login status` (plain text; treat non-zero exit or "not logged in" as logged out; no JSON yet, openai/codex#19866) | `codex login` (ChatGPT browser flow); API key alternative: pipe the key into `codex login --with-api-key` | winget `OpenAI.Codex` (rename to OpenAI.CodexCLI requested, unresolved); fallback `npm install -g @openai/codex` | learn.chatgpt.com/docs/auth, npmjs.com/package/@openai/codex, winget-pkgs manifests/o/OpenAI/Codex |
| Google Gemini CLI (`gemini`) | `gemini --version` | no documented status command: report installed and "login happens on first run"; treat `GEMINI_API_KEY` set as configured; loggedIn = null | `gemini` (first run opens the Google login) | no winget package (google-gemini/gemini-cli#1442); `npm install -g @google/gemini-cli` | npmjs.com/package/@google/gemini-cli; github.com/google-gemini/gemini-cli (auth docs page 404 on 2026-09-12; flags beyond install are community-confirmed only) |
| API keys | n/a | `has` from secrets.json | n/a | n/a | env vars: `ANTHROPIC_API_KEY` (Claude Code uses it instead of the subscription login), `OPENAI_API_KEY`, `GEMINI_API_KEY` |

Prerequisites for the wizard (T-020): Node.js `OpenJS.NodeJS.LTS`, Git `Git.Git`, GitHub CLI `GitHub.cli`, Claude Code
`Anthropic.ClaudeCode`. Install form: `winget install --id <id> -e --accept-source-agreements --accept-package-agreements`;
whether a package needs admin is installer-dependent (Microsoft troubleshooting doc), so the wizard runs it in a terminal and
lets Windows prompt.

Notes: `CLAUDE_CONFIG_DIR` moves the whole `~/.claude` tree including `projects/` (transcripts), so per-project Claude accounts
through separate config dirs are out of scope for T-019; Mission Control reads transcripts from one place. Multiple GitHub
accounts are already supported by the GitHub CLI since 2.40 and by Mission Control's per-project token injection.

## As built (T-019, reviewed by Skye 2026-09-12)

Deviations from the sections above, accepted at review; T-020 codes against this list:
- UI groups key off `role === 'required'`, then `kind === 'cli'`, then `kind === 'key'`; key providers carry `role: 'ai'`. `'vcs'` is unused.
- Probe timeouts: 5 s default, 15 s for Claude Code, 10 s for gh, codex and gemini (`gh auth status` with three keyring logins needs more than 5 s).
- `providers.js` resolves binaries itself with PATHEXT (`claude` is `claude.cmd` on Windows; the bare `claude` file is a bash script) and runs `.cmd`/`.bat` shims through `cmd.exe`. Codex is also looked for at `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` (the ChatGPT desktop app's copy, `viaApp: true`); its login line is rewritten to the full path when the binary is off PATH.
- `Status` gained `path`, `viaApp`, `accounts` (gh logins) and `error`; a provider row gained `blurb`. GitHub's detail says "N logins" because `gh auth status` lists the same account once per credential source.
- Enablement default: every provider is enabled unless the project or the global setting says otherwise; a key that is not stored exports nothing.
- Login and install open a terminal tab in the selected project (or the first project with a path); with no projects the dialog says so. A saved key reaches only terminals opened afterwards.
- Gemini `loggedIn` is always `null` (no status command); the probe reports whether `GEMINI_API_KEY` is set in the app's own environment.

## Placement, after the owner's review (2026-09-12)

- Machine-wide settings live in one **Settings** dialog opened from a cog (⚙) in the sidebar footer, before "+ Add/create a project". Sections: **Accounts & AI** (the content above, unchanged), **Global rules** (edit `orchestrator-system.local.md`; IPC `rules:writeLocal` writes only that file, guard in `globalsettings.js`), **Hidden projects** (IPC `projects:hidden`, `projects:unhide`), **About & diagnostics** (`env` payload gained `version` and `electron`; crash log arrives with T-024).
- The per-project provider checklist is its own header button **AI** (`#dlg-ai`), not part of Repo & account.
- Screenshot views: `--view settings` (alias `accounts`), `settings-rules`, `settings-hidden`, `settings-about`, `ai`.
- Rule for later features: machine-wide goes into a Settings section, per-project goes into the project header.

## Registry as shipped (2026-09-12, after the owner asked for the ten most-used tools)

- **CLI tools (11):** Claude Code, GitHub CLI (both `required`), then OpenAI Codex CLI, Google Gemini CLI, GitHub Copilot CLI, Cursor CLI (bin `agent`, accepted only when its version line mentions cursor or agent), Cline CLI, OpenCode, Aider, Goose, Ollama. Commands come from vendor docs verified on 2026-09-12 (memory note `ai-provider-facts`); only Claude Code's and Codex's `exec` were run on this machine. Goose has no verified install, login or exec line and shows detection only.
- **API keys (8):** Anthropic, OpenAI, Google Gemini, xAI, Mistral, DeepSeek, OpenRouter, Cursor. Aider, Cline, Goose and OpenCode reuse these; Ollama needs none; Copilot rides the GitHub account (`GITHUB_TOKEN`, informational only, the per-project `GH_TOKEN` is unchanged).
- **Probe policy:** `<bin> --version` (fallback `-v`) for detection; `loggedIn` only for tools with a documented status command (Claude Code, GitHub CLI, Codex), `null` otherwise, so those tools never ask for a login. Concurrency 4, 5 s timeout for the new tools, 60 s cache; a full round takes about 2 s here.
- **Optional fields:** `exec` (one-shot template with `{prompt}`, Ollama also `{model}`), `keys` (env vars the tool reads), `blurb`. Nothing reads `exec` or `keys` yet; they exist for the multi-AI collaboration design.
- **Readiness:** `readiness(provider, status, hasKey)` → `{ ready, reason, actions }`; not-installed wins over not-logged-in; a project toggle turned on for a provider that is not ready shows an amber callout with Install / Log in / Open Settings.
- **Filter:** the Settings list filters on name, id, bin, env var, blurb and `keys`.
- **Screenshot timing:** `--view` retries every 500 ms for up to 6 s until a project is selected; the 19-row AI dialog needs `--wait 12000` on a loaded machine.

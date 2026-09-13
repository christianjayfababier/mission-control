# Mission Control (desktop)

A Windows desktop app with real terminals inside it: projects and their directories in the left sidebar; on the right, the orchestrator's terminal for the selected project and one window per spawned worker agent, streaming live.

Built 2026-09-11. Electron + xterm.js + node-pty, no bundler, no framework.

## Install

Download `Mission-Control-Setup-<version>.exe` from
<https://github.com/christianjayfababier/mission-control/releases> and run it. It installs **per user**, with
no administrator prompt, into `%LOCALAPPDATA%\Programs\mission-control` (the installer lets you pick a
different directory) and adds a **Mission Control** Start Menu shortcut. Uninstall from Settings -> Apps,
or with `Uninstall Mission Control.exe` in the install directory.

Mission Control drives tools that already live on the machine, so install these first:

New to Mission Control? **[docs/FIRST-RUN.md](docs/FIRST-RUN.md)** walks a second owner from this
download to their first Recall. The app helps too: on a machine with no projects yet it opens a four-step
**Setup** wizard by itself, which checks the four tools below, offers the optional AI tools and keys, and
adds the first project. **Settings -> About & diagnostics -> Run setup again** reopens it any time. `--view setup` opens the wizard for a
screenshot (and `--view setup-tools`, `setup-ai`, `setup-project` its later steps) without stamping anything.

- **Node.js 22 or newer** -- the lead and worker sessions run under it.
- **Git** -- branches, worktrees and the status reads behind the Explorer.
- **GitHub CLI** (`gh`), authenticated -- PR watch, `GH_TOKEN` per project.
- **Claude Code** (`claude`) -- the sessions themselves.

The build is not code-signed. The first time you run a given version SmartScreen shows *Windows protected
your PC*: choose **More info -> Run anyway**. It asks once per version, not once per launch.

Settings, projects, boards and the orchestrator kit live in `~/.claude/mission-control` and are untouched
by install, upgrade and uninstall.

## Updates

From 0.2.0 the app updates itself from the same releases page. It asks GitHub 20 seconds after start and
every four hours after that, downloads a newer installer in the background, and then waits: a chip in the
project header says **Update <version> ready: restart to install**, and only a click on it restarts the
app and installs. Mission Control never restarts on its own, and it refuses the restart while a terminal
is open or a worker is running -- the download stays on disk until the machine is quiet. **Settings ->
About & diagnostics** has a **Check for updates** button and the last result, so a check never has to wait
for the timer.

What ships an update is *publishing* the draft release: the tag `vX.Y.Z` builds the installer and opens a
**draft**, and installed copies see nothing until someone publishes it. The feed is `latest.yml`, uploaded
next to the exe; a release published without that file offers nobody anything. 0.1.0 has no updater, so
0.2.0 has to be installed over it by hand once.

## Launch

- Desktop shortcut **Mission Control** (points at `node_modules\electron\dist\electron.exe` with this folder as the app).
- Or `"C:\ClaudeApps\MissionControl\Mission Control.cmd"`, or `npm start` in this folder.
- `npm run screenshot` writes `screenshot.png` after 4.5 seconds and quits (used for testing).

## Layout

```
┌ Sidebar ─────────────┬ Header: project name · path · [Launch Claude here] [+ Terminal] [Open in VS Code] [Open folder] ┐
│ Projects             │ Tabs: Terminal 1 · Terminal 2 · Session 1: <title> · Session 2 …                                │
│  ● ConfereceApp      │ ┌──────────────────────────────────────────────────────────────────────────────────────────────┐ │
│    c:\laragon\www\…  │ │ PowerShell in the project directory (xterm.js + node-pty). Run `claude` here.                 │ │
│  ○ geracievents      │ │ Session tabs show the live transcript of a Claude session running anywhere (VS Code too).    │ │
│  ○ ALD-portal-fresh  │ └──────────────────────────────────────────────────────────────────────────────────────────────┘ │
│                      │ ═══ drag to resize ═══                                                                          │
│                      │ Workers                                                                                          │
│                      │ ┌ » backend-engineer  Discount codes  RUNNING 3m12s ┐ ┌ ✓ qa-engineer  CI harness  DONE 8m ┐     │
│ [+ Add folder]       │ │ 14:02:11 tool   Edit  app/Modules/…              │ │ 13:51:02 tool  Bash  pnpm test      │     │
│ ▸ Idle 5             │ │ 14:02:13 claude I'll add the migration request…  │ │ 13:59:40 claude All green.          │     │
└──────────────────────┴─┴──────────────────────────────────────────────────┴─┴─────────────────────────────────────┴─────┘
```

- **Sidebar:** two groups. **Active** holds every project with a session working, waiting or active in the last 6 hours; **Idle** (collapsed, with a count) holds the rest. Nothing is ever dropped: every project Mission Control has seen a session in is remembered in `~/.claude/mission-control/seen-projects.json`, so a project you have not touched for days is still one click away. Folders you add with **+ Add/create a project** are pinned (right-click to remove); a remembered project can be hidden with right-click and comes back when you add its folder again. Idle projects cost no GitHub polling. Green dot: a session is working now. Amber: a session finished its turn and is waiting for you. Badges: live sessions and running workers.
- **+ Add/create a project:** the button at the foot of the sidebar opens one dialog with three ways in. **Existing folder** is the old picker: choose a folder you already have and it is pinned, untouched. **New folder** asks for a parent folder and a name (checked against what Windows and the sidebar accept), creates it, and — both on by default — runs `git init` in it and writes a starter `CLAUDE.md` with the project name as its heading; a failed `git init` takes the folder away again, so nothing half-made reaches the sidebar. **From GitHub** takes a repository URL or `owner/name`, a parent folder, a folder name (the repository name unless you change it) and which GitHub account to clone as; Mission Control opens a terminal of its own in the parent folder with that account’s `GH_TOKEN` and runs `gh repo clone` there, so you watch the progress and can answer anything `gh` asks. The folder is pinned only when that terminal exits cleanly and the folder is really there; otherwise the dialog says the clone failed and the sidebar is unchanged.
- **Terminals:** selecting a project opens a PowerShell terminal in its directory. **Launch Claude here** starts `claude --session-id <uuid>` in it (a fresh session with a known id). **+ Terminal** adds more; each project keeps its terminals alive while you switch around.
- **Session tabs:** one per recent Claude session in that project, whether it runs in this app's terminal or in VS Code. They show the orchestrator's prompts, its messages, every tool call and every worker it spawned, live.
- **Orchestrator tab** (first tab of every project): the project's lead session. **Start a new day** runs `claude --session-id <uuid> --append-system-prompt-file ~/.claude/mission-control/orchestrator-system.md "<recall>"` in a terminal, so the lead starts with the Mission Control orchestrator rules and a **Recall** as its first message: read the memory brain (the automatic checkpoint and journal, the previous lead's handover note, the repo map), the project's CLAUDE.md, docs/ORCHESTRATOR.md, plan and board, list `.claude/agents|skills|commands`, map the repo through an Explore worker when memory has no fresh `repo-map`, report where things stand, then wait for orders. **Resume selected** continues an earlier conversation with its full history. Once the session answers, the tab becomes the conversation with a prompt bar. The rules come from `kit/orchestrator-system.md` (refreshed into `~/.claude/mission-control/orchestrator-system.md` at every start); put your own additions in `orchestrator-system.local.md` next to it, which is never overwritten. At launch both are combined with a project block (repo, branch, account, inbox script) into one generated file. Project-specific rules (CLAUDE.md, agents, a `/standup` that lives inside the repo) win on specifics; user-level `/standup` and `/wrapup` skills in `~/.claude` are ignored because they belong to one project. At the end of the day the lead writes a **Handover** note (`handover.md` in the project's memory: next action, decisions and why, open questions, traps) and announces it in the inbox; the next Recall starts from it. The lead's session id is remembered per project, so tomorrow the tab offers to resume it.
- **Repo & account** (header button): link the project to its GitHub repository (detected from the git remote, or typed) and choose which logged-in `gh` account commits and opens PRs for it (personal vs work). Mission Control puts that account's token and identity into the environment of every new terminal for the project (GH_TOKEN, GIT_AUTHOR_*/GIT_COMMITTER_*), so `gh`, `git commit` and `git push` act as that account while other projects keep theirs, with no global `gh auth switch`. Settings live in `~/.claude/mission-control/project-settings.json`. The header shows repo, branch and account; the lead is told all of it in its system prompt.
- **Pull requests:** open PRs of the linked repo are polled every minute (`gh pr list`) and shown as chips above the workers: number, title, branch, checks (✓ ✗ ⏳), review state, and which workers are on that branch. Each worker card also shows its model, its branch and the PR it belongs to, so parallel PR work is visible at a glance.
- **Inbox** (bottom of the sidebar): orchestrators post decisions, questions, announcements and blockers with `node ~/.claude/mission-control/mc-note.js decision|question|announce|blocker "Title" "Body" [--options "A|B"]`. You answer from the sidebar: click an option or type a reply. The answer is typed into the orchestrator's conversation when it runs in Mission Control (`Decision on "<title>": <answer>`); otherwise it waits in `notes.jsonl` and the orchestrator reads it with `mc-note.js answers`. The rules tell the lead to decide small reversible things itself and to ask through the inbox for scope, production, data, security, money and merges.
- **Tickets and Todos tabs** (per project): paste tickets or todos (bullets, numbered lines, or blank-line separated blocks) and they become board items; the orchestrator and workers read and write the same board with `node ~/.claude/mission-control/mc-board.js ticket|todo …`. Tickets carry type, priority, status, risk, doability, effort, a delivery estimate (ETA in calendar time with notes on what it covers and assumes; when work starts the ETA becomes a promised delivery date, shown amber within a day and red when passed), whether a migration, database update or heavy task is needed, affected areas, analysis, plan, branch and PR. **Send to orchestrator** asks the lead to analyze the open or selected tickets and record the results; you or the lead mark items done. Boards live in `~/.claude/mission-control/boards/<project-key>.json`. Run `mc-board.js` and `mc-note.js` from anywhere in the project, a worktree included; they resolve to the main checkout (a `.git` file pointing at `<main>/.git/worktrees/<name>`), so a command run in a worktree writes the project's board and not a phantom one. Pass `--project <path>` (or set `MC_PROJECT`) when in doubt, and `MC_DEBUG=1` to see the resolved project on stderr.
- **Rules tab** (per project, after Tickets and Todos): everything the lead of this project is told to obey, in three collapsible sections. **From the repo** lists the rule files a Recall reads — `CLAUDE.md`, `docs/ORCHESTRATOR.md`, the plan and progress mirrors, `CONTRIBUTING.md`, `docs/PITFALLS.md`, the PR template, and every file under `.claude/agents`, `.claude/skills` and `.claude/commands` — each with its first line and size; the candidates a repo does not have stay in the list, greyed and marked "not present". **Mission Control rules** points at the rulebook, your own additions for all projects (`orchestrator-system.local.md`, with **create** when it does not exist yet) and the prompt generated for the last lead launched here. Click any row to read it in the viewer on the right half: rendered markdown, **Open in VS Code**, and Esc or × to close. **Your rules for this project** is your own list — add one in plain language, click a rule to edit it, ↑/↓ to reorder, ✕ to remove. Rules are handed to the lead in its system prompt at every launch, above the model assignments, and they win over the general rules; **Tell the lead now** types one straight into a lead session that is already running. The lead writes here too, when you tell it to save something as a rule (`mc-board.js rule add`). Rules live in `~/.claude/mission-control/rules/<project-key>.json`; `--view rules` opens the tab with the first repo rule file in the viewer.
- **PR watch** (`prwatch.js`): the team's PRs are followed to production automatically. Watched PRs are those authored by the project's account, on a branch a worker or ticket is on, or registered by the lead with `mc-board.js watch add <pr>`. Mission Control posts to the inbox when checks pass or fail, reminds you to merge after 30 minutes green (with "Ask orchestrator to merge" as an option), announces the merge, then follows the merge commit's workflow runs and GitHub deployments until they finish and reports live or failed. State persists in `prwatch.json` so restarts do not repeat notes. The header shows **Team busy** (workers running, PRs awaiting merge or deploying) or **Team free**, so you know when to hand over the next task.
- **Rules:** the lead's generated prompt ends with an **Owner rules for this project** section built from the Rules tab, so rules you add there are binding at the lead's next launch or resume; **Tell the lead now** types a new rule into a running lead. Leads save a rule for you when you say "save this as a rule" (`mc-board.js rule add`). The tab also shows the repo's own rule files and this rulebook, read-only.
- **Sync and branches:** the rules require fetching origin at Recall and before every PR (pull fast-forward, rebase or merge main per the repo's rules), a local pre-flight run of the repo's CI script on the synced checkout, branches for all work with the lead choosing the branching model that keeps production safe, and a "team busy" answer when a new task arrives while work is in flight.
- **PR gate:** the rules require every PR to follow the repo's own process (CONTRIBUTING, PR template, PITFALLS, `.claude` commands/skills/agents), stay small and focused, carry no generated files, binaries or unjustified dependencies, keep CI cost flat (no memory-heavy tests or widened type-check scopes), be green locally with recorded commands, be secure by default, and carry evidence and the ticket id.
- **Team & models** (header button): every role the lead can dispatch, custom roles from the project's `.claude/agents` files and the built-in agent types, each with a model and effort you can set, next to Mission Control's recommendation and the reason for it (`team.js`). Changes to custom roles are written back into the agent file's frontmatter; built-in types are stored per project and handed to the lead in its system prompt. **Apply all recommendations** sets the whole team at once. The rules route research and documentation to Sonnet (medium), building and QA to Opus (high), schema and security to Fable (high), and let the lead escalate a looping worker to Fable.
- **Settings** (the ⚙ cog at the bottom of the sidebar, next to **+ Add/create a project**): the global dialog, in four sections. **Accounts & AI** is ten AI tools and their API keys, in three groups, with a filter box above them. *Required* is Claude Code and the GitHub CLI — version, and who is logged in (`claude auth status`, `gh auth status`, probed with a 5 s timeout, 15 s for Claude, in parallel and cached for a minute). *AI tools* is the Codex, Gemini, GitHub Copilot, Cursor, Cline, OpenCode, Aider, Goose and Ollama CLIs — each detected by its version line, each offering the vendor's own install and login command, and none of them nagging for a login it cannot start; Codex is also found at `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`, where the ChatGPT desktop app puts it off PATH. *API keys* is the Anthropic, OpenAI, Gemini, xAI, Mistral, DeepSeek, OpenRouter and Cursor keys: they are encrypted with Electron's `safeStorage` (Windows DPAPI) into `~/.claude/mission-control/secrets.json` — the plain text never reaches the disk or the renderer — and exported into every **new** terminal of a project that may use them (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and the rest); a variable your own shell already exports is never overwritten. **Install** and **Log in** run the vendor's own command (winget, or `gh auth login -w`, or `claude auth login`) in a real terminal tab of the selected project, so you can answer its prompts; when it exits the probes run again. **Global rules** edits `orchestrator-system.local.md`, your own additions to every lead's rulebook (they reach a lead at its next launch; main.js refuses to write any other file). **Hidden projects** lists what you took out of the sidebar, with a **Show again** button each. **About & diagnostics** has the version, the data directory and the kit file paths (`globalsettings.js`, `renderer/settings.js`).
- **AI Collaboration** (header button, per project): which of those tools and keys this project's lead and workers may use, one switch per provider. Everything is on until you switch it off; a provider that is switched off keeps its key out of this project while other projects keep it, and one you switch on that is not installed, not logged in or has no key says so in place, with the button that fixes it (`providers.js`, `secrets.js`, docs/ACCOUNTS-CONTRACT.md).
- **Delivery gate:** the rules make quality the lead's job before yours: builders ship with tests, a QA worker runs the affected suites, the end-to-end flow, new regression tests, a sanity pass of the running app and migration dry runs, security review covers sensitive paths, and the lead reviews the diff and re-runs CI before announcing a PR. You review and merge; you are not QA.
- **Memory is the brain:** `checkpoint.js` writes two notes into `~/.claude/projects/<slug>/memory/` for every project with sessions in the last 48 h (at startup and about 15 s after every turn and worker change), and points to both from `MEMORY.md`, which Claude Code loads into every session of that project. `mission-control-checkpoint.md` is the current state: repo and account, PRs in flight, open tickets and todos, inbox items waiting for you, and per session the last request, last message, what it was in the middle of, every worker with model, branch, task, status and last message. `mission-control-journal.md` is the history, appended day by day and kept for 45 days: owner requests, orchestrator answers, worker results, notes the orchestrator posted and the answers you gave, PR and deployment events, ticket and todo changes from either side. No model calls; nothing is guessed between sessions. The orchestrator's own durable knowledge (decisions, repo map, gotchas) is still written by it as ordinary memory notes, as the rules require.
- **Talking to the orchestrator:** when a session runs in one of this app's terminals, its Session tab has a prompt bar at the bottom. Type there and press Enter (Shift+Enter for a new line); the text goes to that terminal's Claude. Sessions started with **Launch Claude here** are linked by id; typing `claude` yourself is matched by start time. A session running elsewhere (VS Code, another console) is read-only here and shows **Take over here**, which opens a terminal and runs `claude --resume <id>`: close it where it runs first. A new session's tab appears after its first prompt, so type the first message in the terminal.
- **Names and avatars:** every orchestrator and worker gets a stable generated name, a title derived from its role (Lead Orchestrator, Backend Engineer, Codebase Scout…) and an inline SVG avatar, all derived from its id so they never change (`renderer/persona.js`). The lead is told its name at launch and signs notes with it.
- **Workers:** one window per subagent of the selected project, appearing the moment it is spawned: avatar, name and title, task, status (running pulses), duration, model, tool count, tokens, current tool, a **working on** line (branch, worktree, PR with checks and review, ticket) and a live log of tool calls and messages. Session panes carry the same header for the orchestrator, plus running workers and PRs in flight. Maximize with ⤢, hide with ×, or untick **finished workers** to keep only running ones. A finished worker is not gone: the lead can continue it with `SendMessage` to its agent id and the same window wakes up (its status returns to running), which the orchestrator rules ask it to do for follow-ups on the same work item.

- **Explorer** (header button, remembered per project): a second sidebar with the project's files and branches. **Files** is a lazy tree of the checkout with git marks right-aligned (M amber, A/U green, D red, R/C blue) and a dot on directories that contain changes, re-read every 3 seconds while the panel is open and the window is focused; ignored files are hidden until you tick **show ignored** in the ⋯ menu. Each row carries a pill per agent that touched that file: the Persona name, solid for an edit and hollow for a read, full colour while the agent runs and faded once it has finished, with ⑂ when the agent was working in another worktree of the same repo. Pills come from the agents' own tool calls, so files changed by shell commands show only their git mark (the panel header says so). Click a file to open it in VS Code, right-click for **Open in VS Code**, **Reveal in folder** and **Copy path**. **Branches** lists every branch, checked-out one first, then the ones with a worktree: worktree name, the PR badge for that branch, the agents on it, and `↑ahead ↓behind` the default branch; expand a branch to see the files it changes, and **Show files** points the tree at that worktree (with a link back to the project). `--view explorer` opens the panel for a screenshot, `--view explorer-branches` opens it on the Branches tab.

- **Team chat** (header button, remembered per project): a side panel where the project’s AI tools chat to each other about the work like colleagues — a thought, a question, the odd joke, now and then a suggestion. It is **read-only**: the agents get a briefing and answer one short line, they run no tools, they touch neither the board nor the repo, and nothing they say reaches your lead unless you press **Send to lead** on a suggestion, which pastes it into the composer for you to send yourself. The panel carries the label *brainstorm, unverified* for that reason. Switch it on per project with the **on** switch (off everywhere until you do), then invite tools with **+ add**, which offers exactly the AI CLIs that have a non-interactive command *and* are switched on for this project in **AI Collaboration** — that dialog decides which AIs may touch a project, and the chat obeys it: switch one off later and it stays in the roster marked *disabled* and never speaks again until you switch it back on. Each colleague gets its own Persona name, face and specialty, and a chip you can mute or remove. **Hiding the panel stops the agents** for that project and showing it starts them again, as does closing the app; history stays on disk for 30 days and comes back with the panel. Rounds are one agent at a time, every three to five minutes, plus one extra round when a ticket, a PR, a finished worker or an inbox note says something happened. Caps keep it cheap — six messages per colleague per hour, **four for Claude** because it is the one agent spending your Claude plan, and eighty per project per day, all counted in the footer — and free tiers are the point: the Gemini CLI free tier, Codex on your ChatGPT plan and local Ollama models cost nothing, and Claude in the chat is a colleague persona, never the lead, running on the smallest model. Ollama has no default model, so the panel asks which of your pulled models it may use. **Clear history** (two clicks) moves the file aside as a `.bak`. `--view chat` opens the panel for a screenshot.

## Memory view

The **Work | Memory** switch in the header swaps the right side for the selected project's memory: the notes Claude keeps in `~/.claude/projects/<slug>/memory/*.md` (one fact per file with `name`, `description`, `type` in the frontmatter and `[[links]]` between notes).

- **Graph:** a mind map with the project as the hub and one node per note, coloured by type (project, user, feedback, reference). Edges follow the `[[links]]`. A dashed grey node is a link to a note that has not been written yet. Drag nodes, scroll to zoom, double-click the background to reset, click a node to read it.
- **Detail panel:** the note's description, type, file and last update, its content rendered, the notes it links to and the notes that link to it, and **Open in VS Code** / **Open file**. With nothing selected it shows the project's `MEMORY.md` index with clickable entries.
- **List:** the same notes as cards, newest first. **Search** filters both views by name, description and content.
- The view refreshes every 5 seconds while open, so a memory Claude saves appears without a restart. `--view memory` opens the app straight into it; `--view idle` opens the collapsed Idle group (useful with `--screenshot`).

## How it knows what's running

Claude Code writes every session to `~/.claude/projects/<slug>/<session>.jsonl` and every subagent to `<slug>/<session>/subagents/agent-<id>.jsonl` (+ `.meta.json` with the role and task). `transcripts.js` tails those files incrementally and streams display-ready lines to the window over IPC. Workers are threads inside the orchestrator's process, so they have no terminal of their own; their windows are live transcript views, which is the same information a terminal would show.

## Files

```
main.js          Electron main: window, node-pty terminals, IPC, project registry, screenshot mode
transcripts.js   session/worker discovery and incremental tailing
checkpoint.js    writes the per-project mission-control-checkpoint.md memory note from the watcher's state
integrations.js  per-project settings, gh accounts/tokens/PRs, git info, inbox (notes.jsonl)
kit/mc-note.js   the orchestrator's CLI for posting to the inbox; copied to ~/.claude/mission-control/
boards.js        per-project tickets/todos store (JSON), polled for changes made by mc-board.js
prwatch.js       follows watched PRs: checks → merge reminder → merge → workflows/deployments, into the inbox
kit/mc-board.js  the orchestrator's CLI for the tickets/todos board; copied to ~/.claude/mission-control/
kit/mc-project.js  which project a kit CLI means (worktree -> main checkout); required by both CLIs, copied with them
renderer/board.js  Tickets and Todos tabs
renderer/explorer.js  Explorer panel: file tree with git marks and per-agent pills, and the Branches view
chat.js          team chat: the jsonl store, the briefing/parse/round-robin core and the round scheduler
renderer/chat.js  Team chat panel: roster chips, the message list and Send to lead
renderer/rules.js  Rules tab: repo rule files, the Mission Control rulebook, the owner's rules, and the markdown viewer
rules.js         owner-rules store, repo rule-file discovery, the viewer's sandboxed reader, the lead's rules block
explorer.js      git-backed file tree, status, branches and branch diffs for the Explorer panel
kit/orchestrator-system.md  default orchestrator rules, copied to ~/.claude/mission-control/ on first run
preload.js       contextBridge API (window.mc)
setup-lib.js     first-run wizard: where the data directory is (--data-dir) and whether setup should open
renderer/setup.js  the Setup wizard dialog: welcome, the four required tools, optional AI tools, first project
updater.js       auto-update: a pure state machine plus the electron-updater wiring; disabled unless packaged
diag.js          crash evidence: the main-process log, the renderer-gone recovery and the memory guard
renderer/        index.html, app.js (work view), memory.js (memory graph), styles.css (vanilla JS + xterm.js)
Mission Control.cmd   launcher
build/make-icon.js    draws build/icon.ico for the installer; dependency-free, re-run after editing it
build/check-version.js  the release guard: the pushed tag must name the version in package.json
CHANGELOG.md     what shipped in each version, newest first
```

State: `~/.claude/mission-control/projects.json` (added folders), `window.json` (window bounds),
`logs/main.log` (the crash log, see Troubleshooting), `chat/<project>.jsonl` (team chat history, pruned to 30 days).

## Tests

`npm test` runs `test/unit.js` (pure-function checks, milliseconds; today the PR watch's post-merge verdict) and then `test/smoke.js` (plain Node, no dependencies): it boots the app in screenshot mode into a
throwaway Chromium profile, waits ~3.5 s (`SMOKE_WAIT` overrides), captures the window to a PNG in the
system temp dir, and fails if Electron exits non-zero, the PNG is missing / tiny / not a PNG, or the
renderer logged an error. In screenshot mode `main.js` forwards console errors, renderer crashes and
preload failures as `RENDERER ERROR: ...` and exits 1, so the test catches things a human would otherwise
only see by looking -- such as a `<dialog>` staying visible after close. About 10 s end to end.

Known noise, not failures: with another Mission Control already running, Chromium prints *Unable to move
the cache: Access is denied* / *Gpu Cache Creation failed*, and node-pty's conpty helper prints *Error:
AttachConsole failed* at exit. The test filters those out.

GitHub Actions runs `npm test` on windows-latest for every pull request and every push to `main`
(`.github/workflows/smoke.yml`). CI does not rebuild node-pty for Electron, so terminals are unavailable
there; the app tolerates that and the smoke test does not depend on them.

## Build the installer

`npm run dist` builds the Windows NSIS installer with electron-builder and writes
`dist\Mission-Control-Setup-<version>.exe` (about 93 MB) next to its `.blockmap`; `npm run pack` stops at
the unpacked `dist\win-unpacked` folder, which is quicker when you only want to look inside the package.
The whole configuration is the `build` block in `package.json`. The icon is `build/icon.ico`, regenerated
by `node build/make-icon.js` -- dependency-free and drawn in code, so the only binary in the repo can be
rebuilt from source. `dist/` is gitignored; never commit it.

Three settings there are deliberate:

- `npmRebuild: false` -- node-pty 1.1.0 ships N-API prebuilds under
  `node_modules/node-pty/prebuilds/win32-x64` that load under both Node and Electron, and its npm tarball
  does not carry the winpty C++ sources, so a from-source rebuild fails on every machine including CI.
  There is nothing to rebuild.
- `publish` -- the GitHub provider, `christianjayfababier/mission-control`. It is what makes
  electron-builder write `latest.yml` next to the exe and bake `app-update.yml` into the package, which is
  the whole of what `electron-updater` reads. `npm run dist` still passes no `--publish`: the build never
  uploads anything, the release workflow does.
- `asarUnpack` -- node-pty's `.node` binaries, `winpty.dll`, `winpty-agent.exe` and the conpty
  `OpenConsole.exe` have to sit on disk outside the asar or Windows cannot load them.

Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml` on windows-latest: `node
build/check-version.js` first (the tag has to name the version in `package.json`, or the update feed would
advertise a download that does not exist), then `npm ci`, `npm run dist`, the exe, the blockmap and
`latest.yml` uploaded as a workflow artifact, then a **draft** GitHub release created with all three
attached. It stays a draft until someone publishes it by hand -- and publishing it is what hands the
update to every installed copy.

## Troubleshooting

- **The app vanished or restarted and you want to know why**: read `%USERPROFILE%\.claude\mission-control\logs\main.log` (Settings → About & diagnostics shows the path, its size and an **Open log** button). The launcher `start`s electron.exe, so stderr goes nowhere — this file is the evidence. One line per event, `<ISO time> pid=<pid> <level> <event> <detail>`; every line carries the pid because the installed app and a worktree run share the same file. It rotates at 1 MB into `main.log.1`.
  - `startup` / `will-quit` / `quit` — a clean exit always ends in `will-quit`, so a run that simply stops is a crash.
  - `render-process-gone` — the window died: reason and exit code, plus the last memory sample. The window is reloaded once after a second and says so in a header banner.
  - `uncaught-exception` / `unhandled-rejection` — in a packaged app these are logged and the app keeps running (no "A JavaScript error occurred in the main process" box nobody is there to click); a development run still gets the box.
  - `memory` — the guard samples every minute and logs when the Windows commit charge is at 80 % or more, or free RAM is under 1.5 GB, at most once every five minutes. A **Low system memory** chip appears in the project header with the numbers in its tooltip. The 2026-09-12 restarts were exactly this: 52 of 65 GB committed by stale dev servers (80.0 %, about 4 GB free, then under 1 GB), and the app disappeared without a word. Both thresholds are set so that sample trips them.
  - To prove the recovery path on purpose, start the app with `MC_DIAG_CRASH_TEST=1` (optionally `MC_DIAG_CRASH_AFTER_MS`); it crashes its own renderer once, a few seconds after the window opens.
- **Trying a fresh install without losing the one you have**: start the app with `--data-dir <path>` and every
  file Mission Control owns moves there for that run -- the project registry, settings, boards, notes, PR watch,
  the orchestrator kit copied in at every start, and a Chromium profile of its own so it does not fight the
  running app's cache. `~/.claude/mission-control` is not read and not written. Because the registry is empty,
  the Setup wizard opens by itself, which is how it is verified:
  `env -u ELECTRON_RUN_AS_NODE npx electron . --data-dir C:\Temp\mc-fresh --screenshot fresh.png --wait 8000`.
  Claude Code's transcripts are not ours and stay in `~/.claude/projects`, so a trial run still sees the
  sessions on this machine; only what Mission Control itself keeps moves. Delete the directory when done.
  Without the flag nothing changes.
- **Looking at the update chip and its restart dialog in development**: a development run can never download a release, so start it with `MC_UPDATE_FAKE_READY=0.9.9` (unpackaged runs only; a packaged build ignores it). The updater goes straight to `ready` for that version, the header chip and **Settings → About** show it with the live terminal and worker counts, and clicking the chip opens the real restart confirmation. Nothing is downloaded and nothing restarts: the install answers `not packaged`, after logging the attempt like any other.
- **"Terminals are unavailable"**: node-pty's native binary did not load for this Electron version. Run `npx @electron/rebuild -f -w node-pty` in this folder (needs Visual Studio Build Tools with the C++ workload, present on this machine).
- Long messages arriving without their beginning: Claude Code's Windows TUI keeps only the last 1024-byte ConPTY chunk of a single write, so the composer, inbox answers and pastes into a terminal are written in 512-byte slices with a 25 ms gap (`writeText` in `renderer/app.js`).
- `test/pty-paste-harness.js` checks that against a real TUI. It is manual and costs a few haiku turns: `ELECTRON_RUN_AS_NODE=1 npx electron test/pty-paste-harness.js [trusted-folder]`. It prints INTACT/TRUNCATED per case and deletes the session transcript it made.
- Blank sidebar: no sessions seen yet on this machine; add a folder, or expand **Idle** if projects are only remembered.
- The old terminal-only dashboard remains at `%USERPROFILE%\.claude\mission-control\mission-control.cmd`.

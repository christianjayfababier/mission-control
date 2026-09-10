# Mission Control (desktop)

A Windows desktop app with real terminals inside it: projects and their directories in the left sidebar; on the right, the orchestrator's terminal for the selected project and one window per spawned worker agent, streaming live.

Built 2026-09-11. Electron + xterm.js + node-pty, no bundler, no framework.

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
│ [ ] show idle        │ │ 14:02:13 claude I'll add the migration request…  │ │ 13:59:40 claude All green.          │     │
└──────────────────────┴─┴──────────────────────────────────────────────────┴─┴─────────────────────────────────────┴─────┘
```

- **Sidebar:** every project with Claude Code activity in the last 48 hours (discovered from `~/.claude/projects`), plus folders you add with **+ Add folder** (pinned; right-click to remove). Green dot: a session is working now. Amber: a session finished its turn and is waiting for you. Badges: live sessions and running workers.
- **Terminals:** selecting a project opens a PowerShell terminal in its directory. **Launch Claude here** starts `claude --session-id <uuid>` in it (a fresh session with a known id). **+ Terminal** adds more; each project keeps its terminals alive while you switch around.
- **Session tabs:** one per recent Claude session in that project, whether it runs in this app's terminal or in VS Code. They show the orchestrator's prompts, its messages, every tool call and every worker it spawned, live.
- **Orchestrator tab** (first tab of every project): the project's lead session. **Start a new day** runs `claude --session-id <uuid> --append-system-prompt-file ~/.claude/mission-control/orchestrator-system.md "<standup>"` in a terminal, so the lead starts with the Mission Control orchestrator rules and a standup as its first message: read memory and the automatic checkpoint, the project's CLAUDE.md, docs/ORCHESTRATOR.md, plan and board, list `.claude/agents|skills|commands`, map the repo through an Explore worker when memory has no fresh `repo-map`, report where things stand, then wait for orders. **Resume selected** continues an earlier conversation with its full history. Once the session answers, the tab becomes the conversation with a prompt bar. The rules come from `kit/orchestrator-system.md` (refreshed into `~/.claude/mission-control/orchestrator-system.md` at every start); put your own additions in `orchestrator-system.local.md` next to it, which is never overwritten. At launch both are combined with a project block (repo, branch, account, inbox script) into one generated file. Project-specific rules (CLAUDE.md, `/standup`, agents) win on specifics. The lead's session id is remembered per project, so tomorrow the tab offers to resume it.
- **Repo & account** (header button): link the project to its GitHub repository (detected from the git remote, or typed) and choose which logged-in `gh` account commits and opens PRs for it (personal vs work). Mission Control puts that account's token and identity into the environment of every new terminal for the project (GH_TOKEN, GIT_AUTHOR_*/GIT_COMMITTER_*), so `gh`, `git commit` and `git push` act as that account while other projects keep theirs, with no global `gh auth switch`. Settings live in `~/.claude/mission-control/project-settings.json`. The header shows repo, branch and account; the lead is told all of it in its system prompt.
- **Pull requests:** open PRs of the linked repo are polled every minute (`gh pr list`) and shown as chips above the workers: number, title, branch, checks (✓ ✗ ⏳), review state, and which workers are on that branch. Each worker card also shows its model, its branch and the PR it belongs to, so parallel PR work is visible at a glance.
- **Inbox** (bottom of the sidebar): orchestrators post decisions, questions, announcements and blockers with `node ~/.claude/mission-control/mc-note.js decision|question|announce|blocker "Title" "Body" [--options "A|B"]`. You answer from the sidebar: click an option or type a reply. The answer is typed into the orchestrator's conversation when it runs in Mission Control (`Decision on "<title>": <answer>`); otherwise it waits in `notes.jsonl` and the orchestrator reads it with `mc-note.js answers`. The rules tell the lead to decide small reversible things itself and to ask through the inbox for scope, production, data, security, money and merges.
- **Tickets and Todos tabs** (per project): paste tickets or todos (bullets, numbered lines, or blank-line separated blocks) and they become board items; the orchestrator and workers read and write the same board with `node ~/.claude/mission-control/mc-board.js ticket|todo …`. Tickets carry type, priority, status, risk, doability, effort, a delivery estimate (ETA in calendar time with notes on what it covers and assumes; when work starts the ETA becomes a promised delivery date, shown amber within a day and red when passed), whether a migration, database update or heavy task is needed, affected areas, analysis, plan, branch and PR. **Send to orchestrator** asks the lead to analyze the open or selected tickets and record the results; you or the lead mark items done. Boards live in `~/.claude/mission-control/boards/<project-key>.json`.
- **PR watch** (`prwatch.js`): the team's PRs are followed to production automatically. Watched PRs are those authored by the project's account, on a branch a worker or ticket is on, or registered by the lead with `mc-board.js watch add <pr>`. Mission Control posts to the inbox when checks pass or fail, reminds you to merge after 30 minutes green (with "Ask orchestrator to merge" as an option), announces the merge, then follows the merge commit's workflow runs and GitHub deployments until they finish and reports live or failed. State persists in `prwatch.json` so restarts do not repeat notes. The header shows **Team busy** (workers running, PRs awaiting merge or deploying) or **Team free**, so you know when to hand over the next task.
- **Sync and branches:** the rules require fetching origin at standup and before every PR (pull fast-forward, rebase or merge main per the repo's rules), a local pre-flight run of the repo's CI script on the synced checkout, branches for all work with the lead choosing the branching model that keeps production safe, and a "team busy" answer when a new task arrives while work is in flight.
- **PR gate:** the rules require every PR to follow the repo's own process (CONTRIBUTING, PR template, PITFALLS, `.claude` commands/skills/agents), stay small and focused, carry no generated files, binaries or unjustified dependencies, keep CI cost flat (no memory-heavy tests or widened type-check scopes), be green locally with recorded commands, be secure by default, and carry evidence and the ticket id.
- **Team & models** (header button): every role the lead can dispatch, custom roles from the project's `.claude/agents` files and the built-in agent types, each with a model and effort you can set, next to Mission Control's recommendation and the reason for it (`team.js`). Changes to custom roles are written back into the agent file's frontmatter; built-in types are stored per project and handed to the lead in its system prompt. **Apply all recommendations** sets the whole team at once. The rules route research and documentation to Sonnet (medium), building and QA to Opus (high), schema and security to Fable (high), and let the lead escalate a looping worker to Fable.
- **Delivery gate:** the rules make quality the lead's job before yours: builders ship with tests, a QA worker runs the affected suites, the end-to-end flow, new regression tests, a sanity pass of the running app and migration dry runs, security review covers sensitive paths, and the lead reviews the diff and re-runs CI before announcing a PR. You review and merge; you are not QA.
- **Memory is the brain:** `checkpoint.js` writes two notes into `~/.claude/projects/<slug>/memory/` for every project with sessions in the last 48 h (at startup and about 15 s after every turn and worker change), and points to both from `MEMORY.md`, which Claude Code loads into every session of that project. `mission-control-checkpoint.md` is the current state: repo and account, PRs in flight, open tickets and todos, inbox items waiting for you, and per session the last request, last message, what it was in the middle of, every worker with model, branch, task, status and last message. `mission-control-journal.md` is the history, appended day by day and kept for 45 days: owner requests, orchestrator answers, worker results, notes the orchestrator posted and the answers you gave, PR and deployment events, ticket and todo changes from either side. No model calls; nothing is guessed between sessions. The orchestrator's own durable knowledge (decisions, repo map, gotchas) is still written by it as ordinary memory notes, as the rules require.
- **Talking to the orchestrator:** when a session runs in one of this app's terminals, its Session tab has a prompt bar at the bottom. Type there and press Enter (Shift+Enter for a new line); the text goes to that terminal's Claude. Sessions started with **Launch Claude here** are linked by id; typing `claude` yourself is matched by start time. A session running elsewhere (VS Code, another console) is read-only here and shows **Take over here**, which opens a terminal and runs `claude --resume <id>`: close it where it runs first. A new session's tab appears after its first prompt, so type the first message in the terminal.
- **Names and avatars:** every orchestrator and worker gets a stable generated name, a title derived from its role (Lead Orchestrator, Backend Engineer, Codebase Scout…) and an inline SVG avatar, all derived from its id so they never change (`renderer/persona.js`). The lead is told its name at launch and signs notes with it.
- **Workers:** one window per subagent of the selected project, appearing the moment it is spawned: avatar, name and title, task, status (running pulses), duration, model, tool count, tokens, current tool, a **working on** line (branch, worktree, PR with checks and review, ticket) and a live log of tool calls and messages. Session panes carry the same header for the orchestrator, plus running workers and PRs in flight. Maximize with ⤢, hide with ×, or untick **finished workers** to keep only running ones.

## Memory view

The **Work | Memory** switch in the header swaps the right side for the selected project's memory: the notes Claude keeps in `~/.claude/projects/<slug>/memory/*.md` (one fact per file with `name`, `description`, `type` in the frontmatter and `[[links]]` between notes).

- **Graph:** a mind map with the project as the hub and one node per note, coloured by type (project, user, feedback, reference). Edges follow the `[[links]]`. A dashed grey node is a link to a note that has not been written yet. Drag nodes, scroll to zoom, double-click the background to reset, click a node to read it.
- **Detail panel:** the note's description, type, file and last update, its content rendered, the notes it links to and the notes that link to it, and **Open in VS Code** / **Open file**. With nothing selected it shows the project's `MEMORY.md` index with clickable entries.
- **List:** the same notes as cards, newest first. **Search** filters both views by name, description and content.
- The view refreshes every 5 seconds while open, so a memory Claude saves appears without a restart. `--view memory` opens the app straight into it.

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
renderer/board.js  Tickets and Todos tabs
kit/orchestrator-system.md  default orchestrator rules, copied to ~/.claude/mission-control/ on first run
preload.js       contextBridge API (window.mc)
renderer/        index.html, app.js (work view), memory.js (memory graph), styles.css (vanilla JS + xterm.js)
Mission Control.cmd   launcher
```

State: `~/.claude/mission-control/projects.json` (added folders), `window.json` (window bounds).

## Troubleshooting

- **"Terminals are unavailable"**: node-pty's native binary did not load for this Electron version. Run `npx @electron/rebuild -f -w node-pty` in this folder (needs Visual Studio Build Tools with the C++ workload, present on this machine).
- Blank sidebar: no sessions in the last 48 hours; tick **show idle** or add a folder.
- The old terminal-only dashboard remains at `C:\Users\chris\.claude\mission-control\mission-control.cmd`.

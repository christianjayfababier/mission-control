# Plan — Mission Control

Owner: Christian. Lead: Skye. Updated 2026-09-12 (afternoon: installer batch proposed).

## Goal
Every project opened in Mission Control gets a lead that recalls the project from its memory
brain, briefs the owner, plans, and leads workers; the app itself must not lose projects or bury
finished work, and must catch UI regressions before a PR.

## Branching model
Feature branches from `main`, one per work item, one PR each. Workers build in worktrees under
`C:\ClaudeApps\worktrees\mc-<slug>` with `node_modules` junctioned from the main checkout. Merge
order when branches touch the same file: smoke test first (adds `npm test`), then UI, then kit.
The owner merges; a merged change is live after the owner restarts the app.

## Work items (2026-09-12)
| Ticket | Item | Branch | Owner | Done when |
| --- | --- | --- | --- | --- |
| T-004 | Recall and Handover replace "standup"/"wrapup" in the kit; user-level `/standup` and `/wrapup` ignored; worker reuse rule | `feat/recall-handover-kit` | Skye | A fresh lead in any project runs the Recall even with the ALD `/standup` installed; kit text reviewed; README updated |
| T-008 | Repo scaffold: `CLAUDE.md`, `docs/PLAN.md`, `docs/PROGRESS.md` | `feat/recall-handover-kit` | Skye | Files exist, the Recall step 2 finds them |
| T-005 | Sidebar keeps every project seen; Active and Idle groups | `feat/sidebar-workers-hygiene` | opus worker | Screenshot shows an Idle group with a seen project; no extra GitHub polling for idle projects |
| T-006 | Finished workers list (reverted at the owner's request; original panes and "finished workers" checkbox stay) | `feat/sidebar-workers-hygiene` | opus worker | A resumed worker returns to running status; layout unchanged from main |
| T-007 | `npm test` smoke test with renderer-error capture; windows-latest workflow | `feat/smoke-test` | opus worker | `npm test` passes on main and fails on an injected renderer error; workflow runs on the PR |

## Work items (2026-09-12, evening): Explorer panel (approved by the owner)
A VS Code-style Explorer per project: header toggle, second sidebar after the project list, hideable per project.
Files view with git marks and pills naming the workers on each file; Branches view with workers, PRs and changed
files. Contract: `docs/EXPLORER-CONTRACT.md`.

| Ticket | Item | Branch | Owner | Done when |
| --- | --- | --- | --- | --- |
| T-011 | Data: files touched per agent from transcripts, worktree mapping, explorer IPC (list/status/branches/diff), open:file, unit tests | `feat/explorer-data` | opus builder B | `npm test` passes with new unit checks for porcelain parsing, name-status parsing and rel-path mapping; IPC returns per contract on this repo and on a worktree |
| T-010 | Explorer panel, toggle, lazy tree, marks, pills, open in VS Code | `feat/explorer-ui` | opus builder A | Screenshot `--view explorer` shows the panel with marks on a dirty checkout and a pill for a running worker; toggle state survives restart |
| T-012 | Branches view, changed files, switch tree to a worktree | `feat/explorer-ui` | builder A after T-010 | Screenshot shows branches with pills, PR badge and changed files |

Integration: when B is done, A merges `feat/explorer-data` into `feat/explorer-ui`; one PR from `feat/explorer-ui`
after QA and the owner's look at a demo window. Decisions: reads count as "working on" but drawn hollow; panel width
fixed at 280px; no new dependencies; shell edits are invisible and the UI says so.

## Work items (2026-09-12, night): Rules tab (approved by the owner)
A **Rules** tab after Tickets and Todos: the repo's rule files the Recall reads (read-only, viewable), Mission Control's
rulebook and the owner's global additions, and per-project owner rules that are appended to the lead's generated prompt
at launch. Contract: `docs/RULES-CONTRACT.md`.

| Ticket | Item | Branch | Owner | Done when |
| --- | --- | --- | --- | --- |
| T-013 | Rules store, IPC, repo rule-file discovery, prompt injection, `mc-board.js rule`, unit tests | `feat/rules-data` | opus builder B | `npm test` green with checks for discovery, renderOwnerRules and CLI; a generated prompt contains the owner rules |
| T-014 | Rules tab UI: three sections, viewer, add/edit/remove/reorder, Tell the lead now | `feat/rules-ui` | opus builder A | Screenshot `--view rules` shows all three sections on this repo with one owner rule |
| T-015 | Kit paragraph (save owner rules on request, obey the Owner rules section) and README | `feat/rules-ui` | Skye | Kit text present; README describes the tab |

Integration as for the Explorer: A merges `feat/rules-data`, one PR from `feat/rules-ui` after QA and the owner's look.
Decisions: repo rule files are read-only in the tab; rules are plain text; per-project only (global rules live in
`orchestrator-system.local.md`, which the tab shows and opens).

## Non-goals
No new dependencies. No redesign of the terminal panes. No change to the checkpoint or journal
format. No automatic merging.

## Risks
- Kit changes reach leads only after an app restart; running leads keep the old prompt.
- node-pty may fail to build on CI; the smoke test must pass with terminals unavailable.
- The three branches touch `main.js` and `renderer/app.js` in different regions; merge in the order above.

## Work items (2026-09-12, afternoon): Installer, Accounts & AI settings, updates (awaiting the owner's approval)
Goal: a second owner installs Mission Control from a `.exe`, logs in to Claude, GitHub and any AI CLI they own from a
Settings screen, adds a project, and gets the same lead workflow (Recall, plan, workers, rules, board, handover) that this
repo runs today. Updates ship from GitHub and install on restart. The kit is unchanged: it already defines the workflow,
and `ensureKit` copies it into the data dir at every start, so a fresh install behaves like this machine minus the memory,
which the Recall rebuilds (repo map worker, empty board, first handover).

Decisions to confirm (decision notes in the inbox): packaging with `electron-builder` (NSIS, per-user, no admin) and
`electron-updater` as the only new dependencies; a public releases-only repo (`mission-control-releases`) for installers and auto-update, created after the owner has
tried the installer locally; the source repo stays private; unsigned builds for now (SmartScreen warns
once) unless the owner buys a code-signing certificate.

| Ticket | Item | Branch | Owner | Done when |
| --- | --- | --- | --- | --- |
| T-019 | Provider registry and **Accounts & AI** settings: `providers.js` (Claude, GitHub CLI, Codex, Gemini, others: detect, login command, key env var, winget id); status per provider; "Log in" opens an embedded terminal with the provider's login flow; API keys encrypted with Electron `safeStorage` into `secrets.json`; keys and tokens injected per PTY like `GH_TOKEN` today | `feat/accounts-settings` | opus builder A | Screenshot `--view accounts` shows every provider with installed/logged-in state; a key saved in the tab appears in a new terminal's env and never in plain text on disk; unit tests for the registry and env assembly |
| T-020 | First-run **Setup** wizard: prerequisites (Node, Git, GitHub CLI, Claude Code) with winget install buttons, accounts step (reuses T-019), add first project, explains the lead workflow; re-openable from Settings | `feat/setup-wizard` | opus builder B after T-019 | Screenshot `--view setup` on an empty data dir shows the wizard; with everything present it is skipped; the kit is copied and the first Recall runs on the added project |
| T-021 | Packaging: `electron-builder` NSIS per-user installer, `asarUnpack` for node-pty, kit read from app resources, `npm run dist`; release workflow on tag `v*` on windows-latest uploading the installer to the releases repo | `feat/installer` | opus builder C (parallel, disjoint files) | Installer built on CI; installed on a clean Windows Sandbox: app starts, terminals work, kit lands in the data dir, `npm test` unaffected |
| T-022 | Auto-update: `electron-updater` against the releases repo; "Update ready, restart to install" banner; never restarts while a lead or worker is running; manual "Check for updates" in Settings | `feat/auto-update` | builder C after T-021 | A test release with a bumped version is offered, installs on restart, sessions and data dir survive |
| T-023 | Docs: README Install and Updates sections, `CHANGELOG.md`, first-run guide for a second owner; progress board flips (D-009) | `feat/installer` | Skye | A person who has never seen the repo installs and reaches the first Recall from the README alone |

Order: T-019 and T-021 in parallel (settings vs build config, no shared files except `package.json` scripts, owned by C),
then T-020 and T-022, then T-023. Each PR gets a demo window or an installed build for the owner's look before review.
Non-goals for this batch: Export/Import of the data dir (later todo), non-Claude workers in the grid, the per-project
"External AI allowed" flag (comes with the AI plan).

## Work items (2026-09-13): Team chat (approved by the owner)
A hideable second sidebar where the project's AI agents chat casually about the project, for the human to monitor; read-only,
human-gated forwarding to the lead; per-project enable, roster and mute; hide stops, show resumes; free tiers and hard caps.
Contract: `docs/TEAM-CHAT-CONTRACT.md`. Claude stays the only actor in Mission Control.

| Ticket | Item | Branch | Owner | Done when |
| --- | --- | --- | --- | --- |
| T-027 | chat.js store, scheduler, briefing and caps; renderer panel with roster, suggestions and Send to lead; fixture view | `feat/team-chat` | opus builder | Owner enables the chat for a project, adds two agents, sees a greeting round, hides the panel and sees rounds stop, forwards a suggestion into the composer; `npm test` green; `--view chat` screenshot |
| T-028 | Updater restart guard: workers only, confirm terminal closures | `fix/t-028-updater-busy` | opus builder | Chip opens a confirmation with live counts; forced restart logged; unit checks for the blocker rules |

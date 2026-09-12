# Changelog

All notable changes to Mission Control. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the versions are [semantic](https://semver.org/spec/v2.0.0.html).

A version ships when the owner publishes the draft GitHub release that pushing the tag `vX.Y.Z` created;
installed copies pick it up from `latest.yml` in that release within four hours.

## [Unreleased]

### Added

- A copy started from the checkout now says so: a muted **dev · <version>** chip in the project header and
  **(dev)** in the window title, so it is never mistaken for the installed Mission Control (T-029).
- **Global rules** keeps track of unsaved edits: while the textarea differs from the file on disk the section
  is marked **unsaved** and **Save** lights up, and leaving it — another section, **Done**, Esc or **Reload
  from disk** — asks inline first (**Save / Discard / Keep editing**) instead of dropping the text (T-029).
- **First-run Setup wizard**: on a machine with no projects and no completed setup, Mission Control opens a
  four-step wizard by itself — what the app is, the four tools it needs (**Node.js**, **Git**, the **GitHub
  CLI** and **Claude Code**, with Install and Log in buttons that open a real terminal and run the command),
  the optional AI tools and API keys, and the first project. **Next** on the tools step stays disabled until
  all four are ready and says in one sentence what is still blocking. Node.js and Git joined the provider
  registry as required tools, so **Settings → Accounts & AI** now checks them too. **Settings → About &
  diagnostics → Run setup again** reopens the wizard; finishing it is recorded in `settings.json` and it never
  opens by itself again (T-020).
- **`--data-dir <path>`**: a start-up flag that moves everything Mission Control owns — registry, settings,
  boards, notes, PR watch, the orchestrator kit and a Chromium profile of its own — somewhere else for that
  run, so a fresh install can be tried on a machine that already has one. Without the flag nothing changes
  (T-020, README → Troubleshooting).
- **[docs/FIRST-RUN.md](docs/FIRST-RUN.md)**: a guide a second owner follows from the download to their first
  Recall — installing past SmartScreen, the wizard, signing in to Claude Code and the GitHub CLI, adding a
  project, **Start a new day**, what the lead does at Recall, where the board, inbox, rules, Team chat and
  Settings live, how updates arrive, and where the crash log is (T-023).

### Fixed

- The smoke test no longer guesses when the app is ready: with `--view` the screenshot is taken when the
  renderer reports the view is on screen (plus a 300 ms settle) instead of when `--wait` runs out, which stays
  the upper bound. It also fails a blank capture (the PNG must be over 20 KB) and prints the `VIEW READY`
  timing line, and `SMOKE_VIEW=<view>` runs the same check against a view (T-029).

## 0.2.2 - 2026-09-13

### Added

- **Team chat**: a hideable side panel where the project’s AI tools chat to each other about the work like
  colleagues. Read-only by construction — the agents run no tools and write nothing; a suggestion reaches the
  lead only when you press **Send to lead**, which pastes it into the composer for you to send. Off per project
  until you switch it on, stopped while the panel is hidden, limited to the tools **AI Collaboration** allows for
  that project, and capped per agent per hour (four for Claude, six for the rest) and per project per day,
  and built around free tiers (Claude joins as a colleague on the smallest model, never as the lead) (T-027).

### Fixed

- The update chip no longer refuses to restart because a terminal is open anywhere in Mission Control.
  Busy now means a worker is mid-task; terminals are counted, not a blocker (quitting kills them anyway
  and a Claude session resumes). Clicking the ready chip opens a confirmation that says what the
  restart costs — how many terminals close, how many workers are still running — with **Restart anyway**
  available while workers run, and the counts stay fresh as terminals open and close (T-028).

## 0.2.1 - 2026-09-13

### Added

- A main-process crash log at `~/.claude/mission-control/logs/main.log`: one line per event with the
  process id, rotated at 1 MB. It records startup, uncaught exceptions, unhandled rejections, a dead
  renderer (reason and exit code, then one reload and a **The window crashed and was reloaded** banner)
  and every step of a clean exit, so a run that simply stops is now visibly a crash. **Settings >
  About** shows the path, its size, an **Open log** button and the last memory sample (T-024).
- A **Low system memory** chip in the project header, from a memory guard that samples the Windows
  commit charge and free RAM every minute and warns at 80 % committed or under 1.5 GB free — the
  conditions under which the app vanished twice on 2026-09-12 without leaving a trace (T-024).

### Fixed

- `mc-board.js` and `mc-note.js` resolve a worktree back to its main checkout, so a lead running them
  from `C:\ClaudeApps\worktrees\...` writes to the project's real board instead of a phantom one
  ([#14](https://github.com/christianjayfababier/mission-control/pull/14), T-026).

## [0.2.0] - 2026-09-12

The first version that can replace itself, and the first with a settings dialog.

### Added

- Auto-update from GitHub Releases: the app checks on start and every four hours, downloads in the
  background and offers **Update ready: restart to install** in the header. It never restarts on its own,
  and it refuses to restart while a terminal is open or a worker is running. **Settings > About** has a
  **Check for updates** button and the last result (T-022).
- **Add/create a project** in three modes: pick an existing folder, make a new one with `git init` and a
  starter `CLAUDE.md`, or clone a GitHub repository in a terminal you can watch
  ([#11](https://github.com/christianjayfababier/mission-control/pull/11), T-025).
- **Settings** behind the cog: **Accounts & AI** with eleven AI tools and eight API keys (encrypted with
  Windows DPAPI via `safeStorage`, exported per terminal), **Global rules**, **Hidden projects** and
  **About & diagnostics**; per-project **AI Collaboration** toggles
  ([#10](https://github.com/christianjayfababier/mission-control/pull/10), T-019).
- A per-user NSIS installer built by `npm run dist`, and a release workflow triggered by pushing a tag
  ([#9](https://github.com/christianjayfababier/mission-control/pull/9), T-021).
- **Rules**: repo rule files, the rulebook and per-project owner rules, injected into the lead's prompt
  ([#6](https://github.com/christianjayfababier/mission-control/pull/6), T-013, T-014, T-015).
- **Explorer**: the file tree with git marks and worker pills, and a Branches view
  ([#5](https://github.com/christianjayfababier/mission-control/pull/5), T-010, T-011, T-012).
- The sidebar remembers every project a session was ever seen in, grouped Active and Idle, and detects a
  worker that can be resumed ([#3](https://github.com/christianjayfababier/mission-control/pull/3),
  T-005, T-006).
- **Recall** and **Handover** replace standup and wrapup in the orchestrator kit, with the worker-reuse
  rule and the repo scaffold ([#2](https://github.com/christianjayfababier/mission-control/pull/2),
  T-004, T-008).
- A smoke test that boots the app in screenshot mode and fails on any renderer error
  ([#1](https://github.com/christianjayfababier/mission-control/pull/1), T-007).

### Fixed

- The packaged app could not start: `providers.js`, `secrets.js`, `globalsettings.js` and
  `newproject-lib.js` arrived in the app but were never added to the electron-builder file list, so an
  installed Mission Control threw `Cannot find module './providers'` at the first require and never drew a
  window. A unit check now fails when a module `main.js` or `preload.js` requires is not packaged (T-022).
- Long composer messages, inbox answers and pastes reached Claude Code without their beginning: Windows
  ConPTY keeps only the last 1024-byte chunk of a single write, so text now goes out in 512-byte slices
  ([#8](https://github.com/christianjayfababier/mission-control/pull/8), T-018).
- Renderer overflow: the PR strip wraps and stays inside the window, and sidebar rows and inbox cards no
  longer overflow ([#7](https://github.com/christianjayfababier/mission-control/pull/7), T-016, T-017).
- PR watch called a merge blocked when its workflow run had merely been cancelled by a newer push; a
  cancelled run is now *superseded*, not failed
  ([#4](https://github.com/christianjayfababier/mission-control/pull/4), T-009).

## [0.1.0] - 2026-09-11

The first packaged Mission Control: projects and their terminals in one window, the orchestrator kit, the
inbox, boards, PR watch and the memory writer. Installed by hand from `Mission-Control-Setup-0.1.0.exe`;
this version has no auto-update, so 0.2.0 has to be installed over it by hand as well.

[Unreleased]: https://github.com/christianjayfababier/mission-control/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/christianjayfababier/mission-control/releases/tag/v0.2.0
[0.1.0]: https://github.com/christianjayfababier/mission-control/releases/tag/v0.1.0

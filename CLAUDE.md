# Mission Control — rules for Claude sessions in this repo

Mission Control is an Electron desktop app that supervises Claude Code lead sessions and their
workers per project. This file is for whoever works on Mission Control itself. The orchestrator
rules that Mission Control gives to leads of *other* projects live in `kit/orchestrator-system.md`.

## Prime directives
1. **Vanilla stack, on purpose.** Plain JS (CommonJS in main/kit, plain `<script>` globals in
   `renderer/`), one hand-written `renderer/styles.css`, no bundler, no framework, no TypeScript.
   Do not add a dependency without a decision note in the inbox; prefer what is already here.
2. **Nothing lands on `main` directly.** Branch per work item (`feat/<slug>`, `fix/<slug>`),
   worktree per worker under `C:\ClaudeApps\worktrees\mc-<slug>` (junction `node_modules` from the
   main checkout; never `npm install` in a worktree), PR, owner merges. The owner restarts the app to
   load a merged change; say so in every announcement.
3. **Verify with the app, not with a claim.** `npm test` runs the smoke test (screenshot mode with
   renderer-error capture). For anything visual also run
   `env -u ELECTRON_RUN_AS_NODE npx electron . --screenshot out.png --wait 3500 [--view <tab>]`
   and look at the PNG. Never commit screenshots.
4. **The kit is a contract.** `kit/orchestrator-system.md` is copied into
   `~/.claude/mission-control/orchestrator-system.md` at every app start and appended to every
   lead's system prompt. Edits take effect only after a restart; the owner's own additions in
   `orchestrator-system.local.md` are never overwritten. `kit/mc-note.js` and `kit/mc-board.js` must
   keep their CLI surface backwards compatible: leads in other projects call them by name.
5. **Memory files are machine-written.** `mission-control-checkpoint.md` and
   `mission-control-journal.md` in every project's memory dir are overwritten by `checkpoint.js`.
   Never hand-edit them; the lead's own notes (`handover.md`, `repo-map.md`, decisions) are separate.
6. **One account per project.** `GH_TOKEN` and the git identity are injected per PTY. Never
   `gh auth switch`, never change global git config.

## Where things live
- `main.js` main process (IPC, PTYs, registry, snapshot loops, screenshot mode) · `preload.js`
  bridge · `renderer/` UI · `transcripts.js` session and worker discovery · `checkpoint.js` memory
  writer · `integrations.js` settings, GitHub, notes · `prwatch.js` PR follow-through · `boards.js`
  tickets and todos · `team.js` role and model roster · `kit/` what leads receive.
- Runtime data: `~/.claude/mission-control` (registry, settings, notes, boards, prwatch, generated
  prompts). Per-project memory: `~/.claude/projects/<slug>/memory`.
- Docs: `README.md` (product and files), `docs/PLAN.md` (current plan), `docs/PROGRESS.md`
  (board mirror with evidence). The lead's memory has a `repo-map` note with file:line pointers.

## Pitfalls
- `ELECTRON_RUN_AS_NODE` set in the shell turns `require('electron')` into a string; clear it.
- A second Electron instance shares the disk cache with the running app and prints
  "Unable to move the cache"; node-pty's conpty helper prints "AttachConsole failed" at exit.
  Both are noise, not failures.
- `<dialog>` styling: scope `display` rules to `dialog[open]`, or the dialog never hides.
- Renderer uses blocking `alert()`/`confirm()`; never trigger them from timers.
- node-pty must match the Electron ABI; rebuild steps are in README → Troubleshooting.

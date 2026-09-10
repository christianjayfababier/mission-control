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
- **Terminals:** selecting a project opens a PowerShell terminal in its directory. **Launch Claude here** types `claude` into it. **+ Terminal** adds more; each project keeps its terminals alive while you switch around.
- **Session tabs:** one per recent Claude session in that project, whether it runs in this app's terminal or in VS Code. They show the orchestrator's prompts, its messages, every tool call and every worker it spawned, live.
- **Workers:** one window per subagent of the selected project, appearing the moment it is spawned: role, task, status (running pulses), duration, tool count, tokens, current tool, and a live log of tool calls and messages. Maximize with ⤢, hide with ×, or untick **finished workers** to keep only running ones.

## How it knows what's running

Claude Code writes every session to `~/.claude/projects/<slug>/<session>.jsonl` and every subagent to `<slug>/<session>/subagents/agent-<id>.jsonl` (+ `.meta.json` with the role and task). `transcripts.js` tails those files incrementally and streams display-ready lines to the window over IPC. Workers are threads inside the orchestrator's process, so they have no terminal of their own; their windows are live transcript views, which is the same information a terminal would show.

## Files

```
main.js          Electron main: window, node-pty terminals, IPC, project registry, screenshot mode
transcripts.js   session/worker discovery and incremental tailing
preload.js       contextBridge API (window.mc)
renderer/        index.html, app.js, styles.css (vanilla JS + xterm.js)
Mission Control.cmd   launcher
```

State: `~/.claude/mission-control/projects.json` (added folders), `window.json` (window bounds).

## Troubleshooting

- **"Terminals are unavailable"**: node-pty's native binary did not load for this Electron version. Run `npx @electron/rebuild -f -w node-pty` in this folder (needs Visual Studio Build Tools with the C++ workload, present on this machine).
- Blank sidebar: no sessions in the last 48 hours; tick **show idle** or add a folder.
- The old terminal-only dashboard remains at `C:\Users\chris\.claude\mission-control\mission-control.cmd`.

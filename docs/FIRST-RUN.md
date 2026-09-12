# First run — from download to your first Recall

For a second owner setting Mission Control up on their own Windows machine. Follow it once, top to bottom;
it takes about twenty minutes, most of which is Windows installing things. Nothing here needs the person who
built it.

Mission Control does not *do* the work. It gives every project of yours one long-running Claude Code session
— its **lead** — that remembers the project, plans with you, and dispatches worker sessions onto their own
branches. This guide gets you as far as the first conversation with a lead; what happens after that is
between you and it.

---

## 1. Install

1. Open <https://github.com/christianjayfababier/mission-control/releases> and download
   `Mission-Control-Setup-<version>.exe` from the newest release.
2. Run it. The installer is **per user**: no administrator prompt, no shared install. It lands in
   `%LOCALAPPDATA%\Programs\mission-control` (you can choose another directory) and adds a **Mission
   Control** shortcut to the Start Menu.
3. **SmartScreen will stop you.** The build is not code-signed, so Windows shows *Windows protected your
   PC*. Choose **More info → Run anyway**. It asks once per version, not once per launch. If you would
   rather check before trusting it: the file you downloaded is the one the release page lists, and the
   release was built from the tagged commit by the repository's own GitHub Actions workflow.
4. Start Mission Control from the Start Menu.

Everything Mission Control keeps — your projects, boards, inbox, settings and the rulebook it hands every
lead — lives in `%USERPROFILE%\.claude\mission-control`. Installing, upgrading and uninstalling never touch
it.

## 2. The Setup wizard

The first time Mission Control starts on a machine with no projects, it opens **Set up Mission Control** by
itself. Four steps, and you can leave and come back: **Settings → About & diagnostics → Run setup again**.

**1 · Welcome** — what the app is, and what the next three screens check.

**2 · Tools** — the four things that have to be on this machine. Each row has a coloured dot, the version
it found, and where it found it:

| | Why | If it is missing |
| --- | --- | --- |
| **Node.js** | Mission Control runs on it, and so do the inbox and board scripts every lead is handed | **Install** runs `winget install --id OpenJS.NodeJS.LTS` |
| **Git** | Every work item is a branch, often in its own worktree | **Install** runs `winget install --id Git.Git` |
| **GitHub CLI** (`gh`) | Branches, pull requests, and the per-project token each terminal gets | **Install**, then **Log in** |
| **Claude Code** (`claude`) | The lead and worker sessions themselves | **Install**, then **Log in** |

**Install** and **Log in** open a real terminal inside Mission Control and type the command for you, so you
can answer whatever it asks — a winget licence prompt, a browser sign-in, a device code. Finish in that
terminal, come back to the wizard and press **Refresh**.

**Next stays grey until all four are ready**, and the amber line above the list says exactly what is still
blocking — which tool to install, which one to sign in to. It turns green when nothing is.

> On a machine with no projects yet there is no terminal tab to open, so the buttons say the command
> instead: run it in PowerShell, then come back and press **Refresh**.

**3 · AI tools (optional)** — the other coding agents a worker may call (Codex, Gemini, Copilot, Cursor,
Cline, OpenCode, Aider, Goose, Ollama) and the API keys they run on. Keys are encrypted on this machine with
Windows DPAPI and exported into the terminals of projects you allow them in; they never leave the machine and
never come back out of the main process. **You can do all of this later** in **Settings → Accounts & AI** —
skipping the step costs you nothing.

**4 · First project** — see below. **Skip for now** is allowed; **Finish** closes the wizard and records that
setup is done, so it never opens by itself again.

### Signing in to Claude Code and the GitHub CLI

Both are ordinary CLI logins; Mission Control only starts them.

- **Claude Code**: `claude auth login` opens your browser. Sign in with the Claude account whose plan you
  want the sessions to spend. The row then reads *logged in as you@example.com · <org> · <plan>*.
- **GitHub CLI**: `gh auth login -h github.com -w` opens a browser with a device code. Say yes to HTTPS and
  to using the credentials for git. The row then reads *logged in as <login>*.

One account per project is the rule: the account and git identity are injected into every terminal Mission
Control opens for that project (**Repo & account** in the project header picks which). Never run
`gh auth switch` yourself — it changes the machine, not the project.

## 3. Add your first project

A project is a folder, usually a git repository. **+ Add/create a project** (in the wizard, or at the bottom
of the sidebar) offers three ways in:

- **Existing folder** — pick a directory you already work in.
- **New folder** — name it, and Mission Control makes it, optionally with `git init` and a starter
  `CLAUDE.md`.
- **From GitHub** — clone it. The clone runs in a visible terminal, so you can answer anything `gh` asks; the
  folder is added when it finishes cleanly.

The project appears in the sidebar straight away, with a board, an inbox, a rulebook and a memory of its own.

## 4. Start a new day

Select the project. The first tab is **<lead name> · Orchestrator**, and the button on it is **Start a new
day**.

That launches a Claude Code session in the project directory with Mission Control's orchestrator rules
appended to its system prompt, and asks it to **Recall**. The dropdown next to the button resumes a previous
lead session instead, when you would rather continue one.

### What the lead does at Recall

It reads its memory before it says anything:

1. `mission-control-checkpoint.md` — machine-written after every turn: your last request, the session state,
   every worker's task, status and result.
2. `mission-control-journal.md` — machine-written history, day by day.
3. Its own handover note, repo map and decision notes — the things it wrote for itself.
4. Then the project's rules, plan and board.

Then it tells you where the work stands and asks what to do next. You will not have to explain the project
to it twice; that is the whole point of it.

Both machine-written files live in `%USERPROFILE%\.claude\projects\<project>\memory` and are overwritten by
Mission Control. Never hand-edit them.

## 5. Where everything lives

| | Where |
| --- | --- |
| **Board** (tickets and todos) | the **Tickets** and **Todos** tabs of the project; the lead writes to it with `mc-board.js` |
| **Inbox** (questions, decisions, announcements) | bottom of the sidebar; the lead writes to it with `mc-note.js`, you answer in place and the answer goes to the session |
| **Rules** | the **Rules** tab: the repo's own rule files, Mission Control's rulebook, and rules you add for this project. Machine-wide additions: **Settings → Global rules**, appended to every lead in every project |
| **Team chat** | header button: a read-only side panel where the project's AI tools talk to each other about the work. They run nothing; **Send to lead** pastes a suggestion into the composer for you to send |
| **Memory** | the **Memory** toggle in the header: the project's memory notes as a graph |
| **Explorer** | header button: the file tree with git marks, and which agent is reading or editing what |
| **Team & models** | header button: which model and effort each role runs at |
| **AI Collaboration** | header button: which AI tools and keys *this* project may use |
| **Settings** | the cog at the bottom of the sidebar: Accounts & AI, Global rules, Hidden projects, About & diagnostics |

## 6. Updates

Mission Control updates itself from the same releases page. It asks GitHub twenty seconds after start and
every four hours after that, downloads a newer installer in the background, and then waits. A chip in the
project header says **Update <version> ready: restart to install**; nothing happens until you click it, and
clicking it tells you what the restart costs — how many terminals will close, how many workers are still
running — before it does anything. **Settings → About & diagnostics → Check for updates** asks on demand.

A new version only reaches you when the release is *published*; drafts are invisible to installed copies.

## 7. When something goes wrong

- **The window went blank, or the app disappeared.** The main-process log is
  `%USERPROFILE%\.claude\mission-control\logs\main.log`, and **Settings → About & diagnostics** shows its
  path and size with an **Open log** button. One line per event; a run that simply stops without a
  `will-quit` line crashed. The same panel shows the last memory sample — the most common cause here has
  been the machine running out of RAM, not Mission Control.
- **"Terminals are unavailable".** The native terminal binary did not load for this Electron build.
  Reinstall the app; if you are running from a source checkout, `npx @electron/rebuild -f -w node-pty`.
- **A tool says "not installed" but you just installed it.** Press **Refresh** — the probes cache for a
  minute, and a fresh install is not on the PATH of terminals that were already open.
- **You want to see the wizard again.** **Settings → About & diagnostics → Run setup again**. Looking at it
  changes nothing.

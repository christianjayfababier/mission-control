# Explorer — IPC and data contract (T-010, T-011, T-012)

Written by Skye, 2026-09-12. Both builders code against this; the data builder implements it, the renderer
builder consumes it. Paths: `root` is an absolute directory (the project path or a worktree path). `rel` is
a path relative to `root` with forward slashes, no leading `./`. Everything is plain JSON.

## Renderer API (`window.mc`, added in preload.js)

| Call | IPC channel | Returns |
| --- | --- | --- |
| `explorerList(root, rel)` | `explorer:list` | `{ entries: Entry[], error?: string }` |
| `explorerStatus(root)` | `explorer:status` | `Status` |
| `explorerBranches(projectRoot)` | `explorer:branches` | `Branches` |
| `explorerDiff(projectRoot, branch)` | `explorer:diff` | `{ files: DiffFile[], error?: string }` |
| `openFile(path, line?)` | `open:file` | `true` or an error string; runs `code -g <path>[:line]` detached |

```ts
Entry     = { name: string, rel: string, type: 'dir' | 'file', ignored: boolean }
            // sorted: dirs first, then files, case-insensitive; `.git` never listed; ignored = git check-ignore says so
Status    = { root: string, branch: string | null, files: { [rel: string]: Mark }, dirs: { [relDir: string]: true }, at: number }
            // from `git status --porcelain=v1 -z -uall`; dirs = every ancestor dir of a changed file ('' excluded)
Mark      = 'M' | 'A' | 'D' | 'U' | 'R' | 'C'   // U = untracked ('??'); index/worktree columns collapsed to one letter,
                                                  // worktree column wins when both are set; 'AM' -> 'A', ' M' -> 'M', 'R ' -> 'R'
Branches  = { default: string, branches: Branch[], at: number, error?: string }
Branch    = { name: string, sha: string, current: boolean, worktree: string | null, upstream: string | null,
              ahead: number, behind: number }          // ahead/behind vs `default` (merge-base); current = HEAD of projectRoot
DiffFile  = { rel: string, status: 'M' | 'A' | 'D' | 'R' | 'C' }   // `git diff --name-status <default>...<branch>`
```

Default branch: `origin/HEAD` symbolic ref if present, else `main`, else `master`. Every call must fail soft: no
exceptions across IPC, `error` strings instead, an empty result when git is missing or the dir is not a repo.

## Snapshot additions (transcripts.js, in every worker and session summary)

```ts
files: TouchedFile[]      // most recent 100, newest first
TouchedFile = { path: string, rel: string | null, op: 'edit' | 'read', ts: number, tool: string }
cwd: string | null        // already present on workers; add to sessions too
```

- `op: 'edit'` for tool_use of `Edit`, `Write`, `MultiEdit`, `NotebookEdit`; `op: 'read'` for `Read`. Other tools are
  not files (Bash/PowerShell edits are invisible; the UI says so in a tooltip).
- `path` is the tool's `file_path` (or `notebook_path`) exactly as given. `rel` is the path relative to the agent's
  `cwd` (forward slashes) when the path lies under it, else `null`. Case-insensitive on Windows.
- One entry per (path, op): a repeated edit updates `ts` and moves the entry to the front.

## Renderer behaviour (T-010, T-012)

- Header button **Explorer** (`#btn-explorer`) toggles the panel; state per project in localStorage `mc.explorer.<key>`.
  `--view explorer` opens it (for screenshots). `#app` grid becomes `300px 280px 1fr` while open.
- Panel header: segmented control **Files | Branches**, the current `root` (project name, or `worktree: <name>` with a
  "back to project" link when the tree shows a worktree), a refresh button.
- **Files**: lazy tree; ignored entries hidden by default (toggle "show ignored" in a small menu). Marks from `Status`
  as a coloured letter right-aligned (M amber, A/U green, D red, R/C blue); dirs with changes get a dot. Status polled
  every 3 s while the panel is open and the window is focused; `explorer:list` re-fetched for open dirs only when the
  status `at` changes or on refresh.
- **Pills**: for each file row, one pill per agent (workers and the lead session) whose `files` contains it with a
  matching `rel` (agent `cwd` == root) or, when the agent's `cwd` is a different worktree of the same repo, the same
  `rel` with a small ⑂ prefix and the worktree name in the tooltip. Solid pill = edit, hollow = read. Running agents
  full colour; finished ones faded and only for `edit`. Pill text = the agent's Persona name; tooltip = role, op,
  time ago, current tool line, worktree. Same file, three workers = three pills in a row (overflow "+n").
- Click a row: file → `openFile(path)`; dir → toggle. Right-click: Open in VS Code, Reveal in folder (`open:folder` on
  the parent), Copy path.
- **Branches**: list from `Branches` sorted current first, then branches with worktrees, then the rest. Each row:
  name, ⑂ worktree basename if any, PR badge from the project's `prs` (match `headRefName`), pills for agents whose
  `gitBranch` equals the branch, `↑ahead ↓behind`. Expanding a row calls `explorerDiff` once and lists `DiffFile`s
  with marks and pills. A row with a worktree has "Show files" which sets the Files view `root` to that worktree.

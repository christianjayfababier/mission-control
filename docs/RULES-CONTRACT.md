# Rules tab — IPC and data contract (T-013, T-014, T-015)

Written by Skye, 2026-09-12. The data builder implements it, the renderer builder consumes it. Plain JSON everywhere.
`projectPath` is the project's absolute path (the same value the board and settings use).

## Store: `~/.claude/mission-control/rules/<project-key>.json`

```ts
RulesFile = { seq: number, rules: Rule[] }
Rule      = { id: string,            // 'R-001', 'R-002', ... (seq, zero-padded to 3)
              text: string,          // plain text, 1..2000 chars, trimmed
              by: string,            // 'owner' | lead name (e.g. 'Skye') | 'orchestrator' when the lead has no name
              source: 'ui' | 'script',
              createdAt: string, updatedAt: string,   // ISO
              order: number }        // ascending display order; reorder rewrites orders
```

Same file conventions as boards.js (`safeKey`, atomic write, missing file = empty). The CLI `kit/mc-board.js` and the app
write the same file; the app polls it for external changes like it does for boards (~2 s) and pushes a `rules` event.

## Renderer API (`window.mc`)

| Call | IPC | Returns |
| --- | --- | --- |
| `rulesGet(projectPath)` | `rules:get` | `RulesFile` |
| `rulesAdd(projectPath, text)` | `rules:add` | `RulesFile` (by 'owner', source 'ui') |
| `rulesPatch(projectPath, id, { text?, order? })` | `rules:patch` | `RulesFile` |
| `rulesRemove(projectPath, id)` | `rules:remove` | `RulesFile` |
| `rulesReorder(projectPath, ids)` | `rules:reorder` | `RulesFile` (ids in new order) |
| `rulesSources(projectPath)` | `rules:sources` | `Sources` |
| `readText(absPath)` | `rules:read` | `{ text: string, size: number, mtime: number } \| { error }` — only paths inside the project, the kit dir, or `DATA_DIR/generated`; max 512 KB |
| `onRules(cb)` | push `rules` | `{ path: projectPath, rules: RulesFile }` when the file changes on disk |

```ts
Sources = {
  repo: RepoRuleFile[],          // fixed candidates + .claude/* listings, in this order:
                                 // CLAUDE.md, docs/ORCHESTRATOR.md, docs/PLAN.md, docs/PROGRESS.md, docs/TEAM-OPERATIONS.md,
                                 // .claude/orchestrator.md, CONTRIBUTING.md, docs/PITFALLS.md, .github/PULL_REQUEST_TEMPLATE.md,
                                 // .github/pull_request_template.md, then every file under .claude/agents, .claude/skills (SKILL.md
                                 // per subdir), .claude/commands (each with group 'agents' | 'skills' | 'commands')
  kit: { rules: string, local: string | null, generated: string | null },   // absolute paths; local/generated null when absent
  at: number
}
RepoRuleFile = { rel: string, path: string, present: boolean, group: 'rules' | 'agents' | 'skills' | 'commands',
                 firstLine: string | null, size: number | null, mtime: number | null }
                 // present=false rows are the fixed candidates that do not exist (never for .claude/* listings)
                 // firstLine: first non-empty line, frontmatter `description:` preferred when the file starts with `---`
```

## Lead prompt injection (`lead:prepare` in main.js)

After the project block and before the model assignments, append when the project has at least one rule:

```
## Owner rules for this project — binding, they win over the general rules above
- R-001 <text>   (owner, 2026-09-12)
- R-002 <text>   (Skye, 2026-09-12)
```

Pure exported function `renderOwnerRules(rulesFile)` → string ('' when empty) in rules.js, covered by a unit test.

## CLI (`kit/mc-board.js`, copied into DATA_DIR at app start)

```
node mc-board.js rule list
node mc-board.js rule add "text" [--by Skye]      # source 'script'; --by defaults to 'orchestrator'
node mc-board.js rule remove R-003
```
Shares the same file and id scheme; prints `added R-00n` / `removed R-00n` / one line per rule.

## Renderer behaviour (T-014)

- Tab **Rules** after Tickets and Todos in `renderTabs`, count badge = number of owner rules. `--view rules` opens it.
- Three sections, in this order, each collapsible:
  1. **From the repo** — one row per `RepoRuleFile`: group label, `rel`, `firstLine` muted, size; present=false rows greyed
     with "not present". Click → viewer pane on the right half of the tab: file name, path, mtime, "Open in VS Code"
     (`window.mc.openFile(path)`), body rendered as light markdown (headings, bold, inline code, fenced code, lists, links
     as plain text) with no library. Escape or × closes the viewer.
  2. **Mission Control rules** — rows for the kit rulebook, the owner's local additions (or "none yet · create" that opens
     the file path in VS Code), and the latest generated prompt for this project (if any). Same viewer.
  3. **Your rules for this project** — list like Todos: textarea + Add, inline edit on click, × remove with confirm,
     ↑/↓ reorder, meta line "R-00n · by owner · 2 h ago". Empty state explains what a rule is and that a lead can add one
     when asked ("save this as a rule"). A note under the list: "New rules reach the lead at its next launch or resume."
     Button **Tell the lead now** on each rule: if a hosted lead session for this project exists, types
     `Owner rule R-00n (also saved to your Owner rules): <text>` into it via the existing send path (see `sendToSession`
     in app.js) and flashes "sent"; otherwise disabled with a tooltip.
- Refresh `rulesSources` when the tab opens and on a ⟳ button; owner rules live-update via `onRules`.

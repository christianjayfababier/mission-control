# Plan — Mission Control

Owner: Christian. Lead: Skye. Updated 2026-09-12 (evening).

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

## Non-goals
No new dependencies. No redesign of the terminal panes. No change to the checkpoint or journal
format. No automatic merging.

## Risks
- Kit changes reach leads only after an app restart; running leads keep the old prompt.
- node-pty may fail to build on CI; the smoke test must pass with terminals unavailable.
- The three branches touch `main.js` and `renderer/app.js` in different regions; merge in the order above.

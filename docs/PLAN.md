# Plan — Mission Control

Owner: Christian. Lead: Skye. Updated 2026-09-12.

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
| T-006 | Finished workers as a compact list with resumable badge | `feat/sidebar-workers-hygiene` | opus worker | Screenshot shows finished list; a resumed worker returns to the running grid |
| T-007 | `npm test` smoke test with renderer-error capture; windows-latest workflow | `feat/smoke-test` | opus worker | `npm test` passes on main and fails on an injected renderer error; workflow runs on the PR |

## Non-goals
No new dependencies. No redesign of the terminal panes. No change to the checkpoint or journal
format. No automatic merging.

## Risks
- Kit changes reach leads only after an app restart; running leads keep the old prompt.
- node-pty may fail to build on CI; the smoke test must pass with terminals unavailable.
- The three branches touch `main.js` and `renderer/app.js` in different regions; merge in the order above.

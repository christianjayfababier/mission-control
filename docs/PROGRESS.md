# Progress — Mission Control

Mirror of the Tickets board with evidence. Updated 2026-09-12 (evening) by Skye.

| Ticket | Status | Branch / PR | Evidence |
| --- | --- | --- | --- |
| T-001 Verify Start a new day end to end | done | main | Session 6c254251 launched from the Orchestrator tab on 2026-09-11 23:37; Recall ran; owner's reply arrived via the prompt bar |
| T-002 Verify inbox answer delivery | done | main | Decision note mtx5n7ruahoi answered "It arrived" from the sidebar; text landed in the lead's session on 2026-09-12 |
| T-003 mc-board.js flags without a value | done | main @ 2156de2 | commit 2156de2 |
| T-004 Recall and Handover in the kit | done | [PR #2](https://github.com/christianjayfababier/mission-control/pull/2) merged ded6d4e | kit copy in the data dir carries "## 1. Recall" after restart |
| T-005 Sidebar keeps seen projects | done | [PR #3](https://github.com/christianjayfababier/mission-control/pull/3) merged a981473 | lead screenshot `--view idle`: Active 1, Idle 5 incl. three ALD worktrees |
| T-006 Finished workers list | done (reverted) | [PR #3](https://github.com/christianjayfababier/mission-control/pull/3) | built, then reverted at the owner's request; panes and header checkbox kept; resume detection and resumable badge kept |
| T-007 Smoke test and workflow | done | [PR #1](https://github.com/christianjayfababier/mission-control/pull/1) merged 6134210 | `npm test` exit 0; injected renderer error exits 1; CI green on windows-latest in 53 s |
| T-008 Repo scaffold | done | [PR #2](https://github.com/christianjayfababier/mission-control/pull/2) merged | CLAUDE.md, docs/PLAN.md, docs/PROGRESS.md present |
| T-009 False post-merge blocker on cancelled runs | done | [PR #4](https://github.com/christianjayfababier/mission-control/pull/4) merged e6f1ea5 | test/unit.js 5 checks; workflow cancels in-progress runs on PRs only |
| T-010 Explorer panel | in progress | feat/explorer-ui | |
| T-011 Explorer data and IPC | in progress | feat/explorer-data | |
| T-012 Explorer Branches view | planned | feat/explorer-ui | |

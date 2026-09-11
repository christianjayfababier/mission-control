'use strict';
/*
 PrWatch — follows the team's pull requests to production and reports to the owner's inbox.

 Watched PRs: authored by the project's GitHub account, on a branch a worker or a ticket is on, or
 registered by the orchestrator (mc-board.js watch <pr>). For each: checks pending → passed / failed,
 a merge reminder when it sits green, merged → the merge commit's workflow runs and GitHub deployments
 until they finish. Notes are posted through the same inbox the orchestrator uses, with source
 "mission-control", so the owner sees them in the sidebar and the orchestrator can read them too.
 State is persisted so a restart does not repeat notifications.
*/
const fs = require('fs');

const MERGE_REMINDER_MS = 30 * 60 * 1000;
const DEPLOY_TIMEOUT_MS = 3 * 3600 * 1000;
const NO_RUNS_AFTER_MS = 10 * 60 * 1000;

class PrWatch {
  constructor({ github, notes, boards, file, onNote = null }) {
    this.github = github; this.notes = notes; this.boards = boards; this.file = file; this.onNote = onNote;
    this.state = {}; // repoFull -> { [number]: { stage, checks, greenSince, notified: {...}, mergeSha, mergedAt, title, url, branch, project } }
    try { this.state = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { this.state = {}; }
  }
  save() { try { fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2)); } catch { /* ignore */ } }
  note(project, type, title, body, extra = {}) {
    const id = 'mc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    this.notes.append({ kind: 'note', id, ts: new Date().toISOString(), project, type, title: title.slice(0, 200), body: body.slice(0, 4000), options: extra.options || [], session: null, source: 'mission-control', url: extra.url || null });
    if (this.onNote) { try { this.onNote(project, `${type}: ${title}`); } catch { /* ignore */ } }
  }
  checksState(c) { if (!c) return 'unknown'; if (c.fail) return 'failed'; if (c.pending) return 'pending'; return 'passed'; }

  /** Called after each PR poll of a project. `prs` = open PRs (with checks), `workers` = worker summaries. */
  async tick({ project, repo, account, prs, workers }) {
    if (!repo) return;
    const board = this.boards.load(project);
    const branches = new Set([...(workers || []).map((w) => w.gitBranch).filter(Boolean), ...board.tickets.map((t) => t.branch).filter(Boolean)]);
    const ticketPrs = new Set(board.tickets.map((t) => (t.pr || '').match(/\/pull\/(\d+)/)).filter(Boolean).map((m) => Number(m[1])));
    const explicit = new Set((board.watches || []).map((w) => Number(w.pr)));
    const st = this.state[repo.full] || (this.state[repo.full] = {});
    const openNums = new Set();
    for (const pr of prs || []) {
      openNums.add(pr.number);
      const watched = explicit.has(pr.number) || ticketPrs.has(pr.number) || branches.has(pr.branch) || (account && pr.author && pr.author.toLowerCase() === account.toLowerCase()) || st[pr.number];
      if (!watched) continue;
      const w = st[pr.number] || (st[pr.number] = { stage: 'open', checks: null, greenSince: 0, notified: {}, title: pr.title, url: pr.url, branch: pr.branch, project });
      w.title = pr.title; w.url = pr.url; w.branch = pr.branch; w.project = project;
      const cs = this.checksState(pr.checks);
      if (cs !== w.checks) {
        if (cs === 'passed' && !pr.draft) { w.greenSince = Date.now(); this.note(project, 'announcement', `PR #${pr.number} checks passed: ${pr.title}`, `All checks are green on ${pr.branch}${pr.review ? ' · review: ' + pr.review.toLowerCase().replace('_', ' ') : ''}.\n${pr.url}\nReady to merge when you are, or tell the orchestrator to merge it.`, { url: pr.url }); w.notified.reminder = false; }
        else if (cs === 'failed') this.note(project, 'blocker', `PR #${pr.number} checks failed: ${pr.title}`, `A check failed on ${pr.branch}. The orchestrator should fix it before review.\n${pr.url}`, { url: pr.url });
        w.checks = cs;
      }
      if (cs === 'passed' && !pr.draft && w.greenSince && !w.notified.reminder && Date.now() - w.greenSince > MERGE_REMINDER_MS) {
        w.notified.reminder = true;
        this.note(project, 'decision', `Merge PR #${pr.number}? ${pr.title}`, `Green for ${Math.round((Date.now() - w.greenSince) / 60000)} minutes on ${pr.branch}${pr.review ? ' · review: ' + pr.review.toLowerCase().replace('_', ' ') : ''}.\n${pr.url}`, { url: pr.url, options: ['Ask orchestrator to merge', 'I merged it', 'Wait'] });
      }
    }
    // watched PRs no longer open: merged or closed
    for (const [num, w] of Object.entries(st)) {
      if (w.stage !== 'open' || openNums.has(Number(num))) continue;
      const v = await this.github.prView(repo.full, num, account);
      if (!v) continue;
      if (v.state === 'MERGED') {
        w.stage = 'merged'; w.mergeSha = v.mergeSha; w.mergedAt = Date.now(); w.deploy = { runs: null, deployments: null, notifiedNoRuns: false };
        this.note(w.project || project, 'announcement', `PR #${num} merged: ${w.title}`, `Merged into ${v.base}${v.mergeSha ? ' as ' + v.mergeSha.slice(0, 7) : ''}. Watching the workflows and deployments for that commit.\n${w.url}`, { url: w.url });
      } else if (v.state === 'CLOSED') {
        w.stage = 'closed';
        this.note(w.project || project, 'announcement', `PR #${num} closed without merge: ${w.title}`, w.url, { url: w.url });
      }
    }
    // merged PRs: follow the merge commit until CI/CD and deployments finish
    for (const [num, w] of Object.entries(st)) {
      if (w.stage !== 'merged') continue;
      if (!w.mergeSha || Date.now() - w.mergedAt > DEPLOY_TIMEOUT_MS) { w.stage = 'done'; continue; }
      const runs = await this.github.runsForCommit(repo.full, w.mergeSha, account);
      const deps = await this.github.deploymentsForCommit(repo.full, w.mergeSha, account);
      const items = [...(runs || []).map((r) => ({ kind: 'workflow', name: r.name, done: r.status === 'completed', ok: r.conclusion === 'success' || r.conclusion === 'skipped' || r.conclusion === 'neutral', cancelled: r.conclusion === 'cancelled', url: r.url })),
        ...deps.map((d) => ({ kind: 'deployment', name: d.environment, done: ['success', 'failure', 'error', 'inactive'].includes(d.state), ok: d.state === 'success' || d.state === 'inactive', cancelled: false, url: d.url }))];
      if (!items.length) {
        if (!w.deploy.notifiedNoRuns && Date.now() - w.mergedAt > NO_RUNS_AFTER_MS) { w.deploy.notifiedNoRuns = true; w.stage = 'done'; this.note(w.project || project, 'announcement', `PR #${num}: no CI/CD ran after the merge`, `No workflow runs or deployments were found for ${w.mergeSha.slice(0, 7)} within ten minutes. If this repo deploys another way, check production by hand.\n${w.url}`, { url: w.url }); }
        continue;
      }
      if (items.every((i) => i.done)) {
        const v = postMergeVerdict(items);
        if (v.verdict === 'failed') this.note(w.project || project, 'blocker', `PR #${num}: ${v.failed.length} of ${items.length} post-merge ${v.failed.length === 1 ? 'step' : 'steps'} failed`, `${v.lines}\nProduction may be affected. The orchestrator should investigate now.`, { url: w.url });
        else if (v.verdict === 'superseded') this.note(w.project || project, 'announcement', `PR #${num} merged; ${v.cancelled.length} post-merge ${v.cancelled.length === 1 ? 'run was' : 'runs were'} cancelled by a newer push`, `${v.lines}\nA later push to the same branch superseded ${w.mergeSha.slice(0, 7)}; that push's own run is the one that tested what is live. Nothing failed.`, { url: w.url });
        else this.note(w.project || project, 'announcement', `PR #${num} is live: ${w.title}`, `Every post-merge workflow and deployment for ${w.mergeSha.slice(0, 7)} succeeded.\n${v.lines}`, { url: w.url });
        w.stage = 'done';
      }
    }
    this.save();
  }
  /** For the UI: PRs of a project still in flight (open & watched, or merged & deploying). */
  inflight(repoFull) { const st = this.state[repoFull] || {}; return Object.entries(st).filter(([, w]) => w.stage === 'open' || w.stage === 'merged').map(([n, w]) => ({ number: Number(n), stage: w.stage, checks: w.checks, title: w.title, url: w.url, branch: w.branch })); }
}

/** Verdict on the finished post-merge items of one merge commit. A cancelled workflow run is not a failure: GitHub
 *  cancels a run when a newer push to the same branch supersedes it under a cancel-in-progress concurrency group (our
 *  own smoke.yml did this when two PRs merged 44 s apart), and the newer push's run is what tested production. Real
 *  failures (failure, timed_out, action_required, a failed deployment) stay blockers. Pure; covered by test/unit.js. */
function postMergeVerdict(items) {
  const failed = items.filter((i) => !i.ok && !i.cancelled);
  const cancelled = items.filter((i) => i.cancelled);
  const lines = items.map((i) => `${i.ok ? '✓' : i.cancelled ? '↷' : '✗'} ${i.kind} ${i.name}${i.cancelled ? ' (cancelled: superseded by a newer push)' : ''}${i.url ? ' ' + i.url : ''}`).join('\n');
  return { verdict: failed.length ? 'failed' : cancelled.length ? 'superseded' : 'live', failed, cancelled, lines };
}

module.exports = { PrWatch, postMergeVerdict };

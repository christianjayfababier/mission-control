'use strict';
/*
 integrations — per-project settings (repo, GitHub account, git identity), GitHub via the gh CLI
 (accounts, tokens, open PRs), git info, and the orchestrator inbox (notes.jsonl).

 Accounts: gh keeps several logins; a per-terminal GH_TOKEN makes both `gh` and `gh auth git-credential`
 (git push over HTTPS) act as that account without touching the machine-wide active account, so two
 projects can commit as two different users at the same time.
*/
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const keyOf = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 20000, cwd: opts.cwd, maxBuffer: 8e6, env: { ...process.env, ...(opts.env || {}) } },
    (err, stdout, stderr) => resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

class Settings {
  constructor(file) { this.file = file; this.data = {}; try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { this.data = {}; } }
  get(p) { return { ...(this.data[keyOf(p)] || {}) }; }
  set(p, patch) { const k = keyOf(p); this.data[k] = { ...(this.data[k] || {}), ...patch, path: String(p) }; fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); return this.get(p); }
}

/** https://user@github.com/owner/name.git · git@github.com:owner/name.git · owner/name */
function parseRepo(s) {
  s = String(s || '').trim(); if (!s) return null;
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(s) || /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  return m ? { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}` } : null;
}

function summarizeChecks(arr) {
  const c = { pass: 0, fail: 0, pending: 0 };
  for (const x of arr || []) {
    const s = String(x.conclusion || x.state || x.status || '').toUpperCase();
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(s)) c.pass++;
    else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)) c.fail++;
    else c.pending++;
  }
  return c;
}

class GitHub {
  constructor() { this.tokens = new Map(); this.accounts = null; this.accountsAt = 0; }
  async listAccounts(force) {
    if (this.accounts && !force && Date.now() - this.accountsAt < 5 * 60 * 1000) return this.accounts;
    const r = await run('gh', ['auth', 'status']);
    const out = r.stdout + '\n' + r.stderr; const acc = [];
    const re = /Logged in to github\.com account (\S+)[\s\S]*?Active account: (true|false)/g; let m;
    while ((m = re.exec(out))) acc.push({ login: m[1], active: m[2] === 'true' });
    this.accounts = acc; this.accountsAt = Date.now(); return acc;
  }
  async token(login) {
    if (!login) return null; if (this.tokens.has(login)) return this.tokens.get(login);
    const r = await run('gh', ['auth', 'token', '-u', login, '-h', 'github.com']);
    const t = r.ok ? r.stdout.trim() : null; if (t) this.tokens.set(login, t); return t;
  }
  async user(login) {
    const t = await this.token(login); if (!t) return null;
    const r = await run('gh', ['api', 'user'], { env: { GH_TOKEN: t } });
    try { const u = JSON.parse(r.stdout); return { login: u.login, name: u.name || u.login, email: `${u.id}+${u.login}@users.noreply.github.com` }; } catch { return null; }
  }
  async prList(repoFull, login) {
    const t = await this.token(login); const env = t ? { GH_TOKEN: t } : {};
    const r = await run('gh', ['pr', 'list', '--repo', repoFull, '--state', 'open', '--limit', '40', '--json', 'number,title,headRefName,url,isDraft,reviewDecision,statusCheckRollup,author,updatedAt'], { env, timeout: 30000 });
    if (!r.ok) return { error: (r.stderr || r.stdout || 'gh failed').trim().split('\n')[0].slice(0, 200), prs: [] };
    try {
      const list = JSON.parse(r.stdout);
      return { prs: list.map((p) => ({ number: p.number, title: p.title, branch: p.headRefName, url: p.url, draft: !!p.isDraft, review: p.reviewDecision || '', author: p.author && p.author.login, updatedAt: p.updatedAt, checks: summarizeChecks(p.statusCheckRollup) })) };
    } catch { return { error: 'unreadable gh output', prs: [] }; }
  }
}

GitHub.prototype.prView = async function (repoFull, number, login) {
  const t = await this.token(login); const env = t ? { GH_TOKEN: t } : {};
  const r = await run('gh', ['pr', 'view', String(number), '--repo', repoFull, '--json', 'number,title,state,url,headRefName,baseRefName,mergedAt,mergeCommit,author,isDraft,reviewDecision,statusCheckRollup'], { env, timeout: 30000 });
  if (!r.ok) return null;
  try { const p = JSON.parse(r.stdout); return { number: p.number, title: p.title, state: p.state, url: p.url, branch: p.headRefName, base: p.baseRefName, mergedAt: p.mergedAt || null, mergeSha: p.mergeCommit && p.mergeCommit.oid || null, author: p.author && p.author.login, draft: !!p.isDraft, review: p.reviewDecision || '', checks: summarizeChecks(p.statusCheckRollup) }; } catch { return null; }
};
/** Workflow runs triggered by a commit (the merge commit after a PR lands): CI/CD and deploy pipelines. */
GitHub.prototype.runsForCommit = async function (repoFull, sha, login) {
  const t = await this.token(login); const env = t ? { GH_TOKEN: t } : {};
  const r = await run('gh', ['run', 'list', '--repo', repoFull, '--commit', sha, '--limit', '20', '--json', 'name,status,conclusion,url,event,workflowName'], { env, timeout: 30000 });
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout).map((x) => ({ name: x.workflowName || x.name, status: x.status, conclusion: x.conclusion || '', url: x.url, event: x.event })); } catch { return null; }
};
/** GitHub Deployments for a commit, with their latest status (production environments show up here when the repo uses them). */
GitHub.prototype.deploymentsForCommit = async function (repoFull, sha, login) {
  const t = await this.token(login); const env = t ? { GH_TOKEN: t } : {};
  const r = await run('gh', ['api', `repos/${repoFull}/deployments?sha=${sha}&per_page=10`], { env, timeout: 30000 });
  if (!r.ok) return [];
  let list = []; try { list = JSON.parse(r.stdout); } catch { return []; }
  const out = [];
  for (const d of list.slice(0, 5)) {
    const s = await run('gh', ['api', `repos/${repoFull}/deployments/${d.id}/statuses?per_page=1`], { env, timeout: 20000 });
    let state = 'pending'; try { const st = JSON.parse(s.stdout); if (st[0]) state = st[0].state; } catch { /* keep pending */ }
    out.push({ id: d.id, environment: d.environment, state, url: d.url && d.url.replace('api.github.com/repos', 'github.com').replace(/\/deployments\/\d+$/, '/deployments') });
  }
  return out;
};

async function gitInfo(dir) {
  const [r1, r2] = await Promise.all([run('git', ['-C', dir, 'remote', 'get-url', 'origin']), run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])]);
  return { remote: r1.ok ? r1.stdout.trim() : null, branch: r2.ok ? r2.stdout.trim() : null, at: Date.now() };
}

/** Append-only event log written by kit/mc-note.js (from the orchestrator) and by Mission Control (answers, dismissals). */
class Notes {
  constructor(file) { this.file = file; this.offset = 0; this.buf = ''; this.notes = new Map(); }
  poll() {
    let st; try { st = fs.statSync(this.file); } catch { return false; }
    if (st.size < this.offset) { this.offset = 0; this.buf = ''; this.notes.clear(); }
    if (st.size === this.offset) return false;
    const fd = fs.openSync(this.file, 'r'); const b = Buffer.alloc(st.size - this.offset);
    fs.readSync(fd, b, 0, b.length, this.offset); fs.closeSync(fd); this.offset = st.size;
    this.buf += b.toString('utf8'); const parts = this.buf.split(/\r?\n/); this.buf = parts.pop();
    for (const l of parts) { if (!l.trim()) continue; try { this.apply(JSON.parse(l)); } catch { /* skip bad line */ } }
    return true;
  }
  apply(e) {
    if (e.kind === 'note') { this.notes.set(e.id, { ...e, status: 'open', answer: null }); return; }
    const n = this.notes.get(e.id); if (!n) return;
    if (e.kind === 'answer') Object.assign(n, { status: 'answered', answer: e.answer, answeredAt: e.ts });
    else if (e.kind === 'dismiss') n.status = 'dismissed';
    else if (e.kind === 'read') n.read = true;
  }
  append(e) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.appendFileSync(this.file, JSON.stringify(e) + '\n'); this.poll(); }
  get(id) { return this.notes.get(id) || null; }
  forProject(p) { const k = keyOf(p); return [...this.notes.values()].filter((n) => keyOf(n.project) === k && n.status === 'open').sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 50); }
  open() { return [...this.notes.values()].filter((n) => n.status === 'open').sort((a, b) => b.ts.localeCompare(a.ts)); }
}

module.exports = { Settings, GitHub, gitInfo, parseRepo, Notes, keyOf, run };

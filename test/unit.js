#!/usr/bin/env node
'use strict';
// Unit checks for pure functions. Runs before the smoke test (`npm test`), takes milliseconds, no Electron.
const assert = require('node:assert/strict');
const { postMergeVerdict } = require('../prwatch.js');
const { parsePorcelain, parseNameStatus, parseWorktrees } = require('../explorer.js');
const { relTo } = require('../transcripts.js');
const { Rules, renderOwnerRules, readText, sources, localDay } = require('../rules.js');
const prov = require('../providers.js');
const { Secrets } = require('../secrets.js');
const gset = require('../globalsettings.js');
const np = require('../newproject-lib.js');
const { UpdaterState, start: startUpdater } = require('../updater.js');
const diag = require('../diag.js');   // requiring it here is itself the "runs under plain node" check
const { checkVersion } = require('../build/check-version.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const wf = (name, conclusion) => ({ kind: 'workflow', name, done: true, ok: conclusion === 'success', cancelled: conclusion === 'cancelled', url: 'https://example.test/' + name });
const dep = (env, state) => ({ kind: 'deployment', name: env, done: true, ok: state === 'success', cancelled: false, url: '' });

let n = 0;
function check(title, fn) { fn(); n++; console.log('  ok  ' + title); }
const asyncChecks = [];
function checkAsync(title, fn) { asyncChecks.push([title, fn]); }

check('all workflows and deployments succeeded → live', () => {
  const v = postMergeVerdict([wf('smoke', 'success'), dep('production', 'success')]);
  assert.equal(v.verdict, 'live'); assert.equal(v.failed.length, 0); assert.equal(v.cancelled.length, 0);
});
check('a cancelled run alone is superseded, not failed (two merges within a minute cancel the older run)', () => {
  const v = postMergeVerdict([wf('smoke', 'cancelled')]);
  assert.equal(v.verdict, 'superseded'); assert.equal(v.cancelled.length, 1); assert.equal(v.failed.length, 0);
  assert.match(v.lines, /↷ workflow smoke \(cancelled: superseded by a newer push\)/);
});
check('a real failure is a failure even next to a cancelled run', () => {
  const v = postMergeVerdict([wf('smoke', 'cancelled'), wf('deploy', 'failure')]);
  assert.equal(v.verdict, 'failed'); assert.equal(v.failed.length, 1); assert.equal(v.cancelled.length, 1);
  assert.match(v.lines, /✗ workflow deploy/);
});
check('a failed deployment is a failure', () => {
  const v = postMergeVerdict([wf('smoke', 'success'), dep('production', 'failure')]);
  assert.equal(v.verdict, 'failed'); assert.equal(v.failed[0].name, 'production');
});
check('timed_out and action_required count as failures', () => {
  assert.equal(postMergeVerdict([wf('smoke', 'timed_out')]).verdict, 'failed');
  assert.equal(postMergeVerdict([wf('smoke', 'action_required')]).verdict, 'failed');
});

// ── explorer (docs/EXPLORER-CONTRACT.md): the -z parsers, fed the exact bytes git writes
const z = (...records) => Buffer.from(records.join('\0') + '\0', 'utf8');

check('porcelain: worktree and index columns collapse to one mark, ?? is U, dirs are every ancestor', () => {
  const { files, dirs } = parsePorcelain(z(' M a.js', 'M  b.js', 'MM c.js', '?? d/e.txt', 'A  f', 'D  g'));
  assert.deepEqual(files, { 'a.js': 'M', 'b.js': 'M', 'c.js': 'M', 'd/e.txt': 'U', f: 'A', g: 'D' });
  assert.deepEqual(dirs, { d: true });
});
check('porcelain: a rename is one record of two NUL fields, new path first, and marks R', () => {
  // -z reverses the field order of a rename, so "R  old -> new" reaches us as "R  new\0old\0"
  const { files } = parsePorcelain(z('R  new/two.js', 'old/one.js', ' M after.js'));
  assert.deepEqual(files, { 'new/two.js': 'R', 'after.js': 'M' }); // the original path is consumed, never listed
  assert.equal(parsePorcelain(z('AM added.js')).files['added.js'], 'A'); // a staged add is not downgraded by a later edit
});
check('name-status: one path for M/A/D, two for a rename, and the new one wins', () => {
  const files = parseNameStatus(z('M', 'main.js', 'A', 'explorer.js', 'D', 'old.js', 'R100', 'renderer/a.js', 'renderer/b.js'));
  assert.deepEqual(files, [
    { rel: 'main.js', status: 'M' }, { rel: 'explorer.js', status: 'A' },
    { rel: 'old.js', status: 'D' }, { rel: 'renderer/b.js', status: 'R' }, // score dropped, new path kept
  ]);
});
check('worktree list: one record per worktree, a detached one has no branch', () => {
  const wts = parseWorktrees([
    'worktree C:/ClaudeApps/MissionControl', 'HEAD e6f1ea5', 'branch refs/heads/main', '',
    'worktree C:/ClaudeApps/worktrees/mc-explorer-data', 'HEAD abc1234', 'detached', '',
  ].join('\n'));
  assert.equal(wts.length, 2);
  assert.deepEqual(wts[0], { path: 'C:/ClaudeApps/MissionControl', head: 'e6f1ea5', branch: 'main', detached: false });
  assert.equal(wts[1].branch, null); assert.equal(wts[1].detached, true);
});
check('relTo: relative under cwd whatever the case or the slashes, null outside it', () => {
  assert.equal(relTo('C:\\ClaudeApps\\MissionControl', 'C:\\ClaudeApps\\MissionControl\\renderer\\app.js'), 'renderer/app.js');
  assert.equal(relTo('c:/claudeapps/missioncontrol', 'C:\\ClaudeApps\\MissionControl\\main.js'), 'main.js');
  assert.equal(relTo('C:\\ClaudeApps\\MissionControl\\', 'C:/ClaudeApps/MissionControl/main.js'), 'main.js');
  assert.equal(relTo('C:\\ClaudeApps\\MissionControl', 'C:\\ClaudeApps\\MissionControlOther\\main.js'), null);
  assert.equal(relTo('C:\\ClaudeApps\\MissionControl', 'D:\\elsewhere\\main.js'), null);
  assert.equal(relTo(null, 'C:\\x.js'), null);
});

// ── rules (docs/RULES-CONTRACT.md): the prompt block, discovery, the viewer's guard and the CLI
const rule = (id, text, by, createdAt, order) => ({ id, text, by, source: 'ui', createdAt, updatedAt: createdAt, order });

check('renderOwnerRules: nothing to say when the project has no rules', () => {
  assert.equal(renderOwnerRules(null), '');
  assert.equal(renderOwnerRules({ seq: 0, rules: [] }), '');
});
check("renderOwnerRules: the exact block from the contract, in `order`, dated in the owner's local days", () => {
  // The dates are the owner's calendar days, so the expectation is built the same way — the check holds in any zone.
  const day = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const late = '2026-09-12T22:30:00.000Z';   // a UTC evening: west of UTC still the 12th, east of it already the 13th
  const early = '2026-09-12T03:00:00.000Z';
  const block = renderOwnerRules({ seq: 2, rules: [
    rule('R-002', 'Ask before touching the schema.', 'Skye', late, 1),
    rule('R-001', 'Never force-push a shared branch.', 'owner', early, 0),
  ] });
  assert.equal(block, [
    '## Owner rules for this project — binding, they win over the general rules above',
    `- R-001 Never force-push a shared branch.   (owner, ${day(early)})`,
    `- R-002 Ask before touching the schema.   (Skye, ${day(late)})`,
  ].join('\n'));
  assert.equal(localDay(late), day(late));
  assert.equal(localDay(''), '');            // a rule written by hand with no date degrades quietly
});

// one throwaway tree for the file-facing checks, removed at the end
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rules-'));
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, '.claude', 'commands'), { recursive: true });
fs.mkdirSync(path.join(proj, '.claude', 'skills', 'standup'), { recursive: true });
fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '\n# Rules for this repo\n\nVanilla stack, on purpose.\n');
fs.writeFileSync(path.join(proj, '.claude', 'commands', 'wrapup.md'), '---\nname: wrapup\ndescription: "End of shift — write a checkpoint."\n---\n\nDo the thing.\n');
fs.writeFileSync(path.join(proj, '.claude', 'skills', 'standup', 'SKILL.md'), '---\nname: standup\n---\n\nStart of shift.\n');
fs.writeFileSync(path.join(tmp, 'secret.md'), 'not for the viewer');

check('sources: fixed candidates keep their order and their present flag, .claude/* only when present', () => {
  const src = sources(proj, { kitFile: path.join(tmp, 'orchestrator-system.md'), kitLocal: path.join(tmp, 'nope.md'), generatedDir: path.join(tmp, 'generated'), key: 'c--x-proj' });
  const claude = src.repo.find((r) => r.rel === 'CLAUDE.md');
  assert.equal(claude.present, true);
  assert.equal(claude.group, 'rules');
  assert.equal(claude.firstLine, '# Rules for this repo');        // first non-empty line, the leading blank skipped
  assert.equal(claude.path, path.join(proj, 'CLAUDE.md'));
  assert.ok(claude.size > 0 && claude.mtime > 0);
  const plan = src.repo.find((r) => r.rel === 'docs/PLAN.md');
  assert.equal(plan.present, false);                              // a missing candidate still gets a row
  assert.deepEqual([plan.firstLine, plan.size, plan.mtime], [null, null, null]);
  assert.ok(src.repo.indexOf(claude) < src.repo.indexOf(plan));   // contract order
  const cmd = src.repo.find((r) => r.rel === '.claude/commands/wrapup.md');
  assert.equal(cmd.group, 'commands');
  assert.equal(cmd.present, true);
  assert.equal(cmd.firstLine, 'End of shift — write a checkpoint.');  // frontmatter description, unquoted
  const skill = src.repo.find((r) => r.rel === '.claude/skills/standup/SKILL.md');
  assert.equal(skill.group, 'skills');
  assert.equal(skill.firstLine, 'Start of shift.');               // no description: first line after the frontmatter
  assert.equal(src.repo.some((r) => r.group !== 'rules' && !r.present), false);
  assert.equal(src.kit.local, null);                              // absent → null
  assert.equal(src.kit.generated, null);
  assert.ok(src.at > 0);
});
check('readText: inside an allowed root reads, outside it refuses, oversize refuses', () => {
  const ok = readText(path.join(proj, 'CLAUDE.md'), [proj]);
  assert.match(ok.text, /Vanilla stack/);
  assert.ok(ok.size > 0 && ok.mtime > 0);
  assert.ok(readText(path.join(tmp, 'secret.md'), [proj]).error);
  assert.ok(readText(path.join(proj, '..', 'secret.md'), [proj]).error);   // traversal is resolved before the check
  assert.ok(readText(path.join(proj, 'CLAUDE.md'), []).error);
  assert.equal(readText(proj, [proj]).error, 'that is a directory');
  const big = path.join(proj, 'big.md');
  fs.writeFileSync(big, 'x'.repeat(513 * 1024));
  assert.match(readText(big, [proj]).error, /512 KB/);
  fs.rmSync(big);
});
check('Rules store: add, patch, reorder, remove, and ids that never rewind', () => {
  const store = new Rules(path.join(tmp, 'rules'));
  store.add(proj, '  Never force-push a shared branch.  ');
  store.add(proj, 'Ask before touching the schema.', 'Skye', 'script');
  let r = store.load(proj);
  assert.deepEqual(r.rules.map((x) => x.id), ['R-001', 'R-002']);
  assert.equal(r.rules[0].text, 'Never force-push a shared branch.');      // trimmed
  assert.deepEqual([r.rules[0].by, r.rules[0].source], ['owner', 'ui']);
  assert.deepEqual([r.rules[1].by, r.rules[1].source], ['Skye', 'script']);
  r = store.reorder(proj, ['R-002', 'R-001']);
  assert.deepEqual(r.rules.map((x) => x.id), ['R-002', 'R-001']);
  assert.match(renderOwnerRules(r).split('\n')[1], /^- R-002 /);           // the prompt follows the display order
  store.patch(proj, 'R-001', { text: 'Never force-push main.' });
  assert.equal(store.load(proj).rules.find((x) => x.id === 'R-001').text, 'Never force-push main.');
  r = store.remove(proj, 'R-002');
  assert.deepEqual(r.rules.map((x) => x.id), ['R-001']);
  assert.deepEqual(r.rules.map((x) => x.order), [0]);
  store.add(proj, 'Third.');
  assert.deepEqual(store.load(proj).rules.map((x) => x.id), ['R-001', 'R-003']);
  const seen = new Rules(path.join(tmp, 'rules'));
  assert.equal(seen.poll().length, 1);   // a file written by someone else shows up once
  assert.equal(seen.poll().length, 0);
});
check('count(): 0 without a file, and it follows a write from outside within the same millisecond', () => {
  const store = new Rules(path.join(tmp, 'counted'));
  const other = new Rules(path.join(tmp, 'counted'));   // stands in for mc-board.js writing the same file
  assert.equal(store.count(proj), 0);                   // no file yet
  store.add(proj, 'One.');
  assert.equal(store.count(proj), 1);
  other.add(proj, 'Two.');                              // NTFS can stamp both writes with the same mtimeMs
  assert.equal(store.count(proj), 2);                   // so the badge must not be cached on mtime
  store.remove(proj, 'R-001');
  assert.equal(store.count(proj), 1);
});
check('mc-board.js rule add | list | remove writes the same file (MC_DATA_DIR honoured when set)', () => {
  const script = path.join(__dirname, '..', 'kit', 'mc-board.js');
  const dataDir = path.join(tmp, 'cli-data');
  const run = (...a) => execFileSync(process.execPath, [script, ...a, '--project', proj], { env: { ...process.env, MC_DATA_DIR: dataDir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(run('rule', 'list'), 'no rules');
  assert.equal(run('rule', 'add', 'Ship behind a flag.', '--by', 'Skye'), 'added R-001');
  assert.equal(run('rule', 'add', 'Ask before a migration.'), 'added R-002');
  assert.equal(run('rule', 'list'), 'R-001  Ship behind a flag.  (Skye)\nR-002  Ask before a migration.  (orchestrator)');
  const store = new Rules(path.join(dataDir, 'rules'));      // the app reads exactly what the CLI wrote
  const loaded = store.load(proj);
  assert.deepEqual(loaded.rules.map((x) => x.id), ['R-001', 'R-002']);
  assert.deepEqual([loaded.rules[0].by, loaded.rules[0].source], ['Skye', 'script']);
  assert.equal(loaded.rules[1].by, 'orchestrator');
  assert.match(renderOwnerRules(loaded), /^## Owner rules for this project/);
  assert.equal(run('rule', 'remove', 'R-001'), 'removed R-001');
  assert.deepEqual(store.load(proj).rules.map((x) => x.id), ['R-002']);
  assert.equal(run('rule', 'remove', 'R-009'), 'not found: R-009');
  assert.equal(run('todo', 'add', 'untouched'), 'added D-001');            // the older verbs still work
  assert.equal(run('ticket', 'list'), 'no tickets');
});
// T-026: the kit CLIs key the board and notes by project; a worktree must resolve to the main checkout.
// A main checkout with a real .git DIRECTORY, plus two worktrees whose .git is a FILE (absolute gitdir
// with a commondir, and a relative gitdir without one). No git binary: these are the files git writes.
const wtMain = path.join(tmp, 'wt-main');
const wtSub = path.join(tmp, 'worktrees', 'mc-slug');
function makeWorktreeFixture() {
  const gitdir = path.join(wtMain, '.git', 'worktrees', 'mc-slug');
  fs.mkdirSync(gitdir, { recursive: true });
  fs.mkdirSync(path.join(wtMain, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(wtSub, 'kit'), { recursive: true });
  fs.writeFileSync(path.join(gitdir, 'commondir'), '../..' + os.EOL);
  fs.writeFileSync(path.join(gitdir, 'gitdir'), path.join(wtSub, '.git') + os.EOL);
  // git writes the gitdir with forward slashes on Windows
  fs.writeFileSync(path.join(wtSub, '.git'), 'gitdir: ' + gitdir.split(path.sep).join('/') + os.EOL);
}
check('resolveProjectPath: a worktree resolves to the main checkout, a subfolder to the project root', () => {
  const { resolveProjectPath, normalizeProjectPath } = require('../kit/mc-project.js');
  makeWorktreeFixture();
  assert.equal(resolveProjectPath(wtSub, {}), wtMain);                                  // worktree root
  assert.equal(resolveProjectPath(path.join(wtSub, 'kit'), {}), wtMain);                // subfolder of the worktree
  assert.equal(resolveProjectPath(wtSub + path.sep, {}), wtMain);                       // trailing separator
  assert.equal(resolveProjectPath(wtMain, {}), wtMain);                                 // the main checkout itself
  assert.equal(resolveProjectPath(path.join(wtMain, 'src', 'deep'), {}), wtMain);       // subfolder of the main repo
  const plain = path.join(tmp, 'no-git');
  fs.mkdirSync(plain, { recursive: true });
  assert.equal(resolveProjectPath(plain, {}), plain);                                   // no .git anywhere: cwd, as before
  assert.equal(resolveProjectPath(wtSub, { MC_PROJECT: proj }), proj);                  // env override
  assert.equal(resolveProjectPath(wtSub, { MC_PROJECT: proj }, plain), plain);          // --project wins over it
  assert.equal(resolveProjectPath(wtSub, { MC_PROJECT: '  ' }), wtMain);                // empty override is no override
  // a relative gitdir and no commondir file: the `.git/worktrees/<name>` shape is enough
  const rel = path.join(tmp, 'worktrees', 'mc-rel');
  fs.mkdirSync(path.join(wtMain, '.git', 'worktrees', 'mc-rel'), { recursive: true });
  fs.mkdirSync(rel, { recursive: true });
  fs.writeFileSync(path.join(rel, '.git'), 'gitdir: ../../wt-main/.git/worktrees/mc-rel' + os.EOL);
  assert.equal(resolveProjectPath(rel, {}), wtMain);
  // a .git file pointing nowhere useful falls back to the directory holding it
  const odd = path.join(tmp, 'odd-git');
  fs.mkdirSync(odd, { recursive: true });
  fs.writeFileSync(path.join(odd, '.git'), 'gitdir: ' + path.join(tmp, 'elsewhere').split(path.sep).join('/') + os.EOL);
  assert.equal(resolveProjectPath(odd, {}), odd);
  assert.equal(normalizeProjectPath(proj + path.sep), proj);
});
check('mc-board.js run inside a worktree writes the MAIN checkout board, no phantom one (T-026)', () => {
  const script = path.join(__dirname, '..', 'kit', 'mc-board.js');
  const { safeKey } = require('../boards.js');
  const dataDir = path.join(tmp, 'wt-cli-data');
  makeWorktreeFixture();
  const run = (cwd, ...a) => execFileSync(process.execPath, [script, ...a], { cwd, env: { ...process.env, MC_DATA_DIR: dataDir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(run(path.join(wtSub, 'kit'), 'todo', 'add', 'written from a worktree'), 'added D-001');
  const boards = path.join(dataDir, 'boards');
  assert.deepEqual(fs.readdirSync(boards), [safeKey(wtMain) + '.json']);          // the app's own key, and nothing else
  const board = JSON.parse(fs.readFileSync(path.join(boards, safeKey(wtMain) + '.json'), 'utf8'));
  assert.equal(board.project, wtMain);
  assert.deepEqual(board.todos.map((t) => t.text), ['written from a worktree']);
  assert.equal(run(wtSub, 'todo', 'list'), 'D-001  [ ]  written from a worktree  (orchestrator)');   // and reads it back
  assert.equal(run(wtMain, 'todo', 'list'), 'D-001  [ ]  written from a worktree  (orchestrator)');  // same board from the main checkout
});


// -- accounts & AI (docs/ACCOUNTS-CONTRACT.md): the registry's shape, the pure env assembly, the secrets
// file format against a fake encryptor, and the status parsers fed the output real vendors printed here.
check('registry: every row carries what the dialogs need, ids and bins are unique, list() drops the probes', () => {
  const ids = prov.PROVIDERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'provider ids must be unique');
  assert.equal(ids.length, 19);
  // the AI TOOLS group draws in registry order, and the owner picked this one
  assert.deepEqual(prov.PROVIDERS.filter((p) => p.kind === 'cli' && p.role === 'ai').map((p) => p.id),
    ['codex', 'gemini', 'copilot', 'cursor', 'cline', 'opencode', 'aider', 'goose', 'ollama']);

  const bins = prov.PROVIDERS.filter((p) => p.kind === 'cli').map((p) => p.bin);
  assert.equal(new Set(bins).size, bins.length, 'two tools cannot own the same binary name');

  for (const p of prov.PROVIDERS) {
    assert.ok(p.name && p.docs, p.id + ' needs a name and a docs link');
    assert.match(p.docs, /^https:\/\//, p.id + ' docs must be a URL');
    assert.ok(['cli', 'key'].includes(p.kind), p.id + ' kind');
    assert.ok(['required', 'ai', 'vcs'].includes(p.role), p.id + ' role');
    assert.ok(p.blurb, p.id + ' needs a blurb');
    if (p.kind === 'cli') {
      assert.ok(p.bin, p.id + ' needs a bin');
      assert.equal(typeof p.status, 'function', p.id + ' needs a probe');
      // install and login may be null (unverified, or the tool simply has no account), never invented
      for (const f of ['install', 'login']) assert.ok(p[f] === null || typeof p[f] === 'string', `${p.id}.${f} must be a string or null`);
      if (p.keys !== undefined) assert.ok(Array.isArray(p.keys), p.id + '.keys must be a list');
    } else {
      assert.ok(/^[A-Z][A-Z0-9_]+$/.test(p.envVar), p.id + ' needs an env var');
      assert.equal(p.status, undefined, p.id + ' is a key: nothing to probe');
    }
    // a placeholder belongs in exec and nowhere else: an install or login line is run verbatim in a shell
    for (const f of ['install', 'installFallback', 'login']) {
      if (typeof p[f] === 'string') assert.equal(p[f].includes('{'), false, `${p.id}.${f} must not carry a placeholder`);
    }
    if (p.exec != null) assert.ok(p.exec.includes('{prompt}'), p.id + ' exec must carry the {prompt} placeholder');
  }

  // every key provider is reachable from a key row, and every env var is claimed once
  const keys = prov.PROVIDERS.filter((p) => p.kind === 'key');
  assert.equal(keys.length, 8);
  const vars = keys.map((p) => p.envVar);
  assert.equal(new Set(vars).size, vars.length, 'two key providers cannot write the same variable');
  assert.deepEqual(vars, ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'CURSOR_API_KEY']);

  // the lines the wizard and the dialogs actually run
  assert.match(prov.installLine('claude'), /^winget install --id Anthropic\.ClaudeCode -e /);
  assert.match(prov.installLine('ollama'), /^winget install --id Ollama\.Ollama -e /);
  assert.equal(prov.installLine('gemini'), 'npm install -g @google/gemini-cli');
  assert.equal(prov.installLine('copilot'), 'npm install -g @github/copilot');
  assert.equal(prov.installLine('goose'), null);        // unverified: no line is claimed
  assert.equal(prov.byId('goose').login, null);
  assert.equal(prov.byId('ollama').login, null);        // fully local, no account
  assert.equal(prov.byId('aider').login, null);         // keys only
  assert.equal(prov.byId('github').login, 'gh auth login -h github.com -w');

  const serialized = prov.list();
  assert.equal(serialized.length, prov.PROVIDERS.length);
  for (const p of serialized) assert.equal(p.status, undefined);
  assert.doesNotThrow(() => JSON.stringify(serialized));   // it has to survive the IPC boundary
});

check('the Cursor CLI owns a generic binary name, so its version line has to name the tool', () => {
  assert.equal(prov.byId('cursor').bin, 'agent');
  assert.equal(prov.isCursorAgent('cursor-agent 2026.09.01'), true);
  assert.equal(prov.isCursorAgent('Cursor Agent 1.2.3'), true);
  assert.equal(prov.isCursorAgent('agent 0.9'), true);                    // the tool's own bare name
  assert.equal(prov.isCursorAgent('GNU Screen 4.9.0'), false);            // some other `agent` on PATH
  assert.equal(prov.isCursorAgent(''), false);
  assert.equal(prov.isCursorAgent(null), false);
});

check('assembleEnv: an enabled key is exported, a disabled one is not, and the base environment always wins', () => {
  const secrets = { 'openai-key': 'sk-open', 'anthropic-key': 'sk-anthropic', 'gemini-key': 'g-key' };
  const all = prov.assembleEnv({ base: { PATH: 'x' }, secrets });
  assert.equal(all.OPENAI_API_KEY, 'sk-open');
  assert.equal(all.ANTHROPIC_API_KEY, 'sk-anthropic');
  assert.equal(all.GEMINI_API_KEY, 'g-key');
  assert.equal(all.PATH, 'x');                                            // untouched

  const off = prov.assembleEnv({ base: {}, secrets, projectSettings: { providers: { 'openai-key': false } } });
  assert.equal(off.OPENAI_API_KEY, undefined);                            // this project may not use it
  assert.equal(off.ANTHROPIC_API_KEY, 'sk-anthropic');                    // the others are unaffected

  const globalOff = prov.assembleEnv({ base: {}, secrets, globalSettings: { providers: { 'gemini-key': false } } });
  assert.equal(globalOff.GEMINI_API_KEY, undefined);                      // machine-wide default
  const projectWins = prov.assembleEnv({ base: {}, secrets, projectSettings: { providers: { 'gemini-key': true } }, globalSettings: { providers: { 'gemini-key': false } } });
  assert.equal(projectWins.GEMINI_API_KEY, 'g-key');                      // the project overrides the default

  const shell = prov.assembleEnv({ base: { OPENAI_API_KEY: 'from-the-shell' }, secrets });
  assert.equal(shell.OPENAI_API_KEY, 'from-the-shell');                   // never overwrite a base variable

  assert.equal(prov.assembleEnv({ base: {}, secrets: {} }).OPENAI_API_KEY, undefined);   // nothing stored, nothing exported
  assert.equal(prov.isEnabled('openai-key', {}, {}), true);                              // default: enabled
});

check('secrets.json: version 1, base64 ciphertext and a setAt, and no plain text anywhere in the file', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'sec-'));
  const file = path.join(dir, 'secrets.json');
  // a fake encryptor, so this test needs no Electron: reversible, and nothing like the plain text
  const fake = { available: () => true, encrypt: (s) => Buffer.from('ENC:' + Buffer.from(s, 'utf8').toString('hex'), 'utf8'), decrypt: (b) => Buffer.from(String(b).slice(4), 'hex').toString('utf8') };
  const s = new Secrets(file, fake);
  assert.equal(s.has('openai-key'), false);
  assert.deepEqual(s.list(), []);
  const r = s.set('openai-key', 'sk-test-123');
  assert.equal(r.ok, true); assert.match(r.setAt, /^\d{4}-\d{2}-\d{2}T/);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.deepEqual(Object.keys(onDisk.keys), ['openai-key']);
  assert.equal(onDisk.keys['openai-key'].setAt, r.setAt);
  assert.match(onDisk.keys['openai-key'].enc, /^[A-Za-z0-9+/=]+$/);
  assert.equal(fs.readFileSync(file, 'utf8').includes('sk-test-123'), false);   // the point of the whole file
  assert.equal(s.get('openai-key'), 'sk-test-123');                             // main process only
  assert.deepEqual(s.list(), [{ id: 'openai-key', setAt: r.setAt }]);
  assert.deepEqual(s.info(), { 'openai-key': { setAt: r.setAt } });             // what the renderer may know
  assert.deepEqual(s.map(), { 'openai-key': 'sk-test-123' });                   // what pty:create uses
  assert.equal(prov.assembleEnv({ base: {}, secrets: s.map() }).OPENAI_API_KEY, 'sk-test-123');
  s.remove('openai-key');
  assert.equal(s.has('openai-key'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).keys, {});
  assert.equal(s.get('openai-key'), null);

  // no encryption on this machine: refuse, and write nothing at all
  const none = new Secrets(path.join(dir, 'never.json'), { available: () => false, encrypt: () => { throw new Error('nope'); }, decrypt: () => '' });
  assert.match(none.set('openai-key', 'sk-test-123').error, /cannot encrypt/);
  assert.equal(fs.existsSync(path.join(dir, 'never.json')), false);
  assert.equal(s.set('openai-key', '   ').ok, true);                            // an empty field means "forget it"
  assert.equal(s.has('openai-key'), false);
});

check('status parsers: claude auth status JSON, gh auth status text, codex login status text, version lines', () => {
  assert.equal(prov.parseVersion('2.1.269 (Claude Code)'), '2.1.269');
  assert.equal(prov.parseVersion('gh version 2.97.0 (2026-07-31)\nhttps://example.test'), '2.97.0');
  assert.equal(prov.parseVersion('codex-cli 0.153.4'), '0.153.4');
  assert.equal(prov.parseVersion('nothing here'), null);

  const claude = prov.parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.test', orgName: 'Example LLP', subscriptionType: 'team', configDirectory: 'C:\\x' }));
  assert.equal(claude.loggedIn, true);
  assert.equal(claude.account, 'owner@example.test');
  assert.match(claude.detail, /logged in as owner@example\.test .*Example LLP.*team plan/);
  assert.equal(prov.parseClaudeStatus('{"loggedIn":false}').loggedIn, false);
  assert.deepEqual(prov.parseClaudeStatus('command not found'), { loggedIn: null, account: null, detail: null });

  const gh = prov.parseGhStatus([
    'github.com',
    '  \u2713 Logged in to github.com account alpha (GH_TOKEN)',
    '  - Active account: true',
    '',
    '  \u2713 Logged in to github.com account beta (keyring)',
    '  - Active account: false',
    '',
    '  \u2713 Logged in to github.com account alpha (keyring)',
    '  - Active account: false',
  ].join('\n'));
  assert.equal(gh.loggedIn, true);
  assert.equal(gh.account, 'alpha');              // the active one
  assert.equal(gh.accounts.length, 3);            // gh prints one block per login, duplicates included
  assert.equal(gh.detail, 'logged in as alpha \u00b7 3 logins: alpha, beta');
  const noGh = prov.parseGhStatus('You are not logged into any GitHub hosts.');
  assert.equal(noGh.loggedIn, false); assert.deepEqual(noGh.accounts, []);

  const chatgpt = prov.parseCodexLogin('Logged in using ChatGPT', true);
  assert.equal(chatgpt.loggedIn, true); assert.equal(chatgpt.detail, 'Logged in using ChatGPT');
  assert.equal(prov.parseCodexLogin('Logged in using an API key (owner@example.test)', true).account, 'owner@example.test');
  assert.equal(prov.parseCodexLogin('Not logged in. Run `codex login`.', false).loggedIn, false);
  assert.equal(prov.parseCodexLogin('', false).loggedIn, false);              // non-zero exit, nothing to read
  assert.equal(prov.parseCodexLogin('something new', true).loggedIn, null);   // unknown, never a guess
});

check('a missing binary is "not installed", not an exception, and a stored key reports its date', () => {
  assert.equal(prov.which('no-such-tool-' + Date.now()), null);
  const empty = prov.keyStatus(undefined);
  assert.equal(empty.installed, false); assert.equal(empty.detail, 'no key stored');
  const set = prov.keyStatus({ setAt: '2026-09-12T08:00:00.000Z' });
  assert.equal(set.installed, true); assert.equal(set.detail, 'key stored 2026-09-12');
});


// -- the global Settings dialog (the cog in the sidebar): the two things it writes
check('rules:writeLocal writes the owner rulebook and refuses every other path', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'gs-'));
  const allowed = path.join(dir, 'orchestrator-system.local.md');
  const neighbour = path.join(dir, 'orchestrator-system.md');       // the shipped file, one letter away
  fs.writeFileSync(neighbour, 'the shipped rules');

  const ok = gset.writeLocalRules(allowed, allowed, '# mine\nAlways branch.\n');
  assert.equal(ok.ok, true); assert.equal(ok.bytes, Buffer.byteLength('# mine\nAlways branch.\n'));
  assert.equal(fs.readFileSync(allowed, 'utf8'), '# mine\nAlways branch.\n');

  // the same file spelled differently is still the same file
  const odd = allowed.replace(/([\\/])([^\\/]+)$/, '$1.$1$2');       // .../x/./orchestrator-system.local.md
  assert.equal(gset.writeLocalRules(odd, allowed, 'via a dotted path').ok, true);
  assert.equal(gset.writeLocalRules(allowed.toUpperCase(), allowed, 'via upper case').ok, true);

  // anything else is refused, and nothing is written
  for (const bad of [neighbour, path.join(dir, 'secrets.json'), path.join(dir, '..', 'anything.md'), path.join(dir, 'sub', 'other.md'), '', null]) {
    const r = gset.writeLocalRules(bad, allowed, 'should never land');
    assert.ok(r.error, 'expected a refusal for ' + bad);
    assert.equal(r.ok, undefined);
  }
  assert.equal(fs.readFileSync(neighbour, 'utf8'), 'the shipped rules');      // untouched
  assert.equal(fs.existsSync(path.join(dir, 'secrets.json')), false);
  assert.equal(fs.readFileSync(allowed, 'utf8'), 'via upper case');           // only our writes landed

  // and a rulebook nobody could have typed is refused too
  assert.match(gset.writeLocalRules(allowed, allowed, 'x'.repeat(gset.MAX_LOCAL_RULES + 1)).error, /capped at/);
  assert.equal(fs.readFileSync(allowed, 'utf8'), 'via upper case');
});

check('unhide: drops one project whatever its spelling, and leaves the list alone when it is not there', () => {
  const hidden = ['C:\\Apps\\One', 'C:\\Apps\\Two\\', 'C:\\Apps\\Three'];
  const next = gset.unhide(hidden, 'c:/apps/two');            // other case, other slashes, no trailing one
  assert.deepEqual(next, ['C:\\Apps\\One', 'C:\\Apps\\Three']);
  assert.equal(gset.unhide(hidden, 'C:\\Apps\\Nope'), hidden);   // same array back: nothing to save
  assert.equal(gset.unhide(hidden, ''), hidden);
  assert.deepEqual(gset.unhide([], 'C:\\Apps\\One'), []);
  assert.deepEqual(gset.unhide(undefined, 'C:\\Apps\\One'), []);

  // the rows the dialog draws: the remembered name when we have one, else the folder name
  const rows = gset.hiddenRows(['C:\\Apps\\One', 'C:\\Apps\\Three'], [{ path: 'c:\\apps\\one\\', name: 'Renamed One', lastSeen: '2026-09-10T10:00:00.000Z' }]);
  assert.deepEqual(rows.map((r) => r.name), ['Renamed One', 'Three']);
  assert.equal(rows[0].lastSeen, '2026-09-10T10:00:00.000Z');
  assert.equal(rows[1].lastSeen, null);
  assert.deepEqual(gset.hiddenRows([], []), []);
});


check('readiness: a tool that is missing, logged out or keyless, and one that is ready', () => {
  const gemini = prov.byId('gemini'), codex = prov.byId('codex'), key = prov.byId('openai-key');

  const missing = prov.readiness(gemini, { installed: false, loggedIn: null }, false);
  assert.deepEqual(missing, { ready: false, reason: 'not-installed', actions: ['install'] });

  const out = prov.readiness(codex, { installed: true, loggedIn: false }, false);
  assert.deepEqual(out, { ready: false, reason: 'not-logged-in', actions: ['login'] });

  assert.deepEqual(prov.readiness(key, null, false), { ready: false, reason: 'no-key', actions: ['settings'] });
  assert.deepEqual(prov.readiness(key, null, true), { ready: true, reason: null, actions: [] });

  const ready = prov.readiness(codex, { installed: true, loggedIn: true }, false);
  assert.deepEqual(ready, { ready: true, reason: null, actions: [] });

  // not installed wins over not logged in: install first, then log in
  assert.equal(prov.readiness(codex, { installed: false, loggedIn: false }, false).reason, 'not-installed');
  // what we do not know is never a complaint: Gemini has no status command, and a probe may not have run
  assert.equal(prov.readiness(gemini, { installed: true, loggedIn: null }, false).ready, true);
  assert.equal(prov.readiness(codex, null, false).ready, true);
  assert.equal(prov.readiness(codex, {}, false).ready, true);
  assert.equal(prov.readiness(null, null, false).ready, true);

  // a provider with no way to install or log in offers no button it cannot honour
  assert.deepEqual(prov.readiness({ kind: 'cli', name: 'X' }, { installed: false }, false).actions, []);
  assert.deepEqual(prov.readiness({ kind: 'cli', name: 'X', install: 'x' }, { installed: true, loggedIn: false }, false).actions, []);
});

check('exec: the one-shot templates, only where the command is verified, and Ollama needs a model too', () => {
  assert.equal(prov.byId('claude').exec, 'claude -p "{prompt}"');
  assert.equal(prov.byId('codex').exec, 'codex exec "{prompt}"');
  assert.equal(prov.byId('gemini').exec, 'gemini -p "{prompt}"');
  assert.equal(prov.byId('aider').exec, 'aider --message "{prompt}" --yes-always');
  assert.equal(prov.byId('goose').exec, null);            // unverified, so nothing is claimed
  // Ollama is the one template with a second placeholder: it has to be told which local model to run
  assert.equal(prov.byId('ollama').exec, 'ollama run {model} "{prompt}"');
  const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  for (const p of prov.PROVIDERS) {
    if (p.exec == null) continue;
    const found = placeholders(p.exec);
    assert.ok(found.includes('prompt'), p.id + ' exec must carry {prompt}');
    for (const f of found) assert.ok(['prompt', 'model'].includes(f), `${p.id} exec has an unknown placeholder {${f}}`);
  }
  assert.equal(prov.list().find((p) => p.id === 'claude').exec, 'claude -p "{prompt}"');   // it crosses IPC
});

check('a tool without a status command is installed-or-not, and never nags for a login', () => {
  // versionProbe leaves loggedIn null on purpose, so readiness() can never ask for a login it cannot start
  for (const id of ['copilot', 'cursor', 'cline', 'opencode', 'aider', 'goose', 'ollama']) {
    const p = prov.byId(id);
    assert.equal(prov.readiness(p, { installed: true, loggedIn: null }, false).ready, true, id + ' must not nag');
    const missing = prov.readiness(p, { installed: false }, false);
    assert.equal(missing.reason, 'not-installed');
    assert.deepEqual(missing.actions, p.install ? ['install'] : [], id + ' offers Install only if it has a line');
  }
});

checkAsync('pool: every item runs, results keep their order, and never more than n at a time', async () => {
  let live = 0, peak = 0;
  const out = await prov.pool([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (x) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--; return x * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  assert.ok(peak <= 4, 'concurrency cap was exceeded: ' + peak);
  assert.ok(peak > 1, 'nothing ran in parallel at all');
  assert.deepEqual(await prov.pool([], 4, async () => 1), []);
});


// -- the dialogs must never wait for a probe: rows first, statuses as they land
check('mergeStatus: an unprobed provider is "checking", never missing, and keys answer at once', () => {
  const cold = prov.mergeStatus(prov.PROVIDERS, null, {});
  assert.deepEqual(Object.keys(cold).sort(), prov.PROVIDERS.map((p) => p.id).sort());   // every row exists
  for (const p of prov.PROVIDERS.filter((x) => x.kind === 'cli')) {
    assert.equal(cold[p.id].checking, true, p.id + ' should be checking');
    assert.equal(cold[p.id].installed, null, p.id + ' must not claim to be missing before it is probed');
    assert.equal(cold[p.id].detail, 'checking…');
  }
  // a key needs no probe: it is answered from the secrets info in the same tick
  assert.equal(cold['openai-key'].checking, undefined);
  assert.equal(cold['openai-key'].detail, 'no key stored');
  const withKey = prov.mergeStatus(prov.PROVIDERS, null, { 'openai-key': { setAt: '2026-09-12T08:00:00.000Z' } });
  assert.equal(withKey['openai-key'].detail, 'key stored 2026-09-12');

  // a cached answer wins, and only that row stops checking
  const warm = prov.mergeStatus(prov.PROVIDERS, { github: { installed: true, version: '2.97.0', detail: 'logged in as alpha' } }, {});
  assert.equal(warm.github.checking, undefined);
  assert.equal(warm.github.version, '2.97.0');
  assert.equal(warm.claude.checking, true);

  // and a row still being checked never raises a callout
  assert.deepEqual(prov.readiness(prov.byId('gemini'), cold.gemini, false), { ready: true, reason: null, actions: [] });
});

check('applyStatusPatch: one provider lands, every other row is left exactly as it was', () => {
  const before = prov.mergeStatus(prov.PROVIDERS, null, {});
  const after = prov.applyStatusPatch(before, { github: { installed: true, version: '2.97.0', detail: 'logged in as alpha', at: 1 } });
  assert.equal(after.github.detail, 'logged in as alpha');
  assert.equal(after.github.checking, undefined);
  for (const id of prov.PROVIDERS.map((p) => p.id)) {
    if (id === 'github') continue;
    assert.deepEqual(after[id], before[id], id + ' must be untouched by a patch that did not mention it');
  }
  assert.equal(Object.keys(after).length, Object.keys(before).length);   // a patch never adds or drops a row
  assert.notEqual(after, before);                                        // and never mutates in place
  assert.equal(before.github.checking, true);
  // an empty or missing patch is a no-op, and an unknown id is simply carried
  assert.deepEqual(prov.applyStatusPatch(before, {}), before);
  assert.deepEqual(prov.applyStatusPatch(before, null), before);
  assert.equal(prov.applyStatusPatch(null, { x: 1 }).x, 1);
});

checkAsync('refreshStatuses reports each provider as it finishes, not once at the end', async () => {
  const fake = [
    { id: 'slow', kind: 'cli', status: async () => { await new Promise((r) => setTimeout(r, 60)); return { installed: true, detail: 'slow' }; } },
    { id: 'fast', kind: 'cli', status: async () => ({ installed: true, detail: 'fast' }) },
    { id: 'broken', kind: 'cli', status: async () => { throw new Error('boom'); } },
  ];
  // the same shape refreshStatuses drives, exercised through pool so the ordering rule is the real one
  const seen = [];
  await prov.pool(fake, 4, async (p) => {
    let st; try { st = await p.status(); } catch (e) { st = { installed: false, detail: 'probe failed', error: String(e.message) }; }
    seen.push(p.id);
    return st;
  });
  assert.equal(seen[0], 'fast', 'a fast probe must not queue behind a slow one');
  assert.equal(seen.length, 3);
  assert.ok(seen.includes('broken'), 'a probe that throws still reports');
});

// ── T-025 · add/create a project: the rules main.js, preload.js and the dialog all share (newproject-lib.js).
check('project name: a folder name that Windows and the sidebar can both live with', () => {
  for (const ok of ['my-project', 'App_2', 'a', 'mission-control', 'sales.api']) assert.equal(np.validateProjectName(ok), null, ok);
  assert.match(np.validateProjectName(''), /Enter a project name/);
  assert.match(np.validateProjectName('   '), /Enter a project name/);
  assert.match(np.validateProjectName(' spaced'), /start or end with a space/);
  assert.match(np.validateProjectName('a/b'), /path separator/);
  assert.match(np.validateProjectName('a\\b'), /path separator/);
  assert.match(np.validateProjectName('.hidden'), /start with a dot/);
  assert.match(np.validateProjectName('trailing.'), /end with a dot/);
  assert.match(np.validateProjectName('a:b'), /cannot contain/);
  assert.match(np.validateProjectName('what?'), /cannot contain/);
  assert.match(np.validateProjectName('CON'), /reserved Windows name/);
  assert.match(np.validateProjectName('lpt1.txt'), /reserved Windows name/);
  assert.match(np.validateProjectName('x'.repeat(101)), /too long/);
  assert.match(np.validateProjectName('a`b'), /backtick or a line break/);
  assert.match(np.validateProjectName('a\nb'), /backtick or a line break/);
  assert.equal(np.validateProjectName('a;whoami'), null);   // legal on Windows: the clone command quotes it instead
});
check('repository input: a URL, a git@ remote or owner/name — anything else is not a repo', () => {
  assert.equal(np.parseRepoInput('https://github.com/octocat/Hello-World').full, 'octocat/Hello-World');
  assert.equal(np.parseRepoInput('https://github.com/octocat/Hello-World.git').full, 'octocat/Hello-World');
  assert.equal(np.parseRepoInput('https://chris@github.com/octocat/Hello-World/').full, 'octocat/Hello-World');
  assert.equal(np.parseRepoInput('git@github.com:octocat/Hello-World.git').full, 'octocat/Hello-World');
  assert.equal(np.parseRepoInput('octocat/Hello-World').url, 'https://github.com/octocat/Hello-World');
  assert.equal(np.parseRepoInput('  octocat/Hello-World  ').name, 'Hello-World');
  for (const bad of ['', 'not a repo', 'https://gitlab.com/a/b', 'octocat']) assert.equal(np.parseRepoInput(bad), null, JSON.stringify(bad));
});
check('clone command: each argument is one literal, so a folder name cannot smuggle in a second command', () => {
  const q = (s) => "gh repo clone 'octocat/Hello-World' '" + s + "'; exit $LASTEXITCODE";
  assert.equal(np.cloneCommand('octocat/Hello-World', 'hello'), q('hello'));
  assert.equal(np.cloneCommand('octocat/Hello-World', 'my folder'), q('my folder'));
  assert.equal(np.cloneCommand('octocat/Hello-World', 'a;whoami'), q('a;whoami'));      // the whole name stays inside the quotes
  assert.equal(np.cloneCommand('octocat/Hello-World', 'x$(y)'), q('x$(y)'));
  assert.equal(np.cloneCommand('octocat/Hello-World', 'a & b'), q('a & b'));
  assert.equal(np.cloneCommand('octocat/Hello-World', "it's"), q("it''s"));            // PowerShell doubles an embedded quote
  assert.equal(np.cloneCommand('o/n', 'hello', { powershell: false }), "gh repo clone 'o/n' 'hello'; exit $?");
  assert.equal(np.cloneCommand('o/n', "it's", { powershell: false }), "gh repo clone 'o/n' 'it'\\''s'; exit $?");   // sh close-escape-reopen
  assert.equal(np.cloneCommand("o';rm -rf /;'", 'n'), "gh repo clone 'o'';rm -rf /;''' 'n'; exit $LASTEXITCODE");   // the repo argument too
});
check('registry entry: added once, whatever the case or the trailing slash (the half of addProjectPath that runs under node)', () => {
  const at = new Date('2026-09-12T10:00:00.000Z');
  let reg = np.addToRegistry([], 'C:\\Apps\\Demo', at);
  assert.deepEqual(reg, [{ path: 'C:\\Apps\\Demo', name: 'Demo', addedAt: '2026-09-12T10:00:00.000Z' }]);
  assert.equal(np.addToRegistry(reg, 'c:\\apps\\demo\\').length, 1);   // already pinned: Windows paths compare case-insensitively
  assert.equal(np.addToRegistry(reg, 'C:\\Apps\\Other').length, 2);
  assert.equal(np.addToRegistry(null, 'C:\\Apps\\Demo').length, 1);      // a missing projects.json is an empty list
});
check('starter CLAUDE.md: the project name as the H1, and the line the lead fills in', () => {
  const md = np.starterClaudeMd('Demo');
  assert.match(md, /^# Demo\r\n/);
  assert.match(md, /Rules for Claude sessions in this repo go here\./);
  assert.equal(md.includes('docs/PLAN.md'), false);
});
check('target folder: the parent must be there and the folder must not', () => {
  assert.match(np.validateTarget('', 'x').error, /Choose a parent folder/);
  assert.match(np.validateTarget(path.join(tmp, 'nope'), 'x').error, /does not exist/);
  assert.match(np.validateTarget(tmp, '.x').error, /start with a dot/);
  assert.equal(np.validateTarget(tmp, 'brand-new').path, path.join(tmp, 'brand-new'));
  fs.mkdirSync(path.join(tmp, 'taken'));
  assert.match(np.validateTarget(tmp, 'taken').error, /already exists/);
  const file = path.join(tmp, 'a-file'); fs.writeFileSync(file, 'x');
  assert.match(np.validateTarget(file, 'x').error, /not a folder/);
});

// createProjectFolder touches the disk and shells out to git, so it (and the summary) run in a tail
// promise: everything above stays synchronous.
  checkAsync('create a project folder: git init and a starter CLAUDE.md, and no half-made folder on a bad name', async () => {
    const r = await np.createProjectFolder({ parent: tmp, name: 'made-here', git: true, claudeMd: true });
    assert.equal(r.error, undefined);
    assert.equal(r.path, path.join(tmp, 'made-here'));
    assert.equal(fs.existsSync(path.join(r.path, '.git')), true);
    assert.match(fs.readFileSync(path.join(r.path, 'CLAUDE.md'), 'utf8'), /^# made-here/);
    const again = await np.createProjectFolder({ parent: tmp, name: 'made-here' });
    assert.match(again.error, /already exists/);
    const plain = await np.createProjectFolder({ parent: tmp, name: 'plain-one', git: false, claudeMd: false });
    assert.equal(fs.existsSync(path.join(plain.path, '.git')), false);
    assert.equal(fs.existsSync(path.join(plain.path, 'CLAUDE.md')), false);
    const bad = await np.createProjectFolder({ parent: tmp, name: 'no/pe' });
    assert.match(bad.error, /path separator/);
    assert.equal(fs.existsSync(path.join(tmp, 'no')), false);
  });


// ── auto-update (T-022): the state machine only, no Electron and no network. `start()` in updater.js
// does nothing but wire electron-updater's events to these transitions, so covering them covers it.
const mkUpdater = (opts = {}) => { const pushed = []; const u = new UpdaterState({ current: '0.2.0', packaged: true, log: () => {}, onChange: (s) => pushed.push(s), ...opts }); return { u, pushed }; };
/** Drive one to `ready` for 0.3.0, which is the only state an install may happen in. */
const readyUpdater = (opts = {}) => { const m = mkUpdater(opts); m.u.checking(); m.u.available('0.3.0'); m.u.downloaded('0.3.0'); return m; };

check('updater: a packaged app starts idle and a dev run starts disabled with a reason', () => {
  assert.equal(mkUpdater().u.snapshot().state, 'idle');
  const dev = mkUpdater({ packaged: false }).u.snapshot();
  assert.equal(dev.state, 'disabled'); assert.equal(dev.reason, 'not packaged'); assert.equal(dev.canInstall, false);
});
check('updater: the whole happy path, one push per transition', () => {
  const { u, pushed } = mkUpdater();
  assert.equal(u.checking().state, 'checking');
  assert.equal(u.available('0.3.0').version, '0.3.0');
  assert.equal(u.progress(41.6).state, 'downloading');
  assert.equal(u.snapshot().percent, 42);                      // rounded, so the chip never shows 41.6%
  const ready = u.downloaded('0.3.0');
  assert.equal(ready.state, 'ready'); assert.equal(ready.percent, 100); assert.equal(ready.canInstall, true);
  assert.equal(pushed.length, 4);
  assert.ok(ready.checkedAt > 0);
});
check('updater: a check that finds nothing goes back to idle and forgets the old version', () => {
  const { u } = mkUpdater();
  u.checking(); u.available('0.3.0'); u.notAvailable();
  const s = u.snapshot();
  assert.equal(s.state, 'idle'); assert.equal(s.version, null); assert.ok(s.checkedAt > 0);
});
check('updater: an error carries its message, the same one twice is one push, and the next check clears it', () => {
  const { u, pushed } = mkUpdater();
  u.checking(); u.failed(new Error('No published versions on GitHub'));
  assert.equal(u.snapshot().state, 'error');
  assert.match(u.snapshot().error, /No published versions/);
  u.failed(new Error('No published versions on GitHub'));   // the event and the rejected promise, one failure
  assert.equal(pushed.length, 2);
  u.failed('something else');
  assert.equal(pushed.length, 3);
  assert.equal(u.checking().error, null);
});
check('updater: percent is clamped, and a bad state name is a programming error', () => {
  const { u } = mkUpdater();
  assert.equal(u.progress(-5).percent, 0);
  assert.equal(u.progress(1000).percent, 100);
  assert.equal(u.progress(undefined).percent, 0);
  assert.throws(() => u.to('nonsense'), /unknown updater state/);
});
check('updater: nothing moves once it is disabled — a dev run can never offer a restart', () => {
  const { u, pushed } = mkUpdater({ packaged: false });
  u.checking(); u.available('0.3.0'); u.downloaded('0.3.0');
  assert.equal(u.snapshot().state, 'disabled');
  assert.equal(pushed.length, 0);
  assert.match(u.installBlocker(), /updates are disabled: not packaged/);
});
// T-028: busy is running workers and nothing else. Terminals are counted for the restart dialog to
// quote, and never block: quitting kills them anyway and a Claude session resumes afterwards.
check('updater: open terminals never block the restart, they are only counted', () => {
  const { u } = readyUpdater({ runningWorkers: () => 0, openTerminals: () => 3 });
  const s = u.snapshot();
  assert.equal(s.terminals, 3);
  assert.equal(s.workers, 0);
  assert.equal(s.busy, false);
  assert.equal(s.canInstall, true);
  assert.equal(u.installBlocker(), null);
});
check('updater: running workers block the install unless the owner forces it', () => {
  let workers = 2;
  const { u } = readyUpdater({ runningWorkers: () => workers, openTerminals: () => 1 });
  assert.equal(u.snapshot().busy, true);
  assert.equal(u.snapshot().workers, 2);
  assert.equal(u.snapshot().canInstall, false);
  assert.equal(u.installBlocker(), '2 workers are still running');   // the text the renderer shows if it ever surfaces
  assert.equal(u.installBlocker(true), null);                        // "Restart anyway"
  workers = 1;
  assert.equal(u.installBlocker(), '1 worker is still running');
  workers = 0;
  assert.equal(u.installBlocker(), null);
  assert.equal(u.snapshot().canInstall, true);
});
check('updater: force is not a way past a disabled updater or a missing download', () => {
  const dev = mkUpdater({ packaged: false }).u;
  assert.match(dev.installBlocker(true), /updates are disabled/);
  const { u } = mkUpdater({ runningWorkers: () => 0 });
  assert.equal(u.installBlocker(true), 'no update is ready');
  u.checking(); u.available('0.3.0');
  assert.equal(u.installBlocker(true), 'no update is ready');
});
check('updater: the payload carries both counts, freshly asked, and survives a missing counter', () => {
  let workers = 0, terminals = 0;
  const { u } = readyUpdater({ runningWorkers: () => workers, openTerminals: () => terminals });
  assert.deepEqual([u.snapshot().workers, u.snapshot().terminals], [0, 0]);
  workers = 1; terminals = 4;
  assert.deepEqual([u.snapshot().workers, u.snapshot().terminals], [1, 4]);   // no caching: the chip is never stale
  terminals = -3; workers = NaN;
  assert.deepEqual([u.snapshot().workers, u.snapshot().terminals], [0, 0]);   // a nonsense count is zero, never NaN
  const bare = mkUpdater().u.snapshot();
  assert.deepEqual([bare.workers, bare.terminals, bare.busy], [0, 0, false]);
});
check('updater: MC_UPDATE_FAKE_READY is a development fixture — ready to look at, never ready to install', () => {
  const logged = [];
  const h = startUpdater({ app: { isPackaged: false, getVersion: () => '0.2.0' }, fakeReady: '0.9.9', runningWorkers: () => 0, openTerminals: () => 2, send: () => {} });
  const orig = console.log; console.log = (...a) => logged.push(a.join(' '));
  let r; try { r = h.installNow({ force: true }); } finally { console.log = orig; }
  assert.equal(h.state().state, 'ready');
  assert.equal(h.state().version, '0.9.9');
  assert.equal(h.state().terminals, 2);
  assert.deepEqual(r, { error: 'not packaged' });               // quitAndInstall cannot run unpackaged
  assert.ok(logged.some((l) => /install requested for 0\.9\.9/.test(l)), 'the attempt is logged');
  h.stop();
  // and it is ignored the moment the app really is packaged: a release never fakes an update
  const real = startUpdater({ app: { isPackaged: true, getVersion: () => '0.2.0' }, fakeReady: '0.9.9', autoUpdater: { on: () => {}, checkForUpdates: () => Promise.resolve() }, send: () => {} });
  assert.equal(real.state().state, 'idle');
  real.stop();
});

check('updater: install is refused before an update is downloaded, however quiet the machine is', () => {
  const { u } = mkUpdater();
  assert.equal(u.installBlocker(), 'no update is ready');
  u.checking(); u.available('0.3.0');
  assert.equal(u.installBlocker(), 'no update is ready');      // available is not downloaded
  u.progress(99);
  assert.equal(u.installBlocker(), 'no update is ready');
});

// ── crash evidence (T-024, diag.js): the black box that has to keep working when everything else does not
check('diag: a log line is one line, carries the pid, and survives a multi-line detail', () => {
  const t = '2026-09-13T08:00:00.000Z';
  assert.equal(diag.formatLine({ time: t, pid: 4242, level: 'info', event: 'startup', detail: 'version=0.2.0' }),
    '2026-09-13T08:00:00.000Z pid=4242 info startup version=0.2.0');
  // a stack is the whole point of the log, and it must not become five lines the reader has to stitch back together
  const err = new Error('boom'); err.stack = 'Error: boom\n    at a (x.js:1:1)\n    at b (y.js:2:2)';
  const line = diag.formatLine({ time: t, pid: 1, level: 'error', event: 'uncaught exception', detail: err });
  assert.equal(line.includes('\n'), false);
  assert.match(line, /pid=1 error uncaught-exception Error: boom \| Error: boom at a \(x\.js:1:1\) at b \(y\.js:2:2\)/);
  // an object detail becomes key=value, and a value with spaces is quoted so the pairs stay readable
  assert.equal(diag.formatLine({ time: t, pid: 7, event: 'render-process-gone', detail: { reason: 'crashed', exitCode: 5, skip: undefined, note: 'two words' } }),
    '2026-09-13T08:00:00.000Z pid=7 info render-process-gone reason=crashed exitCode=5 note="two words"');
  assert.equal(diag.formatLine({ time: t, pid: 7, event: 'quit' }), '2026-09-13T08:00:00.000Z pid=7 info quit');   // no detail, no trailing space
  assert.equal(diag.formatLine().startsWith(new Date().toISOString().slice(0, 11)), true);                          // defaults: now, this pid
  assert.match(diag.formatLine(), new RegExp('pid=' + process.pid + ' info event$'));
});

check('diag: the log rotates at its cap, keeps exactly one .1, and never throws on a missing file', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'diag-'));
  const file = path.join(dir, 'main.log');
  assert.equal(diag.rotate(file, 100), false);                       // nothing there yet
  fs.writeFileSync(file, 'x'.repeat(99));
  assert.equal(diag.rotate(file, 100), false);                       // under the cap: left alone
  assert.equal(fs.existsSync(file + '.1'), false);
  fs.writeFileSync(file, 'first'.padEnd(100, '!'));
  assert.equal(diag.rotate(file, 100), true);
  assert.equal(fs.existsSync(file), false);                          // moved aside; the next write recreates it
  assert.match(fs.readFileSync(file + '.1', 'utf8'), /^first/);
  fs.writeFileSync(file, 'second'.padEnd(100, '!'));
  assert.equal(diag.rotate(file, 100), true);
  assert.match(fs.readFileSync(file + '.1', 'utf8'), /^second/);      // the older .1 is dropped, never a .2
  assert.equal(fs.existsSync(file + '.2'), false);

  // and the writer end to end: one line per event, appended, the pid in every line
  const log = new diag.DiagLog(path.join(dir, 'logs'), { maxBytes: 1024 * 1024 });
  log.write('info', 'startup', { version: '0.2.0' });
  log.write('error', 'render-process-gone', { reason: 'crashed', exitCode: 5 });
  const lines = fs.readFileSync(log.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (const l of lines) assert.match(l, new RegExp('^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z pid=' + process.pid + ' '));
  assert.match(lines[1], /error render-process-gone reason=crashed exitCode=5$/);
  assert.equal(log.info().bytes, fs.statSync(log.file).size);
  assert.equal(log.info().error, null);
});

check('diag: low memory is the commit charge at 80 % or more, or free RAM under 1.5 GB — and the 2026-09-12 sample trips it', () => {
  // The whole point of the guard: the sample that preceded yesterday's silent restarts must raise the flag.
  const crashDay = diag.memoryVerdict({ commitUsedMb: 52 * 1024, commitLimitMb: 65 * 1024, freeMb: 4181 });
  assert.equal(crashDay.low, true); assert.equal(crashDay.commitPct, 80);
  assert.match(crashDay.reasons.join(' '), /commit 80% of 66560 MB/);
  assert.deepEqual(crashDay.reasons.length, 1);                                                          // commit alone; 4181 MB free is still fine
  // and later the same evening, when free RAM had fallen away too, both rules name themselves
  const worse = diag.memoryVerdict({ commitUsedMb: 60 * 1024, commitLimitMb: 65 * 1024, freeMb: 1000 });
  assert.equal(worse.low, true); assert.equal(worse.commitPct, 92.3);
  assert.match(worse.reasons.join(' '), /commit 92\.3% of 66560 MB 1000 MB free RAM/);
  // a healthy machine stays quiet: this is the real sample measured while building T-024
  const calm = diag.memoryVerdict({ commitUsedMb: 14060, commitLimitMb: 61142, freeMb: 6459 });
  assert.equal(calm.low, false); assert.equal(calm.commitPct, 23);
  // the exact boundaries, both rules
  assert.equal(diag.memoryVerdict({ commitUsedMb: 79.9, commitLimitMb: 100, freeMb: 4096 }).low, false);
  assert.equal(diag.memoryVerdict({ commitUsedMb: 80, commitLimitMb: 100, freeMb: 4096 }).low, true);     // 80 % exactly is already low
  assert.equal(diag.memoryVerdict({ commitUsedMb: 1, commitLimitMb: 100, freeMb: 1535 }).low, true);      // free RAM alone is enough
  assert.equal(diag.memoryVerdict({ commitUsedMb: 1, commitLimitMb: 100, freeMb: 1536 }).low, false);
  // nothing known: no flag, no NaN, no throw
  const blind = diag.memoryVerdict({});
  assert.equal(blind.low, false); assert.equal(blind.commitPct, null); assert.equal(blind.freeMb, null);
  assert.equal(diag.memoryVerdict().low, false);
  assert.equal(diag.memoryVerdict({ commitUsedMb: 5, commitLimitMb: 0, freeMb: 2048 }).commitPct, null);  // no limit, no percentage
  assert.equal(diag.memoryVerdict({ commitUsedMb: 'lots', commitLimitMb: NaN, freeMb: -1 }).low, false);
});

check('diag.js loads in a plain node process, with no Electron anywhere near it', () => {
  // main.js requires it before anything else, so a broken require here would take the whole app down
  // before it could log why. This is the same check npm test makes of itself, from a clean process.
  const out = execFileSync(process.execPath, ['-e', "const d = require(process.argv[1]); console.log(typeof d.installHandlers, typeof d.formatLine, d.formatLine({ time: 't', pid: 9, event: 'ok' }));", path.join(__dirname, '..', 'diag.js')], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  assert.equal(out.trim(), 'function function t pid=9 info ok');
});

// ── team chat (docs/TEAM-CHAT-CONTRACT.md, T-027): the four pure pieces, the store and the run step
const chat = require('../chat.js');

check('briefing: the house rules, the answer format and the project all reach the agent', () => {
  const b = chat.buildBriefing({ persona: { name: 'Astra', specialty: 'Gemini, research and docs' }, project: 'MissionControl', goal: 'A lead per project.', tickets: ['T-027 Team chat panel [in-progress]'], messages: [] });
  assert.match(b, /You are Astra \(Gemini, research and docs\)/);
  assert.match(b, /"kind":"chat\|suggestion\|joke"/);
  assert.match(b, /\{"kind":"skip"\}/);
  assert.match(b, /Never claim you did any work/);
  assert.match(b, /T-027 Team chat panel/);
  assert.match(b, /A lead per project\./);
});
check('briefing: it stays inside the budget, dropping the history before the goal', () => {
  const long = (tag) => Array.from({ length: 40 }, (_, i) => `${tag} line ${i} ${'lorem ipsum dolor sit amet '.repeat(4)}`);
  const b = chat.buildBriefing({ persona: { name: 'Dax', specialty: 'Claude' }, project: 'p', goal: 'THE GOAL PARAGRAPH.', tickets: long('ticket'), todos: long('todo'), journal: long('journal'), messages: long('msg').map((t, i) => ({ name: 'N', text: t, agent: 'claude', id: String(i) })) });
  assert.ok(b.length <= chat.BRIEF_BUDGET, 'briefing is ' + b.length + ' chars');
  assert.match(b, /THE GOAL PARAGRAPH\./);          // the goal survives; the history is what goes
  assert.doesNotMatch(b, /journal line 39/);
});
check('briefing: a key-shaped string in the project data is redacted, never handed to a tool', () => {
  const b = chat.buildBriefing({ persona: { name: 'Dax', specialty: 'Claude' }, project: 'p', tickets: ['T-1 rotate sk-abcdefghijklmnopqrstuvwx now'], journal: ['09:00:00 token ghp_ABCDEFGHIJKLMNOPQRST leaked'], messages: [] });
  assert.doesNotMatch(b, /sk-abcdefghij/);
  assert.doesNotMatch(b, /ghp_ABCDEFGHIJ/);
  assert.equal((b.match(/\[redacted\]/g) || []).length, 2);
});

check('parseReply: one JSON object anywhere in the output is the message', () => {
  assert.deepEqual(chat.parseReply('{"kind":"chat","text":"Morning all."}'), { kind: 'chat', text: 'Morning all.' });
  assert.deepEqual(chat.parseReply('thinking…\n```json\n{"kind":"suggestion","text":"Try caching it."}\n```\n'), { kind: 'suggestion', text: 'Try caching it.' });
  assert.equal(chat.parseReply('{"kind":"joke","text":"A byte walked into a bar."}').kind, 'joke');
});
check('parseReply: no JSON falls back to the first real line, as a plain chat message', () => {
  assert.deepEqual(chat.parseReply('\n\nQuiet morning on the board.\nsecond line\n'), { kind: 'chat', text: 'Quiet morning on the board.' });
  assert.deepEqual(chat.parseReply('```\nFenced but plain.\n```'), { kind: 'chat', text: 'Fenced but plain.' });
});
check('parseReply: skip, empty output and an empty text all mean "nothing this round"', () => {
  assert.equal(chat.parseReply('{"kind":"skip"}'), null);
  assert.equal(chat.parseReply('skip'), null);
  assert.equal(chat.parseReply('{"kind":"chat","text":"   "}'), null);
  assert.equal(chat.parseReply(''), null);
  assert.equal(chat.parseReply('\n \n'), null);
});
check('parseReply: an over-long message and a key-shaped one are dropped, not truncated', () => {
  // spaces on purpose: a 400-character run with none is itself key-shaped, and dropped for that reason
  const words = (n) => { let t = ''; while (t.length < n) t += 'lorem '; return t.slice(0, n).replace(/ $/, 'x'); };
  assert.equal(chat.parseReply(JSON.stringify({ kind: 'chat', text: words(401) })), null);
  assert.equal(chat.parseReply(JSON.stringify({ kind: 'chat', text: words(399) })).text.length, 399);
  assert.equal(chat.parseReply(JSON.stringify({ kind: 'chat', text: 'x'.repeat(399) })), null);   // one long run = key-shaped
  assert.equal(chat.parseReply('{"kind":"chat","text":"use sk-abcdefghijklmnopqrst for that"}'), null);
  assert.equal(chat.parseReply('the token is ghp_ABCDEFGHIJKLMNOPQRSTUV'), null);
});
check('parseReply: an unknown or system kind is demoted to chat — only the app writes system lines', () => {
  assert.equal(chat.parseReply('{"kind":"system","text":"Dax joined"}').kind, 'chat');
  assert.equal(chat.parseReply('{"kind":"shout","text":"hi"}').kind, 'chat');
});

const AGENTS = { roster: ['claude', 'gemini', 'ollama'], capPerAgentPerHour: 6, capPerProjectPerDay: 80 };
check('nextAgent: round-robin from whoever spoke last, and back round the roster', () => {
  assert.equal(chat.nextAgent({ ...AGENTS }), 'claude');
  assert.equal(chat.nextAgent({ ...AGENTS, last: 'claude' }), 'gemini');
  assert.equal(chat.nextAgent({ ...AGENTS, last: 'ollama' }), 'claude');
  assert.equal(chat.nextAgent({ ...AGENTS, roster: [] }), null);
});
check('nextAgent: muted, capped and not-ready agents are skipped; unknown readiness is not a refusal', () => {
  assert.equal(chat.nextAgent({ ...AGENTS, muted: ['gemini'], last: 'claude' }), 'ollama');
  assert.equal(chat.nextAgent({ ...AGENTS, perAgent: { gemini: 6 }, last: 'claude' }), 'ollama');
  assert.equal(chat.nextAgent({ ...AGENTS, ready: { gemini: false }, last: 'claude' }), 'ollama');
  assert.equal(chat.nextAgent({ ...AGENTS, ready: { gemini: null }, last: 'claude' }), 'gemini');
  assert.equal(chat.nextAgent({ ...AGENTS, muted: ['claude', 'gemini', 'ollama'] }), null);
});
check('nextAgent: the project cap silences everyone for the rest of the day', () => {
  assert.equal(chat.nextAgent({ ...AGENTS, today: 80 }), null);
  assert.equal(chat.nextAgent({ ...AGENTS, today: 79 }), 'claude');
});
check('restingAgents: exactly the ones at or over the hourly cap', () => {
  assert.deepEqual(chat.restingAgents({ claude: 6, gemini: 2 }, 6), ['claude']);
  assert.deepEqual(chat.restingAgents({ claude: 6 }, 0), []);
});

const CHAT_ON = { enabled: true, visible: true, hasWindow: true, interval: 4 * 60000 };
check('shouldRound: off, hidden or window-less means no round, and says which', () => {
  assert.match(chat.shouldRound({ ...CHAT_ON, enabled: false }).reason, /chat is off/);
  assert.equal(chat.shouldRound({ ...CHAT_ON, enabled: false }).run, false);
  assert.match(chat.shouldRound({ ...CHAT_ON, visible: false }).reason, /panel is hidden/);
  assert.equal(chat.shouldRound({ ...CHAT_ON, visible: false }).run, false);
  assert.equal(chat.shouldRound({ ...CHAT_ON, hasWindow: false }).run, false);
});
check('shouldRound: the jittered interval has to elapse', () => {
  const now = 10 * 60000;
  assert.equal(chat.shouldRound({ ...CHAT_ON, now, lastRoundAt: now - 3 * 60000 }).run, false);
  assert.equal(chat.shouldRound({ ...CHAT_ON, now, lastRoundAt: now - 5 * 60000 }).run, true);
  assert.equal(chat.shouldRound({ ...CHAT_ON, now, lastRoundAt: now - 5 * 60000 }).reason, 'interval');
});
check('shouldRound: an event jumps the queue, but only one event round every two minutes', () => {
  const now = 60 * 60000;
  const ev = { ...CHAT_ON, now, lastRoundAt: now, pendingEvent: 'T-027 moved to in-progress' };
  assert.deepEqual(chat.shouldRound({ ...ev, lastEventRoundAt: now - 3 * 60000 }), { run: true, reason: 'event' });
  const coalesced = chat.shouldRound({ ...ev, lastEventRoundAt: now - 30000 });
  assert.equal(coalesced.run, false);
  assert.match(coalesced.reason, /coalesced/);
});
check('shouldRound: MC_CHAT_ROUND_NOW (force) skips the wait but never the off/hidden check', () => {
  const now = 60 * 60000;
  assert.equal(chat.shouldRound({ ...CHAT_ON, now, lastRoundAt: now, force: true }).run, true);
  assert.equal(chat.shouldRound({ ...CHAT_ON, now, visible: false, lastRoundAt: 0, force: true }).run, false);
});

// ── the store: one jsonl per project, the boards.js conventions
const chatDir = path.join(tmp, 'chat');
const CHAT_PROJ = 'C:\\ClaudeApps\\MissionControl';
check('ChatStore: a missing file is an empty chat, and append round-trips', () => {
  const st = new chat.ChatStore(chatDir);
  assert.deepEqual(st.read(CHAT_PROJ), []);
  const m = st.append(CHAT_PROJ, { agent: 'claude', name: 'Dax', kind: 'chat', text: 'Morning.' });
  assert.match(m.id, /^c/); assert.match(m.ts, /^\d{4}-\d{2}-\d{2}T/);
  const back = st.read(CHAT_PROJ);
  assert.equal(back.length, 1);
  assert.deepEqual({ agent: back[0].agent, name: back[0].name, kind: back[0].kind, text: back[0].text }, { agent: 'claude', name: 'Dax', kind: 'chat', text: 'Morning.' });
  assert.equal(path.basename(st.file(CHAT_PROJ)), 'c-claudeapps-missioncontrol.jsonl');
});
check('ChatStore: a half-written line is skipped, not fatal', () => {
  const st = new chat.ChatStore(chatDir);
  fs.appendFileSync(st.file(CHAT_PROJ), '{"id":"broken","ts":\n');
  st.append(CHAT_PROJ, { agent: 'gemini', name: 'Astra', kind: 'joke', text: 'A byte walked in.' });
  const back = st.read(CHAT_PROJ);
  assert.equal(back.length, 2);
  assert.equal(back[1].kind, 'joke');
});
check('ChatStore: append redacts a key and clips to 400 chars — the store is never a leak', () => {
  const st = new chat.ChatStore(path.join(chatDir, 'redact'));
  const m = st.append(CHAT_PROJ, { agent: 'claude', name: 'Dax', kind: 'chat', text: 'key sk-abcdefghijklmnopqrstuv ' + 'y'.repeat(500) });
  assert.doesNotMatch(m.text, /sk-abcdefghij/);
  assert.ok(m.text.length <= 400);
});
check('ChatStore: prune drops everything older than 30 days and keeps the rest in order', () => {
  const st = new chat.ChatStore(path.join(chatDir, 'prune'));
  const now = Date.parse('2026-09-13T10:00:00.000Z');
  const at = (days, text) => st.append(CHAT_PROJ, { ts: new Date(now - days * 24 * 3600e3).toISOString(), agent: 'claude', name: 'Dax', kind: 'chat', text });
  at(40, 'ancient'); at(31, 'old'); at(2, 'recent'); at(0, 'now');
  assert.equal(st.prune(CHAT_PROJ, 30, now), 2);
  assert.deepEqual(st.read(CHAT_PROJ).map((m) => m.text), ['recent', 'now']);
  assert.equal(st.prune(CHAT_PROJ, 30, now), 0);      // idempotent
});
check('ChatStore: clear moves the file to .bak instead of deleting it; forwarded marks one message', () => {
  const st = new chat.ChatStore(path.join(chatDir, 'clear'));
  const m = st.append(CHAT_PROJ, { agent: 'claude', name: 'Dax', kind: 'suggestion', text: 'Cache the branch list.' });
  assert.equal(st.forwarded(CHAT_PROJ, m.id, '2026-09-13T11:00:00.000Z').forwarded, '2026-09-13T11:00:00.000Z');
  assert.equal(st.read(CHAT_PROJ)[0].forwarded, '2026-09-13T11:00:00.000Z');
  assert.equal(st.forwarded(CHAT_PROJ, 'nope'), null);
  const r = st.clear(CHAT_PROJ);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(st.file(CHAT_PROJ)), false);
  assert.equal(fs.existsSync(st.file(CHAT_PROJ) + '.bak'), true);
  assert.deepEqual(st.read(CHAT_PROJ), []);
  assert.deepEqual(st.clear(CHAT_PROJ), { ok: true, moved: null });   // nothing to move the second time
});
check('ChatStore: the caps are counted from the file — per agent per hour, per project per day', () => {
  const st = new chat.ChatStore(path.join(chatDir, 'caps'));
  const now = new Date(); now.setHours(12, 0, 0, 0);
  const at = (minsAgo, agent, kind = 'chat') => st.append(CHAT_PROJ, { ts: new Date(now.getTime() - minsAgo * 60000).toISOString(), agent, name: 'N', kind, text: 'x' });
  at(10, 'claude'); at(20, 'claude'); at(90, 'claude'); at(5, 'gemini'); at(1, 'gemini', 'system');
  const c = st.counts(CHAT_PROJ, now.getTime());
  assert.deepEqual(c.agent, { claude: 2, gemini: 1 });   // the 90-minute-old one is out of the hour
  assert.equal(c.today, 4);                              // the system line is not an agent's turn
});

// ── the run step: the chat's own Claude template, and which tools read stdin
check('execPlan: Claude in the chat runs the cheapest model, and the registry exec is untouched', () => {
  const p = chat.execPlan('claude', { settings: chat.DEFAULTS(), resolve: () => 'C:\\npm\\claude.CMD' });
  assert.deepEqual(p.args, ['-p', '--model', 'haiku']);
  assert.equal(p.stdin, true);
  assert.equal(p.bin, 'C:\\npm\\claude.CMD');
  assert.equal(prov.byId('claude').exec, 'claude -p "{prompt}"');   // the owner's terminals still get this
});
check('execPlan: Ollama refuses to run without a model, and takes the prompt as an argument', () => {
  assert.match(chat.execPlan('ollama', { settings: chat.DEFAULTS(), resolve: () => 'ollama.exe' }).error, /pick an Ollama model/);
  const s = chat.normalizeSettings({ model: { ollama: 'llama3.2' } });
  const p = chat.execPlan('ollama', { settings: s, resolve: () => 'ollama.exe' });
  assert.deepEqual(p.args, ['run', 'llama3.2', '{prompt}']);
  assert.equal(p.stdin, false);
});
check('execPlan: a tool that is not installed, and one with no exec line, both say so instead of running', () => {
  assert.match(chat.execPlan('gemini', { resolve: () => null }).error, /not installed/);
  assert.match(chat.execPlan('goose', { resolve: () => 'goose.exe' }).error, /no non-interactive command/);
  assert.match(chat.execPlan('nope', {}).error, /unknown provider/);
});
check('chatEnv strips the two variables that make a nested Claude refuse to start', () => {
  assert.deepEqual(chat.chatEnv({ PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }), { PATH: 'x' });
});
check('tokenize keeps a quoted argument in one piece', () => {
  assert.deepEqual(chat.tokenize('agent -p "{prompt}" --output-format json'), ['agent', '-p', '{prompt}', '--output-format', 'json']);
});
check('parseOllamaList reads the model names out of `ollama list`', () => {
  const out = 'NAME              ID            SIZE      MODIFIED\nllama3.2:latest   a80c4f17acd5  2.0 GB    2 days ago\nqwen2.5-coder:7b  2b0496514337  4.7 GB    3 weeks ago\n';
  assert.deepEqual(chat.parseOllamaList(out), ['llama3.2:latest', 'qwen2.5-coder:7b']);
  assert.deepEqual(chat.parseOllamaList(''), []);
});
check('normalizeSettings: the contract defaults, and nonsense from disk cannot break the scheduler', () => {
  assert.deepEqual(chat.normalizeSettings(null), { enabled: false, visible: false, roster: [], muted: [], capPerAgentPerHour: 6, capPerAgent: { claude: 4 }, capPerProjectPerDay: 80, model: { claude: 'haiku', ollama: null } });
  const s = chat.normalizeSettings({ enabled: 1, roster: ['claude', 'claude', 'not-a-tool'], capPerAgentPerHour: 'x', capPerProjectPerDay: 99999 });
  assert.deepEqual(s.roster, ['claude']);
  assert.equal(s.enabled, true);
  assert.equal(s.capPerAgentPerHour, 6);
  assert.equal(s.capPerProjectPerDay, 1000);
});
check('readGoal pulls the Goal paragraph out of a project docs/PLAN.md, and shrugs when there is none', () => {
  const proj = path.join(tmp, 'chat-proj'); fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'docs', 'PLAN.md'), '# Plan\n\n## Goal\nEvery project gets a lead\nthat remembers.\n\n## Branching model\nnot this.\n');
  assert.equal(chat.readGoal(proj), 'Every project gets a lead that remembers.');
  assert.equal(chat.readGoal(path.join(tmp, 'nothing-here')), null);
});
check('readJournalTail takes the last lines of the machine-written journal, not its frontmatter', () => {
  const mem = path.join(tmp, 'chat-mem'); fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'mission-control-journal.md'), '---\nname: x\n---\n\n## 2026-09-13\n- 09:00:00 owner: start\n- 09:05:00 board · T-027 new → in-progress\n');
  assert.deepEqual(chat.readJournalTail(mem, 8), ['09:00:00 owner: start', '09:05:00 board · T-027 new → in-progress']);
  assert.deepEqual(chat.readJournalTail(path.join(tmp, 'nope'), 8), []);
});
check('the demo fixture the screenshot uses parses, and has a greeting, a joke and a suggestion', () => {
  const msgs = chat.fixture(path.join(__dirname, 'fixtures', 'chat-demo.jsonl'));
  assert.ok(msgs.length >= 12, 'fixture has ' + msgs.length + ' messages');
  assert.equal(new Set(msgs.map((m) => m.agent)).size, 3);
  for (const kind of ['system', 'joke', 'suggestion', 'chat']) assert.ok(msgs.some((m) => m.kind === kind), 'no ' + kind + ' in the fixture');
  for (const m of msgs) { assert.ok(m.text.length <= 400); assert.equal(chat.looksSecret(m.text), false); }
  assert.equal(chat.fixture(path.join(tmp, 'no-such-fixture.jsonl')), null);
});
check('the persona a message is stored with is the one renderer/persona.js draws for that provider id', () => {
  // main.js writes the name, the renderer draws the avatar from the seed: both must read the same list,
  // or a roster chip and its own messages would disagree about who just spoke.
  const namesOf = (f) => JSON.parse('[' + /const NAMES = \[([\s\S]*?)\];/.exec(fs.readFileSync(f, 'utf8'))[1].replace(/'/g, '"') + ']');
  assert.deepEqual(namesOf(path.join(__dirname, '..', 'chat.js')), namesOf(path.join(__dirname, '..', 'renderer', 'persona.js')));
  assert.equal(chat.persona('claude').seed, 'chat:claude');
  assert.match(chat.persona('gemini').specialty, /^Google Gemini CLI, /);
});

// AI Collaboration decides which AIs may touch a project (docs/ACCOUNTS-CONTRACT.md); the chat obeys it.
// A stub service: every dependency of ChatService is a callback, so this needs no Electron and no disk.
const stubChat = (over = {}) => {
  const store = {};
  return new chat.ChatService({
    dir: path.join(tmp, 'chat-stub'),
    getSettings: () => store.chat,
    setSettings: (_p, next) => { store.chat = next; },
    listProjects: () => [],
    readyOf: () => true,
    log: () => { },
    ...over,
  });
};
check('candidates: a provider disabled for the project in AI Collaboration is never offered under "+ add"', () => {
  const off = new Set(['gemini']);
  const svc = stubChat({ isEnabled: (_p, id) => !off.has(id) });
  svc.set(CHAT_PROJ, { roster: [] });
  const ids = svc.candidates(CHAT_PROJ).map((c) => c.id);
  assert.ok(ids.includes('claude'), 'an enabled tool is offered');
  assert.equal(ids.includes('gemini'), false, 'a disabled tool must not be offered');
  // and it cannot be smuggled in behind the menu's back
  svc.addAgent(CHAT_PROJ, 'gemini');
  assert.deepEqual(svc.get(CHAT_PROJ).roster, []);
});
check('roster: an agent disabled in AI Collaboration after joining stays listed, says why, and never speaks', () => {
  let off = false;
  const svc = stubChat({ isEnabled: (_p, id) => !(off && id === 'gemini') });
  svc.set(CHAT_PROJ, { roster: ['claude', 'gemini'] });
  assert.deepEqual(svc.roster(CHAT_PROJ).map((r) => [r.id, r.ready]), [['claude', true], ['gemini', true]]);
  off = true;
  const rows = svc.roster(CHAT_PROJ);
  assert.equal(rows.length, 2, 'it stays in the roster');
  const gem = rows.find((r) => r.id === 'gemini');
  assert.equal(gem.ready, false);
  assert.match(gem.reason, /disabled in AI Collaboration/);
  assert.equal(svc.agentReady(CHAT_PROJ, 'claude').ready, true);
  // and the scheduler's own pick skips it: after Claude speaks, the turn comes back to Claude
  const ready = {}; for (const id of ['claude', 'gemini']) ready[id] = svc.agentReady(CHAT_PROJ, id).ready;
  assert.equal(chat.nextAgent({ roster: ['claude', 'gemini'], ready, last: 'claude', capPerAgentPerHour: 6, capPerProjectPerDay: 80 }), 'claude');
});
check('caps: Claude has its own lower hourly cap, because it spends the owner\'s Claude plan', () => {
  const d = chat.normalizeSettings(null);
  assert.equal(d.capPerAgentPerHour, 6);
  assert.equal(d.capPerAgent.claude, 4);
  const state = { roster: ['claude', 'gemini'], capPerAgentPerHour: 6, capPerAgent: d.capPerAgent, capPerProjectPerDay: 80 };
  assert.equal(chat.nextAgent({ ...state, perAgent: { claude: 3 } }), 'claude');   // under its own cap
  assert.equal(chat.nextAgent({ ...state, perAgent: { claude: 4 } }), 'gemini');   // at 4 Claude rests
  assert.equal(chat.nextAgent({ ...state, perAgent: { gemini: 4 }, last: 'claude' }), 'gemini');  // 4 is not everyone's cap
  assert.equal(chat.nextAgent({ ...state, perAgent: { gemini: 6 }, last: 'claude' }), 'claude');
  assert.deepEqual(chat.restingAgents({ claude: 4, gemini: 4 }, 6, d.capPerAgent), ['claude']);
});


check('every module main.js and preload.js require must be in build.files, or the installed app dies on boot', () => {
  // PR #10 and #11 added providers.js, secrets.js, globalsettings.js and newproject-lib.js and never
  // added them to the electron-builder file list. `npm run dist` was happy; the packaged app threw
  // "Cannot find module ./providers" at the first require and never drew a window. Never again.
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const listed = new Set(pkg.build.files.filter((f) => !f.startsWith('!')));
  const needed = new Set();
  for (const src of ['main.js', 'preload.js']) {
    for (const m of fs.readFileSync(path.join(root, src), 'utf8').matchAll(/require\('\.\/([\w-]+)'\)/g)) needed.add(m[1] + '.js');
  }
  const missing = [...needed].filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], 'not packaged: ' + missing.join(', '));
  for (const f of needed) assert.equal(fs.existsSync(path.join(root, f)), true, f + ' is required but not in the repo');
});

// ── the release guard the workflow runs before it builds (build/check-version.js)
check('version guard: the tag must be vX.Y.Z and must name the version in package.json', () => {
  assert.deepEqual(checkVersion('v0.2.0', '0.2.0'), { ok: true, version: '0.2.0' });
  assert.match(checkVersion('v0.3.0', '0.2.0').message, /does not match package.json version "0.2.0"/);
  assert.match(checkVersion('v0.3.0', '0.2.0').message, /"version": "0.3.0"/);   // it says what to fix
  assert.match(checkVersion('0.2.0', '0.2.0').message, /not of the form vX.Y.Z/);
  assert.match(checkVersion('release-0.2.0', '0.2.0').message, /not of the form vX.Y.Z/);
  assert.match(checkVersion('', '0.2.0').message, /only runs on a pushed tag/);
  assert.match(checkVersion('v0.2.0', '').message, /no version field/);
  assert.equal(checkVersion(' v0.2.0 ', ' 0.2.0 ').ok, true);                    // a CI variable may carry whitespace
});
check('version guard: this repo is tagged and versioned consistently right now', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(checkVersion('v' + pkg.version, pkg.version).ok, true);
});

(async () => {
  for (const [title, fn] of asyncChecks) { await fn(); n++; console.log('  ok  ' + title); }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`unit PASS  ${n} checks`);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });

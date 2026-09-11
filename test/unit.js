#!/usr/bin/env node
'use strict';
// Unit checks for pure functions. Runs before the smoke test (`npm test`), takes milliseconds, no Electron.
const assert = require('node:assert/strict');
const { postMergeVerdict } = require('../prwatch.js');
const { parsePorcelain, parseNameStatus, parseWorktrees } = require('../explorer.js');
const { relTo } = require('../transcripts.js');
const { Rules, renderOwnerRules, readText, sources, localDay } = require('../rules.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const wf = (name, conclusion) => ({ kind: 'workflow', name, done: true, ok: conclusion === 'success', cancelled: conclusion === 'cancelled', url: 'https://example.test/' + name });
const dep = (env, state) => ({ kind: 'deployment', name: env, done: true, ok: state === 'success', cancelled: false, url: '' });

let n = 0;
function check(title, fn) { fn(); n++; console.log('  ok  ' + title); }

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
  const run = (...a) => execFileSync(process.execPath, [script, ...a, '--project', proj], { env: { ...process.env, MC_DATA_DIR: dataDir }, encoding: 'utf8' }).trim();
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

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`unit PASS  ${n} checks`);

#!/usr/bin/env node
'use strict';
// Unit checks for pure functions. Runs before the smoke test (`npm test`), takes milliseconds, no Electron.
const assert = require('node:assert/strict');
const { postMergeVerdict } = require('../prwatch.js');
const { parsePorcelain, parseNameStatus, parseWorktrees } = require('../explorer.js');
const { relTo } = require('../transcripts.js');

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

console.log(`unit PASS  ${n} checks`);

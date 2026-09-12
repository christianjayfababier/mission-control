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


// -- accounts & AI (docs/ACCOUNTS-CONTRACT.md): the registry's shape, the pure env assembly, the secrets
// file format against a fake encryptor, and the status parsers fed the output real vendors printed here.
check('registry: every provider has the fields the renderer and the wizard rely on, and list() drops the probes', () => {
  const ids = prov.PROVIDERS.map((p) => p.id);
  assert.deepEqual(ids, ['claude', 'github', 'codex', 'gemini', 'anthropic-key', 'openai-key', 'gemini-key']);
  for (const p of prov.PROVIDERS) {
    assert.ok(p.name && p.docs, p.id + ' needs a name and a docs link');
    assert.ok(['cli', 'key'].includes(p.kind));
    assert.ok(['required', 'ai', 'vcs'].includes(p.role));
    if (p.kind === 'cli') { assert.ok(p.bin, p.id + ' needs a bin'); assert.equal(typeof p.status, 'function'); assert.ok(p.install, p.id + ' needs an install line'); }
    else { assert.ok(/^[A-Z_]+$/.test(p.envVar), p.id + ' needs an env var'); assert.equal(p.status, undefined); }
  }
  // the install lines are the ones the contract verified; gemini has no winget package
  assert.match(prov.installLine('claude'), /^winget install --id Anthropic\.ClaudeCode -e /);
  assert.match(prov.installLine('github'), /^winget install --id GitHub\.cli -e /);
  assert.equal(prov.installLine('gemini'), 'npm install -g @google/gemini-cli');
  assert.equal(prov.byId('github').login, 'gh auth login -h github.com -w');
  const serialized = prov.list();
  assert.equal(serialized.length, prov.PROVIDERS.length);
  for (const p of serialized) assert.equal(p.status, undefined);
  assert.doesNotThrow(() => JSON.stringify(serialized));   // it has to survive the IPC boundary
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

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`unit PASS  ${n} checks`);

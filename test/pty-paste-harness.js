#!/usr/bin/env node
'use strict';
// MANUAL, opt-in harness — NOT part of `npm test`. It spends a few real Claude (haiku) turns.
//
// Why it exists: Claude Code's Windows TUI (2.1.269) keeps only the LAST ConPTY chunk of a single
// large write, so a composer message or a paste above ~1000 characters loses its beginning. The fix
// in renderer/app.js writes long text in small slices with a gap; this harness proves it against a
// real TUI. The slicing parameters below MUST match PTY_SLICE / PTY_SLICE_GAP / PTY_ENTER_DELAY and
// sliceForPty() in renderer/app.js (the renderer file cannot be `require`d from node: it is a plain
// <script> that touches window on load, so the numbers are repeated here on purpose).
//
// Run from the worktree root (node-pty needs the Electron ABI, so run it through Electron-as-node):
//   ELECTRON_RUN_AS_NODE=1 npx electron test/pty-paste-harness.js [cwd-for-claude]
// The folder claude starts in must already be trusted (no trust dialog), otherwise nothing is sent;
// pass a trusted folder as the first argument. Default: the current working directory.
//
// It prints one INTACT/TRUNCATED line per case, read back from the session transcript, then deletes
// that transcript. Expect: old-* TRUNCATED, every sliced-* INTACT.

const pty = require('node-pty');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Keep in sync with renderer/app.js (PTY_SLICE, PTY_SLICE_GAP, PTY_ENTER_DELAY, sliceForPty).
const PTY_SLICE = 512;
const PTY_SLICE_GAP = 25;
const PTY_ENTER_DELAY = 120;
function sliceForPty(text, max = PTY_SLICE) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const c = text.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end -= 1; // never split a surrogate pair
      const esc = text.lastIndexOf('\x1b', end - 1);
      if (esc > i && end - esc < 16) end = esc; // never split an escape sequence
    }
    if (end <= i) end = Math.min(i + max, text.length);
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

const cwd = process.argv[2] || process.cwd();
const sid = crypto.randomUUID();
const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k]; // nested-session guard
delete env.ELECTRON_RUN_AS_NODE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p = pty.spawn('powershell.exe', ['-NoLogo'], { name: 'xterm-256color', cols: 140, rows: 40, cwd, env, useConpty: true });
let out = '';
p.onData((d) => { out += d; });
const w = (s) => p.write(s);

function filler(n, multiline) {
  let s = '';
  let i = 0;
  while (s.length < n) s += multiline && i % 80 === 79 ? '\n' : String(i % 10), i++;
  return s.slice(0, n);
}
const message = (tag, n, multiline) => `${tag} START ${filler(n, multiline)} END ${tag}. Reply with the single word ok.`;

// The two strategies under test. `old` is what renderer/app.js did before T-018.
async function sendOld(body) { w(body); await sleep(PTY_ENTER_DELAY); w('\r'); }
async function sendSliced(body, { bracket = false } = {}) {
  if (bracket) w('\x1b[200~');
  for (const part of sliceForPty(body)) { w(part); await sleep(PTY_SLICE_GAP); }
  if (bracket) w('\x1b[201~');
  await sleep(PTY_ENTER_DELAY);
  w('\r');
}

const cases = [
  { tag: 'old-1500', n: 1500, send: (b) => sendOld(b) },
  { tag: 'sliced-1500', n: 1500, send: (b) => sendSliced(b) },
  { tag: 'sliced-2500', n: 2500, send: (b) => sendSliced(b) },
  { tag: 'sliced-bracket-1500', n: 1500, send: (b) => sendSliced(b, { bracket: true }) },
  { tag: 'sliced-multiline-1500', n: 1500, multiline: true, send: (b) => sendSliced(b, { bracket: true }) },
];

async function waitIdle() {
  let last = out.length;
  for (let i = 0; i < 60; i++) { await sleep(1000); if (out.length === last && i > 3) return; last = out.length; }
}

(async () => {
  console.log('session', sid, 'cwd', cwd);
  await sleep(1500);
  w(`claude --session-id ${sid} --model haiku\r`);
  await sleep(6000);
  await waitIdle();
  for (const c of cases) {
    process.stdout.write('sending ' + c.tag + '\n');
    await c.send(message(c.tag, c.n, c.multiline));
    await sleep(3000);
    await waitIdle();
  }
  w('/exit\r');
  await sleep(2500);
  p.kill();

  const root = path.join(os.homedir(), '.claude', 'projects');
  let file = null;
  for (const d of fs.readdirSync(root)) { const f = path.join(root, d, sid + '.jsonl'); if (fs.existsSync(f)) file = f; }
  if (!file) { console.log('no transcript found for ' + sid + ' — did the trust dialog block the session?'); process.exit(1); }
  const seen = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'user' || !j.message) continue;
    const c = j.message.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('') : '';
    if (!t || t.startsWith('<')) continue;
    const tail = /END (\S+)\./.exec(t);
    const tag = tail ? tail[1] : '?';
    seen.set(tag, t.startsWith(tag + ' START')
      ? `${tag}: INTACT (${t.length} chars)`
      : `${tag}: TRUNCATED, kept ${t.length} chars, head=${JSON.stringify(t.slice(0, 24))}`);
  }
  for (const c of cases) console.log(seen.get(c.tag) || `${c.tag}: MISSING (never reached the transcript)`);
  fs.unlinkSync(file);
  console.log('deleted test transcript ' + file);
  process.exit(0);
})();

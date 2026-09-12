'use strict';
/*
 globalsettings — the pure half of the Settings dialog (the cog at the bottom of the sidebar).

 Two of its four sections write something, and both writes are worth testing without Electron:

 1. Global rules: the owner's own additions to every lead's rulebook live in exactly one file,
    DATA_DIR/orchestrator-system.local.md. `writeLocalRules()` is the only writer, and it refuses any
    path that is not that file — the renderer hands us a path, so this is the gate, the same way
    rules.readText() gates the viewer's reads.
 2. Hidden projects: `unhide()` takes a `hidden` list out of seen-projects.json and returns the list
    without one entry, comparing paths the way the rest of main.js does (trailing slashes and case
    do not matter on Windows).

 Nothing here throws across IPC: a refusal comes back as an `error` field.
*/
const fs = require('fs');
const path = require('path');

const MAX_LOCAL_RULES = 256 * 1024;   // the file is prose; anything larger is a mistake, not a rulebook

/** Compare-only form of a path: resolved, no trailing separator, lower case (Windows is case-insensitive). */
const normPath = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
/** Do two paths name the same file? Purely textual — neither side has to exist yet. */
const sameFile = (a, b) => !!a && !!b && normPath(a) === normPath(b);

/**
 * Write the owner's rulebook additions. `allowed` is main.js's KIT_LOCAL; any other `file` is refused,
 * so a renderer that asks for a different path cannot overwrite it. `{ ok, bytes }` or `{ error }`.
 */
function writeLocalRules(file, allowed, text) {
  if (!sameFile(file, allowed)) return { error: 'this is the only file the Settings dialog may write: ' + allowed };
  const body = String(text == null ? '' : text);
  if (body.length > MAX_LOCAL_RULES) return { error: `that is ${Math.round(body.length / 1024)} KB; the rulebook additions are capped at ${MAX_LOCAL_RULES / 1024} KB` };
  try {
    fs.mkdirSync(path.dirname(allowed), { recursive: true });
    fs.writeFileSync(allowed, body);
    return { ok: true, bytes: Buffer.byteLength(body), at: Date.now() };
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 200) }; }
}

/** The `hidden` list without `p`. Returns the same array when nothing matched, so callers can skip the save. */
function unhide(hidden, p) {
  const list = Array.isArray(hidden) ? hidden : [];
  if (!p) return list;
  const out = list.filter((x) => normPath(x) !== normPath(p));
  return out.length === list.length ? list : out;
}

/** One row per hidden project for the Settings list: the remembered name when we have one, else the folder. */
function hiddenRows(hidden, seenProjects) {
  const seen = Array.isArray(seenProjects) ? seenProjects : [];
  return (Array.isArray(hidden) ? hidden : []).filter(Boolean).map((p) => {
    const rec = seen.find((x) => x && x.path && normPath(x.path) === normPath(p));
    return { path: String(p), name: (rec && rec.name) || String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p), lastSeen: (rec && rec.lastSeen) || null };
  });
}

module.exports = { writeLocalRules, unhide, hiddenRows, sameFile, normPath, MAX_LOCAL_RULES };

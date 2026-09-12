#!/usr/bin/env node
'use strict';
/* Release guard (T-022): the tag that triggered .github/workflows/release.yml must name the same
   version as package.json, or `latest.yml` would advertise a version nobody can download and every
   installed copy would keep re-downloading it. Runs before the build so a mismatch costs seconds,
   not a 90 MB upload.

   Usage: node build/check-version.js v0.2.0 [path/to/package.json]   -> exit 0, or exit 1 and why. */

const path = require('path');
const fs = require('fs');

/** @returns {{ok: true, version: string} | {ok: false, message: string}} */
function checkVersion(tag, version) {
  const t = String(tag == null ? '' : tag).trim();
  const v = String(version == null ? '' : version).trim();
  if (!t) return { ok: false, message: 'No tag given. This workflow only runs on a pushed tag vX.Y.Z.' };
  if (!v) return { ok: false, message: 'package.json has no version field.' };
  if (!/^v\d+\.\d+\.\d+(?:[-+].+)?$/.test(t)) return { ok: false, message: `Tag "${t}" is not of the form vX.Y.Z. Delete it and push a tag that is.` };
  const bare = t.slice(1);
  if (bare !== v) return { ok: false, message: `Tag "${t}" does not match package.json version "${v}". Set "version": "${bare}" in package.json (and rebuild the lockfile), commit, then move the tag.` };
  return { ok: true, version: v };
}

if (require.main === module) {
  try {
    const pkgPath = process.argv[3] || path.join(__dirname, '..', 'package.json');
    const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    const r = checkVersion(process.argv[2], version);
    if (!r.ok) { console.error('version guard: ' + r.message); process.exit(1); }
    console.log(`version guard: tag and package.json agree on ${r.version}`);
  } catch (e) {
    console.error('version guard: ' + ((e && e.message) || e));
    process.exit(1);
  }
}

module.exports = { checkVersion };

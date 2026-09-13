'use strict';
/*
 setup-lib — the pure half of the first-run Setup wizard (T-020), and the `--data-dir` flag.

 Two jobs, both testable under plain node (test/unit.js), neither of them touching Electron:

 1. `resolveDataDir(argv, fallback)`: where this run keeps its data. Normally `~/.claude/mission-control`;
    `--data-dir <path>` moves the whole lot (registry, settings, boards, notes, prwatch, the kit copied in
    at every start) somewhere else for that run only. It exists so a fresh install can be tried on a
    machine that already has one — which is exactly what the wizard has to be verified against.
 2. `shouldOpenSetup(globalSettings, registry)`: does the wizard open by itself? Only on a machine that has
    never finished it AND has no projects yet. Anything else — a completed setup, or a registry with a
    project in it — means the owner has been here before and must never be interrupted by a wizard.
    `setupRecord()` is what Finish writes into settings.json.
*/
const path = require('path');

/**
 * The data directory this run uses. `--data-dir <path>` wins; a flag with no value after it, or a value
 * that is itself another flag, is ignored rather than obeyed half-way. Relative paths resolve against cwd.
 */
function resolveDataDir(argv, fallback) {
  const args = Array.isArray(argv) ? argv : [];
  const i = args.indexOf('--data-dir');
  const raw = i >= 0 ? args[i + 1] : null;
  if (i < 0 || raw == null) return fallback;
  const v = String(raw).trim();
  if (!v || v.startsWith('--')) return fallback;
  return path.resolve(v);
}

/** Has the owner finished the wizard on this machine? The stamp settings.json carries, or null. */
function setupState(globalSettings) {
  const g = globalSettings && typeof globalSettings === 'object' && !Array.isArray(globalSettings) ? globalSettings : {};
  const s = g.setup;
  return s && typeof s === 'object' && s.completedAt ? s : null;
}

/**
 * Pure: should the wizard open on its own at startup? A fresh install is "no completion stamp and no
 * projects in the registry". A completed setup never reopens it, and neither does a registry with
 * something in it — an owner who lost settings.json but has projects is not a first run.
 */
function shouldOpenSetup(globalSettings, registry) {
  if (setupState(globalSettings)) return false;
  const projects = (Array.isArray(registry) ? registry : []).filter(Boolean);
  return projects.length === 0;
}

/** What Finish writes: when it was done, and which version did it. */
function setupRecord(version, now) {
  return { completedAt: new Date(now == null ? Date.now() : now).toISOString(), version: String(version || '') };
}

module.exports = { resolveDataDir, shouldOpenSetup, setupState, setupRecord };

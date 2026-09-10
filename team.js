'use strict';
/*
 Team — the roles a project's orchestrator can dispatch, with the model and effort each one runs at.

 Custom roles live in <project>/.claude/agents/*.md; their `model:` / `effort:` frontmatter is the
 authoritative setting and is rewritten here when the owner changes it. Built-in agent types have no
 file, so their setting is stored in project-settings.json and handed to the lead in its system prompt
 (the Agent tool's `model` parameter overrides frontmatter anyway).
*/
const fs = require('fs');
const path = require('path');

const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const BUILTINS = [
  { name: 'general-purpose', description: 'Built-in: multi-step engineering tasks, code changes, searches; the default worker when no custom role fits.' },
  { name: 'Explore', description: 'Built-in read-only scout: sweeps files and directories and reports where things are; never edits.' },
  { name: 'Plan', description: 'Built-in architect: designs an implementation plan for a task and names the critical files.' },
  { name: 'claude-code-guide', description: 'Built-in documentation guide for Claude Code, the Agent SDK and the Claude API.' },
];

/** Why a role gets a model: cheap where the work is reading and prose, strong where it changes code, strongest where a mistake is irreversible. */
function recommend(name, description = '') {
  const n = String(name).toLowerCase(); const d = String(description).toLowerCase(); const t = n + ' ' + d;
  if (/architect|dba|schema|migration/.test(n) || /schema decisions|migrations/.test(d)) return { model: 'fable', effort: 'high', reason: 'Schema and architecture decisions are costly to flip and every module depends on them; the strongest model pays for itself here.' };
  if (/security/.test(n) || /security review|authorization gaps|injection/.test(d)) return { model: 'fable', effort: 'high', reason: 'A missed authorization gap or injection ships to production; security review deserves the strongest reasoning, and it runs rarely.' };
  if (/qa|test/.test(n) || /regression|e2e|playwright|pest|jest|verifies other workers/.test(d)) return { model: 'opus', effort: 'high', reason: 'QA designs regression and end-to-end tests and must catch what the builders missed; a cheaper model rubber-stamps.' };
  if (/explore|scout/.test(n)) return { model: 'sonnet', effort: 'medium', reason: 'Finding where things live is search and summary, not judgment; Sonnet is fast and cheap. Haiku for trivial lookups.' };
  if (/research|docs|writer|guide|analyst/.test(n) || /research|documentation|reports|summar/.test(d) && !/build|implement|code/.test(d)) return { model: 'sonnet', effort: 'medium', reason: 'Reading, researching and writing prose: Sonnet is accurate enough at a fraction of the cost and makes no code changes.' };
  if (/plan/.test(n)) return { model: 'opus', effort: 'high', reason: 'A plan steers every worker after it; worth a strong model, but it does not need Fable unless the problem is novel.' };
  if (/devops|infra|deploy|ci/.test(n) || /pipeline|deploy|infrastructure|kubernetes|docker/.test(d)) return { model: 'opus', effort: 'high', reason: 'CI/CD and infrastructure changes have a wide blast radius and are hard to test locally; Opus at high effort.' };
  if (/engineer|developer|backend|frontend|mobile|integration|ai|realtime|general/.test(t)) return { model: 'opus', effort: 'high', reason: 'Writes and changes code: Opus at high effort gives the best correctness per dollar. The lead escalates to Fable only when Opus loops or fails twice.' };
  return { model: 'opus', effort: 'high', reason: 'Unknown role: default to Opus at high effort, the safe choice for anything that changes code.' };
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text); if (!m) return null;
  const meta = {}; for (const raw of m[1].split(/\r?\n/)) { const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw); if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, ''); }
  return { meta, raw: m[0], body: text.slice(m[0].length) };
}

function roster(projectPath, overrides = {}) {
  const out = [];
  const dir = path.join(projectPath, '.claude', 'agents');
  let files = []; try { files = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)); } catch { files = []; }
  for (const f of files) {
    const file = path.join(dir, f); let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(text); if (!fm) continue;
    const name = fm.meta.name || f.replace(/\.md$/i, '');
    const rec = recommend(name, fm.meta.description);
    out.push({ name, description: fm.meta.description || '', model: fm.meta.model || null, effort: fm.meta.effort || null, source: 'agent', file, recommended: rec });
  }
  for (const b of BUILTINS) {
    const o = overrides[b.name] || {};
    out.push({ name: b.name, description: b.description, model: o.model || null, effort: o.effort || null, source: 'builtin', file: null, recommended: recommend(b.name, b.description) });
  }
  return out;
}

/** Rewrite (or add) model/effort in an agent file's frontmatter. Empty values remove the line (Claude Code then inherits). */
function setAgentModel(file, { model, effort }) {
  const text = fs.readFileSync(file, 'utf8'); const fm = parseFrontmatter(text); if (!fm) throw new Error('no frontmatter in ' + file);
  const nl = /\r\n/.test(fm.raw) ? '\r\n' : '\n';
  let lines = fm.raw.split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l === ''));
  // lines[0] === '---', last === '---'
  const setKey = (key, value) => {
    const i = lines.findIndex((l) => new RegExp('^' + key + ':').test(l));
    if (value) { if (i >= 0) lines[i] = `${key}: ${value}`; else lines.splice(lines.length - 1, 0, `${key}: ${value}`); }
    else if (i >= 0) lines.splice(i, 1);
  };
  if (model !== undefined) setKey('model', model); if (effort !== undefined) setKey('effort', effort);
  fs.writeFileSync(file, lines.join(nl) + nl + fm.body);
}

module.exports = { roster, recommend, setAgentModel, MODELS, EFFORTS, BUILTINS };

/* Persona — stable names, titles and avatars for orchestrators and workers.
   Names are derived from the agent's id (or the project's key for the lead), so they never change and need no storage. */
'use strict';
(() => {
  const NAMES = ['Atlas', 'Nova', 'Orion', 'Vega', 'Juno', 'Sage', 'Ember', 'Kai', 'Lyra', 'Rowan', 'Iris', 'Felix', 'Mira', 'Theo', 'Zara', 'Idris', 'Nia', 'Cyrus', 'Wren', 'Milo',
    'Astra', 'Bodhi', 'Cleo', 'Dax', 'Elara', 'Finn', 'Gaia', 'Hugo', 'Indra', 'Jett', 'Kira', 'Leo', 'Maya', 'Nico', 'Onyx', 'Pax', 'Quinn', 'Remy', 'Sol', 'Tova',
    'Uma', 'Vale', 'Wade', 'Xena', 'Yara', 'Zed', 'Aria', 'Blaise', 'Cass', 'Dune', 'Echo', 'Faye', 'Gus', 'Hale', 'Ines', 'Jules', 'Kato', 'Lux', 'Moss', 'Nell',
    'Oda', 'Pilar', 'Rune', 'Skye', 'Tarek', 'Ursa', 'Vito', 'Willa', 'Yves', 'Zia'];
  const TITLES = {
    'general-purpose': 'Generalist Engineer', 'claude': 'Generalist Engineer', 'explore': 'Codebase Scout', 'plan': 'Planning Architect', 'claude-code-guide': 'Claude Code Specialist',
    'statusline-setup': 'Tooling Assistant', 'research-analyst': 'Research Analyst', 'architect-dba': 'Architect & DBA', 'backend-engineer': 'Backend Engineer', 'frontend-engineer': 'Frontend Engineer',
    'design-system-engineer': 'Design System Engineer', 'devops-engineer': 'DevOps Engineer', 'docs-writer': 'Technical Writer', 'integrations-engineer': 'Integrations Engineer',
    'mobile-engineer': 'Mobile Engineer', 'qa-engineer': 'QA Engineer', 'security-reviewer': 'Security Reviewer', 'ai-engineer': 'AI Engineer', 'onsite-engineer': 'Onsite Engineer', 'realtime-engineer': 'Realtime Engineer',
  };
  const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
  const name = (seed) => NAMES[hash(seed) % NAMES.length];
  const title = (role) => { const r = String(role || 'agent').toLowerCase(); if (TITLES[r]) return TITLES[r]; return r.split(/[-_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '); };
  const hue = (seed) => hash(seed + ':h') % 360;
  /** Inline SVG avatar: two-tone disc, a soft orbit ring and the initial. `accent` tints the ring (lead = amber, worker = role hue). */
  function avatar(seed, letter, accent) {
    const h = hue(seed), h2 = (h + 40) % 360, ring = accent || `hsl(${(h + 180) % 360} 70% 65%)`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 60% 45%)"/><stop offset="1" stop-color="hsl(${h2} 65% 30%)"/></linearGradient></defs><circle cx="24" cy="24" r="23" fill="url(#g)"/><circle cx="24" cy="24" r="19.5" fill="none" stroke="${ring}" stroke-width="1.6" stroke-dasharray="${8 + (hash(seed) % 20)} 6" opacity=".85"/><text x="24" y="30" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="20" font-weight="700" fill="#f0f6fc">${letter}</text></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }
  const forWorker = (w) => { const n = name('worker:' + w.id); return { name: n, title: title(w.role), avatar: avatar('worker:' + w.id, n[0]) }; };
  const forLead = (p) => { const n = name('lead:' + p.key); return { name: n, title: 'Lead Orchestrator', avatar: avatar('lead:' + p.key, n[0], '#d29922') }; };
  const forSession = (s) => { const n = name('session:' + s.id); return { name: n, title: 'Claude session', avatar: avatar('session:' + s.id, n[0], '#58a6ff') }; };
  window.Persona = { name, title, avatar, forWorker, forLead, forSession };
})();

/* Memory view — a mind-map graph of the selected project's memory notes.
   Data: ~/.claude/projects/<slug>/memory/*.md (frontmatter name/description/type, [[links]] in the body). */
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const TYPE_COLORS = { project: '#58a6ff', user: '#3fb950', feedback: '#d29922', reference: '#bc8cff', note: '#8b98a8', hub: '#e6edf3', missing: '#4b5563' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const unesc = (s) => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  const M = {
    active: false, view: 'graph', data: null, projectKey: null, nodes: [], edges: [], byName: new Map(), selected: null, hover: null,
    filter: '', cam: { x: 0, y: 0, k: 1 }, drag: null, panning: null, anim: null, timer: null,
  };
  const canvas = $('#mem-canvas'); const ctx = canvas.getContext('2d');

  // ───────── view switching (hooks into app.js state via DOM + window.MC bridge)
  function setMode(memory) {
    M.active = memory;
    $('#body').classList.toggle('memory-mode', memory);
    $('#view-memory').classList.toggle('active', memory); $('#view-work').classList.toggle('active', !memory);
    $('#memory').hidden = !memory;
    if (memory) { load(); resize(); if (!M.timer) M.timer = setInterval(() => { if (M.active) load(true); }, 5000); }
    else if (M.timer) { clearInterval(M.timer); M.timer = null; }
  }
  $('#view-work').onclick = () => setMode(false);
  $('#view-memory').onclick = () => setMode(true);

  // ───────── data
  function currentProject() { return window.MC && window.MC.currentProject ? window.MC.currentProject() : null; }
  async function load(quiet) {
    const p = currentProject(); if (!p) return;
    const slug = p.slug || (p.sessions && p.sessions[0] && p.sessions[0].slug) || null;
    const data = await window.mc.readMemory({ path: p.path, slug });
    const changed = !M.data || M.projectKey !== p.key || JSON.stringify(data.notes.map((n) => [n.filename, n.mtime])) !== JSON.stringify(M.data.notes.map((n) => [n.filename, n.mtime]));
    if (!changed && quiet) return;
    const keepPositions = M.projectKey === p.key;
    M.projectKey = p.key; M.data = data;
    buildGraph(p, keepPositions);
    $('#mem-dir').textContent = data.dir || '';
    $('#mem-dir').title = data.dir || '';
    renderLegend(); renderList(); renderDetail();
    if (!data.exists || !data.notes.length) { $('#mem-empty').hidden = false; $('#mem-empty').innerHTML = data.exists ? 'This project has a memory folder but no notes yet.' : `No memory yet for <b>${esc(p.name)}</b>.<br><span class="muted">Claude writes it to <code>${esc(data.dir || '~/.claude/projects/&lt;slug&gt;/memory')}</code> as it learns about the project. Ask it to "save this to memory".</span>`; }
    else $('#mem-empty').hidden = true;
    startAnim();
  }
  function buildGraph(p, keepPositions) {
    const old = new Map(M.nodes.map((n) => [n.id, n]));
    const W = canvas.clientWidth || 800, H = canvas.clientHeight || 600;
    const nodes = [], edges = [], byName = new Map();
    const hub = { id: 'hub', kind: 'hub', name: p.name, type: 'hub', r: 26, x: W / 2, y: H / 2, fixed: true };
    nodes.push(hub);
    const notes = M.data.notes;
    notes.forEach((n, i) => {
      const prev = keepPositions && old.get('n:' + n.name);
      const a = (i / Math.max(1, notes.length)) * Math.PI * 2;
      const node = { id: 'n:' + n.name, kind: 'note', name: n.name, type: n.type, note: n, r: 10 + Math.min(8, n.links.length * 1.5), x: prev ? prev.x : W / 2 + Math.cos(a) * 220, y: prev ? prev.y : H / 2 + Math.sin(a) * 220, vx: 0, vy: 0 };
      nodes.push(node); byName.set(n.name, node);
    });
    for (const n of notes) {
      const from = byName.get(n.name);
      edges.push({ a: hub, b: from, kind: 'hub' });
      for (const l of n.links) {
        let to = byName.get(l);
        if (!to) { // link to a note that does not exist yet → ghost node
          const prev = keepPositions && old.get('m:' + l);
          to = { id: 'm:' + l, kind: 'missing', name: l, type: 'missing', r: 7, x: prev ? prev.x : from.x + (Math.random() - 0.5) * 120, y: prev ? prev.y : from.y + (Math.random() - 0.5) * 120, vx: 0, vy: 0 };
          nodes.push(to); byName.set(l, to);
        }
        edges.push({ a: from, b: to, kind: 'link' });
      }
    }
    M.nodes = nodes; M.edges = edges; M.byName = byName;
    if (M.selected && !byName.has(M.selected)) M.selected = null;
    M.iter = keepPositions ? 60 : 320;
  }

  // ───────── force layout
  function scale() { const W = canvas.clientWidth || 800, H = canvas.clientHeight || 600; const s = Math.max(1, Math.min(2.2, Math.min(W, H) / 640)); return { W, H, s, Lhub: Math.max(160, Math.min(460, Math.min(W, H) * 0.3)), Llink: Math.max(100, Math.min(280, Math.min(W, H) * 0.18)) }; }
  function step() {
    const nodes = M.nodes, edges = M.edges; if (!nodes.length) return;
    const { W, H, s, Lhub, Llink } = scale(); const cx = W / 2, cy = H / 2; const rep = 9000 * s * s;
    for (const n of nodes) { if (n.fixed) { n.x = cx; n.y = cy; } }
    // repulsion
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j]; let dx = b.x - a.x, dy = b.y - a.y; let d2 = dx * dx + dy * dy; if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
      const f = rep / d2; const d = Math.sqrt(d2); const fx = dx / d * f * 1.6, fy = dy / d * f; // labels are wide: push harder horizontally
      if (!a.fixed && a !== M.drag) { a.vx -= fx; a.vy -= fy; } if (!b.fixed && b !== M.drag) { b.vx += fx; b.vy += fy; }
    }
    // springs
    for (const e of edges) {
      const L = e.kind === 'hub' ? Lhub : Llink, k = e.kind === 'hub' ? 0.012 : 0.03;
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y; const d = Math.max(1, Math.hypot(dx, dy)); const f = (d - L) * k; const fx = dx / d * f, fy = dy / d * f;
      if (!e.a.fixed && e.a !== M.drag) { e.a.vx += fx; e.a.vy += fy; } if (!e.b.fixed && e.b !== M.drag) { e.b.vx -= fx; e.b.vy -= fy; }
    }
    for (const n of nodes) {
      if (n.fixed || n === M.drag) continue;
      n.vx += (cx - n.x) * 0.002; n.vy += (cy - n.y) * 0.002; // gentle centering
      n.vx *= 0.82; n.vy *= 0.82; n.x += Math.max(-12, Math.min(12, n.vx)); n.y += Math.max(-12, Math.min(12, n.vy));
    }
  }
  function startAnim() { if (M.anim) return; const loop = () => { if (!M.active) { M.anim = null; return; } if (M.iter > 0 || M.drag) { step(); M.iter = Math.max(0, M.iter - 1); } draw(); M.anim = requestAnimationFrame(loop); }; M.anim = requestAnimationFrame(loop); }

  // ───────── drawing
  function resize() { const dpr = window.devicePixelRatio || 1; const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); draw(); }
  new ResizeObserver(resize).observe($('#mem-canvas-wrap'));
  function matches(n) { if (!M.filter) return true; const f = M.filter; return n.name.toLowerCase().includes(f) || (n.note && ((n.note.description || '').toLowerCase().includes(f) || (n.note.body || '').toLowerCase().includes(f))); }
  function draw() {
    const W = canvas.clientWidth, H = canvas.clientHeight; if (!W) return;
    ctx.save(); ctx.clearRect(0, 0, W, H);
    ctx.translate(M.cam.x, M.cam.y); ctx.scale(M.cam.k, M.cam.k);
    const { s } = scale();
    const sel = M.selected ? M.byName.get(M.selected) : null; const hov = M.hover;
    const neighbors = new Set(); if (sel) for (const e of M.edges) { if (e.a === sel) neighbors.add(e.b); if (e.b === sel) neighbors.add(e.a); }
    for (const e of M.edges) {
      const lit = sel && (e.a === sel || e.b === sel);
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y);
      ctx.setLineDash(e.b.kind === 'missing' || e.a.kind === 'missing' ? [4, 4] : []);
      ctx.strokeStyle = lit ? '#bc8cff' : e.kind === 'hub' ? 'rgba(88,166,255,0.18)' : 'rgba(188,140,255,0.35)'; ctx.lineWidth = lit ? 2 : e.kind === 'hub' ? 1 : 1.4; ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const n of M.nodes) {
      const dim = (M.filter && !matches(n) && n.kind !== 'hub') || (sel && n !== sel && !neighbors.has(n) && n.kind !== 'hub');
      ctx.globalAlpha = dim ? 0.25 : 1;
      const color = TYPE_COLORS[n.type] || TYPE_COLORS.note;
      const R = n.r * s;
      if (n === sel || n === hov) { ctx.beginPath(); ctx.arc(n.x, n.y, R + 6 * s, 0, Math.PI * 2); ctx.fillStyle = color + '33'; ctx.fill(); }
      ctx.beginPath(); ctx.arc(n.x, n.y, R, 0, Math.PI * 2);
      if (n.kind === 'hub') { ctx.fillStyle = '#1f2a3a'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#58a6ff'; ctx.stroke(); }
      else if (n.kind === 'missing') { ctx.fillStyle = '#0d1117'; ctx.fill(); ctx.setLineDash([3, 3]); ctx.strokeStyle = '#6e7681'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]); }
      else { ctx.fillStyle = color; ctx.fill(); if (n === sel) { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); } }
      const label = n.kind === 'hub' ? n.name : n.name.replace(/-/g, ' ');
      const fs = Math.round((n.kind === 'hub' ? 13 : 11) * s);
      ctx.font = n.kind === 'hub' ? `bold ${fs}px "Segoe UI", sans-serif` : `${n === sel ? 'bold ' : ''}${fs}px "Segoe UI", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const ly = n.y + R + 4 * s; const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(13,17,23,0.75)'; ctx.fillRect(n.x - tw / 2 - 3, ly - 1, tw + 6, fs + 4);
      ctx.fillStyle = n.kind === 'missing' ? '#8b98a8' : '#e6edf3'; ctx.fillText(label, n.x, ly);
      if (n.kind === 'missing') { ctx.font = `${Math.round(9 * s)}px "Segoe UI", sans-serif`; ctx.fillStyle = '#6e7681'; ctx.fillText('not written yet', n.x, ly + fs + 3); }
    }
    ctx.globalAlpha = 1; ctx.restore();
  }

  // ───────── interaction
  const toWorld = (ev) => { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left - M.cam.x) / M.cam.k, y: (ev.clientY - r.top - M.cam.y) / M.cam.k }; };
  const hit = (pt) => { const { s } = scale(); for (let i = M.nodes.length - 1; i >= 0; i--) { const n = M.nodes[i]; if (Math.hypot(n.x - pt.x, n.y - pt.y) <= n.r * s + 4) return n; } return null; };
  canvas.onmousedown = (ev) => { const pt = toWorld(ev); const n = hit(pt); if (n && n.kind !== 'hub') { M.drag = n; M.dragMoved = false; canvas.classList.add('dragging'); } else { M.panning = { sx: ev.clientX, sy: ev.clientY, ox: M.cam.x, oy: M.cam.y }; canvas.classList.add('dragging'); } startAnim(); };
  window.addEventListener('mousemove', (ev) => {
    if (M.drag) { const pt = toWorld(ev); M.drag.x = pt.x; M.drag.y = pt.y; M.drag.vx = 0; M.drag.vy = 0; M.dragMoved = true; M.iter = Math.max(M.iter, 20); }
    else if (M.panning) { M.cam.x = M.panning.ox + (ev.clientX - M.panning.sx); M.cam.y = M.panning.oy + (ev.clientY - M.panning.sy); draw(); }
    else if (M.active) { const n = hit(toWorld(ev)); if (n !== M.hover) { M.hover = n; canvas.style.cursor = n ? 'pointer' : 'grab'; draw(); } }
  });
  window.addEventListener('mouseup', (ev) => {
    if (M.drag) { if (!M.dragMoved) select(M.drag.kind === 'note' ? M.drag.name : null, M.drag); M.drag = null; }
    M.panning = null; canvas.classList.remove('dragging');
  });
  canvas.onwheel = (ev) => { ev.preventDefault(); const r = canvas.getBoundingClientRect(); const mx = ev.clientX - r.left, my = ev.clientY - r.top; const k = Math.max(0.35, Math.min(3, M.cam.k * (ev.deltaY < 0 ? 1.1 : 0.9))); M.cam.x = mx - (mx - M.cam.x) * (k / M.cam.k); M.cam.y = my - (my - M.cam.y) * (k / M.cam.k); M.cam.k = k; draw(); };
  canvas.ondblclick = () => { M.cam = { x: 0, y: 0, k: 1 }; draw(); };

  function select(name, node) {
    M.selected = name; renderDetail(node); renderList(); draw();
  }

  // ───────── detail panel + list
  function renderMarkdown(body) {
    const lines = body.split(/\r?\n/); let html = ''; let inList = false;
    const inline = (s) => esc(s)
      // text is already HTML-escaped here; do not escape again
      .replace(/\[\[([^\]|#]+)(?:\|([^\]]*))?\]\]/g, (m, n, label) => { const name = unesc(n.trim()); const ok = M.byName.has(name) && M.byName.get(name).kind === 'note'; return `<a class="wiki${ok ? '' : ' missing'}" data-name="${n.trim()}">${(label || n).trim()}</a>`; })
      .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|\s)_([^_]+)_/g, '$1<i>$2</i>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    for (const raw of lines) {
      const l = raw.trimEnd();
      if (/^\s*[-*] /.test(l)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`; continue; }
      if (inList) { html += '</ul>'; inList = false; }
      if (!l.trim()) continue;
      const h = /^(#{1,3}) (.*)$/.exec(l); if (h) { html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
      html += `<p>${inline(l)}</p>`;
    }
    if (inList) html += '</ul>';
    return html;
  }
  function renderDetail(node) {
    const d = $('#mem-detail'); d.innerHTML = '';
    const n = node || (M.selected ? M.byName.get(M.selected) : null);
    if (!n || n.kind === 'hub') {
      const p = currentProject(); const data = M.data;
      if (data && data.exists && p) {
        d.appendChild(el('h2', null, p.name + ' memory'));
        const counts = {}; for (const x of data.notes) counts[x.type] = (counts[x.type] || 0) + 1;
        d.appendChild(el('div', 'desc', `${data.notes.length} notes · ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')}`));
        if (data.index) {
          // MEMORY.md uses markdown links "[Title](file.md)"; turn them into wiki links by file name so they select the node
          const wiki = data.index.replace(/\[([^\]]+)\]\(([^)\s]+?)\.md\)/g, (m, title, file) => `[[${file.split('/').pop()}|${title}]]`);
          const md = el('div', 'md'); md.innerHTML = renderMarkdown(wiki); d.appendChild(el('h3', null, 'Index (MEMORY.md)')); d.appendChild(md); wireWiki(md, true);
        }
      } else d.appendChild(el('div', 'mem-detail-empty muted', 'Click a memory to read it. Drag nodes to rearrange. Scroll to zoom. Double-click the background to reset the view.'));
      return;
    }
    if (n.kind === 'missing') {
      d.appendChild(el('h2', null, n.name)); d.appendChild(el('div', 'desc', 'Referenced by another note but not written yet. Ask Claude to save this memory.'));
      const from = M.edges.filter((e) => e.b === n).map((e) => e.a);
      const links = el('div', 'links', 'Referenced by: '); from.forEach((f) => { const a = el('a', null, f.name); a.onclick = () => select(f.name, f); links.appendChild(a); }); d.appendChild(links);
      return;
    }
    const note = n.note; const color = TYPE_COLORS[note.type] || TYPE_COLORS.note;
    d.appendChild(el('h2', null, note.name));
    if (note.description) d.appendChild(el('div', 'desc', note.description));
    const meta = el('div', 'meta-row'); const t = el('span', 'tag', note.type); t.style.background = color + '33'; t.style.color = color; meta.appendChild(t); meta.appendChild(el('span', 'muted mono', note.filename)); meta.appendChild(el('span', 'muted', 'updated ' + new Date(note.mtime).toLocaleString())); d.appendChild(meta);
    const md = el('div', 'md'); md.innerHTML = renderMarkdown(note.body); d.appendChild(md); wireWiki(md, false);
    const inbound = M.edges.filter((e) => e.kind === 'link' && e.b === n).map((e) => e.a);
    if (note.links.length || inbound.length) {
      const links = el('div', 'links');
      if (note.links.length) { links.appendChild(el('span', 'muted', 'Links to: ')); note.links.forEach((l) => { const a = el('a', null, l); a.onclick = () => { const tn = M.byName.get(l); select(tn && tn.kind === 'note' ? l : null, tn); }; links.appendChild(a); }); links.appendChild(el('br')); }
      if (inbound.length) { links.appendChild(el('span', 'muted', 'Linked from: ')); inbound.forEach((f) => { const a = el('a', null, f.name); a.onclick = () => select(f.name, f); links.appendChild(a); }); }
      d.appendChild(links);
    }
    const act = el('div', 'actions');
    const b1 = el('button', 'btn small', 'Open in VS Code'); b1.onclick = () => window.mc.openInCode(note.file);
    const b2 = el('button', 'btn small', 'Open file'); b2.onclick = () => window.mc.openPath(note.file);
    act.appendChild(b1); act.appendChild(b2); d.appendChild(act);
  }
  function wireWiki(container, fromIndex) { for (const a of container.querySelectorAll('a.wiki')) a.onclick = () => { const nm = unesc(a.dataset.name); const tn = M.byName.get(nm) || [...M.byName.values()].find((x) => x.note && (x.note.filename === nm || x.note.filename === nm + '.md' || x.note.description === nm)); if (tn) select(tn.kind === 'note' ? tn.name : null, tn); }; }
  function renderLegend() {
    const lg = $('#mem-legend'); lg.innerHTML = '';
    for (const t of ['project', 'user', 'feedback', 'reference']) { const s = el('span', null, t); s.style.setProperty('--c', TYPE_COLORS[t]); lg.appendChild(s); }
    const m = el('span', null, 'not written yet'); m.style.setProperty('--c', TYPE_COLORS.missing); lg.appendChild(m);
  }
  function renderList() {
    const list = $('#mem-list'); list.innerHTML = '';
    if (!M.data) return;
    const notes = M.data.notes.filter((n) => matches({ name: n.name, note: n })).sort((a, b) => b.mtime - a.mtime);
    for (const n of notes) {
      const c = el('div', 'mem-card' + (M.selected === n.name ? ' sel' : '')); c.style.setProperty('--c', TYPE_COLORS[n.type] || TYPE_COLORS.note);
      c.appendChild(el('b', null, n.name)); c.appendChild(el('small', null, n.description || n.body.slice(0, 160)));
      const tags = el('div', 'tags'); tags.appendChild(el('span', 'tag', n.type)); if (n.links.length) tags.appendChild(el('span', 'tag', n.links.length + ' link' + (n.links.length > 1 ? 's' : ''))); tags.appendChild(el('span', 'tag', new Date(n.mtime).toLocaleDateString())); c.appendChild(tags);
      c.onclick = () => select(n.name, M.byName.get(n.name)); list.appendChild(c);
    }
    if (!notes.length && M.data.notes.length) list.appendChild(el('div', 'muted', 'No memories match the search.'));
  }
  function setView(v) { M.view = v; $('#mem-graph-btn').classList.toggle('active', v === 'graph'); $('#mem-list-btn').classList.toggle('active', v === 'list'); $('#mem-list').hidden = v !== 'list'; canvas.style.visibility = v === 'graph' ? 'visible' : 'hidden'; if (v === 'graph') { resize(); startAnim(); } }
  $('#mem-graph-btn').onclick = () => setView('graph');
  $('#mem-list-btn').onclick = () => setView('list');
  $('#mem-search').oninput = (e) => { M.filter = e.target.value.trim().toLowerCase(); renderList(); draw(); };
  $('#mem-refresh').onclick = () => load(false);
  $('#mem-open-dir').onclick = () => { if (M.data && M.data.dir) window.mc.openPath(M.data.dir); };

  // react to project changes from app.js
  document.addEventListener('mc:project-selected', () => { if (M.active) { M.selected = null; M.cam = { x: 0, y: 0, k: 1 }; load(false); } });
  window.mc.onEnv((env) => { if (env.startView === 'memory') setTimeout(() => setMode(true), 800); });
})();

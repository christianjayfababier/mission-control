'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => { const h = (_e, payload) => cb(payload); ipcRenderer.on(channel, h); return () => ipcRenderer.removeListener(channel, h); };

contextBridge.exposeInMainWorld('mc', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  lines: (kind, id, afterSeq) => ipcRenderer.invoke('lines', { kind, id, afterSeq }),
  onSnapshot: on('snapshot'),
  onLines: on('lines'),
  onEnv: on('env'),
  addProject: () => ipcRenderer.invoke('projects:add'),
  removeProject: (p) => ipcRenderer.invoke('projects:remove', p),
  hideProject: (p) => ipcRenderer.invoke('projects:hide', p), // unpinned project: stays in seen-projects.json, leaves the sidebar
  openInCode: (p) => ipcRenderer.invoke('open:code', p),
  openFolder: (p) => ipcRenderer.invoke('open:folder', p),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  openUrl: (u) => ipcRenderer.invoke('open:url', u),
  readMemory: (opts) => ipcRenderer.invoke('memory:read', opts),
  // explorer: file tree, git status, branches, branch diff (docs/EXPLORER-CONTRACT.md)
  explorerList: (root, rel) => ipcRenderer.invoke('explorer:list', { root, rel }),
  explorerStatus: (root) => ipcRenderer.invoke('explorer:status', root),
  explorerBranches: (projectRoot) => ipcRenderer.invoke('explorer:branches', projectRoot),
  explorerDiff: (projectRoot, branch) => ipcRenderer.invoke('explorer:diff', { root: projectRoot, branch }),
  openFile: (p, line) => ipcRenderer.invoke('open:file', { path: p, line }),
  // repo + GitHub account per project
  ghAccounts: () => ipcRenderer.invoke('gh:accounts'),
  settingsGet: (p) => ipcRenderer.invoke('settings:get', p),
  settingsSet: (p, patch) => ipcRenderer.invoke('settings:set', { path: p, patch }),
  // orchestrator inbox (notes, questions, decisions)
  notesAnswer: (id, answer) => ipcRenderer.invoke('notes:answer', { id, answer }),
  notesDismiss: (id) => ipcRenderer.invoke('notes:dismiss', { id }),
  // team & models per project
  teamGet: (p) => ipcRenderer.invoke('team:get', p),
  teamSet: (p, name, model, effort) => ipcRenderer.invoke('team:set', { path: p, name, model, effort }),
  // tickets & todos board per project (shared with mc-board.js)
  boardGet: (p) => ipcRenderer.invoke('board:get', p),
  boardAddTickets: (p, items) => ipcRenderer.invoke('board:add', { path: p, kind: 'ticket', items }),
  boardAddTodos: (p, items) => ipcRenderer.invoke('board:add', { path: p, kind: 'todo', items }),
  boardPatch: (p, kind, id, patch) => ipcRenderer.invoke('board:patch', { path: p, kind, id, patch }),
  boardRemove: (p, kind, id) => ipcRenderer.invoke('board:remove', { path: p, kind, id }),
  onBoard: on('board'),
  // owner rules per project, repo rule-file discovery and the viewer's reader (docs/RULES-CONTRACT.md)
  rulesGet: (p) => ipcRenderer.invoke('rules:get', p),
  rulesAdd: (p, text) => ipcRenderer.invoke('rules:add', { path: p, text }),
  rulesPatch: (p, id, patch) => ipcRenderer.invoke('rules:patch', { path: p, id, patch }),
  rulesRemove: (p, id) => ipcRenderer.invoke('rules:remove', { path: p, id }),
  rulesReorder: (p, ids) => ipcRenderer.invoke('rules:reorder', { path: p, ids }),
  rulesSources: (p) => ipcRenderer.invoke('rules:sources', p),
  readText: (absPath, project) => ipcRenderer.invoke('rules:read', { path: absPath, project }), // project optional; only the project, the kit files and DATA_DIR/generated are readable
  onRules: on('rules'),
  // accounts & AI: provider registry, status probes, logins in a terminal, encrypted API keys
  // (docs/ACCOUNTS-CONTRACT.md). A key value only ever travels renderer → main; it never comes back.
  providersList: () => ipcRenderer.invoke('providers:list'),
  providersRefresh: () => ipcRenderer.invoke('providers:refresh'),
  providersLogin: (id, projectPath) => ipcRenderer.invoke('providers:login', { id, path: projectPath || null }),
  providersInstall: (id, projectPath) => ipcRenderer.invoke('providers:install', { id, path: projectPath || null }),
  providersSetEnabled: (projectPath, id, enabled) => ipcRenderer.invoke('providers:enable', { path: projectPath || null, id, enabled }),
  secretSet: (id, value) => ipcRenderer.invoke('secrets:set', { id, value }),
  secretRemove: (id) => ipcRenderer.invoke('secrets:remove', { id }),
  onProviders: on('providers'),
  // the global Settings dialog (the cog in the sidebar): the owner's rulebook additions and hidden projects
  writeLocalRules: (absPath, text) => ipcRenderer.invoke('rules:writeLocal', { path: absPath, text }),
  hiddenProjects: () => ipcRenderer.invoke('projects:hidden'),
  unhideProject: (p) => ipcRenderer.invoke('projects:unhide', p),
  // lead launch: builds the per-project system prompt file (rules + local additions + project context)
  leadPrepare: (p, name) => ipcRenderer.invoke('lead:prepare', { path: p, name }),
  ptyCreate: (opts) => ipcRenderer.invoke('pty:create', opts),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.send('pty:kill', { id }),
  onPtyData: on('pty:data'),
  onPtyExit: on('pty:exit'),
});

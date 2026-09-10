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
  openInCode: (p) => ipcRenderer.invoke('open:code', p),
  openFolder: (p) => ipcRenderer.invoke('open:folder', p),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  openUrl: (u) => ipcRenderer.invoke('open:url', u),
  readMemory: (opts) => ipcRenderer.invoke('memory:read', opts),
  // repo + GitHub account per project
  ghAccounts: () => ipcRenderer.invoke('gh:accounts'),
  settingsGet: (p) => ipcRenderer.invoke('settings:get', p),
  settingsSet: (p, patch) => ipcRenderer.invoke('settings:set', { path: p, patch }),
  // orchestrator inbox (notes, questions, decisions)
  notesAnswer: (id, answer) => ipcRenderer.invoke('notes:answer', { id, answer }),
  notesDismiss: (id) => ipcRenderer.invoke('notes:dismiss', { id }),
  // lead launch: builds the per-project system prompt file (rules + local additions + project context)
  leadPrepare: (p) => ipcRenderer.invoke('lead:prepare', p),
  ptyCreate: (opts) => ipcRenderer.invoke('pty:create', opts),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.send('pty:kill', { id }),
  onPtyData: on('pty:data'),
  onPtyExit: on('pty:exit'),
});

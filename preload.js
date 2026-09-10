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
  ptyCreate: (opts) => ipcRenderer.invoke('pty:create', opts),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.send('pty:kill', { id }),
  onPtyData: on('pty:data'),
  onPtyExit: on('pty:exit'),
});

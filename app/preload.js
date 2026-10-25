// KurzFiler for macOS — bridge between the window and the file system. GPL v3 or later.
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('kfNative', {
  openDialog: (opts) => ipcRenderer.invoke('open-dialog', opts),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  saveDialog: (opts) => ipcRenderer.invoke('save-dialog', opts),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  writeFile: (p, data) => ipcRenderer.invoke('write-file', p, data),
  writeFiles: (dir, files) => ipcRenderer.invoke('write-files', dir, files),
  setTitle: (t) => ipcRenderer.send('set-title', t),
  updateMenu: (states) => ipcRenderer.send('update-menu', states),
  addRecent: (p) => ipcRenderer.send('add-recent', p),
  closeReply: (ok) => ipcRenderer.send('close-reply', ok),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f) || null; } catch (e) { return null; } },
  onMenu: (cb) => ipcRenderer.on('menu', (e, id) => cb(id)),
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (e, files) => cb(files)),
  onImportFiles: (cb) => ipcRenderer.on('import-files', (e, files) => cb(files)),
  onCloseRequest: (cb) => ipcRenderer.on('close-request', () => cb())
});

// KurzFiler for macOS — application shell (Electron main process). GPL v3 or later.
'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('KurzFiler');
let win = null;
let rendererReady = false;
let pending = [];          // files to open once the window is ready
let closing = false;
let quitting = false;
let menuStates = {};
let recent = [];
let lastDir = app.getPath('documents');

const KRZ_EXT = ['krz', 'k25', 'k26', 'KRZ', 'K25', 'K26'];
const AUDIO_EXT = ['wav', 'wave', 'aif', 'aiff', 'aifc', 'iff', '8svx', 'svx', 'WAV', 'AIF', 'AIFF', 'IFF'];
const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
function loadRecent() { try { recent = JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter(p => typeof p === 'string'); } catch (e) { recent = []; } }
function saveRecent() { try { fs.mkdirSync(path.dirname(recentFile()), { recursive: true }); fs.writeFileSync(recentFile(), JSON.stringify(recent)); } catch (e) { } }
function addRecent(p) {
  recent = [p].concat(recent.filter(x => x !== p)).slice(0, 12); saveRecent();
  try { app.addRecentDocument(p); } catch (e) { }
  buildMenu();
}
function readFileObj(p) {
  const data = fs.readFileSync(p);
  lastDir = path.dirname(p);
  return { path: p, name: path.basename(p), data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function openPaths(paths, asImport) {
  const files = [];
  for (const p of paths) {
    try { files.push(readFileObj(p)); }
    catch (e) { dialog.showMessageBox(win, { type: 'error', message: 'Could not open the file', detail: p + '\n' + e.message }); }
  }
  if (!files.length) return;
  if (!win) { createWindow(); pending.push({ files, asImport }); return; }
  if (!rendererReady) { pending.push({ files, asImport }); return; }
  send(asImport ? 'import-files' : 'open-files', files);
  win.show(); win.focus();
}

// ------------------------------------------------------------------ menu
function cmd(label, id, accelerator, extra) {
  return Object.assign({ id, label, accelerator, enabled: menuStates[id] !== false, click: () => send('menu', id) }, extra || {});
}
function buildMenu() {
  const recentItems = recent.length ? recent.map(p => ({ label: path.basename(p), sublabel: path.dirname(p), click: () => { if (fs.existsSync(p)) openPaths([p]); else { recent = recent.filter(x => x !== p); saveRecent(); buildMenu(); dialog.showMessageBox(win, { type: 'warning', message: 'The file no longer exists.', detail: p }); } } }))
    .concat([{ type: 'separator' }, { label: 'Clear Menu', click: () => { recent = []; saveRecent(); app.clearRecentDocuments(); buildMenu(); } }])
    : [{ label: 'No Recent Files', enabled: false }];
  const template = [
    {
      label: 'KurzFiler', submenu: [
        cmd('About KurzFiler', 'about'), { type: 'separator' },
        cmd('Fill Mode…', 'fillMode', 'CmdOrCtrl+,'), { type: 'separator' },
        { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }
      ]
    },
    {
      label: 'File', submenu: [
        cmd('New', 'new', 'CmdOrCtrl+N'), cmd('Open…', 'open', 'CmdOrCtrl+O'), { label: 'Open Recent', submenu: recentItems },
        cmd('Revert to Saved', 'revert'), { type: 'separator' },
        cmd('Import…', 'import', 'CmdOrCtrl+I'), cmd('Remap IDs…', 'remap'), { type: 'separator' },
        { role: 'close', label: 'Close Window' },
        cmd('Save', 'save', 'CmdOrCtrl+S'), cmd('Save As…', 'saveAs', 'Shift+CmdOrCtrl+S'), cmd('Save Selected…', 'saveSelected', 'Alt+CmdOrCtrl+S'),
        cmd('Export Samples as WAV…', 'exportWav', 'CmdOrCtrl+E'), { type: 'separator' },
        cmd('File Information', 'fileInfo', 'CmdOrCtrl+J')
      ]
    },
    {
      label: 'Edit', submenu: [
        cmd('Undo', 'undo', 'CmdOrCtrl+Z'), cmd('Redo', 'redo', 'Shift+CmdOrCtrl+Z'), { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, cmd('Delete', 'delete'), { type: 'separator' },
        cmd('Select All', 'selectAll', 'CmdOrCtrl+A'), cmd('Deselect', 'deselect', 'CmdOrCtrl+D'),
        cmd('Select Dependants', 'selectDependants', 'CmdOrCtrl+Down'), cmd('Select Users', 'selectUsers', 'CmdOrCtrl+Up')
      ]
    },
    {
      label: 'Object', submenu: [
        cmd('Rename…', 'rename'), { type: 'separator' },
        { label: 'Sample', enabled: false },
        cmd('Set Root Key…', 'setRoot', 'CmdOrCtrl+R'), cmd('Guess Root from Name', 'guessRoot'), cmd('AltStart to SampleEnd', 'altStart'), cmd('Play Sample', 'play'),
        { type: 'separator' }, { label: 'Keymap', enabled: false },
        cmd('Compact Keymap', 'compact'), cmd('New Velocity Split Keymap…', 'velosplit'),
        { type: 'separator' }, { label: 'Program', enabled: false },
        cmd('New Drumset…', 'newDrumset'), cmd('New Instrument…', 'newInstrument')
      ]
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [cmd('KurzFiler Help', 'help'), { label: 'Original KurzFiler Project', click: () => shell.openExternal('https://github.com/SpotlightKid/kurzfiler') }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function applyMenuStates(states) {
  menuStates = states || {};
  const m = Menu.getApplicationMenu(); if (!m) return;
  for (const id of Object.keys(menuStates)) { const it = m.getMenuItemById(id); if (it) it.enabled = !!menuStates[id]; }
}

// ------------------------------------------------------------------ window
function createWindow() {
  rendererReady = false; closing = false;
  win = new BrowserWindow({
    width: 1200, height: 780, minWidth: 820, minHeight: 520,
    title: 'KurzFiler', show: false,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 19 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ecebe8',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    const p = pending; pending = [];
    for (const job of p) send(job.asImport ? 'import-files' : 'open-files', job.files);
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('close', e => {
    if (closing || !rendererReady) return;
    e.preventDefault();
    send('close-request');
  });
  win.on('closed', () => { win = null; });
}

// ------------------------------------------------------------------ IPC
function filtersFor(kind) {
  if (kind === 'krz') return [{ name: 'Kurzweil Files', extensions: KRZ_EXT }];
  return [{ name: 'Kurzweil and Audio Files', extensions: KRZ_EXT.concat(AUDIO_EXT) }, { name: 'Kurzweil Files', extensions: KRZ_EXT }, { name: 'Audio Files', extensions: AUDIO_EXT }];
}
ipcMain.handle('open-dialog', async (e, { kind, multi }) => {
  const r = await dialog.showOpenDialog(win, { defaultPath: lastDir, properties: ['openFile'].concat(multi ? ['multiSelections'] : []), filters: filtersFor(kind) });
  if (r.canceled) return [];
  return r.filePaths.map(readFileObj);
});
ipcMain.handle('read-file', (e, p) => readFileObj(p));
ipcMain.handle('save-dialog', async (e, { defaultName, fmt }) => {
  const ext = { krz: 'krz', k25: 'k25', k26: 'k26' }[fmt] || 'krz';
  const names = { krz: 'Kurzweil K2000 File', k25: 'Kurzweil K2500 File', k26: 'Kurzweil K2600 File' };
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(lastDir, defaultName), filters: [{ name: names[fmt] || 'Kurzweil File', extensions: [ext] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
  if (r.canceled || !r.filePath) return null;
  let p = r.filePath;
  if (!/\.(krz|k25|k26)$/i.test(p)) p += '.' + ext;
  lastDir = path.dirname(p);
  return p;
});
ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Export WAV files to…', buttonLabel: 'Export Here', defaultPath: lastDir, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});
function writeAtomic(p, data) {
  const tmp = p + '.kurzfiler-tmp';
  fs.writeFileSync(tmp, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  fs.renameSync(tmp, p);
}
ipcMain.handle('write-file', (e, p, data) => { writeAtomic(p, data); return true; });
ipcMain.handle('write-files', (e, dir, files) => {
  let n = 0;
  for (const f of files) {
    const safe = f.name.replace(/[\/\\:]/g, '-');
    let p = path.join(dir, safe), i = 2;
    while (fs.existsSync(p)) p = path.join(dir, safe.replace(/\.wav$/i, '') + ' (' + (i++) + ').wav');
    writeAtomic(p, f.data); n++;
  }
  shell.showItemInFolder(path.join(dir, files[0].name.replace(/[\/\\:]/g, '-')));
  return n;
});
ipcMain.on('set-title', (e, { title, path: p, dirty }) => {
  if (!win) return;
  win.setTitle(title);
  if (process.platform === 'darwin') { win.setRepresentedFilename(p || ''); win.setDocumentEdited(!!dirty); }
});
ipcMain.on('update-menu', (e, states) => applyMenuStates(states));
ipcMain.on('add-recent', (e, p) => addRecent(p));
ipcMain.on('close-reply', (e, ok) => {
  if (!ok) { quitting = false; return; }
  closing = true;
  if (win) win.close();
  if (quitting) app.quit();
});

// ------------------------------------------------------------------ app lifecycle
app.on('open-file', (e, p) => { e.preventDefault(); if (app.isReady()) openPaths([p]); else pending.push({ files: [readFileObj(p)], asImport: false }); });
app.on('before-quit', e => {
  if (win && !closing) { e.preventDefault(); quitting = true; send('close-request'); }
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!win) createWindow(); });
app.whenReady().then(() => {
  loadRecent(); buildMenu(); createWindow();
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter(a => /\.(krz|k25|k26)$/i.test(a) && fs.existsSync(a));
  if (args.length) openPaths(args);
});

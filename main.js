// DriveSync Compare — main process.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const core = require('./core');

let win = null;
let cancelFlag = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 560,
    title: 'DriveSync Compare',
    autoHideMenuBar: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

// Standard menu — on macOS the Edit menu is what makes Cmd+C/V/X/A work at all.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('ds:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('ds:compare', async (evt, { rootA, rootB, mode }) => {
  cancelFlag = false;
  const withHash = mode === 'hash';
  const send = (stage, count) => { if (win && !win.isDestroyed()) win.webContents.send('ds:progress', { stage, count }); };
  try {
    if (!fs.existsSync(rootA)) return { ok: false, error: 'Left folder does not exist: ' + rootA };
    if (!fs.existsSync(rootB)) return { ok: false, error: 'Right folder does not exist: ' + rootB };
    const a = await core.scanFolder(rootA, { withHash, shouldCancel: () => cancelFlag, onProgress: (n) => send('Scanning left…', n) });
    if (a.cancelled) return { ok: false, error: 'Cancelled' };
    const b = await core.scanFolder(rootB, { withHash, shouldCancel: () => cancelFlag, onProgress: (n) => send('Scanning right…', n) });
    if (b.cancelled) return { ok: false, error: 'Cancelled' };
    const rows = core.compareMaps(a.map, b.map, mode, a.folders, b.folders);
    const renames = core.detectFolderRenames(a.map, b.map, a.folders, b.folders, mode);
    return { ok: true, rows, summary: core.summarize(rows), renames, errors: [...a.errors, ...b.errors] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('ds:cancel', async () => { cancelFlag = true; return true; });

// items: [{ rel, kind: 'file'|'folder', direction: 'AtoB'|'BtoA' }] — copies/creates only, NEVER deletes.
ipcMain.handle('ds:copy', async (evt, { rootA, rootB, items }) => {
  cancelFlag = false;
  const results = { done: 0, failed: 0, bytes: 0, failures: [] };
  // Folders first, shallowest first, so structure exists before files land in it.
  const ordered = [...items].sort((x, y) => {
    if ((x.kind === 'folder') !== (y.kind === 'folder')) return x.kind === 'folder' ? -1 : 1;
    return x.rel.split('/').length - y.rel.split('/').length;
  });
  for (let i = 0; i < ordered.length; i++) {
    if (cancelFlag) break;
    const { rel, kind, direction } = ordered[i];
    const srcRoot = direction === 'AtoB' ? rootA : rootB;
    const dstRoot = direction === 'AtoB' ? rootB : rootA;
    const src = path.join(srcRoot, ...rel.split('/'));
    const dst = path.join(dstRoot, ...rel.split('/'));
    try {
      if (kind === 'folder') {
        await core.createFolder(dst);
        results.done++;
      } else {
        const st = await fs.promises.stat(src);
        await core.copyOne(src, dst);
        results.done++; results.bytes += st.size;
      }
    } catch (e) {
      results.failed++; results.failures.push({ rel, error: e.message });
    }
    if (win && !win.isDestroyed()) win.webContents.send('ds:copy-progress', { done: results.done, failed: results.failed, total: items.length, current: rel });
  }
  results.cancelled = cancelFlag;
  return { ok: true, results };
});

// Apply a detected rename on ONE side: { side: 'A'|'B', rootA, rootB, fromRel, toRel }
ipcMain.handle('ds:rename', async (evt, { side, rootA, rootB, fromRel, toRel }) => {
  try {
    await core.renameFolder(side === 'A' ? rootA : rootB, fromRel, toRel);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml' };
const PREVIEW_IMAGE_MAX = 30 * 1024 * 1024;
const PREVIEW_TEXT_MAX = 64 * 1024;

// Preview for one relative file path, from both sides.
ipcMain.handle('ds:preview', async (evt, { rootA, rootB, rel }) => {
  const kind = core.previewKind(rel);
  async function side(root) {
    const full = path.join(root, ...rel.split('/'));
    try {
      const st = await fs.promises.stat(full);
      if (!st.isFile()) return { exists: false };
      const out = { exists: true, size: st.size, mtimeMs: st.mtimeMs, kind };
      if (kind === 'image') {
        if (st.size <= PREVIEW_IMAGE_MAX) {
          const buf = await fs.promises.readFile(full);
          const ext = (rel.split('.').pop() || '').toLowerCase();
          out.dataUrl = 'data:' + (MIME[ext] || 'image/*') + ';base64,' + buf.toString('base64');
        } else out.tooLarge = true;
      } else if (kind === 'text') {
        const fh = await fs.promises.open(full, 'r');
        const buf = Buffer.alloc(Math.min(PREVIEW_TEXT_MAX, st.size));
        await fh.read(buf, 0, buf.length, 0);
        await fh.close();
        out.text = buf.toString('utf8');
        out.truncated = st.size > PREVIEW_TEXT_MAX;
      }
      return out;
    } catch (e) {
      return { exists: false };
    }
  }
  return { kind, a: await side(rootA), b: await side(rootB) };
});

// Open a file in the OS default app (used from the preview panel, e.g. for video).
ipcMain.handle('ds:open', async (evt, { root, rel }) => {
  const full = path.resolve(path.join(root, ...rel.split('/')));
  if (!full.startsWith(path.resolve(root))) return { ok: false, error: 'Path escapes the selected folder' };
  const err = await shell.openPath(full);
  return { ok: !err, error: err || undefined };
});

ipcMain.handle('ds:save-report', async (evt, { csv, defaultName }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName || 'drivesync-report.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (r.canceled || !r.filePath) return false;
  await fs.promises.writeFile(r.filePath, csv, 'utf8');
  return true;
});

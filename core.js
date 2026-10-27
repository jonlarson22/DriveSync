// Core compare/copy logic — pure Node, no Electron. Used by main.js and by test.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// Recursively scan a root folder.
// Returns Map relPath (posix-style, forward slashes) -> { size, mtimeMs, fullPath }
// onProgress(count) called periodically. shouldCancel() -> true stops early.
async function scanFolder(root, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const shouldCancel = opts.shouldCancel || (() => false);
  const withHash = !!opts.withHash;
  const map = new Map();
  const folders = new Set();
  const errors = [];

  async function walk(dir) {
    if (shouldCancel()) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      errors.push({ path: dir, error: e.message });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (shouldCancel()) return;
      const full = path.join(dir, ent.name);
      // Skip symlinks to avoid loops / double-counting linked photo folders
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        folders.add(path.relative(root, full).split(path.sep).join('/'));
        await walk(full);
      } else if (ent.isFile()) {
        try {
          const st = await fs.promises.stat(full);
          const rel = path.relative(root, full).split(path.sep).join('/');
          const rec = { size: st.size, mtimeMs: st.mtimeMs, fullPath: full };
          if (withHash) rec.hash = await hashFile(full);
          map.set(rel, rec);
          if (map.size % 200 === 0) onProgress(map.size);
        } catch (e) {
          errors.push({ path: full, error: e.message });
        }
      }
    }
  }
  await walk(root);
  onProgress(map.size);
  return { map, folders, errors, cancelled: shouldCancel() };
}

// Compare two scan maps, plus folder sets when provided.
// mode: 'quick' (size only) | 'standard' (size + mtime within 2s) | 'hash' (size + SHA-256)
// Folder rows have kind:'folder' and status onlyA / onlyB / same (present on both).
// File rows have kind:'file'. Rows are sorted by path, folders and files together.
function compareMaps(mapA, mapB, mode, foldersA, foldersB) {
  const rows = [];
  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);
  for (const rel of allKeys) {
    const a = mapA.get(rel);
    const b = mapB.get(rel);
    let status;
    if (a && !b) status = 'onlyA';
    else if (!a && b) status = 'onlyB';
    else {
      if (a.size !== b.size) status = 'different';
      else if (mode === 'hash') status = (a.hash && b.hash && a.hash === b.hash) ? 'same' : 'different';
      else if (mode === 'standard') status = Math.abs(a.mtimeMs - b.mtimeMs) <= 2000 ? 'same' : 'different';
      else status = 'same'; // quick
    }
    rows.push({
      rel,
      kind: 'file',
      status,
      sizeA: a ? a.size : null,
      sizeB: b ? b.size : null,
      mtimeA: a ? a.mtimeMs : null,
      mtimeB: b ? b.mtimeMs : null,
      hashA: a ? a.hash || null : null,
      hashB: b ? b.hash || null : null,
    });
  }
  if (foldersA || foldersB) {
    const fa = foldersA || new Set();
    const fb = foldersB || new Set();
    for (const rel of new Set([...fa, ...fb])) {
      const inA = fa.has(rel), inB = fb.has(rel);
      rows.push({
        rel,
        kind: 'folder',
        status: inA && inB ? 'same' : inA ? 'onlyA' : 'onlyB',
        sizeA: null, sizeB: null, mtimeA: null, mtimeB: null, hashA: null, hashB: null,
      });
    }
  }
  rows.sort((x, y) => x.rel.localeCompare(y.rel) || (x.kind === y.kind ? 0 : x.kind === 'folder' ? -1 : 1));
  return rows;
}

function summarize(rows) {
  const s = { total: 0, same: 0, onlyA: 0, onlyB: 0, different: 0, bytesOnlyA: 0, bytesOnlyB: 0, bytesDifferentA: 0, bytesDifferentB: 0, foldersTotal: 0, foldersOnlyA: 0, foldersOnlyB: 0, foldersSame: 0 };
  for (const r of rows) {
    if (r.kind === 'folder') {
      s.foldersTotal++;
      if (r.status === 'onlyA') s.foldersOnlyA++;
      else if (r.status === 'onlyB') s.foldersOnlyB++;
      else s.foldersSame++;
      continue;
    }
    s.total++;
    s[r.status]++;
    if (r.status === 'onlyA') s.bytesOnlyA += r.sizeA || 0;
    if (r.status === 'onlyB') s.bytesOnlyB += r.sizeB || 0;
    if (r.status === 'different') { s.bytesDifferentA += r.sizeA || 0; s.bytesDifferentB += r.sizeB || 0; }
  }
  return s;
}

// Create a folder (and any missing parents) — used for folder rows.
async function createFolder(destFull) {
  await fs.promises.mkdir(destFull, { recursive: true });
}

// ---- Folder rename detection ----
// Signature of everything under a folder: file suffix -> {size, hash}, plus subfolder suffixes.
function folderSignature(map, folders, folderRel) {
  const prefix = folderRel + '/';
  const files = new Map();
  for (const [rel, rec] of map) {
    if (rel.startsWith(prefix)) files.set(rel.slice(prefix.length), rec);
  }
  const subfolders = new Set();
  for (const f of folders || []) {
    if (f.startsWith(prefix)) subfolders.add(f.slice(prefix.length));
  }
  return { files, subfolders };
}

function signaturesMatch(sigA, sigB, mode) {
  if (sigA.files.size === 0 || sigA.files.size !== sigB.files.size) return false;
  if (sigA.subfolders.size !== sigB.subfolders.size) return false;
  for (const sf of sigA.subfolders) if (!sigB.subfolders.has(sf)) return false;
  for (const [suffix, ra] of sigA.files) {
    const rb = sigB.files.get(suffix);
    if (!rb || ra.size !== rb.size) return false;
    if (mode === 'hash' && ra.hash && rb.hash && ra.hash !== rb.hash) return false;
  }
  return true;
}

// Find folders that exist under different names on the two sides but hold the
// same contents — i.e. a rename happened on one side. Returns candidates:
// { nameA, nameB, fileCount, totalBytes } meaning side A calls it nameA and
// side B calls it nameB. Empty folders are excluded (they match everything),
// ambiguous matches (a folder matching 2+ names) are excluded, and when a
// parent folder matches, its children are not reported separately.
function detectFolderRenames(mapA, mapB, foldersA, foldersB, mode) {
  const fa = foldersA || new Set(), fb = foldersB || new Set();
  const onlyA = [...fa].filter((f) => !fb.has(f));
  const onlyB = [...fb].filter((f) => !fa.has(f));
  const sigsA = new Map(onlyA.map((f) => [f, folderSignature(mapA, fa, f)]));
  const sigsB = new Map(onlyB.map((f) => [f, folderSignature(mapB, fb, f)]));

  const raw = [];
  for (const a of onlyA) {
    for (const b of onlyB) {
      if (signaturesMatch(sigsA.get(a), sigsB.get(b), mode)) raw.push({ nameA: a, nameB: b });
    }
  }
  // uniqueness: drop any folder that matched more than one counterpart
  const countA = {}, countB = {};
  for (const r of raw) { countA[r.nameA] = (countA[r.nameA] || 0) + 1; countB[r.nameB] = (countB[r.nameB] || 0) + 1; }
  let uniq = raw.filter((r) => countA[r.nameA] === 1 && countB[r.nameB] === 1);
  // topmost only: drop pairs nested inside another accepted pair
  uniq = uniq.filter((r) => !uniq.some((o) => o !== r && r.nameA.startsWith(o.nameA + '/') && r.nameB.startsWith(o.nameB + '/')));

  return uniq.map((r) => {
    const sig = sigsA.get(r.nameA);
    let totalBytes = 0;
    for (const rec of sig.files.values()) totalBytes += rec.size;
    return { nameA: r.nameA, nameB: r.nameB, fileCount: sig.files.size, totalBytes, certain: mode === 'hash' };
  }).sort((x, y) => x.nameA.localeCompare(y.nameA));
}

// Rename a folder in place on one side (same drive = instant, no data copied).
// Guards: source must exist, target must NOT exist, target parent is created.
async function renameFolder(root, fromRel, toRel) {
  const from = path.join(root, ...fromRel.split('/'));
  const to = path.join(root, ...toRel.split('/'));
  const rootResolved = path.resolve(root);
  if (!path.resolve(from).startsWith(rootResolved) || !path.resolve(to).startsWith(rootResolved)) throw new Error('Path escapes the selected folder');
  if (!fs.existsSync(from)) throw new Error('Source folder no longer exists: ' + fromRel);
  if (fs.existsSync(to)) throw new Error('Target folder already exists: ' + toRel);
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await fs.promises.rename(from, to);
  return true;
}

// ---- Preview classification ----
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg']);
const TEXT_EXT = new Set(['txt', 'md', 'csv', 'json', 'log', 'xml', 'html', 'htm', 'ini', 'yaml', 'yml']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv']);
function previewKind(rel) {
  const ext = (rel.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'other';
}

// Copy one file, creating parent folders, preserving modified time.
async function copyOne(srcFull, destFull) {
  await fs.promises.mkdir(path.dirname(destFull), { recursive: true });
  await fs.promises.copyFile(srcFull, destFull);
  try {
    const st = await fs.promises.stat(srcFull);
    await fs.promises.utimes(destFull, st.atime, st.mtime);
  } catch (e) { /* timestamp preserve is best-effort */ }
}

module.exports = { hashFile, scanFolder, compareMaps, summarize, copyOne, createFolder, detectFolderRenames, renameFolder, previewKind, folderSignature };

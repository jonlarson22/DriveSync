// Headless test of core compare + copy logic.
const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require('./core');

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-test-'));
  const A = path.join(base, 'A'), B = path.join(base, 'B');
  fs.mkdirSync(path.join(A, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(B, 'sub'), { recursive: true });

  fs.writeFileSync(path.join(A, 'same.jpg'), 'identical-bytes');
  fs.writeFileSync(path.join(B, 'same.jpg'), 'identical-bytes');
  // align mtimes for same.jpg
  const t = new Date('2024-01-01T12:00:00Z');
  fs.utimesSync(path.join(A, 'same.jpg'), t, t);
  fs.utimesSync(path.join(B, 'same.jpg'), t, t);

  fs.writeFileSync(path.join(A, 'only-a.jpg'), 'only in A');
  fs.writeFileSync(path.join(B, 'only-b.jpg'), 'only in B!');
  fs.writeFileSync(path.join(A, 'sub', 'diff.jpg'), 'version-one');
  fs.writeFileSync(path.join(B, 'sub', 'diff.jpg'), 'version-two-longer');
  fs.writeFileSync(path.join(A, 'samesize-diff.jpg'), 'AAAA');
  fs.writeFileSync(path.join(B, 'samesize-diff.jpg'), 'BBBB');
  // Folder structure: an empty folder only in A, one only in B, 'sub' on both
  fs.mkdirSync(path.join(A, 'empty-a'), { recursive: true });
  fs.mkdirSync(path.join(B, 'empty-b'), { recursive: true });

  const a = await core.scanFolder(A, {});
  const b = await core.scanFolder(B, {});
  console.log('scan A', a.map.size, 'B', b.map.size, 'errors', a.errors.length + b.errors.length);

  // standard mode: samesize-diff has same size, mtimes ~now both (close) -> may be same; hash mode must catch it
  const std = core.compareMaps(a.map, b.map, 'standard');
  for (const r of std) console.log(' standard', r.status, r.rel);

  const aH = await core.scanFolder(A, { withHash: true });
  const bH = await core.scanFolder(B, { withHash: true });
  const hashed = core.compareMaps(aH.map, bH.map, 'hash', aH.folders, bH.folders);
  for (const r of hashed) console.log(' hash    ', r.kind, r.status, r.rel);
  console.log('summary', core.summarize(hashed));

  const fileRows = hashed.filter(r => r.kind === 'file');
  const folderRows = hashed.filter(r => r.kind === 'folder');
  const byRel = Object.fromEntries(fileRows.map(r => [r.rel, r.status]));
  const folderByRel = Object.fromEntries(folderRows.map(r => [r.rel, r.status]));
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
  assert(byRel['same.jpg'] === 'same', 'same.jpg identical in hash mode');
  assert(byRel['only-a.jpg'] === 'onlyA', 'only-a detected');
  assert(byRel['only-b.jpg'] === 'onlyB', 'only-b detected');
  assert(byRel['sub/diff.jpg'] === 'different', 'different size detected');
  assert(byRel['samesize-diff.jpg'] === 'different', 'same-size different content caught by hash');

  assert(folderByRel['empty-a'] === 'onlyA', 'empty folder only in A detected');
  assert(folderByRel['empty-b'] === 'onlyB', 'empty folder only in B detected');
  assert(folderByRel['sub'] === 'same', 'shared folder marked same');

  // create the A-only empty folder on B, verify
  await core.createFolder(path.join(B, 'empty-a'));
  assert(fs.existsSync(path.join(B, 'empty-a')) && fs.readdirSync(path.join(B, 'empty-a')).length === 0, 'empty folder created on other side');

  // copy only-a A->B and diff B->A, verify
  await core.copyOne(path.join(A, 'only-a.jpg'), path.join(B, 'only-a.jpg'));
  assert(fs.readFileSync(path.join(B, 'only-a.jpg'), 'utf8') === 'only in A', 'copy A->B works');
  await core.copyOne(path.join(B, 'sub', 'diff.jpg'), path.join(A, 'sub', 'diff.jpg'));
  assert(fs.readFileSync(path.join(A, 'sub', 'diff.jpg'), 'utf8') === 'version-two-longer', 'copy B->A overwrite works');

  // ---- rename detection: build a second scenario ----
  const C = path.join(base, 'C'), D = path.join(base, 'D');
  fs.mkdirSync(path.join(C, '2024-Trip', 'day1'), { recursive: true });
  fs.mkdirSync(path.join(D, '2024', 'day1'), { recursive: true });
  fs.writeFileSync(path.join(C, '2024-Trip', 'a.jpg'), 'photo-a');
  fs.writeFileSync(path.join(D, '2024', 'a.jpg'), 'photo-a');
  fs.writeFileSync(path.join(C, '2024-Trip', 'day1', 'b.jpg'), 'photo-b-longer');
  fs.writeFileSync(path.join(D, '2024', 'day1', 'b.jpg'), 'photo-b-longer');
  // an unrelated only-on-one-side folder with different contents — must NOT match
  fs.mkdirSync(path.join(C, 'misc'), { recursive: true });
  fs.writeFileSync(path.join(C, 'misc', 'x.jpg'), 'something else entirely');
  fs.mkdirSync(path.join(D, 'empty-d'), { recursive: true });

  const cH = await core.scanFolder(C, { withHash: true });
  const dH = await core.scanFolder(D, { withHash: true });
  const renames = core.detectFolderRenames(cH.map, dH.map, cH.folders, dH.folders, 'hash');
  console.log('renames detected:', renames);
  assert(renames.length === 1 && renames[0].nameA === '2024-Trip' && renames[0].nameB === '2024' && renames[0].fileCount === 2, 'folder rename detected (nested child not double-reported)');
  assert(renames[0].certain === true, 'hash mode marks rename certain');

  // apply rename on D and verify contents intact, nothing recopied
  await core.renameFolder(D, '2024', '2024-Trip');
  assert(fs.readFileSync(path.join(D, '2024-Trip', 'day1', 'b.jpg'), 'utf8') === 'photo-b-longer', 'renamed folder keeps its files');
  assert(!fs.existsSync(path.join(D, '2024')), 'old folder name gone after rename');
  // guard: renaming onto an existing folder must fail
  let guardOk = false;
  try { await core.renameFolder(D, 'empty-d', '2024-Trip'); } catch (e) { guardOk = true; }
  assert(guardOk, 'rename onto existing folder refused');

  // preview classification
  assert(core.previewKind('photos/IMG_1.JPG') === 'image', 'jpg previews as image');
  assert(core.previewKind('notes/readme.txt') === 'text', 'txt previews as text');
  assert(core.previewKind('clip.mp4') === 'video', 'mp4 classified video');
  assert(core.previewKind('archive.zip') === 'other', 'zip classified other');

  fs.rmSync(base, { recursive: true, force: true });
  console.log(process.exitCode ? 'TESTS FAILED' : 'ALL TESTS PASSED');
})();

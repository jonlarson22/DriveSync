// DriveSync Compare — renderer.
let rootA = '', rootB = '';
let rows = [];           // all comparison rows
let selected = new Set(); // rel paths checked
let lastDirectionPick = null; // remember which bulk-select direction was used
let renames = [];        // detected folder rename candidates
let renameChecked = new Set(); // indexes into renames
let previewRel = null;   // file currently shown in the preview panel

const $ = (id) => document.getElementById(id);
const LABEL = { onlyA: 'Only in Left', onlyB: 'Only in Right', different: 'Different', same: 'Identical' };

function fmtSize(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}
function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

$('pickA').onclick = async () => { const p = await window.ds.pickFolder(); if (p) { rootA = p; $('pathA').value = p; } };
$('pickB').onclick = async () => { const p = await window.ds.pickFolder(); if (p) { rootB = p; $('pathB').value = p; } };

window.ds.onProgress(({ stage, count }) => { $('status').textContent = stage + ' ' + count.toLocaleString() + ' files'; });
window.ds.onCopyProgress(({ done, failed, total, current }) => {
  $('copyStatus').textContent = `Copying ${done + failed} / ${total} — ${current}`;
});

$('cancelBtn').onclick = async () => { await window.ds.cancel(); $('status').textContent = 'Cancelling…'; };

$('compareBtn').onclick = async () => {
  if (!rootA || !rootB) { $('status').textContent = 'Pick both a Left and a Right folder first.'; return; }
  if (rootA === rootB) { $('status').textContent = 'Left and Right are the same folder — pick two different locations.'; return; }
  $('compareBtn').disabled = true; $('cancelBtn').disabled = false;
  $('status').textContent = 'Scanning…';
  const res = await window.ds.compare({ rootA, rootB, mode: $('mode').value });
  $('compareBtn').disabled = false; $('cancelBtn').disabled = true;
  if (!res.ok) { $('status').textContent = 'Error: ' + res.error; return; }
  rows = res.rows;
  renames = res.renames || [];
  renameChecked = new Set(renames.map((_r, i) => i)); // pre-check all candidates — applying still asks first
  selected = new Set();
  // Sensible default: pre-select everything that needs copying to make B match A and vice versa? No —
  // default to nothing selected, so a stray click can't copy. Bulk buttons make selecting easy.
  $('status').textContent = `Done. ${rows.length.toLocaleString()} files compared.` + (res.errors.length ? ` (${res.errors.length} unreadable — see report)` : '');
  renderSummary(res.summary);
  renderRenames();
  $('toolbar').classList.remove('hidden');
  $('copybar').classList.remove('hidden');
  $('results').classList.remove('hidden');
  renderTable();
};

function renderSummary(s) {
  const el = $('summary');
  el.innerHTML = '';
  const cards = [
    [s.total.toLocaleString(), 'files compared'],
    [s.same.toLocaleString(), 'identical'],
    [s.onlyA.toLocaleString(), 'only in Left — ' + fmtSize(s.bytesOnlyA)],
    [s.onlyB.toLocaleString(), 'only in Right — ' + fmtSize(s.bytesOnlyB)],
    [s.different.toLocaleString(), 'different in both'],
    [(s.foldersOnlyA + s.foldersOnlyB).toLocaleString(), `folders only on one side (${s.foldersOnlyA} Left, ${s.foldersOnlyB} Right) of ${s.foldersTotal} folders`],
  ];
  for (const [b, span] of cards) {
    const d = document.createElement('div'); d.className = 'card';
    const bb = document.createElement('b'); bb.textContent = b;
    const ss = document.createElement('span'); ss.textContent = span;
    d.append(bb, ss); el.appendChild(d);
  }
  el.classList.remove('hidden');
}

function renderRenames() {
  const sec = $('renames');
  if (!renames.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  sec.querySelector('.renamesNote').textContent = renames.some((r) => !r.certain)
    ? 'These folders have different names on the two sides but matching contents (matched by filename + size — run an Exact/hash compare to be certain). Checked ones will be renamed when you pick a direction:'
    : 'These folders have different names on the two sides but hash-identical contents. Checked ones will be renamed when you pick a direction:';
  const list = $('renameList');
  list.innerHTML = '';
  renames.forEach((r, i) => {
    const label = document.createElement('label'); label.className = 'renameItem';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = renameChecked.has(i);
    cb.onchange = () => { cb.checked ? renameChecked.add(i) : renameChecked.delete(i); };
    label.append(cb, document.createTextNode(` Left: ${r.nameA}/  ↔  Right: ${r.nameB}/  (${r.fileCount.toLocaleString()} files, ${fmtSize(r.totalBytes)})`));
    list.appendChild(label);
  });
}

async function applyRenames(side) {
  // side 'B': rename on Right so its names match Left (fromRel = nameB, toRel = nameA)
  const picks = renames.filter((_r, i) => renameChecked.has(i));
  if (!picks.length) { $('renameStatus').textContent = 'No renames checked.'; return; }
  const desc = picks.map((r) => side === 'B' ? `${r.nameB}/ → ${r.nameA}/` : `${r.nameA}/ → ${r.nameB}/`).join('\n');
  if (!confirm(`Rename ${picks.length} folder(s) on the ${side === 'B' ? 'Right' : 'Left'} drive?\n\n${desc}\n\nNo files are copied — the folders just change name in place.`)) return;
  let done = 0, failed = 0;
  for (const r of picks) {
    const res = await window.ds.rename({ side, rootA, rootB, fromRel: side === 'B' ? r.nameB : r.nameA, toRel: side === 'B' ? r.nameA : r.nameB });
    res.ok ? done++ : failed++;
    if (!res.ok) console.log('Rename failed', r, res.error);
  }
  $('renameStatus').textContent = `Renamed ${done} folder(s)${failed ? `, ${failed} failed` : ''}. Re-running Compare…`;
  $('compareBtn').click();
}
$('renameOnB').onclick = () => applyRenames('B');
$('renameOnA').onclick = () => applyRenames('A');

function visibleRows() {
  const f = $('filter').value;
  const q = $('search').value.trim().toLowerCase();
  return rows.filter((r) => {
    if (f === 'diff' && r.status === 'same') return false;
    if (f !== 'all' && f !== 'diff' && r.status !== f) return false;
    if (q && !r.rel.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderTable() {
  const tbody = $('tbody');
  tbody.innerHTML = '';
  const vis = visibleRows();
  const frag = document.createDocumentFragment();
  for (const r of vis.slice(0, 5000)) { // cap DOM at 5k rows for huge photo libraries; filter/search to narrow
    const tr = document.createElement('tr');
    const cbTd = document.createElement('td'); cbTd.className = 'cb';
    const cb = document.createElement('input'); cb.type = 'checkbox';
    cb.checked = selected.has(r.rel);
    cb.disabled = r.status === 'same';
    cb.onchange = () => { cb.checked ? selected.add(r.rel) : selected.delete(r.rel); updateSelInfo(); };
    cbTd.appendChild(cb);
    const stTd = document.createElement('td');
    const pill = document.createElement('span'); pill.className = 'pill ' + r.status; pill.textContent = LABEL[r.status];
    stTd.appendChild(pill);
    const pTd = document.createElement('td'); pTd.className = 'path'; pTd.textContent = r.kind === 'folder' ? '📁 ' + r.rel + '/' : r.rel;
    const sa = document.createElement('td'); sa.textContent = r.kind === 'folder' ? (r.status !== 'onlyB' ? 'folder' : '—') : fmtSize(r.sizeA);
    const sb = document.createElement('td'); sb.textContent = r.kind === 'folder' ? (r.status !== 'onlyA' ? 'folder' : '—') : fmtSize(r.sizeB);
    const ma = document.createElement('td'); ma.textContent = fmtDate(r.mtimeA);
    const mb = document.createElement('td'); mb.textContent = fmtDate(r.mtimeB);
    tr.append(cbTd, stTd, pTd, sa, sb, ma, mb);
    if (previewRel === r.rel && r.kind === 'file') tr.className = 'selectedRow';
    if (r.kind === 'file') {
      tr.style.cursor = 'pointer';
      tr.onclick = (e) => { if (e.target !== cb) showPreview(r.rel); };
    }
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  if (vis.length > 5000) $('status').textContent = `Showing first 5,000 of ${vis.length.toLocaleString()} rows — use the filter or search to narrow down. Selections still work on shown rows; bulk-select buttons below select across ALL rows.`;
  updateSelInfo();
}

function updateSelInfo() {
  $('selInfo').textContent = selected.size ? selected.size.toLocaleString() + ' selected' : '';
}

$('filter').onchange = renderTable;
$('search').oninput = renderTable;

$('selVisible').onclick = () => { for (const r of visibleRows()) if (r.status !== 'same') selected.add(r.rel); renderTable(); };
$('selNone').onclick = () => { selected.clear(); renderTable(); };
$('selAtoB').onclick = () => { selected.clear(); for (const r of rows) if (r.status === 'onlyA' || (r.kind === 'file' && r.status === 'different')) selected.add(r.rel); lastDirectionPick = 'AtoB'; renderTable(); };
$('selBtoA').onclick = () => { selected.clear(); for (const r of rows) if (r.status === 'onlyB' || (r.kind === 'file' && r.status === 'different')) selected.add(r.rel); lastDirectionPick = 'BtoA'; renderTable(); };

async function doCopy(direction) {
  const items = [];
  let overwrites = 0;
  for (const r of rows) {
    if (!selected.has(r.rel)) continue;
    if (direction === 'AtoB' && (r.status === 'onlyA' || (r.kind === 'file' && r.status === 'different'))) { items.push({ rel: r.rel, kind: r.kind, direction }); if (r.status === 'different') overwrites++; }
    if (direction === 'BtoA' && (r.status === 'onlyB' || (r.kind === 'file' && r.status === 'different'))) { items.push({ rel: r.rel, kind: r.kind, direction }); if (r.status === 'different') overwrites++; }
  }
  if (!items.length) { $('copyStatus').textContent = 'Nothing selected that can copy in that direction.'; return; }
  const fileItems = items.filter((it) => it.kind === 'file');
  const folderItems = items.filter((it) => it.kind === 'folder');
  const totalBytes = fileItems.reduce((acc, it) => {
    const r = rows.find((x) => x.rel === it.rel && x.kind === 'file');
    return acc + (direction === 'AtoB' ? (r.sizeA || 0) : (r.sizeB || 0));
  }, 0);
  let msg = `Copy ${fileItems.length.toLocaleString()} file(s) (${fmtSize(totalBytes)})${folderItems.length ? ` and create ${folderItems.length.toLocaleString()} folder(s)` : ''} ${direction === 'AtoB' ? 'Left → Right' : 'Right → Left'}?`;
  if (overwrites) msg += `\n\n${overwrites.toLocaleString()} of them will OVERWRITE a different version on the other side.`;
  if (!confirm(msg)) return;
  $('copyAtoB').disabled = true; $('copyBtoA').disabled = true; $('cancelBtn').disabled = false;
  const res = await window.ds.copy({ rootA, rootB, items });
  $('copyAtoB').disabled = false; $('copyBtoA').disabled = false; $('cancelBtn').disabled = true;
  if (res.ok) {
    const r = res.results;
    $('copyStatus').textContent = `Done: ${r.done.toLocaleString()} item(s) copied/created, ${fmtSize(r.bytes)} of files${r.failed ? ` — ${r.failed} FAILED` : ''}${r.cancelled ? ' (cancelled)' : ''}. Re-run Compare to verify.`;
    if (r.failures.length) console.log('Copy failures', r.failures);
  }
}
$('copyAtoB').onclick = () => doCopy('AtoB');
$('copyBtoA').onclick = () => doCopy('BtoA');

async function showPreview(rel) {
  previewRel = rel;
  renderTable();
  const p = await window.ds.preview({ rootA, rootB, rel });
  $('previewTitle').textContent = 'Preview — ' + rel;
  fillPreviewSide('A', p.a, rel);
  fillPreviewSide('B', p.b, rel);
  $('preview').classList.remove('hidden');
  $('preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function fillPreviewSide(side, info, rel) {
  const body = $('preview' + side);
  const meta = $('previewMeta' + side);
  body.innerHTML = '';
  if (!info || !info.exists) {
    body.textContent = 'Not present on this side.';
    meta.textContent = '';
    $('open' + side).disabled = true;
    return;
  }
  $('open' + side).disabled = false;
  meta.textContent = `${fmtSize(info.size)} — modified ${fmtDate(info.mtimeMs)}`;
  if (info.dataUrl) {
    const img = document.createElement('img'); img.src = info.dataUrl; img.alt = rel;
    img.onload = () => { meta.textContent += ` — ${img.naturalWidth} × ${img.naturalHeight} px`; };
    body.appendChild(img);
  } else if (info.text !== undefined) {
    const pre = document.createElement('pre'); pre.textContent = info.text + (info.truncated ? '\n… (preview truncated)' : '');
    body.appendChild(pre);
  } else if (info.kind === 'video') {
    body.textContent = '🎬 Video — use Open to watch it in your usual player.';
  } else if (info.tooLarge) {
    body.textContent = 'File is too large to preview here — use Open to view it.';
  } else {
    body.textContent = 'No inline preview for this file type — use Open to view it.';
  }
}
$('openA').onclick = () => { if (previewRel) window.ds.open({ root: rootA, rel: previewRel }); };
$('openB').onclick = () => { if (previewRel) window.ds.open({ root: rootB, rel: previewRel }); };

$('reportBtn').onclick = async () => {
  if (!rows.length) return;
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = ['status,kind,path,size_left,size_right,modified_left,modified_right'];
  for (const r of rows) lines.push([LABEL[r.status], r.kind, r.rel, r.sizeA ?? '', r.sizeB ?? '', r.mtimeA ? new Date(r.mtimeA).toISOString() : '', r.mtimeB ? new Date(r.mtimeB).toISOString() : ''].map(esc).join(','));
  const ok = await window.ds.saveReport({ csv: lines.join('\n'), defaultName: 'drivesync-report.csv' });
  $('copyStatus').textContent = ok ? 'Report saved.' : '';
};

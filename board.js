'use strict';
/* Boards: grouped table with inline editing, filters, "+ Add item", Kanban. purchasing.js fills in the columns. */
const BOARD_TITLE = {};
const C = (f, label, type, w) => ({ f, label, type, w });
const COLS = {};
const CHOICES = {};
const DONE_STATUS = { pos: 'done' };
const DEFAULT_STATUS = { pos: 'drafting', research: 'identified' };

function matches(it) {
  const f = S.f;
  if (S.activeOnly && DONE_STATUS[it.board] && it.status === DONE_STATUS[it.board]) return false;
  if (f.person && !it.people.includes(f.person)) return false;
  if (f.status && it.status !== f.status) return false;
  if (f.group && it.group !== f.group) return false;
  if (f.priority && it.priority !== f.priority) return false;
  if (f.q) { const q = f.q.toLowerCase(); return [it.name, it.customer, it.quoteNo, it.so, it.product, it.id, it.poNo, it.container, it.category, supName(it)].some((v) => v && String(v).toLowerCase().includes(q)); }
  return true;
}
const boardItems = (board) => QB.items.filter((i) => i.board === board && matches(i));

function cell(it, c) {
  const v = it[c.f];
  const ed = (inner, cls = '') => `<td class="ed ${cls}" data-act="edit" data-id="${it.id}" data-f="${c.f}" data-t="${c.type}"><span class="c ${cls ? 'num' : ''}" title="${esc(v)}">${inner}</span></td>`;
  switch (c.type) {
    case 'name': return `<td class="stick ed" data-act="edit" data-id="${it.id}" data-f="name" data-t="text"><div class="namecell"><span class="grip" draggable="true" data-rowdrag="${it.id}" data-act="noop" title="Drag to move this card up, down or into another group">⋮⋮</span><span class="c" title="${esc(v)}">${esc(v)}</span><button class="open" data-act="open" data-id="${it.id}">Open ›</button></div></td>`;
    case 'status': return `<td>${pill(statusDef(it.board, v), '', `data-act="status" data-id="${it.id}"`)}</td>`;
    case 'people': return `<td><button class="avs" data-act="people" data-id="${it.id}" aria-label="Change people">${avs(v) || '<span class="muted">+</span>'}</button></td>`;
    case 'id': return `<td><button class="avs num idbtn" data-act="copyid" data-id="${it.id}" data-label="${c.label}" title="Click to copy">${it.id}</button></td>`;
    case 'supplier': return `<td class="ed" data-act="picksupplier" data-id="${it.id}"><span class="c" title="${esc(supName(it))}">${esc(supName(it)) || '<span class="muted">+ link supplier</span>'}</span></td>`;
    case 'money': return ed(fmt$(v), 'r');
    case 'pct': return ed(v == null || v === '' ? '' : `${v}%`, 'r');
    case 'num': return ed(v == null || v === '' ? '' : Number(v).toLocaleString('en-AU'), 'r');
    case 'date': { const late = v && v < today() && it.status !== 'done' && (c.f === 'expected' || c.f === 'nextAction' || (c.f === 'eta' && !it.landed) || (c.f === 'balanceDue' && !it.balancePaid)); return ed(late ? `<span class="chip bad">${fmtD(v)}</span>` : fmtD(v)); }
    case 'priority': { const p = prioDef(v); return `<td>${p ? pill(p, '', `data-act="priority" data-id="${it.id}"`) : `<button class="avs muted" data-act="priority" data-id="${it.id}" aria-label="Set priority">+</button>`}</td>`; }
    case 'choose': return `<td class="ed" data-act="choose" data-id="${it.id}" data-f="${c.f}"><span class="c">${esc(v)}</span></td>`;
    case 'count': { const n = c.f === 'upd' ? updatesOf(it.id).length : (it.files || []).length; return `<td><button class="avs num" data-act="open" data-id="${it.id}" data-tab="${c.f === 'upd' ? 'updates' : 'files'}">${n ? `<span class="chip">${n}</span>` : '<span class="muted">0</span>'}</button></td>`; }
    default: return ed(esc(v));
  }
}

function groupHtml(board, g, rows, cols) {
  const key = `${board}:${g.key}`; const shut = S.collapsed[key];
  const total = rows.reduce((s, i) => s + (Number(i.value) || 0), 0);
  const head = `<button class="grp-h" data-act="toggle" data-k="${key}" aria-expanded="${!shut}">${shut ? '▸' : '▾'} ${esc(g.label)} <span class="n num">${rows.length} item${rows.length === 1 ? '' : 's'}${board === 'research' ? '' : ` · ${fmt$(total) || '$0'}`}</span></button>`;
  if (shut) return `<div class="grp" data-g="${g.key}" style="--g:${g.color}">${head}</div>`;
  const width = cols.reduce((s, c) => s + c.w, 0);
  const mix = QB.STATUS[board].map((s) => { const n = rows.filter((i) => i.status === s.key).length; return n ? `<i style="flex:${n};background:${s.color}" title="${esc(s.label)}: ${n}"></i>` : ''; }).join('');
  return `<div class="grp" data-g="${g.key}" style="--g:${g.color}">${head}
    <table class="grid" style="width:${width}px"><colgroup>${cols.map((c) => `<col style="width:${c.w}px">`).join('')}</colgroup>
    <thead><tr>${cols.map((c, i) => `<th class="${i === 0 ? 'stick' : ''} ${['money', 'pct', 'num'].includes(c.type) ? 'r' : ''}">${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((it) => `<tr data-rowid="${it.id}" class="${S.flash === it.id ? 'flash' : ''}">${cols.map((c) => cell(it, c)).join('')}</tr>`).join('')}
      <tr class="add"><td class="stick"><input id="add-${board}-${g.key}" data-add="${g.key}" data-board="${board}" placeholder="+ Add item" aria-label="Add item to ${esc(g.label)}"></td><td colspan="${cols.length - 1}"></td></tr>
      <tr class="foot">${cols.map((c, i) => `<td class="${i === 0 ? 'stick' : ''} ${c.type === 'money' ? 'r' : ''}">${c.f === 'status' ? `<div class="mix">${mix}</div>` : c.f === 'value' ? `<span class="c num">${fmt$(total)}</span>` : ''}</td>`).join('')}</tr>
    </tbody></table></div>`;
}

const cardSub = (it) => (it.board === 'pos' ? `${supName(it) || 'No supplier linked'}${it.eta ? ` · ETA ${fmtD(it.eta)}` : ''}` : it.board === 'research' ? `${it.category || 'No category yet'}${supName(it) ? ` · ${supName(it)}` : ''}` : `${it.product || 'No product code yet'}${it.qty ? ` · ${Number(it.qty).toLocaleString('en-AU')}` : ''}`);
const cardRef = (it) => (it.board === 'pos' ? `${it.poNo ? it.poNo + ' · ' : ''}${fmt$(it.value)}` : it.board === 'research' ? (it.nextAction ? `Next ${fmtD(it.nextAction)}` : '') : `${it.quoteNo ? `SQ-${it.quoteNo} · ` : ''}${fmt$(it.value)}`);
function kanbanHtml(board, rows) {
  const cols = QB.STATUS[board].filter((s) => !(S.activeOnly && DONE_STATUS[board] === s.key) && !(S.hideEmpty && !rows.some((i) => i.status === s.key)));
  return `<div class="kan">${cols.map((s) => { const cards = rows.filter((i) => i.status === s.key); return `
    <div class="kcol" data-drop="${s.key}"><div class="kcol-h" style="--bg:${s.color};--fg:${textOn(s.color)}"><span>${esc(s.label)}</span><span class="num">${cards.length}</span></div>
    ${cards.map((it) => `<div class="kcard ${S.flash === it.id ? 'flash' : ''}" draggable="true" data-drag="${it.id}" data-act="open" data-id="${it.id}" style="--g:${group(it.group).color}" tabindex="0">
      <b>${esc(it.name)}</b><span class="muted">${esc(cardSub(it))}</span>
      <div class="ft"><span>${avs(it.people)}</span><span class="num">${esc(cardRef(it))}</span><span class="chip">${updatesOf(it.id).length}</span></div></div>`).join('')}</div>`; }).join('')}</div>
    <p class="muted" style="font-size:12.5px">Drag a card to another column to change its status. Click a card to open it.</p>`;
}

function viewBoard(board) {
  const rows = boardItems(board); const cols = COLS[board]; const f = S.f;
  const opt = (list, cur, any) => `<option value="">${any}</option>` + list.map(([k, l]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const groups = QB.GROUPS.filter((g) => g.boards.includes(board) && (!f.group || f.group === g.key));
  const body = S.view[board] === 'kanban' ? kanbanHtml(board, rows)
    : `<div class="scroll"><div class="groups">${groups.map((g) => groupHtml(board, g, rows.filter((i) => i.group === g.key), cols)).join('')}</div></div>`;
  return `<header class="page"><div><p class="eyebrow">Purchasing</p><h1>${BOARD_TITLE[board]}</h1></div>
      <div class="row"><div class="seg" role="group" aria-label="View">${['table', 'kanban'].map((v) => `<button class="${S.view[board] === v ? 'on' : ''}" data-act="view" data-v="${v}">${v === 'table' ? 'Table' : 'Kanban'}</button>`).join('')}</div>
      ${board === 'pos' ? '<button class="btn gold" data-act="newrow" data-target="add-pos-po_drafting">+ New PO draft</button>' : '<button class="btn gold" data-act="newrow" data-target="add-research-rs_stretch">+ New research card</button>'}</div></header>
    <div class="tools"><input type="search" id="f-q" placeholder="Search name, supplier, PO number, container, Item ID" value="${esc(f.q)}" aria-label="Search">
      <select id="f-person" data-filter="person" aria-label="Person">${opt(peopleFor(board).map((p) => [p.key, p.first]), f.person, 'Everyone')}</select>
      <select id="f-status" data-filter="status" aria-label="Status">${opt(QB.STATUS[board].map((s) => [s.key, s.label]), f.status, 'Any status')}</select>
      <select id="f-group" data-filter="group" aria-label="Group">${opt(QB.GROUPS.filter((g) => g.boards.includes(board)).map((g) => [g.key, g.label]), f.group, 'All groups')}</select>
      <select id="f-priority" data-filter="priority" aria-label="Priority">${opt(QB.PRIORITY.map((p) => [p.key, p.label]), f.priority, 'Any priority')}</select>
      ${DONE_STATUS[board] ? `<label class="row" style="font-size:13px"><input type="checkbox" id="f-active" ${S.activeOnly ? 'checked' : ''}> Active only (hide Done)</label>` : ''}
      ${S.view[board] === 'kanban' ? `<label class="row" style="font-size:13px"><input type="checkbox" id="f-empty" ${S.hideEmpty ? 'checked' : ''}> Hide empty columns</label>` : ''}
      <span class="muted num" style="margin-left:auto;font-size:12.5px">${rows.length} shown${board === 'research' ? '' : ` · ${fmt$(rows.reduce((s, i) => s + (Number(i.value) || 0), 0)) || '$0'}`}</span></div>${body}`;
}

// ---- actions ----
ACT.view = (el) => { S.view[S.route] = el.dataset.v; render(); };
ACT.toggle = (el) => { S.collapsed[el.dataset.k] = !S.collapsed[el.dataset.k]; render(); };
ACT.newrow = (el) => { S.view[S.route] = 'table'; S.f = noFilters(); S.collapsed = {}; render(); const inp = document.getElementById(el.dataset.target); if (inp) { inp.scrollIntoView({ block: 'center' }); inp.focus(); toast('Type a name here and press Enter. It gets its Item ID straight away.'); } };
ACT.picksupplier = (el, e) => { e.stopPropagation(); const it = item(el.dataset.id); pop(el, QB.suppliers.map((s) => `<button class="btn ghost sm" style="text-align:left" data-pick="${s.id}">${it.supplierId === s.id ? '✓ ' : ''}${esc(s.name)}</button>`).join('') + '<button class="btn ghost sm" data-pick="">No supplier</button>', (k) => { setField(it, 'supplierId', k); S.flash = it.id; render(); }); };
ACT.open = (el) => { S.open = el.dataset.id; S.tab = el.dataset.tab || 'updates'; S.draft = ''; render(); loadCardExtras(el.dataset.id); };
// Files and the authoritative activity log load when a card opens.
async function loadCardExtras(id) {
  const it = item(id); if (!it) return;
  try {
    const [files] = await Promise.all([DB.listFiles(id), DB.refreshActivity(id)]);
    it.files = files;
  } catch (e) { /* keep the card usable; files/activity just stay stale */ }
  if (S.open === id) render();
}
ACT.edit = (td) => {
  if ($('input', td)) return;
  const it = item(td.dataset.id); const f = td.dataset.f; const t = td.dataset.t;
  const numeric = ['money', 'pct', 'num'].includes(t);
  td.innerHTML = `<input class="cell" id="cell-edit" type="${t === 'date' ? 'date' : numeric ? 'number' : 'text'}" ${numeric ? 'step="any"' : ''} value="${esc(it[f] ?? '')}">`;
  const inp = $('input', td); let done = false; inp.focus(); if (inp.select) inp.select();
  const commit = (save) => { if (done) return; done = true; if (save) { const v = inp.value.trim(); if (setField(it, f, numeric ? (v === '' ? null : Number(v)) : v)) S.flash = it.id; } render(); };
  inp.addEventListener('blur', () => commit(true));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(true); if (e.key === 'Escape') { e.stopPropagation(); commit(false); } });
};
ACT.status = (el) => { const it = item(el.dataset.id); pop(el, QB.STATUS[it.board].map((s) => pill(s, '', `data-pick="${s.key}"`)).join(''), (k) => { setField(it, 'status', k); S.flash = it.id; render(); }, QB.STATUS[it.board].length > 10 ? 'two' : ''); };
ACT.priority = (el) => { const it = item(el.dataset.id); pop(el, QB.PRIORITY.map((p) => pill(p, '', `data-pick="${p.key}"`)).join('') + '<button class="btn ghost sm" data-pick="">Clear</button>', (k) => { setField(it, 'priority', k); render(); }); };
ACT.people = (el) => { const it = item(el.dataset.id); pop(el, peopleFor(it.board).map((p) => `<button class="btn ghost sm" style="text-align:left" data-pick="${p.key}">${it.people.includes(p.key) ? '✓ ' : ''}${esc(p.name)}</button>`).join(''), (k) => { setField(it, 'people', it.people.includes(k) ? it.people.filter((x) => x !== k) : [...it.people, k]); render(); }); };
ACT.choose = (el) => { const it = item(el.dataset.id); const f = el.dataset.f; pop(el, CHOICES[f]().map((o) => `<button class="btn ghost sm" style="text-align:left" data-pick="${esc(o)}">${esc(o)}</button>`).join(''), (v) => { setField(it, f, v); render(); }); };
['status', 'priority', 'people', 'choose'].forEach((a) => { const fn = ACT[a]; ACT[a] = (el, e) => { e.stopPropagation(); fn(el); }; });

function createItem(board, groupKey, fields) {
  const peers = QB.items.filter((i) => i.board === board && i.group === groupKey);
  const position = peers.length ? Math.max(...peers.map((i) => i.position || 0)) + 10 : 10;
  const it = { id: newItemId(), board, group: groupKey, status: DEFAULT_STATUS[board], position, people: [S.me], value: null, received: today(), nextAction: '', supplierId: '', notes: '', priority: '', files: [], ...fields };
  QB.items.push(it);
  const { files, ...row } = it;   // files live in storage, not on the row
  DB.insertItem(row);
  logAct(it, 'created', '', `Item ID ${it.id}`); S.flash = it.id; return it;
}

// ---- typed input, filters, add-row, drag and drop ----
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'f-q') { S.f.q = t.value; render(); const el = $('#f-q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  else if (t.id === 'composer') S.draft = t.value;
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.filter) { S.f[t.dataset.filter] = t.value; render(); }
  if (t.id === 'f-active') { S.activeOnly = t.checked; render(); }
  if (t.id === 'f-empty') { S.hideEmpty = t.checked; render(); }
});
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (e.key === 'Enter' && t.dataset && t.dataset.add && t.value.trim()) { const it = createItem(t.dataset.board, t.dataset.add, { name: t.value.trim() }); render(); toast(`Added with Item ID ${it.id}.`, 'Open', () => { S.open = it.id; render(); }); }
  if (e.key === 'Enter' && t.classList && t.classList.contains('kcard')) t.click();
});
document.addEventListener('dragstart', (e) => { const c = e.target.closest && e.target.closest('[data-drag]'); if (c) e.dataTransfer.setData('text/plain', c.dataset.drag); });
document.addEventListener('dragover', (e) => { const col = e.target.closest && e.target.closest('[data-drop]'); if (col) { e.preventDefault(); col.classList.add('over'); } });
document.addEventListener('dragleave', (e) => { const col = e.target.closest && e.target.closest('[data-drop]'); if (col && !col.contains(e.relatedTarget)) col.classList.remove('over'); });
document.addEventListener('drop', (e) => {
  const col = e.target.closest && e.target.closest('[data-drop]'); if (!col) return;
  e.preventDefault(); const it = item(e.dataTransfer.getData('text/plain'));
  if (it && setField(it, 'status', col.dataset.drop)) S.flash = it.id; render();
});

// ---- drag rows up and down in the Table view (or into another group), using the ⋮⋮ handle ----
let rowDrag = null;
const clearDropMarks = () => document.querySelectorAll('.dropabove,.dropbelow,.dropinto').forEach((n) => n.classList.remove('dropabove', 'dropbelow', 'dropinto'));
const rowTarget = (e) => { const t = e.target; const tr = t.closest ? t.closest('tr[data-rowid]') : null; const grp = t.closest ? t.closest('.grp[data-g]') : null; return { tr, grp }; };
const lowerHalf = (e, tr) => { const r = tr.getBoundingClientRect(); return e.clientY >= r.top + r.height / 2; };
document.addEventListener('dragstart', (e) => {
  const h = e.target.closest ? e.target.closest('[data-rowdrag]') : null; if (!h) return;
  rowDrag = h.dataset.rowdrag; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', rowDrag);
  const tr = h.closest('tr'); if (tr && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(tr, 12, 16);
});
document.addEventListener('dragend', () => { rowDrag = null; clearDropMarks(); });
document.addEventListener('dragover', (e) => {
  if (!rowDrag) return;
  const { tr, grp } = rowTarget(e); if (!grp) return;
  e.preventDefault(); clearDropMarks();
  if (tr) tr.classList.add(lowerHalf(e, tr) ? 'dropbelow' : 'dropabove'); else grp.classList.add('dropinto');
});
document.addEventListener('drop', (e) => {
  if (!rowDrag) return;
  const { tr, grp } = rowTarget(e); if (!grp) return;
  e.preventDefault();
  const it = item(rowDrag); rowDrag = null; clearDropMarks();
  if (!it || (tr && tr.dataset.rowid === it.id)) return;
  const g = grp.dataset.g; const arr = QB.items;
  arr.splice(arr.indexOf(it), 1);
  if (tr) arr.splice(arr.indexOf(item(tr.dataset.rowid)) + (lowerHalf(e, tr) ? 1 : 0), 0, it);
  else { let last = -1; arr.forEach((x, i) => { if (x.board === it.board && x.group === g) last = i; }); arr.splice(last < 0 ? arr.length : last + 1, 0, it); }
  // Persist the new spot: position sits between its new neighbours in the group.
  const peers = arr.filter((x) => x.board === it.board && x.group === g);
  const at = peers.indexOf(it);
  const prev = at > 0 ? peers[at - 1].position : 0;
  const next = at < peers.length - 1 ? peers[at + 1].position : prev + 20;
  it.position = (prev + next) / 2;
  DB.patchItem(it.id, { position: it.position }, 'the order');
  if (it.group !== g) {
    setField(it, 'group', g);
    const h = it.board === 'pos' && GROUP_HEALTH[g] && HEALTH_GROUP[it.status] !== g ? GROUP_HEALTH[g] : null;
    if (h) setField(it, 'status', h);
    toast(`Moved to "${group(g).label}"${h ? ` and Health set to "${statusDef('pos', h).label}"` : ''}.`);
  }
  S.flash = it.id; render();
});

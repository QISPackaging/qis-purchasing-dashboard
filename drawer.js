'use strict';
/* Card drawer: fields, Updates / Files / Activity / Unleashed tabs. */
const SRC_LABEL = { monday: 'from Monday', claude: 'added by Claude' };

function tabUpdates(it) {
  const list = updatesOf(it.id).slice().reverse();
  return `<div class="composer"><label class="muted" for="composer" style="font-size:12px">Write an update or paste a supplier email</label>
      <textarea id="composer" placeholder="e.g. Supplier confirms the container is ready on the 29th…">${esc(S.draft)}</textarea>
      <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn" data-act="post">Post update</button></div></div>
    ${list.length ? list.map((u, i) => `<div class="upd ${i === 0 && S.flash === it.id ? 'flash' : ''}"><div class="meta">${avs([u.by])}<b style="margin-left:6px">${esc(person(u.by).name)}</b><span class="num">${fmtDT(u.at)}</span>${SRC_LABEL[u.src] ? `<span class="chip">${SRC_LABEL[u.src]}</span>` : ''}</div><div class="body">${esc(u.text)}</div></div>`).join('') : '<p class="muted">No updates yet.</p>'}`;
}
function tabFiles(it) {
  const files = it.files || [];
  const what = it.board === 'pos' ? 'the PO, proforma invoice, packing list or bill of lading' : 'a spec sheet or supplier quote';
  const ext = (n) => (n.includes('.') ? n.split('.').pop().toUpperCase().slice(0, 4) : 'FILE');
  return `<button class="drop" data-act="addfile">Add ${what} — click to choose a file</button>
    ${files.map((f) => `<button class="file" data-act="openfile" data-name="${esc(f.name)}" title="Open"><span class="ext">${esc(ext(f.name))}</span><span style="flex:1;overflow-wrap:anywhere;text-align:left">${esc(f.name)}</span><span class="muted num">${f.size} KB</span></button>`).join('') || '<p class="muted">No files on this card yet.</p>'}`;
}
function tabActivity(it) {
  const list = (QB.activity[it.id] || []).slice().reverse();
  return `${list.map((a) => `<div class="act"><time class="num">${fmtDT(a.at)}</time><b>${esc(person(a.by).first)}</b><span>${esc(a.field)}: ${a.from ? `<span class="muted">${esc(a.from)}</span> → ` : ''}<b>${esc(a.to) || '(cleared)'}</b></span></div>`).join('')}
    <div class="act"><time class="num">${fmtD(it.received)}</time><span class="muted">Card created${it.id.startsWith('9') ? '' : ' (carried over from Monday with its original Item ID)'}</span></div>
    <p class="muted" style="font-size:12px">Every change is recorded with who made it and when, including changes made through Claude.</p>`;
}
function drawerKvs(it) {
  // Every field here edits in place, the same as its cell in the table: text, number and date boxes, or the matching picker.
  const dash = '<span class="muted">–</span>';
  const type = (f) => (COLS[it.board].find((c) => c.f === f) || {}).type || 'text';
  const kv = (label, f, shown) => {
    const t = type(f); const val = shown != null ? shown : it[f];
    const attrs = t === 'supplier' ? `data-act="picksupplier" data-id="${it.id}"` : t === 'choose' ? `data-act="choose" data-id="${it.id}" data-f="${f}"`
      : `data-act="edit" data-id="${it.id}" data-f="${f}" data-t="${['quote', 'so', 'name'].includes(t) ? 'text' : t}"`;
    return `<div><span>${label}</span><b class="num kved" ${attrs} title="Click to change">${val ? esc(val) : dash}</b></div>`;
  };
  const ro = (label, shown) => `<div><span>${label}</span><b class="num">${shown ? esc(shown) : dash}</b></div>`;
  const d = (f) => fmtD(it[f]); const n = (f) => (it[f] ? Number(it[f]).toLocaleString('en-AU') : '');
  if (it.board === 'pos') return kv('Supplier', 'supplierId', supName(it)) + kv('PO number', 'poNo') + kv('Order value', 'value', fmt$(it.value)) + kv('Freight forwarder', 'forwarder') + kv('Container / BL ref', 'container') + kv('Deposit paid', 'depositPaid') + kv('Balance due', 'balanceDue', d('balanceDue')) + kv('Balance paid', 'balancePaid', d('balancePaid')) + kv('ERD (ready at factory)', 'erd', d('erd')) + kv('ETD', 'etd', d('etd')) + kv('ETA', 'eta', d('eta')) + kv('Received / landed', 'landed', d('landed')) + kv('Next action due', 'nextAction', d('nextAction'));
  return kv('Product category', 'category') + kv('Supplier', 'supplierId', supName(it)) + kv('Sample requested', 'sampleRequested') + kv('Sample connote', 'sampleConnote') + kv('Next action due', 'nextAction', d('nextAction'));
}
function drawerFooter(it) {
  const note = (t) => `<span class="muted" style="font-size:12.5px;align-self:center">${t}</span>`;
  if (it.board === 'pos') {
    if (it.group === 'po_forecast') return `<span class="row">${note('Repeats on the 1st of every month')}</span><button class="btn gold" data-act="forecastdone">Done for this month</button>`;
    return `<span class="row">${it.fromResearch ? `<button class="btn ghost" data-act="open" data-id="${it.fromResearch}">See the research card</button>` : ''}</span>${it.landed ? note(`Landed ${fmtD(it.landed)}`) : it.poNo ? '<button class="btn gold" data-act="marklanded">Mark as landed today</button>' : note('Not placed yet. Add the PO number once it is in Unleashed.')}`;
  }
  return `<span class="row">${supName(it) ? '<button class="btn ghost" data-act="tosupplier">See the supplier</button>' : ''}</span>${it.poId ? `<button class="btn ghost" data-act="open" data-id="${it.poId}">Open its PO draft</button>` : '<button class="btn gold" data-act="startpo">Start a PO draft →</button>'}`;
}
function drawerHtml(it) {
  if (!it) return '';
  const g = group(it.group); const p = prioDef(it.priority);
  const tabs = [['updates', `Updates (${updatesOf(it.id).length})`], ['files', `Files (${(it.files || []).length})`], ['activity', 'Activity']];
  if (it.board === 'pos') tabs.push(['unleashed', 'Unleashed']);
  const tab = tabs.some(([k]) => k === S.tab) ? S.tab : 'updates';
  const body = { updates: tabUpdates, files: tabFiles, activity: tabActivity, unleashed: tabUnleashedPO }[tab](it);
  const longf = (label, f) => `<div class="dnotes" data-act="editlong" data-id="${it.id}" data-f="${f}" title="Click to change"><b>${label}.</b> ${it[f] ? esc(it[f]) : '<span class="muted">Click to add.</span>'}</div>`;
  const notes = (it.board === 'research' ? longf('Spec / requirements', 'spec') : '') + longf('Notes', 'notes');
  return `<div class="shade" data-act="close"></div>
  <aside class="drawer" role="dialog" aria-label="${esc(it.name)}">
    <div class="dh"><div class="top"><div><p class="eyebrow">${BOARD_TITLE[it.board]} · <span style="color:${g.color}">${esc(g.label)}</span></p><h3 class="kved" data-act="edit" data-id="${it.id}" data-f="name" data-t="text" title="Click to rename">${esc(it.name)}</h3></div><button class="x" data-act="close" aria-label="Close">×</button></div>
      <div class="row">${pill(statusDef(it.board, it.status), 'round', `data-act="status" data-id="${it.id}"`)}${p ? pill(p, 'round', `data-act="priority" data-id="${it.id}"`) : `<button class="btn ghost sm" data-act="priority" data-id="${it.id}">Set priority</button>`}
        <button class="avs" style="width:auto" data-act="people" data-id="${it.id}" aria-label="Change people">${avs(it.people, 'lg') || 'Assign'}</button><button class="chip num chipbtn" data-act="copyid" data-id="${it.id}" data-label="${it.board === 'research' ? 'Inquiry ID' : 'Item ID'}" title="Click to copy">${it.board === 'research' ? 'Inquiry' : 'Item'} ${it.id}</button></div>
      <div class="kvs">${drawerKvs(it)}</div>${notes}</div>
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="${tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}</div>
    <div class="db">${body}</div>
    <div class="df">${drawerFooter(it)}</div>
  </aside>`;
}

ACT.editlong = (el) => {
  if ($('textarea', el)) return;
  const it = item(el.dataset.id); const f = el.dataset.f;
  el.innerHTML = `<textarea class="longedit" id="long-edit" aria-label="${esc(f)}">${esc(it[f] || '')}</textarea>`;
  const ta = $('textarea', el); let done = false; ta.focus();
  const commit = (save) => { if (done) return; done = true; if (save && setField(it, f, ta.value.trim())) S.flash = it.id; render(); };
  ta.addEventListener('blur', () => commit(true));
  ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); commit(false); } });
};
ACT.close = () => { S.open = null; S.draft = ''; render(); };
ACT.tab = (el) => { S.tab = el.dataset.tab; render(); };
ACT.post = () => {
  const it = item(S.open); const text = S.draft.trim();
  if (!text) { toast('Type an update first.'); $('#composer').focus(); return; }
  addUpdate(it, text); S.draft = ''; render();
  toast('Update posted.');
};
ACT.addfile = () => {
  const id = S.open; const inp = $('#fpick');
  inp.value = '';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    if (f.size > 45 * 1024 * 1024) { toast('That file is over 45 MB — too big for the card. Put it on SharePoint and paste the link in Notes.'); return; }
    toast(`Uploading ${f.name}…`);
    try {
      await DB.uploadFile(id, f);
      const it = item(id); if (it) { logAct(it, 'file added', '', f.name); it.files = await DB.listFiles(id); }
      if (S.open === id) render();
      toast(`${f.name} added to the card.`);
    } catch (e) { /* guard() already showed the failure */ }
  };
  inp.click();
};
ACT.openfile = async (el, e) => {
  e.stopPropagation();
  try { const url = await DB.fileUrl(S.open, el.dataset.name); window.open(url, '_blank'); }
  catch (err) { toast(`Couldn't open the file: ${err.message}`); }
};

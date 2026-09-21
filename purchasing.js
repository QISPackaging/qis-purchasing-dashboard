'use strict';
/* Purchasing area: Purchase Orders + Supplier Research boards, Overview, Suppliers, and the rules that link them. */
BOARD_TITLE.pos = 'Purchase Orders';
BOARD_TITLE.research = 'Supplier Research';
COLS.pos = [C('name', 'Name', 'name', 300), C('status', 'Health', 'status', 196), C('people', 'Owner', 'people', 86), C('supplierId', 'Supplier', 'supplier', 196), C('poNo', 'PO Number', 'text', 120), C('value', 'Order Value', 'money', 110), C('nextAction', 'Next Action Due', 'date', 126), C('priority', 'Priority', 'priority', 100), C('forwarder', 'Freight Forwarder', 'choose', 140), C('container', 'Container / BL Ref', 'text', 200), C('depositPaid', 'Deposit Paid', 'text', 150), C('balanceDue', 'Balance Due', 'date', 110), C('balancePaid', 'Balance Paid', 'date', 110), C('erd', 'ERD', 'date', 96), C('etd', 'ETD', 'date', 96), C('eta', 'ETA', 'date', 96), C('landed', 'Received / Landed', 'date', 132), C('notes', 'Notes', 'text', 220), C('files', 'Files', 'count', 64), C('upd', 'Updates', 'count', 76), C('id', 'Item ID', 'id', 112)];
COLS.research = [C('name', 'Name', 'name', 330), C('id', 'Inquiry ID', 'id', 112), C('status', 'Stage', 'status', 236), C('people', 'Owner', 'people', 86), C('priority', 'Priority', 'priority', 100), C('category', 'Product Category', 'choose', 170), C('supplierId', 'Supplier', 'supplier', 196), C('sampleRequested', 'Sample Requested', 'choose', 132), C('sampleConnote', 'Sample Connote', 'text', 150), C('spec', 'Spec / Requirements', 'text', 260), C('nextAction', 'Next Action Due', 'date', 126), C('notes', 'Notes', 'text', 220), C('files', 'Files', 'count', 64), C('upd', 'Updates', 'count', 76)];
CHOICES.forwarder = () => QB.FORWARDERS;
CHOICES.category = () => QB.CATEGORIES;
CHOICES.sampleRequested = () => ['Yes', 'No'];

function supplier(id) { return QB.suppliers.find((s) => s.id === id); }
function supName(it) { const s = it && it.supplierId ? supplier(it.supplierId) : null; return s ? s.name : ''; }
const daysTo = (d) => Math.round((new Date(d) - new Date(today())) / 864e5);
const dueChip = (d) => { const n = daysTo(d); return `<span class="chip ${n < 0 ? 'bad' : n <= 3 ? 'warn' : 'good'}">${n < 0 ? `${-n} day${n === -1 ? '' : 's'} late` : n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`}</span>`; };

// ---- rules (database triggers in the real build) ----
// A PO's group follows its Health, so nobody has to drag cards between groups as well as changing the status.
const HEALTH_GROUP = { drafting: 'po_drafting', review: 'po_drafting', waiting: 'po_placed', in_production: 'po_placed', forwarder: 'po_placed', on_water: 'po_water', landed: 'po_landed', done: 'po_done' };
// ...and the other way round: dragging a PO into a group sets a matching Health, so the two never drift apart.
const GROUP_HEALTH = { po_drafting: 'drafting', po_placed: 'in_production', po_water: 'on_water', po_landed: 'landed', po_done: 'done' };
function purchasingLanded(it) { if (it.status !== 'landed' && it.status !== 'done') setField(it, 'status', 'landed'); }
function moveGroup(it, g, why) {
  if (it.group === g) return;
  logAct(it, 'group (auto rule)', group(it.group).label, group(g).label); it.group = g;
  DB.patchItem(it.id, { group: g }, 'the group move');
  toast(`Moved to "${group(g).label}" ${why}.`);
}
function purchasingTransition(it, to) {
  if (it.board === 'pos') {
    if (it.group === 'po_forecast') return;                       // forecast cards stay where they are
    if (to === 'landed' && !it.landed) setField(it, 'landed', today());   // stamps + persists the landed date
    const g = HEALTH_GROUP[to];
    if (g) moveGroup(it, g, 'to match its Health');
    return;
  }
  if (to === 'approved' && !it.poId) toast(`${it.name}: approved and ready to use.`, 'Start a PO draft', () => startPo(it.id));
}
function startPo(id) {
  const r = item(id); if (!r) return;
  if (r.poId) { S.route = 'pos'; S.open = r.poId; render(); return; }
  const s = supplier(r.supplierId);
  const po = createItem('pos', 'po_drafting', { name: `${s ? s.name : r.name} — PO draft`, supplierId: r.supplierId || '', priority: r.priority || '', nextAction: bizDays(3), fromResearch: r.id, notes: `Started from supplier research ${r.id}: ${r.name}.` });
  r.poId = po.id;
  DB.patchItem(r.id, { poId: po.id }, 'the research link');
  addUpdate(r, `PO draft started: Item ${po.id}.`); addUpdate(po, `Started from supplier research card ${r.id} (${r.name}).`);
  S.route = 'pos'; S.open = po.id; S.tab = 'updates'; S.f = noFilters(); S.flash = po.id; render();
  toast('PO draft created in "Drafting Orders" and linked to the research card.');
}
ACT.startpo = () => startPo(S.open);
ACT.marklanded = () => {
  const it = item(S.open); setField(it, 'status', 'landed');      // the Health rule stamps the landed date and moves the group
  addUpdate(it, 'Marked as landed. Receiving and count to do.'); S.flash = it.id; render();
};
ACT.forecastdone = () => {
  const it = item(S.open); const next = QB.firstOfMonth(1); const month = new Date().toLocaleString('en-AU', { month: 'long' });
  addUpdate(it, `Forecast check done for ${month}.`); setField(it, 'nextAction', next); render();
  toast(`Done for ${month}. This card comes back on ${fmtD(next)}.`);
};
ACT.tosupplier = () => { const it = item(S.open); S.route = 'suppliers'; S.flashSup = it.supplierId; S.open = null; render(); const row = document.querySelector(`[data-sup="${it.supplierId}"]`); if (row) row.scrollIntoView({ block: 'center' }); };
ACT.supfilter = (el) => { S.route = 'pos'; S.view.pos = 'table'; S.f = { ...noFilters(), q: supplier(el.dataset.sup).name }; S.activeOnly = false; render(); scrollTo(0, 0); };

// ---- Unleashed tab on a PO card (live, read-only, via the pd-unleashed function) ----
function tabUnleashedPO(it) {
  if (!it.poNo) return '<p class="muted">No PO number on this card yet. Once the order is placed in Unleashed, put its PO number on the card and the live purchase order shows here.</p>';
  const c = it._ul;
  if (!c) { fetchUnleashedPO(it); return `<p class="muted">Looking up ${esc(it.poNo)} in Unleashed…</p>`; }
  if (c.error) return `<p class="muted">Couldn't reach Unleashed: ${esc(c.error)}</p><button class="btn ghost sm" data-act="ulretry">Try again</button>`;
  const po = c.po;
  if (!po) return `<p class="muted">${esc(it.poNo)} was not found in Unleashed. Check the PO number on the card.</p><button class="btn ghost sm" data-act="ulretry">Look again</button>`;
  const cur = (po.Currency || {}).CurrencyCode || 'AUD';
  const lines = po.PurchaseOrderLines || [];
  const shown = lines.slice(0, 12);
  const money = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return `<div class="ul"><div class="h"><b>${esc(po.OrderNumber)}</b><span class="chip ${['Complete', 'Costed'].includes(po.OrderStatus) ? 'good' : po.OrderStatus === 'Deleted' ? 'bad' : 'warn'}">${esc(po.OrderStatus)}</span>
      <span class="num">${cur} ${money(po.SubTotal)} ex GST</span>${cur !== 'AUD' ? `<span class="num muted">= AUD ${money(po.BCSubTotal)}</span>` : ''}
      <span class="muted">${esc((po.Supplier || {}).SupplierName || '')} (${esc((po.Supplier || {}).SupplierCode || '')})</span></div>
    ${shown.map((l) => `<div class="ln"><span><b>${esc((l.Product || {}).ProductCode || '')}</b> · <span class="num">${Number(l.OrderQuantity || 0).toLocaleString('en-AU')} @ ${money(l.UnitPrice)}</span></span><span class="num">${money(l.LineTotal)}</span></div>`).join('')}
    ${lines.length > shown.length ? `<div class="ln"><span class="muted">+ ${lines.length - shown.length} more lines</span></div>` : ''}
    <div class="ln"><span class="muted">Read live from Unleashed just now</span><span class="row"><button class="btn ghost sm" data-act="ulretry">Refresh</button><button class="btn ghost sm" data-act="pofill">Fill Order Value (AUD ex GST)</button></span></div></div>
    <p class="muted" style="font-size:12px">Read-only. Changes to the PO itself are made in Unleashed.</p>`;
}
async function fetchUnleashedPO(it) {
  if (it._ulLoading) return;
  it._ulLoading = true;
  try {
    const res = await DB.unleashed('list_purchase_orders', { orderNumber: it.poNo });
    it._ul = { po: (res.Items || [])[0] || null };
  } catch (e) { it._ul = { error: e.message }; }
  it._ulLoading = false;
  if (S.open === it.id && S.tab === 'unleashed') render();
}
ACT.ulretry = () => { const it = item(S.open); it._ul = null; render(); };
ACT.pofill = () => {
  const it = item(S.open); const po = (it._ul || {}).po;
  if (!po) { toast('Load the Unleashed PO first.'); return; }
  const v = Math.round(Number(po.BCSubTotal ?? po.SubTotal) * 100) / 100;
  const changed = setField(it, 'value', v);
  render(); toast(changed ? `Order Value set to AUD ${v.toLocaleString('en-AU')} from ${po.OrderNumber}.` : 'Order Value already matches Unleashed.');
};

// ---- Overview (the purchasing dashboard) ----
function viewPOverview() {
  const pos = QB.items.filter((i) => i.board === 'pos' && i.group !== 'po_forecast');
  const sum = (l) => l.reduce((t, i) => t + (Number(i.value) || 0), 0);
  const onOrder = pos.filter((i) => i.poNo && !i.landed && i.status !== 'done');
  const water = pos.filter((i) => i.group === 'po_water');
  const drafts = pos.filter((i) => i.group === 'po_drafting');
  const arriving = onOrder.filter((i) => i.eta).sort((a, b) => a.eta.localeCompare(b.eta));
  const soon = arriving.filter((i) => daysTo(i.eta) <= 14);
  const bal = pos.filter((i) => i.balanceDue && !i.balancePaid && i.status !== 'done').sort((a, b) => a.balanceDue.localeCompare(b.balanceDue));
  const research = QB.items.filter((i) => i.board === 'research' && i.status !== 'parked');
  const mix = QB.STATUS.research.map((s) => { const n = research.filter((i) => i.status === s.key).length; return n ? `<i style="flex:${n};background:${s.color}" title="${esc(s.label)}: ${n}"></i>` : ''; }).join('');
  const row = (i, left, right) => `<div class="work" data-act="open" data-id="${i.id}" tabindex="0"><span><b>${esc(i.name)}</b><br><span class="muted" style="font-size:12.5px">${left}</span></span><span class="row">${right}</span></div>`;
  return `<header class="page"><div><p class="eyebrow">Purchasing</p><h1>Purchasing Overview</h1></div>
      <p class="muted" style="max-width:520px;margin:0;font-size:12.5px">Everything here is worked out from the Purchase Orders and Supplier Research cards. Nothing is entered on this page.</p></header>
    <div class="tiles">
      <div class="tile"><div class="k">On order</div><div class="v num">${fmt$(sum(onOrder)) || '$0'}</div><div class="s num">${onOrder.length} purchase orders not yet landed</div></div>
      <div class="tile"><div class="k">On the water</div><div class="v num">${fmt$(sum(water)) || '$0'}</div><div class="s num">${water.length} shipments</div></div>
      <div class="tile"><div class="k">Landing in 14 days</div><div class="v num">${soon.length}</div><div class="s num">${soon.length ? `next ETA ${fmtD(soon[0].eta)}` : 'nothing due'}</div></div>
      <div class="tile"><div class="k">Balances to pay</div><div class="v num">${bal.length}</div><div class="s num">${bal.length ? `next due ${fmtD(bal[0].balanceDue)}` : 'none outstanding'}</div></div>
      <div class="tile"><div class="k">Drafts in progress</div><div class="v num">${drafts.length}</div><div class="s num">${fmt$(sum(drafts)) || '$0'} being drafted</div></div></div>
    <div class="split">
      <div class="panel"><h2 style="margin-top:0">Arriving next</h2>${arriving.map((i) => row(i, `${esc(supName(i))} · ${esc(i.forwarder || 'no forwarder yet')}${i.container ? ` · ${esc(i.container)}` : ''}`, `<span class="num">ETA ${fmtD(i.eta)}</span>${dueChip(i.eta)}`)).join('') || '<p class="muted">No ETAs entered yet.</p>'}</div>
      <div class="panel"><h2 style="margin-top:0">Balance payments coming up</h2>${bal.map((i) => row(i, `${esc(supName(i))} · order value ${fmt$(i.value)} · deposit: ${esc(i.depositPaid || 'not recorded')}`, `<span class="num">due ${fmtD(i.balanceDue)}</span>${dueChip(i.balanceDue)}`)).join('') || '<p class="muted">No balances outstanding.</p>'}</div>
      <div class="panel" style="grid-column:1/-1"><h2 style="margin-top:0">Supplier research in progress</h2><div class="mix" style="margin:0 0 10px;height:10px">${mix}</div>
        ${research.map((i) => row(i, `${esc(i.category || 'No category')}${supName(i) ? ` · ${esc(supName(i))}` : ''}`, `${pill(statusDef('research', i.status), 'round')}${i.nextAction ? dueChip(i.nextAction) : ''}`)).join('')}</div>
    </div>`;
}

// ---- Suppliers (the Supplier Matrix both boards link to) ----
function viewSuppliers() {
  const rows = QB.suppliers.map((s) => {
    const pos = QB.items.filter((i) => i.board === 'pos' && i.supplierId === s.id && i.poNo && !i.landed && i.status !== 'done');
    const rs = QB.items.filter((i) => i.board === 'research' && i.supplierId === s.id && i.status !== 'parked');
    return `<tr class="click ${S.flashSup === s.id ? 'flash' : ''}" data-sup="${s.id}" data-act="supfilter" tabindex="0"><td><b>${esc(s.name)}</b><br><span class="muted num" style="font-size:12px">Unleashed code ${esc(s.code)}</span></td>
      <td>${pill({ label: s.tier, color: QB.TIERS[s.tier] }, 'round')}</td><td>${esc(s.country)}</td><td>${esc(s.products)}</td><td class="num">${esc(s.lead)}</td><td>${esc(s.freight)}</td><td>${esc(s.moq)}</td><td>${esc(s.currency)} · ${esc(s.terms)}</td>
      <td class="num">${pos.length ? `<b>${pos.length}</b> · ${fmt$(pos.reduce((t, i) => t + (Number(i.value) || 0), 0))}` : '<span class="muted">none</span>'}</td><td class="num">${rs.length || '<span class="muted">none</span>'}</td></tr>`;
  }).join('');
  S.flashSup = null;
  return `<header class="page"><div><p class="eyebrow">Purchasing</p><h1>Suppliers</h1></div>
      <p class="muted" style="max-width:560px;margin:0;font-size:12.5px">This is the Supplier Matrix. Both purchasing boards link to it, so it moves across with them. Open POs and research cards are counted from the boards. Click a supplier to see its purchase orders.</p></header>
    <div class="scroll"><table class="plain" style="min-width:1180px"><thead><tr><th>Supplier</th><th>Tier</th><th>Country</th><th>Products</th><th>Production lead time</th><th>Freight</th><th>MOQ</th><th>Currency and terms</th><th>On order</th><th>Research cards</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---- My Work for the purchasing area ----
function purchasingWork() {
  const out = []; const t = today();
  QB.items.forEach((i) => {
    if ((i.board !== 'pos' && i.board !== 'research') || i.status === 'done' || i.status === 'parked') return;
    if (i.nextAction && i.nextAction <= t) out.push([i, i.group === 'po_forecast' ? 'Monthly forecast check due' : i.nextAction < t ? 'Next action overdue' : 'Next action due today', i.nextAction < t ? 'bad' : 'warn', `due ${fmtD(i.nextAction)} · ${BOARD_TITLE[i.board]}`]);
    if (i.board === 'pos' && i.eta && !i.landed && i.eta < t) out.push([i, 'ETA passed, not marked landed', 'bad', `ETA was ${fmtD(i.eta)} · ${i.forwarder || 'no forwarder'}`]);
    if (i.board === 'pos' && i.balanceDue && !i.balancePaid && daysTo(i.balanceDue) <= 7) out.push([i, 'Balance payment due', 'warn', `due ${fmtD(i.balanceDue)} · order value ${fmt$(i.value)}`]);
    if (i.board === 'pos' && i.status === 'review') out.push([i, 'Waiting on review and approval', 'warn', supName(i)]);
    if (i.board === 'research' && i.status === 'approved' && !i.poId) out.push([i, 'Approved, start a PO draft', 'good', supName(i)]);
  });
  return out;
}

// ---- My Work + boot ----
const workList = () => purchasingWork();
function viewMyWork() {
  const list = workList();
  return `<header class="page"><div><p class="eyebrow">${esc(person(S.me).name)} · Purchasing</p><h1>My Work</h1></div>
      <p class="muted" style="max-width:480px;margin:0;font-size:12.5px">This replaces Monday's notifications: the cards that need someone today. The number next to My Work in the menu is this list.</p></header>
    <div class="panel" style="max-width:860px">${list.map(([i, why, cls, extra]) => `<div class="work" data-act="open" data-id="${i.id}" tabindex="0"><span><b>${esc(i.name)}</b><br><span class="muted" style="font-size:12.5px">${esc(extra)}</span></span><span class="chip ${cls}">${why}</span></div>`).join('') || '<p class="muted">Nothing needs you right now.</p>'}</div>`;
}

boot();

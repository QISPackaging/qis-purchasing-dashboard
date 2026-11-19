'use strict';
/* Container Planning: the Forecast and Container tabs (ported from the mockup Liam approved on 18/11/2026).
   One IIFE with its own state object PL. It exposes window.viewPlanning and the ACT.pl* handlers only.
   All data goes through API (window.PL_API when a local test harness supplies one). Reads stock and PO
   status from Unleashed; never writes to Unleashed or to the SharePoint workbooks. */
(() => {
  // ---------- fixed rules ----------
  const CAP = { 20: 30, 40: 60, '2x40': 120 };                 // CBM per container: a planning figure for the 40ft sizes, the confirmed maximum for a 20ft (Liam, 19/11/2026)
  const CAPLBL = { 20: '20ft', 40: '40ft', '2x40': '2 × 40ft' };
  const TIGHT = 1.09;                                          // PO 484 shipped 65.3 CBM in a 40ft planned at 60 (40ft sizes only: a 20ft has no such room)
  const FULL = 1.0001;                                         // 40ft sizes: "over the planning figure" starts here, clear of rounding in the CBM sum
  const EPS = 1e-6;                                            // a 20ft: the 30 CBM figure itself, clear only of float noise in the sum (30.001 CBM does not fit)
  const over20 = (cbm) => cbm > CAP[20] + EPS;
  const fitsIn = (k, cbm) => (k === '20' ? !over20(cbm) : cbm <= CAP[k] * TIGHT);   // a 40ft may run to 109%; a 20ft stops at its 30 CBM
  const capWord = (k) => (k === '20' ? 'maximum' : 'planning figure');
  const TBL_MIN = 240;                                         // the table box is never fitted (or dragged) shorter than this
  const BANDS = [['Top 50%', 'target_top', 12], ['Upper-Bottom 25%', 'target_upper', 8], ['Bottom 25%', 'target_bottom', 6]];
  const BANDF = Object.fromEntries(BANDS.map((b) => [b[0], b[1]]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const UIKEY = 'pd-planning-ui';
  const SAVE_MS = 800, REFOCUS_MS = 30000, USAGE_STALE_MS = 20 * 3600e3, PO_CACHE_MS = 5 * 60e3, STOCK_STALE_MS = 15 * 60e3;
  const REF_STALE_MS = 10 * 60e3, AUTO_RETRY_MS = 3600e3, RETRY_MS = 5000, DRAFTS_MS = 45000;
  const PO_OPEN = ['Parked', 'Open', 'Deleted'], PO_DONE = ['Complete', 'Receipted'];   // not ordered yet / already landed
  const NO_PO_NO = 'PO card, no PO number yet';
  const FX_MIN = 0.4, FX_MAX = 1.1, FRT_LOW = 2000;            // an exchange rate outside this range is a typing slip; freight under this on any container gets a warning
  const OLD_CHUNK_MS = 7 * 86400e3;                            // usage whose oldest month was read longer ago than this says so on the stamp
  const ZERO = { stock: 0, alloc: 0, avail: 0, pack: 0, onPur: 0 };

  const PL = {
    phase: 'idle', error: '', step: '',            // idle | loading | ready | error
    me: null, loadNo: 0, refAt: 0, freshBusy: false, busyPo: false, busyNew: false,
    ref: null, bySku: {}, fam: null, excl: {}, xdrafts: [],   // xdrafts: OTHER suppliers' open drafts (id, name, supplier, manual, lines), for In draft on shared SKUs     // excl: SKU -> the usage-exclusion rules on it (reason + the month each starts)
    today: '', windowFrom: '', fyLabel: '', months: [], part: null,
    usage: {}, hasUsage: false, run: null, fullM: [], fullK: {},   // fullM: the months read in full (the only ones averaged)
    stock: {}, stockAt: null, stockTried: 0, stockBusy: false, stockErr: '',
    drafts: [], draftsFor: null, draftsAt: 0, draftsRead: 0, draftKey: null,
    archived: [],                                  // the supplier's last 10 archived drafts (read-only, can be restored)
    cards: {},                                     // PO card id -> true (a live card) / false (gone), as last read fresh
    cat: null, sup: null,
    tab: 'forecast', show: 'all', q: '', showAll: false,
    rate0: {},                                     // rates as they were when the page opened (for the bold outline, and for a rate cell that is blanked)
    po: {},                                        // PO number -> { info: { status, day } or null, at }
    refresh: { busy: false, text: '', autoAt: 0 },
    fitH: 0,                                       // the table box's height as last fitted to the window (px); 0 = the stylesheet's own limit
    bad: { fx: '', frt: '' },                      // why the exchange rate / freight being typed is not taken (the last good figure stays in use)
    ui: { full: false, h: null, tab: 'forecast', cat: null, sup: null, draft: null, how: false },
  };
  try { Object.assign(PL.ui, JSON.parse(localStorage.getItem(UIKEY) || '{}')); } catch (e) { /* no storage: defaults */ }
  if (PL.ui.tab === 'container') PL.tab = 'container';
  const saveUI = () => { try { localStorage.setItem(UIKEY, JSON.stringify(PL.ui)); } catch (e) { /* ignore */ } };

  // ---------- small helpers ----------
  const el = (id) => document.getElementById(id);
  const n0 = (v) => Math.round(v).toLocaleString('en-AU');
  const n1 = (v) => (Math.round(v * 10) / 10).toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const n2 = (v) => v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qty = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? n0(v) : n1(v));
  const aud = (v) => '$' + n0(v);
  const num = (v) => { const x = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) && x >= 0 ? x : 0; };
  const plainNum = (v) => { const t = String(v).replace(/[$,\s]/g, ''); return /^(\d+\.?\d*|\.\d+)$/.test(t) ? +t : null; };   // money and rates: digits only ("10k", "1e4" and "0,68" are not numbers)
  const blank = (v) => String(v).trim() === '';
  const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((y) => [y, x[y]])) : x));
  const briFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Australia/Brisbane', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const briIso = (ms) => briFmt.format(new Date(ms));                                   // 'YYYY-MM-DD HH:MM' in Brisbane
  const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const stampOf = (ts) => { const ms = typeof ts === 'number' ? ts : Date.parse(ts); if (!Number.isFinite(ms)) return ''; const s = briIso(ms); return `${dmy(s)} ${s.slice(11, 16)}`; };
  const closeP = () => { const p = el('pop'); if (p) p.innerHTML = ''; };

  // ---------- data access (the only door to Supabase and Unleashed) ----------
  const sel = async (q) => { const { data, error } = await q; if (error) throw new Error(error.message); return data; };
  const selAll = async (build) => {                      // PostgREST caps a reply at 1,000 rows
    const out = [];
    for (let from = 0; ; from += 1000) { const rows = await sel(build().range(from, from + 999)); out.push(...rows); if (rows.length < 1000) return out; }
  };
  const parsed = (x) => (typeof x === 'string' ? JSON.parse(x) : x);
  const cardRows = (id) => sel(DB.client.from('pd_items').select('id,name,po_no,archived_at').eq('id', id));   // PO cards are only ever read from this page
  const realApi = {
    now: () => Date.now(),
    async ref() {
      const c = DB.client;
      const [categories, skus, aliases, exclusions] = await Promise.all([
        sel(c.from('pd_cp_categories').select('*').eq('active', true).order('position')),
        selAll(() => c.from('pd_cp_skus').select('*').order('position').order('sku')),   // every row, inactive ones too: the code lookup is built from all of them, as the edge function builds it
        selAll(() => c.from('pd_cp_sku_aliases').select('*').order('code')),
        // the usage exclusions, for the "not counted" line in a month's hover: the reason only, never the customer code
        selAll(() => c.from('pd_cp_usage_exclusions').select('sku,from_month,reason,active').order('sku')),
      ]);
      // Per-supplier carton details (migration 2): a SKU bought from two suppliers shows under both. If the table is not
      // there (migration 2 not run, or rolled back) every SKU stays under the supplier on its own row, as before.
      const links = await selAll(() => c.from('pd_cp_sku_suppliers').select('sku,supplier_id,cbm_per_carton,usd_per_unit,moq_cartons,units_per_ctn,active,extra').order('sku')).catch(() => []);
      return { categories, skus, aliases, exclusions, links };
    },
    async usage(windowFrom) {
      const c = DB.client;
      const [rows, runs] = await Promise.all([
        selAll(() => c.from('pd_cp_usage').select('sku,month,cartons_sold,packs_sold,assembly_used,credits,assembly_wastage,excluded_cartons,excluded_credits,total').gte('month', windowFrom).order('month').order('sku')),
        sel(c.from('pd_cp_usage_runs').select('*').eq('ok', true).order('finished_at', { ascending: false }).limit(1)),
      ]);
      return { rows, run: runs[0] || null };
    },
    async drafts(supplierId) {                               // every supplier's drafts in one read: this supplier's come back, and the other
      const rows = await sel(DB.client.from('pd_cp_drafts').select('*').is('archived_at', null).order('id'));   // suppliers' open drafts ride along as .others (In draft on shared SKUs)
      const own = rows.filter((r) => String(r.supplier_id) === String(supplierId));
      own.others = rows.filter((r) => String(r.supplier_id) !== String(supplierId) && r.kind === 'draft' && !r.ordered_at);
      return own;
    },
    archived: (supplierId) => sel(DB.client.from('pd_cp_drafts').select('*').eq('supplier_id', supplierId).not('archived_at', 'is', null).order('archived_at', { ascending: false }).limit(10)),
    async createDraft(fields) { return (await sel(DB.client.from('pd_cp_drafts').insert(fields).select('*')))[0]; },
    async saveDraft(id, fields, knownUpdatedAt) {         // null = someone else changed it since we read it
      return (await sel(DB.client.from('pd_cp_drafts').update(fields).eq('id', id).eq('updated_at', knownUpdatedAt).select('*')))[0] || null;
    },
    saveSku: (sku, fields) => sel(DB.client.from('pd_cp_skus').update(fields).eq('sku', sku).select('sku')),
    saveCategory: (key, fields) => sel(DB.client.from('pd_cp_categories').update(fields).eq('key', key).select('key')),
    async stock() {                                        // whole stock list (about 1,100 rows, two pages), kept to tracked codes
      const page = (n) => DB.unleashed('get_stock_on_hand', { pageSize: 1000, page: n }).then(parsed);
      // A read is good only when every page carries a list and the same whole-number count, and the different rows
      // read (one per product code, a repeat never added twice) come to that count. Anything else is a failed read.
      const read = async () => {
        const [first, second] = await Promise.all([page(1), page(2).catch((e) => ({ failed: e }))]);
        const pg = (first && first.Pagination) || {}, pages = pg.NumberOfPages || 1, total = pg.NumberOfItems;
        if (pages >= 2 && second && second.failed) throw second.failed;
        const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 2) }, (_, i) => page(i + 3)));
        const rows = new Map(), short = (why) => Object.assign(new Error(`Stock could not be read in full from Unleashed: ${why}.`), { short: true });
        [first, ...(pages >= 2 ? [second] : []), ...rest].forEach((p, i) => {
          if (!p || !Array.isArray(p.Items)) throw short(`page ${i + 1} came back without a list of items`);
          if (!Number.isInteger(total) || (p.Pagination || {}).NumberOfItems !== total) throw short(`page ${i + 1} did not carry the same row count as page 1`);
          p.Items.forEach((x) => { const code = String(x.ProductCode || (x.Product || {}).ProductCode || ''); if (code) rows.set(code, x); });
        });
        if (rows.size !== total) throw short(`${rows.size} of ${total} rows`);
        if (!total) throw short('the list came back empty');   // a list that agrees with itself but holds nothing is not "no stock anywhere"
        return rows;
      };
      let rows;
      try { rows = await read(); } catch (e) { if (!e || !e.short) throw e; rows = await read(); }   // the list can move between two pages read at once: look once more, then it is a failed read
      const items = [];
      rows.forEach((x, code) => {
        if (PL.fam && !PL.fam(code)) return;
        items.push({ code, onHand: +x.QtyOnHand || 0, allocated: +x.AllocatedQty || 0, available: +x.AvailableQty || 0, onPurchase: +x.OnPurchase || 0 });
      });
      return { asAt: new Date().toISOString(), items };
    },
    async poStatus(poNo) {                                 // null = Unleashed has no purchase order with that number
      const res = parsed(await DB.unleashed('list_purchase_orders', { orderNumber: poNo }));
      const po = ((res && res.Items) || [])[0];
      return po ? { status: po.OrderStatus || null, orderDate: po.OrderDate || null, supplierCode: (po.Supplier || {}).SupplierCode || '' } : null;
    },
    async poCard(id) {                                     // the linked PO card as it is now; the card list in QB.items is as at sign-in
      const row = (await cardRows(id))[0];
      return row ? { id: String(row.id), name: row.name || '', poNo: row.po_no || '', archived: !!row.archived_at } : null;
    },
    async refreshStep(body) {
      const { data, error } = await DB.client.functions.invoke('pd-cp-usage', { body });
      if (error) throw new Error(error.message);
      return data;
    },
    async startPoCard(d) {                                 // same pattern as startPo() in purchasing.js
      const s = QB.suppliers.find((x) => String(x.id) === String(d.supplier_id));
      const why = `Started from Container Planning draft "${d.name}". ${d.summary || ''}`.trim();
      const po = createItem('pos', 'po_drafting', { name: `${s ? s.name : 'Container'} — ${d.name}`, supplierId: d.supplier_id || '', nextAction: bizDays(3), notes: why });
      // createItem() sends its insert without waiting for it. The draft's po_item_id (and the update below) point at
      // that row, so read it back (a read only) until it is there before anything is saved against it.
      let there = false;
      for (let i = 0; i < 12 && !there; i += 1) {
        try { there = (await cardRows(po.id)).length > 0; } catch (e) { /* try again */ }
        if (!there) await new Promise((ok) => setTimeout(ok, 300));
      }
      if (!there) throw new Error('the new card did not save');
      addUpdate(po, why);
      return po.id;
    },
  };
  const API = window.PL_API || realApi;
  const nowMs = () => (typeof API.now === 'function' ? API.now() : Date.now());
  // Every stock read comes through here. A reply with no list of rows is a failed read, never "no stock": the caller
  // keeps the last good numbers (or shows the error panel on a first load) rather than suggesting from zero.
  // The same goes for a list that holds none of the tracked products while there are SKUs to show.
  const readStock = async () => {
    const res = await API.stock();
    if (!res || !Array.isArray(res.items)) throw new Error('Stock could not be read from Unleashed: the reply had no list of items.');
    if (PL.ref && PL.ref.skus.some(shown) && !res.items.some((it) => PL.fam(String(it.code || '')))) throw new Error('Stock could not be read from Unleashed: none of the tracked products were in the list.');
    return res;
  };

  // ---------- window and months (from the clock, not constants) ----------
  function setWindow() {
    const t = briIso(nowMs()).slice(0, 10), y = +t.slice(0, 4), m = +t.slice(5, 7), day = +t.slice(8, 10);
    const fy0 = m >= 7 ? y : y - 1;
    const months = [];
    for (let yy = fy0, mm = 7; yy < y || (yy === y && mm <= m); mm === 12 ? (yy += 1, mm = 1) : mm += 1) months.push([`${yy}-${String(mm).padStart(2, '0')}`, MON[mm - 1]]);
    const last = months.pop();
    PL.today = t; PL.windowFrom = `${fy0}-07-01`; PL.fyLabel = 'FY' + String((fy0 + 1) % 100).padStart(2, '0');
    PL.months = months; PL.part = [last[0], day > 1 ? `${last[1]} 1–${day}` : `${last[1]} 1`];
    setFullMonths();
  }
  // A month that has ended on the calendar counts as a full month only once usage has been read AFTER it ended: the
  // last good run finished (Brisbane day) after the month's last day, and its window reached that day. Until then
  // the month is shown muted and left out of the average, like the part month.
  const lastDay = (ym) => `${ym}-${String(new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate()).padStart(2, '0')}`;
  function setFullMonths() {
    const run = PL.run || {}, ms = Date.parse(run.finished_at), done = Number.isFinite(ms) ? briIso(ms).slice(0, 10) : '', to = run.window_to ? String(run.window_to).slice(0, 10) : '';
    PL.fullM = PL.months.filter((m) => { const end = lastDay(m[0]); return done > end && (!to || to >= end); });
    PL.fullK = Object.fromEntries(PL.fullM.map((m) => [m[0], true]));
  }
  const rangeLbl = () => { const f = PL.fullM; return f.length > 1 ? `${f[0][1]}–${f[f.length - 1][1]}` : f.length ? f[0][1] : ''; };

  // ---------- adopting what the API returns ----------
  function adoptRef(ref, again) {                         // again = a refetch while the page is open
    const was = again ? PL.bySku : {}, base = again ? PL.rate0 : {};
    PL.ref = { categories: ref.categories || [], skus: ref.skus || [], aliases: ref.aliases || [], exclusions: ref.exclusions || [] };
    PL.bySku = {}; PL.rate0 = {};
    // Usage exclusions (pd_cp_usage_exclusions): one SKU bought by one customer, not counted from one month on.
    // The numbers themselves come out of the usage rebuild; this is only so a month cell can say why.
    PL.excl = {};
    PL.ref.exclusions.forEach((x) => {
      if (!x || x.active === false || !x.sku) return;
      (PL.excl[x.sku] = PL.excl[x.sku] || []).push({ from: String(x.from_month || '').slice(0, 7), reason: String(x.reason || '') });
    });
    PL.ref.skus.forEach((r) => {
      r.rate = +r.rate || 0; PL.bySku[r.sku] = r;
      PL.rate0[r.sku] = was[r.sku] && was[r.sku].rate === r.rate && base[r.sku] != null ? base[r.sku] : r.rate;   // someone else's change becomes the new starting rate
    });
    // family(code): exact SKU = one carton; alias = pack at its factor; else longest tracked SKU prefix + digits = pack of that many units
    const tracked = Object.keys(PL.bySku).sort((a, b) => b.length - a.length), alias = {};
    PL.ref.aliases.forEach((a) => { if (PL.bySku[a.sku]) alias[a.code] = a; });
    PL.fam = (code) => {
      if (PL.bySku[code]) return [code, 'base', 1];
      if (alias[code]) return [alias[code].sku, 'pack', +alias[code].factor || 0];
      const b = tracked.find((t) => code.startsWith(t)); if (!b) return null;
      const rest = code.slice(b.length);
      return /^\d+$/.test(rest) ? [b, 'pack', +rest / PL.bySku[b].carton_qty] : null;
    };
    // One row per (SKU, supplier) from pd_cp_sku_suppliers. Each row reads the product (rate, band, description, carton
    // size) from the one SKU row underneath it, so a rate typed under one supplier is the rate under the other too, and
    // carries only its supplier's own carton details. A SKU with no supplier rows stays as it was.
    const by = {};
    (ref.links || []).forEach((l) => { if (l && l.active !== false && PL.bySku[l.sku] && l.supplier_id) (by[l.sku] = by[l.sku] || []).push(l); });
    PL.multi = {};
    PL.ref.skus = PL.ref.skus.flatMap((b) => {
      const ls = by[b.sku]; if (!ls) return [b];
      if (ls.length > 1) PL.multi[b.sku] = ls.map((l) => String(l.supplier_id));
      return ls.map((l) => {
        const x = Object.create(b), ex = l.extra || {};
        x.supplier_id = String(l.supplier_id); x.cbm_per_carton = +l.cbm_per_carton || 0;
        x.usd_per_unit = l.usd_per_unit == null ? null : +l.usd_per_unit; x.moq_cartons = l.moq_cartons == null ? null : +l.moq_cartons;
        x.units_per_ctn = +l.units_per_ctn > 0 ? +l.units_per_ctn : 1; x.no_details = !!ex.no_details || !(+l.cbm_per_carton > 0);
        return x;
      });
    });
  }
  function adoptUsage(u) {
    const map = {}; const rows = (u && u.rows) || [];
    rows.forEach((x) => { (map[x.sku] = map[x.sku] || {})[String(x.month).slice(0, 7)] = x; });
    PL.usage = map; PL.hasUsage = rows.length > 0; PL.run = (u && u.run) || null;
    setFullMonths();
  }
  function adoptStock(res) {
    const st = {};
    ((res && res.items) || []).forEach((it) => {
      const f = PL.fam(String(it.code || '')); if (!f) return;
      const s = st[f[0]] || (st[f[0]] = { ...ZERO });
      if (f[1] === 'base') { s.row = true; s.stock += +it.onHand || 0; s.alloc += +it.allocated || 0; s.avail += +it.available || 0; s.onPur += +it.onPurchase || 0; }
      else s.pack += (+it.available || 0) * f[2];
    });
    PL.stock = st; PL.stockAt = (res && res.asAt) || null; PL.stockErr = '';
  }
  // The size a typed freight figure was typed for. It is kept in the draft's extra (frtFor) so every sign-in sees the
  // same "check it" chip; _frtFor is this session's value until the next save has carried it.
  const frtForOf = (d) => (d._frtFor !== undefined ? d._frtFor : (d.extra || {}).frtFor) || null;
  const frtTag = (d) => { const f = frtForOf(d); return f ? '|freight typed for ' + f : ''; };
  const draftSnap = (d) => canon({ name: d.name, container: d.container, fx: d.fx, freight: d.freight, freight_typed: !!d.freight_typed, manual: d.manual, lines: d.lines }) + frtTag(d);
  function normDraft(row) {
    const d = { ...row, kind: row.kind || 'draft', manual: { ...(row.manual || {}) }, lines: { ...(row.lines || {}) }, extra: row.extra || {},
      fx: +row.fx > 0 ? +row.fx : 0.68, freight: row.freight == null ? null : +row.freight, freight_typed: !!row.freight_typed, container: CAP[row.container] ? String(row.container) : null };
    d._saved = draftSnap(d);
    return d;
  }
  function adoptDrafts(rows, sup) {
    if (rows && Array.isArray(rows.others)) PL.xdrafts = rows.others.filter((r) => r && r.kind === 'draft' && !r.ordered_at && !r.archived_at)
      .map((r) => ({ id: r.id, name: String(r.name || ''), supplier_id: String(r.supplier_id), manual: parsed(r.manual) || {}, lines: parsed(r.lines) || {} }));
    const old = PL.draftsFor === sup ? PL.drafts : [];
    const byId = {}; old.forEach((d) => { if (d.id != null) byId[d.id] = d; });
    const next = (rows || []).filter((r) => !r.archived_at).map((row) => {
      const o = byId[row.id];
      if (o && !o._stale && (o._t || o._busy || o._fails)) return o;   // our own unsaved typing (or a save still being retried): keep it, the save settles it
      const d = normDraft(row); if (o) { d._link = o._link; d._hold = o._hold; d._po = o._po; d._shown = o._shown; }   // what the last PO check found stays on show until the next one
      // A saved row that still has no size (its first save never landed): the size this screen picked for it stays,
      // so a background read cannot flip it between sizes (and freight figures) as stock moves. The next edit saves it.
      if (o && !d.container && CAP[o.container] && isOpenDraft(d) && isOpenDraft(o)) { d.container = o.container; if (!d.freight_typed) d.freight = o.freight; }
      return d;
    });
    const local = old.find((d) => d.id == null);
    if (local && (local._touched || !next.some(isOpenDraft))) next.push(local);
    PL.drafts = next; PL.draftsFor = sup;
  }
  // The Archived group: the last 10 from the API. Without that call (or when it fails) the list keeps what this
  // session archived itself, less anything that has since come back.
  const archivedRows = (sup) => (typeof API.archived === 'function' ? Promise.resolve().then(() => API.archived(sup)).catch(() => null) : Promise.resolve(null));
  function adoptArchived(rows) {
    const back = (d) => PL.drafts.some((x) => x.id === d.id);
    PL.archived = (rows ? rows.filter((r) => r.archived_at).slice(0, 10).map(normDraft) : PL.archived).filter((d) => !back(d));
  }

  // ---------- context: category, supplier, draft ----------
  const catOf = (key) => PL.ref.categories.find((c) => c.key === key);
  const shown = (r) => r.active !== false;                // an inactive SKU stays in the code lookup (so its codes are never read as packs of a shorter SKU) and is only hidden on screen
  const supsOf = (cat) => [...new Set(PL.ref.skus.filter((r) => shown(r) && r.category_key === cat && r.supplier_id).map((r) => String(r.supplier_id)))];
  const supName = (id) => { const s = (QB.suppliers || []).find((x) => String(x.id) === String(id)); return s ? s.name : String(id); };
  const supSkus = () => PL.ref.skus.filter((r) => shown(r) && String(r.supplier_id) === PL.sup);                       // the container belongs to the supplier
  const catSkus = () => PL.ref.skus.filter((r) => shown(r) && String(r.supplier_id) === PL.sup && r.category_key === PL.cat);   // the forecast belongs to the category
  const keyOf = (d) => (d.id == null ? 'new' : String(d.id));
  const isOpenDraft = (d) => d.kind === 'draft' && !d.ordered_at && !d.archived_at;
  const cur = () => PL.drafts.find((d) => keyOf(d) === PL.draftKey) || PL.archived.find((d) => keyOf(d) === PL.draftKey) || null;
  const isHist = () => { const d = cur(); return !d || !isOpenDraft(d); };
  function pickContext() {
    const cats = PL.ref.categories;
    PL.cat = (cats.find((c) => c.key === PL.ui.cat) || cats[0] || {}).key || null;
    const sups = supsOf(PL.cat);
    PL.sup = sups.includes(String(PL.ui.sup)) ? String(PL.ui.sup) : sups[0] || null;
  }
  function localDraft() {
    const cat = catOf(PL.cat) || {}, n = PL.drafts.filter((d) => d.kind === 'draft').length + 1;
    return { id: null, kind: 'draft', name: `Draft ${n} · started ${dmy(PL.today)}`, category_key: PL.cat, supplier_id: PL.sup, container: null,
      fx: +cat.default_fx > 0 ? +cat.default_fx : 0.68, freight: cat.freight_40 == null ? 0 : +cat.freight_40, freight_typed: false,
      manual: {}, lines: {}, po_item_id: null, po_no: '', ordered_at: null, notes: '', extra: {}, archived_at: null };
  }
  function pickDraft() {
    if (!PL.sup) { PL.draftKey = null; return; }
    if (!PL.drafts.some(isOpenDraft)) PL.drafts.push(localDraft());
    let d = cur();
    if (!d) { d = PL.drafts.find((x) => keyOf(x) === String(PL.ui.draft)) || PL.drafts.find(isOpenDraft); PL.draftKey = keyOf(d); }
    if (isOpenDraft(d) && !CAP[d.container]) autoContainer(d);
  }
  function stashCurrent() {                                // leaving a draft: anything typed and not yet sent goes now
    const d = cur(); if (d && isOpenDraft(d) && d._t) saveDraft(d);   // its cartons are not written again just for being looked at (no write wars)
  }
  function openDraft(key) {
    stashCurrent();
    PL.draftKey = key; PL.ui.draft = key; saveUI();
    const d = cur(); if (d && isOpenDraft(d) && !CAP[d.container]) autoContainer(d);
  }

  // ---------- the maths (same rules as the forecasting and balancing sheets) ----------
  const stk = (r) => PL.stock[r.sku] || ZERO;
  const noRow = (r) => !!PL.stockAt && !stk(r).row;       // a count-checked read with no row for this code: a line that has never had stock. It is counted as 0, and says so.
  const useRow = (r, key) => (PL.usage[r.sku] || {})[key];
  const useTotal = (x) => (!x ? 0 : x.total != null ? +x.total : Math.max(0, (+x.cartons_sold || 0) + (+x.packs_sold || 0) + (+x.assembly_used || 0) - (+x.credits || 0)));
  const targetOf = (r) => { const c = catOf(r.category_key), f = BANDF[r.band]; return c && f && c[f] != null ? +c[f] : null; };
  const rateOf = (r) => +r.rate || 0;
  const haveOf = (r) => { const s = stk(r); return s.avail + s.pack + s.onPur; };
  // A SKU bought from two suppliers: its suggestion belongs to its main supplier (the supplier on its own row, the one
  // it was last bought from); under the other supplier it only takes typed numbers. Cartons on the other suppliers'
  // open drafts count as In draft on both sides: typed numbers always, and the main supplier's untyped cartons as saved.
  const homeOf = (r) => String((PL.bySku[r.sku] || r).supplier_id || '');
  const isHome = (r) => !PL.multi || !PL.multi[r.sku] || String(r.supplier_id) === homeOf(r);
  const xParts = (r) => (PL.multi && PL.multi[r.sku] ? PL.xdrafts : []).map((d) => {
    const typed = d.manual[r.sku] != null, n = typed ? +d.manual[r.sku] || 0 : String(d.supplier_id) === homeOf(r) ? +d.lines[r.sku] || 0 : 0;
    return [supName(d.supplier_id) + ' · ' + d.name, n, typed];
  }).filter((x) => x[1] > 0);
  const xTyped = (r) => xParts(r).reduce((t, x) => t + (x[2] ? x[1] : 0), 0);
  // One number for every line nobody has typed, the same on every screen. What a SKU still needs (target × rate, less
  // stock, on order and every carton TYPED on the supplier's open drafts) belongs to the OLDEST open draft that has
  // not typed that SKU. It is worked out from stock, rates and typed numbers only, never from another open draft's
  // saved lines, so two screens can never both add a need or both drop it.
  const openDrafts = () => PL.drafts.filter(isOpenDraft).sort((a, b) => (a.id == null) - (b.id == null) || a.id - b.id);   // oldest first; a draft not saved yet is the newest
  function needOf(r, not) {                               // [cartons to suggest, cartons the skip rule left off]; not = a draft whose own typed number is left out (what it would get by not typing)
    const target = targetOf(r);
    if (r.excluded || target == null || !isHome(r)) return [0, 0];
    const rate = rateOf(r); if (!(rate > 0)) return [0, 0];
    const typed = PL.drafts.reduce((t, d) => t + (d !== not && isOpenDraft(d) && d.manual[r.sku] != null ? +d.manual[r.sku] || 0 : 0), 0) + xTyped(r);
    const have = haveOf(r) + typed, need = target * rate - have;
    if (need <= 0) return [0, 0];
    if (typed > 0 && need < 0.5) return [0, 0];           // cartons already typed for it: what is left is only the rounding of that number, not a carton for the next draft
    const q = Math.max(1, Math.round(need));
    return have / rate >= 3 && q / rate < 2 ? [0, q] : [q, 0];   // would add under 2 months and the line is not short: leave it off (kept on show, greyed, as a fill candidate)
  }
  const unclaimed = (r, not) => needOf(r, not)[0];
  const claimer = (r, not) => openDrafts().find((d) => d === not || d.manual[r.sku] == null) || null;
  function cartonsOf(d, r) {                              // one draft's cartons of one SKU
    if (!isOpenDraft(d)) return +(d.lines || {})[r.sku] || 0;          // ordered, past and archived drafts: as saved
    if (r.excluded) return 0;
    if (d.manual[r.sku] != null) return +d.manual[r.sku] || 0;
    if (!PL.stockAt) return +(d.lines || {})[r.sku] || 0;              // no stock read to work from: the saved copy
    return claimer(r) === d ? unclaimed(r) : 0;
  }
  // In draft: cartons on the supplier's OTHER drafts that are not yet a placed PO. Ordered drafts count under On order (Unleashed), never both.
  function draftParts(r) {
    const d0 = cur();
    return openDrafts().filter((d) => d !== d0 && (d.id != null || d._touched)).map((d) => [d.name + (d._link ? ' · ' + d._link : ''), cartonsOf(d, r)]).filter((x) => x[1] > 0)
      .concat(xParts(r).map((x) => [x[0], x[1]]));
  }
  const draftOf = (r) => draftParts(r).reduce((t, x) => t + x[1], 0);
  function suggest(r) {                                   // what the open draft gets on a line it has not typed
    const d = cur();
    return d && isOpenDraft(d) && PL.stockAt && claimer(r, d) === d ? unclaimed(r, d) : 0;
  }
  function skipOf(r) {                                    // the need the skip rule left off the open draft: shown greyed beside Suggested, never ordered, never in a total
    const d = cur();
    return d && isOpenDraft(d) && PL.stockAt && claimer(r, d) === d ? needOf(r, d)[1] : 0;
  }
  // On a line the open draft has typed, Suggested is what it would get by clearing its number. A newer draft may be
  // holding some of those cartons meanwhile (they are under In draft on the same row): the cell says so on hover.
  function heldTip(r) {
    const d = cur(); if (!d || !isOpenDraft(d) || d.manual[r.sku] == null) return '';
    const o = claimer(r); if (!o || o === d || (o.id == null && !o._touched)) return '';
    const n = cartonsOf(o, r);
    return n > 0 ? `What this draft would get if you cleared your number. ${n0(n)} of these ${n === 1 ? 'is' : 'are'} sitting on ${o.name} now, and counted under In draft.` : '';
  }
  function orderOf(r) { const d = cur(); return d ? cartonsOf(d, r) : 0; }
  function calc(r) {
    const hist = isHist(), rate = rateOf(r), have = haveOf(r), order = orderOf(r), s = stk(r);
    const now = rate > 0 ? have / rate : null;
    const added = !hist && rate > 0 ? order / rate : null;
    const inDraft = draftOf(r);
    const after = !hist && rate > 0 ? (have + inDraft + order) / rate : null;
    // Over 15 months only when the order is more than half a carton past the 15-month quantity, so rounding
    // Suggested to whole cartons at a 15-month target cannot raise it by itself. The Months after colour follows it.
    // One carton against a need that is still there is the smallest order there is, so it is never flagged either.
    const room = 15 * rate - have - inDraft;
    const over = !hist && order > 0 && rate > 0 && order - room > 0.5 + 1e-6 && !(order === 1 && room > 0);
    const flags = [];
    if (r.excluded) flags.push(['plain', r.excluded]);
    if (!hist) {
      if (s.avail < 0) flags.push(['bad', 'Oversold by ' + qty(-s.avail)]);
      if (!r.excluded && now != null && now < 3) flags.push(['bad', 'Under 3 months']);
      // No rate: cover cannot be worked out, so the month flags above and below are silent. Needs a look when
      // something rides on it (cartons on the order, or usage this year); otherwise it is only labelled.
      if (!r.excluded && !(rate > 0)) flags.push([order > 0 || fy(r) > 0 ? 'warn' : 'plain', 'No rate']);
      if (!r.excluded && noRow(r)) flags.push(['warn', 'No stock row in Unleashed']);   // counted as 0 and still suggested, so it needs a look
      if (order > 0 && r.moq_cartons && order < r.moq_cartons) flags.push(['warn', 'Under MOQ ' + r.moq_cartons]);
      if (r.no_details) flags.push([order > 0 ? 'warn' : 'plain', 'No carton details']);   // no CBM on record for this supplier: the container meter counts it as 0
      if (order > 0 && r.units_per_ctn > 1 && Math.abs(order / r.units_per_ctn - Math.round(order / r.units_per_ctn)) > 1e-9) flags.push(['plain', `Not whole ${supName(r.supplier_id)} cartons (${n0(r.units_per_ctn)} per carton)`]);
      if (PL.multi && PL.multi[r.sku]) flags.push(['plain', isHome(r) ? 'Also from ' + PL.multi[r.sku].filter((s) => s !== String(r.supplier_id)).map(supName).join(', ') : 'Suggested on ' + supName(homeOf(r)) + ' drafts']);
      if (over) flags.push(['warn', 'Over 15 months']);
      if (order > 0 && added != null && added < 2 && now >= 3) flags.push(['plain', 'Adds under 2 months']);
    }
    return { rate, have, inDraft, order, now, added, after, over, flags, cbm: order * (+r.cbm_per_carton || 0), sug: hist ? 0 : suggest(r), skip: hist ? 0 : skipOf(r) };
  }
  function fy(r) {                                        // average of the months read in full, from the unrounded numbers
    if (!PL.fullM.length || !PL.hasUsage) return null;
    return PL.fullM.reduce((t, m) => t + useTotal(useRow(r, m[0])), 0) / PL.fullM.length;
  }
  const farOff = (d, rate) => Math.abs(d) >= 2 && Math.abs(d) >= 0.3 * Math.max(rate, 0.01);
  function drift(r) {                                     // this year's average is well away from the rate in use
    const f = fy(r), rate = rateOf(r); if (f == null || isHist() || r.excluded) return 0;
    return farOff(f - rate, rate) ? Math.sign(f - rate) : 0;
  }
  function driftTip(r, dr) {                              // the arrow's tooltip: how many months are behind it, and whether it is one spike
    const rate = rateOf(r), v = PL.fullM.map((m) => useTotal(useRow(r, m[0]))), n = v.filter((x) => Math.sign(x - rate) === dr && farOff(x - rate, rate)).length;   // months that would trip the arrow by themselves
    const w = [...v].sort((a, b) => a - b), mid = w.length % 2 ? w[(w.length - 1) / 2] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2;
    const steady = Math.sign(mid - rate) === dr && farOff(mid - rate, rate);       // would the middle month trip the arrow by itself?
    return `${rangeLbl()} average is ${n1(fy(r))} a month, against a rate of ${qty(rate)} · ${n} of ${v.length} full month${v.length === 1 ? '' : 's'} well ${dr > 0 ? 'above' : 'below'} the rate${steady ? '' : n === 1 ? ' · one month only' : ' · the middle month is close to the rate'}`;
  }
  // The freight figure a draft works from. An open draft with nothing typed follows the default for its size (so a
  // 20ft saved before its category had a 20ft figure, or still holding the last size's figure, shows the 20ft default);
  // a typed figure, and anything ordered, archived or past, is what the row holds.
  const frtOf = (d) => {
    if (d.kind === 'draft' && isOpenDraft(d) && !d.freight_typed) { const f = frtDefault(d, d.container); if (f != null) return f; }
    return d.freight == null ? null : +d.freight;
  };
  // No freight figure: the draft's size has no default freight and nothing has been typed. Freight, landed and GP%
  // then show a dash; they are never built on the last size's figure or on zero. (Open drafts only: an ordered or
  // archived copy shows the figure its row holds, whatever the category's defaults are today.)
  const noFreight = (d) => frtOf(d) == null || (isOpenDraft(d) && !d.freight_typed && frtDefault(d, d.container) == null);
  // What the row itself should hold, so that its ordered or archived copy reads as the open draft did: the typed
  // figure, else the figure on screen (the default for its size; nothing where the size has no default).
  const frtHeld = (d) => (d.freight_typed ? d.freight : noFreight(d) ? null : frtOf(d));
  function cont() {
    const d = cur() || {}, fx = +d.fx || 0, noFrt = noFreight(d), freight = noFrt ? 0 : frtOf(d) || 0, cap = CAP[d.container] || 0;
    let cbm = 0, ctns = 0, usd = 0, lines = 0, flagged = 0;
    supSkus().forEach((r) => {
      const c = calc(r);
      if (c.order > 0) { cbm += c.cbm; ctns += c.order; usd += c.order * (+r.usd_per_unit || 0) * r.carton_qty; lines += 1; }
      if (c.flags.some((f) => f[0] !== 'plain')) flagged += 1;
    });
    return { fx, freight, noFrt, cap, cbm, ctns, usd, lines, flagged, goods: fx > 0 ? usd / fx : 0 };
  }
  function lineCost(r, t) {
    const usdCtn = (+r.usd_per_unit || 0) * r.carton_qty, audCtn = t.fx > 0 ? usdCtn / t.fx : 0;
    const frtCtn = t.cbm > 0 ? (t.freight / t.cbm) * (+r.cbm_per_carton || 0) : 0, landed = audCtn + frtCtn;
    return { usdCtn, audCtn, frtCtn, landed, gp: r.rrp ? 1 - landed / r.rrp : null };
  }
  function frtDefault(d, c) {
    const cat = catOf(d.category_key) || {}, v = { 20: cat.freight_20, 40: cat.freight_40, '2x40': cat.freight_2x40 }[c];
    return v == null ? null : +v;
  }
  function autoContainer(d) {                             // d is the open draft: the first size pick on a new or reset draft
    const cbm = supSkus().reduce((t, r) => t + orderOf(r) * (+r.cbm_per_carton || 0), 0);
    // A 20ft only when there are cartons to load, they are within its 30 CBM maximum and the category has a 20ft freight
    // figure. Everything else is as it always was: a 40ft up to 109%, else 2 × 40ft (an empty draft starts on a 40ft).
    d.container = cbm > 0 && fitsIn('20', cbm) && frtDefault(d, '20') != null ? '20' : fitsIn('40', cbm) ? '40' : '2x40';
    if (!d.freight_typed) { const f = frtDefault(d, d.container); if (f != null) d.freight = f; }
  }
  function linesOf() { const out = {}; supSkus().forEach((r) => { const q = orderOf(r); if (q > 0) out[r.sku] = q; }); return out; }
  function typedOver(base, d) {                           // a copy of saved lines with the draft's typed numbers laid over it (a typed number always wins)
    const out = { ...(base || {}) };
    Object.keys(d.manual).forEach((k) => { const q = (PL.bySku[k] || {}).excluded ? 0 : +d.manual[k] || 0; if (q > 0) out[k] = q; else delete out[k]; });
    return out;
  }

  // ---------- saving (drafts autosave with an updated_at check; rates and targets save on a short delay) ----------
  const live = () => !!S.authed && PL.phase === 'ready';
  const timers = {};                                      // key -> { fn, what, t, fails }; t is 0 while that save is on its way
  async function fireTimer(key) {
    const x = timers[key]; if (!x) return;
    clearTimeout(x.t);
    if (!S.authed) { x.t = setTimeout(() => fireTimer(key), RETRY_MS); return; }   // signed out: hold it, as draft edits are held
    x.t = 0;
    if (S.me === PL.me) {
      try { await x.fn(); } catch (e) {                   // keep the edit and keep trying (5 s, 10 s, ... up to a minute apart), as draft saves do
        if (timers[key] !== x) return;                    // typed again meanwhile: that newer save carries the value
        if (!x.fails) toast(`Couldn't save ${x.what}. It will keep trying; check your connection. (${(e && e.message) || e})`);
        x.fails = (x.fails || 0) + 1;
        x.t = setTimeout(() => fireTimer(key), Math.min(60000, RETRY_MS * 2 ** (x.fails - 1)));
        return;
      }
    }
    if (timers[key] === x) delete timers[key];
  }
  const later = (key, what, fn) => { if (timers[key]) clearTimeout(timers[key].t); timers[key] = { fn, what, t: setTimeout(() => fireTimer(key), SAVE_MS) }; };
  const saveRate = (sku) => later('r:' + sku, `the rate for ${sku}`, async () => API.saveSku(sku, { rate: PL.bySku[sku].rate }));   // the value is read when the save is sent, so a retry sends the latest
  const saveTarget = (key, f) => later(`t:${key}:${f}`, 'the target months', async () => API.saveCategory(key, { [f]: catOf(key)[f] }));
  const stateOf = (d) => (!d ? '' : !isOpenDraft(d) ? 'Read-only' : d._heldAt ? 'PO placed: read-only once stock is read' : d._busy ? 'Saving…' : d._fails ? 'Not saved — retrying' : d._t ? 'Unsaved changes' : d.id == null ? 'Not saved yet' : 'Saved');
  // The open draft follows Suggested on the lines nobody typed, so stock, a rate or another draft can move its cartons
  // after it was saved. Nothing is written for that (two screens would keep overwriting each other); the label says so.
  function movedOf(d) {
    if (!d || d !== cur() || !isOpenDraft(d) || d.id == null) return null;
    const now = linesOf(), was = d.lines || {}, list = []; let ctns = 0, cbm = 0;
    supSkus().forEach((r) => {
      const a = +was[r.sku] || 0, b = now[r.sku] || 0; if (a === b) return;
      list.push([r.sku, a, b]); ctns += b - a; cbm += (b - a) * (+r.cbm_per_carton || 0);
    });
    return list.length ? { list, ctns, cbm } : null;
  }
  const signed = (v, f) => (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v));
  function savedHtml(d) {
    const s = stateOf(d), m = s === 'Saved' ? movedOf(d) : null; if (!m) return s;
    const ms = Date.parse(d.updated_at), on = Number.isFinite(ms) ? ' ' + dmy(briIso(ms)).slice(0, 5) : '';
    return `Saved${on} · <button type="button" class="pl-moved" data-act="plmoved" title="Stock, a rate or another draft has moved since this draft was saved. Click to see the lines.">since then ${signed(m.ctns, n0)} cartons, ${signed(m.cbm, n1)} CBM on ${m.list.length} line${m.list.length === 1 ? '' : 's'}</button>`;
  }
  function setSaved() { const s = el('pl-saved'); if (s) s.innerHTML = savedHtml(cur()) || 'Read-only'; }
  function touch(user) {                                  // something on the open draft may have changed: save shortly
    const d = cur(); if (!d || !isOpenDraft(d)) return;
    if (user) { d._touched = true; d.freight = frtHeld(d); }   // an edit also settles a freight figure the row held from before (see frtOf)
    if (d.id == null && !d._touched) return;              // an untouched new draft is not written just for looking at it
    clearTimeout(d._t); d._t = setTimeout(() => { d._t = null; saveDraft(d); }, SAVE_MS);
    setSaved();
  }
  function saveDraft(d, force, extra) {
    if (!d || d.kind !== 'draft') return Promise.resolve(false);
    clearTimeout(d._t); d._t = null;
    if (d._heldAt) {                                      // another sign-in has seen this draft's PO placed; it is only waiting here for a stock read. Nothing more is written to it.
      if (!d._heldSaid) { d._heldSaid = true; toast(`${d.name} has been ordered (seen from another sign-in). It turns read-only here as soon as stock can be read; changes made now are not saved.`); }
      setSaved(); return Promise.resolve(false);
    }
    if (!S.authed || S.me !== PL.me) {                    // signed out: hold the edit and look again shortly; a different person signed in: it is not theirs to save
      if (!S.authed) d._t = setTimeout(() => { d._t = null; saveDraft(d); }, RETRY_MS);
      return Promise.resolve(false);
    }
    if (d._pend) extra = { ...d._pend, ...(extra || {}) };   // fields a failed save still owes (the PO card link, the ordered stamp)
    // Whatever writes an open draft's row (an edit, Save draft, Start a PO card) writes the freight figure the screen
    // is working from, so the row never keeps a figure from before its size or its category's default changed (see frtOf).
    if (isOpenDraft(d) && CAP[d.container]) d.freight = frtHeld(d);
    // The saved copy of the cartons: as on screen for the open draft; for an open draft that is not on screen (a save
    // retried after moving to another draft) the copy it had, with its typed numbers laid over it so the two never disagree.
    const fields = { name: d.name, container: d.container, fx: d.fx, freight: d.freight, freight_typed: !!d.freight_typed, manual: { ...d.manual }, lines: !isOpenDraft(d) ? { ...d.lines } : d === cur() ? linesOf() : typedOver(d.lines, d) };
    let snap = canon(fields) + frtTag(d);
    // "nothing changed" is judged against the save already on its way, if there is one, not the last one that landed
    if (!force && !extra && (d.id != null || d._queued != null) && snap === (d._queued != null ? d._queued : d._saved)) { if (!d._busy) d._fails = 0; setSaved(); return d._chain || Promise.resolve(true); }
    d._busy = (d._busy || 0) + 1; d._queued = snap; setSaved();
    const run = async () => {
      // The size a typed freight was typed for rides in extra. It is merged in as the save is sent (not when it was
      // queued), so a "Yes, this is the PO" saved just before it is never written over.
      const exOf = () => (d._frtFor !== undefined && d._frtFor !== ((d.extra || {}).frtFor || null) ? { extra: { ...(d.extra || {}), frtFor: d._frtFor } } : null);
      let ex = exOf();
      try {
        if (d.id == null) {
          const name = await freeName(d.name, d.supplier_id);   // two sign-ins can each start from the same "Draft 1" placeholder
          if (name !== d.name) { const was = snap; d.name = name; fields.name = name; snap = canon(fields) + frtTag(d); if (d._queued === was) d._queued = snap; }
          const row = await API.createDraft({ kind: 'draft', category_key: d.category_key, supplier_id: d.supplier_id, ...fields, ...(ex || {}), ...(extra || {}) });
          const wasOpen = cur() === d;
          Object.assign(d, { id: row.id, updated_at: row.updated_at, created_at: row.created_at });
          if (wasOpen) {
            PL.draftKey = keyOf(d); PL.ui.draft = PL.draftKey; saveUI();
            const o = document.querySelector('#pl-sel-draft option[value="new"]'); if (o) { o.value = PL.draftKey; o.textContent = d.name; }
          }
        } else {
          let row = await API.saveDraft(d.id, { ...fields, ...(ex || {}), ...(extra || {}) }, d.updated_at);
          if (!row) {
            // Refused: the row has changed since it was read. Every open tab copies a PO number it sees on the linked
            // card onto the draft, which moves updated_at too. If that is all that moved, nobody touched the cartons:
            // take the row's time and its link, and send this save once more.
            const now = await linkOnly(d);
            if (now) {
              d.updated_at = now.updated_at; d.extra = now.extra || {};
              if (!extra || !('po_no' in extra)) d.po_no = now.po_no || '';
              if (!extra || !('po_item_id' in extra)) d.po_item_id = now.po_item_id == null ? null : now.po_item_id;
              ex = exOf();
              row = await API.saveDraft(d.id, { ...fields, ...(ex || {}), ...(extra || {}) }, d.updated_at);
            }
          }
          if (!row) { d._stale = true; d._fails = 0; d._pend = null; toast('Changed by someone else — reloaded'); reloadDrafts(true); return false; }
          d.updated_at = row.updated_at;
        }
        d._saved = snap; d.lines = fields.lines; Object.assign(d, ex || {}, extra || {}); d._fails = 0; d._pend = null;
        if (ex && d._frtFor === ex.extra.frtFor) delete d._frtFor;
        return true;
      } catch (e) {                                       // keep the edit and keep trying (5 s, 10 s, ... up to a minute apart); the label says so
        if (extra) d._pend = { ...(d._pend || {}), ...extra };
        d._queued = null;
        if (!d._fails) toast(`Couldn't save the draft. It will keep trying; check your connection. (${e.message})`);
        d._fails = (d._fails || 0) + 1;
        if (!d._t && !d._stale) d._t = setTimeout(() => { d._t = null; saveDraft(d); }, Math.min(60000, RETRY_MS * 2 ** (d._fails - 1)));
        return false;
      } finally { d._busy -= 1; if (!d._busy) d._queued = null; setSaved(); }
    };
    d._chain = (d._chain || Promise.resolve()).then(run);
    return d._chain;
  }
  function patchDraft(d, fields) {                        // a field or two on the saved row (the PO number seen on its card), never its cartons
    d._busy = (d._busy || 0) + 1;                         // so a re-read under way does not swap this draft out from under the write
    d._chain = (d._chain || Promise.resolve()).then(async () => {
      try {
        if (d.id == null || !S.authed || S.me !== PL.me) return false;
        if (Object.keys(fields).every((k) => canon(d[k]) === canon(fields[k]))) return true;
        const row = await API.saveDraft(d.id, fields, d.updated_at);
        if (!row) return false;                           // changed by someone else: their version comes with the next re-read
        Object.assign(d, fields); d.updated_at = row.updated_at;
        return true;
      } catch (e) { return false; } finally { d._busy -= 1; setSaved(); }
    });
    return d._chain;
  }
  // The saved row as it is now, when its cartons and settings are still exactly what this session last saw, it is
  // still an open draft and it is not linked to a PO card this session does not know of. Otherwise null (someone
  // else's edit: theirs is taken on).
  async function linkOnly(d) {
    try {
      const now = (await API.drafts(d.supplier_id)).find((x) => x.id === d.id);
      if (!now || (now.kind || 'draft') !== 'draft' || now.ordered_at || now.archived_at) return null;
      if (now.po_item_id != null && String(now.po_item_id) !== String(d.po_item_id)) return null;
      return draftSnap(normDraft(now)) === d._saved ? now : null;
    } catch (e) { return null; }
  }
  // "Draft N · started DD/MM/YYYY" is numbered from the drafts this screen knows of. Another sign-in may have saved a
  // draft with the same name since, so the name is settled as the draft is first saved, against the drafts that
  // exist by then. A name someone has typed is left alone.
  async function freeName(name, sup) {
    if (!/^Draft \d+ · started /.test(name)) return name;
    try {
      const rows = await API.drafts(sup), has = (n) => rows.some((x) => x.name === n);
      if (!has(name)) return name;
      const tail = name.replace(/^Draft \d+/, ''); let n = rows.filter((x) => (x.kind || 'draft') === 'draft').length + 1;
      while (has(`Draft ${n}${tail}`)) n += 1;
      return `Draft ${n}${tail}`;
    } catch (e) { return name; }
  }
  function flushAll() {                                   // send anything still waiting on its short delay, now
    PL.drafts.forEach((d) => { if (d._t) saveDraft(d); });
    Object.keys(timers).forEach((k) => { if (timers[k].t) fireTimer(k); });
  }
  const plain = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => k[0] !== '_'));

  // ---------- loading ----------
  function softStep(text) { PL.step = text; const s = el('pl-step'); if (s) s.textContent = text; }
  async function load() {
    const run = (PL.loadNo += 1);
    PL.phase = 'loading'; PL.error = ''; PL.me = S.me;
    try {
      setWindow();
      softStep('Loading the forecast set-up and usage…');
      const [ref, usage] = await Promise.all([API.ref(), API.usage(PL.windowFrom)]);
      if (run !== PL.loadNo) return;
      adoptRef(ref); adoptUsage(usage); pickContext(); PL.refAt = Date.now();
      softStep('Reading stock and on order from Unleashed (about 15 seconds)…');
      const [stock, drafts, gone] = await Promise.all([readStock(), PL.sup ? API.drafts(PL.sup) : [], PL.sup ? archivedRows(PL.sup) : null]);
      if (run !== PL.loadNo) return;
      adoptStock(stock); PL.stockTried = Date.now(); adoptDrafts(drafts, PL.sup); adoptArchived(gone); PL.draftsAt = Date.now(); PL.draftsRead = nowMs(); pickDraft();
      PL.phase = 'ready';
    } catch (e) { if (run !== PL.loadNo) return; PL.phase = 'error'; PL.error = (e && e.message) || String(e); }
    rerender();
    if (PL.phase === 'ready') { checkPo(); autoUsage(); }
  }
  function dropSession() {                                // someone else has signed in: nothing loaded for the last person carries over
    PL.loadNo += 1;
    PL.drafts.forEach((d) => { clearTimeout(d._t); d._t = null; });
    Object.keys(timers).forEach((k) => { clearTimeout(timers[k].t); delete timers[k]; });
    PL.drafts = []; PL.archived = []; PL.draftsFor = null; PL.draftKey = null; PL.po = {}; PL.cards = {}; PL.phase = 'idle';
  }
  // Stock is read when the page opens. If the dashboard is left open, read it again once it is 15 minutes old,
  // quietly: a failed read keeps the last good numbers, and the stamp shows how old they are.
  async function restock() {
    if (PL.stockBusy) return; PL.stockBusy = true; PL.stockTried = Date.now();
    try { adoptStock(await readStock()); unhold(); PL.stockBusy = false; rerender(); checkPo(true); }   // new On order may be a linked PO just placed: look now, not from the 5 minute cache
    catch (e) { PL.stockBusy = false; const first = !PL.stockErr; PL.stockErr = (e && e.message) || String(e); if (first) rerender(); }   // the last good numbers stay, with their time and a note on the stamp
  }
  // A draft another sign-in has seen placed, held In draft on this screen because stock could not be read at that
  // moment (see reloadDrafts). Once stock IS read, it becomes Ordered here in the same step.
  function unhold() {
    if (!PL.drafts.some((d) => d._heldAt)) return;
    PL.drafts.forEach((d) => { if (d._heldAt) { d.ordered_at = d._heldAt; delete d._heldAt; d._link = ''; d._hold = null; } });
    pickDraft();
  }
  // Rates, target months and the SKU list as just read again, taken on while the page is open. A rate or target this
  // session has typed and not yet seen saved (when the read was sent, or now) keeps its typed value: the read may
  // have been taken before that save landed. keys = the saves that were waiting when the read was sent.
  function takeRef(ref, keys) {
    [...new Set([...(keys || []), ...Object.keys(timers)])].forEach((k) => {
      const key = k.slice(2, k.startsWith('t:') ? k.lastIndexOf(':') : undefined), f = k.slice(k.lastIndexOf(':') + 1);
      if (k.startsWith('r:')) { const to = (ref.skus || []).find((r) => r.sku === key); if (to && PL.bySku[key]) to.rate = PL.bySku[key].rate; }
      else { const to = (ref.categories || []).find((c) => c.key === key), from = catOf(key); if (to && from) to[f] = from[f]; }
    });
    adoptRef(ref, true);
    if (!catOf(PL.cat) || (PL.sup && !supsOf(PL.cat).includes(PL.sup))) PL.phase = 'idle';   // the category or supplier on screen is gone: load afresh
  }
  const refSig = () => canon([PL.ref.categories, PL.ref.skus, PL.ref.aliases]);
  // A tab left open: the date moves on, other people change rates and target months, and someone else may have
  // refreshed usage. Looked at on every draw and when the window comes back; does real work at most every 10 minutes.
  // (Rates and target months are also read again with the drafts, every 45 seconds: see reloadDrafts.)
  async function freshen() {
    if (!live() || PL.freshBusy || PL.refresh.busy) return;
    const newDay = briIso(nowMs()).slice(0, 10) !== PL.today;
    if (!newDay && Date.now() - PL.refAt < REF_STALE_MS) { autoUsage(); return; }
    PL.freshBusy = true; PL.refAt = Date.now();
    const run = PL.loadNo, keys = Object.keys(timers);
    try {
      if (newDay) setWindow();                            // new date, part-month label and (on the 1st) month columns
      const [ref, usage] = await Promise.all([API.ref(), API.usage(PL.windowFrom)]);
      if (run === PL.loadNo && PL.phase === 'ready') {
        takeRef(ref, keys);
        if (!PL.refresh.busy) adoptUsage(usage);
      }
    } catch (e) { /* offline: keep what is on screen and try again next time */ }
    PL.freshBusy = false;
    if (run !== PL.loadNo) return;
    rerender(); autoUsage();
    if (PL.phase === 'ready' && Date.now() - PL.draftsAt >= REFOCUS_MS) reloadDrafts();
  }
  // Full redraw from a background event, keeping the cell being typed in. Waits while a menu, the PO card drawer or
  // the change-password box is open, because render() rebuilds all three and would wipe what is being typed there.
  let rrTimer = null, rrKeep = true;
  function rerender(keepText = true) {
    if (!S.authed || S.route !== 'planning') return;
    if (el('popbox') || S.open || S.chpass) {
      rrKeep = rrKeep && keepText;
      if (!rrTimer) rrTimer = setTimeout(() => { rrTimer = null; const k = rrKeep; rrKeep = true; rerender(k); }, 1500);
      return;
    }
    const a = document.activeElement, id = a && a.id && a.closest && a.closest('.planning') ? a.id : null;
    const raw = id ? a.value : null; let s0 = null, s1 = null;
    try { if (id) { s0 = a.selectionStart; s1 = a.selectionEnd; } } catch (e) { /* not a text field */ }
    render();
    const b = id ? el(id) : null; if (!b) return;
    b.focus(); if (!keepText) return;                     // after "Changed by someone else" the cell shows their number, not the text that was typed over it
    if (raw != null && 'value' in b && b.tagName === 'INPUT') b.value = raw;
    try { if (s0 != null) b.setSelectionRange(s0, s1); } catch (e) { /* not a text field */ }
  }
  async function reloadDrafts(force) {
    const sup = PL.sup; if (!sup || !live()) return;
    PL.draftsAt = Date.now();
    const run = PL.loadNo, keys = Object.keys(timers);
    const fetchRows = async () => { await Promise.all(PL.drafts.map((d) => d._chain).filter(Boolean)); return API.drafts(sup); };
    let rows, stock = null, gone = null, ref = null, held = false;
    try {
      // Rates and target months are read with the drafts: the claim rule only gives every screen the same number
      // when every screen works from the same rates. (A failed read of them keeps the ones on screen.)
      [gone, ref] = await Promise.all([archivedRows(sup), Promise.resolve().then(() => API.ref()).catch(() => null)]);
      rows = await fetchRows();                               // the open drafts are read last, so nothing can be saved between that read and taking it on
      // Another session saw one of these drafts' POs placed: its cartons are On order now. Read stock again first and
      // switch both in one step, so the cartons are never missing from both columns. If stock cannot be read, the
      // draft is held In draft on this screen (as poPass holds it) and the next re-read tries again.
      const flipped = sup === PL.sup ? rows.filter((r) => r.ordered_at && PL.drafts.some((d) => d.id === r.id && !d.ordered_at)).map((r) => r.id) : [];
      if (flipped.length) {
        try { stock = await readStock(); } catch (e) { if (!PL.drafts.some((d) => d._heldAt)) PL.stockTried = 0; }   // could not read it: the next draw tries once more too (and its failure puts the note on the stamp)
        rows = await fetchRows();
        if (!stock) { held = true; rows = rows.map((r) => (r.ordered_at && flipped.includes(r.id) ? { ...r, ordered_at: null, _heldAt: r.ordered_at } : r)); }
      }
    } catch (e) { return; }
    if (sup !== PL.sup || run !== PL.loadNo || !live()) return;
    const sig = () => canon([...PL.drafts, ...PL.archived].map((d) => [d.id, d.updated_at || '', d.ordered_at || '', d.archived_at || '', d.lines, d.manual, d._heldAt || ''])) + PL.draftKey + refSig();
    const before = sig();
    if (ref) { takeRef(ref, keys); if (PL.phase !== 'ready') { rerender(); return; } }
    adoptDrafts(rows, sup); adoptArchived(gone); if (stock) { adoptStock(stock); PL.stockTried = Date.now(); } pickDraft();
    if (held) { PL.draftsAt = 0; PL.drafts.forEach((d) => { if (d._heldAt) d._link = 'PO placed, waiting for a stock read'; }); }
    PL.draftsRead = nowMs(); const at = el('pl-drafts-at'); if (at) at.textContent = briIso(PL.draftsRead).slice(11, 16);
    if (force || stock || sig() !== before) rerender(!force);
    checkPo();
  }
  async function switchSupplier(id) {
    stashCurrent();
    const saving = PL.drafts.map((d) => d._chain).filter(Boolean);
    PL.sup = id || null; PL.ui.sup = PL.sup; PL.draftKey = null; PL.drafts = []; PL.archived = []; PL.draftsFor = null; saveUI();
    render();
    if (!PL.sup) return;
    try {
      await Promise.all(saving);
      const gone = await archivedRows(PL.sup), rows = await API.drafts(PL.sup); if (PL.sup !== id) return;
      adoptDrafts(rows, id); adoptArchived(gone); PL.draftsAt = Date.now(); PL.draftsRead = nowMs(); pickDraft();
    } catch (e) { PL.phase = 'error'; PL.error = (e && e.message) || String(e); }
    rerender(); checkPo();
  }
  // ---------- the PO hand-over ----------
  const dayOf = (v) => {                                  // an Unleashed or ISO date as a Brisbane day; '' when there is none
    if (v == null || v === '') return '';
    const s = String(v), u = s.match(/Date\((-?\d+)/);
    if (!u && typeof v !== 'number' && /^\d{4}-\d\d-\d\d/.test(s) && !/(Z|[+-]\d\d:?\d\d)$/.test(s)) return s.slice(0, 10);
    const ms = u ? +u[1] : typeof v === 'number' ? v : Date.parse(s);
    return Number.isFinite(ms) ? briIso(ms).slice(0, 10) : '';
  };
  async function poInfo(poNo, fresh) {                    // { status, day, sup } or null (Unleashed has no such PO); kept for 5 minutes
    const c = PL.po[poNo];
    if (c && !fresh && Date.now() - c.at < PO_CACHE_MS) return c.info;
    const x = await API.poStatus(poNo);
    const info = !x ? null : typeof x === 'string' ? { status: x, day: '', sup: '' } : x.status ? { status: String(x.status), day: dayOf(x.orderDate), sup: String(x.supplierCode || '').trim() } : null;
    PL.po[poNo] = { info, at: Date.now() };
    return info;
  }
  // The linked PO card as it is NOW. The card list in QB.items was read at sign-in, so a card started, or a PO number
  // typed, from another sign-in since then is not in it. Gives [card or null, was it read fresh].
  async function readCard(id) {
    if (id == null) return [null, false];
    const fresh = typeof API.poCard === 'function';
    if (fresh) {
      try { const c = await API.poCard(id), card = c && !c.archived ? c : null; PL.cards[id] = !!card; return [card, true]; } catch (e) { /* offline: the copy from sign-in will do for now */ }
    }
    const it = (QB.items || []).find((i) => String(i.id) === String(id)) || null;
    if (!fresh) PL.cards[id] = !!it;
    return [it && { id: it.id, name: it.name, poNo: it.poNo || '' }, false];
  }
  // What an ordered draft keeps: its typed numbers and, for every line nobody typed, the cartons this screen last
  // showed while Unleashed said the PO was not placed yet (_shown, taken in poPass). Without that (a fresh page load)
  // the saved copy. Never worked out afresh at the flip: by then stock may already count the PO, and every untyped
  // line would come to 0.
  function keptLines(d) {
    const s = d._shown && d._shown.m === canon(d.manual) ? d._shown.lines : null;
    return typedOver(s || d.lines, d);
  }
  // A draft is "ordered" once its linked PO is past Parked/Open in Unleashed: from then its cartons are On order, not
  // In draft. The PO number is the one on the linked card (read fresh), copied onto the draft as soon as it is seen
  // so every sign-in has it. A PO dated before the draft, or already Complete the first time it is seen, is not taken
  // on trust: the draft stays In draft and the page asks.
  let poChain = Promise.resolve();
  function checkPo(fresh) {                               // one pass at a time; fresh = do not use the 5 minute status cache
    poChain = poChain.then(() => poPass(fresh)).catch(() => {});
    return poChain;
  }
  async function poPass(fresh) {
    if (!live()) return;
    let changed = false; const placed = [];
    for (const id of PL.drafts.filter((x) => isOpenDraft(x) && x.id != null && !x._heldAt).map((x) => x.id)) {   // not a draft another sign-in has already stamped (held here until stock is read): it is never stamped twice
      const open = () => PL.drafts.find((x) => x.id === id && isOpenDraft(x) && !x._heldAt);   // a re-read may have swapped the draft object meanwhile
      let d = open(); if (!d) continue;
      const [card, sure] = await readCard(d.po_item_id);
      d = open(); if (!d) continue;
      const poNo = String((sure && card ? card.poNo : (card && card.poNo) || d.po_no) || '').trim();   // the card's number wins: correcting it there is enough
      let info = null, link = card ? NO_PO_NO : '', hold = '', flip = false;
      if (poNo) {
        const t0 = Date.now();
        try { info = await poInfo(poNo, fresh); } catch (e) { continue; }
        d = open(); if (!d) continue;
        const st = info && info.status, x = d.extra || {}, made = Date.parse(d.created_at);
        if (!st) link = `${poNo} not found in Unleashed`;
        else {
          const before = !!info.day && Number.isFinite(made) && info.day < briIso(made).slice(0, 10);
          // A number that lands on another supplier's purchase order is a slip of the finger, whatever its date.
          const mine = String(((QB.suppliers || []).find((s) => String(s.id) === String(d.supplier_id)) || {}).code || '').trim();
          if (x.poNot === poNo) hold = `${poNo} was marked as not this draft's PO: correct the PO number on the card`;
          else if (x.poOk !== poNo && mine && info.sup && info.sup.toUpperCase() !== mine.toUpperCase()) hold = `${poNo} is a ${info.sup} order, not ${mine}: check the number`;
          else if (x.poOk !== poNo && (before || (PO_DONE.includes(st) && d.po_no !== poNo))) hold = `${poNo} is ${st}${info.day ? `, dated ${dmy(info.day)}` : ''}${before ? ', before this draft' : ''}: check the number`;
          flip = !hold && !PO_OPEN.includes(st);
          link = hold ? 'check the PO number' : st === 'Parked' ? 'PO parked' : st === 'Deleted' ? 'PO deleted' : `PO ${st.toLowerCase()}`;
        }
        // Unleashed said, just now, that this PO is not placed (or is not there): what the draft shows is what it holds
        // before any flip. Kept for keptLines; the saved copy of an untyped line can be days old.
        if (!hold && (!st || PO_OPEN.includes(st)) && PL.stockAt && (PL.po[poNo] || {}).at >= t0) d._shown = { m: canon(d.manual), lines: Object.fromEntries(supSkus().map((r) => [r.sku, cartonsOf(d, r)]).filter((y) => y[1] > 0)) };
      }
      if ((d._link || '') !== link || ((d._hold || {}).text || '') !== hold) changed = true;
      d._link = link; d._hold = hold ? { no: poNo, text: hold } : null; d._po = poNo ? [poNo, info ? info.status : 'not found in Unleashed'] : null;
      if (flip) placed.push([id, poNo, info.status]);
      else if (!hold && String(d.po_no || '') !== poNo) patchDraft(d, { po_no: poNo });   // as it is on the card now (blank again if it was taken off)
    }
    if (placed.length) {
      // Read On order again BEFORE the cartons leave In draft, then switch both in one step. Otherwise they would sit
      // in neither column and every other draft would suggest them a second time. If stock cannot be read, the
      // draft stays In draft until the next check.
      let stock = null;
      try { stock = await readStock(); } catch (e) { /* next check */ }
      const flip = stock ? placed.map(([id, poNo, st]) => [PL.drafts.find((x) => x.id === id && isOpenDraft(x)), poNo, st]).filter((x) => x[0]) : [];
      if (flip.length) {
        const open = cur(), at = new Date(nowMs()).toISOString();
        flip.forEach(([d, poNo]) => { d.lines = keptLines(d); d.freight = frtHeld(d); d.ordered_at = at; d.po_no = poNo; d._link = ''; d._hold = null; });
        adoptStock(stock); PL.stockTried = Date.now(); changed = true;
        flip.forEach(([d, poNo, st]) => {
          saveDraft(d, true, { ordered_at: at, po_no: poNo });
          if (d === open) toast(`${d.name} is now ${poNo} in Unleashed (${st}). Its cartons count as On order from here, so it is read-only.`);
        });
      }
    }
    if (changed) { pickDraft(); rerender(); }
  }
  ACT.plpoyes = async () => {                             // "Yes, this is the PO": the number held back above is this draft's after all
    const d = cur(); if (!d || !isOpenDraft(d) || !d._hold) return;
    const no = d._hold.no, extra = { ...(d.extra || {}), poOk: no }; delete extra.poNot;
    if (!(await patchDraft(d, { extra, po_no: no }))) { toast("Couldn't save that: the draft was changed by someone else, or the connection dropped. Reloaded; try again."); reloadDrafts(true); return; }
    toast(`${no} confirmed as this draft's PO.`); checkPo();
  };
  async function reopenDraft() {                          // "Not this PO": an Ordered draft goes back to Drafts and the number on its card is read again
    const d = cur(); if (!d || d.kind !== 'draft' || !d.ordered_at || d.archived_at) return;
    const no = String(d.po_no || '').trim(), extra = { ...(d.extra || {}) }; delete extra.poOk; if (no) extra.poNot = no;
    if (!(await patchDraft(d, { ordered_at: null, po_no: '', extra }))) { toast("Couldn't reopen the draft: it was changed by someone else, or the connection dropped. Reloaded; try again."); reloadDrafts(true); return; }
    d._link = ''; d._hold = null; d._po = null;
    PL.drafts = PL.drafts.filter((x) => x.id != null || x._touched);   // the empty stand-in draft is not needed now
    render(); toast(`${d.name} is a draft again${no ? `, no longer tied to ${no}` : ''}. Its cartons count as In draft. If its PO card still shows that number, correct it there.`);
    checkPo(true);
  }

  // ---------- usage freshness ----------
  const usageStale = () => { const f = PL.run && PL.run.finished_at; return !f || nowMs() - Date.parse(f) > USAGE_STALE_MS; };
  function autoUsage() {                                  // over 20 hours old: refresh in the background, at most one attempt an hour
    if (!usageStale() || Date.now() - PL.refresh.autoAt < AUTO_RETRY_MS) return;
    PL.refresh.autoAt = Date.now(); refreshUsage('auto');
  }
  function setProg(text) {
    PL.refresh.text = text;
    const p = el('pl-prog'); if (p) p.textContent = text;
    const st = el('pl-stamp'); if (st) st.classList.toggle('is-busy', !!text);   // the progress text takes the usage stamp's place, so the head keeps its one line and the table does not jump
    const b = el('pl-refresh'); if (b) b.disabled = PL.refresh.busy;
  }
  async function refreshUsage(source) {
    if (PL.refresh.busy || PL.phase !== 'ready') return;
    PL.refresh.busy = true;
    setWindow();
    const all = [...PL.months, PL.part].map((m) => m[0]);
    // Button: every month of the window. Background run: from the month of the last good run (so a month that was
    // only part-read then is finished off), and never fewer than the current and previous month.
    let months = all;
    if (source !== 'button' && PL.run) {
      const ms = Date.parse(PL.run.finished_at), from = Number.isFinite(ms) ? briIso(ms).slice(0, 7) : all[0], two = all.slice(-2)[0];
      months = all.filter((k) => k >= (from < two ? from : two));
    }
    const mlabel = (k) => `${MON[+k.slice(5, 7) - 1]} ${k.slice(0, 4)}`;
    const steps = months.map((k) => [`sales for ${mlabel(k)}`, { action: 'sales', month: k }]);
    steps.push(['credit notes', { action: 'credits' }], ['print jobs', { action: 'assemblies' }], ['monthly totals', { action: 'rebuild', source }]);
    const call = async (label, body) => {                 // one call to the function: its reply, or an Error (carrying the list when a rebuild is refused with needs)
      let res = await API.refreshStep(body);
      if (res && res.data !== undefined && res.ok === undefined) { if (res.error) throw new Error(res.error.message || String(res.error)); res = res.data; }
      if (!res || res.error || !res.ok) throw Object.assign(new Error((res && res.error) || `no reply for ${label}`), { needs: res && Array.isArray(res.needs) ? res.needs : null });
      return res;
    };
    const sales = async (label, body) => {                // a month too heavy at 1,000 a page: once more at 500, then once at 200 (the function steps down to 100 by itself from there)
      try { return await call(label, body); } catch (e) { setProg(`Refreshing usage: ${label} again, in smaller pages…`); }
      try { return await call(label, { ...body, pageSize: 500 }); } catch (e) { setProg(`Refreshing usage: ${label} once more, in pages of 200…`); }
      return call(label, { ...body, pageSize: 200 });
    };
    const chunk = (k) => { const m = /^sales:(\d{4}-\d\d)$/.exec(k); return m ? [`sales for ${mlabel(m[1])}`, { action: 'sales', month: m[1] }] : k === 'credits' ? ['credit notes', { action: 'credits' }] : k === 'assemblies' ? ['print jobs', { action: 'assemblies' }] : null; };
    try {
      for (let i = 0; i < steps.length; i += 1) {
        const [label, body] = steps[i];
        setProg(`Refreshing usage: ${label} (step ${i + 1} of ${steps.length})…`);
        if (body.action === 'sales') await sales(label, body);
        else if (body.action !== 'rebuild') await call(label, body);
        else {
          try { await call(label, body); } catch (e) {
            // Refused because some months were never pulled, or were pulled before the SKU list changed: the reply
            // lists them. Pull exactly those, then ask once more.
            const more = (e.needs || []).map(chunk);
            if (!more.length || more.some((x) => !x)) throw e;
            for (const [l, b] of more) { setProg(`Refreshing usage: catching up ${l}…`); await (b.action === 'sales' ? sales(l, b) : call(l, b)); }
            setProg('Refreshing usage: monthly totals again…');
            await call(label, body);
          }
        }
      }
      setProg('Refreshing usage: reading the new numbers…');
      adoptUsage(await API.usage(PL.windowFrom));
      if (source === 'button') toast('Usage refreshed from Unleashed.');
    } catch (e) {
      toast(`Couldn't refresh usage: ${(e && e.message) || e}. The numbers shown are the last good ones.`);
    }
    PL.refresh.busy = false; setProg('');
    rerender();
  }

  // ---------- context bar, stamp, meter ----------
  const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
  function stampHtml() {
    const as = PL.run && PL.run.finished_at ? `as at <b>${esc(stampOf(PL.run.finished_at))}</b>` : '<b>not loaded yet</b>';
    // "as at" is when the monthly totals were last built. Older months are only read again by the button, so when
    // the oldest month behind the numbers was read over 7 days ago the stamp says so.
    const oc = PL.run && PL.run.stats && PL.run.stats.oldest_chunk_at, ocMs = oc ? Date.parse(oc) : NaN, old = Number.isFinite(ocMs) && nowMs() - ocMs > OLD_CHUNK_MS;
    const usage = old ? `<span class="pl-usage pl-old" title="The oldest month behind these numbers was last read from Unleashed on ${esc(stampOf(ocMs))}. The daily refresh only re-reads recent months; press Refresh usage to re-read every month.">` : '<span class="pl-usage">';
    const failed = PL.stockErr ? ` <span class="pl-over" title="${esc(PL.stockErr)} These are the last good numbers; it is tried again every 15 minutes.">(the last stock re-read failed)</span>` : '';
    return `<span>Stock is Unleashed Available, <b>${esc(stampOf(PL.stockAt) || dmy(PL.today))}</b>${failed}</span>
      ${usage}Usage: ${esc(PL.fyLabel)} to date, cartons a month, net of credits · ${as}</span>
      <span><span title="When this supplier's shared drafts were last read. They are read again every 45 seconds while this page is on screen.">Drafts as at <b id="pl-drafts-at">${PL.draftsRead ? briIso(PL.draftsRead).slice(11, 16) : '—'}</b></span> ·
      <button class="btn ghost sm" id="pl-refresh" type="button" data-act="plrefresh"${PL.refresh.busy ? ' disabled' : ''} title="Re-reads this year's sales orders, credit notes and print jobs from Unleashed. Takes a few minutes.">Refresh usage</button></span>
      <span id="pl-prog" role="status">${esc(PL.refresh.text)}</span>`;
  }
  function ctxHtml(ok) {
    const d = cur(), hist = isHist(), sups = supsOf(PL.cat);
    const day = (ts) => dmy(briIso(Date.parse(ts)));
    const tail = (x) => (x.archived_at ? ` · archived ${day(x.archived_at)}` : (x._link ? ' · ' + x._link : '') + (x.kind === 'draft' && x.ordered_at ? ` · ordered ${day(x.ordered_at)}` : ''));
    const grp = (label, list) => (list.length ? `<optgroup label="${label}">${list.map((x) => opt(keyOf(x), x.name + (x.id == null ? ' (not saved yet)' : '') + tail(x), x === d)).join('')}</optgroup>` : '');
    const drafts = PL.drafts.filter(isOpenDraft), ordered = PL.drafts.filter((x) => x.kind === 'draft' && x.ordered_at), past = PL.drafts.filter((x) => x.kind === 'past');
    const hold = d && isOpenDraft(d) && d._hold ? `<div class="pl-polink"><span class="chip warn">${esc(d._hold.text)}</span><button class="btn ghost sm" type="button" data-act="plpoyes" title="Only if this really is the purchase order for this draft. Otherwise correct the PO number on the PO card.">Yes, this is the PO</button></div>` : '';
    return `<div class="pl-ctx">
      <div><label class="pl-lab" for="pl-sel-cat">Category</label><select id="pl-sel-cat" title="Category">${PL.ref.categories.map((c) => opt(c.key, c.label, c.key === PL.cat)).join('') || '<option>No categories loaded</option>'}</select></div>
      <div><label class="pl-lab" for="pl-sel-sup">Supplier</label><select id="pl-sel-sup" title="Supplier"${sups.length ? '' : ' disabled'}>${sups.map((s) => opt(s, supName(s), s === PL.sup)).join('') || '<option>No supplier</option>'}</select></div>
      <div class="pl-grow"><label class="pl-lab" for="pl-sel-draft">Container draft or past PO</label>
        <div class="pl-draftrow"><select id="pl-sel-draft" title="Container draft or past PO"${d ? '' : ' disabled'}>${d ? grp('Drafts', drafts) + grp('Ordered', ordered) + grp('Past POs', past) + grp('Archived', PL.archived) : '<option>No drafts</option>'}</select>
          <button class="btn ghost sm" type="button" data-act="plnewdraft"${d ? '' : ' disabled'} title="Start another container for this supplier. The cartons on your other drafts show under In draft.">New draft</button>
          <button class="btn ghost sm" type="button" data-act="pldraftmenu"${d && d.kind === 'draft' ? '' : ' disabled'} aria-label="Rename, archive, reopen or restore this draft" title="Rename or archive this draft. An ordered draft can be reopened here, an archived one restored.">Rename · Archive</button>
          <span class="pl-saved muted" id="pl-saved" role="status">${savedHtml(d)}</span></div>${hold}</div>
      <div class="pl-sp"><span class="pl-lab" id="pl-lbl-cont">Container</span>
        <div class="seg" role="group" aria-labelledby="pl-lbl-cont" id="pl-seg-cont">${[['20', '20ft · 30 CBM'], ['40', '40ft · 60 CBM'], ['2x40', '2 × 40ft · 120 CBM']].map(([k, l]) => { const on = !!d && d.container === k; return `<button type="button" data-act="plcont" data-pl-cont="${k}" class="${on ? 'on' : ''}" aria-pressed="${on}"${hist || !ok ? ' disabled' : ''}>${l}</button>`; }).join('')}</div></div>
    </div>`;
  }
  const histStatus = (d) => (d.extra && d.extra.status) || (d.archived_at ? `Archived ${dmy(briIso(Date.parse(d.archived_at)))}` : d.ordered_at ? `Ordered ${dmy(briIso(Date.parse(d.ordered_at)))}${d.po_no ? ` as ${d.po_no}` : ''}` : 'Past PO');
  // Freight warnings for an open draft (in the meter, beside the freight figure, on both tabs).
  function frtChips(d, t) {
    if (t.noFrt) return `<span class="chip warn">Set the freight figure for a ${CAPLBL[d.container] || 'container'} on the Container tab</span>`;
    const was = frtForOf(d), out = [];
    if (d.freight_typed && was && was !== d.container && CAPLBL[was]) out.push(`<span class="pl-hint"><span class="chip warn">${aud(t.freight)} was typed for a ${CAPLBL[was]}: check it for ${CAPLBL[d.container]}</span><button class="btn ghost sm" type="button" data-act="plfrtok" title="Keeps the typed freight figure for this container size. Or type the right figure in the freight box on the Container tab.">Keep ${aud(t.freight)}</button></span>`);
    if (t.freight < FRT_LOW) out.push(`<span class="chip warn">Freight is under ${aud(FRT_LOW)}: check it</span>`);
    return out.join('');
  }
  // A hint, never a switch: once a size is set it only changes when someone presses a size button. Offered when the
  // cartons would fit a smaller size (a 40ft may run to 109%; a 20ft only to its 30 CBM maximum), or do not fit the
  // size picked. A 20ft is only offered when its category has a 20ft freight figure.
  function sizeHint(d, t) {
    if (!(t.cbm > 0)) return '';
    const sizes = ['20', '40', '2x40'], i = sizes.indexOf(d.container), fits = (k) => fitsIn(k, t.cbm);
    if (i < 0) return '';
    const down = sizes.slice(0, i).find((k) => fits(k) && (k !== '20' || frtDefault(d, k) != null));
    const up = down || fits(d.container) ? null : sizes.slice(i + 1).find(fits) || sizes.slice(i + 1).pop();
    const k = down || up; if (!k) return '';
    const f = d.freight_typed ? null : frtDefault(d, k);
    return `<span class="pl-hint"><span class="chip warn">${down ? `These cartons fit one ${CAPLBL[k]}` : `These cartons do not fit a ${CAPLBL[d.container]}`}</span><button class="btn ghost sm" type="button" data-act="plcont" data-pl-cont="${k}" title="Changes this draft's container size. Nothing changes until you press it.">Switch to ${CAPLBL[k]}${f != null ? ` (freight ${aud(f)})` : ''}</button></span>`;
  }
  function meterHtml() {
    const t = cont(), d = cur(), hist = isHist(), pct = t.cap ? t.cbm / t.cap : 0, left = t.cap - t.cbm;
    let cls, state;
    // A past PO's lines are what Unleashed received and costed, not the balancing tab's plan: "received at".
    // (The plan it was ordered against is in the row's note, so plan and received can still be compared.)
    const word = capWord(d.container);
    // An excess is never shown as "0.0": two decimals under 0.05 CBM. (A 20ft is over at any amount past 30 CBM, so a few litres can be all there is.)
    const over = -left, overTxt = over < 0.05 ? n2(over) : n1(over), sliver = !hist && d.container === '20' && over20(t.cbm) && over < 0.05;
    if (hist) { cls = 'is-done'; state = `<span class="pl-state muted">${esc(histStatus(d))}${d.kind === 'past' ? ' · received' : ''} at ${n1(t.cbm)} CBM · ${word} ${t.cap}</span>`; }
    // 30 CBM is the most a 20ft takes: anything over it is red and will not fit. The amber "tight" band rests on PO 484, a 40ft, and is for the 40ft sizes only.
    else if (d.container === '20' && over20(t.cbm)) { cls = 'is-over'; state = `<span class="pl-state pl-hot">${over < 0.005 ? `Just over the ${t.cap} CBM maximum for a 20ft (by under 0.01 CBM)` : `${overTxt} CBM over the ${t.cap} CBM maximum for a 20ft`}</span>`; }
    else if (pct > TIGHT) { cls = 'is-over'; state = `<span class="pl-state pl-hot">Over by ${n1(over)} CBM, will not fit</span>`; }
    else if (pct > FULL) { cls = 'is-tight'; state = `<span class="pl-state pl-over">${overTxt} CBM over the planning figure (PO 484 shipped 65.3 CBM in a 40ft)</span>`; }
    else if (pct >= 0.9) { cls = ''; state = `<span class="pl-state pl-fine">Good fill · ${n1(Math.max(0, left))} CBM spare</span>`; }
    else { cls = 'is-low'; state = `<span class="pl-state pl-over">Room for ${n1(left)} CBM more</span>`; }
    const size = hist ? esc((d.extra && d.extra.size) || CAPLBL[d.container] || 'no container size') : CAPLBL[d.container];
    return `
      <div class="pl-top"><span class="pl-big num">${sliver ? n2(t.cbm) : n1(t.cbm)} <small>of ${t.cap} CBM · ${size}</small></span>
        <span class="num muted">${n0(pct * 100)}% of ${word}</span>${state}</div>
      <div class="pl-bar" role="img" aria-label="Container at ${n0(pct * 100)} percent of the ${word}"><i class="${cls}" style="width:${Math.min(100, pct * 100)}%"></i></div>
      <div class="pl-kv num"><span><b>${n0(t.ctns)}</b> cartons</span><span><b>${t.lines}</b> lines</span>
        <span>Goods <b>US$${n0(t.usd)}</b> = <b>${aud(t.goods)}</b></span><span>Freight &amp; customs <b>${t.noFrt ? '—' : aud(t.freight)}</b></span>
        <span>Landed <b>${t.noFrt ? '—' : aud(t.goods + t.freight)}</b> ex GST</span>
        ${t.cbm > 0 && !t.noFrt ? `<span><b>${aud(t.freight / t.cbm)}</b> freight per CBM</span>` : ''}
        ${!hist && t.flagged ? `<span><b>${t.flagged}</b> SKUs need a look</span>` : ''}
        ${PL.stockErr ? `<span class="pl-over pl-stockerr" title="${esc(PL.stockErr)} These are the last good numbers, from ${esc(stampOf(PL.stockAt))}; it is tried again every 15 minutes.">The last stock re-read failed</span>` : ''}
        ${hist ? '' : frtChips(d, t) + sizeHint(d, t)}</div>`;
  }

  // ---------- forecast ----------
  function visible(r, c) {
    if (PL.q && !(r.sku + ' ' + r.description).toLowerCase().includes(PL.q.toLowerCase())) return false;
    if (PL.show === 'order') return c.order > 0;
    if (PL.show === 'flag') return c.flags.some((f) => f[0] !== 'plain') || drift(r) !== 0;
    if (PL.show === 'fill') return c.skip > 0;
    return true;
  }
  const monthsCls = (v) => (v == null ? '' : v < 3 ? 'pl-hot' : v > 15 ? 'pl-over' : '');
  const moqCell = (r) => (+r.moq_cartons ? n0(+r.moq_cartons) : '<span class="muted" title="MOQ is not loaded for this line, so it is not checked against it">?</span>');
  const flagsHtml = (c) => c.flags.map((f) => `<span class="chip ${f[0]}">${esc(f[1])}</span>`).join('');
  const tipText = (s) => String(s).replace(/[;|]/g, ' ');
  // What a usage exclusion kept out of one month, and the plain-English reason, or null. The cartons are the net the
  // rebuild stored (sales left out, less the credits that reversed them); the reason comes from the rule itself, so
  // no customer code is ever on screen. A rule that starts after this month cannot have taken anything out of it.
  function exclOf(r, key, row) {
    const ctns = Math.round(((+(row && row.excluded_cartons) || 0) - (+(row && row.excluded_credits) || 0)) * 10) / 10;
    if (!ctns) return null;
    const why = (PL.excl[r.sku] || []).filter((x) => !x.from || x.from <= key).map((x) => x.reason).filter(Boolean).join('; ');
    return { ctns, why: why || 'a rule on this line' };
  }
  function mcell(r, m, cls) {   // every month shows its split on hover / click; underlined when print jobs outweigh carton sales
    const x = useRow(r, m[0]), v = useTotal(x);
    const p = x ? [+x.cartons_sold || 0, +x.packs_sold || 0, +x.assembly_used || 0, +x.credits || 0] : [v, 0, 0, 0];
    const bits = ['Cartons sold|' + n1(p[0])];
    if (p[1]) bits.push('Small packs sold|' + n1(p[1]));
    if (p[2]) bits.push('Used in print jobs|' + n1(p[2]));
    if (p[3]) bits.push('Credits|−' + n1(p[3]));
    const left = exclOf(r, m[0], x);                       // cartons an exclusion rule kept out of this month, and why
    // nearly always cartons taken out (−); a month where only a credit was left out puts cartons back (+)
    if (left) bits.push(`Not counted (${tipText(left.why)})|${left.ctns > 0 ? '−' : '+'}${n1(Math.abs(left.ctns))}`);
    const pj = p[2] > p[0];
    return `<td class="num pl-split ${pj ? 'pl-pj' : ''} ${cls}"${pj ? ' tabindex="0"' : ''} data-pl-split="${esc(tipText(r.sku) + ' · ' + m[1] + ';' + bits.join(';') + ';Total|' + n1(v))}"><span class="pl-v">${n0(v)}</span></td>`;
  }
  const drawn = {};             // the In draft cell as last drawn, per SKU
  function dcell(r) {           // cartons in other drafts; the tip names the draft
    const p = draftParts(r), id = esc(r.sku);
    if (!p.length) return (drawn[r.sku] = `<td class="num muted" id="pl-ind-${id}">—</td>`);
    const t = p.reduce((a, x) => a + x[1], 0);
    return (drawn[r.sku] = `<td class="num pl-split pl-indraft" id="pl-ind-${id}" tabindex="0" data-pl-split="${esc(tipText(r.sku) + ' · in other drafts;' + p.map((x) => tipText(x[0]) + '|' + n0(x[1])).join(';') + (p.length > 1 ? ';Total|' + n0(t) : ''))}"><span class="pl-v">${n0(t)}</span></td>`);
  }
  // One source for every live cell: the first draw writes these into the HTML, typing patches them by id.
  function fvals(r, c, hist) {
    const d = cur() || { manual: {} }, dr = drift(r), held = !hist && c.sug ? heldTip(r) : '';
    return {
      now: c.now == null ? '—' : n1(c.now), nowCls: r.excluded || hist ? '' : monthsCls(c.now),
      // Suggested (HTML). A need the skip rule left off is shown greyed in brackets: on show as a fill candidate, never ordered.
      sug: !hist && c.sug ? (held ? `<span class="pl-held" title="${esc(held)}">${n0(c.sug)}</span>` : n0(c.sug)) : c.skip ? `<span class="pl-skip" title="Adds ${n1(c.skip / c.rate)} months, left off (under 2 months)">(${n0(c.skip)})</span>` : '—',
      rate: c.rate, rateTyped: !hist && c.rate !== PL.rate0[r.sku],
      ord: c.order > 0 ? c.order : (d.manual[r.sku] === 0 && !hist ? 0 : ''), ordTyped: !hist && d.manual[r.sku] != null,
      dr: dr > 0 ? '▲' : dr < 0 ? '▼' : '', drTitle: dr ? driftTip(r, dr) : '',
      add: c.order > 0 && c.added != null ? '+' + n1(c.added) : '—',
      aft: c.after == null ? '—' : n1(c.after), aftCls: c.order > 0 ? (c.after != null && c.after < 3 ? 'pl-hot' : c.over ? 'pl-over' : '') : '',
      cbm: c.order > 0 ? n2(c.cbm) : '—', flags: flagsHtml(c),
    };
  }
  function forecastTable() {
    const hist = isHist(), nm = PL.months.length, nf = PL.fullM.length, asAt = PL.run && PL.run.finished_at ? stampOf(PL.run.finished_at) : dmy(PL.today);
    const unread = `Not read in full yet: usage as at ${esc(asAt)} stops before this month ended. Not in the average until usage is refreshed.`;
    const head = `<thead><tr>
      <th class="pl-stick pl-l" rowspan="2">SKU</th><th class="pl-l" rowspan="2">Band</th>
      <th class="pl-colgrp pl-sep" colspan="${nm + 3}" title="Cartons sold + small packs sold + blank stock used in print jobs, less credits. Rounded to the nearest carton. Hover or click any month for its split. A dotted underline means print jobs used more than was sold as cartons. A customer whose stock is bought elsewhere can be left out of a line from a set month: the hover says what was not counted and why.">Used, cartons a month</th>
      <th class="pl-sep" rowspan="2">Rate<br>/ month</th>
      <th class="pl-sep" rowspan="2" title="Unleashed Available = on hand less allocated">Stock<br>avail.</th><th rowspan="2" title="Unleashed on purchase (placed purchase orders)">On<br>order</th><th rowspan="2" title="Cartons sitting in your other drafts for this supplier. They count towards cover, so a second container does not suggest them again. Hover a number to see which draft.">In<br>draft</th><th rowspan="2" title="Stock and on order only: what is really here or coming">Months<br>now</th>
      <th class="pl-sep" rowspan="2">Suggested</th><th rowspan="2">Order<br>cartons</th>
      <th rowspan="2">Months<br>added</th><th rowspan="2" title="Stock + on order + in draft + this order">Months<br>after</th><th rowspan="2">MOQ</th><th rowspan="2">CBM</th></tr>
      <tr><th class="pl-sep">Last yr</th>${PL.months.map((m) => (PL.fullK[m[0]] ? `<th>${m[1]}</th>` : `<th class="pl-unread" title="${unread}">${m[1]}</th>`)).join('')}<th title="Part month: usage as at ${esc(asAt)}. Not in the average.">${esc(PL.part[1])}</th><th title="${nf ? `Average of the ${nf} full month${nf === 1 ? '' : 's'} (${esc(rangeLbl())}), from the unrounded numbers` : 'No month has been read in full yet this financial year'}">Avg${nf ? ' ' + esc(rangeLbl()) : ''}</th></tr></thead>`;
    const list = catSkus().map((r) => [r, calc(r)]).filter(([r, c]) => visible(r, c));
    if (PL.show === 'fill') { const size = ([r, c]) => c.skip * (+r.cbm_per_carton || 0); list.sort((a, b) => size(b) - size(a)); }   // fill candidates: biggest CBM first
    const rows = list.map(([r, c]) => {
      const f = fy(r), s = stk(r), v = fvals(r, c, hist), id = esc(r.sku), off = hist || r.excluded ? ' disabled' : '';
      return `<tr class="${r.excluded ? 'pl-off' : ''}" data-pl-row="${id}">
        <td class="pl-stick"><span class="pl-sku">${id}</span><span class="pl-desc" title="${esc(r.description)}">${esc(r.description)}</span><div class="pl-flags" id="pl-fl-${id}">${v.flags}</div></td>
        <td class="pl-l"><span class="chip ${r.band === 'Top 50%' ? 'good' : r.band === 'Not ranked' ? 'plain' : ''}"${r.band === 'Not ranked' ? ' title="Not on the Product Ranking List, so no target and no suggestion"' : ''}>${esc(r.band)}</span></td>
        <td class="num pl-sep">${r.last_year_avg == null ? '—' : qty(+r.last_year_avg)}</td>
        ${PL.months.map((m) => mcell(r, m, PL.fullK[m[0]] ? '' : 'muted')).join('')}
        ${mcell(r, PL.part, 'muted')}
        <td class="num" id="pl-avg-${id}">${f == null ? '—' : n1(f)}</td>
        <td class="pl-sep"><span class="pl-cellin"><span class="pl-arrow" id="pl-dr-${id}" title="${esc(v.drTitle)}">${v.dr}</span><input class="pl-yel${v.rateTyped ? ' pl-typed' : ''}" id="pl-rate-${id}" data-pl-rate="${id}" data-pl-col="rate" inputmode="decimal" autocomplete="off" value="${esc(v.rate)}" aria-label="Monthly rate for ${id}"${off}></span></td>
        <td class="num pl-sep ${s.avail < 0 ? 'pl-neg' : ''}" title="${noRow(r) ? 'Unleashed has no stock row for this code (a line that has never had stock). Counted as 0.' : `On hand ${qty(s.stock)} · allocated ${qty(s.alloc)}`}">${noRow(r) ? '<span class="muted">—</span>' : qty(s.avail)}${s.pack > 0.05 ? `<span class="pl-sub">+${n1(s.pack)} in small packs</span>` : ''}</td>
        <td class="num">${qty(s.onPur)}</td>
        ${dcell(r)}
        <td class="num ${v.nowCls}" id="pl-now-${id}">${v.now}</td>
        <td class="num pl-sep" id="pl-sug-${id}">${v.sug}</td>
        <td><input class="pl-yel${v.ordTyped ? ' pl-typed' : ''}" id="pl-ord-${id}" data-pl-ord="${id}" data-pl-col="ord" inputmode="numeric" autocomplete="off" value="${esc(v.ord)}" aria-label="Order cartons for ${id}"${off}></td>
        <td class="num" id="pl-add-${id}">${v.add}</td>
        <td class="num ${v.aftCls}" id="pl-aft-${id}">${v.aft}</td>
        <td class="num">${moqCell(r)}</td>
        <td class="num" id="pl-cbm-${id}">${v.cbm}</td></tr>`;
    }).join('');
    return head + '<tbody>' + (rows || `<tr><td class="pl-l" colspan="${nm + 16}" style="color:var(--ink-soft)">No SKUs match.</td></tr>`) + '</tbody>';
  }
  function setInput(input, value, typed) { if (!input) return; if (document.activeElement !== input) input.value = value; input.classList.toggle('pl-typed', !!typed); }
  function refreshForecast() {
    const hist = isHist();
    catSkus().forEach((r) => {
      const now = el('pl-now-' + r.sku); if (!now) return;
      const v = fvals(r, calc(r), hist);
      now.textContent = v.now; now.className = 'num ' + v.nowCls;
      el('pl-sug-' + r.sku).innerHTML = v.sug;
      const was = drawn[r.sku], ind = el('pl-ind-' + r.sku);       // a number typed here changes what the other drafts are left to claim
      if (ind && dcell(r) !== was) { if (tipFor === ind) hideTip(); ind.outerHTML = drawn[r.sku]; }
      setInput(el('pl-rate-' + r.sku), v.rate, v.rateTyped);
      setInput(el('pl-ord-' + r.sku), v.ord, v.ordTyped);
      const dr = el('pl-dr-' + r.sku); dr.textContent = v.dr; dr.title = v.drTitle;
      el('pl-add-' + r.sku).textContent = v.add;
      const aft = el('pl-aft-' + r.sku); aft.textContent = v.aft; aft.className = 'num ' + v.aftCls;
      el('pl-cbm-' + r.sku).textContent = v.cbm;
      el('pl-fl-' + r.sku).innerHTML = v.flags;
    });
  }
  const scrollBox = (table) => `<div class="scroll pl-scroll" id="pl-scroll"${(PL.ui.h || PL.fitH) && !PL.ui.full ? ` style="max-height:${+(PL.ui.h || PL.fitH)}px"` : ''}><table class="pl-grid" id="pl-tbl">${table}</table></div>
      <div class="pl-grip" role="separator" aria-orientation="horizontal" title="Drag to make the table taller or shorter. Double-click to reset."><i></i></div>`;
  function forecastHtml() {
    const d = cur(), hist = isHist(), cat = catOf(PL.cat) || {}, dis = hist ? ' disabled' : '';
    const seg = [['all', 'All SKUs'], ['order', 'On this order'], ['flag', 'Needs a look'], ['fill', 'Fill candidates', 'Lines with a need the under-2-months rule left off (greyed in brackets under Suggested), biggest CBM first: the natural top-ups when the meter shows room.']]
      .map(([k, l, tip]) => `<button type="button" data-act="plshow" data-pl-show="${k}" class="${PL.show === k ? 'on' : ''}" aria-pressed="${PL.show === k}"${tip ? ` title="${tip}"` : ''}>${l}</button>`).join('');
    const open = hist || !!PL.ui.how;                     // a read-only notice always shows; the how-it-works hint sits behind its toggle (remembered)
    const how = hist
      ? (d.kind === 'past'
        ? `<b>${esc(d.name)}</b> is shown read-only. ${esc((d.extra && d.extra.note) || '')} Stock and months are today's, so they already include it.`
        : d.archived_at ? `<b>${esc(d.name)}</b> is archived and shown read-only, as it was last saved. Its cartons count nowhere. Restore it from Rename · Archive to work on it again.`
          : `<b>${esc(d.name)}</b> is shown read-only: it is now ${esc(d.po_no || 'a purchase order')} in Unleashed, so its cartons count under On order.`)
      : `Suggested = target months × your rate, less stock, on order and anything in your other drafts. Cartons nobody has typed sit on the oldest open draft, so a newer draft is only offered what is left. Order follows Suggested until you type your own number (bold outline); on a line you have typed, Suggested is what this draft would get if you cleared it (a dotted underline means a newer draft is holding some of those cartons: hover it). A greyed number in brackets under Suggested is a need left off because it would add under 2 months; Fill candidates lists them. ▲▼ beside a rate means this year's ${esc(rangeLbl() || 'monthly')} average is well away from it. A month with a <span class="pl-dot">dotted underline</span> went mostly into print jobs, not carton sales. Hover or click any month for its split.`;
    return `<div class="pl-tools" id="pl-strip">
        ${tabsHtml()}
        <div class="seg" role="group" aria-label="Show" id="pl-seg-show">${seg}</div>
        <input type="search" id="pl-q" placeholder="Find a SKU…" aria-label="Find a SKU" autocomplete="off" value="${esc(PL.q)}">
        <div class="pl-tgt" id="pl-tgt">Target months ${BANDS.map((b, i) => `<label>${esc(b[0])} <input class="num" id="pl-tgt-${i}" data-pl-band="${esc(b[0])}" value="${esc(cat[b[1]] == null ? b[2] : +cat[b[1]])}" inputmode="decimal" autocomplete="off"${dis}></label>`).join('')}</div>
        <span class="pl-acts"><button class="btn ghost" type="button" data-act="plsuggest"${dis}>Back to suggested</button>
        <button class="btn ghost" type="button" data-act="plclear"${dis}>Clear order</button>
        <button class="btn ghost" type="button" data-act="plreset"${dis} title="Puts this draft back on the suggested quantities, the default exchange rate and the default freight. Rates and target months are shared by every draft, so they stay as they are.">Reset this draft</button></span>
        ${endHtml('pl-how', 'Shows or hides the short explanation of Suggested, the arrows and the dotted months. Remembered.')}
      </div>
      <section class="pl-view" id="pl-view-forecast" role="tabpanel" aria-labelledby="pl-tab-forecast">
      <p class="pl-how${hist ? ' pl-ro' : ''}" id="pl-how"${open ? '' : ' hidden'}>${how}</p>
      ${scrollBox(forecastTable())}
    </section>`;
  }

  // ---------- container ----------
  function cvals(r, c, k, t, hist) {
    const d = cur() || { manual: {} }, on = c.order > 0;
    return {
      cq: on ? c.order : (d.manual[r.sku] === 0 && !hist ? 0 : ''), cqTyped: !hist && d.manual[r.sku] != null,
      ccbm: on ? n2(c.cbm) : '—', cusd: n2(k.usdCtn), ctusd: on ? n0(k.usdCtn * c.order) : '—',
      caud: n2(k.audCtn), ctaud: on ? n0(k.audCtn * c.order) : '—',
      cfrt: t.cbm > 0 && !t.noFrt ? n2(k.frtCtn) : '—', clan: t.cbm > 0 && !t.noFrt ? n2(k.landed) : '—',   // no freight figure: a dash, never a number built on zero freight
      cgp: k.gp == null || !(t.cbm > 0) || t.noFrt ? '—' : n1(k.gp * 100) + '%', flags: flagsHtml(c),
    };
  }
  function containerTable() {
    const hist = isHist(), t = cont();
    const head = `<thead><tr><th class="pl-stick pl-l">Code</th><th>Ctn qty</th><th>USD / bag</th><th>CBM / ctn</th>
      <th class="pl-sep">No. of ctns</th><th>CBM total</th><th class="pl-sep">USD / ctn</th><th>Total USD</th><th>AUD / ctn</th><th>Total AUD</th>
      <th class="pl-sep">Frt &amp; cust / ctn</th><th>Landed / ctn</th><th>Current cost</th><th class="pl-sep">RRP 1 ctn</th><th>GP%</th></tr></thead>`;
    const rows = supSkus().filter((r) => PL.showAll || orderOf(r) > 0).map((r) => {
      const c = calc(r), v = cvals(r, c, lineCost(r, t), t, hist), id = esc(r.sku);
      return `<tr class="${r.excluded ? 'pl-off' : ''}" data-pl-row="${id}">
        <td class="pl-stick"><span class="pl-sku">${id}</span><span class="pl-desc" title="${esc(r.description)}">${esc(r.description)}</span><div class="pl-flags" id="pl-cfl-${id}">${v.flags}</div></td>
        <td class="num">${n0(r.carton_qty)}</td><td class="num">${(+r.usd_per_unit || 0).toFixed(4)}</td><td class="num">${(+r.cbm_per_carton || 0).toFixed(4)}</td>
        <td class="pl-sep"><input class="pl-yel${v.cqTyped ? ' pl-typed' : ''}" id="pl-cq-${id}" data-pl-ord="${id}" data-pl-col="cq" inputmode="numeric" autocomplete="off" value="${esc(v.cq)}" aria-label="Cartons of ${id}"${hist || r.excluded ? ' disabled' : ''}></td>
        <td class="num" id="pl-ccbm-${id}">${v.ccbm}</td><td class="num pl-sep" id="pl-cusd-${id}">${v.cusd}</td><td class="num" id="pl-ctusd-${id}">${v.ctusd}</td>
        <td class="num" id="pl-caud-${id}">${v.caud}</td><td class="num" id="pl-ctaud-${id}">${v.ctaud}</td>
        <td class="num pl-sep" id="pl-cfrt-${id}">${v.cfrt}</td><td class="num" id="pl-clan-${id}">${v.clan}</td>
        <td class="num">${r.current_cost ? n2(+r.current_cost) : '—'}</td>
        <td class="num pl-sep">${r.rrp ? n2(+r.rrp) : '<span class="muted" title="No RRP is loaded for this line (the lookup shows #REF! on the balancing tab)">n/a</span>'}</td><td class="num" id="pl-cgp-${id}">${v.cgp}</td></tr>`;
    }).join('');
    return head + '<tbody>' + (rows || '<tr><td class="pl-l" colspan="15" style="color:var(--ink-soft)">Nothing on this container yet. Enter cartons on the Forecast tab, or press Back to suggested.</td></tr>') +
      `<tr class="pl-tot"><td class="pl-stick">Total</td><td></td><td></td><td></td><td class="num pl-sep" id="pl-tt-ctns">${n0(t.ctns)}</td><td class="num" id="pl-tt-cbm">${n2(t.cbm)}</td><td class="pl-sep"></td><td class="num" id="pl-tt-usd">${n0(t.usd)}</td><td></td><td class="num" id="pl-tt-aud">${n0(t.goods)}</td><td class="pl-sep"></td><td></td><td></td><td class="pl-sep"></td><td></td></tr></tbody>`;
  }
  function refreshContainer() {
    const t = cont(), hist = isHist();
    const fx = el('pl-fx'), frt = el('pl-frt');
    if (fx && document.activeElement !== fx) fx.value = t.fx;
    if (frt && document.activeElement !== frt) frt.value = t.noFrt ? '' : t.freight;
    const set = (id, v) => { const e = el(id); if (e) e.textContent = v; };
    supSkus().forEach((r) => {
      if (!el('pl-ccbm-' + r.sku)) return;
      const c = calc(r), v = cvals(r, c, lineCost(r, t), t, hist);
      setInput(el('pl-cq-' + r.sku), v.cq, v.cqTyped);
      ['ccbm', 'cusd', 'ctusd', 'caud', 'ctaud', 'cfrt', 'clan', 'cgp'].forEach((k) => set(`pl-${k}-${r.sku}`, v[k]));
      el('pl-cfl-' + r.sku).innerHTML = v.flags;
    });
    set('pl-tt-ctns', n0(t.ctns)); set('pl-tt-cbm', n2(t.cbm)); set('pl-tt-usd', n0(t.usd)); set('pl-tt-aud', n0(t.goods));
  }
  function containerHtml() {
    const d = cur(), hist = isHist(), t = cont(), dis = hist ? ' disabled' : '', cat = catOf(d.category_key) || {};
    const linked = d.po_item_id != null && PL.cards[d.po_item_id] !== false;   // a card started from another sign-in counts too
    const other = d.extra && d.extra.otherCount ? ` Plus ${+d.extra.otherCount} custom-print line${+d.extra.otherCount === 1 ? '' : 's'} (${n0(+d.extra.otherCtns || 0)} cartons) not shown.` : '';
    const note = (hist
      ? `Read-only: <b>${esc(d.name)}</b>. ${esc((d.extra && d.extra.note) || (d.archived_at ? 'Archived, as last saved.' : d.ordered_at ? `Now ${d.po_no || 'a purchase order'} in Unleashed.` : ''))}${other}`
      : `Freight is shared across lines by CBM, the same way your balancing sheet does it.${cat.freight_40 == null ? '' : ` Default freight is about ${aud(+cat.freight_40)} per 40ft${cat.freight_20 == null ? '' : ` and ${aud(+cat.freight_20)} per 20ft`}; open a past PO to see what the last ones came in at.`} Change a carton count here and the Forecast tab follows.`)
      + ' All dollar figures are ex GST.';
    const open = hist || !!PL.ui.how;                     // as on the Forecast tab: a read-only note always shows, the how-it-works note sits behind its toggle (remembered)
    return `<div class="pl-hdr" id="pl-strip">
        ${tabsHtml()}
        <div class="pl-fld"><label class="pl-lab" for="pl-fx">AUD → USD rate</label><input id="pl-fx" class="num${PL.bad.fx ? ' pl-bad' : ''}" inputmode="decimal" autocomplete="off" value="${esc(t.fx)}" title="US dollars for one Australian dollar, between ${FX_MIN.toFixed(2)} and ${FX_MAX.toFixed(2)}"${dis}></div>
        <div class="pl-fld"><label class="pl-lab" for="pl-frt">Freight &amp; customs (AUD)</label><input id="pl-frt" class="num${PL.bad.frt ? ' pl-bad' : ''}" inputmode="decimal" autocomplete="off" value="${esc(t.noFrt ? '' : t.freight)}"${t.noFrt && !hist ? ' placeholder="not set"' : ''} title="For the whole container, in dollars: digits only"${dis}></div>
        <div class="pl-badmsg" id="pl-badmsg" role="alert">${esc(PL.bad.fx || PL.bad.frt)}</div>
        <span class="pl-acts"><button class="btn ghost" type="button" data-act="plshowall">${PL.showAll ? 'Show ordered lines only' : 'Show all SKUs'}</button>
        <button class="btn ghost" type="button" data-act="plsave"${dis} title="Drafts also save by themselves a moment after each change.">Save draft</button>
        <button class="btn gold" type="button" data-act="plpo"${dis}>${linked ? 'Open the PO card' : 'Start a PO card'}</button></span>
        ${endHtml('pl-note', 'Shows or hides the short note on how freight is shared and what the default freight figures are. Remembered.')}
        <div class="pl-note${hist ? ' pl-ro' : ''}" id="pl-note"${open ? '' : ' hidden'}>${note}</div>
      </div>
      <section class="pl-view" id="pl-view-container" role="tabpanel" aria-labelledby="pl-tab-container">
      ${scrollBox(containerTable())}
    </section>`;
  }

  // ---------- the strip above the table ----------
  // One strip holds the Forecast | Container tabs, that tab's own tools, and the two page buttons (How this works,
  // Full view), so on a laptop they share rows instead of each taking one (Liam, 19/11/2026: "We are all using
  // laptops"). The strip sits outside the tab panel; the panel is the hint and the table.
  const tabsHtml = () => {
    const f = PL.tab === 'forecast';
    return `<div class="pl-tabs" role="tablist" aria-label="Container planning views">
          <button class="pl-tab" role="tab" id="pl-tab-forecast" aria-controls="pl-view-forecast" aria-selected="${f}" type="button" data-act="pltab" data-pl-tab="forecast">Forecast</button>
          <button class="pl-tab" role="tab" id="pl-tab-container" aria-controls="pl-view-container" aria-selected="${!f}" type="button" data-act="pltab" data-pl-tab="container">Container</button>
        </div>`;
  };
  // what = the id of the note the toggle shows and hides (the Forecast hint, the Container note). A read-only view has no toggle: its notice always shows.
  const endHtml = (what, tip) => `<span class="pl-end">${isHist() ? '' : `<button class="pl-howbtn" id="pl-howbtn" type="button" data-act="plhow" aria-expanded="${!!PL.ui.how}" aria-controls="${what}" title="${tip}">How this works</button>`}
          <button class="btn ghost" id="pl-full" type="button" data-act="plfull" aria-pressed="${!!PL.ui.full}" title="Give the table the whole window. Press Esc to go back. Remembered for your next visit.">${PL.ui.full ? '⤡ Exit full view' : '⤢ Full view'}</button></span>`;

  // ---------- the page ----------
  // One line: the tabs already name the view, so the h1 is kept for screen readers only and the room goes to the table.
  const headHtml = (title, stamp) => `<header class="page pl-head"><div><p class="eyebrow">Purchasing · Container planning</p><h1 id="pl-h1" class="pl-vh">${title}</h1></div><div class="pl-stamp${PL.refresh.text ? ' is-busy' : ''}" id="pl-stamp">${stamp}</div></header>`;
  function footHtml() {
    return `<div class="pl-foot">
      <div><b>How the monthly numbers are counted:</b> what actually left the shelf, in cartons. Full cartons sold, plus small packs sold (converted to cartons; the brown no-handle gift packs count against SOS1 and SOS2, the cartons they are cut from), plus blank stock used in completed print jobs (Unleashed assemblies, wastage included), less completed credit notes (taken off the month of the order they reverse). A printed bag is not counted again when it sells, and breaking a carton into packs is not a sale: those packs show under Stock until they sell or get printed. Parked and deleted orders are left out, and so are parked print jobs. Sales land in the month of the order; print jobs in the month they were completed. Months are shown rounded to the nearest carton; the average is worked from the unrounded numbers and leaves out the part month.</div>
      <div><b>In draft</b> is cartons sitting in your other drafts for this supplier. They count towards cover, so a second container does not suggest the same cartons again; Months now stays on real stock and on order. Once a draft's purchase order is placed in Unleashed its cartons move from In draft to On order. A parked PO still counts as In draft.</div>
      <div><b>On order</b> is Unleashed on-purchase only (placed purchase orders). <b>Stock</b> is Unleashed Available, with small-pack stock added as carton equivalents.</div>
      <div><b>Saving:</b> drafts are shared by Liam, Rick and Will and save by themselves a moment after each change, as do rates and target months. Nothing on this page writes to Unleashed or to the SharePoint workbooks. MOQ shows ? where it is not loaded, and those lines are not checked against it.</div>
    </div>`;
  }
  function viewPlanning() {
    if (PL.phase !== 'idle' && PL.me !== S.me) dropSession();
    if (PL.phase === 'idle') load();
    if (PL.phase !== 'ready') {
      const body = PL.phase === 'error'
        ? `<b>Couldn't load Container Planning.</b><br>${esc(PL.error)}<br><button class="btn ghost sm" type="button" data-act="plretry" style="margin-top:10px">Try again</button>`
        : `<b>Container Planning</b><br><span id="pl-step">${esc(PL.step || 'Loading…')}</span>`;
      return `<div class="planning" id="pl-root">${headHtml('Container Planning', '')}<div class="pl-empty">${body}</div></div>`;
    }
    if (Date.now() - PL.stockTried > STOCK_STALE_MS) restock();
    freshen(); startPoll();
    Promise.resolve().then(fitTable);                     // once this draw is on the page
    const d = cur(), ok = !!d && catSkus().length > 0, f = PL.tab === 'forecast', full = ok && PL.ui.full;
    const cat = catOf(PL.cat);
    const empty = !PL.ref.categories.length ? '<b>No categories are loaded yet.</b><br>The Container Planning set-up tables are empty.'
      : PL.sup && PL.draftsFor !== PL.sup ? `<b>${esc(supName(PL.sup))}</b><br>Loading this supplier's drafts…`
        : `<b>${esc(cat ? cat.label : '')}${PL.sup ? ' → ' + esc(supName(PL.sup)) : ''}</b><br>No SKUs are loaded for this category yet. Once they are, it opens the same two tabs. Forecast shows the category's SKUs; the container, its meter and the list of drafts and past POs belong to the supplier.`;
    return `<div class="planning${full ? ' is-full' : ''}" id="pl-root">
      ${headHtml(f ? 'Forecast' : 'Container', stampHtml())}
      ${ctxHtml(ok)}
      ${ok ? `<div class="pl-meter" id="pl-meter" aria-live="polite">${meterHtml()}</div>
      ${f ? forecastHtml() : containerHtml()}` : `<div class="pl-empty">${empty}</div>`}
      ${footHtml()}
      <div class="pl-tip" id="pl-tip" role="tooltip" hidden></div>
    </div>`;
  }
  window.viewPlanning = viewPlanning;

  function markBad() {                                    // red outline and the reason, while a figure being typed is not taken
    const fx = el('pl-fx'), frt = el('pl-frt'), m = el('pl-badmsg');
    if (fx) fx.classList.toggle('pl-bad', !!PL.bad.fx);
    if (frt) frt.classList.toggle('pl-bad', !!PL.bad.frt);
    if (m) m.textContent = PL.bad.fx || PL.bad.frt;
  }
  function refresh() {                                    // patch in place: never render() while someone is typing
    const m = el('pl-meter'); if (m) m.innerHTML = meterHtml();
    if (PL.tab === 'forecast') refreshForecast(); else refreshContainer();
    fitTable();                                           // a chip coming or going in the meter moves the table's top edge
  }
  function setFull(on) {
    PL.ui.full = !!on; saveUI(); render();
    if (PL.ui.full) scrollTo(0, 0);
    const b = el('pl-full'); if (b) b.focus();
  }
  const ready = () => live() && S.route === 'planning';
  const inPage = (t) => !!(t && t.closest && t.closest('.planning'));

  // ---------- buttons (through the dashboard's own data-act dispatcher) ----------
  ACT.plretry = () => { PL.phase = 'idle'; render(); };
  ACT.plrefresh = () => { if (ready()) refreshUsage('button'); };
  ACT.pltab = (b) => { PL.tab = b.dataset.plTab === 'container' ? 'container' : 'forecast'; PL.ui.tab = PL.tab; saveUI(); render(); const t = el('pl-tab-' + PL.tab); if (t) t.focus(); };
  ACT.plfull = () => setFull(!PL.ui.full);
  ACT.plshow = (b) => { PL.show = b.dataset.plShow; render(); };
  ACT.plshowall = () => { PL.showAll = !PL.showAll; render(); };
  ACT.plcont = (b) => {
    const d = cur(), c = b.dataset.plCont; if (!d || isHist() || !CAP[c] || c === d.container) return;
    if (d.freight_typed && frtForOf(d) == null) d._frtFor = d.container;   // a typed freight belongs to the size it was held on: the meter asks for it to be checked on the new one
    d.container = c; if (!d.freight_typed) d.freight = frtDefault(d, c);    // null on a size with no default: no figure at all, never the last size's
    touch(true); render();
  };
  ACT.plfrtok = () => {                                   // "Keep": the typed freight is right for this size too
    const d = cur(); if (!d || isHist() || !d.freight_typed) return;
    d._frtFor = d.container; touch(true); refresh();
  };
  ACT.plhow = (b) => {                                    // the how-it-works hint: shown or tucked away, remembered
    PL.ui.how = !PL.ui.how; saveUI();
    const p = el(b.getAttribute('aria-controls')); if (p) p.hidden = !PL.ui.how;   // the Forecast hint, or the Container note
    b.setAttribute('aria-expanded', String(!!PL.ui.how));
    fitTable();                                           // the note coming or going moves the table's top edge
  };
  ACT.plsuggest = () => { const d = cur(); if (!d || isHist()) return; d.manual = {}; touch(true); render(); toast('Order is back on the suggested quantities.'); };
  ACT.plclear = () => { const d = cur(); if (!d || isHist()) return; d.manual = {}; supSkus().forEach((r) => { d.manual[r.sku] = 0; }); touch(true); render(); toast('Order cleared. Back to suggested brings it back.'); };
  ACT.plreset = () => {                                   // this draft only: rates and target months belong to everyone and to every draft, so they are left alone
    const d = cur(); if (!d || isHist()) return;
    const cat = catOf(d.category_key) || catOf(PL.cat);
    d.manual = {}; d.fx = cat && +cat.default_fx > 0 ? +cat.default_fx : 0.68; d.freight_typed = false; d._frtFor = null; PL.bad.fx = PL.bad.frt = ''; autoContainer(d);
    touch(true); render(); toast('This draft is back to its starting numbers. Rates and target months are shared, so they stay as they are.');
  };
  ACT.plsave = async () => {
    const d = cur(); if (!d || isHist()) return;
    d._touched = true;
    if (await saveDraft(d, true)) toast('Draft saved. Rick and Will see the same draft from their own sign-in.');
  };
  ACT.plmoved = (b) => {                                  // what has moved on the open draft since it was last saved
    const d = cur(), m = movedOf(d); if (!m) return;
    const rows = m.list.map(([sku, a, z]) => `<tr><td style="text-align:left;padding:1px 14px 1px 0">${esc(sku)}</td><td style="text-align:right;padding:1px 0">${n0(a)} → ${n0(z)}</td><td style="text-align:right;padding:1px 0 1px 12px">${signed(z - a, n0)}</td></tr>`).join('');
    pop(b, `<div style="font-size:12.5px;line-height:1.45;max-width:320px"><b>Cartons saved → cartons now</b><br><span class="muted">Stock, on order, a rate or another draft has moved since the last save. Nothing is saved until you type or press the button.</span></div>
      <div style="max-height:240px;overflow:auto"><table style="font-size:12.5px;font-variant-numeric:tabular-nums;border-collapse:collapse;width:100%">${rows}</table></div>
      ${PL.stockErr ? '<div class="muted" style="font-size:12.5px;max-width:320px">The last stock re-read failed, so these are worked from older stock. They can be saved once stock has been read again.</div>' : '<button class="btn sm" data-pick="save">Save today\'s numbers</button>'}`, (k) => { if (k === 'save' && !PL.stockErr) { closeP(); ACT.plsave(); } });
  };
  ACT.plpo = async () => {
    const d = cur(); if (!d || isHist() || PL.busyPo) return;
    const card = d.po_item_id != null && PL.cards[d.po_item_id] !== false ? (QB.items || []).find((i) => String(i.id) === String(d.po_item_id)) : null;
    if (card) { S.open = card.id; S.tab = 'updates'; render(); return; }
    PL.busyPo = true;                                     // one card per press, however fast the button is clicked
    d._busy = (d._busy || 0) + 1;                         // and a re-read of the drafts meanwhile must not swap this draft out before the link is on it
    try {
      if (d.po_item_id != null) {                         // linked, but the card is not in this sign-in's list: never start a second one while the first is still there
        const [there, sure] = await readCard(d.po_item_id);
        if (there) { render(); toast(`This draft already has a PO card (Item ID ${there.id}), started from another sign-in after you signed in. Reload the page to open it.`); return; }
        // Only a read that came back fresh and empty (the card was deleted or archived) may lead to a new card.
        if (!sure && typeof API.poCard === 'function') { toast("Couldn't check this draft's PO card just now. Nothing was created; try again in a moment."); return; }
      }
      if (!(cont().ctns > 0)) { toast('Nothing on this container yet. Enter cartons first.'); return; }
      // The cartons are about to be fixed as typed numbers and written on the card, so they are worked out from what
      // is true NOW, not from what this screen last read: stock, rates and the supplier's drafts are read again first.
      // If that moves any line, nothing is started: the screen is redrawn and the person looks before pressing again.
      const was = canon(linesOf()), keys = Object.keys(timers), sup = PL.sup, run = PL.loadNo;
      toast('Checking stock, rates and the other drafts before the card is written (about 15 seconds)…');
      let fresh;
      try {
        fresh = await Promise.all([API.ref(), readStock(), Promise.all(PL.drafts.map((x) => x._chain).filter(Boolean)).then(() => API.drafts(sup))]);
      } catch (e) { toast(`Couldn't re-read stock, rates and drafts just now, so no PO card was started. Try again. (${(e && e.message) || e})`); return; }
      if (sup !== PL.sup || run !== PL.loadNo || !live()) return;
      takeRef(fresh[0], keys); adoptStock(fresh[1]); PL.stockTried = Date.now(); adoptDrafts(fresh[2], sup); pickDraft();
      if (PL.phase !== 'ready' || cur() !== d || isHist() || canon(linesOf()) !== was) {
        render(); toast('Stock, a rate or another draft has moved since this screen was drawn, so no PO card was started. Check the cartons, then press Start a PO card again.'); return;
      }
      const t = cont();
      const fixed = {}; supSkus().forEach((r) => { if (!r.excluded) fixed[r.sku] = orderOf(r); });   // the cartons on screen as the card is written
      d._touched = true;
      if (!(await saveDraft(d, true)) || d.id == null) return;
      const id = await API.startPoCard({ ...plain(d), summary: `${n0(t.ctns)} cartons on ${t.lines} lines, ${n1(t.cbm)} CBM in a ${CAPLBL[d.container]}; goods US$${n0(t.usd)}${t.noFrt ? '; no freight figure set, so no landed cost.' : `, landed about ${aud(t.goods + t.freight)} ex GST.`}` });
      // Gone for ordering: the cartons shown become typed numbers, so the draft stops following Suggested (stock sold
      // tomorrow must not change what the card says). "Back to suggested" undoes it.
      Object.keys(fixed).forEach((k) => { if (d.manual[k] == null) d.manual[k] = fixed[k]; });
      d.po_item_id = id; PL.cards[id] = true; d._link = NO_PO_NO;   // linked on screen at once, so another press opens this card instead of making a second one
      if (!(await saveDraft(d, true, { po_item_id: id }))) return;
      S.open = String(id); S.tab = 'updates'; render();
      toast('PO card created in "Drafting Orders" and linked to this draft. Its cartons are now fixed as typed numbers (bold outline), so they no longer follow Suggested; Back to suggested undoes that. Put the PO number on the card once the order exists in Unleashed.');
    } catch (e) { toast(`Couldn't start the PO card. (${(e && e.message) || e})`); } finally { PL.busyPo = false; d._busy -= 1; if (!d._busy) d._queued = null; setSaved(); }
  };
  ACT.plnewdraft = async () => {
    if (!ready() || !PL.sup || PL.busyNew) return;
    PL.busyNew = true;
    try {
      const prev = cur();                                 // the draft being left must exist (it is the older one) and anything typed on it must be sent first
      if (prev && isOpenDraft(prev) && (prev.id == null || prev._t)) { prev._touched = true; if (!(await saveDraft(prev)) && prev.id == null) return; }
      PL.drafts = PL.drafts.filter((x) => x.id != null || x._touched);      // a placeholder nobody typed in or saved is not a draft: drop it
      const d0 = localDraft();
      const row = await API.createDraft({ kind: 'draft', name: await freeName(d0.name, d0.supplier_id), category_key: d0.category_key, supplier_id: d0.supplier_id, container: null, fx: d0.fx, freight: d0.freight, freight_typed: false, manual: {}, lines: {} });
      const d = normDraft(row); d._touched = true;
      PL.drafts.push(d); PL.draftKey = keyOf(d); PL.ui.draft = PL.draftKey; saveUI();
      autoContainer(d); touch(true); render();            // touch: its container size and suggested cartons are written too, not just the empty row
      toast(`${d.name} started. Cartons on your other drafts show under In draft.`);
      await saveDraft(d, true);                           // written now, not on the short delay: the row never sits without a size for another sign-in to pick differently
    } catch (e) { toast(`Couldn't start a new draft. (${(e && e.message) || e})`); } finally { PL.busyNew = false; }
  };
  function renameDraft(anchor) {
    const d = cur(); if (!d || !isOpenDraft(d)) return;
    pop(anchor, `<div class="field"><label for="pl-rename">Draft name</label><input id="pl-rename" maxlength="120" autocomplete="off" value="${esc(d.name)}"></div><button class="btn sm" data-pick="save">Save name</button>`, (k) => { if (k === 'save') commit(); });
    const inp = el('pl-rename'); if (!inp) return;
    function commit() {
      const v = inp.value.trim(); closeP();
      if (!v || v === d.name) return;
      d.name = v; d._touched = true; saveDraft(d, true); render();
    }
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    inp.focus(); inp.select();
  }
  function archiveDraft(anchor) {                         // a draft tied to a PO card or a PO number is not archived without a question
    const d = cur(); if (!d || d.kind !== 'draft' || d.archived_at) return;
    if (d.id == null) { toast('This draft has not been saved yet, so there is nothing to archive.'); return; }
    const card = d.po_item_id != null && PL.cards[d.po_item_id] !== false;
    const po = d.ordered_at ? [d.po_no, 'ordered'] : d._po || (d.po_no ? [d.po_no, ''] : null);
    if (!card && !(po && po[0])) { doArchive(d); return; }
    const what = po && po[0] ? `is linked to ${po[0]}${po[1] ? ` (${po[1]})` : ''}` : 'has a PO card with no PO number yet';
    const then = d.ordered_at ? 'It leaves the Ordered list; its cartons stay under On order.'
      : `Its ${n0(supSkus().reduce((t, r) => t + cartonsOf(d, r), 0))} cartons stop counting as In draft, so they will be suggested again.`;
    pop(anchor, `<div style="font-size:13px;line-height:1.45;max-width:300px"><b>${esc(d.name)}</b> ${esc(what)}. Archive anyway? ${esc(then)}</div>
      <button class="btn sm" data-pick="yes">Archive anyway</button><button class="btn ghost sm" data-pick="no">Keep it</button>`, (k) => { closeP(); if (k === 'yes') doArchive(d); });
  }
  async function doArchive(d) {
    if (d !== cur()) return;
    // An open draft is archived with the cartons it shows now: its saved copy does not follow untyped lines, and the
    // archived view is that copy. (An ordered draft keeps the cartons it was ordered with.)
    const shown = isOpenDraft(d) ? { lines: linesOf(), ...(frtHeld(d) !== d.freight ? { freight: frtHeld(d) } : {}) } : {};
    if (d._t) saveDraft(d);                                // write the last edit now, so its autosave cannot fire at the archived row afterwards
    await (d._chain || Promise.resolve());
    clearTimeout(d._t); d._t = null;
    try {
      const row = await API.saveDraft(d.id, { archived_at: new Date(nowMs()).toISOString(), ...shown }, d.updated_at);
      if (!row) { d._stale = true; toast('Changed by someone else — reloaded'); reloadDrafts(true); return; }
      PL.drafts = PL.drafts.filter((x) => x !== d); PL.archived = [normDraft(row), ...PL.archived].slice(0, 10);
      PL.draftKey = null; PL.ui.draft = null; pickDraft(); PL.ui.draft = PL.draftKey; saveUI(); render();
      toast(`Archived "${d.name}". Its cartons no longer count as In draft.`, 'Undo', async () => {
        try {
          if (!(await API.saveDraft(row.id, { archived_at: null }, row.updated_at))) { toast("Couldn't bring it back — it was changed by someone else."); return; }
          PL.archived = PL.archived.filter((x) => x.id !== row.id); PL.ui.draft = String(row.id); PL.draftKey = null; await reloadDrafts(true);
        } catch (e) { toast(`Couldn't bring it back. (${(e && e.message) || e})`); }
      });
    } catch (e) { toast(`Couldn't archive the draft. (${(e && e.message) || e})`); if (d._fails) touch(false); }
  }
  async function restoreDraft() {                         // from the Archived group, back to where it was (Drafts, or Ordered)
    const d = cur(); if (!d || !d.archived_at || d.id == null) return;
    try {
      const row = await API.saveDraft(d.id, { archived_at: null }, d.updated_at);
      if (!row) { toast("Couldn't restore it — it was changed by someone else. Reloaded; try again."); await reloadDrafts(true); return; }
      PL.archived = PL.archived.filter((x) => x !== d); PL.ui.draft = String(d.id); saveUI();
      await reloadDrafts(true);
      toast(`Restored "${d.name}". ${row.ordered_at ? 'It is back under Ordered.' : 'Its cartons count as In draft again.'}`);
    } catch (e) { toast(`Couldn't restore the draft. (${(e && e.message) || e})`); }
  }
  ACT.pldraftmenu = (b) => {
    const d = cur(); if (!d || d.kind !== 'draft') return;
    const item = (k, label) => `<button class="btn ghost sm" style="text-align:left" data-pick="${k}">${label}</button>`;
    pop(b, d.archived_at ? item('restore', 'Restore this draft') : (isOpenDraft(d) ? item('rename', 'Rename this draft') : item('reopen', 'Not this PO: reopen the draft')) + item('archive', 'Archive this draft'),
      (k) => { closeP(); if (k === 'rename') renameDraft(b); else if (k === 'archive') archiveDraft(b); else if (k === 'reopen') reopenDraft(); else if (k === 'restore') restoreDraft(); });
  };

  // ---------- typing (every document listener is gated to this page) ----------
  document.addEventListener('input', (e) => {
    if (!ready()) return;
    const t = e.target; if (!inPage(t)) return;
    const ds = t.dataset || {}, d = cur(), hist = isHist();
    if (t.id === 'pl-q') { PL.q = t.value; const tb = el('pl-tbl'); if (tb && PL.tab === 'forecast') tb.innerHTML = forecastTable(); return; }
    if (hist || !d) return;
    if (ds.plRate) { const r = PL.bySku[ds.plRate]; if (!r) return; r.rate = !/\d/.test(t.value) || /^\s*-/.test(t.value) ? PL.rate0[r.sku] : num(t.value); saveRate(r.sku); touch(false); }   // blank, or no number in it ("n/a", "-5"): back to the opening rate. 0 only when 0 is typed
    else if (ds.plOrd) { if (blank(t.value)) delete d.manual[ds.plOrd]; else d.manual[ds.plOrd] = Math.round(num(t.value)); touch(true); }
    else if (ds.plBand) { const cat = catOf(PL.cat), b = BANDS.find((x) => x[0] === ds.plBand); if (!cat || !b) return; cat[b[1]] = blank(t.value) ? b[2] : num(t.value); saveTarget(cat.key, b[1]); touch(false); }
    else if (t.id === 'pl-fx') {                          // taken only as a plain number in a believable range; otherwise the last good rate stays and the box says why
      const v = plainNum(t.value), okv = v != null && v >= FX_MIN && v <= FX_MAX;
      PL.bad.fx = blank(t.value) || okv ? '' : `The exchange rate must be between ${FX_MIN.toFixed(2)} and ${FX_MAX.toFixed(2)} (US dollars for one Australian dollar). Still using ${d.fx}.`;
      if (okv) { d.fx = v; touch(true); }
      markBad();
    } else if (t.id === 'pl-frt') {                       // digits only: "10k" is not ten thousand
      const v = blank(t.value) ? null : plainNum(t.value);
      PL.bad.frt = blank(t.value) || v != null ? '' : `Freight must be a plain dollar figure, digits only (for example 9500, not 9.5k). Still using ${noFreight(d) ? 'no figure' : aud(frtOf(d) || 0)}.`;
      if (blank(t.value)) { d.freight_typed = false; d.freight = frtDefault(d, d.container); d._frtFor = null; touch(true); }   // blank = back to the default for this size (none on a size without one)
      else if (v != null) { d.freight_typed = true; d.freight = v; d._frtFor = d.container; touch(true); }
      markBad();
    } else return;
    refresh();
  });
  document.addEventListener('focusout', (e) => {     // once focus has left a yellow cell, show the number the maths is using
    if (!ready()) return;
    const t = e.target; if (!inPage(t) || !t.matches || !t.matches('input.pl-yel, #pl-fx, #pl-frt, .pl-tgt input')) return;
    const k = t.id === 'pl-fx' ? 'fx' : t.id === 'pl-frt' ? 'frt' : '';
    if (k && PL.bad[k]) { toast(PL.bad[k]); PL.bad[k] = ''; }   // the box goes back to the figure in use (below); the toast says what was not taken and why
    setTimeout(() => {
      if (!ready() || !t.isConnected) return;
      if (t.dataset.plBand) { const cat = catOf(PL.cat), b = BANDS.find((x) => x[0] === t.dataset.plBand); if (cat && b) t.value = cat[b[1]]; }
      markBad(); refresh();
    }, 0);
  });
  document.addEventListener('keydown', (e) => {      // Enter / arrows move down and up a column, like the spreadsheet
    if (!ready()) return;
    const t = e.target; if (!inPage(t) || !t.matches || !t.matches('input.pl-yel') || !['Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const col = [...t.closest('table').querySelectorAll(`input.pl-yel[data-pl-col="${t.dataset.plCol}"]:not([disabled])`)];
    const next = col[col.indexOf(t) + (e.key === 'ArrowUp' ? -1 : 1)];
    if (next) { e.preventDefault(); next.focus(); next.select(); }
  });
  document.addEventListener('change', (e) => {
    if (!ready()) return;
    const t = e.target; if (!inPage(t)) return;
    if (t.id === 'pl-sel-cat') {
      PL.cat = t.value; PL.ui.cat = PL.cat; saveUI();
      const sups = supsOf(PL.cat);
      if (!sups.includes(PL.sup)) switchSupplier(sups[0] || null); else render();
    } else if (t.id === 'pl-sel-sup') switchSupplier(t.value);
    else if (t.id === 'pl-sel-draft') { openDraft(t.value); render(); reloadDrafts(); }
  });

  // ---------- table room: full view (Esc) and the drag handle ----------
  document.addEventListener('keydown', (e) => {      // capture phase, so the dashboard's own Esc (popover, password box, card drawer) keeps priority
    if (e.key !== 'Escape' || !S.authed || S.route !== 'planning') return;
    hideTip();
    if (!PL.ui.full || el('popbox') || S.chpass || S.open) return;
    if (e.target && e.target.matches && e.target.matches('input, select, textarea')) return;
    setFull(false);
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (!ready()) return;
    const g = e.target.closest && e.target.closest('.planning .pl-grip'); if (!g) return;
    const sc = g.previousElementSibling; if (!sc) return;
    const y0 = e.clientY, h0 = sc.getBoundingClientRect().height;
    g.classList.add('is-on'); try { g.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ } e.preventDefault();
    const move = (ev) => { PL.ui.h = Math.round(Math.max(TBL_MIN, Math.min(4000, h0 + ev.clientY - y0))); sc.style.maxHeight = PL.ui.h + 'px'; };
    const up = () => { g.classList.remove('is-on'); g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up); saveUI(); };
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  });
  document.addEventListener('dblclick', (e) => {
    if (!ready()) return;
    const g = e.target.closest && e.target.closest('.planning .pl-grip'); if (!g) return;
    PL.ui.h = null; saveUI(); if (g.previousElementSibling) g.previousElementSibling.style.maxHeight = '';
    fitTable();
  });
  // Outside full view the table may be as tall as the window (planning.css). At the top of the page that would put
  // its last rows, the Total row and its sideways scrollbar below the fold. So, until someone drags the grip, the box
  // is kept to the room between its own top edge and the bottom of the window: it ends on screen, and grows to the
  // whole window as the page is scrolled down to it. It is never fitted shorter than TBL_MIN (240 px, about four
  // rows): a 600 px laptop window with a warning or two above the table leaves under 320 px, and the box must still
  // end on screen there.
  function fitTable() {
    const sc = el('pl-scroll'); if (!sc || !ready() || PL.ui.full || PL.ui.h) return;
    const b = sc.getBoundingClientRect(); if (!b.height) return;   // not laid out
    const h = Math.round(Math.max(TBL_MIN, window.innerHeight - Math.max(8, b.top) - 8));
    PL.fitH = h; if (sc.style.maxHeight !== h + 'px') sc.style.maxHeight = h + 'px';
  }
  window.addEventListener('scroll', (e) => { if (ready() && e.target === document) fitTable(); }, true);
  window.addEventListener('resize', () => { if (ready()) fitTable(); });

  // ---------- split tip for the month and In draft cells ----------
  let tipFor = null;
  function hideTip() { const tip = el('pl-tip'); if (tip) tip.hidden = true; tipFor = null; }
  function showTip(td) {
    const tip = el('pl-tip'); if (!tip || tipFor === td) return; tipFor = td;
    const rows = String(td.dataset.plSplit || '').split(';');
    tip.innerHTML = '<b>' + esc(rows[0]) + '</b>' + rows.slice(1).map((x) => { const [k, v] = x.split('|'); return `<div class="${k === 'Total' ? 'pl-t' : ''}"><span>${esc(k)}</span><span>${esc(v)}</span></div>`; }).join('');
    tip.hidden = false;
    const b = td.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, b.left + b.width / 2 - w / 2)) + 'px';
    tip.style.top = (b.top - h - 6 < 8 ? b.bottom + 6 : b.top - h - 6) + 'px';
  }
  const splitAt = (e) => (S.route === 'planning' && e.target && e.target.closest ? e.target.closest('.planning td.pl-split') : null);
  document.addEventListener('mouseover', (e) => { const td = splitAt(e); if (td) showTip(td); else if (tipFor) hideTip(); });
  document.addEventListener('focusin', (e) => { if (S.route !== 'planning') return; const td = splitAt(e); if (td) showTip(td); else if (tipFor) hideTip(); });
  document.addEventListener('click', (e) => { if (S.route !== 'planning') return; const td = splitAt(e); if (td) { tipFor = null; showTip(td); } else if (tipFor) hideTip(); });
  window.addEventListener('scroll', () => { if (tipFor) hideTip(); }, true);

  // ---------- shared drafts: look again when the window comes back, and do not lose typing on the way out ----------
  // Someone typing for an hour never leaves the window, so the drafts are also read again every 45 seconds while the
  // page is on screen (not while the tab is hidden). The timer is started by drawing the page and stops once it is left.
  const lookAgain = () => { freshen(); if (Date.now() - PL.draftsAt >= REFOCUS_MS) reloadDrafts(); };
  let pollT = null;
  function poll() {
    pollT = null; if (!ready()) return;
    pollT = setTimeout(poll, DRAFTS_MS);
    if (document.hidden) return;
    if (Date.now() - PL.stockTried > STOCK_STALE_MS) restock();
    lookAgain();
  }
  const startPoll = () => { if (!pollT) pollT = setTimeout(poll, DRAFTS_MS); };
  window.addEventListener('focus', () => { if (!ready()) return; lookAgain(); });
  document.addEventListener('visibilitychange', () => { if (!ready() || document.hidden) return; lookAgain(); });
  window.addEventListener('beforeunload', (e) => {   // an edit not yet saved (drafts, rates, target months): send it now and let the browser ask before leaving
    if (!live()) return;
    if (!PL.drafts.some((d) => d._t || d._busy) && !Object.keys(timers).length) return;
    flushAll(); e.preventDefault(); e.returnValue = '';
  });
  window.addEventListener('pagehide', () => { if (live()) flushAll(); });
})();

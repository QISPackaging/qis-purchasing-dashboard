'use strict';
/* Data layer: Supabase auth + reads/writes for the pd_ tables and pd-files
   storage. Loads everything into the in-memory QB shape the UI renders from,
   and writes each change through as it happens. */
const DB = (() => {
  const client = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

  // js field <-> db column
  const COLMAP = {
    group: 'group_key', status: 'status_key', supplierId: 'supplier_id', nextAction: 'next_action',
    poNo: 'po_no', depositPaid: 'deposit_paid', balanceDue: 'balance_due', balancePaid: 'balance_paid',
    sampleRequested: 'sample_requested', sampleConnote: 'sample_connote', fromResearch: 'from_research', poId: 'po_id',
  };
  const DATES = new Set(['nextAction', 'balanceDue', 'balancePaid', 'erd', 'etd', 'eta', 'landed', 'received']);
  const toDb = (js) => {
    const out = {};
    for (const [k, v] of Object.entries(js)) {
      const col = COLMAP[k] || k;
      if (DATES.has(k) || k === 'supplierId' || k === 'fromResearch' || k === 'poId') out[col] = v === '' || v == null ? null : v;
      else if (k === 'value') out[col] = v === '' || v == null ? null : Number(v);
      else out[col] = v;
    }
    return out;
  };
  const briDT = (ts) => {
    const s = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Australia/Brisbane', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
    return s.replace(' ', 'T');
  };
  const fromDb = (r) => ({
    id: String(r.id), board: r.board, group: r.group_key, status: r.status_key, position: r.position,
    name: r.name, people: r.people || [], priority: r.priority || '',
    supplierId: r.supplier_id || '', nextAction: r.next_action || '', notes: r.notes || '',
    poNo: r.po_no || '', value: r.value, forwarder: r.forwarder || '', container: r.container || '',
    depositPaid: r.deposit_paid || '', balanceDue: r.balance_due || '', balancePaid: r.balance_paid || '',
    erd: r.erd || '', etd: r.etd || '', eta: r.eta || '', landed: r.landed || '',
    category: r.category || '', sampleRequested: r.sample_requested || 'No', sampleConnote: r.sample_connote || '',
    spec: r.spec || '', fromResearch: r.from_research ? String(r.from_research) : '', poId: r.po_id ? String(r.po_id) : '',
    received: r.received, files: [],   // files listed from storage when a card opens
  });

  async function init() {
    const { data: { session } } = await client.auth.getSession();
    return session;
  }
  async function signIn(email, password) {
    const { error } = await client.auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  }
  const signOut = () => client.auth.signOut();
  async function changePassword(password) {
    const { error } = await client.auth.updateUser({ password });
    return error ? error.message : null;
  }

  const sel = async (q) => { const { data, error } = await q; if (error) throw new Error(error.message); return data; };

  async function loadAll() {
    const [users, sups, items, updates, activity] = await Promise.all([
      sel(client.from('pd_users').select('*')),
      sel(client.from('pd_suppliers').select('*').order('name')),
      sel(client.from('pd_items').select('*').is('archived_at', null).order('position')),
      sel(client.from('pd_updates').select('*').is('deleted_at', null).order('created_at')),
      sel(client.from('pd_activity').select('*').order('at')),
    ]);
    const ORDER = ['liam', 'rick', 'will'];
    QB.PEOPLE = users.filter((u) => u.active)
      .sort((a, b) => ORDER.indexOf(a.person_key) - ORDER.indexOf(b.person_key))
      .map((u) => ({ key: u.person_key, first: u.full_name.split(' ')[0], name: u.full_name, color: u.color, email: u.email, auth_id: u.auth_id }));
    QB.AREA_PEOPLE = { purchasing: QB.PEOPLE.map((p) => p.key) };
    QB.suppliers = sups.map((s) => ({ id: s.id, name: s.name, code: s.code, tier: s.tier, country: s.country,
      products: s.products, lead: s.lead_time, freight: s.freight, moq: s.moq, currency: s.currency, terms: s.terms,
      active: s.active, extra: s.extra || {} }));
    const groupOrder = Object.fromEntries(QB.GROUPS.map((g, i) => [g.key, i]));
    QB.items = items.map(fromDb).sort((a, b) => (groupOrder[a.group] - groupOrder[b.group]) || (a.position - b.position));
    QB.updates = {}; QB.activity = {};
    for (const u of updates) (QB.updates[String(u.item_id)] = QB.updates[String(u.item_id)] || [])
      .push({ by: u.author, at: briDT(u.created_at), text: u.body, src: u.source });
    for (const a of activity) (QB.activity[String(a.item_id)] = QB.activity[String(a.item_id)] || [])
      .push({ at: briDT(a.at), by: a.actor, field: a.field, from: a.old_val, to: a.new_val });
  }

  // Every save failure must be seen — silent loss is the one unforgivable bug.
  function guard(promise, what) {
    return promise.catch((e) => { toast(`Couldn't save ${what}. Check your connection, then reload before editing more. (${e.message})`); throw e; });
  }
  const patchItem = (id, jsFields, what) =>
    guard(sel(client.from('pd_items').update(toDb(jsFields)).eq('id', id).select('id')), what || 'the change');
  const insertItem = (jsItem, what) =>
    guard(sel(client.from('pd_items').insert(toDb(jsItem)).select('id')), what || 'the new card');
  const addUpdate = (itemId, body) =>
    guard(sel(client.from('pd_updates').insert({ item_id: itemId, author: S.me, body }).select('id')), 'the update');
  async function refreshActivity(itemId) {
    const rows = await sel(client.from('pd_activity').select('*').eq('item_id', itemId).order('at'));
    QB.activity[String(itemId)] = rows.map((a) => ({ at: briDT(a.at), by: a.actor, field: a.field, from: a.old_val, to: a.new_val }));
  }

  // ---- files (private bucket, signed URLs) ----
  async function listFiles(itemId) {
    const { data, error } = await client.storage.from('pd-files').list(String(itemId), { sortBy: { column: 'created_at', order: 'asc' } });
    if (error) throw new Error(error.message);
    return (data || []).filter((f) => f.name !== '.emptyFolderPlaceholder')
      .map((f) => ({ name: f.name, size: Math.round(((f.metadata || {}).size || 0) / 1024) }));
  }
  const uploadFile = (itemId, file) =>
    guard(client.storage.from('pd-files').upload(`${itemId}/${file.name}`, file, { upsert: true })
      .then(({ error }) => { if (error) throw new Error(error.message); }), 'the file');
  async function fileUrl(itemId, name) {
    const { data, error } = await client.storage.from('pd-files').createSignedUrl(`${itemId}/${name}`, 3600);
    if (error) throw new Error(error.message);
    return data.signedUrl;
  }

  // ---- Unleashed via the pd-unleashed Edge Function (token stays server-side) ----
  async function unleashed(name, args) {
    const { data, error } = await client.functions.invoke('pd-unleashed', { body: { name, arguments: args || {} } });
    if (error) throw new Error(error.message);
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  return { client, init, signIn, signOut, changePassword, loadAll, patchItem, insertItem, addUpdate, refreshActivity, listFiles, uploadFile, fileUrl, unleashed };
})();

'use strict';
/* Core: helpers, state, item rules, popovers, toasts, sign-in, navigation.
   State lives in QB (loaded by db.js); every change writes through to Supabase. */
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt$ = (n) => (n == null || n === '' ? '' : '$' + Number(n).toLocaleString('en-AU', { maximumFractionDigits: 0 }));
const fmtD = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}` : '');
const fmtDT = (s) => `${fmtD(s)} ${s.slice(11, 16)}`;
const today = () => QB.dd(0);
const nowStamp = () => { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return `${today()}T${p(d.getHours())}:${p(d.getMinutes())}`; };
function textOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 165 ? '#1B2330' : '#FFFFFF';
}
// New Item ID: 9 + nine random digits + a Luhn check digit (11 digits, clear of Monday's 1… range).
function luhn(payload) {
  let sum = 0;
  [...payload].reverse().forEach((ch, i) => { let d = +ch; if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; } sum += d; });
  return String((10 - (sum % 10)) % 10);
}
function newItemId() {
  let id;
  do {
    const r = crypto.getRandomValues(new Uint32Array(9));
    const body = '9' + [...r].map((x) => x % 10).join('');
    id = body + luhn(body);
  } while (QB.items.some((i) => i.id === id));
  return id;
}
function bizDays(n) {
  const d = new Date();
  while (n > 0) { d.setDate(d.getDate() + 1); if (d.getDay() % 6 !== 0) n--; }
  return d.toISOString().slice(0, 10);
}

const S = {
  me: null, authed: false, loading: false, loadError: '',
  hideEmpty: false,
  route: 'poverview', view: { pos: 'table', research: 'table' }, activeOnly: true,
  f: { q: '', person: '', status: '', group: '', priority: '' }, collapsed: {},
  open: null, tab: 'updates', draft: '', flash: null, chpass: false, signinError: '',
};
const person = (k) => QB.PEOPLE.find((p) => p.key === k) || { key: k, first: k || '—', name: k || '—', color: '#9aa0a8' };
const peopleFor = () => QB.PEOPLE.filter((p) => QB.AREA_PEOPLE.purchasing.includes(p.key));
const group = (k) => QB.GROUPS.find((g) => g.key === k);
const statusDef = (board, k) => QB.STATUS[board].find((s) => s.key === k) || { key: '', label: '', color: '#c4c4c4' };
const prioDef = (k) => QB.PRIORITY.find((p) => p.key === k);
const item = (id) => QB.items.find((i) => i.id === id);
const updatesOf = (id) => QB.updates[id] || [];

// ---- item rules ----
// Local echo of the server-side activity trigger, so the Activity tab is
// instant; opening a card replaces it with the database's own log.
function logAct(it, field, from, to) {
  (QB.activity[it.id] = QB.activity[it.id] || []).push({ at: nowStamp(), by: S.me, field, from, to });
}
function setField(it, field, val) {
  const from = it[field];
  if (String(from ?? '') === String(val ?? '')) return false;
  it[field] = val;
  const show = (v) => (field === 'status' ? statusDef(it.board, v).label : field === 'supplierId' ? (supplier(v) || {}).name : field === 'group' ? (group(v) || {}).label : Array.isArray(v) ? v.map((k) => person(k).first).join(', ') : v);
  logAct(it, field, show(from), show(val));
  DB.patchItem(it.id, { [field]: val }, `"${field}"`);
  if (field === 'status') purchasingTransition(it, val);
  if (field === 'landed' && val && it.board === 'pos') purchasingLanded(it);   // typing a landed date also sets Health to Landed
  return true;
}
// Copy to the clipboard, with a fallback for browsers that block the modern way.
function copyText(text, label) {
  const ok = () => toast(`${label} copied: ${text}`);
  const fail = () => toast(`Couldn't copy here. The ${label} is ${text}.`);
  const fallback = () => {
    try {
      const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.select(); const done = document.execCommand('copy'); ta.remove(); if (done) ok(); else fail();
    } catch (err) { fail(); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
}
function addUpdate(it, text, src) {
  (QB.updates[it.id] = QB.updates[it.id] || []).push({ by: S.me, at: nowStamp(), text, src: src || 'app' });
  DB.addUpdate(it.id, text);
  S.flash = it.id;
}

// ---- small UI pieces ----
const pill = (def, cls = '', attrs = '') => `<button class="pill ${cls}" style="--bg:${def.color};--fg:${textOn(def.color)}" ${attrs}>${esc(def.label) || '&nbsp;'}</button>`;
const avs = (keys, cls = '') => (keys || []).map((k) => { const p = person(k); return `<span class="av ${cls}" style="--pc:${p.color}" title="${esc(p.name)}">${esc(p.name.split(' ').map((w) => w[0]).join(''))}</span>`; }).join('');

let toastTimer;
function toast(msg, label, fn) {
  clearTimeout(toastTimer);
  $('#toast').innerHTML = `<div class="toast" role="status"><span>${esc(msg)}</span>${label ? `<button id="toast-act">${esc(label)}</button>` : ''}</div>`;
  if (label) $('#toast-act').onclick = () => { $('#toast').innerHTML = ''; fn(); };
  toastTimer = setTimeout(() => { $('#toast').innerHTML = ''; }, 8000);
}
function closePop() { $('#pop').innerHTML = ''; }
function pop(anchor, html, onPick, cls = '') {
  const r = anchor.getBoundingClientRect();
  $('#pop').innerHTML = `<div class="pop ${cls}" id="popbox">${html}</div>`;
  const box = $('#popbox');
  box.style.left = Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8)) + 'px';
  const below = r.bottom + 4 + box.offsetHeight < innerHeight;
  box.style.top = (below ? r.bottom + 4 : Math.max(8, r.top - box.offsetHeight - 4)) + 'px';
  box.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) onPick(b.dataset.pick, b, e); });
}

// ---- sign-in ----
function signinHtml() {
  return `<div class="signin"><div class="signin-card">
    <div class="brand" style="justify-content:center;background:var(--plate);align-self:center;border-radius:4px;padding:4px 6px"><img src="img/qis-logo.png" alt="QIS Packaging"></div>
    <p class="eyebrow" style="text-align:center">QIS Packaging</p>
    <h1 style="text-align:center">Purchasing Dashboard</h1>
    <p class="muted" style="text-align:center;font-size:12.5px;margin:4px 0 14px">Purchasing team sign-in. Separate from the sales dashboard.</p>
    <form id="signin-form">
      <div class="field"><label for="si-email">Email</label><input id="si-email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="si-pw">Password</label><input id="si-pw" type="password" autocomplete="current-password" required></div>
      ${S.signinError ? `<p class="bad-text">${esc(S.signinError)}</p>` : ''}
      <button class="btn gold" style="width:100%;margin-top:10px" type="submit">Sign in</button>
    </form>
    <p class="muted" style="font-size:12px;margin:14px 0 0">Access is limited to the purchasing team. If your password isn't working, ask Liam.</p>
  </div></div>`;
}
async function doSignIn() {
  const err = await DB.signIn($('#si-email').value.trim(), $('#si-pw').value);
  if (err) { S.signinError = /invalid/i.test(err) ? 'Email or password not recognised.' : err; render(); return; }
  S.signinError = '';
  await enter();
}
async function enter() {
  S.loading = true; render();
  try {
    await DB.loadAll();
    const { data: { user } } = await DB.client.auth.getUser();
    const me = QB.PEOPLE.find((p) => p.auth_id === (user && user.id));
    if (!me) { S.loadError = 'Signed in, but this account is not on the purchasing team.'; S.loading = false; render(); return; }
    S.me = me.key; S.authed = true; S.loading = false; S.route = 'poverview';
  } catch (e) {
    S.loadError = `Couldn't load the boards: ${e.message}`; S.loading = false;
  }
  render();
}

// ---- change password ----
function chpassHtml() {
  return `<div class="shade" data-act="chpassclose"></div><div class="dlg signin-card" role="dialog" aria-label="Change password" style="position:fixed;z-index:60;top:18vh;left:50%;transform:translateX(-50%);width:min(400px,94vw)">
    <h1 style="font-size:19px;text-align:center">Change password</h1>
    <form id="chpass-form">
      <div class="field"><label for="cp-1">New password (10+ characters)</label><input id="cp-1" type="password" autocomplete="new-password" minlength="10" required></div>
      <div class="field"><label for="cp-2">Type it again</label><input id="cp-2" type="password" autocomplete="new-password" minlength="10" required></div>
      <div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn ghost" type="button" data-act="chpassclose">Cancel</button><button class="btn gold" type="submit">Change password</button></div>
    </form>
  </div>`;
}

// ---- navigation + render ----
const ACT = {};
const NAV = [['poverview', 'Overview'], ['research', 'Supplier Research'], ['pos', 'Purchase Orders'], ['suppliers', 'Suppliers']];
function navHtml() {
  const me = person(S.me);
  const w = workList().length;
  return `<nav>
    <span class="brand"><img src="img/qis-logo.png" alt="QIS Packaging"></span>
    <span class="wordmark">Purchasing Dashboard</span>
    ${NAV.map(([r, l]) => `<a class="${S.route === r ? 'on' : ''}" data-act="go" data-route="${r}" tabindex="0">${l}</a>`).join('')}
    <a class="${S.route === 'mywork' ? 'on' : ''}" data-act="go" data-route="mywork" tabindex="0">My Work${w ? `<span class="badge num">${w}</span>` : ''}</a>
    <span class="who">${avs([S.me])}<span style="margin-left:8px"><b>${esc(me.name)}</b></span><button class="linkbtn" data-act="chpass">Change password</button><button class="linkbtn" data-act="signout">Sign out</button></span>
  </nav>`;
}
function render() {
  if (S.loading) { closePop(); $('#app').innerHTML = `<div class="signin"><div class="signin-card"><h1 style="text-align:center">Purchasing Dashboard</h1><p class="muted" style="text-align:center">Loading the boards…</p></div></div>`; return; }
  if (S.loadError) { closePop(); $('#app').innerHTML = `<div class="signin"><div class="signin-card"><h1 style="text-align:center">Purchasing Dashboard</h1><p class="bad-text" style="text-align:center">${esc(S.loadError)}</p><button class="btn ghost" data-act="signout" style="align-self:center">Back to sign-in</button></div></div>`; return; }
  if (!S.authed) { closePop(); $('#app').innerHTML = signinHtml(); $('#drawer').innerHTML = ''; $('#dlg').innerHTML = ''; return; }
  const sc = $('.scroll'); const keep = sc ? [sc.scrollLeft, sc.scrollTop] : null; const y = scrollY;
  closePop();
  const views = { pos: () => viewBoard('pos'), research: () => viewBoard('research'), poverview: viewPOverview, suppliers: viewSuppliers, mywork: viewMyWork };
  $('#app').innerHTML = navHtml() + (views[S.route] || views.poverview)();
  $('#drawer').innerHTML = S.open ? drawerHtml(item(S.open)) : '';
  $('#dlg').innerHTML = S.chpass ? chpassHtml() : '';
  const sc2 = $('.scroll'); if (sc2 && keep) { sc2.scrollLeft = keep[0]; sc2.scrollTop = keep[1]; }
  scrollTo(0, y);
  S.flash = null;
}
ACT.noop = () => {};
ACT.copyid = (el, e) => { e.stopPropagation(); copyText(el.dataset.id, el.dataset.label || 'Item ID'); };
const noFilters = () => ({ q: '', person: '', status: '', group: '', priority: '' });
ACT.go = (el) => { S.route = el.dataset.route; S.open = null; S.f = noFilters(); render(); scrollTo(0, 0); };
ACT.signout = async () => { await DB.signOut(); S.me = null; S.authed = false; S.open = null; S.draft = ''; S.loadError = ''; render(); scrollTo(0, 0); };
ACT.chpass = () => { S.chpass = true; render(); $('#cp-1').focus(); };
ACT.chpassclose = () => { S.chpass = false; render(); };

function boot() {
  $('#layer').innerHTML = '<div id="drawer"></div><div id="dlg"></div><div id="pop"></div><div id="toast"></div><input type="file" id="fpick" hidden>';
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!e.target.closest('#popbox') && !(el && el.dataset.keep)) closePop();
    if (el && ACT[el.dataset.act]) ACT[el.dataset.act](el, e);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if ($('#popbox')) closePop(); else if (S.chpass) { S.chpass = false; render(); } else if (S.open) { S.open = null; render(); } }
    if (e.key === 'Enter' && e.target.matches && e.target.matches('nav a, tr.click, .work')) e.target.click();
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'signin-form') { e.preventDefault(); doSignIn(); }
    if (e.target.id === 'chpass-form') {
      e.preventDefault();
      const a = $('#cp-1').value, b = $('#cp-2').value;
      if (a !== b) { toast('The two passwords don\'t match.'); return; }
      const err = await DB.changePassword(a);
      if (err) { toast(`Couldn't change it: ${err}`); return; }
      S.chpass = false; render(); toast('Password changed. Use the new one next time you sign in.');
    }
  });
  DB.init().then((session) => { if (session) enter(); else render(); });
}

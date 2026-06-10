'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------- Ikony (SVG) ---------- */
const ICON = {
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05"/><path d="M12 22.08V12"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  printer: '<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a6 6 0 0 1 0 12h-3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  key: '<circle cx="8" cy="15" r="5"/><path d="m11.5 11.5 8-8M17 7l2 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
function icon(name, cls = 'ico') { return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[name] || ''}</svg>`; }

/* ---------- Lokální nastavení (prohlížeč) ---------- */
const DEF = { currency: 'Kč', sound: true, theme: 'light', silenceMs: 90, fastAvg: 70 };
let cfg = { ...DEF, ...JSON.parse(localStorage.getItem('sklad_cfg') || '{}') };
function saveCfg() { localStorage.setItem('sklad_cfg', JSON.stringify(cfg)); }

let currentUser = null;
let atLogin = false;
const state = { mode: 'in', view: 'inventory', filter: 'all', q: '', sort: 'updated', dir: 'desc', items: [] };

const scanEl = $('#scan'), stepEl = $('#step'), fieldEl = $('#scanfield'), spinnerEl = $('#spinner');

/* ---------- API ---------- */
async function api(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401 && !String(url).includes('/api/login')) ensureLogin('Sezení vypršelo, přihlas se znovu.');
  if (!res.ok) { let m = 'Chyba serveru'; try { m = (await res.json()).error || m; } catch {} const e = new Error(m); e.status = res.status; throw e; }
  return res.status === 204 ? null : res.json();
}
function ensureLogin(msg) { if (!atLogin) showLogin(msg); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// Bezpečné URL do CSS url() – jen http(s), bez znaků, které by umožnily únik z url()
function cssUrl(u) { const s = String(u == null ? '' : u); return /^https?:\/\//i.test(s) && !/['"()\\\s<>]/.test(s) ? s : ''; }
function thumbHtml(it, cls) { const u = cssUrl(it.image_url); return u ? `<div class="${cls}" style="background-image:url('${u}')"></div>` : `<div class="${cls}">${icon('box')}</div>`; }
function money(v) { return (Number(v) || 0).toLocaleString('cs-CZ', { maximumFractionDigits: 2 }) + ' ' + cfg.currency; }
function qfmt(n) { return (Number(n) || 0).toLocaleString('cs-CZ', { maximumFractionDigits: 3 }); }
function round3c(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }

/* ---------- Zvuk ---------- */
let actx;
function beep(ok = true) {
  if (!cfg.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.connect(g); g.connect(actx.destination); o.type = 'sine';
    o.frequency.value = ok ? 880 : 220;
    g.gain.setValueAtTime(0.07, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.18);
    o.start(); o.stop(actx.currentTime + 0.18);
  } catch {}
}

/* ---------- Toast ---------- */
let toastT;
function toast(msg, kind = '', action) {
  const el = $('#toast');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { el.classList.add('hidden'); action.fn(); }; el.appendChild(b); }
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.add('hidden'), action ? 6000 : 2600);
}

/* ---------- Téma ---------- */
function applyTheme() { document.body.classList.toggle('theme-dark', cfg.theme === 'dark'); $('#btn-theme').innerHTML = icon(cfg.theme === 'dark' ? 'sun' : 'moon'); }
$('#btn-theme').addEventListener('click', () => { cfg.theme = cfg.theme === 'dark' ? 'light' : 'dark'; saveCfg(); applyTheme(); });

/* ---------- Modal systém ---------- */
let modalLocked = false;
function openModal(html, locked = false) { modalLocked = locked; $('#modal-body').innerHTML = html; $('#overlay').classList.remove('hidden'); }
function closeModal() { if (modalLocked) return; $('#overlay').classList.add('hidden'); $('#modal-body').innerHTML = ''; focusScan(); }
$('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
function field(label, id, val, type = 'text', extra = '') { return `<div class="fld"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(val)}" ${extra}></div>`; }

/* ===================== PŘIHLÁŠENÍ ===================== */
async function boot() {
  applyTheme();
  try { const me = await api('/api/me'); currentUser = me.user; await afterLogin(); }
  catch { showLogin(); }
}
function showLogin(err) {
  if (atLogin) { const e = $('#lg-err'); if (e && err) e.textContent = err; return; }
  atLogin = true;
  openModal(`
    <div class="login">
      <div class="l-logo">${icon('box')}</div>
      <h2>Skladová evidence</h2>
      <p>Přihlas se ke svému účtu</p>
      <input id="lg-user" placeholder="Uživatelské jméno" autocomplete="username">
      <input id="lg-pass" type="password" placeholder="Heslo" autocomplete="current-password">
      <button class="btn primary l-go" id="lg-go">Přihlásit se</button>
      <div class="l-err" id="lg-err">${err ? esc(err) : ''}</div>
    </div>`, true);
  const go = async () => {
    try {
      const r = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#lg-user').value.trim(), password: $('#lg-pass').value }) });
      currentUser = r.user; modalLocked = false; closeModal(); await afterLogin();
    } catch (e) { $('#lg-err').textContent = e.message; }
  };
  $('#lg-go').onclick = go;
  $('#lg-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#lg-pass').focus(); });
  $('#lg-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  setTimeout(() => $('#lg-user').focus(), 50);
}
async function afterLogin() {
  atLogin = false;
  $('#op-name').textContent = currentUser.display_name;
  $('#op-role').textContent = currentUser.role === 'admin' ? 'Administrátor' : 'Operátor';
  $('#op-avatar').textContent = ((currentUser.display_name || '?').trim()[0] || '?').toUpperCase();
  document.body.classList.toggle('is-admin', currentUser.role === 'admin');
  setMode('in');
  await Promise.all([loadItems(), loadSummary()]);
  focusScan();
}
async function logout() { try { await api('/api/logout', { method: 'POST' }); } catch {} location.reload(); }

/* ---------- Režim / taby / filtry / řazení ---------- */
function setMode(m) {
  state.mode = m;
  $$('[data-mode]').forEach((x) => x.classList.toggle('active', x.dataset.mode === m));
  document.body.classList.remove('mode-out', 'mode-set');
  if (m === 'out') document.body.classList.add('mode-out');
  if (m === 'set') document.body.classList.add('mode-set');
  $('#step-label').textContent = m === 'set' ? 'na' : 'po';
  $('#hint').textContent = m === 'set'
    ? 'Inventura: naskenuj kód a nastav skutečný počet kusů na skladě.'
    : 'Jen naskenuj kód čtečkou — appka pozná konec skenu sama, Enter mačkat nemusíš.';
  focusScan();
}
$$('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$$('.nav-item').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  $$('.nav-item').forEach((x) => x.classList.toggle('active', x === b));
  $('#view-inventory').classList.toggle('hidden', state.view !== 'inventory');
  $('#view-history').classList.toggle('hidden', state.view !== 'history');
  if (state.view === 'history') loadMovements();
}));
function setFilter(f) { state.filter = f; $$('.fil').forEach((x) => x.classList.toggle('active', x.dataset.filter === f)); loadItems(); }
$$('.fil').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
$$('.stat[data-filter]').forEach((c) => c.addEventListener('click', () => { if (state.view !== 'inventory') $('.nav-item[data-view="inventory"]').click(); setFilter(c.dataset.filter); }));
$$('.grid th.sortable').forEach((th) => th.addEventListener('click', () => {
  const key = th.dataset.sort;
  if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
  else { state.sort = key; state.dir = key === 'name' || key === 'code' ? 'asc' : 'desc'; }
  loadItems();
}));

/* ---------- Skenování (bez Enteru) ---------- */
let scanning = false, autoTimer = null, firstKeyT = 0;
function submitScan() { clearTimeout(autoTimer); const code = scanEl.value.trim(); scanEl.value = ''; if (!code || scanning) return; doScan(code); }
scanEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitScan(); } });
scanEl.addEventListener('input', () => {
  const now = performance.now();
  if (scanEl.value.length <= 1) firstKeyT = now;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    const code = scanEl.value.trim();
    if (code.length < 3 || scanning) return;
    const avg = code.length > 1 ? (now - firstKeyT) / (code.length - 1) : 0;
    if (avg <= cfg.fastAvg) submitScan();
  }, cfg.silenceMs);
});
async function doScan(code) {
  scanning = true; spinnerEl.classList.remove('hidden'); fieldEl.classList.add('busy'); scanEl.disabled = true;
  try {
    const body = { code, mode: state.mode };
    const n = parseFloat(stepEl.value);
    if (state.mode === 'set') body.value = Number.isFinite(n) ? n : 0;
    else body.step = Number.isFinite(n) && n > 0 ? n : 1;
    const r = await api('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    beep(true); showLastScan(r); await Promise.all([loadItems(), loadSummary()]);
  } catch (err) { beep(false); if (err.status !== 401) toast(err.message, 'err'); }
  finally { scanning = false; spinnerEl.classList.add('hidden'); fieldEl.classList.remove('busy'); scanEl.disabled = false; focusScan(); }
}
function showLastScan(r) {
  const it = r.item, el = $('#lastscan');
  const name = it.name || '— bez názvu, otevři detail a doplň —';
  const thumb = thumbHtml(it, 'ls-thumb');
  let badge = '';
  if (r.lookedUp) badge = r.found ? `<span class="src-badge">✓ ${esc(it.source || 'internet')}</span>` : `<span class="src-badge miss">⚠ nenalezeno</span>`;
  const d = r.delta;
  const deltaTxt = state.mode === 'set' ? `= ${qfmt(it.quantity)}` : `${d >= 0 ? '+' : ''}${qfmt(d)} → ${qfmt(it.quantity)}`;
  el.className = 'lastscan ' + state.mode;
  el.innerHTML = `${thumb}
    <div><div class="ls-name">${esc(name)}</div>
    <div class="ls-sub"><span class="code">${esc(it.code)}</span>${it.brand ? ' · ' + esc(it.brand) : ''}${badge}</div></div>
    <div class="ls-right"><div class="ls-badge">${deltaTxt} ${esc(it.unit || 'ks')}</div><button class="ls-undo" id="ls-undo">${icon('undo')} Vrátit</button></div>`;
  $('#ls-undo').onclick = undoLast;
}
async function undoLast() {
  try { await api('/api/undo', { method: 'POST' }); toast('Vráceno zpět', 'ok'); $('#lastscan').classList.add('hidden'); await Promise.all([loadItems(), loadSummary()]); if (state.view === 'history') loadMovements(); }
  catch (err) { toast(err.message, 'err'); }
  focusScan();
}

/* ---------- Sklad ---------- */
function statusDot(it) { if (it.quantity <= 0) return 'zero'; if (it.min_stock > 0 && it.quantity < it.min_stock) return 'low'; return 'ok'; }
async function loadItems() {
  const p = new URLSearchParams({ filter: state.filter, sort: state.sort, dir: state.dir });
  if (state.q) p.set('q', state.q);
  let rows;
  try { rows = await api('/api/items?' + p.toString()); }
  catch (e) { if (e.status === 401) return; throw e; }
  state.items = rows;

  // zachovat rozdělanou inline editaci přes re-render (sken/refresh nesmí přepsat psaný text)
  const ae = document.activeElement;
  let keep = null;
  if (ae && ae.dataset && ae.dataset.f && ae.closest && ae.closest('#items tr')) {
    keep = { code: ae.closest('tr').dataset.code, f: ae.dataset.f, v: ae.value, s: null, e: null };
    try { keep.s = ae.selectionStart; keep.e = ae.selectionEnd; } catch {}
  }
  renderItems();
  if (keep) {
    const el = [...document.querySelectorAll('#items tr [data-f="' + keep.f + '"]')].find((x) => x.closest('tr').dataset.code === keep.code);
    if (el) { el.value = keep.v; el.focus(); if (keep.s != null) { try { el.setSelectionRange(keep.s, keep.e); } catch {} } }
  }
  $$('.grid th.sortable').forEach((th) => { const a = th.querySelector('.arr'); if (a) a.remove(); if (th.dataset.sort === state.sort) th.insertAdjacentHTML('beforeend', ` <span class="arr">${state.dir === 'asc' ? '▲' : '▼'}</span>`); });
}
function renderItems() {
  const tb = $('#items');
  $('#empty').classList.toggle('hidden', state.items.length > 0);
  if (!state.items.length) $('#empty-text').textContent = state.q || state.filter !== 'all' ? 'Nic neodpovídá filtru.' : 'Sklad je zatím prázdný.';
  tb.innerHTML = state.items.map((it) => {
    const dot = statusDot(it);
    const u = esc(it.unit || 'ks');
    return `
    <tr data-code="${esc(it.code)}" class="${dot === 'zero' ? 'zero' : dot === 'low' ? 'low' : ''}">
      <td class="c-st"><span class="dot ${dot}" title="${dot === 'zero' ? 'Vyprodáno' : dot === 'low' ? 'Pod minimem' : 'OK'}"></span></td>
      <td class="c-img">${thumbHtml(it, 'thumb')}</td>
      <td class="c-code code">${esc(it.code)}</td>
      <td class="c-name"><input class="cell-input ${it.name ? '' : 'name-empty'}" data-f="name" value="${esc(it.name)}" placeholder="doplň název…" aria-label="Název položky"></td>
      <td class="c-loc" data-label="Umístění"><input class="cell-input loc" data-f="location" value="${esc(it.location)}" placeholder="—" aria-label="Umístění"></td>
      <td class="c-qty" data-label="Množství"><div class="qty-ctrl"><button data-act="dec" aria-label="Ubrat">−</button>
        <input class="qty-num ${it.quantity <= 0 ? 'zero' : ''}" data-f="quantity" type="number" step="any" value="${it.quantity}" aria-label="Množství (${u})">
        <button data-act="inc" aria-label="Přidat">+</button><span class="unit-tag">${u}</span></div></td>
      <td class="c-min" data-label="Min. zásoba"><input class="min-input" data-f="min_stock" type="number" min="0" step="any" value="${it.min_stock || 0}" aria-label="Minimální zásoba"></td>
      <td class="c-price" data-label="Cena/ks"><input class="price-input" data-f="price" type="number" min="0" step="0.01" value="${it.price || 0}" aria-label="Cena za ${u}"></td>
      <td class="c-act">
        <button class="iconbtn" data-act="detail" aria-label="Detail položky" title="Detail">${icon('info')}</button>
        <button class="iconbtn" data-act="label" aria-label="Tisk štítku" title="Tisk štítku">${icon('printer')}</button>
        <button class="iconbtn danger" data-act="del" aria-label="Smazat položku" title="Smazat">${icon('trash')}</button>
      </td>
    </tr>`;
  }).join('');
}
$('#items').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const code = btn.closest('tr').dataset.code;
  const item = state.items.find((i) => i.code === code); if (!item) return;
  const act = btn.dataset.act;
  if (act === 'inc' || act === 'dec') {
    const st = parseFloat(stepEl.value); const inc = Number.isFinite(st) && st > 0 ? st : 1;
    await patch(code, { quantity: round3c(item.quantity + (act === 'inc' ? inc : -inc)) });
  }
  else if (act === 'detail') openDetail(code);
  else if (act === 'label') printLabels([item]);
  else if (act === 'del') { if (confirm(`Smazat položku „${item.name || code}"?`)) { await api('/api/items/' + encodeURIComponent(code), { method: 'DELETE' }); toast('Smazáno', 'ok'); await Promise.all([loadItems(), loadSummary()]); } }
});
$('#items').addEventListener('change', async (e) => { const inp = e.target.closest('[data-f]'); if (!inp) return; await patch(inp.closest('tr').dataset.code, { [inp.dataset.f]: inp.value }); });
$('#items').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('[data-f]')) e.target.blur(); });
async function patch(code, body) {
  try { await api('/api/items/' + encodeURIComponent(code), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await Promise.all([loadItems(), loadSummary()]); }
  catch (err) { toast(err.message, 'err'); }
}

/* ---------- Historie ---------- */
const TYPE_LBL = { in: ['Příjem', 'type-in'], out: ['Výdej', 'type-out'], set: ['Inventura', 'type-set'] };
async function loadMovements() {
  let rows;
  try { rows = await api('/api/movements'); } catch (e) { if (e.status === 401) return; rows = []; }
  $('#empty-hist').classList.toggle('hidden', rows.length > 0);
  $('#movements').innerHTML = rows.map((m) => {
    const t = new Date(m.created_at).toLocaleString('cs-CZ');
    const [lbl, cls] = TYPE_LBL[m.type] || [m.type, ''];
    const dcls = m.delta >= 0 ? 'delta-in' : 'delta-out';
    return `<tr><td>${esc(t)}</td><td class="code">${esc(m.code)}</td><td>${esc(m.name || '—')}</td>
      <td><span class="type-badge ${cls}">${lbl}</span></td>
      <td class="c-qty ${dcls}">${m.delta >= 0 ? '+' : ''}${qfmt(m.delta)}</td>
      <td class="c-min"><strong>${qfmt(m.quantity_after)}</strong></td><td>${esc(m.user || '—')}</td></tr>`;
  }).join('');
}

/* ---------- Hledání + souhrn ---------- */
let searchT;
$('#search').addEventListener('input', (e) => { state.q = e.target.value.trim(); clearTimeout(searchT); searchT = setTimeout(loadItems, 200); });
async function loadSummary() {
  try {
    const s = await api('/api/summary');
    $('#stat-skus').textContent = s.skus; $('#stat-pieces').textContent = s.pieces;
    $('#stat-value').textContent = (Number(s.value) || 0).toLocaleString('cs-CZ', { maximumFractionDigits: 0 });
    $('#cur-label').textContent = cfg.currency;
    $('#stat-low').textContent = s.low; $('#chip-low').classList.toggle('alert', s.low > 0);
    $('#stat-zero').textContent = s.zero; $('#chip-zero').classList.toggle('alert', s.zero > 0);
  } catch {}
}

/* ---------- Tisk štítků (Code128) ---------- */
function labelHTML(it) {
  let svg;
  try { svg = window.Code128(it.code, { height: 64, module: 2 }); }
  catch { svg = '<div style="color:#b00020;font-size:11px;padding:14px 4px;line-height:1.3">⚠ Kód obsahuje znaky,<br>které nelze zakódovat.</div>'; }
  return `<div class="label"><div class="l-name">${esc(it.name || '(bez názvu)')}</div>${svg}<div class="l-code">${esc(it.code)}</div>${it.location ? `<div class="l-loc">📍 ${esc(it.location)}</div>` : ''}</div>`;
}
function printLabels(items) {
  if (!items || !items.length) { toast('Žádné položky k tisku', 'err'); return; }
  const css = `body{font-family:Inter,Arial,sans-serif;margin:0;padding:8px;background:#fff;color:#000}
    .label{display:inline-block;width:58mm;text-align:center;padding:8px;margin:4px;border:1px solid #ddd;border-radius:6px;page-break-inside:avoid;vertical-align:top}
    .l-name{font-size:13px;font-weight:700;margin-bottom:5px;min-height:34px;line-height:1.2}
    .l-code{font-family:monospace;font-size:12px;margin-top:3px;letter-spacing:1px}
    .l-loc{font-size:11px;color:#555;margin-top:2px}
    svg{max-width:100%;height:auto}@media print{.label{border:none}}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Štítky (${items.length})</title><style>${css}</style></head><body>${items.map(labelHTML).join('')}</body></html>`;
  const w = window.open('', '_blank', 'width=540,height=680');
  if (!w) { toast('Povol vyskakovací okna kvůli tisku', 'err'); return; }
  w.document.open(); w.document.write(html); w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch {} }, 400);
}

/* ---------- Detail položky ---------- */
async function openDetail(code) {
  const it = state.items.find((i) => i.code === code) || (await api('/api/items?q=' + encodeURIComponent(code))).find((x) => x.code === code);
  if (!it) return;
  const moves = await api('/api/movements?code=' + encodeURIComponent(code) + '&limit=50').catch(() => []);
  const thumb = thumbHtml(it, 'm-thumb');
  const histRows = moves.length ? moves.map((m) => { const [lbl, cls] = TYPE_LBL[m.type] || [m.type, '']; return `<tr><td>${esc(new Date(m.created_at).toLocaleString('cs-CZ'))}</td><td><span class="type-badge ${cls}">${lbl}</span></td><td class="${m.delta >= 0 ? 'delta-in' : 'delta-out'}">${m.delta >= 0 ? '+' : ''}${qfmt(m.delta)}</td><td><strong>${qfmt(m.quantity_after)}</strong></td><td>${esc(m.user || '')}</td></tr>`; }).join('') : '<tr><td style="color:var(--text-muted)">Žádné pohyby.</td></tr>';
  openModal(`
    <div class="modal-head">${thumb}
      <div><h3>${esc(it.name || 'Bez názvu')}</h3><div class="m-code">${esc(it.code)}</div>
      <div class="ls-sub" style="margin-top:6px">Hodnota skladem: <strong>${money((it.quantity || 0) * (it.price || 0))}</strong></div></div>
      <button class="modal-close" id="m-close" aria-label="Zavřít">✕</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="fld full"><label>Název</label><input id="d-name" value="${esc(it.name)}"></div>
        ${field('Značka', 'd-brand', it.brand)}${field('Kategorie', 'd-category', it.category)}
        ${field('Množství', 'd-quantity', it.quantity, 'number', 'step="any"')}${field('Min. zásoba', 'd-min_stock', it.min_stock || 0, 'number', 'min="0" step="any"')}
        ${field('Cena / ' + esc(it.unit || 'ks'), 'd-price', it.price || 0, 'number', 'min="0" step="0.01"')}${field('Jednotka', 'd-unit', it.unit || 'ks', 'text', 'list="units"')}
        ${field('Umístění', 'd-location', it.location)}${field('Dodavatel', 'd-supplier', it.supplier)}
        <div class="fld full"><label>Obrázek (URL)</label><input id="d-image_url" value="${esc(it.image_url)}"></div>
        <div class="fld full"><label>Poznámka</label><textarea id="d-note">${esc(it.note)}</textarea></div>
      </div>
      <div class="m-section-title">Historie pohybů</div>
      <div class="m-hist"><table>${histRows}</table></div>
      <div class="modal-actions">
        <button class="btn danger-btn" id="d-del">${icon('trash')} Smazat</button>
        <button class="btn" id="d-label">${icon('printer')} Štítek</button>
        <button class="btn" id="d-lookup">Dohledat</button>
        <span class="spacer"></span>
        <button class="btn" id="d-cancel">Zavřít</button>
        <button class="btn primary" id="d-save">Uložit</button>
      </div>
    </div>`);
  $('#m-close').onclick = $('#d-cancel').onclick = closeModal;
  $('#d-label').onclick = () => printLabels([it]);
  $('#d-save').onclick = async () => {
    const body = {}; for (const f of ['name', 'brand', 'category', 'unit', 'location', 'supplier', 'image_url', 'note', 'quantity', 'min_stock', 'price']) body[f] = $('#d-' + f).value;
    try { await api('/api/items/' + encodeURIComponent(it.code), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast('Uloženo', 'ok'); closeModal(); await Promise.all([loadItems(), loadSummary()]); }
    catch (err) { toast(err.message, 'err'); }
  };
  $('#d-del').onclick = async () => { if (!confirm('Opravdu smazat tuto položku?')) return; await api('/api/items/' + encodeURIComponent(it.code), { method: 'DELETE' }); toast('Smazáno', 'ok'); closeModal(); await Promise.all([loadItems(), loadSummary()]); };
  $('#d-lookup').onclick = async () => { const r = await api('/api/items/' + encodeURIComponent(it.code) + '/lookup', { method: 'POST' }); toast(r.found ? 'Doplněno' : 'Nic nenalezeno', r.found ? 'ok' : 'err'); closeModal(); openDetail(it.code); };
}

/* ---------- Ruční přidání ---------- */
$('#btn-add').addEventListener('click', () => {
  openModal(`
    <div class="modal-head"><div class="m-thumb">${icon('plus')}</div><div><h3>Přidat položku ručně</h3><div class="m-code">Kód můžeš nechat prázdný (vygeneruje se)</div></div><button class="modal-close" id="m-close" aria-label="Zavřít">✕</button></div>
    <div class="modal-body"><div class="form-grid">
      ${field('Čárový kód (volitelně)', 'a-code', '')}${field('Název', 'a-name', '')}
      ${field('Počáteční množství', 'a-quantity', 0, 'number', 'step="any"')}${field('Jednotka', 'a-unit', 'ks', 'text', 'list="units"')}
      ${field('Cena / ks', 'a-price', 0, 'number', 'min="0" step="0.01"')}${field('Min. zásoba', 'a-min_stock', 0, 'number', 'min="0" step="any"')}
      ${field('Umístění', 'a-location', '')}${field('Dodavatel', 'a-supplier', '')}
      <div class="fld full"><label>Poznámka</label><textarea id="a-note"></textarea></div>
    </div>
    <p class="hint">Když vyplníš jen kód a necháš název prázdný, appka ho zkusí dohledat na internetu.</p>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" id="a-cancel">Zrušit</button><button class="btn primary" id="a-save">Přidat</button></div></div>`);
  $('#m-close').onclick = $('#a-cancel').onclick = closeModal;
  $('#a-save').onclick = async () => {
    const body = {}; for (const f of ['code', 'name', 'unit', 'location', 'supplier', 'note', 'quantity', 'price', 'min_stock']) body[f] = $('#a-' + f).value;
    try { const r = await api('/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast(r.found ? 'Přidáno + dohledáno' : 'Přidáno', 'ok'); closeModal(); await Promise.all([loadItems(), loadSummary()]); }
    catch (err) { toast(err.message, 'err'); }
  };
  setTimeout(() => $('#a-code').focus(), 50);
});

/* ---------- Nastavení ---------- */
async function openSettings() {
  let adminHtml = '';
  if (currentUser.role === 'admin') {
    const [users, st] = await Promise.all([api('/api/users').catch(() => []), api('/api/settings').catch(() => ({}))]);
    const userRows = users.map((u) => `
      <div class="user-row"><span class="u-rname">${esc(u.display_name)}</span> <span class="code">${esc(u.username)}</span>
        <span class="u-role ${u.role}">${u.role === 'admin' ? 'admin' : 'uživatel'}</span><span class="spacer"></span>
        <button class="iconbtn" data-pw="${esc(u.username)}" aria-label="Nové heslo" title="Nové heslo">${icon('key')}</button>
        ${u.username !== currentUser.username ? `<button class="iconbtn danger" data-deluser="${esc(u.username)}" aria-label="Smazat uživatele" title="Smazat">${icon('trash')}</button>` : ''}
      </div>`).join('');
    adminHtml = `
      <div class="m-section-title">Uživatelé</div>
      <div id="users-list">${userRows}</div>
      <div class="form-grid" style="margin-top:8px">
        ${field('Jméno (login)', 'nu-username', '')}${field('Zobrazované jméno', 'nu-display', '')}
        ${field('Heslo', 'nu-pass', '', 'text')}
        <div class="fld"><label>Role</label><select id="nu-role"><option value="user">uživatel</option><option value="admin">admin</option></select></div>
      </div>
      <div class="modal-actions"><span class="spacer"></span><button class="btn" id="nu-add">${icon('plus')} Přidat uživatele</button></div>

      <div class="m-section-title">E-mailová upozornění (pod minimum)</div>
      <div class="switch-row"><div><div class="lab">Posílat upozornění e-mailem</div><div class="sub">Když zásoba klesne pod minimum</div></div><input id="ml-enabled" type="checkbox" aria-label="Posílat upozornění e-mailem" ${st.enabled ? 'checked' : ''}></div>
      <div class="form-grid">
        ${field('SMTP server', 'ml-host', st.host || '')}${field('Port', 'ml-port', st.port || 587, 'number')}
        ${field('Uživatel', 'ml-user', st.user || '')}${field('Heslo', 'ml-pass', '', 'password', st.has_pass ? 'placeholder="•••••• (uloženo)"' : '')}
        ${field('Odesílatel (From)', 'ml-from', st.from || '')}${field('Příjemce upozornění', 'ml-to', st.to || '')}
      </div>
      <div class="switch-row"><div><div class="lab">SSL/TLS (port 465)</div></div><input id="ml-secure" type="checkbox" aria-label="SSL/TLS" ${st.secure ? 'checked' : ''}></div>
      <div class="modal-actions"><button class="btn" id="ml-test">Poslat test</button><button class="btn" id="ml-report">Poslat report teď</button><span class="spacer"></span><button class="btn primary" id="ml-save">Uložit e-mail</button></div>`;
  }
  openModal(`
    <div class="modal-head"><div class="m-thumb">${icon('settings')}</div><div><h3>Nastavení</h3><div class="m-code">Přihlášen: ${esc(currentUser.display_name)} (${esc(currentUser.username)})</div></div><button class="modal-close" id="m-close" aria-label="Zavřít">✕</button></div>
    <div class="modal-body">
      <div class="m-section-title">Můj účet</div>
      <div class="form-grid">
        <div class="fld"><label>Nové heslo</label><input id="ac-pass" type="password" placeholder="••••"></div>
        <div class="fld" style="justify-content:flex-end"><button class="btn" id="ac-pass-btn">Změnit heslo</button></div>
      </div>
      <div class="modal-actions"><button class="btn danger-btn" id="ac-logout">${icon('logout')} Odhlásit se</button><span class="spacer"></span></div>

      <div class="m-section-title">Vzhled a chování</div>
      <div class="form-grid">${field('Měna', 's-currency', cfg.currency)}<div class="fld"></div></div>
      <div class="switch-row"><div><div class="lab">Zvuková odezva</div><div class="sub">Pípnutí při skenu</div></div><input id="s-sound" type="checkbox" aria-label="Zvuková odezva" ${cfg.sound ? 'checked' : ''}></div>
      <div class="switch-row"><div><div class="lab">Tmavý režim</div></div><input id="s-theme" type="checkbox" aria-label="Tmavý režim" ${cfg.theme === 'dark' ? 'checked' : ''}></div>
      <div class="m-section-title">Citlivost čtečky (pokročilé)</div>
      <div class="form-grid">${field('Odmlka = konec skenu (ms)', 's-silenceMs', cfg.silenceMs, 'number', 'min="30" max="500"')}${field('Práh rychlosti (ms/znak)', 's-fastAvg', cfg.fastAvg, 'number', 'min="20" max="300"')}</div>
      <p class="hint">Když se sken neodesílá sám, zvyš „práh rychlosti". Když se odešle při ručním psaní, sniž ho.</p>
      ${adminHtml}
      <div class="modal-actions"><span class="spacer"></span><button class="btn" id="s-cancel">Zavřít</button><button class="btn primary" id="s-save">Uložit nastavení</button></div>
    </div>`);
  $('#m-close').onclick = $('#s-cancel').onclick = closeModal;
  $('#ac-logout').onclick = logout;
  $('#ac-pass-btn').onclick = async () => {
    const pw = $('#ac-pass').value; if (pw.length < 6) return toast('Heslo musí mít aspoň 6 znaků', 'err');
    try { await api('/api/me/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) }); toast('Heslo změněno', 'ok'); $('#ac-pass').value = ''; }
    catch (err) { toast(err.message, 'err'); }
  };
  $('#s-save').onclick = () => {
    cfg.currency = $('#s-currency').value.trim() || 'Kč';
    cfg.sound = $('#s-sound').checked; cfg.theme = $('#s-theme').checked ? 'dark' : 'light';
    cfg.silenceMs = Math.min(500, Math.max(30, parseInt($('#s-silenceMs').value, 10) || DEF.silenceMs));
    cfg.fastAvg = Math.min(300, Math.max(20, parseInt($('#s-fastAvg').value, 10) || DEF.fastAvg));
    saveCfg(); applyTheme(); loadSummary(); toast('Nastavení uloženo', 'ok'); closeModal();
  };
  if (currentUser.role === 'admin') wireAdminSettings();
}
function wireAdminSettings() {
  $('#nu-add').onclick = async () => {
    try {
      await api('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#nu-username').value.trim(), display_name: $('#nu-display').value.trim(), password: $('#nu-pass').value, role: $('#nu-role').value }) });
      toast('Uživatel přidán', 'ok'); openSettings();
    } catch (err) { toast(err.message, 'err'); }
  };
  $$('[data-deluser]').forEach((b) => b.onclick = async () => { if (!confirm(`Smazat uživatele ${b.dataset.deluser}?`)) return; try { await api('/api/users/' + encodeURIComponent(b.dataset.deluser), { method: 'DELETE' }); toast('Smazáno', 'ok'); openSettings(); } catch (err) { toast(err.message, 'err'); } });
  $$('[data-pw]').forEach((b) => b.onclick = async () => { const pw = prompt('Nové heslo pro ' + b.dataset.pw + ':'); if (!pw) return; try { await api('/api/users/' + encodeURIComponent(b.dataset.pw) + '/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) }); toast('Heslo změněno', 'ok'); } catch (err) { toast(err.message, 'err'); } });
  const saveMail = async () => api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: $('#ml-enabled').checked, host: $('#ml-host').value.trim(), port: parseInt($('#ml-port').value, 10) || 587, secure: $('#ml-secure').checked, user: $('#ml-user').value.trim(), pass: $('#ml-pass').value, from: $('#ml-from').value.trim(), to: $('#ml-to').value.trim() }) });
  $('#ml-save').onclick = async () => { try { await saveMail(); toast('Nastavení e-mailu uloženo', 'ok'); } catch (err) { toast(err.message, 'err'); } };
  $('#ml-test').onclick = async () => { try { await saveMail(); await api('/api/alert/test', { method: 'POST' }); toast('Testovací e-mail odeslán', 'ok'); } catch (err) { toast(err.message, 'err'); } };
  $('#ml-report').onclick = async () => { try { await saveMail(); const r = await api('/api/alert/report', { method: 'POST' }); toast(`Report odeslán (${r.count} položek)`, 'ok'); } catch (err) { toast(err.message, 'err'); } };
}
$('#btn-settings').addEventListener('click', openSettings);
$('#op-badge').addEventListener('click', openSettings);

/* ---------- Export menu / štítky / obnova ---------- */
const exportMenu = $('#export-menu');
exportMenu.addEventListener('click', (e) => { if (e.target.closest('a')) exportMenu.open = false; });
document.addEventListener('click', (e) => { if (exportMenu.open && !exportMenu.contains(e.target)) exportMenu.open = false; });
$('#btn-labels').addEventListener('click', () => { exportMenu.open = false; printLabels(state.items); });
$('#btn-restore').addEventListener('click', () => { exportMenu.open = false; $('#restore-file').click(); });
$('#restore-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const cnt = Array.isArray(data.items) ? data.items.length : 0;
    if (!confirm(`Obnovit ze zálohy? PŘEPÍŠE současný sklad (${cnt} položek ze souboru).`)) { e.target.value = ''; return; }
    await api('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    toast('Sklad obnoven ze zálohy', 'ok'); await Promise.all([loadItems(), loadSummary()]);
  } catch (err) { toast('Obnova selhala: ' + err.message, 'err'); }
  e.target.value = '';
});

/* ---------- Focus na skenovací pole ---------- */
function focusScan() {
  if (scanEl.disabled || !$('#overlay').classList.contains('hidden')) return;
  const ae = document.activeElement;
  if (ae && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName) && ae !== scanEl) return;
  scanEl.focus();
}
scanEl.addEventListener('focus', () => fieldEl.classList.add('focus'));
scanEl.addEventListener('blur', () => fieldEl.classList.remove('focus'));
document.addEventListener('click', (e) => {
  if (e.target.closest('input, button, a, select, textarea, summary, label, .modal, .panel, .toolbar, .sidebar, .stats')) return;
  focusScan();
});

/* ---------- Start ---------- */
boot();

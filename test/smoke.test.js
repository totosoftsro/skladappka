'use strict';

// Smoke testy: nastartují vlastní instanci serveru na dočasné databázi
// (DATA_DIR=tmp, DISABLE_LOOKUP=1 → žádný internet) a projedou celé API.
// Spuštění: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let PORT, B;
let proc;
let cookie = '';
let adminPassword = '';
let tmpDir;

// volný port za běhu – žádné kolize mezi paralelními běhy
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

function api(p, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json', Cookie: cookie }, opts.headers);
  return fetch(B + p, opts);
}
async function json(p, opts) { const r = await api(p, opts); return { status: r.status, body: await r.json() }; }

before(async () => {
  PORT = await freePort();
  B = `http://127.0.0.1:${PORT}`;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sklad-test-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: tmpDir, DISABLE_LOOKUP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; }); // ať je případná chyba startu vidět

  // počkej na server i na vypsané heslo admina
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { const r = await fetch(B + '/healthz'); ready = r.ok && /Heslo:/.test(out); } catch {}
    if (!ready) await new Promise((s) => setTimeout(s, 100));
  }
  assert.ok(ready, 'server nastartoval a vypsal heslo. Výstup:\n' + out);

  const m = out.match(/Heslo:\s+(\S+)/);
  assert.ok(m, 'heslo nalezeno ve výstupu');
  adminPassword = m[1];
  const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: adminPassword }) });
  assert.strictEqual(r.status, 200, 'login se seedovaným heslem');
  cookie = r.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  if (proc && proc.exitCode === null) {
    proc.kill('SIGTERM');
    await Promise.race([once(proc, 'exit'), new Promise((s) => setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} s(); }, 2000))]);
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('healthz vrací ok + správnou verzi z package.json', async () => {
  const r = await (await fetch(B + '/healthz')).json();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, require('../package.json').version);
});

test('index.html se servíruje a odkazované assety vrací 200', async () => {
  const html = await (await fetch(B + '/')).text();
  assert.match(html, /<title>/);
  for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:css|js|svg|json))(?:\?[^"]*)?"/gi)) {
    let url = m[1].split('?')[0];
    if (/^https?:\/\//.test(url)) continue;           // externí (fonty) neřešíme
    if (!url.startsWith('/')) url = '/' + url;         // relativní → kořen
    if (url.startsWith('/api/')) continue;             // API endpointy vyžadují auth, nejsou to statické assety
    const res = await fetch(B + url);
    assert.strictEqual(res.status, 200, 'asset ' + url);
  }
});

test('API bez přihlášení vrací 401', async () => {
  const r = await fetch(B + '/api/items');
  assert.strictEqual(r.status, 401);
});

test('odhlášení zneplatní sezení (na vlastní cookie, sdílenou nerušíme)', async () => {
  const login = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: adminPassword }) });
  const c2 = login.headers.get('set-cookie').split(';')[0];
  let me = await fetch(B + '/api/me', { headers: { Cookie: c2 } });
  assert.strictEqual(me.status, 200);
  await fetch(B + '/api/logout', { method: 'POST', headers: { Cookie: c2 } });
  me = await fetch(B + '/api/me', { headers: { Cookie: c2 } });
  assert.strictEqual(me.status, 401);
});

test('neplatný JSON vrací JSON 400', async () => {
  const r = await api('/api/login', { method: 'POST', body: '{bad' });
  assert.strictEqual(r.status, 400);
  assert.match(r.headers.get('content-type'), /json/);
});

test('neznámý endpoint vrací JSON 404', async () => {
  const { status, body } = await json('/api/neexistuje');
  assert.strictEqual(status, 404);
  assert.ok(body.error);
});

test('sken: příjem s desetinným krokem', async () => {
  const { status, body } = await json('/api/scan', { method: 'POST', body: JSON.stringify({ code: 'T-001', mode: 'in', step: 2.5 }) });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.item.quantity, 2.5);
  assert.strictEqual(body.lookedUp, true);
  assert.strictEqual(body.found, false); // lookup vypnutý
});

test('sken: výdej a výdej do mínusu', async () => {
  let r = await json('/api/scan', { method: 'POST', body: JSON.stringify({ code: 'T-001', mode: 'out', step: 1 }) });
  assert.strictEqual(r.body.item.quantity, 1.5);
  r = await json('/api/scan', { method: 'POST', body: JSON.stringify({ code: 'T-001', mode: 'out', step: 5 }) });
  assert.strictEqual(r.body.item.quantity, -3.5);
});

test('sken: inventura (set) s desetinnou hodnotou', async () => {
  const { body } = await json('/api/scan', { method: 'POST', body: JSON.stringify({ code: 'T-001', mode: 'set', value: 10.25 }) });
  assert.strictEqual(body.item.quantity, 10.25);
  assert.strictEqual(body.delta, 13.75);
});

test('undo vrátí poslední pohyb', async () => {
  const { body } = await json('/api/undo', { method: 'POST' });
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.item.quantity, -3.5);
  // vrátit zpět na 10.25 pro další testy
  await json('/api/scan', { method: 'POST', body: JSON.stringify({ code: 'T-001', mode: 'set', value: 10.25 }) });
});

test('PATCH: jednotka, cena, min. zásoba; nekonečná cena → 0', async () => {
  let { body } = await json('/api/items/T-001', { method: 'PATCH', body: JSON.stringify({ unit: 'm', price: 12.5, min_stock: 20, name: 'Testovací metráž' }) });
  assert.strictEqual(body.unit, 'm');
  assert.strictEqual(body.price, 12.5);
  ({ body } = await json('/api/items/T-001', { method: 'PATCH', body: JSON.stringify({ price: '1e309' }) }));
  assert.strictEqual(body.price, 0);
});

test('zlomyslné image_url se zahodí, platné projde', async () => {
  let { body } = await json('/api/items/T-001', { method: 'PATCH', body: JSON.stringify({ image_url: "https://x/a.jpg');evil" }) });
  assert.strictEqual(body.image_url, '');
  ({ body } = await json('/api/items/T-001', { method: 'PATCH', body: JSON.stringify({ image_url: 'https://example.com/a.jpg' }) }));
  assert.strictEqual(body.image_url, 'https://example.com/a.jpg');
});

test('filtr low + souhrn počítá hodnotu', async () => {
  const { body: items } = await json('/api/items?filter=low');
  assert.ok(items.some((i) => i.code === 'T-001'), 'T-001 je pod minimem (10.25 < 20)');
  const { body: s } = await json('/api/summary');
  assert.strictEqual(s.low, 1);
  assert.strictEqual(s.value, 0); // cena je po testu Infinity→0
});

test('ruční přidání bez kódu vygeneruje MAN-…; duplicitní kód → 409', async () => {
  const { body } = await json('/api/items', { method: 'POST', body: JSON.stringify({ name: 'Ruční položka', quantity: 3 }) });
  assert.match(body.item.code, /^MAN-/);
  const dup = await json('/api/items', { method: 'POST', body: JSON.stringify({ code: 'T-001', name: 'dup' }) });
  assert.strictEqual(dup.status, 409);
});

test('CSV export: BOM, hlavička, ochrana proti formula injection', async () => {
  await json('/api/items', { method: 'POST', body: JSON.stringify({ code: 'CSV-1', name: '=EVIL()' }) });
  const buf = Buffer.from(await (await api('/api/export.csv')).arrayBuffer());
  assert.deepStrictEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'začíná UTF-8 BOM');
  const txt = buf.toString('utf8').replace(/^﻿/, '');
  assert.match(txt, /^Kód;Název/);
  assert.match(txt, /CSV-1;'=EVIL\(\)/, 'vzorec je neutralizovaný apostrofem');
});

test('záloha → obnova (round-trip)', async () => {
  const backup = await (await api('/api/backup.json')).json();
  const n = backup.items.length;
  const { body } = await json('/api/restore', { method: 'POST', body: JSON.stringify(backup) });
  assert.strictEqual(body.count, n);
  const { body: s } = await json('/api/summary');
  assert.strictEqual(s.skus, n);
});

test('uživatelé: slabé heslo 400, operátor nemá admin práva, ale smí pracovat', async () => {
  let r = await json('/api/users', { method: 'POST', body: JSON.stringify({ username: 'op', password: 'abc' }) });
  assert.strictEqual(r.status, 400);
  r = await json('/api/users', { method: 'POST', body: JSON.stringify({ username: 'op', display_name: 'Operátor', password: 'heslo123', role: 'user' }) });
  assert.strictEqual(r.status, 200);

  const login = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'op', password: 'heslo123' }) });
  const opCookie = login.headers.get('set-cookie').split(';')[0];
  const forbidden = await fetch(B + '/api/users', { headers: { Cookie: opCookie } });
  assert.strictEqual(forbidden.status, 403);
  const restoreForbidden = await fetch(B + '/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: opCookie }, body: '{"items":[]}' });
  assert.strictEqual(restoreForbidden.status, 403);
  const scan = await fetch(B + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: opCookie }, body: JSON.stringify({ code: 'T-001', mode: 'in' }) });
  assert.strictEqual(scan.status, 200);
  const { body: moves } = await json('/api/movements?code=T-001&limit=1');
  assert.strictEqual(moves[0].user, 'Operátor', 'pohyb nese jméno operátora');
});

test('změna hesla zneplatní stará sezení', async () => {
  const login = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'op', password: 'heslo123' }) });
  const opCookie = login.headers.get('set-cookie').split(';')[0];
  await json('/api/users/op/password', { method: 'POST', body: JSON.stringify({ password: 'jine-heslo1' }) });
  const me = await fetch(B + '/api/me', { headers: { Cookie: opCookie } });
  assert.strictEqual(me.status, 401);
});

test('smazání položky: 200, podruhé 404', async () => {
  let r = await api('/api/items/CSV-1', { method: 'DELETE' });
  assert.strictEqual(r.status, 200);
  r = await api('/api/items/CSV-1', { method: 'DELETE' });
  assert.strictEqual(r.status, 404);
});

test('QR endpoint vrací SVG', async () => {
  const r = await api('/api/qr.svg?text=4006381333931');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /svg/);
  assert.match(await r.text(), /^<svg/);
});

test('CSV import: zalozi/aktualizuje/preskoci + kategorie + filtr', async () => {
  const rows = [
    { code: 'IMP-1', name: 'Polozka 1', quantity: '10', unit: 'ks', category: 'TestKat', min_stock: '3' },
    { code: 'IMP-2', name: 'Polozka 2', quantity: '2.5', unit: 'm', category: 'TestKat' },
    { code: '', name: 'bez kodu' },
    { code: 'IMP-1', min_stock: '7' },
  ];
  const r = await json('/api/import', { method: 'POST', body: JSON.stringify({ rows }) });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.created, r.body.updated, r.body.skipped], [2, 1, 1]);
  const it = (await json('/api/items?q=IMP-1')).body.find((x) => x.code === 'IMP-1');
  assert.strictEqual(it.quantity, 10);
  assert.strictEqual(it.min_stock, 7);
  const cats = (await json('/api/categories')).body;
  assert.ok(cats.some((c) => c.category === 'TestKat' && c.n === 2));
  assert.strictEqual((await json('/api/items?category=TestKat')).body.length, 2);
  await api('/api/items/IMP-1', { method: 'DELETE' });
  await api('/api/items/IMP-2', { method: 'DELETE' });
});

test('import je jen pro admina (operator 403)', async () => {
  await json('/api/users', { method: 'POST', body: JSON.stringify({ username: 'imp-op', display_name: 'Imp Op', password: 'heslo123', role: 'user' }) });
  const login = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'imp-op', password: 'heslo123' }) });
  const c = login.headers.get('set-cookie').split(';')[0];
  const r = await fetch(B + '/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c }, body: JSON.stringify({ rows: [] }) });
  assert.strictEqual(r.status, 403);
  await api('/api/users/imp-op', { method: 'DELETE' });
});

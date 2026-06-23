'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const lookup = require('../lookup');
const backup = require('../backup');
const L = lookup._internals;

// ───────────────────────── lookup: čisté funkce ─────────────────────────
test('clean: string / číslo / pole / lokalizovaný objekt', () => {
  assert.equal(L.clean('  ahoj   světe '), 'ahoj světe');
  assert.equal(L.clean(42), '42');
  assert.equal(L.clean(['', '  ', 'Vrták']), 'Vrták'); // přeskočí prázdné
  assert.equal(L.clean({ cs: 'Čeština', en: 'Czech' }), 'Čeština');
  assert.equal(L.clean({ en: 'OnlyEN' }), 'OnlyEN');
  assert.equal(L.clean(null), '');
  assert.equal(L.clean(undefined), '');
});

test('isIsbn rozpozná ISBN, ne EAN', () => {
  assert.equal(L.isIsbn('9780306406157'), true);
  assert.equal(L.isIsbn('030640615X'), true);
  assert.equal(L.isIsbn('8594001234567'), false);
  assert.equal(L.isIsbn('abc'), false);
});

test('httpsUrl povýší http na https', () => {
  assert.equal(L.httpsUrl('http://x/y.jpg'), 'https://x/y.jpg');
  assert.equal(L.httpsUrl('https://a/b'), 'https://a/b');
  assert.equal(L.httpsUrl(''), '');
});

test('dget/pick: tečkové cesty vč. indexu pole', () => {
  const o = { a: { b: 'X' }, images: ['p.jpg', 'q.jpg'] };
  assert.equal(L.dget(o, 'a.b'), 'X');
  assert.equal(L.dget(o, 'images.0'), 'p.jpg');
  assert.equal(L.dget(o, 'a.nope'), undefined);
  assert.equal(L.pick(o, ['z', 'a.b']), 'X');     // první neprázdná
  assert.equal(L.pick(o, ['z', 'nic']), '');
});

test('score: vyšší priorita / obrázek / značka boduje výš', () => {
  const a = { name: 'A', image_url: 'x', brand: 'b' };
  const b = { name: 'A', image_url: '', brand: '' };
  assert.ok(L.score(a, 5) > L.score(b, 5));
  assert.ok(L.score(b, 8) > L.score(a, 5)); // priorita převáží
});

// ───────────────────────── lookup: vlastní/placený zdroj ────────────────
test('fromCustom: mapuje pole odpovědi přes BARCODE_API_MAP', async () => {
  const origFetch = global.fetch;
  process.env.BARCODE_API_URL = 'https://example.test/lookup?ean={code}';
  process.env.BARCODE_API_MAP = JSON.stringify({ name: 'result.productName', image: 'result.photo' });
  let calledUrl = '';
  global.fetch = async (url) => {
    calledUrl = url;
    return { ok: true, json: async () => ({ result: { productName: 'Test Produkt', photo: 'http://img.test/p.jpg' } }) };
  };
  try {
    const r = await L.fromCustom('8594001234567');
    assert.ok(calledUrl.includes('ean=8594001234567'), 'kód se dosadil do {code}');
    assert.equal(r.name, 'Test Produkt');
    assert.equal(r.image_url, 'https://img.test/p.jpg'); // povýšeno na https
    assert.equal(r.source, 'Externí katalog');
  } finally {
    global.fetch = origFetch;
    delete process.env.BARCODE_API_URL;
    delete process.env.BARCODE_API_MAP;
  }
});

test('fromCustom: zvládne odpověď jako pole i výchozí pole', async () => {
  const origFetch = global.fetch;
  process.env.BARCODE_API_URL = 'https://example.test/{code}';
  global.fetch = async () => ({ ok: true, json: async () => ([{ title: 'Pole Produkt', brand: 'ACME' }]) });
  try {
    const r = await L.fromCustom('123');
    assert.equal(r.name, 'Pole Produkt'); // výchozí 'title'
    assert.equal(r.brand, 'ACME');        // výchozí 'brand'
  } finally {
    global.fetch = origFetch;
    delete process.env.BARCODE_API_URL;
  }
});

test('fromCustom: bez konfigurace vrací null', async () => {
  delete process.env.BARCODE_API_URL;
  assert.equal(await L.fromCustom('123'), null);
});

test('lookupProduct: prázdný i přerostlý kód → null (bez sítě)', async () => {
  delete process.env.BARCODE_API_URL;
  assert.equal(await lookup.lookupProduct(''), null);
  assert.equal(await lookup.lookupProduct('x'.repeat(65)), null);
});

// ───────────────────────── zálohy ───────────────────────────────────────
test('runBackup: vytvoří konzistentní snapshot, který jde přečíst', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sklad-bak-'));
  const db = new Database(path.join(dir, 'sklad.db'));
  try {
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (x INTEGER)');
    db.prepare('INSERT INTO t VALUES (?)').run(42);

    const dest = await backup.runBackup(db, dir, 14);
    assert.ok(fs.existsSync(dest), 'soubor zálohy existuje');
    assert.match(path.basename(dest), /^sklad-\d{8}-\d{6}\.db$/);

    const b = new Database(dest, { readonly: true });
    assert.equal(b.prepare('SELECT x FROM t').get().x, 42);
    b.close();
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prune: nechá jen posledních N záloh (nejnovější)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sklad-prune-'));
  const dir = backup.backupsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(dir, `sklad-2024010${i}-000000.db`), 'x');
    fs.writeFileSync(path.join(dir, 'neco-jineho.txt'), 'x'); // cizí soubor se nepočítá ani nemaže

    const removed = backup.prune(dir, 2);
    assert.equal(removed, 3);
    const left = backup.listBackups(dir);
    assert.deepEqual(left, ['sklad-20240104-000000.db', 'sklad-20240105-000000.db']);
    assert.ok(fs.existsSync(path.join(dir, 'neco-jineho.txt')), 'cizí soubor zůstal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

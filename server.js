'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const compression = require('compression');
const { db, initDb } = require('./db');
const { lookupProduct } = require('./lookup');
const auth = require('./auth');
const mail = require('./mail');

const VERSION = require('./package.json').version;
const PORT = Number(process.env.PORT) || 3000;
const useTls = !!(process.env.TLS_KEY && process.env.TLS_CERT);
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1');

// ---- Bezpečnostní hlavičky ----
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "script-src 'self'",
  "connect-src 'self'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CSP);
  if (useTls) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

app.use(compression());
// Tělo: malý limit globálně, velký jen pro obnovu zálohy (a GET/HEAD vůbec neparsujeme)
const jsonSmall = express.json({ limit: '256kb' });
const jsonLarge = express.json({ limit: '64mb' });
const BIG_BODY = new Set(['/api/restore', '/api/import']);
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return (BIG_BODY.has(req.path) ? jsonLarge : jsonSmall)(req, res, next);
});
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  // CSRF obrana navíc k SameSite=Lax: měnící požadavky musí mít shodný Origin/Referer host
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const o = req.get('origin') || req.get('referer');
    if (o) { try { if (new URL(o).host !== req.get('host')) return res.status(403).json({ error: 'Neplatný původ požadavku' }); } catch { return res.status(403).json({ error: 'Neplatný původ požadavku' }); } }
  }
  next();
});
// no-cache = prohlížeč si soubor vždy ověří přes ETag (304 = levné) → po update serveru
// nikdy nemíchá staré CSS/JS s novým HTML
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

initDb();
auth.cleanupSessions();
const seeded = auth.seedAdmin();

// Periodická údržba: úklid expirovaných sezení (denně) a zápis WAL (hodinově)
setInterval(() => { try { auth.cleanupSessions(); } catch {} }, 24 * 3600 * 1000).unref();
setInterval(() => { try { db.pragma('wal_checkpoint(PASSIVE)'); } catch {} }, 3600 * 1000).unref();

const nowIso = () => new Date().toISOString();
const round3 = (n) => { const x = Number(n); return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : 0; };
const money2 = (n) => { const x = Number(n); return Number.isFinite(x) && x > 0 ? Math.round(x * 100) / 100 : 0; };

// Bezpečné URL obrázku – jen http(s), bez znaků, které by rozbily CSS url() / atribut
function sanitizeImageUrl(u) {
  const s = String(u || '').trim();
  if (!s || !/^https?:\/\//i.test(s) || /[\s'"()\\<>]/.test(s)) return '';
  return s.slice(0, 2048);
}
// Express wrapper, aby se chyby z async handlerů dostaly do error middleware (nepadne proces)
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- Omezení pokusů o přihlášení (brute-force) – per IP i per uživatel ----
const loginHits = new Map(); // key -> { count, ts }
const WINDOW = 15 * 60000, MAX_FAILS = 10;
function sweepLoginHits() { const now = Date.now(); for (const [k, r] of loginHits) if (now - r.ts >= WINDOW) loginHits.delete(k); }
function loginBlocked(key) { const r = loginHits.get(key); return !!(r && Date.now() - r.ts < WINDOW && r.count >= MAX_FAILS); }
function recordFail(key) {
  if (loginHits.size > 2000) sweepLoginHits(); // strop proti zaplavení paměti náhodnými jmény
  const r = loginHits.get(key);
  if (r && Date.now() - r.ts < WINDOW) r.count++; else loginHits.set(key, { count: 1, ts: Date.now() });
}
function clearFails(...keys) { keys.forEach((k) => loginHits.delete(k)); }
setInterval(sweepLoginHits, WINDOW).unref();

const getItem = db.prepare('SELECT * FROM items WHERE code = ?');
const ITEM_TEXT_FIELDS = ['name', 'brand', 'category', 'location', 'note', 'supplier', 'unit', 'image_url'];

function logMovement(code, name, delta, type, qtyAfter, user) {
  return db.prepare(
    `INSERT INTO movements (code, name, delta, type, quantity_after, user, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(code, name, delta, type, qtyAfter, user || '', nowIso()).lastInsertRowid;
}
// DISABLE_LOOKUP=1 vypne dohledávání na internetu (offline provoz, testy)
async function lookupSafe(code) {
  if (process.env.DISABLE_LOOKUP === '1') return null;
  try { return await lookupProduct(code); } catch { return null; }
}

function checkCrossing(beforeQty, beforeMin, afterItem) {
  const wasLow = beforeMin > 0 && beforeQty < beforeMin;
  const nowLow = afterItem.min_stock > 0 && afterItem.quantity < afterItem.min_stock;
  if (nowLow && !wasLow) mail.maybeAlertCrossing(afterItem); // fire & forget
}

/* ===================== AUTENTIZACE (veřejné) ===================== */
app.use(auth.authMiddleware);

app.post('/api/login', (req, res) => {
  const ipKey = 'ip:' + (req.ip || 'unknown');
  const userKey = 'u:' + String(req.body.username || '').slice(0, 40).toLowerCase();
  if (loginBlocked(ipKey) || loginBlocked(userKey)) {
    return res.status(429).json({ error: 'Příliš mnoho pokusů o přihlášení. Zkuste to za 15 minut.' });
  }
  const r = auth.login(req.body.username, req.body.password);
  if (!r) { recordFail(ipKey); recordFail(userKey); return res.status(401).json({ error: 'Špatné jméno nebo heslo' }); }
  clearFails(ipKey, userKey);
  res.cookie('sid', r.token, { httpOnly: true, sameSite: 'lax', secure: useTls || process.env.TRUST_PROXY === '1', path: '/', maxAge: 30 * 864e5 });
  res.json({ user: r.user });
});
app.post('/api/logout', (req, res) => { auth.logout(req.token); res.clearCookie('sid'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Nepřihlášeno' });
  res.json({ user: auth.publicUser(req.user) });
});
// Změna vlastního hesla
app.post('/api/me/password', auth.requireAuth, (req, res) => {
  if (!auth.verifyPassword(String(req.body.current || ''), req.user.salt, req.user.pass_hash)) {
    return res.status(403).json({ error: 'Špatné stávající heslo' });
  }
  try { auth.setPassword(req.user.username, String(req.body.password || '')); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Health-check (bez přihlášení) – pro monitoring / supervisor
app.get('/healthz', (req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true, version: VERSION, time: nowIso() }); }
  catch (e) { res.status(500).json({ ok: false }); }
});

/* ===================== Od teď vše vyžaduje přihlášení ===================== */
app.use('/api', auth.requireAuth);

/* ---- Seznam položek ---- */
app.get('/api/items', (req, res) => {
  const q = String(req.query.q || '').trim();
  const filter = String(req.query.filter || 'all');
  const sortMap = { name: 'name', code: 'code', quantity: 'quantity', price: 'price', updated: 'updated_at', value: '(quantity*price)' };
  const sort = sortMap[req.query.sort] || 'updated_at';
  const dir = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const category = String(req.query.category || '').trim();
  const where = [], params = [];
  if (q) { where.push('(code LIKE ? OR name LIKE ? OR brand LIKE ? OR location LIKE ? OR supplier LIKE ?)'); const l = `%${q}%`; params.push(l, l, l, l, l); }
  if (filter === 'low') where.push('min_stock > 0 AND quantity < min_stock');
  else if (filter === 'zero') where.push('quantity <= 0');
  if (category) { where.push('category = ?'); params.push(category); }
  const sql = 'SELECT * FROM items' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ` ORDER BY ${sort} ${dir}, name ASC`;
  res.json(db.prepare(sql).all(...params));
});

/* ---- Kategorie (pro filtr) ---- */
app.get('/api/categories', (req, res) => {
  res.json(db.prepare("SELECT category, COUNT(*) AS n FROM items WHERE category != '' GROUP BY category ORDER BY category").all());
});

/* ---- Sken: příjem / výdej / inventura ---- */
app.post('/api/scan', wrap(async (req, res) => {
  const code = String(req.body.code || '').trim();
  const mode = ['in', 'out', 'set'].includes(req.body.mode) ? req.body.mode : 'in';
  if (!code) return res.status(400).json({ error: 'Chybí kód' });
  if (code.length > 128) return res.status(400).json({ error: 'Kód je příliš dlouhý' });

  // Dohledání běží mimo transakci (je asynchronní) a jen u nové položky
  let lookedUp = false, found = false, info = null;
  if (!getItem.get(code)) { info = await lookupSafe(code); lookedUp = true; found = !!(info && info.name); }

  const user = req.user.display_name;
  // get-or-create + update atomicky, ať se souběžné skeny nepřepisují
  const result = db.transaction(() => {
    let it = getItem.get(code), created = false;
    if (!it) {
      const ts = nowIso();
      const r = db.prepare(`INSERT INTO items (code, name, brand, category, image_url, quantity, source, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT(code) DO NOTHING`)
        .run(code, info?.name || '', info?.brand || '', info?.category || '', sanitizeImageUrl(info?.image_url), info?.source || '', ts, ts);
      created = r.changes > 0;
      it = getItem.get(code);
    }
    let delta;
    if (mode === 'set') {
      const target = Number(req.body.value);
      if (!Number.isFinite(target)) { const e = new Error('Neplatný stav'); e.status = 400; throw e; }
      delta = round3(target - it.quantity);
    } else {
      const s = Number(req.body.step);
      delta = round3(mode === 'out' ? -(Number.isFinite(s) && s > 0 ? s : 1) : (Number.isFinite(s) && s > 0 ? s : 1));
    }
    const newQty = round3(it.quantity + delta);
    db.prepare('UPDATE items SET quantity = ?, updated_at = ? WHERE code = ?').run(newQty, nowIso(), code);
    const movementId = logMovement(code, it.name, delta, mode, newQty, user);
    return { beforeQty: it.quantity, beforeMin: it.min_stock, delta, movementId, created };
  })();

  const updated = getItem.get(code);
  if (updated.quantity < result.beforeQty) checkCrossing(result.beforeQty, result.beforeMin, updated);
  res.json({ item: updated, lookedUp, found, delta: result.delta, movementId: Number(result.movementId), created: result.created });
}));

/* ---- Ruční přidání ---- */
app.post('/api/items', wrap(async (req, res) => {
  let code = String(req.body.code || '').trim();
  if (code.length > 128) return res.status(400).json({ error: 'Kód je příliš dlouhý' });
  if (!code) code = 'MAN-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
  if (getItem.get(code)) return res.status(409).json({ error: 'Položka s tímto kódem už existuje' });
  let info = null;
  if (!req.body.name && req.body.lookup !== false) info = await lookupSafe(code);
  const ts = nowIso();
  const qty = round3(req.body.quantity);
  const name = String(req.body.name || info?.name || '');
  try {
    db.prepare(`INSERT INTO items (code, name, brand, category, image_url, quantity, min_stock, price, unit, supplier, location, note, source, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(code, name, String(req.body.brand || info?.brand || ''),
        String(req.body.category || info?.category || ''), sanitizeImageUrl(req.body.image_url || info?.image_url),
        qty, Math.max(0, round3(req.body.min_stock)), money2(req.body.price),
        String(req.body.unit || 'ks'), String(req.body.supplier || ''), String(req.body.location || ''),
        String(req.body.note || ''), info?.source || (req.body.name ? 'ručně' : ''), ts, ts);
  } catch (e) {
    if (/UNIQUE|PRIMARY/i.test(String(e.message))) return res.status(409).json({ error: 'Položka s tímto kódem už existuje' });
    throw e;
  }
  if (qty !== 0) logMovement(code, name, qty, 'in', qty, req.user.display_name);
  res.json({ item: getItem.get(code), found: !!(info && info.name) });
}));

/* ---- Úprava ---- */
app.patch('/api/items/:code', (req, res) => {
  const code = req.params.code;
  const item = getItem.get(code);
  if (!item) return res.status(404).json({ error: 'Položka neexistuje' });
  const updates = [], vals = [];
  for (const f of ITEM_TEXT_FIELDS) if (f in req.body) {
    updates.push(`${f} = ?`);
    vals.push(f === 'image_url' ? sanitizeImageUrl(req.body[f]) : String(req.body[f] ?? ''));
  }
  if ('quantity' in req.body) { updates.push('quantity = ?'); vals.push(round3(req.body.quantity)); }
  if ('min_stock' in req.body) { updates.push('min_stock = ?'); vals.push(Math.max(0, round3(req.body.min_stock))); }
  if ('price' in req.body) { updates.push('price = ?'); vals.push(money2(req.body.price)); }
  if (updates.length) {
    updates.push('updated_at = ?'); vals.push(nowIso(), code);
    db.prepare(`UPDATE items SET ${updates.join(', ')} WHERE code = ?`).run(...vals);
  }
  const updated = getItem.get(code);
  // upozornění jen když množství reálně kleslo (ne při pouhé změně minima)
  if ('quantity' in req.body && updated.quantity < item.quantity) checkCrossing(item.quantity, item.min_stock, updated);
  res.json(updated);
});

/* ---- Znovu dohledat ---- */
app.post('/api/items/:code/lookup', wrap(async (req, res) => {
  const code = req.params.code;
  const item = getItem.get(code);
  if (!item) return res.status(404).json({ error: 'Položka neexistuje' });
  const info = await lookupSafe(code);
  if (!getItem.get(code)) return res.status(404).json({ error: 'Položka mezitím zmizela' }); // smazána během dohledávání
  if (!info || !info.name) return res.json({ item, found: false });
  db.prepare(`UPDATE items SET
       name = CASE WHEN name='' THEN ? ELSE name END,
       brand = CASE WHEN brand='' THEN ? ELSE brand END,
       category = CASE WHEN category='' THEN ? ELSE category END,
       image_url = CASE WHEN image_url='' THEN ? ELSE image_url END,
       source = ?, updated_at = ? WHERE code = ?`)
    .run(info.name, info.brand, info.category, sanitizeImageUrl(info.image_url), info.source, nowIso(), code);
  res.json({ item: getItem.get(code), found: true });
}));

app.delete('/api/items/:code', (req, res) => {
  const r = db.prepare('DELETE FROM items WHERE code = ?').run(req.params.code);
  if (r.changes === 0) return res.status(404).json({ error: 'Položka neexistuje' });
  res.json({ ok: true });
});

/* ---- Undo (atomicky) ---- */
app.post('/api/undo', (req, res) => {
  const wantId = 'id' in req.body ? Number(req.body.id) : null;
  const out = db.transaction(() => {
    const last = db.prepare('SELECT * FROM movements ORDER BY id DESC LIMIT 1').get();
    if (!last) return { err: 404, msg: 'Není co vrátit' };
    // bezpečnost ve více uživatelích: vrátit smí jen ten poslední pohyb, který klient skutečně provedl
    if (wantId !== null && wantId !== last.id) return { err: 409, msg: 'Tohle už není poslední pohyb (mezitím skenoval někdo jiný).' };
    const item = getItem.get(last.code);
    if (!item) return { err: 409, msg: 'Položka už byla smazána – pohyb nelze vrátit.' }; // nemazat audit stopu
    const newQty = round3(item.quantity - last.delta);
    db.prepare('UPDATE items SET quantity = ?, updated_at = ? WHERE code = ?').run(newQty, nowIso(), last.code);
    db.prepare('DELETE FROM movements WHERE id = ?').run(last.id);
    // uklidit fantomovou položku vzniklou omylem naskenovaným kódem (žádné jiné pohyby, prázdná, na nule)
    let removed = false;
    if (newQty === 0 && !item.name && item.source === '' &&
        db.prepare('SELECT COUNT(*) c FROM movements WHERE code = ?').get(last.code).c === 0) {
      db.prepare('DELETE FROM items WHERE code = ?').run(last.code);
      removed = true;
    }
    return { undone: last, removed };
  })();
  if (out.err) return res.status(out.err).json({ error: out.msg });
  res.json({ ok: true, undone: out.undone, removed: out.removed, item: getItem.get(out.undone.code) });
});

/* ---- Historie ---- */
app.get('/api/movements', (req, res) => {
  const code = String(req.query.code || '').trim();
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 300));
  res.json(code
    ? db.prepare('SELECT * FROM movements WHERE code = ? ORDER BY id DESC LIMIT ?').all(code, limit)
    : db.prepare('SELECT * FROM movements ORDER BY id DESC LIMIT ?').all(limit));
});

/* ---- Souhrn ---- */
app.get('/api/summary', (req, res) => {
  res.json(db.prepare(
    `SELECT COUNT(*) AS skus, COALESCE(SUM(quantity),0) AS pieces, COALESCE(SUM(quantity*price),0) AS value,
            COALESCE(SUM(CASE WHEN min_stock>0 AND quantity<min_stock THEN 1 ELSE 0 END),0) AS low,
            COALESCE(SUM(CASE WHEN quantity<=0 THEN 1 ELSE 0 END),0) AS zero FROM items`
  ).get());
});

/* ---- Dodavatelé ---- */
const getSupplier = db.prepare('SELECT * FROM suppliers WHERE id = ?');
app.get('/api/suppliers', (req, res) => {
  res.json(db.prepare('SELECT * FROM suppliers ORDER BY name').all());
});
app.post('/api/suppliers', auth.requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Chybí název dodavatele' });
  const r = db.prepare('INSERT INTO suppliers (name, contact, lead_days, note, created_at) VALUES (?,?,?,?,?)')
    .run(name, String(req.body.contact || '').slice(0, 200), Math.max(0, Math.floor(Number(req.body.lead_days) || 0)), String(req.body.note || '').slice(0, 500), nowIso());
  res.json(getSupplier.get(r.lastInsertRowid));
});
app.patch('/api/suppliers/:id', auth.requireAdmin, (req, res) => {
  const s = getSupplier.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Dodavatel neexistuje' });
  const sets = [], vals = [];
  if ('name' in req.body) { const n = String(req.body.name || '').trim(); if (!n) return res.status(400).json({ error: 'Název nesmí být prázdný' }); sets.push('name = ?'); vals.push(n.slice(0, 120)); }
  if ('contact' in req.body) { sets.push('contact = ?'); vals.push(String(req.body.contact || '').slice(0, 200)); }
  if ('lead_days' in req.body) { sets.push('lead_days = ?'); vals.push(Math.max(0, Math.floor(Number(req.body.lead_days) || 0))); }
  if ('note' in req.body) { sets.push('note = ?'); vals.push(String(req.body.note || '').slice(0, 500)); }
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
  res.json(getSupplier.get(req.params.id));
});
app.delete('/api/suppliers/:id', auth.requireAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM suppliers WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Dodavatel neexistuje' });
  res.json({ ok: true });
});

/* ---- Návrh doobjednání: co je pod minimem, kolik dokoupit, od koho ---- */
app.get('/api/reorder', (req, res) => {
  const low = db.prepare('SELECT * FROM items WHERE min_stock > 0 AND quantity < min_stock ORDER BY supplier, name').all();
  const supByName = new Map(db.prepare('SELECT * FROM suppliers').all().map((s) => [s.name, s]));
  const groups = new Map();
  let totalCost = 0;
  for (const it of low) {
    const key = it.supplier || '';
    if (!groups.has(key)) {
      const sup = supByName.get(key);
      groups.set(key, { supplier: key, contact: sup ? sup.contact : '', lead_days: sup ? sup.lead_days : null, items: [], totalCost: 0 });
    }
    const suggested = round3(it.min_stock - it.quantity);
    const cost = money2(suggested * it.price);
    const g = groups.get(key);
    g.items.push({ code: it.code, name: it.name, quantity: it.quantity, min_stock: it.min_stock, suggested, unit: it.unit, price: it.price, cost });
    g.totalCost = money2(g.totalCost + cost);
    totalCost = money2(totalCost + cost);
  }
  res.json({ groups: [...groups.values()], totalCost, count: low.length });
});
app.get('/api/reorder.csv', (req, res) => {
  const low = db.prepare('SELECT * FROM items WHERE min_stock > 0 AND quantity < min_stock ORDER BY supplier, name').all();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="doobjednat.csv"');
  res.send(toCsv(
    ['Dodavatel', 'Kód', 'Název', 'Stav', 'Min. zásoba', 'Doobjednat', 'Jednotka', 'Cena/ks', 'Cena celkem'],
    ['supplier', 'code', 'name', (r) => dec(r.quantity), (r) => dec(r.min_stock), (r) => dec(round3(r.min_stock - r.quantity)), 'unit', (r) => dec(r.price), (r) => dec(money2((r.min_stock - r.quantity) * r.price))],
    low));
});

/* ---- QR kód jako SVG (pro tisk štítků) ---- */
app.get('/api/qr.svg', wrap(async (req, res) => {
  const text = String(req.query.text || '').slice(0, 512);
  if (!text) return res.status(400).json({ error: 'Chybí text' });
  const svg = await QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.send(svg);
}));

/* ---- CSV / záloha ---- */
function toCsv(head, cols, rows) {
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // ochrana proti CSV/formula injection (Excel)
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [head.join(';')];
  for (const r of rows) lines.push(cols.map((c) => esc(typeof c === 'function' ? c(r) : r[c])).join(';'));
  return '﻿' + lines.join('\r\n');
}
const dec = (v) => String(v == null ? '' : v).replace('.', ','); // desetinná čárka pro cs-CZ Excel (oddělovač ;)
app.get('/api/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM items ORDER BY name, code').all();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sklad.csv"');
  res.send(toCsv(
    ['Kód', 'Název', 'Značka', 'Kategorie', 'Množství', 'Jednotka', 'Min. zásoba', 'Cena/ks', 'Hodnota', 'Dodavatel', 'Umístění', 'Poznámka', 'Zdroj', 'Aktualizováno'],
    ['code', 'name', 'brand', 'category', (r) => dec(r.quantity), 'unit', (r) => dec(r.min_stock), (r) => dec(r.price), (r) => dec((r.quantity * r.price).toFixed(2)), 'supplier', 'location', 'note', 'source', 'updated_at'],
    rows));
});
app.get('/api/movements.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM movements ORDER BY id DESC').all();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pohyby.csv"');
  res.send(toCsv(['Čas', 'Kód', 'Název', 'Typ', 'Pohyb', 'Stav po', 'Operátor'],
    ['created_at', 'code', 'name', 'type', (r) => dec(r.delta), (r) => dec(r.quantity_after), 'user'], rows));
});
app.get('/api/backup.json', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="sklad-zaloha.json"');
  res.json({ app: 'skladappka', exported_at: nowIso(), items: db.prepare('SELECT * FROM items').all(), movements: db.prepare('SELECT * FROM movements').all() });
});
/* ---- Hromadný import položek z CSV (admin) ---- */
// Tělo: { rows: [{ code, name?, quantity?, unit?, price?, min_stock?, category?, location?, supplier?, note? }] }
// Existující kód aktualizuje (jen vyplněná pole), nový zakládá. Nastaví-li se množství,
// zapíše se inventurní pohyb (type 'set'), aby zůstala auditní stopa.
app.post('/api/import', auth.requireAdmin, (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: 'Chybí data (rows)' });
  if (rows.length > 100000) return res.status(413).json({ error: 'Příliš mnoho řádků' });
  const user = req.user.display_name;
  const TEXT = ['name', 'brand', 'category', 'location', 'note', 'supplier', 'unit'];
  let created = 0, updated = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const code = String(r.code || '').trim().slice(0, 128);
      if (!code) { skipped++; continue; }
      const exists = getItem.get(code);
      const ts = nowIso();
      if (!exists) {
        db.prepare(`INSERT INTO items (code, name, brand, category, image_url, quantity, min_stock, price, unit, supplier, location, note, source, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'import', ?, ?)`)
          .run(code, String(r.name || ''), String(r.brand || ''), String(r.category || ''), sanitizeImageUrl(r.image_url),
            'quantity' in r ? round3(r.quantity) : 0, Math.max(0, round3(r.min_stock)), money2(r.price),
            String(r.unit || 'ks'), String(r.supplier || ''), String(r.location || ''), String(r.note || ''), ts, ts);
        created++;
      } else {
        const sets = [], vals = [];
        for (const f of TEXT) if (f in r && String(r[f]) !== '') { sets.push(`${f} = ?`); vals.push(String(r[f])); }
        if ('image_url' in r) { sets.push('image_url = ?'); vals.push(sanitizeImageUrl(r.image_url)); }
        if ('min_stock' in r) { sets.push('min_stock = ?'); vals.push(Math.max(0, round3(r.min_stock))); }
        if ('price' in r) { sets.push('price = ?'); vals.push(money2(r.price)); }
        if (sets.length) { sets.push('updated_at = ?'); vals.push(ts, code); db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE code = ?`).run(...vals); }
        updated++;
      }
      // nastavit množství (absolutně) + auditní pohyb
      if ('quantity' in r) {
        const before = getItem.get(code).quantity;
        const target = round3(r.quantity);
        if (target !== before) {
          db.prepare('UPDATE items SET quantity = ?, updated_at = ? WHERE code = ?').run(target, ts, code);
          logMovement(code, getItem.get(code).name, round3(target - before), 'set', target, user);
        }
      }
    }
  });
  try { tx(); res.json({ ok: true, created, updated, skipped, total: rows.length }); }
  catch (e) { console.error('[import]', e.message); res.status(400).json({ error: 'Import selhal: ' + e.message }); }
});

app.post('/api/restore', auth.requireAdmin, (req, res) => {
  const itemsIn = Array.isArray(req.body.items) ? req.body.items : null;
  if (!itemsIn) return res.status(400).json({ error: 'Neplatná záloha (chybí items)' });
  const movements = Array.isArray(req.body.movements) ? req.body.movements : [];
  const ts = nowIso();

  // deduplikace podle kódu (poslední vyhrává) + zahození položek bez kódu
  const byCode = new Map();
  for (const it of itemsIn) { const code = String(it.code || '').trim(); if (code) byCode.set(code, it); }
  const items = [...byCode.values()];

  const tx = db.transaction(() => {
    db.exec('DELETE FROM items; DELETE FROM movements;');
    db.prepare("DELETE FROM sqlite_sequence WHERE name='movements'").run();
    const ins = db.prepare(`INSERT INTO items (code,name,brand,category,image_url,quantity,min_stock,price,unit,supplier,location,note,source,created_at,updated_at)
      VALUES (@code,@name,@brand,@category,@image_url,@quantity,@min_stock,@price,@unit,@supplier,@location,@note,@source,@created_at,@updated_at)`);
    for (const it of items) ins.run({
      code: String(it.code).trim(), name: String(it.name || ''), brand: String(it.brand || ''), category: String(it.category || ''),
      image_url: sanitizeImageUrl(it.image_url), quantity: round3(it.quantity), min_stock: Math.max(0, round3(it.min_stock)),
      price: money2(it.price), unit: String(it.unit || 'ks'), supplier: String(it.supplier || ''), location: String(it.location || ''),
      note: String(it.note || ''), source: String(it.source || ''), created_at: String(it.created_at || ts), updated_at: String(it.updated_at || ts),
    });
    const insM = db.prepare(`INSERT INTO movements (code,name,delta,type,quantity_after,user,created_at)
      VALUES (@code,@name,@delta,@type,@quantity_after,@user,@created_at)`);
    for (const m of movements) { if (!String(m.code || '').trim()) continue; insM.run({
      code: String(m.code).trim(), name: String(m.name || ''), delta: round3(m.delta), type: String(m.type || ''),
      quantity_after: round3(m.quantity_after), user: String(m.user || ''), created_at: String(m.created_at || ts),
    }); }
  });
  try {
    tx();
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    res.json({ ok: true, count: items.length });
  } catch (e) { console.error('[restore]', e.message); res.status(400).json({ error: 'Obnova selhala: ' + e.message }); }
});

/* ===================== Správa uživatelů (admin) ===================== */
app.get('/api/users', auth.requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT username, display_name, role, created_at FROM users ORDER BY username').all());
});
app.post('/api/users', auth.requireAdmin, (req, res) => {
  try { res.json(auth.createUser(req.body)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/users/:username/password', auth.requireAdmin, (req, res) => {
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(req.params.username)) return res.status(404).json({ error: 'Uživatel neexistuje' });
  try { auth.setPassword(req.params.username, String(req.body.password || '')); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/users/:username', auth.requireAdmin, (req, res) => {
  const target = req.params.username;
  if (target === req.user.username) return res.status(400).json({ error: 'Nemůžeš smazat sám sebe' });
  const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
  const tgt = db.prepare('SELECT role FROM users WHERE username = ?').get(target);
  if (tgt && tgt.role === 'admin' && admins <= 1) return res.status(400).json({ error: 'Musí zůstat aspoň jeden admin' });
  db.prepare('DELETE FROM users WHERE username = ?').run(target);
  db.prepare('DELETE FROM sessions WHERE username = ?').run(target);
  res.json({ ok: true });
});

/* ===================== Nastavení e-mailu + upozornění (admin) ===================== */
app.get('/api/settings', auth.requireAdmin, (req, res) => {
  const c = mail.getMailConfig();
  res.json({ enabled: c.enabled, host: c.host, port: c.port, secure: c.secure, user: c.user, from: c.from, to: c.to, has_pass: !!c.pass });
});
app.put('/api/settings', auth.requireAdmin, (req, res) => {
  const b = req.body;
  const map = { alert_enabled: b.enabled ? '1' : '0', mail_host: b.host, mail_port: b.port, mail_secure: b.secure ? '1' : '0', mail_user: b.user, mail_from: b.from, alert_to: b.to };
  for (const [k, v] of Object.entries(map)) if (v !== undefined) mail.setSetting(k, String(v ?? ''));
  if (typeof b.pass === 'string' && b.pass !== '') mail.setSetting('mail_pass', b.pass); // heslo měň jen když je vyplněné
  res.json({ ok: true });
});
app.post('/api/alert/test', auth.requireAdmin, async (req, res) => {
  try { await mail.sendTest(); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/alert/report', auth.requireAdmin, async (req, res) => {
  try { const r = await mail.sendLowStockReport(); res.json({ ok: true, count: r.count }); } catch (e) { res.status(400).json({ error: e.message }); }
});

// Neznámá API cesta → JSON 404 (ne SPA fallback)
app.use('/api', (req, res) => res.status(404).json({ error: 'Neznámý endpoint' }));

// Centrální error handler – vždy JSON, nikdy stack trace ven
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) return res.status(400).json({ error: 'Neplatný JSON v požadavku' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Požadavek je příliš velký' });
  const status = err.status || 500;
  if (status >= 500) console.error('[ERROR]', req.method, req.originalUrl, '-', err && err.message);
  res.status(status).json({ error: status < 500 ? (err.message || 'Neplatný požadavek') : 'Interní chyba serveru' });
});

// Proces nepadne kvůli jedné chybě
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err && err.stack || err));

const server = useTls
  ? https.createServer({ key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) }, app)
  : http.createServer(app);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} je obsazený. Spusť s jiným portem:  PORT=8080 npm start\n`);
  else console.error('  Chyba serveru:', e.message);
  process.exit(1);
});

// Korektní ukončení – dopsat WAL a zavřít DB
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`\n  ${sig} – ukončuji…`);
  server.close(() => {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
  const proto = useTls ? 'https' : 'http';
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  console.log(`\n  Skladová evidence v${VERSION} běží 🚀` + (useTls ? '  (HTTPS)' : ''));
  console.log(`  Na tomto PC:      ${proto}://localhost:${PORT}`);
  for (const ip of ips) console.log(`  V síti (ostatní):  ${proto}://${ip}:${PORT}`);
  if (seeded) {
    console.log('\n  ┌─────────────────────────────────────────────┐');
    console.log('  │  Vytvořen administrátorský účet              │');
    console.log(`  │  Jméno:  ${seeded.username.padEnd(35)}│`);
    console.log(`  │  Heslo:  ${seeded.password.padEnd(35)}│`);
    console.log('  │  (po přihlášení si heslo změň v Nastavení)   │');
    console.log('  └─────────────────────────────────────────────┘');
  }
  console.log('');
});

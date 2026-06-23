'use strict';

// Best-effort vyhledávání informací o zboží podle čárového kódu (EAN/UPC/ISBN) na internetu.
// Fáze:
//   1) volné zdroje paralelně (volitelný vlastní/placený zdroj, Google Books*, Open *Facts)
//   2) UPCitemdb (denní limit) jen když fáze 1 nic nenašla – šetří kvótu i čas
//
// * Google Books má i bez klíče denní limit; pro vyšší spolehlivost nastav GOOGLE_BOOKS_KEY.
//
// Spolehlivost pro obecné zboží zvýšíš zapojením placeného zdroje přes proměnné:
//   BARCODE_API_URL     – URL šablona s {code}, např. https://api.poskytovatel.tld/v3/lookup?ean={code}
//   BARCODE_API_KEY     – přidá hlavičku Authorization: Bearer <key>
//   BARCODE_API_HEADERS – volitelné JSON s hlavičkami, např. {"x-api-key":"…"}
//   BARCODE_API_MAP     – volitelné JSON mapování polí odpovědi na {name,brand,category,image}
//                          (hodnota = tečková cesta nebo pole cest, např. {"name":"data.title"})
// Pokud nic nenajde, vrátí null a název se doplní ručně v appce.

const UA = 'skladappka/' + require('./package.json').version + ' (firemni skladova evidence)';
const TIMEOUT_MS = Math.max(1000, Number(process.env.LOOKUP_TIMEOUT_MS) || 4000);
const GOOGLE_KEY = process.env.GOOGLE_BOOKS_KEY || ''; // volitelný klíč – bez něj je anonymní kvóta nízká

async function fetchJson(url, timeoutMs = TIMEOUT_MS, extraHeaders = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json', ...extraHeaders } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Bezpečně získá text – zvládne string, číslo, pole i lokalizovaný objekt {en,cs,…}
function clean(s) {
  if (s == null) return '';
  if (typeof s === 'number') s = String(s);
  else if (typeof s !== 'string') {
    if (Array.isArray(s)) s = s.find((x) => typeof x === 'string' && x.trim()) || '';
    else if (typeof s === 'object') s = s.cs || s.en || Object.values(s).find((x) => typeof x === 'string') || '';
    else s = '';
  }
  return String(s).replace(/\s+/g, ' ').trim();
}
function httpsUrl(u) { const s = clean(u); return s ? s.replace(/^http:/i, 'https:') : ''; }
function firstPart(v, sep) { return typeof v === 'string' ? v.split(sep)[0] : ''; }
function lastPart(v, sep) { return typeof v === 'string' ? v.split(sep).pop() : ''; }

function isIsbn(code) {
  return /^(97[89]\d{10}|\d{9}[\dxX])$/.test(code);
}

// Tečková cesta v objektu, zvládne i indexy polí ("images.0").
function dget(obj, dotPath) {
  return String(dotPath).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
// První neprázdná hodnota z více cest.
function pick(obj, paths) {
  for (const p of paths) { const s = clean(dget(obj, p)); if (s) return s; }
  return '';
}
function asPaths(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }

// ---- Jednotlivé zdroje ----

// Volitelný vlastní/placený zdroj (konfigurace z prostředí, čte se až za běhu).
async function fromCustom(code) {
  const url = process.env.BARCODE_API_URL;
  if (!url) return null;
  let headers = {};
  try { if (process.env.BARCODE_API_HEADERS) headers = JSON.parse(process.env.BARCODE_API_HEADERS); } catch { /* ignore */ }
  if (process.env.BARCODE_API_KEY) headers = { Authorization: 'Bearer ' + process.env.BARCODE_API_KEY, ...headers };
  let map = {};
  try { if (process.env.BARCODE_API_MAP) map = JSON.parse(process.env.BARCODE_API_MAP); } catch { /* ignore */ }

  const data = await fetchJson(url.replace(/\{code\}/g, encodeURIComponent(code)), TIMEOUT_MS, headers);
  if (!data) return null;
  // Odpověď může být pole, {items:[…]}, {product:…}, {data:…} nebo přímo objekt.
  const root = Array.isArray(data) ? data[0]
    : (Array.isArray(data.items) ? data.items[0] : (data.product || data.data || data));
  if (!root || typeof root !== 'object') return null;

  const name = pick(root, [...asPaths(map.name), 'title', 'name', 'product_name', 'description']);
  if (!name) return null;
  return {
    name,
    brand: pick(root, [...asPaths(map.brand), 'brand', 'manufacturer', 'brands']),
    category: pick(root, [...asPaths(map.category), 'category', 'categories']),
    image_url: httpsUrl(pick(root, [...asPaths(map.image), 'image', 'image_url', 'imageUrl', 'images.0'])),
    source: clean(process.env.BARCODE_API_NAME) || 'Externí katalog',
  };
}

async function fromGoogleBooks(code) {
  if (!isIsbn(code)) return null;
  const data = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(code)}` + (GOOGLE_KEY ? `&key=${encodeURIComponent(GOOGLE_KEY)}` : ''));
  const v = data && data.totalItems > 0 && data.items && data.items[0] && data.items[0].volumeInfo;
  if (!v) return null;
  const name = clean([v.title, v.subtitle].filter(Boolean).join(' – '));
  if (!name) return null;
  return {
    name,
    brand: clean(Array.isArray(v.authors) ? v.authors[0] : ''),
    category: clean(Array.isArray(v.categories) ? v.categories[0] : 'Kniha'),
    image_url: httpsUrl(v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)),
    source: 'Google Books',
  };
}

async function fromOpenFacts(code, subdomain, label) {
  const data = await fetchJson(
    `https://world.${subdomain}.org/api/v2/product/${encodeURIComponent(code)}.json` +
      `?fields=product_name,generic_name,brands,categories,image_front_url,image_url`
  );
  if (!data || data.status !== 1 || !data.product) return null;
  const p = data.product;
  const name = clean(p.product_name) || clean(p.generic_name);
  if (!name) return null;
  return {
    name,
    brand: clean(firstPart(p.brands, ',')),
    category: clean(lastPart(p.categories, ',')),
    image_url: httpsUrl(p.image_front_url || p.image_url),
    source: label,
  };
}

async function fromUpcItemDb(code) {
  const data = await fetchJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`);
  if (!data || data.code !== 'OK' || !Array.isArray(data.items) || !data.items.length) return null;
  const it = data.items[0];
  const name = clean(it.title);
  if (!name) return null;
  return {
    name,
    brand: clean(it.brand),
    category: clean(it.category),
    image_url: httpsUrl(Array.isArray(it.images) && it.images.length ? it.images[0] : ''),
    source: 'UPCitemdb',
  };
}

const FREE = [
  { prio: 6, fn: (c) => fromGoogleBooks(c) },
  { prio: 5, fn: (c) => fromOpenFacts(c, 'openfoodfacts', 'Open Food Facts') },
  { prio: 5, fn: (c) => fromOpenFacts(c, 'openproductsfacts', 'Open Products Facts') },
  { prio: 5, fn: (c) => fromOpenFacts(c, 'openbeautyfacts', 'Open Beauty Facts') },
];
const FALLBACK = [{ prio: 2, fn: (c) => fromUpcItemDb(c) }];

// Vlastní zdroj má nejvyšší prioritu – pokud je nakonfigurovaný, vyhrává.
function freeSources() {
  return process.env.BARCODE_API_URL ? [{ prio: 8, fn: fromCustom }, ...FREE] : FREE;
}

function score(res, prio) {
  return prio * 100 + (res.image_url ? 20 : 0) + (res.brand ? 10 : 0) + Math.min(res.name.length, 50);
}

async function runSources(list, c) {
  const results = await Promise.allSettled(list.map((s) => s.fn(c)));
  let best = null, bestScore = -1;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value && r.value.name) {
      const sc = score(r.value, list[i].prio);
      if (sc > bestScore) { bestScore = sc; best = r.value; }
    }
  });
  return best;
}

async function lookupProduct(code) {
  const c = clean(code);
  if (!c || c.length > 64) return null; // reálné kódy mají max ~14 znaků
  const free = await runSources(freeSources(), c);
  if (free) return free;
  return runSources(FALLBACK, c); // UPCitemdb jen jako záloha
}

module.exports = { lookupProduct };
// Čisté pomocné funkce vystavené pro testy (neslouží jako veřejné API).
module.exports._internals = { clean, httpsUrl, isIsbn, dget, pick, asPaths, score, fromCustom, lookupProduct };

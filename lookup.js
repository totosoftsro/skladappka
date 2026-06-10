'use strict';

// Best-effort vyhledávání informací o zboží podle čárového kódu (EAN/UPC/ISBN) na internetu.
// Všechno zdarma, bez API klíče. Dvě fáze:
//   1) bezlimitní zdroje paralelně (Google Books, Open Food/Products/Beauty Facts, Brocade)
//   2) UPCitemdb (denní limit) jen když fáze 1 nic nenašla – šetří kvótu i čas
//
// Pokud nic nenajde, vrátí null a název se doplní ručně v appce.

const UA = 'skladappka/1.2 (firemni skladova evidence)';
const TIMEOUT_MS = 4000;

async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
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
    if (Array.isArray(s)) s = s.find((x) => typeof x === 'string') || '';
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

// ---- Jednotlivé zdroje ----

async function fromGoogleBooks(code) {
  if (!isIsbn(code)) return null;
  const data = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(code)}`);
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

async function fromBrocade(code) {
  const data = await fetchJson(`https://www.brocade.io/api/items/${encodeURIComponent(code)}`);
  if (!data || !data.name) return null;
  return { name: clean(data.name), brand: clean(data.brand_name), category: clean(data.category), image_url: '', source: 'Brocade' };
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
  { prio: 3, fn: (c) => fromBrocade(c) },
];
const FALLBACK = [{ prio: 2, fn: (c) => fromUpcItemDb(c) }];

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
  if (!c) return null;
  const free = await runSources(FREE, c);
  if (free) return free;
  return runSources(FALLBACK, c); // UPCitemdb jen jako záloha
}

module.exports = { lookupProduct };

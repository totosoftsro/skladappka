# 📦 Skladová evidence

Jednoduchá, samostatně hostovaná webová aplikace pro evidenci firemního skladu
s USB čtečkou čárových kódů. Naskenuješ kód a appka si **sama dohledá název,
značku a obrázek zboží na internetu** — názvy nemusíš psát ručně. Běží jako
jeden Node.js server se SQLite databází, ostatní v síti přistupují přes
prohlížeč (počítač i mobil).

## Funkce

- **Skenování bez Enteru** — appka rozpozná rychlou dávku znaků ze čtečky a sken
  odešle sama; ruční psaní se omylem neodešle. Citlivost lze doladit v Nastavení.
- **Automatické dohledání zboží** podle EAN/UPC/ISBN z bezplatných zdrojů
  (Open Food/Products/Beauty Facts, Google Books, UPCitemdb jako záloha).
  Výsledek se uloží — podruhé se už nehledá.
- **Hromadný import z CSV/Excelu** — migrace ze stávající tabulky jedním
  souborem (existující kódy aktualizuje, nové zakládá).
- **Kategorie** + filtr podle kategorie pro přehlednou organizaci skladu.
- **Tři režimy:** Příjem · Výdej · Inventura (nastaví skutečný stav).
- **Jednotky a desetinná množství** — ks, m, m², kg, l, bal… (např. „výdej 2,5 m“).
  Záporný stav (výdej do mínusu) je povolen.
- **Ceny a hodnota skladu**, minimální zásoby se stavy 🟢/🟠/🔴, filtry
  „pod limitem“ / „vyprodáno“.
- **Přihlašování uživatelů** (admin / operátor), jméno se zapisuje ke každému
  pohybu. Kompletní **historie pohybů**.
- **Undo** posledního pohybu jedním klikem.
- **Tisk štítků** s **čárovým kódem (Code128) nebo QR kódem** (volba v Nastavení) —
  jednotlivě i hromadně dle filtru.
- **E-mailová upozornění** při poklesu pod minimum (vlastní SMTP) + ruční report.
- **Export** skladu a pohybů do CSV (Excel, česká locale), **záloha/obnova** JSON.
- **Mobilní rozhraní** (karty, spodní listy) + přidání na plochu (PWA, bez offline režimu).
- Tmavý režim, čeština. Jediné externí závislosti za běhu: vyhledávání názvů
  zboží a webové fonty (Google Fonts) — bez nich appka funguje a použije
  systémové písmo.

## Rychlý start

Vyžaduje **Node.js 20+**.

```bash
git clone https://github.com/totosoftsro/skladappka.git
cd skladappka
npm install
npm start
```

Při **prvním spuštění** se vytvoří účet `admin` s náhodným heslem — vypíše se
do konzole. Po přihlášení si ho změň v **⚙️ Nastavení → Můj účet**.

Konzole také vypíše adresy:

```
Na tomto PC:      http://localhost:3000
V síti (ostatní):  http://192.168.x.x:3000
```

Ostatní ve firemní síti otevřou druhou adresu v prohlížeči — nic neinstalují.

## Konfigurace (proměnné prostředí)

| Proměnná         | Výchozí       | Význam                                                |
|------------------|---------------|-------------------------------------------------------|
| `PORT`             | `3000`        | Port serveru                                          |
| `DATA_DIR`         | `data/` vedle aplikace | Složka s databází (SQLite)                   |
| `TLS_KEY`, `TLS_CERT` | —          | Cesty k PEM souborům → server běží na HTTPS           |
| `TRUST_PROXY`      | —             | `1` za reverzní proxy (správné IP, Secure cookie)     |
| `DISABLE_LOOKUP`   | —             | `1` vypne dohledávání na internetu (offline provoz)   |
| `GOOGLE_BOOKS_KEY` | —             | volitelný klíč Google Books API (spolehlivější ISBN) |

Endpoint **`GET /healthz`** vrací `{ ok, version }` — pro monitoring / supervisor
(používá ho i Docker HEALTHCHECK).

## Produkční nasazení

**pm2 (doporučeno na firemním PC/serveru):**
```bash
npm i -g pm2
pm2 start server.js --name sklad
pm2 save && pm2 startup   # automatický start po rebootu
```

**Docker:**
```bash
docker build -t skladappka .
docker run -d --name sklad -p 3000:3000 -v sklad-data:/data --restart unless-stopped skladappka
# heslo admina: docker logs sklad
```

**HTTPS:** buď přímo (`TLS_KEY`/`TLS_CERT`), nebo za reverzní proxy
(Caddy/nginx) s `TRUST_PROXY=1`. Uvnitř důvěryhodné LAN lze provozovat i po HTTP.

## Zálohování

- **Doporučeno:** v appce **Export → Záloha (JSON)** — konzistentní, obnovitelné
  přes **Export → Obnovit ze zálohy…** (jen admin).
- Souborová záloha: kopíruj `data/sklad.db` **včetně** `sklad.db-wal` (WAL
  režim), ideálně po zastavení serveru — při ukončení se WAL zapíše automaticky.

## Import z CSV

V appce **Export → Import z CSV…**. První řádek jsou názvy sloupců (česky i
anglicky, na velikosti/diakritice nezáleží). Rozpoznají se mj.:
`kód` (povinný), `název`, `množství`, `jednotka`, `cena`, `min. zásoba`,
`kategorie`, `umístění`, `dodavatel`. Oddělovač `;` i `,`, desetinná čárka i
tečka. Existující kódy se aktualizují (jen vyplněná pole), nové se založí.

```
Kód;Název;Množství;Jednotka;Cena/ks;Min. zásoba;Kategorie;Umístění
8594001234567;Vrták 6mm HSS;120;ks;12,50;20;Nářadí;A1
8594007654321;Kabel CYKY 3x1,5;250,5;m;18,90;50;Elektro;B2
```

## Zabezpečení

- Hesla hashovaná (scrypt + sůl), porovnání odolné proti časovému útoku,
  minimum 6 znaků; změna hesla zneplatní všechna sezení.
- Sezení v HttpOnly cookie (30 dní), omezení pokusů o přihlášení (per IP
  i per účet), role admin/operátor.
- Bezpečnostní hlavičky (CSP, X-Frame-Options, nosniff…), sanitizace URL
  obrázků, ochrana CSV exportu proti formula injection, chybové odpovědi bez
  interních detailů.

## Testy

```bash
npm test
```

Smoke testy nastartují vlastní instanci na dočasné databázi (bez internetu)
a projedou celé API — skenování, jednotky, undo, zálohu/obnovu, role, CSV.

## Struktura

```
server.js    HTTP server + API
auth.js      uživatelé, sezení, hesla
lookup.js    dohledávání zboží podle kódu
mail.js      SMTP upozornění
db.js        SQLite schéma + migrace
public/      frontend (bez build kroku)
test/        smoke testy (node --test)
```

## Licence

MIT — viz [LICENSE](LICENSE).

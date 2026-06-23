'use strict';

// Automatické zálohy: konzistentní online snapshot SQLite databáze do
// DATA_DIR/backups/. Funguje i při běžícím provozu a WAL režimu (better-sqlite3
// .backup() kopíruje konzistentní stav). Plán: jednou krátce po startu, pak
// periodicky; staré zálohy se promazávají (retence).

const path = require('path');
const fs = require('fs');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupsDir(dataDir) {
  return path.join(dataDir, 'backups');
}

// Jména obsahují timestamp, takže abecední řazení = chronologické.
function listBackups(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /^sklad-\d{8}-\d{6}\.db$/.test(f)).sort();
  } catch {
    return [];
  }
}

// Nech jen posledních `keep` záloh, starší smaž. Vrací počet smazaných.
function prune(dir, keep) {
  const files = listBackups(dir);
  const excess = Math.max(0, files.length - Math.max(1, keep));
  for (let i = 0; i < excess; i++) {
    try { fs.unlinkSync(path.join(dir, files[i])); } catch { /* ignore */ }
  }
  return excess;
}

// Vytvoří jeden snapshot a promaže staré. Vrací cestu k souboru.
async function runBackup(db, dataDir, keep = 14) {
  const dir = backupsDir(dataDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* některé FS chmod nepodporují */ }
  const dest = path.join(dir, `sklad-${stamp()}.db`);
  await db.backup(dest);
  try { fs.chmodSync(dest, 0o600); } catch { /* ignore */ }
  prune(dir, keep);
  return dest;
}

// Naplánuje pravidelné zálohy. BACKUP_INTERVAL_HOURS=0 (nebo neplatné) = vypnuto.
function scheduleBackups(db, dataDir, opts = {}) {
  const hrs = opts.intervalHours != null ? opts.intervalHours : Number(process.env.BACKUP_INTERVAL_HOURS ?? 24);
  const keep = opts.keep != null ? opts.keep : Math.max(1, Number(process.env.BACKUP_KEEP ?? 14));
  if (!Number.isFinite(hrs) || hrs <= 0) return null;
  const tick = () => runBackup(db, dataDir, keep)
    .then((f) => console.log('[backup] uložena záloha ' + path.basename(f)))
    .catch((e) => console.error('[backup] selhalo:', e.message));
  setTimeout(tick, 30000).unref();          // první po 30 s (ať server naběhne)
  return setInterval(tick, hrs * 3600 * 1000).unref();
}

module.exports = { runBackup, scheduleBackups, listBackups, prune, backupsDir };

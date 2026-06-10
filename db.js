'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'sklad.db'));
db.pragma('journal_mode = WAL');

function ensureColumns(table, defs) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  for (const [name, ddl] of defs) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      code        TEXT PRIMARY KEY,
      name        TEXT NOT NULL DEFAULT '',
      brand       TEXT NOT NULL DEFAULT '',
      category    TEXT NOT NULL DEFAULT '',
      image_url   TEXT NOT NULL DEFAULT '',
      quantity    REAL NOT NULL DEFAULT 0,
      min_stock   REAL NOT NULL DEFAULT 0,
      price       REAL NOT NULL DEFAULT 0,
      unit        TEXT NOT NULL DEFAULT 'ks',
      supplier    TEXT NOT NULL DEFAULT '',
      location    TEXT NOT NULL DEFAULT '',
      note        TEXT NOT NULL DEFAULT '',
      source      TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS movements (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      code           TEXT NOT NULL,
      name           TEXT NOT NULL DEFAULT '',
      delta          REAL NOT NULL,
      type           TEXT NOT NULL,
      quantity_after REAL NOT NULL,
      user           TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      username     TEXT PRIMARY KEY,
      pass_hash    TEXT NOT NULL,
      salt         TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role         TEXT NOT NULL DEFAULT 'user',
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      username   TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_movements_code ON movements(code);
    CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
  `);

  // ---- Migrace pro starší databáze ----
  ensureColumns('items', [
    ['min_stock', 'min_stock INTEGER NOT NULL DEFAULT 0'],
    ['price', 'price REAL NOT NULL DEFAULT 0'],
    ['unit', "unit TEXT NOT NULL DEFAULT 'ks'"],
    ['supplier', "supplier TEXT NOT NULL DEFAULT ''"],
  ]);
  ensureColumns('movements', [['user', "user TEXT NOT NULL DEFAULT ''"]]);
}

module.exports = { db, initDb };

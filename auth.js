'use strict';

const crypto = require('crypto');
const { db } = require('./db');

const nowIso = () => new Date().toISOString();
const SESSION_DAYS = 30;
const MIN_PASSWORD = 6;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  let h;
  try { h = crypto.scryptSync(String(password), salt, 64).toString('hex'); } catch { return false; }
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(u) { return u && { username: u.username, display_name: u.display_name, role: u.role }; }

function createUser({ username, password, display_name, role }) {
  username = String(username || '').trim();
  if (!username) throw new Error('Chybí uživatelské jméno');
  if (!/^[a-zA-Z0-9._-]{2,40}$/.test(username)) throw new Error('Jméno smí mít 2–40 znaků (písmena, číslice, . _ -)');
  if (String(password || '').length < MIN_PASSWORD) throw new Error(`Heslo musí mít aspoň ${MIN_PASSWORD} znaků`);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new Error('Uživatel už existuje');
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO users (username, pass_hash, salt, display_name, role, created_at) VALUES (?,?,?,?,?,?)')
    .run(username, hash, salt, String(display_name || username).slice(0, 60), role === 'admin' ? 'admin' : 'user', nowIso());
  return publicUser(db.prepare('SELECT * FROM users WHERE username = ?').get(username));
}

function setPassword(username, password) {
  if (String(password || '').length < MIN_PASSWORD) throw new Error(`Heslo musí mít aspoň ${MIN_PASSWORD} znaků`);
  const { salt, hash } = hashPassword(password);
  db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE username = ?').run(hash, salt, username);
  // po změně hesla odhlásit všechna stávající sezení (i případného útočníka)
  db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
}

function randomPassword() {
  return crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 14);
}

// Při prázdné databázi založí admina s NÁHODNÝM heslem (vrátí ho k vypsání do konzole).
function seedAdmin() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return null;
  const password = randomPassword();
  createUser({ username: 'admin', password, display_name: 'Administrátor', role: 'admin' });
  return { username: 'admin', password };
}

function login(username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!u) { try { crypto.scryptSync(String(password || ''), 'timing-equalizer', 64); } catch {} return null; } // vyrovnání času
  if (!verifyPassword(password, u.salt, u.pass_hash)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, username, created_at) VALUES (?,?,?)').run(token, u.username, nowIso());
  return { token, user: publicUser(u) };
}
function logout(token) { if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }

function userByToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT username, created_at FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (Date.now() - new Date(s.created_at).getTime() > SESSION_DAYS * 864e5) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return db.prepare('SELECT * FROM users WHERE username = ?').get(s.username) || null;
}

function cleanupSessions() {
  const cutoff = new Date(Date.now() - SESSION_DAYS * 864e5).toISOString();
  db.prepare('DELETE FROM sessions WHERE created_at < ?').run(cutoff);
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function authMiddleware(req, res, next) {
  const token = parseCookies(req).sid;
  const u = userByToken(token);
  if (u) { req.user = u; req.token = token; }
  next();
}
function requireAuth(req, res, next) { if (!req.user) return res.status(401).json({ error: 'Nepřihlášeno' }); next(); }
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Nepřihlášeno' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Jen pro administrátora' });
  next();
}

module.exports = {
  MIN_PASSWORD, hashPassword, verifyPassword, publicUser, createUser, setPassword, seedAdmin,
  login, logout, userByToken, cleanupSessions, parseCookies, authMiddleware, requireAuth, requireAdmin,
};

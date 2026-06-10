'use strict';

const nodemailer = require('nodemailer');
const { db } = require('./db');

function getSetting(key, def = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function getMailConfig() {
  return {
    enabled: getSetting('alert_enabled', '0') === '1',
    host: getSetting('mail_host', ''),
    port: Number(getSetting('mail_port', '587')) || 587,
    secure: getSetting('mail_secure', '0') === '1',
    user: getSetting('mail_user', ''),
    pass: getSetting('mail_pass', ''),
    from: getSetting('mail_from', ''),
    to: getSetting('alert_to', ''),
  };
}
function isConfigured(c) { c = c || getMailConfig(); return !!(c.host && c.from && c.to); }

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function sendMail(subject, html, text) {
  const c = getMailConfig();
  if (!isConfigured(c)) throw new Error('E-mail není nastavený (chybí server, odesílatel nebo příjemce).');
  const transport = nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
  try {
    await transport.sendMail({ from: c.from, to: c.to, subject, text: text || subject, html });
  } finally {
    transport.close();
  }
}

function lowStockTable(items) {
  const rows = items.map((i) =>
    `<tr><td>${esc(i.name || i.code)}</td><td style="font-family:monospace">${esc(i.code)}</td>` +
    `<td align="right"><b>${i.quantity}</b></td><td align="right">${i.min_stock}</td><td>${esc(i.location || '')}</td></tr>`
  ).join('');
  return `<h2 style="font-family:sans-serif">📦 Položky pod minimální zásobou</h2>
    <table cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <tr style="background:#f1f2f7"><th align="left">Název</th><th align="left">Kód</th><th>Stav</th><th>Min.</th><th align="left">Umístění</th></tr>
      ${rows}
    </table>`;
}

// Upozornění při poklesu konkrétní položky pod minimum (s hodinovým škrcením na kód)
const lastAlert = new Map();
async function maybeAlertCrossing(item) {
  const c = getMailConfig();
  if (!c.enabled || !isConfigured(c)) return;
  const now = Date.now();
  if (lastAlert.has(item.code) && now - lastAlert.get(item.code) < 3600000) return;
  lastAlert.set(item.code, now);
  try {
    await sendMail(`⚠️ Nízká zásoba: ${item.name || item.code}`, lowStockTable([item]));
  } catch (e) {
    console.error('Odeslání upozornění selhalo:', e.message);
  }
}

async function sendLowStockReport() {
  const items = db.prepare('SELECT * FROM items WHERE min_stock > 0 AND quantity < min_stock ORDER BY name, code').all();
  if (!items.length) {
    await sendMail('📦 Sklad: vše v pořádku', '<p style="font-family:sans-serif">Žádné položky pod minimální zásobou. 👍</p>');
    return { count: 0 };
  }
  await sendMail(`📦 Sklad: ${items.length} položek pod minimem`, lowStockTable(items));
  return { count: items.length };
}

async function sendTest() {
  await sendMail('✅ Test – Skladová evidence', '<p style="font-family:sans-serif">Toto je testovací e-mail. Nastavení funguje. 🎉</p>');
}

module.exports = { getSetting, setSetting, getMailConfig, isConfigured, sendMail, maybeAlertCrossing, sendLowStockReport, sendTest };

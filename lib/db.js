// SHOPARA - base de donnees + schema
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'shopara.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  suspended INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  fee_dakar INTEGER DEFAULT 1000,
  fee_regions INTEGER DEFAULT 2000,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  stock INTEGER DEFAULT 0,
  description TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  address TEXT NOT NULL,
  zone TEXT NOT NULL,
  delivery_fee INTEGER NOT NULL,
  total INTEGER NOT NULL,
  payment_mode TEXT NOT NULL,
  payment_status TEXT DEFAULT 'non_paye',
  status TEXT DEFAULT 'en_attente',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,
  months INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  pay_ref TEXT DEFAULT '',
  pay_mode TEXT DEFAULT '',
  status TEXT DEFAULT 'en_attente',
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  page TEXT NOT NULL,
  shop_id INTEGER,
  product_id INTEGER,
  session TEXT NOT NULL,
  referer TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id);
CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id);
CREATE INDEX IF NOT EXISTS idx_visits_shop_ts ON visits(shop_id, ts);
CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts);
`);

function getSetting(k, dflt) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
  return r ? r.value : dflt;
}
function setSetting(k, v) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
}
if (!db.prepare('SELECT key FROM settings WHERE key=?').get('abonnement_numero')) {
  setSetting('abonnement_numero', process.env.NUMERO_ABONNEMENT || '772695341');
}
if (!db.prepare('SELECT key FROM settings WHERE key=?').get('plan_1mois')) setSetting('plan_1mois', '2500');
if (!db.prepare('SELECT key FROM settings WHERE key=?').get('plan_2mois')) setSetting('plan_2mois', '5000');

// Compte super-admin (suspended=-1 => admin)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@shopara.sn';
if (!db.prepare('SELECT id FROM users WHERE email=?').get(ADMIN_EMAIL)) {
  db.prepare('INSERT INTO users(email,name,phone,password_hash) VALUES(?,?,?,?)')
    .run(ADMIN_EMAIL, 'Admin Shopara', '', bcrypt.hashSync(process.env.ADMIN_PASS || 'Shopara2026!', 10));
  db.prepare('UPDATE users SET suspended=-1 WHERE email=?').run(ADMIN_EMAIL);
}

module.exports = db;
module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;

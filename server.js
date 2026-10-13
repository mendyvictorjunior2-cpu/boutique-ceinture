// ============================================================
// SHOPARA - SaaS de boutiques en ligne (Senegal) - v2.0
// ============================================================
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'shopara.db'));
db.pragma('journal_mode = WAL');

// ---------- Schema ----------
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

// ---------- Parametres ----------
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

// ---------- Compte super-admin ----------
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@shopara.sn';
if (!db.prepare('SELECT id FROM users WHERE email=?').get(ADMIN_EMAIL)) {
  db.prepare('INSERT INTO users(email,name,phone,password_hash) VALUES(?,?,?,?)')
    .run(ADMIN_EMAIL, 'Admin Shopara', '', bcrypt.hashSync(process.env.ADMIN_PASS || 'Shopara2026!', 10));
  db.prepare('UPDATE users SET suspended=-1 WHERE email=?').run(ADMIN_EMAIL);
}

// ---------- App + securite ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || 'shopara-secret-change-me',
  resave: false, saveUninitialized: true,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000, secure: 'auto' }
}));
app.use(rateLimit({ windowMs: 60 * 1000, max: 300 }));

function currentUser(req) {
  if (!req.session.userId) return null;
  return db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u || u.suspended === 1) return res.status(401).json({ error: 'Non authentifie ou compte suspendu' });
  req.user = u; next();
}
function requireAdmin(req, res, next) {
  const u = currentUser(req);
  if (!u || u.suspended !== -1) return res.status(403).json({ error: 'Acces admin requis' });
  req.user = u; next();
}
function requireShop(req, res, next) {
  const shop = db.prepare('SELECT * FROM shops WHERE id=? AND user_id=?').get(req.params.shopId, req.user.id);
  if (!shop) return res.status(404).json({ error: 'Boutique introuvable' });
  req.shop = shop; next();
}

// ---------- Suivi des visites (public) ----------
const visitLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.post('/api/track', visitLimiter, (req, res) => {
  try {
    const { page, shopId, productId } = req.body || {};
    if (!page || typeof page !== 'string' || page.length > 100) return res.status(400).end();
    const sid = (req.sessionID || 'anon').slice(0, 32);
    db.prepare("INSERT INTO visits(page,shop_id,product_id,session,referer) VALUES(?,?,?,?,'',datetime('now'))")
      .run(page.slice(0, 100), shopId ? Number(shopId) : null, productId ? Number(productId) : null, sid);
    res.status(204).end();
  } catch (e) { res.status(500).end(); }
});

// ---------- Auth vendeurs ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.post('/api/auth/register', authLimiter, (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !password || password.length < 6)
    return res.status(400).json({ error: 'Nom, email et mot de passe (6+ caracteres) requis' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare('INSERT INTO users(email,name,phone,password_hash) VALUES(?,?,?,?)')
      .run(String(email).toLowerCase().trim(), String(name).trim(), phone || '', hash);
    req.session.userId = r.lastInsertRowid;
    res.json({ ok: true, user: { id: r.lastInsertRowid, name, email } });
  } catch (e) { res.status(409).json({ error: 'Email deja utilise' }); }
});
app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase().trim());
  if (!u || u.suspended === 1 || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ error: 'Identifiants invalides' });
  req.session.userId = u.id;
  res.json({ ok: true, user: { id: u.id, name: u.name, email: u.email, admin: u.suspended === -1 } });
});
app.post('/api/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/auth/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.json({ user: null });
  res.json({ user: { id: u.id, name: u.name, email: u.email, admin: u.suspended === -1 } });
});

// ---------- Boutiques ----------
function slugify(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'boutique';
}
app.post('/api/shops', requireAuth, (req, res) => {
  const { name, description, phone, address, feeDakar, feeRegions } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Nom de boutique requis' });
  let slug = slugify(name), i = 1;
  while (db.prepare('SELECT id FROM shops WHERE slug=?').get(slug)) slug = slugify(name) + '-' + (++i);
  const r = db.prepare('INSERT INTO shops(user_id,name,slug,description,phone,address,fee_dakar,fee_regions) VALUES(?,?,?,?,?,?,?,?)')
    .run(req.user.id, name.trim(), slug, description || '', phone || '', address || '', Number(feeDakar) || 1000, Number(feeRegions) || 2000);
  res.json({ ok: true, shop: { id: r.lastInsertRowid, slug } });
});
app.get('/api/shops', requireAuth, (req, res) => {
  res.json({ shops: db.prepare('SELECT * FROM shops WHERE user_id=? ORDER BY id DESC').all(req.user.id) });
});
app.put('/api/shops/:shopId', requireAuth, requireShop, (req, res) => {
  const { name, description, phone, address, active, feeDakar, feeRegions } = req.body || {};
  db.prepare('UPDATE shops SET name=COALESCE(?,name),description=COALESCE(?,description),phone=COALESCE(?,phone),address=COALESCE(?,address),active=COALESCE(?,active),fee_dakar=COALESCE(?,fee_dakar),fee_regions=COALESCE(?,fee_regions) WHERE id=?')
    .run(name ?? null, description ?? null, phone ?? null, address ?? null, active ?? null,
      feeDakar != null ? Number(feeDakar) : null, feeRegions != null ? Number(feeRegions) : null, req.shop.id);
  res.json({ ok: true });
});

// ---------- Produits ----------
app.post('/api/shops/:shopId/products', requireAuth, requireShop, (req, res) => {
  const { name, price, stock, description } = req.body || {};
  if (!name || !Number(price) || Number(price) <= 0) return res.status(400).json({ error: 'Nom et prix valides requis' });
  const r = db.prepare('INSERT INTO products(shop_id,name,price,stock,description) VALUES(?,?,?,?,?)')
    .run(req.shop.id, String(name).trim(), Math.round(Number(price)), Math.max(0, Math.round(Number(stock) || 0)), description || '');
  res.json({ ok: true, product: { id: r.lastInsertRowid } });
});
app.get('/api/shops/:shopId/products', requireAuth, requireShop, (req, res) => {
  res.json({ products: db.prepare('SELECT * FROM products WHERE shop_id=? ORDER BY id DESC').all(req.shop.id) });
});
app.put('/api/shops/:shopId/products/:pid', requireAuth, requireShop, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=? AND shop_id=?').get(req.params.pid, req.shop.id);
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  const { name, price, stock, description, active } = req.body || {};
  db.prepare('UPDATE products SET name=COALESCE(?,name),price=COALESCE(?,price),stock=COALESCE(?,stock),description=COALESCE(?,description),active=COALESCE(?,active) WHERE id=?')
    .run(name ?? null, price != null ? Math.round(Number(price)) : null, stock != null ? Math.round(Number(stock)) : null, description ?? null, active ?? null, p.id);
  res.json({ ok: true });
});
app.delete('/api/shops/:shopId/products/:pid', requireAuth, requireShop, (req, res) => {
  db.prepare('UPDATE products SET active=0 WHERE id=? AND shop_id=?').run(req.params.pid, req.shop.id);
  res.json({ ok: true });
});

// ---------- Boutique publique ----------
app.get('/api/public/shop/:slug', (req, res) => {
  const shop = db.prepare('SELECT id,name,slug,description,phone,address,fee_dakar,fee_regions FROM shops WHERE slug=? AND active=1').get(req.params.slug);
  if (!shop) return res.status(404).json({ error: 'Boutique introuvable' });
  res.json({ shop, products: db.prepare('SELECT id,name,price,stock,description FROM products WHERE shop_id=? AND active=1 AND stock>0').all(shop.id) });
});

// ---------- Commandes (acheteur) ----------
const orderLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
app.post('/api/public/shop/:slug/order', orderLimiter, (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE slug=? AND active=1').get(req.params.slug);
  if (!shop) return res.status(404).json({ error: 'Boutique introuvable' });
  const { customerName, customerPhone, address, zone, items, paymentMode } = req.body || {};
  if (!customerName || !customerPhone || !address || !['dakar', 'regions'].includes(zone) || !['wave', 'om', 'livraison'].includes(paymentMode))
    return res.status(400).json({ error: 'Donnees de commande incompletes' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Panier vide' });
  let total = 0;
  const resolved = [];
  for (const it of items.slice(0, 20)) {
    const p = db.prepare('SELECT * FROM products WHERE id=? AND shop_id=? AND active=1').get(it.productId, shop.id);
    if (!p || p.stock < it.qty || it.qty < 1 || it.qty > 50) return res.status(400).json({ error: 'Produit indisponible' });
    total += p.price * it.qty;
    resolved.push({ p, qty: it.qty });
  }
  const fee = zone === 'dakar' ? shop.fee_dakar : shop.fee_regions;
  total += fee;
  const code = 'SHP-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
  db.transaction(() => {
    const r = db.prepare('INSERT INTO orders(code,shop_id,customer_name,customer_phone,address,zone,delivery_fee,total,p
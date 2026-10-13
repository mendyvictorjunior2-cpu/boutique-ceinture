// SHOPARA - routes d'authentification + suivi des visites
'use strict';
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { makeAuth } = require('./app');

module.exports = function (app, db) {
  const auth = makeAuth(db);
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

  // Suivi des visites (pages publiques, anti-spam)
  const visitLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
  app.post('/api/track', visitLimiter, (req, res) => {
    try {
      const { page, shopId, productId } = req.body || {};
      if (!page || typeof page !== 'string' || page.length > 100) return res.status(400).end();
      const sid = (req.sessionID || 'anon').slice(0, 32);
      db.prepare('INSERT INTO visits(page,shop_id,product_id,session,referer) VALUES(?,?,?,?,?)')
        .run(page.slice(0, 100), shopId ? Number(shopId) : null, productId ? Number(productId) : null, sid, (req.headers.referer || '').slice(0, 200));
      res.status(204).end();
    } catch (e) { res.status(500).end(); }
  });

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
    const u = auth.getUser(req);
    if (!u) return res.json({ user: null });
    res.json({ user: { id: u.id, name: u.name, email: u.email, admin: u.suspended === -1 } });
  });
};

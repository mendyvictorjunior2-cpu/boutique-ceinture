// SHOPARA - administration plateforme (stats, users, abonnements, reglages, export CSV)
'use strict';
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { makeAuth } = require('./app');
const { getSetting, setSetting } = require('./db');

module.exports = function (app, db) {
  const auth = makeAuth(db);
  const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

  // Connexion admin (meme table users, suspended=-1)
  app.post('/api/admin/login', adminLoginLimiter, (req, res) => {
    const { email, password } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase().trim());
    if (!u || u.suspended !== -1 || !bcrypt.compareSync(password || '', u.password_hash))
      return res.status(401).json({ error: 'Acces refuse' });
    req.session.userId = u.id;
    res.json({ ok: true, admin: true });
  });

  // Statistiques plateforme
  app.get('/api/admin/stats', auth.requireAdmin, (req, res) => {
    const q = (sql) => db.prepare(sql).get();
    res.json({
      stats: {
        users: q('SELECT COUNT(*) c FROM users').c,
        shops: q('SELECT COUNT(*) c FROM shops').c,
        activeShops: q('SELECT COUNT(*) c FROM shops WHERE active=1').c,
        products: q('SELECT COUNT(*) c FROM products').c,
        orders: q('SELECT COUNT(*) c FROM orders').c,
        pendingOrders: q("SELECT COUNT(*) c FROM orders WHERE status='en_attente'").c,
        deliveredOrders: q("SELECT COUNT(*) c FROM orders WHERE status='livree'").c,
        cancelledOrders: q("SELECT COUNT(*) c FROM orders WHERE status='annulee'").c,
        activeSubs: q("SELECT COUNT(*) c FROM subscriptions WHERE status='actif' AND ends_at>=date('now')").c,
        expiredSubs: q("SELECT COUNT(*) c FROM subscriptions WHERE status='actif' AND ends_at<date('now')").c,
        pendingSubs: q("SELECT COUNT(*) c FROM subscriptions WHERE status IN ('en_attente','en_verification')").c,
        revenueConfirmed: q("SELECT COALESCE(SUM(amount),0) s FROM subscriptions WHERE status='actif'").s,
        revenuePending: q("SELECT COALESCE(SUM(amount),0) s FROM subscriptions WHERE status IN ('en_attente','en_verification')").s,
        revenueToday: q("SELECT COALESCE(SUM(amount),0) s FROM subscriptions WHERE status='actif' AND date(created_at)=date('now')").s,
        revenue7d: q("SELECT COALESCE(SUM(amount),0) s FROM subscriptions WHERE status='actif' AND created_at>=datetime('now','-7 days')").s,
        revenue30d: q("SELECT COALESCE(SUM(amount),0) s FROM subscriptions WHERE status='actif' AND created_at>=datetime('now','-30 days')").s,
        visitsTotal: q('SELECT COUNT(*) c FROM visits').c,
        uniqueTotal: q('SELECT COUNT(DISTINCT session) c FROM visits').c,
        visitsToday: q("SELECT COUNT(*) c FROM visits WHERE date(ts)=date('now')").c,
        visits7d: q("SELECT COUNT(*) c FROM visits WHERE ts>=datetime('now','-7 days')").c,
        visits30d: q("SELECT COUNT(*) c FROM visits WHERE ts>=datetime('now','-30 days')").c,
        topPages: db.prepare('SELECT page, COUNT(*) v FROM visits GROUP BY page ORDER BY v DESC LIMIT 10').all(),
        signupsByDay: db.prepare("SELECT date(created_at) d, COUNT(*) c FROM users WHERE created_at>=datetime('now','-30 days') GROUP BY date(created_at)").all(),
        shopsByDay: db.prepare("SELECT date(created_at) d, COUNT(*) c FROM shops WHERE created_at>=datetime('now','-30 days') GROUP BY date(created_at)").all()
      }
    });
  });

  // Utilisateurs
  app.get('/api/admin/users', auth.requireAdmin, (req, res) => {
    res.json({ users: db.prepare('SELECT id,name,email,phone,suspended,created_at FROM users ORDER BY id DESC LIMIT 200').all() });
  });
  app.get('/api/admin/users/:id/shops', auth.requireAdmin, (req, res) => {
    res.json({ shops: db.prepare('SELECT * FROM shops WHERE user_id=?').all(req.params.id) });
  });
  app.put('/api/admin/users/:id/suspend', auth.requireAdmin, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (u.suspended === -1) return res.status(400).json({ error: 'Impossible de suspendre un admin' });
    db.prepare('UPDATE users SET suspended=? WHERE id=?').run(u.suspended === 1 ? 0 : 1, u.id);
    res.json({ ok: true, suspended: u.suspended !== 1 });
  });

  // Abonnements
  app.get('/api/admin/subscriptions', auth.requireAdmin, (req, res) => {
    res.json({ subscriptions: db.prepare('SELECT s.*, u.name user_name, u.email user_email FROM subscriptions s JOIN users u ON u.id=s.user_id ORDER BY s.id DESC LIMIT 200').all() });
  });
  function applySubscription(subId) {
    const sub = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subId);
    if (!sub) return;
    const current = db.prepare("SELECT ends_at FROM subscriptions WHERE user_id=? AND status='actif' ORDER BY ends_at DESC LIMIT 1").get(sub.user_id);
    let start = new Date();
    if (current && current.ends_at && new Date(current.ends_at) > start) start = new Date(current.ends_at);
    const ends = new Date(start);
    ends.setMonth(ends.getMonth() + sub.months);
    db.prepare("UPDATE subscriptions SET status='actif', starts_at=?, ends_at=? WHERE id=?").run(start.toISOString(), ends.toISOString(), sub.id);
  }
  app.put('/api/admin/subscriptions/:id/validate', auth.requireAdmin, (req, res) => {
    const sub = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Abonnement introuvable' });
    if (sub.status === 'actif') return res.status(400).json({ error: 'Deja actif' });
    applySubscription(sub.id);
    res.json({ ok: true });
  });
  app.put('/api/admin/subscriptions/:id/reject', auth.requireAdmin, (req, res) => {
    db.prepare("UPDATE subscriptions SET status='rejete' WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  });

  // Boutiques
  app.get('/api/admin/shops', auth.requireAdmin, (req, res) => {
    res.json({ shops: db.prepare('SELECT s.*, u.name user_name FROM shops s JOIN users u ON u.id=s.user_id ORDER BY s.id DESC LIMIT 200').all() });
  });
  app.put('/api/admin/shops/:id/active', auth.requireAdmin, (req, res) => {
    const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Boutique introuvable' });
    db.prepare('UPDATE shops SET active=? WHERE id=?').run(shop.active === 1 ? 0 : 1, shop.id);
    res.json({ ok: true });
  });

  // Reglages (numero de paiement, tarifs) - cote serveur uniquement
  app.get('/api/admin/settings', auth.requireAdmin, (req, res) => {
    res.json({ settings: Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value])) });
  });
  app.put('/api/admin/settings', auth.requireAdmin, (req, res) => {
    const { abonnement_numero, plan_1mois, plan_2mois } = req.body || {};
    if (abonnement_numero) setSetting('abonnement_numero', String(abonnement_numero).trim().slice(0, 20));
    if (plan_1mois) setSetting('plan_1mois', String(Math.round(Number(plan_1mois) || 2500)));
    if (plan_2mois) setSetting('plan_2mois', String(Math.round(Number(plan_2mois) || 5000)));
    res.json({ ok: true });
  });

  // Export CSV des abonnements
  app.get('/api/admin/export/subscriptions.csv', auth.requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT s.id,u.email,s.plan,s.amount,s.status,s.pay_ref,s.starts_at,s.ends_at,s.created_at FROM subscriptions s JOIN users u ON u.id=s.user_id ORDER BY s.id DESC').all();
    res.type('text/csv');
    res.write('id,email,formule,montant,statut,reference,debut,fin,cree_le\n');
    for (const r of rows) res.write([r.id, r.email, r.plan, r.amount, r.status, r.pay_ref || '', r.starts_at || '', r.ends_at || '', r.created_at].join(',') + '\n');
    res.end();
  });
};

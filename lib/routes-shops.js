// SHOPARA - boutiques, produits, boutique publique, stats vendeur
'use strict';
const { makeAuth } = require('./app');

module.exports = function (app, db) {
  const auth = makeAuth(db);

  function slugify(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'boutique';
  }

  // --- Boutiques (vendeur) ---
  app.post('/api/shops', auth.requireAuth, (req, res) => {
    const { name, description, phone, address, feeDakar, feeRegions } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Nom de boutique requis' });
    let slug = slugify(name), i = 1;
    while (db.prepare('SELECT id FROM shops WHERE slug=?').get(slug)) slug = slugify(name) + '-' + (++i);
    const r = db.prepare('INSERT INTO shops(user_id,name,slug,description,phone,address,fee_dakar,fee_regions) VALUES(?,?,?,?,?,?,?,?)')
      .run(req.user.id, name.trim(), slug, description || '', phone || '', address || '', Number(feeDakar) || 1000, Number(feeRegions) || 2000);
    res.json({ ok: true, shop: { id: r.lastInsertRowid, slug } });
  });

  app.get('/api/shops', auth.requireAuth, (req, res) => {
    res.json({ shops: db.prepare('SELECT * FROM shops WHERE user_id=? ORDER BY id DESC').all(req.user.id) });
  });

  app.put('/api/shops/:shopId', auth.requireAuth, auth.requireShop, (req, res) => {
    const { name, description, phone, address, active, feeDakar, feeRegions } = req.body || {};
    db.prepare('UPDATE shops SET name=COALESCE(?,name),description=COALESCE(?,description),phone=COALESCE(?,phone),address=COALESCE(?,address),active=COALESCE(?,active),fee_dakar=COALESCE(?,fee_dakar),fee_regions=COALESCE(?,fee_regions) WHERE id=?')
      .run(name ?? null, description ?? null, phone ?? null, address ?? null, active ?? null,
        feeDakar != null ? Number(feeDakar) : null, feeRegions != null ? Number(feeRegions) : null, req.shop.id);
    res.json({ ok: true });
  });

  // --- Produits (vendeur) ---
  app.post('/api/shops/:shopId/products', auth.requireAuth, auth.requireShop, (req, res) => {
    const { name, price, stock, description } = req.body || {};
    if (!name || !Number(price) || Number(price) <= 0) return res.status(400).json({ error: 'Nom et prix valides requis' });
    const r = db.prepare('INSERT INTO products(shop_id,name,price,stock,description) VALUES(?,?,?,?,?)')
      .run(req.shop.id, String(name).trim(), Math.round(Number(price)), Math.max(0, Math.round(Number(stock) || 0)), description || '');
    res.json({ ok: true, product: { id: r.lastInsertRowid } });
  });

  app.get('/api/shops/:shopId/products', auth.requireAuth, auth.requireShop, (req, res) => {
    res.json({ products: db.prepare('SELECT * FROM products WHERE shop_id=? ORDER BY id DESC').all(req.shop.id) });
  });

  app.put('/api/shops/:shopId/products/:pid', auth.requireAuth, auth.requireShop, (req, res) => {
    const p = db.prepare('SELECT * FROM products WHERE id=? AND shop_id=?').get(req.params.pid, req.shop.id);
    if (!p) return res.status(404).json({ error: 'Produit introuvable' });
    const { name, price, stock, description, active } = req.body || {};
    db.prepare('UPDATE products SET name=COALESCE(?,name),price=COALESCE(?,price),stock=COALESCE(?,stock),description=COALESCE(?,description),active=COALESCE(?,active) WHERE id=?')
      .run(name ?? null, price != null ? Math.round(Number(price)) : null, stock != null ? Math.round(Number(stock)) : null, description ?? null, active ?? null, p.id);
    res.json({ ok: true });
  });

  app.delete('/api/shops/:shopId/products/:pid', auth.requireAuth, auth.requireShop, (req, res) => {
    db.prepare('UPDATE products SET active=0 WHERE id=? AND shop_id=?').run(req.params.pid, req.shop.id);
    res.json({ ok: true });
  });

  // --- Boutique publique (acheteur) ---
  app.get('/api/public/shop/:slug', (req, res) => {
    const shop = db.prepare('SELECT id,name,slug,description,phone,address,fee_dakar,fee_regions FROM shops WHERE slug=? AND active=1').get(req.params.slug);
    if (!shop) return res.status(404).json({ error: 'Boutique introuvable' });
    res.json({ shop, products: db.prepare('SELECT id,name,price,stock,description FROM products WHERE shop_id=? AND active=1 AND stock>0').all(shop.id) });
  });

  // --- Commandes du vendeur ---
  app.get('/api/shops/:shopId/orders', auth.requireAuth, auth.requireShop, (req, res) => {
    res.json({ orders: db.prepare('SELECT * FROM orders WHERE shop_id=? ORDER BY id DESC').all(req.shop.id) });
  });

  app.put('/api/shops/:shopId/orders/:oid', auth.requireAuth, auth.requireShop, (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id=? AND shop_id=?').get(req.params.oid, req.shop.id);
    if (!o) return res.status(404).json({ error: 'Commande introuvable' });
    const { status, paymentStatus } = req.body || {};
    if (status && !['en_attente', 'confirmee', 'livree', 'annulee'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
    if (paymentStatus && !['non_paye', 'en_attente_paiement', 'payee'].includes(paymentStatus)) return res.status(400).json({ error: 'Statut de paiement invalide' });
    db.prepare('UPDATE orders SET status=COALESCE(?,status), payment_status=COALESCE(?,payment_status) WHERE id=?')
      .run(status || null, paymentStatus || null, o.id);
    res.json({ ok: true });
  });

  // --- Stats vendeur (isolation par boutique) ---
  app.get('/api/shops/:shopId/stats', auth.requireAuth, auth.requireShop, (req, res) => {
    const sid = req.shop.id;
    const q = (sql) => db.prepare(sql).get(sid);
    const totalOrders = q('SELECT COUNT(*) c FROM orders WHERE shop_id=?').c;
    const stats = {
      totalOrders,
      delivered: q("SELECT COUNT(*) c FROM orders WHERE shop_id=? AND status='livree'").c,
      cancelled: q("SELECT COUNT(*) c FROM orders WHERE shop_id=? AND status='annulee'").c,
      pending: q("SELECT COUNT(*) c FROM orders WHERE shop_id=? AND status='en_attente'").c,
      confirmedCA: q("SELECT COALESCE(SUM(total),0) s FROM orders WHERE shop_id=? AND status IN ('confirmee','livree') AND payment_status='payee'").s,
      outOfStock: q('SELECT COUNT(*) c FROM products WHERE shop_id=? AND stock<=0').c,
      visits30: q("SELECT COUNT(*) c FROM visits WHERE shop_id=? AND ts>=datetime('now','-30 days')").c,
      unique30: q("SELECT COUNT(DISTINCT session) c FROM visits WHERE shop_id=? AND ts>=datetime('now','-30 days')").c,
      visitsToday: q("SELECT COUNT(*) c FROM visits WHERE shop_id=? AND date(ts)=date('now')").c,
      visits7: q("SELECT COUNT(*) c FROM visits WHERE shop_id=? AND ts>=datetime('now','-7 days')").c,
      byDay: db.prepare("SELECT date(ts) d, COUNT(*) v, COUNT(DISTINCT session) u FROM visits WHERE shop_id=? AND ts>=datetime('now','-30 days') GROUP BY date(ts)").all(sid),
      topProducts: db.prepare("SELECT p.name, COUNT(*) v FROM visits v JOIN products p ON p.id=v.product_id WHERE v.shop_id=? AND v.product_id IS NOT NULL AND v.ts>=datetime('now','-30 days') GROUP BY p.id ORDER BY v DESC LIMIT 5").all(sid),
      ordersByDay: db.prepare("SELECT date(created_at) d, COUNT(*) c FROM orders WHERE shop_id=? AND created_at>=datetime('now','-30 days') GROUP BY date(created_at)").all(sid)
    };
    stats.conversion = stats.unique30 > 0 ? +(totalOrders / stats.unique30 * 100).toFixed(1) : 0;
    stats.conversionDefinition = "commandes totales / visiteurs uniques (30 j) x 100";
    res.json({ stats });
  });
};

// SHOPARA - commandes acheteur + reçus (public, sans fausse confirmation)
'use strict';
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

module.exports = function (app, db) {
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
      const r = db.prepare('INSERT INTO orders(code,shop_id,customer_name,customer_phone,address,zone,delivery_fee,total,payment_mode) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(code, shop.id, String(customerName).trim().slice(0, 100), String(customerPhone).trim().slice(0, 20), String(address).trim().slice(0, 200), zone, fee, total, paymentMode);
      for (const { p, qty } of resolved) {
        db.prepare('INSERT INTO order_items(order_id,product_id,name,qty,price) VALUES(?,?,?,?,?)').run(r.lastInsertRowid, p.id, p.name, qty, p.price);
        db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(qty, p.id);
      }
    })();
    res.json({
      ok: true,
      order: {
        code, total, fee,
        paymentStatus: paymentMode === 'livraison' ? 'non_paye' : 'en_attente_paiement',
        paymentInstructions: paymentMode === 'livraison'
          ? 'A payer a la livraison. Reste non regle jusqu a confirmation du vendeur.'
          : 'Envoyez ' + total + ' FCFA au ' + (shop.phone || 'numero de la boutique') + ' (' + (paymentMode === 'wave' ? 'Wave' : 'Orange Money') + ') puis communiquez la reference au vendeur. Le paiement reste en attente jusqu a verification.'
      }
    });
  });

  // Consultation d'une commande + recu (public par code unique)
  app.get('/api/public/order/:code', (req, res) => {
    const o = db.prepare('SELECT o.*, s.name shop_name, s.phone shop_phone, s.address shop_address, s.slug shop_slug FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.code=?')
      .get(String(req.params.code || '').trim().toUpperCase());
    if (!o) return res.status(404).json({ error: 'Commande introuvable' });
    const items = db.prepare('SELECT name,qty,price FROM order_items WHERE order_id=?').all(o.id);
    res.json({ order: o, items });
  });
};

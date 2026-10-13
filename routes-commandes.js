// routes-commandes.js - Shopara: commandes et recus
'use strict';
const { genererNumeroCommande } = require('./auth');

module.exports = function (app, ctx) {
  const { db, utilisateurCourant, exigeConnexion, limiteCommandes } = ctx;

  app.post('/api/pub/commande', limiteCommandes, (req, res) => {
    const { slug, client_nom, client_telephone, client_adresse, zone_livraison, mode_paiement, articles } = req.body || {};
    const b = db.prepare('SELECT * FROM boutiques WHERE slug = ? AND publiee = 1').get(String(slug || '').slice(0, 50));
    if (!b) return res.status(404).json({ erreur: 'Boutique introuvable.' });
    if (!client_nom || !client_telephone || !client_adresse) return res.status(400).json({ erreur: 'Champs requis manquants.' });
    if (!Array.isArray(articles) || articles.length === 0) return res.status(400).json({ erreur: 'Aucun article.' });
    let sousTotal = 0;
    const lignes = [];
    for (const a of articles.slice(0, 20)) {
      const p = db.prepare('SELECT * FROM produits WHERE id = ? AND boutique_id = ?').get(Number(a.produit_id), b.id);
      if (!p) return res.status(400).json({ erreur: 'Produit invalide.' });
      const qte = Math.max(1, Math.min(20, Number(a.quantite) || 1));
      if (p.stock < qte) return res.status(409).json({ erreur: 'Stock insuffisant.' });
      sousTotal += p.prix * qte;
      lignes.push({ produit_id: p.id, nom: p.nom, prix: p.prix, quantite: qte });
    }
    const frais = zone_livraison === 'regions' ? b.frais_livraison_regions : b.frais_livraison_dakar;
    const total = sousTotal + frais;
    const numero = genererNumeroCommande();
    const mode = ['wave', 'om', 'livraison'].includes(mode_paiement) ? mode_paiement : 'wave';
    db.prepare('INSERT INTO commandes (numero, boutique_id, client_nom, client_telephone, client_adresse, zone_livraison, articles_json, sous_total, frais_livraison, total, mode_paiement) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(numero, b.id, String(client_nom).slice(0, 80), String(client_telephone).slice(0, 20), String(client_adresse).slice(0, 200), zone_livraison === 'regions' ? 'regions' : 'dakar', JSON.stringify(lignes), sousTotal, frais, total, mode);
    res.json({ ok: true, numero, total, statut: 'en_attente', statut_paiement: 'en_attente_paiement' });
  });

  app.get('/api/pub/recu/:numero', (req, res) => {
    const c = db.prepare('SELECT c.*, b.nom bnom, b.telephone btel, b.email bemail, b.adresse badresse FROM commandes c JOIN boutiques b ON b.id = c.boutique_id WHERE c.numero = ?').get(String(req.params.numero).slice(0, 30));
    if (!c) return res.status(404).json({ erreur: 'Commande introuvable.' });
    res.json({
      boutique: { nom: c.bnom, telephone: c.btel, email: c.bemail, adresse: c.badresse },
      numero: c.numero, date: c.cree_le, articles: JSON.parse(c.articles_json),
      sous_total: c.sous_total, frais_livraison: c.frais_livraison, total: c.total,
      mode_paiement: c.mode_paiement, statut_paiement: c.statut_paiement, statut: c.statut
    });
  });

  app.get('/api/boutiques/:id/commandes', exigeConnexion, (req, res) => {
    const u = utilisateurCourant(req);
    const b = db.prepare('SELECT id FROM boutiques WHERE id = ? AND vendeur_id = ?').get(Number(req.params.id), u.id);
    if (!b) return res.status(404).json({ erreur: 'Boutique introuvable.' });
    res.json(db.prepare('SELECT numero, client_nom, client_telephone, client_adresse, zone_livraison, articles_json, sous_total, frais_livraison, total, mode_paiement, statut, statut_paiement, reference_paiement, cree_le FROM commandes WHERE boutique_id = ? ORDER BY cree_le DESC LIMIT 200').all(b.id));
  });

  app.put('/api/commandes/:numero/statut', exigeConnexion, (req, res) => {
    const u = utilisateurCourant(req);
    const c = db.prepare('SELECT c.*, b.vendeur_id FROM commandes c JOIN boutiques b ON b.id = c.boutique_id WHERE c.numero = ?').get(String(req.params.numero).slice(0, 30));
    if (!c || c.vendeur_id !== u.id) return res.status(404).json({ erreur: 'Commande introuvable.' });
    const s = String((req.body || {}).statut || '');
    if (!['confirmee', 'livree', 'annulee'].includes(s)) return res.status(400).json({ erreur: 'Statut invalide.' });
    db.prepare('UPDATE commandes SET statut = ? WHERE numero = ?').run(s, c.numero);
    if (s === 'livree') {
      const arts = JSON.parse(c.articles_json);
      const dec = db.prepare('UPDATE produits SET stock = MAX(0, stock - ?) WHERE id = ?');
      for (const a of arts) dec.run(a.quantite, a.produit_id);
    }
    res.json({ ok: true });
  });

  app.put('/api/commandes/:numero/paiement', exigeConnexion, (req, res) => {
    const u = utilisateurCourant(req);
    const c = db.prepare('SELECT c.*, b.vendeur_id FROM commandes c JOIN boutiques b ON b.id = c.boutique_id WHERE c.numero = ?').get(String(req.params.numero).slice(0, 30));
    if (!c || c.vendeur_id !== u.id) return res.status(404).json({ erreur: 'Commande introuvable.' });
    const s = String((req.body || {}).statut_paiement || '');
    if (!['payee', 'annule'].includes(s)) return res.status(400).json({ erreur: 'Statut invalide.' });
    db.prepare('UPDATE commandes SET statut_paiement = ?, reference_paiement = COALESCE(NULLIF(?, ""), reference_paiement) WHERE numero = ?')
      .run(s, String((req.body || {}).reference || '').slice(0, 50), c.numero);
    res.json({ ok: true });
  });
};

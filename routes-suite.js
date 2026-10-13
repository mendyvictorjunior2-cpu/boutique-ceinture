// Suite des routes Shopara: dashboard vendeur, abonnements, admin, pages
module.exports = function(app, ctx) {
  const { db, randomId, requireVendeur, requireAdmin } = ctx;
  const path = require('path');

  // ===== DASHBOARD VENDEUR =====
  app.get('/api/vendeur/stats', requireVendeur, (req, res) => {
    const boutiques = db.prepare('SELECT id, slug, nom, publiee FROM boutiques WHERE vendeur_id = ?').all(req.vendeur.id);
    const ids = boutiques.map(b => b.id);
    const inClause = ids.length ? ids.map(() => '?').join(',') : 'NULL';
    const q = (sql) => ids.length ? db.prepare(sql).get(...ids) : { n: 0, s: 0 };
    const nbCommandes = q(`SELECT COUNT(*) n FROM commandes WHERE boutique_id IN (${inClause})`).n;
    const nbLivrees = q(`SELECT COUNT(*) n FROM commandes WHERE boutique_id IN (${inClause}) AND statut='livree'`).n;
    const nbAnnulees = q(`SELECT COUNT(*) n FROM commandes WHERE boutique_id IN (${inClause}) AND statut='annulee'`).n;
    const caConfirme = q(`SELECT COALESCE(SUM(total),0) s FROM commandes WHERE boutique_id IN (${inClause}) AND statut_paiement='paye'`).s;
    const nbEnAttente = q(`SELECT COUNT(*) n FROM commandes WHERE boutique_id IN (${inClause}) AND statut='en_attente'`).n;
    const nbRupture = q(`SELECT COUNT(*) n FROM produits WHERE boutique_id IN (${inClause}) AND actif=1 AND stock<=0`).n;
    const pagesVues = q(`SELECT COUNT(*) n FROM visites WHERE boutique_id IN (${inClause})`).n;
    const visiteursUniques = q(`SELECT COUNT(DISTINCT sid) n FROM visites WHERE boutique_id IN (${inClause})`).n;
    const visitesJour = q(`SELECT COUNT(*) n FROM visites WHERE boutique_id IN (${inClause}) AND date(cree_le)=date('now')`).n;
    const visitesSemaine = q(`SELECT COUNT(*) n FROM visites WHERE boutique_id IN (${inClause}) AND date(cree_le)>=date('now','-6 days')`).n;
    const visitesMois = q(`SELECT COUNT(*) n FROM visites WHERE boutique_id IN (${inClause}) AND date(cree_le)>=date('now','-29 days')`).n;
    const tauxConversion = visiteursUniques > 0 ? Math.round(nbCommandes / visiteursUniques * 1000) / 10 : 0;
    res.json({ boutiques, nbCommandes, nbLivrees, nbAnnulees, caConfirme, nbEnAttente, nbRupture, pagesVues, visiteursUniques, visitesJour, visitesSemaine, visitesMois, tauxConversion });
  });

  app.get('/api/vendeur/commandes', requireVendeur, (req, res) => {
    const boutiques = db.prepare('SELECT id FROM boutiques WHERE vendeur_id = ?').all(req.vendeur.id);
    const ids = boutiques.map(b => b.id);
    if (!ids.length) return res.json([]);
    const inClause = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT c.*, b.nom AS boutique_nom FROM commandes c JOIN boutiques b ON b.id = c.boutique_id WHERE c.boutique_id IN (${inClause}) ORDER BY c.cree_le DESC LIMIT 200`).all(...ids);
    for (const c of rows) c.lignes = db.prepare('SELECT nom, prix_unitaire, quantite FROM lignes_commande WHERE commande_id = ?').all(c.id);
    res.json(rows);
  });

  app.post('/api/vendeur/commandes/:id/paiement-recu', requireVendeur, (req, res) => {
    const c = db.prepare('SELECT c.* FROM commandes c JOIN boutiques b ON b.id = c.boutique_id WHERE c.id = ? AND b.vendeur_id = ?').get(req.params.id, req.vendeur.id);
    if (!c) return res.status(404).json({ error: 'Commande introuvable.' });
    db.prepare("UPDATE commandes SET statut_paiement = 'paye' WHERE id = ?").run(c.id);
    res.json({ ok: true });
  });

  app.post('/api/vendeur/commandes/:id/statut', requireVendeur, (req, res) => {
    const c = db.prepare('SELECT c.* FROM commandes c JOIN boutiques b ON b.id = c.boutique_id WHERE c.id = ? AND b.vendeur_id = ?').get(req.params.id, req.vendeur.id);
    if (!c) return res.status(404).json({ error: 'Commande introuvable.' });
    const s = req.body && req.body.statut;
    if (!['en_attente', 'confirmee', 'livree', 'annulee'].includes(s)) return res.status(400).json({ error: 'Statut invalide.' });
    if (s === 'annulee') {
      const lignes = db.prepare('SELECT produit_id, quantite FROM lignes_commande WHERE commande_id = ?').all(c.id);
      for (const l of lignes) db.prepare('UPDATE produits SET stock = stock + ? WHERE id = ?').run(l.quantite, l.produit_id);
    }
    db.prepare('UPDATE commandes SET statut = ? WHERE id = ?').run(s, c.id);
    res.json({ ok: true });
  });

  // ===== ABONNEMENTS =====
  const OFFRES = { '1mois': { mois: 1, montant: 2500 }, '2mois': { mois: 2, montant: 5000 } };
  app.get('/api/abonnement/offres', (req, res) => {
    const num = db.prepare('SELECT valeur FROM parametres WHERE cle = ?').get('numero_paiement_abonnement');
    const moyen = db.prepare('SELECT valeur FROM parametres WHERE cle = ?').get('moyen_paiement_abonnement');
    res.json({ offres: OFFRES, numeroPaiement: num ? num.valeur : null, moyenPaiement: moyen ? moyen.valeur : null });
  });

  app.post('/api/vendeur/abonnement', requireVendeur, (req, res) => {
    const { offre, reference, boutiqueSlug } = req.body || {};
    if (!OFFRES[offre]) return res.status(400).json({ error: 'Offre invalide.' });
    if (!reference || String(reference).length < 4) return res.status(400).json({ error: 'Reference de paiement requise.' });
    const b = db.prepare('SELECT * FROM boutiques WHERE vendeur_id = ? AND slug = ?').get(req.vendeur.id, String(boutiqueSlug||''));
    if (!b) return res.status(400).json({ error: 'Choisissez la boutique concernee.' });
    db.prepare("INSERT INTO abonnements (id, vendeur_id, boutique_id, offre, montant, reference_paiement, statut, cree_le) VALUES (?,?,?,?,?,?, 'en_attente', datetime('now'))")
      .run(randomId(), req.vendeur.id, b.id, offre, OFFRES[offre].montant, String(reference).trim());
    res.json({ ok: true, message: 'Paiement enregistre. Activation apres verification par Shopara (sous 24h).' });
  });

  app.get('/api/vendeur/abonnements', requireVendeur, (req, res) => {
    res.json(db.prepare('SELECT a.*, b.nom AS boutique_nom, b.slug AS boutique_slug FROM abonnements a JOIN boutiques b ON b.id = a.boutique_id WHERE a.vendeur_id = ? ORDER BY a.cree_le DESC').all(req.vendeur.id));
  });

  // ===== ADMIN PLATEFORME =====
  app.post('/api/admin/login', (req, res) => {
    const au = process.env.ADMIN_USER || 'admin';
    const ap = process.env.ADMIN_PASS || '';
    if (!ap) return res.status(503).json({ error: 'Admin non configure.' });
    if (req.body && req.body.utilisateur === au && req.body.motDePasse === ap) {
      req.session.isAdmin = true;
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Identifiants invalides.' });
  });

  const adminGuard = (req, res, next) => {
    if (req.session.isAdmin === true) return next();
    return res.status(401).json({ error: 'Acces admin requis.' });
  };

  app.get('/api/admin/stats', adminGuard, (req, res) => {
    const one = (sql) => db.prepare(sql).get();
    res.json({
      nbVendeurs: one('SELECT COUNT(*) n FROM vendeurs').n,
      nbActifs: one('SELECT COUNT(*) n FROM vendeurs WHERE actif=1').n,
      nbBoutiques: one('SELECT COUNT(*) n FROM boutiques').n,
      nbPubliees: one('SELECT COUNT(*) n FROM boutiques WHERE publiee=1').n,
      nbProduits: one('SELECT COUNT(*) n FROM produits').n,
      nbCommandes: one('SELECT COUNT(*) n FROM commandes').n,
      cmdAttente: one("SELECT COUNT(*) n FROM commandes WHERE statut='en_attente'").n,
      cmdConfirm: one("SELECT COUNT(*) n FROM commandes WHERE statut='confirmee'").n,
      cmdLivrees: one("SELECT COUNT(*) n FROM commandes WHERE statut='livree'").n,
      cmdAnnulees: one("SELECT COUNT(*) n FROM commandes WHERE statut='annulee'").n,
      pagesVues: one('SELECT COUNT(*) n FROM visites').n,
      visiteursUniques: one('SELECT COUNT(DISTINCT sid) n FROM visites').n,
      visitesJour: one("SELECT COUNT(*) n FROM visites WHERE date(cree_le)=date('now')").n,
      visites7: one("SELECT COUNT(*) n FROM visites WHERE date(cree_le)>=date('now','-6 days')").n,
      visites30: one("SELECT COUNT(*) n FROM visites WHERE date(cree_le)>=date('now','-29 days')").n,
      nbAbActifs: one("SELECT COUNT(*) n FROM abonnements WHERE statut='actif' AND expire_le>=date('now')").n,
      nbAbExpires: one("SELECT COUNT(*) n FROM abonnements WHERE statut='actif' AND expire_le<date('now')").n,
      nbAb1m: one("SELECT COUNT(*) n FROM abonnements WHERE offre='1mois' AND statut='actif'").n,
      nbAb2m: one("SELECT COUNT(*) n FROM abonnements WHERE offre='2mois' AND statut='actif'").n,
      revenusConfirmes: one("SELECT COALESCE(SUM(montant),0) s FROM abonnements WHERE statut='actif'").s,
      paiementsAttente: one("SELECT COUNT(*) n FROM abonnements WHERE statut='en_attente'").n,
      topPages: db.prepare('SELECT page, COUNT(*) vues FROM visites GROUP BY page ORDER BY vues DESC LIMIT 10').all()
    });
  });

  app.get('/api/admin/abonnements', adminGuard, (req, res) => {
    res.json(db.prepare('SELECT a.*, v.nom AS vendeur_nom, v.email AS vendeur_email, b.nom AS boutique_nom FROM abonnements a JOIN vendeurs v ON v.id=a.vendeur_id JOIN boutiques b ON b.id=a.boutique_id ORDER BY a.cree_le DESC').all());
  });

  app.post('/api/admin/abonnements/:id/valider', adminGuard, (req, res) => {
    const ab = db.prepare('SELECT * FROM abonnements WHERE id = ?').get(req.params.id);
    if (!ab) return res.status(404).json({ error: 'Abonnement introuvable.' });
    if (ab.statut === 'actif') return res.status(400).json({ error: 'Deja actif.' });
    const mois = OFFRES[ab.offre].mois;
    const dernier = db.prepare("SELECT expire_le FROM abonnements WHERE boutique_id = ? AND statut='actif' AND expire_le>date('now') ORDER BY expire_le DESC LIMIT 1").get(ab.boutique_id);
    db.prepare("UPDATE abonnements SET statut='actif', debut_le=datetime('now'), expire_le=datetime(COALESCE(?, 'now'), '+' || ? || ' months') WHERE id = ?")
      .run(dernier ? dernier.expire_le : null, mois, ab.id);
    res.json({ ok: true });
  });

  app.get('/api/admin/vendeurs', adminGuard, (req, res) => {
    const rows = db.prepare('SELECT id, nom, email, telephone, actif, cree_le FROM vendeurs ORDER BY cree_le DESC').all();
    for (const v of rows) v.nbBoutiques = db.prepare('SELECT COUNT(*) n FROM boutiques WHERE vendeur_id=?').get(v.id).n;
    res.json(rows);
  });

  app.post('/api/admin/vendeurs/:id/statut', adminGuard, (req, res) => {
    db.prepare('UPDATE vendeurs SET actif = ? WHERE id = ?').run(req.body && req.body.actif ? 1 : 0, req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/admin/commandes', adminGuard, (req, res) => {
    res.json(db.prepare('SELECT c.numero, c.nom_client, c.total, c.statut, c.statut_paiement, c.cree_le, b.nom AS boutique_nom FROM commandes c JOIN boutiques b ON b.id=c.boutique_id ORDER BY c.cree_le DESC LIMIT 200').all());
  });

  app.get('/api/admin/parametres', adminGuard, (req, res) => {
    res.json(db.prepare('SELECT cle, valeur FROM parametres').all());
  });
  app.post('/api/admin/parametres', adminGuard, (req, res) => {
    const { cle, valeur } = req.body || {};
    if (!cle || !valeur) return res.status(400).json({ error: 'Cle et valeur requises.' });
    db.prepare('INSERT OR REPLACE INTO parametres (cle, valeur) VALUES (?,?)').run(String(cle), String(valeur));
    res.json({ ok: true });
  });

  app.get('/api/admin/export-stats.csv', adminGuard, (req, res) => {
    const rows = [
      ['vendeurs', db.prepare('SELECT COUNT(*) n FROM vendeurs').get().n],
      ['boutiques', db.prepare('SELECT COUNT(*) n FROM boutiques').get().n],
      ['commandes', db.prepare('SELECT COUNT(*) n FROM commandes').get().n],
      ['visiteurs_uniques', db.prepare('SELECT COUNT(DISTINCT sid) n FROM visites').get().n],
      ['abonnements_actifs', db.prepare("SELECT COUNT(*) n FROM abonnements WHERE statut='actif' AND expire_le>=date('now')").get().n],
      ['revenus_abonnements_fcfa', db.prepare("SELECT COALESCE(SUM(montant),0) s FROM abonnements WHERE statut='actif'").get().s]
    ];
    let csv = 'indicateur,valeur\n';
    for (const [k, v] of rows) csv += k + ',' + v + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="shopara-stats.csv"');
    res.send(csv);
  });

  // ===== PAGES =====
  const pub = path.join(__dirname, 'public');
  app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));
  app.get('/inscription', (req, res) => res.sendFile(path.join(pub, 'inscription.html')));
  app.get('/connexion', (req, res) => res.sendFile(path.join(pub, 'connexion.html')));
  app.get('/dashboard', (req, res) => res.sendFile(path.join(pub, 'dashboard.html')));
  app.get('/abonnement', (req, res) => res.sendFile(path.join(pub, 'abonnement.html')));
  app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
  app.get('/b/:slug', (req, res) => res.sendFile(path.join(pub, 'boutique.html')));
  app.get('/recu/:numero', (req, res) => res.sendFile(path.join(pub, 'recu.html')));
  app.get('/confirme', (req, res) => res.sendFile(path.join(pub, 'confirme.html')));
  app.use(express.static(pub));

  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Erreur interne.' });
  });
};

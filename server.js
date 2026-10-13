const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db' }),
  secret: process.env.SESSION_SECRET || 'shopara-dev-secret-a-changer',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 24*60*60*1000 }
}));

const limiterGlobal = rateLimit({ windowMs: 15*60*1000, max: 300 });
const limiterAuth = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'Trop de tentatives.' } });
const limiterPublic = rateLimit({ windowMs: 60*1000, max: 120 });
app.use('/api/', limiterGlobal);
app.use('/api/inscription', limiterAuth);
app.use('/api/connexion', limiterAuth);

function h(s) { return crypto.createHash('sha256').update('shopara-salt-' + String(s)).digest('hex'); }
function randomId() { return crypto.randomBytes(8).toString('hex'); }
function slugify(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40) || 'boutique';
}
function requireVendeur(req, res, next) {
  if (!req.session.vendeurId) return res.status(401).json({ error: 'Connectez-vous.' });
  const u = db.prepare('SELECT * FROM vendeurs WHERE id = ? AND actif = 1').get(req.session.vendeurId);
  if (!u) return res.status(401).json({ error: 'Compte invalide.' });
  req.vendeur = u; next();
}
function requireAdmin(req, res, next) {
  if (req.session.isAdmin === true) return next();
  return res.status(401).json({ error: 'Accès admin requis.' });
}
function requireBoutique(req, res, next) {
  const b = db.prepare('SELECT * FROM boutiques WHERE vendeur_id = ? AND slug = ?').get(req.vendeur.id, req.params.slug);
  if (!b) return res.status(404).json({ error: 'Boutique introuvable.' });
  req.boutique = b; next();
}
function requireAbonnement(req, res, next) {
  if (req.session.isAdmin === true) return next();
  const ab = db.prepare("SELECT * FROM abonnements WHERE boutique_id = ? AND statut = 'actif' AND expire_le >= date('now') ORDER BY expire_le DESC LIMIT 1").get(req.boutique.id);
  if (!ab) return res.status(402).json({ error: 'Abonnement requis.' });
  req.abonnement = ab; next();
}

app.post('/api/inscription', (req, res) => {
  const { nom, email, telephone, motDePasse } = req.body || {};
  if (!nom || !email || !telephone || !motDePasse) return res.status(400).json({ error: 'Champs requis manquants.' });
  if (String(motDePasse).length < 6) return res.status(400).json({ error: 'Mot de passe: 6 caracteres minimum.' });
  const existe = db.prepare('SELECT id FROM vendeurs WHERE email = ?').get(String(email).toLowerCase().trim());
  if (existe) return res.status(409).json({ error: 'Un compte existe deja avec cet email.' });
  const id = randomId();
  db.prepare('INSERT INTO vendeurs (id, nom, email, telephone, mot_de_passe_hash, actif, cree_le) VALUES (?,?,?,?,?,1,datetime("now"))')
    .run(id, nom.trim(), String(email).toLowerCase().trim(), String(telephone), h(motDePasse));
  req.session.vendeurId = id;
  res.json({ ok: true });
});
app.post('/api/connexion', (req, res) => {
  const { email, motDePasse } = req.body || {};
  const u = db.prepare('SELECT * FROM vendeurs WHERE email = ?').get(String(email||'').toLowerCase().trim());
  if (!u || u.mot_de_passe_hash !== h(motDePasse)) return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  if (!u.actif) return res.status(403).json({ error: 'Compte suspendu.' });
  req.session.vendeurId = u.id;
  res.json({ ok: true });
});
app.post('/api/deconnexion', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/moi', (req, res) => {
  if (!req.session.vendeurId) return res.json({ connecte: false });
  const u = db.prepare('SELECT id, nom, email, telephone, cree_le FROM vendeurs WHERE id = ?').get(req.session.vendeurId);
  if (!u) return res.json({ connecte: false });
  const bs = db.prepare('SELECT * FROM boutiques WHERE vendeur_id = ?').all(u.id);
  res.json({ connecte: true, vendeur: u, boutiques: bs });
});

app.post('/api/boutiques', requireVendeur, (req, res) => {
  const { nom, description, telephone, adresse, ville, fraisLivraisonDakar, fraisLivraisonRegions } = req.body || {};
  if (!nom || !telephone) return res.status(400).json({ error: 'Nom et telephone requis.' });
  let slug = slugify(nom);
  if (db.prepare('SELECT id FROM boutiques WHERE slug = ?').get(slug)) slug = slug + '-' + randomId().slice(0,4);
  db.prepare('INSERT INTO boutiques (id, vendeur_id, slug, nom, description, telephone, adresse, ville, frais_dakar, frais_regions, publiee, cree_le) VALUES (?,?,?,?,?,?,?,?,?,?,0,datetime("now"))')
    .run(randomId(), req.vendeur.id, slug, nom.trim(), String(description||''), String(telephone), String(adresse||''), String(ville||''), Number(fraisLivraisonDakar||1000), Number(fraisLivraisonRegions||2000));
  res.json({ ok: true, slug });
});
app.get('/api/mes-boutiques', requireVendeur, (req, res) => {
  res.json(db.prepare('SELECT * FROM boutiques WHERE vendeur_id = ?').all(req.vendeur.id));
});
app.put('/api/boutiques/:slug', requireVendeur, requireBoutique, (req, res) => {
  const b = req.body || {};
  db.prepare('UPDATE boutiques SET nom=?, description=?, telephone=?, adresse=?, ville=?, frais_dakar=?, frais_regions=?, publiee=? WHERE id=?')
    .run(String(b.nom||req.boutique.nom).trim(), String(b.description||req.boutique.description), String(b.telephone||req.boutique.telephone), String(b.adresse||req.boutique.adresse), String(b.ville||req.boutique.ville), b.fraisLivraisonDakar!==undefined?Number(b.fraisLivraisonDakar):req.boutique.frais_dakar, b.fraisLivraisonRegions!==undefined?Number(b.fraisLivraisonRegions):req.boutique.frais_regions, b.publiee!==undefined?(b.publiee?1:0):req.boutique.publiee, req.boutique.id);
  res.json({ ok: true });
});

app.get('/api/boutiques/:slug/produits', (req, res) => {
  const b = db.prepare('SELECT * FROM boutiques WHERE slug = ?').get(req.params.slug);
  if (!b) return res.status(404).json({ error: 'Boutique introuvable.' });
  res.json(db.prepare('SELECT * FROM produits WHERE boutique_id = ? AND actif = 1 ORDER BY cree_le DESC').all(b.id));
});
app.post('/api/boutiques/:slug/produits', requireVendeur, requireBoutique, requireAbonnement, (req, res) => {
  const { nom, description, prix, stock, imageUrl } = req.body || {};
  if (!nom || !prix) return res.status(400).json({ error: 'Nom et prix requis.' });
  if (Number(prix) <= 0) return res.status(400).json({ error: 'Prix invalide.' });
  const id = randomId();
  db.prepare('INSERT INTO produits (id, boutique_id, nom, description, prix, stock, image_url, actif, cree_le) VALUES (?,?,?,?,?,?,?,1,datetime("now"))')
    .run(id, req.boutique.id, nom.trim(), String(description||''), Math.round(Number(prix)), Number(stock||0), String(imageUrl||''));
  res.json({ ok: true, id });
});
app.put('/api/boutiques/:slug/produits/:id', requireVendeur, requireBoutique, requireAbonnement, (req, res) => {
  const p = db.prepare('SELECT * FROM produits WHERE id = ? AND boutique_id = ?').get(req.params.id, req.boutique.id);
  if (!p) return res.status(404).json({ error: 'Produit introuvable.' });
  const b = req.body || {};
  db.prepare('UPDATE produits SET nom=?, description=?, prix=?, stock=?, image_url=?, actif=? WHERE id=?')
    .run(String(b.nom||p.nom), String(b.description||p.description), b.prix!==undefined?Math.round(Number(b.prix)):p.prix, b.stock!==undefined?Number(b.stock):p.stock, String(b.imageUrl||p.image_url), b.actif!==undefined?(b.actif?1:0):p.actif, p.id);
  res.json({ ok: true });
});

app.get('/api/publique/boutique/:slug', limiterPublic, (req, res) => {
  const b = db.prepare('SELECT id, slug, nom, description, telephone, adresse, ville, frais_dakar, frais_regions FROM boutiques WHERE slug = ? AND publiee = 1').get(req.params.slug);
  if (!b) return res.status(404).json({ error: 'Boutique introuvable.' });
  res.json(b);
});
app.post('/api/publique/commande', limiterPublic, (req, res) => {
  const { boutiqueSlug, nomClient, telephone, adresse, ville, zone, modePaiement, items } = req.body || {};
  const b = db.prepare('SELECT * FROM boutiques WHERE slug = ? AND publiee = 1').get(String(boutiqueSlug||''));
  if (!b) return res.status(404).json({ error: 'Boutique introuvable.' });
  if (!nomClient || !telephone || !items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Nom, telephone et produits requis.' });
  let total = 0; const lignes = [];
  for (const it of items) {
    const p = db.prepare('SELECT * FROM produits WHERE id = ? AND boutique_id = ? AND actif = 1').get(String(it.produitId||''), b.id);
    if (!p) return res.status(400).json({ error: 'Produit invalide.' });
    const qte = Math.max(1, Math.min(20, Math.round(Number(it.quantite)||1)));
    if (p.stock < qte) return res.status(400).json({ error: 'Stock insuffisant pour ' + p.nom + '.' });
    total += p.prix * qte;
    lignes.push({ produitId: p.id, nom: p.nom, prixUnitaire: p.prix, quantite: qte });
  }
  const frais = (String(zone).toLowerCase().includes('dakar')) ? b.frais_dakar : b.frais_regions;
  total += frais;
  const mode = ['wave', 'orange_money', 'paiement_livraison'].includes(modePaiement) ? modePaiement : 'paiement_livraison';
  const numeroCommande = 'SP-' + Date.now().toString(36).toUpperCase() + '-' + randomId().slice(0,4).toUpperCase();
  const id = randomId();
  db.prepare('INSERT INTO commandes (id, boutique_id, numero, nom_client, telephone, adresse, ville, zone, mode_paiement, frais_livraison, total, statut_paiement, statut, cree_le) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime("now"))')
    .run(id, b.id, numeroCommande, nomClient, String(telephone), String(adresse||''), String(ville||''), String(zone||''), mode, frais, total, 'non_paye', 'en_attente');
  for (const l of lignes) {
    db.prepare('INSERT INTO lignes_commande (id, commande_id, produit_id, nom, prix_unitaire, quantite) VALUES (?,?,?,?,?,?)').run(randomId(), id, l.produitId, l.nom, l.prixUnitaire, l.quantite);
    db.prepare('UPDATE produits SET stock = stock - ? WHERE id = ?').run(l.quantite, l.produitId);
  }
  res.json({ ok: true, numeroCommande, total, fraisLivraison: frais, modePaiement: mode });
});

app.get('/api/publique/recu/:numero', limiterPublic, (req, res) => {
  const c = db.prepare('SELECT c.*, b.nom AS boutique_nom, b.telephone AS boutique_tel, b.adresse AS boutique_adresse, b.ville AS boutique_ville FROM commandes c JOIN boutiques b ON b.id = c.boutique_id WHERE c.numero = ?').get(String(req.params.numero||'').trim().toUpperCase());
  if (!c) return res.status(404).json({ error: 'Commande introuvable.' });
  const lignes = db.prepare('SELECT nom, prix_unitaire, quantite FROM lignes_commande WHERE commande_id = ?').all(c.id);
  res.json({ numero: c.numero, date: c.cree_le, boutique: { nom: c.boutique_nom, telephone: c.boutique_tel, adresse: c.boutique_adresse, ville: c.boutique_ville }, client: { nom: c.nom_client, telephone: c.telephone, ville: c.ville }, lignes, fraisLivraison: c.frais_livraison, total: c.total, modePaiement: c.mode_paiement, statutPaiement: c.statut_paiement, statutCommande: c.statut });
});

app.get('/api/publique/visite', limiterPublic, (req, res) => {
  let sid = null;
  const m = (req.headers.cookie || '').match(/sid=([^;]+)/);
  if (m) sid = m[1];
  if (!sid) { sid = 'v-' + randomId(); res.setHeader('Set-Cookie', 'sid=' + sid + '; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax'); }
  const { page, boutiqueSlug, produitId, referer } = req.query;
  if (!page || String(page).length > 100) return res.json({ ok: true });
  let boutiqueId = null;
  if (boutiqueSlug) { const b = db.prepare('SELECT id FROM boutiques WHERE slug = ?').get(String(boutiqueSlug)); if (b) boutiqueId = b.id; }
  db.prepare('INSERT INTO visites (page, boutique_id, produit_id, sid, referer, cree_le) VALUES (?,?,?,?,?,datetime("now"))')
    .run(String(page).slice(0,100), boutiqueId, produitId ? String(produitId).slice(0,40) : null, sid, String(referer||'').slice(0,200));
  res.json({ ok: true });
});

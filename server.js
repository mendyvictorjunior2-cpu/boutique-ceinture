// server.js - Shopara SaaS (multi-vendeurs, abonnements, recus, stats)
'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const SQLiteStore = require('connect-sqlite3')(session);
const db = require('./db');
const { hashMotDePasse, verifierMotDePasse, slugify } = require('./auth');
const paiements = require('./paiements');
const registerRoutes = require('./routes-suite');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: 'shopara.sid',
  secret: process.env.SESSION_SECRET || 'shopara-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: new SQLiteStore({ db: 'sessions.db', dir: process.env.SHOPARA_DATA_DIR || path.join(__dirname, 'data') }),
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 604800000 }
}));

const limiteGenerale = rateLimit({ windowMs: 900000, max: 300 });
const limiteAuth = rateLimit({ windowMs: 900000, max: 20, message: { erreur: 'Trop de tentatives, reessayez plus tard.' } });
const limiteVisites = rateLimit({ windowMs: 60000, max: 60 });
const limiteCommandes = rateLimit({ windowMs: 900000, max: 30 });
app.use(limiteGenerale);

// ---------- Helpers ----------
function utilisateurCourant(req) {
  if (!req.session.vendeurId) return null;
  const v = db.prepare('SELECT id, email, nom, telephone, role, suspendu FROM vendeurs WHERE id = ?').get(req.session.vendeurId);
  if (!v || v.suspendu) return null;
  return v;
}
function exigeConnexion(req, res, next) {
  if (!utilisateurCourant(req)) return res.status(401).json({ erreur: 'Connexion requise.' });
  next();
}
function exigeAdmin(req, res, next) {
  const u = utilisateurCourant(req);
  if (!u || u.role !== 'admin') return res.status(403).json({ erreur: 'Acces admin requis.' });
  next();
}
function parametre(cle, defaut) {
  const r = db.prepare('SELECT valeur FROM parametres WHERE cle = ?').get(cle);
  return r ? r.valeur : defaut;
}
function abonnementActif(vendeurId) {
  return db.prepare("SELECT * FROM abonnements WHERE vendeur_id = ? AND statut_paiement = 'payee' AND date_fin >= date('now') ORDER BY date_fin DESC LIMIT 1").get(vendeurId);
}
function maBoutique(req) {
  const u = utilisateurCourant(req);
  return db.prepare('SELECT * FROM boutiques WHERE id = ? AND vendeur_id = ?').get(Number(req.params.id), u.id);
}

// ---------- Visites ----------
app.post('/api/visite', limiteVisites, (req, res) => {
  const { chemin, boutiqueSlug, produitId } = req.body || {};
  let boutiqueId = null;
  if (boutiqueSlug) {
    const b = db.prepare('SELECT id FROM boutiques WHERE slug = ?').get(String(boutiqueSlug).slice(0, 50));
    if (b) boutiqueId = b.id;
  }
  db.prepare('INSERT INTO visites (boutique_id, page, chemin, session_id, referent, produit_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(boutiqueId, String(chemin || '/').slice(0, 120), String(chemin || '/').slice(0, 200), (req.sessionID || '').slice(0, 64), String(req.headers.referer || '').slice(0, 200), Number(produitId) || null);
  res.json({ ok: true });
});

// ---------- Pages statiques ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/connexion.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'connexion.html')));
app.get('/vendeur.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vendeur.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/boutique/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'boutique.html')));
app.get('/abonnement.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'abonnement.html')));
app.get('/recu.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'recu.html')));

// ---------- Auth ----------
app.post('/api/inscription', limiteAuth, (req, res) => {
  const { email, motDePasse, nom, telephone } = req.body || {};
  if (!email || !motDePasse || !nom || !telephone) return res.status(400).json({ erreur: 'Tous les champs sont requis.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) return res.status(400).json({ erreur: 'Email invalide.' });
  if (String(motDePasse).length < 8) return res.status(400).json({ erreur: 'Mot de passe: 8 caracteres minimum.' });
  if (db.prepare('SELECT id FROM vendeurs WHERE email = ?').get(String(email).toLowerCase())) return res.status(409).json({ erreur: 'Email deja utilise.' });
  const r = db.prepare('INSERT INTO vendeurs (email, mot_de_passe_hash, nom, telephone) VALUES (?, ?, ?, ?)')
    .run(String(email).toLowerCase(), hashMotDePasse(String(motDePasse)), String(nom).slice(0, 80), String(telephone).slice(0, 20));
  req.session.vendeurId = r.lastInsertRowid;
  res.json({ ok: true });
});
app.post('/api/connexion', limiteAuth, (req, res) => {
  const { email, motDePasse } = req.body || {};
  const v = db.prepare('SELECT * FROM vendeurs WHERE email = ?').get(String(email || '').toLowerCase());
  if (!v || !verifierMotDePasse(String(motDePasse || ''), v.mot_de_passe_hash)) return res.status(401).json({ erreur: 'Identifiants incorrects.' });
  if (v.suspendu) return res.status(403).json({ erreur: 'Compte suspendu.' });
  db.prepare('UPDATE vendeurs SET derniere_connexion = datetime("now") WHERE id = ?').run(v.id);
  req.session.vendeurId = v.id;
  res.json({ ok: true, role: v.role });
});
app.post('/api/deconnexion', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/moi', (req, res) => {
  const u = utilisateurCourant(req);
  if (!u) return res.status(401).json({ erreur: 'Non connecte.' });
  res.json({ vendeur: u, abonnement: abonnementActif(u.id) || null });
});

// ---------- Boutiques ----------
app.get('/api/boutiques', (req, res) => {
  res.json(db.prepare('SELECT id, slug, nom, description FROM boutiques WHERE publiee = 1 ORDER BY cree_le DESC').all());
});
app.post('/api/boutiques', exigeConnexion, (req, res) => {
  const { nom, description, telephone, email, adresse } = req.body || {};
  if (!nom) return res.status(400).json({ erreur: 'Le nom de la boutique est requis.' });
  const u = utilisateurCourant(req);
  if (db.prepare('SELECT COUNT(*) c FROM boutiques WHERE vendeur_id = ?').get(u.id).c >= 3) return res.status(403).json({ erreur: 'Maximum 3 boutiques par compte.' });
  let slug = slugify(nom);
  if (db.prepare('SELECT id FROM boutiques WHERE slug = ?').get(slug)) slug = slug + '-' + Math.random().toString(36).slice(2, 6);
  const r = db.prepare('INSERT INTO boutiques (vendeur_id, slug, nom, description, telephone, email, adresse) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(u.id, slug, String(nom).slice(0, 80), String(description || '').slice(0, 500), String(telephone || '').slice(0, 20), String(email || '').slice(0, 80), String(adresse || '').slice(0, 200));
  res.json({ ok: true, slug });
});
app.get('/api/mes-boutiques', exigeConnexion, (req, res) => {
  const u = utilisateurCourant(req);
  res.json(db.prepare('SELECT * FROM boutiques WHERE vendeur_id = ?').all(u.id));
});
app.put('/api/boutiques/:id', exigeConnexion, (req, res) => {
  const b = maBoutique(req);
  if (!b) return res.status(404).json({ erreur: 'Boutique introuvable.' });
  const f = req.body || {};
  db.prepare('UPDATE boutiques SET nom = ?, description = ?, telephone = ?, email = ?, adresse = ?, frais_livraison_dakar = ?, frais_livraison_regions = ?, instructions_paiement = ?, publiee = ? WHERE id = ?')
    .run(String(f.nom || b.nom).slice(0, 80), String(f.description || b.description).slice(0, 500), String(f.telephone || b.telephone).slice(0, 20), String(f.email || b.email).slice(0, 80), String(f.adresse || b.adresse).slice(0, 200), Number(f.frais_livraison_dakar) || b.frais_livraison_dakar, Number(f.frais_livraison_regions) || b.frais_livraison_regions, String(f.instructions_paiement || b.instructions_paiement).slice(0, 500), f.publiee === false ? 0 : 1, b.id);
  res.json({ ok: true });
});

// ---------- Produits ----------
app.post('/api/boutiques/:id/produits', exigeConnexion, (req, res) => {
  const b = maBoutique(req);
  if (!b) return res.status(404).json({ erreur: 'Boutique introuvable.' });
  const { nom, description, prix, stock } = req.body || {};
  if (!nom || prix === undefined) return res.status(400).json({ erreur: 'Nom et prix requis.' });
  if (!Number.isInteger(Number(prix)) || Number(prix) < 0) return res.status(400).json({ erreur: 'Prix invalide.' });
  const r = db.prepare('INSERT INTO produits (boutique_id, nom, description, prix, stock, image_url) VALUES (?, ?, ?, ?, ?, ?)')
    .run(b.id, String(nom).slice(0, 80), String(description || '').slice(0, 500), Number(prix), Math.max(0, Number(stock) || 0), String((req.body || {}).image_url || '').slice(0, 300));
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.put('/api/produits/:id', exigeConnexion, (req, res) => {
  const u = utilisateurCourant(req);
  const p = db.prepare('SELECT p.*, b.vendeur_id FROM produits p JOIN boutiques b ON b.id = p.boutique_id WHERE p.id = ?').get(Number(req.params.id));
  if (!p || p.vendeur_id !== u.id) return res.status(404).json({ erreur: 'Produit introuvable.' });
  const f = req.body || {};
  db.prepare('UPDATE produits SET nom = ?, description = ?, prix = ?, stock = ?, image_url = ? WHERE id = ?')
    .run(String(f.nom || p.nom).slice(0, 80), String(f.description || p.description).slice(0, 500), Number.isInteger(Number(f.prix)) ? Number(f.prix) : p.prix, Number.isInteger(Number(f.stock)) ? Math.max(0, Number(f.stock)) : p.stock, String(f.image_url || p.image_url).slice(0, 300), p.id);
  res.json({ ok: true });
});

// ---------- Public: boutique + produits ----------
app.get('/api/pub/boutique/:slug', (req, res) => {
  const b = db.prepare('SELECT id, slug, nom, description, telephone, email, adresse, frais_livraison_dakar, frais_livraison_regions, instructions_paiement FROM boutiques WHERE slug = ? AND publiee = 1').get(String(req.params.slug).slice(0, 50));
  if (!b) return res.status(404).json({ erreur: 'Boutique introuvable.' });
  b.produits = db.prepare('SELECT id, nom, description, prix, stock, image_url FROM produits WHERE boutique_id = ?').all(b.id);
  res.json(b);
});

// ---------- Commandes, recus, abonnements, stats, admin ----------
registerRoutes(app, { db, paiements, utilisateurCourant, exigeConnexion, exigeAdmin, parametre, abonnementActif, limiteCommandes });

app.listen(PORT, () => console.log('Shopara demarre sur le port ' + PORT));

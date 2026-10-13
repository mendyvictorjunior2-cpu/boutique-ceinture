// server.js - Shopara SaaS server (multi-vendeurs)
'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const SQLiteStore = require('connect-sqlite3')(session);
const db = require('./db');
const { hashMotDePasse, verifierMotDePasse, genererNumeroCommande, slugify } = require('./auth');
const paiements = require('./paiements');

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
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

// ---------- Rate limiting ----------
const limiteGenerale = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const limiteAuth = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { erreur: 'Trop de tentatives, reessayez plus tard.' } });
const limiteVisites = rateLimit({ windowMs: 60 * 1000, max: 60 });
const limiteCommandes = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
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

// ---------- Visites (tracking pages publiques) ----------
app.post('/api/visite', limiteVisites, (req, res) => {
  const { chemin, boutiqueSlug, produitId } = req.body || {};
  let boutiqueId = null;
  if (boutiqueSlug) {
    const b = db.prepare('SELECT id FROM boutiques WHERE slug = ?').get(String(boutiqueSlug).slice(0, 50));
    if (b) boutiqueId = b.id;
  }
  db.prepare('INSERT INTO visites (boutique_id, page, chemin, session_id, referent, produit_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(boutiqueId, String(chemin || '/').slice(0, 120), String(chemin || '/').slice(0, 200),
         (req.sessionID || '').slice(0, 64), String(req.headers.referer || '').slice(0, 200),
         Number(produitId) || null);
  res.json({ ok: true });
});

// ---------- Public: accueil Shopara + annuaire des boutiques ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/api/boutiques', (req, res) => {
  const boutiques = db.prepare('SELECT id, slug, nom, description, telephone FROM boutiques WHERE publiee = 1 ORDER BY cree_le DESC').all();
  res.json(boutiques);
});

// ---------- Auth ----------
app.post('/api/inscription', limiteAuth, (req, res) => {
  const { email, motDePasse, nom, telephone } = req.body || {};
  if (!email || !motDePasse || !nom || !telephone) return res.status(400).json({ erreur: 'Tous les champs sont requis.' });
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email));
  if (!emailOk) return res.status(400).json({ erreur: 'Email invalide.' });
  if (String(motDePasse).length < 8) return res.status(400).json({ erreur: 'Mot de passe: 8 caracteres minimum.' });
  if (db.prepare('SELECT id FROM vendeurs WHERE email = ?').get(String(email).toLowerCase())) return res.status(409).json({ erreur: 'Email deja utilise.' });
  const r = db.prepare('INSERT INTO vendeurs (email, mot_de_passe_hash, nom, telephone) VALUES (?, ?, ?, ?)')
    .run(String(email).toLowerCase(), hashMotDePasse(String(motDePasse)), String(nom).slice(0, 80), String(telephone).slice(0, 20));
  req.session.vendeurId = r.lastInsertRowid;
  res.json({ ok: true, vendeur: { id: r.lastInsertRowid, email: String(email).toLowerCase(), nom } });
});
app.post('/api/connexion', limiteAuth, (req, res) => {
  const { email, motDePasse } = req.body || {};
  const v = db.prepare('SELECT * FROM vendeurs WHERE email = ?').get(String(email || '').toLowerCase());
  if (!v || !verifierMotDePasse(String(motDePasse || ''), v.mot_de_passe_hash)) return res.status(401).json({ erreur: 'Identifiants incorrects.' });
  if (v.suspendu) return res.status(403).json({ erreur: 'Compte suspendu.' });
  db.prepare('UPDATE vendeurs SET derniere_connexion = datetime("now") WHERE id = ?').run(v.id);
  req.session.vendeurId = v.id;
  res.json({ ok: true, vendeur: { id: v.id, email: v.email, nom: v.nom, role: v.role } });
});
app.post('/api/deconnexion', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get('/api/moi', (req, res) => {
  const u = utilisateurCourant(req);
  if (!u) return res.status(401).json({ erreur: 'Non connecte.' });
  const abo = abonnementActif(u.id);
  res.json({ vendeur: u, abonnement: abo || null });
});

// ---------- Boutiques (vendeur) ----------
app.post('/api/boutiques', exigeConnexion, (req, res) => {
  const { nom, description, telephone, email, adresse } = req.body || {};
  if (!nom) return res.status(400).json({ erreur: 'Le nom de la boutique est requis.' });
  const u = utilisateurCourant(req);
  const nb = db.prepare('SELECT COUNT(*) c FROM boutiques WHERE vendeur_id = ?').get(u.id).c;
  if (nb >= 3) return res.status(403).json({ erreur: 'Maximum 3 boutiques par compte (offre gratuite).' });
  let slug = slugify(nom);
  const existe = db.prepare('SELECT id FROM boutiques WHERE slug = ?').get(slug);
  if (existe) slug = slug + '-' + Math.random().toString(36).slice(2, 6);
  const r = db.prepare('INSERT INTO boutiques (vendeur_id, slug, nom, description, telephone, email, adresse) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(u.id, slug, String(nom).slice(0, 80), String(description || '').slice(0, 500),
         String(telephone || '').slice(0, 20), String(email || '').slice(0, 80), String(adresse || '').slice(0, 200));
  res.json({ ok: true, boutique: { id: r.lastInsertRowid, slug, nom } });
});
app.get('/api/mes-boutiques', exigeConnexion, (req, res) => {
  const u = utilisateurCourant(req);
  res.json(db.prepare('SELECT * FROM boutiques WHERE vendeur_id = ?').all(u.id));
});
app.put('/api/boutiques/:id', exigeConnexion, (req, res) => {
  const u = utilisateurCourant(req);
  const b = db.prepare('SELECT * FROM boutiques WHERE id = ?').get(Number(req.params.id));
  if (!b || b.vendeur_id !== u.id) return res.status(404).json({ erreur: 'Boutique introuvable.' });
  const f = req.body || {};
  db.prepare('UPDATE boutiques SET nom = ?, description = ?, telephone = ?, email = ?, adresse = ?, frais_livraison_dakar = ?, frais_livraison_regions = ?, instructions_paiement = ?, publiee = ? WHERE id = ?')
    .run(String(f.nom || b.nom).slice(0, 80), String(f.description || b.description).slice(0, 500),
         String(f.telephone || b.telephone).slice(0, 20), String(f.email || b.email).slice(0, 80),
         String(f.adresse || b.adresse).slice(0, 200),
         Number(f.frais_livraison_dakar) || b.frais_livraison_dakar, Number(f.frais_livraison_regions) || b.frais_livraison_regions,
         String(f.instructions_paiement || b.instructions_paiement).slice(0, 500),
         f.publiee === false ? 0 : 1, b.id);
  res.json({ ok: true });
});

// ---------- Produits ----------
app.post('/api/boutiques/:id/produits', exigeConnexion, (req, res) => {
  const u = utilisateurCourant(req);
  const b = db.prepare('SELECT * FROM boutiques WHERE id = ?').get(Number(req.params.id));
  if (!b || b.vendeur_id !== u.id) return res.status(404).json({ erreur: 'Boutique introuvable.' });
  const { nom, description, prix, stock } = req.body || {};
  if (!nom || prix === undefined) return res.status(400).json({ erreur: 'Nom et prix requis.' });
  const prixN = Number(prix);
  if (!Number.isInteger(prixN) || prixN < 0) return res.status(400).json({ erreur: 'Prix invalide (entier en FCFA).' });
  const r = db.prepare('INSERT INTO produits (boutique_id, nom, description, prix, stock, image_url) VALUES (?, ?, ?, ?, ?, ?)')
    .run(b.id, String(nom).slice(0, 80), String(description || '').slice(0, 500), prixN,
         Math.max(0, Number(stock) || 0), String((req.body || {}).image_url || '').slice(0, 300));
  res.json({ ok: true, produit: { id: r.lastInsertRowid, nom, prix: prixN, stock: Math.max(0, Number(stock) || 0) } });
});
app.get('/api/boutiques/:id/produits', exigeConnexion, (req, res) => {
  const u = utilisateurCourant(req);
  const b = db.prepare('SELECT vendeur_id FROM boutiques WHERE id = ?').get(Number(req.params.id));
  if (!b || b.vendeur_id !== u.id) return res.status(404).json({ erreur: 'Boutique introuvable.' });
  res.json(db.prepare('SELECT * FROM produits WHERE boutique_id = ?').all(b.id ? Number(req.params.id) : 0));
});

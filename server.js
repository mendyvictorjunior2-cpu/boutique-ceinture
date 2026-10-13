// server.js - Shopara SaaS server (multi-vendeurs) - PARTIE 2 chargee depuis routes-suite.js
// Voir routes-suite.js pour: commandes, recus, abonnements, stats, dashboards.
// Ce fichier: setup + auth + boutiques + produits (partie 1) puis require('./routes-suite').
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
  de parametres
}

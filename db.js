// db.js - Shopara database layer (SQLite, multi-tenant)
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.SHOPARA_DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'shopara.db'));
db.pragma('journal_mode = WAL');

// ---------- Schema v2 (SaaS) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS vendeurs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  mot_de_passe_hash TEXT NOT NULL,
  nom TEXT NOT NULL,
  telephone TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'vendeur',
  suspendu INTEGER NOT NULL DEFAULT 0,
  cree_le TEXT NOT NULL DEFAULT (datetime('now')),
  derniere_connexion TEXT
);
CREATE TABLE IF NOT EXISTS boutiques (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendeur_id INTEGER NOT NULL REFERENCES vendeurs(id),
  slug TEXT UNIQUE NOT NULL,
  nom TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  telephone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  adresse TEXT NOT NULL DEFAULT '',
  frais_livraison_dakar INTEGER NOT NULL DEFAULT 1000,
  frais_livraison_regions INTEGER NOT NULL DEFAULT 2000,
  instructions_paiement TEXT NOT NULL DEFAULT '',
  publiee INTEGER NOT NULL DEFAULT 1,
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS produits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  boutique_id INTEGER NOT NULL REFERENCES boutiques(id),
  nom TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  prix INTEGER NOT NULL CHECK (prix >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image_url TEXT NOT NULL DEFAULT '',
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS commandes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE NOT NULL,
  boutique_id INTEGER NOT NULL REFERENCES boutiques(id),
  client_nom TEXT NOT NULL,
  client_telephone TEXT NOT NULL,
  client_adresse TEXT NOT NULL,
  zone_livraison TEXT NOT NULL DEFAULT 'dakar',
  articles_json TEXT NOT NULL,
  sous_total INTEGER NOT NULL,
  frais_livraison INTEGER NOT NULL,
  total INTEGER NOT NULL,
  mode_paiement TEXT NOT NULL DEFAULT 'wave',
  statut TEXT NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente','confirmee','livree','annulee')),
  statut_paiement TEXT NOT NULL DEFAULT 'en_attente_paiement' CHECK (statut_paiement IN ('en_attente_paiement','payee','annule')),
  reference_paiement TEXT NOT NULL DEFAULT '',
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS abonnements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendeur_id INTEGER NOT NULL REFERENCES vendeurs(id),
  offre INTEGER NOT NULL CHECK (offre IN (1,2)),
  montant INTEGER NOT NULL CHECK (montant > 0),
  statut_paiement TEXT NOT NULL DEFAULT 'en_attente_paiement' CHECK (statut_paiement IN ('en_attente_paiement','payee','annule')),
  reference_paiement TEXT NOT NULL DEFAULT '',
  date_debut TEXT,
  date_fin TEXT,
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS parametres (
  cle TEXT PRIMARY KEY,
  valeur TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS visites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  boutique_id INTEGER REFERENCES boutiques(id),
  page TEXT NOT NULL,
  chemin TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  referent TEXT NOT NULL DEFAULT '',
  produit_id INTEGER,
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commandes_boutique ON commandes(boutique_id);
CREATE INDEX IF NOT EXISTS idx_commandes_statut ON commandes(statut);
CREATE INDEX IF NOT EXISTS idx_produits_boutique ON produits(boutique_id);
CREATE INDEX IF NOT EXISTS idx_visites_boutique_date ON visites(boutique_id, cree_le);
CREATE INDEX IF NOT EXISTS idx_visites_date ON visites(cree_le);
CREATE INDEX IF NOT EXISTS idx_visites_session ON visites(session_id);

INSERT OR IGNORE INTO parametres (cle, valeur) VALUES
  ('numero_abonnements', '772695341'),
  ('tarif_1_mois', '2500'),
  ('tarif_2_mois', '5000'),
  ('paiement_frais_wave', 'Wave: environ 1 pour cent par transaction'),
INSERT OR IGNORE INTO parametres (cle, valeur) VALUES
  ('paiement_frais_om', 'Orange Money: 1 pour cent, versement bancaire J+5');
`);

// Admin bootstrap: first account becomes platform owner
const ADMIN_EMAIL = process.env.SHOPARA_ADMIN_EMAIL || 'mendyvictorjunior2@gmail.com';
const ADMIN_PASS = process.env.SHOPARA_ADMIN_PASS || 'Shopara2026!';
const bcrypt = require('crypto');
const crypto = require('crypto');
function hash(p) {
  return crypto.scryptSync(p, 'shopara-salt', 32).toString('hex');
}
const exists = db.prepare('SELECT id FROM vendeurs WHERE role = ?').get('admin');
if (!exists) {
  db.prepare('INSERT OR IGNORE INTO vendeurs (email, mot_de_passe_hash, nom, telephone, role) VALUES (?, ?, ?, ?, ?)')
    .run(ADMIN_EMAIL, hash(ADMIN_PASS), 'Admin Shopara', '772695341', 'admin');
}

module.exports = db;

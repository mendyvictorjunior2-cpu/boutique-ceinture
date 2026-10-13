const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'shopara.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS vendeurs (
  id TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  telephone TEXT NOT NULL,
  mot_de_passe_hash TEXT NOT NULL,
  actif INTEGER DEFAULT 1,
  cree_le TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS boutiques (
  id TEXT PRIMARY KEY,
  vendeur_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  nom TEXT NOT NULL,
  description TEXT DEFAULT '',
  telephone TEXT NOT NULL,
  adresse TEXT DEFAULT '',
  ville TEXT DEFAULT '',
  frais_dakar INTEGER DEFAULT 1000,
  frais_regions INTEGER DEFAULT 2000,
  publiee INTEGER DEFAULT 0,
  cree_le TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS produits (
  id TEXT PRIMARY KEY,
  boutique_id TEXT NOT NULL,
  nom TEXT NOT NULL,
  description TEXT DEFAULT '',
  prix INTEGER NOT NULL,
  stock INTEGER DEFAULT 0,
  image_url TEXT DEFAULT '',
  actif INTEGER DEFAULT 1,
  cree_le TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS commandes (
  id TEXT PRIMARY KEY,
  boutique_id TEXT NOT NULL,
  numero TEXT NOT NULL UNIQUE,
  nom_client TEXT NOT NULL,
  telephone TEXT NOT NULL,
  adresse TEXT DEFAULT '',
  ville TEXT DEFAULT '',
  zone TEXT DEFAULT '',
  mode_paiement TEXT DEFAULT 'paiement_livraison',
  frais_livraison INTEGER DEFAULT 0,
  total INTEGER NOT NULL,
  statut_paiement TEXT DEFAULT 'non_paye',
  statut TEXT DEFAULT 'en_attente',
  cree_le TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS lignes_commande (
  id TEXT PRIMARY KEY,
  commande_id TEXT NOT NULL,
  produit_id TEXT NOT NULL,
  nom TEXT NOT NULL,
  prix_unitaire INTEGER NOT NULL,
  quantite INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS abonnements (
  id TEXT PRIMARY KEY,
  vendeur_id TEXT NOT NULL,
  boutique_id TEXT NOT NULL,
  offre TEXT NOT NULL,
  montant INTEGER NOT NULL,
  reference_paiement TEXT DEFAULT '',
  statut TEXT DEFAULT 'en_attente',
  debut_le TEXT,
  expire_le TEXT,
  cree_le TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS visites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page TEXT NOT NULL,
  boutique_id TEXT,
  produit_id TEXT,
  sid TEXT NOT NULL,
  referer TEXT DEFAULT '',
  cree_le TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS parametres (
  cle TEXT PRIMARY KEY,
  valeur TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cmd_boutique ON commandes(boutique_id);
CREATE INDEX IF NOT EXISTS idx_cmd_statut ON commandes(statut);
CREATE INDEX IF NOT EXISTS idx_prod_boutique ON produits(boutique_id);
CREATE INDEX IF NOT EXISTS idx_visites_boutique ON visites(boutique_id);
CREATE INDEX IF NOT EXISTS idx_visites_date ON visites(cree_le);
`);

const getParam = db.prepare('SELECT valeur FROM parametres WHERE cle = ?');
const setParam = db.prepare('INSERT OR REPLACE INTO parametres (cle, valeur) VALUES (?, ?)');
if (!getParam.get('numero_paiement_abonnement')) setParam.run('numero_paiement_abonnement', process.env.NUMERO_ABONNEMENT || '772695341');
if (!getParam.get('moyen_paiement_abonnement')) setParam.run('moyen_paiement_abonnement', 'Wave ou Orange Money (manuel, verification admin)');

module.exports = db;

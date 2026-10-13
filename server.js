// ============================================================
// Boutique Ceinture Chauffante Menstruelle — 9 900 FCFA
// Serveur Node.js/Express + SQLite
// Paiements : Wave / Orange Money (mode manuel sécurisé) + paiement à la livraison
// ============================================================
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const Database = require("better-sqlite3");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const paiements = require("./paiements");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Sécurité ----------
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use(session({
  store: new SQLiteStore({ db: "sessions.db" }),
  secret: process.env.SESSION_SECRET || "dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 1000 * 60 * 60 * 8 }
}));

const limiterGlobal = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
const limiterCommande = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const limiterLogin = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });
app.use("/api/", limiterGlobal);

// ---------- Base de données ----------
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "boutique.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS produit (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nom TEXT NOT NULL, prix_fcfa INTEGER NOT NULL,
  description TEXT NOT NULL, stock INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS commande (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL, telephone TEXT NOT NULL, ville TEXT NOT NULL,
  quartier TEXT NOT NULL, quantite INTEGER NOT NULL,
  mode_paiement TEXT NOT NULL, statut_paiement TEXT DEFAULT NULL,
  total_fcfa INTEGER NOT NULL, creee_le TEXT DEFAULT (datetime('now'))
);
`);

// Produit auto-créé (permet de survivre aux redéploiements du plan gratuit)
db.prepare(`INSERT OR IGNORE INTO produit (id, nom, prix_fcfa, description, stock)
VALUES (1, 'Ceinture Chauffante Menstruelle', 9900,
'Ceinture de chaleur USB rechargeable, 3 niveaux de chaleur, tissu doux lavable. Soulage les douleurs menstruelles en 10 minutes.', 10)`).run();

const FRAIS_DAKAR = 1000, FRAIS_REGIONS = 2000;

function fraisLivraison(ville) { return String(ville).trim().toLowerCase() === "dakar" ? FRAIS_DAKAR : FRAIS_REGIONS; }
function verifierStock(quantite) {
  const p = db.prepare("SELECT stock FROM produit WHERE id=1").get();
  if (!p || p.stock < quantite) return { ok: false, restant: p ? p.stock : 0 };
  return { ok: true, restant: p.stock };
}

// ---------- API publique ----------
app.get("/api/produit", (req, res) => {
  const p = db.prepare("SELECT nom, prix_fcfa, description, stock FROM produit WHERE id=1").get();
  const paiement = paiements.configure();
  res.json({ ...p, frais_dakar: FRAIS_DAKAR, frais_regions: FRAIS_REGIONS,
    paiement, instructions_manuelles: paiement.configure ? null : paiements.instructionsManuelles() });
});

app.post("/api/commande", limiterCommande, (req, res) => {
  const { nom, telephone, ville, quartier, quantite, mode_paiement } = req.body || {};
  if (!nom || !telephone || !ville || !quartier || !quantite || quantite < 1) {
    return res.status(400).json({ erreur: "Champs manquants ou invalides." });
  }
  if (!["paiement_livraison", "wave", "orange_money", "wave_manuel", "orange_money_manuel"].includes(mode_paiement)) {
    return res.status(400).json({ erreur: "Mode de paiement inconnu." });
  }
  const st = verifierStock(quantite);
  if (!st.ok) return res.status(409).json({ erreur: "Stock insuffisant.", stock_restant: st.restant });

  const prix = db.prepare("SELECT prix_fcfa FROM produit WHERE id=1").get().prix_fcfa;
  const total = prix * quantite + fraisLivraison(ville);

  // En mode manuel, la commande naît "en attente de paiement" — JAMAIS "payee".
  let statutPaiement = null;
  if (mode_paiement !== "paiement_livraison") statutPaiement = "en_attente_paiement";

  const info = db.prepare(`INSERT INTO commande (nom, telephone, ville, quartier, quantite, mode_paiement, statut_paiement, total_fcfa)
  VALUES (?,?,?,?,?,?,?,?)`).run(nom, telephone, ville, quartier, quantite, mode_paiement, statutPaiement, total);

  const paiement = paiements.configure();
  res.status(201).json({
    commande: { id: info.lastInsertRowid, total_fcfa: total, statut_paiement: statutPaiement },
    paiement: paiement.configure ? { mode: "api", ...paiement } : { mode: "manuel", instructions: paiements.instructionsManuelles() }
  });
});

app.get("/api/paiements/statut/:id", (req, res) => {
  const c = db.prepare("SELECT statut_paiement FROM commande WHERE id=?").get(req.params.id);
  if (!c) return res.status(404).json({ erreur: "Commande inconnue." });
  res.json({ statut_paiement: c.statut_paiement });
});

// ---------- Webhooks (Phase 2, actifs uniquement avec les clés API officielles) ----------
app.post("/api/webhooks/wave", (req, res) => {
  res.status(202).end(); // accusé immédiat ; vérification asynchrone contre l'API Wave (jamais le corps seul)
  paiements.webhookWave(req.body, (id, statut) => {
    if (statut === "payee") {
      const c = db.prepare("SELECT quantite FROM commande WHERE id=?").get(id);
      if (c) db.prepare("UPDATE produit SET stock = stock - ? WHERE id=1 AND stock >= ?").run(c.quantite, c.quantite);
    }
    db.prepare("UPDATE commande SET statut_paiement=? WHERE id=?").run(statut, id);
  });
});
app.post("/api/webhooks/orange", (req, res) => {
  res.status(202).end();
  paiements.webhookOrange(req.body, (id, statut) => {
    if (statut === "payee") {
      const c = db.prepare("SELECT quantite FROM commande WHERE id=?").get(id);
      if (c) db.prepare("UPDATE produit SET stock = stock - ? WHERE id=1 AND stock >= ?").run(c.quantite, c.quantite);
    }
    db.prepare("UPDATE commande SET statut_paiement=? WHERE id=?").run(statut, id);
  });
});

// ---------- Admin ----------
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin2026";

app.post("/api/admin/login", limiterLogin, (req, res) => {
  const { user, pass } = req.body || {};
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ erreur: "Identifiants incorrects." });
});

function adminRequis(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(403).json({ erreur: "Accès admin requis." });
}

app.get("/api/admin/stats", adminRequis, (req, res) => {
  const ca = db.prepare(`SELECT COALESCE(SUM(total_fcfa),0) AS t FROM commande WHERE statut_paiement='payee' OR statut_paiement IS NULL`).get().t;
  const commandes = db.prepare("SELECT COUNT(*) AS n FROM commande").get().n;
  const unites = db.prepare("SELECT COALESCE(SUM(quantite),0) AS u FROM commande WHERE statut_paiement='payee' OR statut_paiement IS NULL").get().u;
  const stock = db.prepare("SELECT stock FROM produit WHERE id=1").get().stock;
  res.json({ chiffre_affaires: ca, commandes: commandes, unites_vendues: unites, stock_restant: stock });
});

app.get("/api/admin/commandes", adminRequis, (req, res) => {
  res.json(db.prepare("SELECT * FROM commande ORDER BY id DESC").all());
});

app.post("/api/admin/commande/:id/statut", adminRequis, (req, res) => {
  // Confirmer un paiement manuel APRÈS vérification dans le portefeuille — responsabilité admin.
  const { statut } = req.body || {};
  if (!["payee", "echoue", "annule", "confirmee", "livree", "annulee"].includes(statut)) {
    return res.status(400).json({ erreur: "Statut invalide." });
  }
  const c = db.prepare("SELECT quantite, statut_paiement FROM commande WHERE id=?").get(req.params.id);
  if (!c) return res.status(404).json({ erreur: "Commande inconnue." });
  if (statut === "payee" && c.statut_paiement !== "payee") {
    db.prepare("UPDATE produit SET stock = stock - ? WHERE id=1 AND stock >= ?").run(c.quantite, c.quantite);
  }
  db.prepare("UPDATE commande SET statut_paiement=? WHERE id=?").run(statut, req.params.id);
  res.json({ ok: true });
});

app.put("/api/admin/produit", adminRequis, (req, res) => {
  const { prix_fcfa, stock } = req.body || {};
  if (typeof prix_fcfa !== "number" || typeof stock !== "number") {
    return res.status(400).json({ erreur: "prix_fcfa et stock sont requis (nombres)." });
  }
  db.prepare("UPDATE produit SET prix_fcfa=?, stock=? WHERE id=1").run(Math.round(prix_fcfa), Math.round(stock));
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Boutique en ligne sur le port ${PORT}`));

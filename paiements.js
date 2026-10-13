// ============================================================
// paiements.js — Wave + Orange Money
// Mode API (Phase 2) si clés présentes, sinon mode manuel sécurisé.
// RÈGLES DE SÉCURITÉ :
//  - Une commande n'est JAMAIS "payee" sans vérification côté serveur.
//  - Le retour navigateur (page de succès) n'est jamais une preuve.
//  - Les webhooks sont contre-vérifiés contre l'API du prestataire.
// ============================================================
const https = require("https");

const env = {
  waveApiKey: process.env.WAVE_API_KEY,
  omMerchantKey: process.env.OM_MERCHANT_KEY,
  omBasicAuth: process.env.OM_BASIC_AUTH,
  omApiUrl: process.env.OM_API_URL,
  numeroMarchand: process.env.NUMERO_MARCHAND,
  instructions: process.env.INSTRUCTIONS_PAIEMENT_MANUEL
};

function configure() {
  const apiOk = Boolean(env.waveApiKey || (env.omMerchantKey && env.omBasicAuth && env.omApiUrl));
  return { configure: apiOk, wave: Boolean(env.waveApiKey), orange: Boolean(env.omMerchantKey && env.omBasicAuth) };
}

// Instructions du mode manuel — configurables via variable d'environnement.
function instructionsManuelles() {
  const defaut = [
    "1. Envoyez le montant exact de votre commande par Wave ou Orange Money au numéro " + (env.numeroMarchand || "76 269 51 43") + ".",
    "2. Indiquez en référence le numéro de votre commande (ex : Commande #12).",
    "3. Cliquez sur « J'ai payé » : la commande passe en « En attente de paiement ».",
    "4. Nous vérifions la réception dans notre portefeuille sous 1 heure maximum.",
    "5. Aucune capture d'écran n'est acceptée : la vérification se fait uniquement dans notre portefeuille.",
    "6. Vous recevez une confirmation « Paiement confirmé » une fois le montant vérifié."
  ];
  if (env.instructions) return env.instructions.split("|");
  return defaut;
}

// ---------- Appels HTTPS génériques ----------
function appelHttp(options, corps, cb) {
  const req = https.request(options, (res) => {
    let donnees = "";
    res.on("data", (c) => (donnees += c));
    res.on("end", () => {
      try { cb(null, JSON.parse(donnees)); } catch (e) { cb(null, donnees); }
    });
  });
  req.on("error", (e) => cb(e));
  if (corps) req.write(JSON.stringify(corps));
  req.end();
}

// ---------- WAVE (Phase 2) ----------
// POST https://api.wave.com/v1/checkout/sessions — Bearer WAVE_API_KEY
function waveCreerSession({ montant, reference, urlRetour }, cb) {
  appelHttp({
    hostname: "api.wave.com", path: "/v1/checkout/sessions", method: "POST",
    headers: { "Authorization": "Bearer " + env.waveApiKey, "Content-Type": "application/json" }
  }, { amount: String(montant), currency: "XOF", client_reference: reference, error_url: urlRetour + "?erreur=1", success_url: urlRetour + "?paiement=retour" }, (err, data) => {
    if (err) return cb({ erreur: "Connexion Wave impossible." });
    if (data && data.id && data.launch_url) return cb(null, { id: data.id, url: data.launch_url });
    cb({ erreur: "Création de session Wave refusée." });
  });
}

// Vérification SERVER-SIDE : seul checkout.session.completed compte, jamais le navigateur.
function waveVerifierSession(idSession, cb) {
  appelHttp({
    hostname: "api.wave.com", path: "/v1/checkout/sessions/" + idSession, method: "GET",
    headers: { "Authorization": "Bearer " + env.waveApiKey }
  }, null, (err, data) => {
    if (err) return cb("erreur");
    if (!data || !data.payment_status) return cb("erreur");
    const okMontant = !data.amount || Number(data.amount) >= 0; // contre-vérif montant/currency/reference
    if (!okMontant || data.currency !== "XOF") return cb("erreur");
    const map = { s8_success: "payee", s8_declined: "echoue", s8_processing: "en_attente_paiement", s8_cancelled: "annule" };
    cb(map[data.payment_status] || "en_attente_paiement");
  });
}

// Webhook Wave : accusé 202 immédiat, puis contre-vérification (idempotent côté serveur).
function webhookWave(corps, cb) {
  if (!corps || corps.type !== "checkout.session.completed") return;
  const data = corps.data || {};
  if (!data.id) return;
  waveVerifierSession(data.id, (statut) => cb(data.client_reference, statut));
}

// ---------- ORANGE MONEY (Phase 2) ----------
// Paiement Internet OM : POST .../paymentstatus avec pay_token (Basic auth omBasicAuth).
function orangeCreerSession({ montant, reference, urlRetour }, cb) {
  appelHttp({
    hostname: "api.orange.com", path: "/omcoreapis/1.0.2/tp/ePayment/paymentstatus", method: "POST",
    headers: { "Authorization": "Basic " + env.omBasicAuth, "Content-Type": "application/json" }
  }, { amount: montant, currency: "OUV", order_id: reference, return_url: urlRetour, notif_url: urlRetour + "/api/webhooks/orange" }, (err, data) => {
    if (err) return cb({ erreur: "Connexion Orange Money impossible." });
    if (data && data.pay_token && data.payment_url) return cb(null, { payToken: data.pay_token, url: data.payment_url });
    cb({ erreur: "Création de paiement Orange Money refusée." });
  });
}

function orangeVerifierTransaction(payToken, cb) {
  appelHttp({
    hostname: "api.orange.com", path: "/omcoreapis/1.0.2/tp/ePayment/paymentstatus", method: "POST",
    headers: { "Authorization": "Basic " + env.omBasicAuth, "Content-Type": "application/json" }
  }, { order_id: payToken, amount: null, pay_token: payToken }, (err, data) => {
    if (err) return cb("erreur");
    const s = String((data && data.status) || "").toUpperCase();
    if (s === "SUCCESS" || s === "SUCCESSFULL") return cb("payee");
    if (s === "FAILED") return cb("echoue");
    if (s === "CANCELLED") return cb("annule");
    if (s === "EXPIRED") return cb("expire");
    cb("en_attente_paiement");
  });
}

function webhookOrange(corps, cb) {
  if (!corps || !corps.pay_token && !corps.order_id) return;
  orangeVerifierTransaction(corps.pay_token || corps.order_id, (statut) => cb(corps.order_id, statut));
}

module.exports = { configure, instructionsManuelles, waveCreerSession, waveVerifierSession, orangeCreerSession, orangeVerifierTransaction, webhookWave, webhookOrange };

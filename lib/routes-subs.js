// SHOPARA - abonnements (paiement manuel Wave/OM + validation admin, jamais de fausse activation)
'use strict';
const { makeAuth } = require('./app');
const { getSetting } = require('./db');

module.exports = function (app, db) {
  const auth = makeAuth(db);

  // Demande d'abonnement -> instructions de paiement manuel
  app.post('/api/subscriptions', auth.requireAuth, (req, res) => {
    const plan = req.body && req.body.plan;
    if (!['1mois', '2mois'].includes(plan)) return res.status(400).json({ error: 'Formule invalide (1mois ou 2mois)' });
    const months = plan === '1mois' ? 1 : 2;
    const amount = Number(getSetting('plan_' + plan, months === 1 ? '2500' : '5000'));
    const numero = getSetting('abonnement_numero', '772695341');
    const r = db.prepare("INSERT INTO subscriptions(user_id,plan,months,amount,status) VALUES(?,?,?,?,'en_attente')").run(req.user.id, plan, months, amount);
    res.json({
      ok: true, subscriptionId: r.lastInsertRowid,
      payment: {
        mode: 'manuel',
        numero, amount,
        instructions: 'Envoyez ' + amount + ' FCFA au ' + numero + ' (Wave ou Orange Money), puis enregistrez la reference de la transaction. Un administrateur verifiera le paiement avant activation.'
      }
    });
  });

  // Le vendeur enregistre sa reference de paiement
  app.post('/api/subscriptions/:id/payref', auth.requireAuth, (req, res) => {
    const sub = db.prepare('SELECT * FROM subscriptions WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!sub) return res.status(404).json({ error: 'Abonnement introuvable' });
    const ref = ((req.body && req.body.reference) || '').trim();
    if (!ref || ref.length < 4) return res.status(400).json({ error: 'Reference de transaction requise (4+ caracteres)' });
    db.prepare("UPDATE subscriptions SET pay_ref=?, status='en_verification' WHERE id=?").run(ref.slice(0, 50), sub.id);
    res.json({ ok: true, message: 'Reference enregistree. Un administrateur va verifier le paiement.' });
  });

  // Abonnement actif courant
  app.get('/api/me/subscription', auth.requireAuth, (req, res) => {
    const sub = db.prepare("SELECT * FROM subscriptions WHERE user_id=? AND status='actif' AND ends_at>=date('now') ORDER BY ends_at DESC LIMIT 1").get(req.user.id);
    res.json({ subscription: sub || null });
  });

  app.get('/api/me/subscriptions', auth.requireAuth, (req, res) => {
    res.json({ subscriptions: db.prepare('SELECT * FROM subscriptions WHERE user_id=? ORDER BY id DESC').all(req.user.id) });
  });
};

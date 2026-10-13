// paiements.js - Shopara payments module
// Phase 1 (actif): paiement manuel avec reference de transaction + validation admin.
// Phase 2 (inactif sans cles API): Wave Checkout / Orange Money B2B.
'use strict';

const configure = !!(process.env.WAVE_API_KEY) || !!(process.env.OM_MERCHANT_KEY && process.env.OM_BASIC_AUTH);

// ---------- Phase 2: Wave Checkout (API officielle docs.wave.com/business) ----------
async function waveCreerSession({ montant, reference, urlRetour }) {
  if (!process.env.WAVE_API_KEY) return { configure: false };
  const res = await fetch('https://api.wave.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.WAVE_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: montant,
      currency: 'XOF',
      client_reference: reference,
      success_url: urlRetour
    })
  });
  if (!res.ok) throw new Error('Wave: ' + res.status);
  return { configure: true, data: await res.json() };
}

async function waveVerifierSession(sessionId) {
  if (!process.env.WAVE_API_KEY) return { configure: false };
  const res = await fetch('https://api.wave.com/v1/checkout/sessions/' + encodeURIComponent(sessionId), {
    headers: { 'Authorization': 'Bearer ' + process.env.WAVE_API_KEY }
  });
  if (!res.ok) throw new Error('Wave: ' + res.status);
  const d = await res.json();
  let statut = 'en_attente_paiement';
  if (d.payment_status === 's8_success') statut = 'payee';
  else if (d.payment_status === 's8_declined') statut = 'echoue';
  else if (d.payment_status === 's8_cancelled') statut = 'annule';
  return {
    configure: true,
    statut,
    montant: d.amount,
    devise: d.currency,
    reference: d.client_reference,
    brut: d
  };
}

// ---------- Phase 2: Orange Money Paiement Internet ----------
async function orangeCreerSession({ montant, reference, urlRetour }) {
  if (!process.env.OM_MERCHANT_KEY || !process.env.OM_BASIC_AUTH || !process.env.OM_API_URL) return { configure: false };
  const token = Buffer.from(process.env.OM_BASIC_AUTH).toString('base64');
  const res = await fetch(process.env.OM_API_URL + '/payment', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      merchant_key: process.env.OM_MERCHANT_KEY,
      currency: 'OUV',
      order_id: reference,
      amount: montant,
      return_url: urlRetour,
      cancel_url: urlRetour,
      notif_url: urlRetour
    })
  });
  if (!res.ok) throw new Error('OM: ' + res.status);
  return { configure: true, data: await res.json() };
}

async function orangeVerifierTransaction(payToken) {
  if (!process.env.OM_MERCHANT_KEY || !process.env.OM_BASIC_AUTH || !process.env.OM_API_URL) return { configure: false };
  const token = Buffer.from(process.env.OM_BASIC_AUTH).toString('base64');
  const res = await fetch(process.env.OM_API_URL + '/transactionstatus', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id: payToken, notif_token: process.env.OM_MERCHANT_KEY })
  });
  if (!res.ok) throw new Error('OM: ' + res.status);
  const d = await res.json();
  let statut = 'en_attente_paiement';
  const s = String(d.status || '').toUpperCase();
  if (s === 'SUCCESS' || s === 'SUCCESSFULL') statut = 'payee';
  else if (s === 'FAILED') statut = 'echoue';
  else if (s === 'CANCELLED') statut = 'annule';
  else if (s === 'EXPIRED') statut = 'expire';
  return { configure: true, statut, montant: d.amount, brut: d };
}

// ---------- Phase 1: instructions manuelles (actives par defaut) ----------
function instructionsManuelles({ mode, numero, montant, reference }) {
  if (mode === 'om') {
    return [
      '1. Composez #144# sur votre telephone Orange.',
      '2. Choisissez Transfert puis envoyer ' + montant + ' FCFA au ' + numero + '.',
      '3. Notez la reference de la transaction OM affichee.',
      '4. Saisissez cette reference ci-dessous pour que la boutique la verifie.',
      'IMPORTANT: tant que la reference n est pas verifiee, la commande reste En attente de paiement.'
    ];
  }
  return [
    '1. Ouvrez votre application Wave.',
    '2. Envoyez ' + montant + ' FCFA au numero ' + numero + '.',
    '3. Notez la reference de la transaction Wave.',
    '4. Saisissez cette reference ci-dessous pour que la boutique la verifie.',
    'IMPORTANT: tant que la reference n est pas verifiee, la commande reste En attente de paiement.'
  ];
}

module.exports = { configure, waveCreerSession, waveVerifierSession, orangeCreerSession, orangeVerifierTransaction, instructionsManuelles };

// auth.js - Shopara auth utilities (scrypt hashing, sessions helpers)
'use strict';
const crypto = require('crypto');

function hashMotDePasse(motDePasse) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(motDePasse, salt, 32).toString('hex');
  return salt + ':' + hash;
}

function verifierMotDePasse(motDePasse, stocke) {
  try {
    const [salt, hash] = stocke.split(':');
    const calc = crypto.scryptSync(motDePasse, salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calc, 'hex'));
  } catch (e) {
    return false;
  }
}

function genererNumeroCommande() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const date = d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return 'SP-' + date + '-' + rand;
}

function slugify(nom) {
  return nom.toString().toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'boutique';
}

module.exports = { hashMotDePasse, verifierMotDePasse, genererNumeroCommande, slugify };

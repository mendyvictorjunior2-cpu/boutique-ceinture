// SHOPARA - application Express + securite + middleware
'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const rateLimit = require('express-rate-limit');

const DATA_DIR = path.join(__dirname, '..', 'data');

function createApp(db) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: DATA_DIR }),
    secret: process.env.SESSION_SECRET || 'shopara-secret-change-me',
    resave: false, saveUninitialized: true,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000, secure: 'auto' }
  }));
  app.use(rateLimit({ windowMs: 60 * 1000, max: 300 }));
  return app;
}

// Middleware d'authentification (fabriques avec acces db)
function makeAuth(db) {
  function getUser(req) {
    return req.session.userId ? db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId) : null;
  }
  return {
    getUser,
    requireAuth: (req, res, next) => {
      const u = getUser(req);
      if (!u || u.suspended === 1) return res.status(401).json({ error: 'Non authentifie ou compte suspendu' });
      req.user = u; next();
    },
    requireAdmin: (req, res, next) => {
      const u = getUser(req);
      if (!u || u.suspended !== -1) return res.status(403).json({ error: 'Acces admin requis' });
      req.user = u; next();
    },
    requireShop: (req, res, next) => {
      const shop = db.prepare('SELECT * FROM shops WHERE id=? AND user_id=?').get(req.params.shopId, req.user.id);
      if (!shop) return res.status(404).json({ error: 'Boutique introuvable' });
      req.shop = shop; next();
    }
  };
}

module.exports = { createApp, makeAuth };

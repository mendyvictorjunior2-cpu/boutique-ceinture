// ============================================================
// SHOPARA - SaaS de boutiques en ligne (Senegal) - v2.0
// Point d'entree : assemble les modules
// ============================================================
'use strict';
const path = require('path');
const db = require('./lib/db');
const { createApp } = require('./lib/app');

const PORT = process.env.PORT || 3000;
const app = createApp(db);

require('./lib/routes-auth')(app, db);
require('./lib/routes-shops')(app, db);
require('./lib/routes-orders')(app, db);
require('./lib/routes-subs')(app, db);
require('./lib/routes-admin')(app, db);

// Pages statiques + fallback
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route inconnue' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log('Shopara demarre sur le port ' + PORT));

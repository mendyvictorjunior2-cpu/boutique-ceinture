// routes-suite.js - Shopara: aggrege les modules de routes
'use strict';
module.exports = function registerRoutes(app, ctx) {
  require('./routes-commandes')(app, ctx);
  require('./routes-abonnements')(app, ctx);
  require('./routes-stats')(app, ctx);
  require('./routes-admin')(app, ctx);
};

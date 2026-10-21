'use strict';
/* ================================================
   Vercel entry point — every /api/* request lands here
   (see the rewrite in vercel.json). Static pages and the admin UI
   are served by Vercel's CDN from /public.

   The module-level `ready` promise is reused while an instance is warm,
   so the database pool and migrations are set up once per cold start.
   No state lives in memory between requests.
   ================================================ */
const { buildConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { createProvider } = require('../server/payments');
const { createApp } = require('../server/app');
const { createAdminApp } = require('../server/admin/app');

let ready = null;

function init() {
  if (!ready) {
    ready = (async () => {
      const config = buildConfig();
      const db = await openDb({ databaseUrl: config.databaseUrl, defaultStock: config.defaultStock });
      const provider = createProvider(config, db);
      return {
        store: createApp({ config, db, provider }),
        admin: config.admin.enabled ? createAdminApp({ config, db, provider }) : null,
      };
    })().catch(err => {
      ready = null; // let the next request retry
      throw err;
    });
  }
  return ready;
}

module.exports = async function handler(req, res) {
  let app;
  try {
    app = await init();
  } catch (err) {
    // Details go to the function logs only, never to the visitor
    console.error('[startup] ', err.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: 'The service is temporarily unavailable.' }));
    return;
  }
  const pathname = String(req.url || '/').split('?')[0];
  if (pathname.startsWith('/api/admin/')) {
    if (!app.admin) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    return app.admin(req, res);
  }
  return app.store(req, res);
};

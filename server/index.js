'use strict';
/* ================================================
   Local / self-hosted runner.
   Store on :3000, admin on :3001 (localhost only by default).
   With no DATABASE_URL it uses PGlite (real Postgres in WASM, stored
   in data/pgdata) so `npm start` works with zero setup.
   On Vercel this file is not used — see api/index.js.
   ================================================ */
const http = require('node:http');
const { loadDotEnv, buildConfig } = require('./config');
const { openDb } = require('./db');
const { createProvider } = require('./payments');
const { createApp } = require('./app');
const { createAdminApp } = require('./admin/app');

async function main() {
  loadDotEnv();

  let config;
  try {
    config = buildConfig();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir, defaultStock: config.defaultStock });
  const provider = createProvider(config, db);

  const harden = server => {
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 64;
    return server;
  };

  const servers = [];
  const store = harden(http.createServer(createApp({ config, db, provider })));
  store.listen(config.port, config.host, () => {
    console.log(`House of Mangalya running at ${config.publicOrigin}  (bound to ${config.host}:${config.port})`);
    console.log(`Database: ${db.engine === 'postgres' ? 'PostgreSQL' : 'local PGlite (data/pgdata)'}`);
    console.log(`Payment provider: ${provider.name}${provider.name === 'mock' ? '  — TEST MODE, no real money' : ''}`);
  });
  servers.push(store);

  if (config.admin.enabled) {
    const adminServer = harden(http.createServer(createAdminApp({ config, db, provider })));
    adminServer.listen(config.admin.port, config.admin.host, () => {
      console.log(`Admin portal at ${config.admin.origin}  (bound to ${config.admin.host}:${config.admin.port})`);
    });
    servers.push(adminServer);
  } else {
    console.log('Admin portal disabled — run "npm run admin:password" to enable it.');
  }

  const shutdown = () => {
    let open = servers.length;
    for (const s of servers) {
      s.close(() => {
        if (--open === 0) db.close().finally(() => process.exit(0));
      });
    }
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

'use strict';
/* ================================================
   Portable, gzip-compressed JSON snapshot of the business data.
     npm run backup
   Works against whatever database the app uses (Neon/Postgres via DATABASE_URL,
   or the local PGlite folder). Keeps the newest 30 snapshots in backups/
   (git-ignored). The files contain customer addresses — keep them private.

   Note: Neon also keeps its own point-in-time history (check your plan's
   retention); this script gives you an independent copy you control.
   ================================================ */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { loadDotEnv, buildConfig } = require('../server/config');
const { openDb } = require('../server/db');

const TABLES = ['orders', 'webhook_events', 'newsletter', 'audit_log', 'coupons', 'inventory', 'stock_log', 'settings', 'ad_spend'];

(async () => {
  loadDotEnv();
  const config = buildConfig();
  const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir, defaultStock: config.defaultStock });

  const dump = { createdAt: new Date().toISOString(), engine: db.engine, tables: {} };
  for (const t of TABLES) dump.tables[t] = await db.pg.q(`SELECT * FROM ${t}`); // table names are the fixed list above
  await db.close();

  const dir = path.join(config.root, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = dump.createdAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const target = path.join(dir, `backup-${stamp}.json.gz`);
  fs.writeFileSync(target, zlib.gzipSync(JSON.stringify(dump)), { mode: 0o600 });

  const files = fs.readdirSync(dir).filter(f => /^backup-\d{8}-\d{6}\.json\.gz$/.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - 30))) fs.rmSync(path.join(dir, old));
  const rows = Object.values(dump.tables).reduce((n, r) => n + r.length, 0);
  console.log(`Backup written: ${path.relative(config.root, target)} (${(fs.statSync(target).size / 1024).toFixed(0)} KB, ${rows} rows). Keeping ${Math.min(files.length, 30)} snapshots.`);
})().catch(e => { console.error(e); process.exit(1); });

'use strict';
/* ================================================
   Generates vercel.json so the security headers on static pages
   are exactly the ones the server code defines (no drift).
     npm run build:vercel          → writes vercel.json
     node scripts/build-vercel.js --check   → exits 1 if vercel.json is out of date (used by tests)
   ================================================ */
const fs = require('node:fs');
const path = require('node:path');
const { securityHeaders } = require('../server/http');
const { ADMIN_HEADERS } = require('../server/admin/app');

const toList = obj => Object.entries(obj).map(([key, value]) => ({ key, value }));

function build() {
  const store = securityHeaders({ isProduction: true });
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: null,
    buildCommand: null,
    installCommand: 'npm ci --omit=dev',
    outputDirectory: 'public',
    cleanUrls: false,
    trailingSlash: false,
    regions: ['sin1'],
    functions: {
      'api/index.js': {
        maxDuration: 20,
        memory: 1024,
        // The in-process Postgres used for local dev is never needed in the cloud
        excludeFiles: '{node_modules/@electric-sql/**,test/**,docs/**}',
      },
    },
    rewrites: [{ source: '/api/:path*', destination: '/api/index' }],
    redirects: [{ source: '/admin', destination: '/admin/', permanent: false }],
    headers: [
      // Store pages: everything except /admin
      { source: '/((?!admin(?:/|$)).*)', headers: toList(store) },
      { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }] },
      // Admin UI: stricter policy, never cached, never indexed
      { source: '/admin/(.*)', headers: toList(ADMIN_HEADERS) },
    ],
  };
}

const json = JSON.stringify(build(), null, 2) + '\n';
const file = path.resolve(__dirname, '..', 'vercel.json');
if (process.argv.includes('--check')) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current !== json) {
    console.error('vercel.json is out of date — run: npm run build:vercel');
    process.exit(1);
  }
  console.log('vercel.json is up to date');
} else {
  fs.writeFileSync(file, json);
  console.log('Wrote vercel.json');
}

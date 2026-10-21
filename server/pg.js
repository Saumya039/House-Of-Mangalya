'use strict';
/* ================================================
   Database adapter — one tiny interface over two engines:
     • node-postgres (`pg`)  when DATABASE_URL is set (Neon, Supabase, RDS, local Postgres…)
     • PGlite (real Postgres compiled to WASM) for zero-setup local development and tests
   Both speak the same SQL, so what runs on your laptop is what runs in production.

   Interface (every method returns a Promise):
     q(sql, params?)        -> rows[]
     run(sql, params?)      -> { rows, rowCount }
     named(sql, {a:1})      -> rows[]      uses :a placeholders (converted to $1…)
     tx(async t => { … })   -> result      t has q / run / named; commits or rolls back
     close()
   Integers (COUNT, SUM) and numerics come back as JavaScript numbers.
   ================================================ */

// A quoted string literal (skipped) OR a :name placeholder (replaced). `::casts` never match.
const NAMED = /'(?:[^']|'')*'|(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** Converts :name placeholders to $1…$n (same name reused → same parameter). */
function toPositional(text, params = {}) {
  const names = [];
  const out = text.replace(NAMED, (m, name) => {
    if (name === undefined) return m; // a string literal — leave it alone
    if (!Object.hasOwn(params, name)) throw new Error(`Missing SQL parameter :${name}`);
    let i = names.indexOf(name);
    if (i < 0) { names.push(name); i = names.length - 1; }
    return `$${i + 1}`;
  });
  return [out, names.map(n => params[n])];
}

function wrap(exec) {
  const run = async (text, params = []) => {
    const r = await exec(text, params);
    return { rows: r.rows, rowCount: r.rowCount ?? r.affectedRows ?? r.rows.length };
  };
  return {
    run,
    q: async (text, params = []) => (await run(text, params)).rows,
    named: async (text, params) => (await run(...toPositional(text, params))).rows,
    namedRun: async (text, params) => run(...toPositional(text, params)),
  };
}

async function openPostgres({ databaseUrl, max = 4 }) {
  const pg = require('pg');
  pg.types.setTypeParser(20, v => Number(v));      // int8 (COUNT, SUM of ints)
  pg.types.setTypeParser(1700, v => Number(v));    // numeric
  const local = /@(localhost|127\.0\.0\.1)([:/]|$)/.test(databaseUrl);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 12_000,
    ssl: local ? false : { rejectUnauthorized: true },
  });
  pool.on('error', () => { /* an idle client dropped; the pool replaces it */ });
  const base = wrap((t, p) => pool.query(t, p));
  return {
    engine: 'postgres',
    ...base,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap((t, p) => client.query(t, p)));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite({ dataDir }) {
  const { PGlite, types } = require('@electric-sql/pglite');
  const db = new PGlite({
    ...(dataDir ? { dataDir } : {}),
    parsers: { [types.INT8]: v => Number(v), [types.NUMERIC]: v => Number(v) },
  });
  await db.waitReady;
  const base = wrap((t, p) => db.query(t, p));
  return {
    engine: 'pglite',
    ...base,
    tx: fn => db.transaction(tx => fn(wrap((t, p) => tx.query(t, p)))),
    close: () => db.close(),
  };
}

/** @param {{databaseUrl?:string, dataDir?:string}} opts */
async function openAdapter(opts = {}) {
  if (opts.databaseUrl) return openPostgres(opts);
  return openPglite(opts);
}

module.exports = { openAdapter, toPositional };

// Cloudflare D1 (free plan: 100,000 rows written and 5 million rows read a day,
// 5 GB) as the counter and rate-limit store, through D1's REST API, so no
// Cloudflare Worker is needed. It speaks the same small pipeline of Redis
// commands as upstashStore (server/usage.js), so the counter and the
// early-warning rate limiter work unchanged:
//   INCR, GET, SET, EXPIRE, PERSIST (numbers with an optional expiry; SET takes an integer)
//   PFADD, PFCOUNT (an exact set: the monthly visitor ids, already HMACs)
// Expired rows are skipped on read and deleted now and then.

const KV = 'neuro_kv';
const SET = 'neuro_set';
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${KV} (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, exp INTEGER)`,
  `CREATE TABLE IF NOT EXISTS ${SET} (k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (k, v)) WITHOUT ROWID`,
];
const CLEANUP_EVERY = 200; // about one call in 200 also deletes expired rows

/** One Redis command -> one SQL statement, and how to read its result. */
function toSql([cmd, key, arg], now) {
  const k = String(key);
  const t = String(now);
  switch (cmd) {
    case 'INCR':
      // an expired number starts again from 1, as a missing Redis key would
      return {
        sql: `INSERT INTO ${KV} (k, n) VALUES (?1, 1) ON CONFLICT (k) DO UPDATE SET
                n = CASE WHEN exp IS NOT NULL AND exp <= CAST(?2 AS INTEGER) THEN 1 ELSE n + 1 END,
                exp = CASE WHEN exp IS NOT NULL AND exp <= CAST(?2 AS INTEGER) THEN NULL ELSE exp END
              RETURNING n`,
        params: [k, t],
        read: (r) => Number(r.results?.[0]?.n ?? 0),
      };
    case 'GET':
      return {
        sql: `SELECT n FROM ${KV} WHERE k = ?1 AND (exp IS NULL OR exp > CAST(?2 AS INTEGER))`,
        params: [k, t],
        read: (r) => (r.results?.length ? String(r.results[0].n) : null),
      };
    case 'SET': {
      // integers only (the table holds numbers); clears any expiry, as Redis SET does
      const v = Number(arg);
      if (!Number.isSafeInteger(v)) throw new Error('d1: SET needs an integer');
      return {
        sql: `INSERT INTO ${KV} (k, n, exp) VALUES (?1, CAST(?2 AS INTEGER), NULL) ON CONFLICT (k) DO UPDATE SET n = excluded.n, exp = NULL`,
        params: [k, String(v)],
        read: () => 'OK',
      };
    }
    case 'EXPIRE':
      // set once (callers repeat it on every request; rewriting it would cost a write each time)
      return {
        sql: `UPDATE ${KV} SET exp = CAST(?2 AS INTEGER) + CAST(?3 AS INTEGER) WHERE k = ?1 AND exp IS NULL`,
        params: [k, t, String(Math.max(0, Math.floor(Number(arg) || 0)))],
        read: (r) => (r.meta?.changes ? 1 : 0),
      };
    case 'PERSIST':
      return {
        sql: `UPDATE ${KV} SET exp = NULL WHERE k = ?1 AND exp IS NOT NULL`,
        params: [k],
        read: (r) => (r.meta?.changes ? 1 : 0),
      };
    case 'PFADD':
      return {
        sql: `INSERT OR IGNORE INTO ${SET} (k, v) VALUES (?1, ?2)`,
        params: [k, String(arg)],
        read: (r) => (r.meta?.changes ? 1 : 0),
      };
    case 'PFCOUNT':
      return {
        sql: `SELECT COUNT(*) AS n FROM ${SET} WHERE k = ?1`,
        params: [k],
        read: (r) => Number(r.results?.[0]?.n ?? 0),
      };
    default:
      throw new Error(`d1: unsupported ${cmd}`);
  }
}

/**
 * @param {string} accountId  Cloudflare account id
 * @param {string} databaseId D1 database id (uuid)
 * @param {string} token      API token with "D1: Edit" on this account
 * @returns {{pipeline:(cmds:Array<Array<string|number>>)=>Promise<Array<any>>}|null}
 */
export function d1Store(accountId, databaseId, token, { fetchImpl = globalThis.fetch, now = () => Date.now(), random = Math.random } = {}) {
  if (!accountId || !databaseId || !token) return null;
  if (!/^[0-9a-f]{32}$/i.test(accountId) || !/^[0-9a-f-]{36}$/i.test(databaseId)) return null;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  let ready = false; // the tables exist (checked once per instance)
  return {
    async pipeline(cmds) {
      const sec = Math.floor(now() / 1000);
      const stmts = cmds.map((c) => toSql(c, sec));
      const pre = ready ? [] : SCHEMA.map((sql) => ({ sql }));
      const post = random() * CLEANUP_EVERY < 1
        ? [{ sql: `DELETE FROM ${KV} WHERE exp IS NOT NULL AND exp <= CAST(?1 AS INTEGER)`, params: [String(sec)] }]
        : [];
      const batch = [...pre, ...stmts.map(({ sql, params }) => ({ sql, params })), ...post];
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ batch }),
      });
      if (!res.ok) throw new Error(`d1 HTTP ${res.status}`);
      const out = await res.json();
      if (!out?.success || !Array.isArray(out.result)) throw new Error('d1: query failed');
      ready = true;
      const results = out.result.slice(pre.length, pre.length + stmts.length);
      if (results.length !== stmts.length) throw new Error('d1: short result');
      return results.map((r, i) => {
        if (r?.success === false) throw new Error('d1: statement failed');
        return stmts[i].read(r);
      });
    },
  };
}

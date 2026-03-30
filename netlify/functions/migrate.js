const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) {
    const config = process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
      : {
          host: process.env.PG_HOST,
          port: parseInt(process.env.PG_PORT || '5432'),
          database: process.env.PG_DB,
          user: process.env.PG_USER,
          password: process.env.PG_PASSWORD,
          ssl: { rejectUnauthorized: false },
        };
    pool = new Pool(config);
  }
  return pool;
}

function decodeJWT(token) {
  try {
    const raw = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(raw, 'base64').toString());
    if (typeof payload === 'number') return { id: payload };
    return payload;
  } catch { return null; }
}

async function isAdmin(db, user) {
  if (!user || !user.id) return false;
  const tables = ['wl_users', '"wl_Users"'];
  for (const table of tables) {
    try {
      const r = await db.query(`SELECT "type" FROM ${table} WHERE id = $1`, [user.id]);
      if (r.rows[0]) return ['administrator', 'admin'].includes(r.rows[0].type);
    } catch {}
  }
  return false;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const db = getPool();
  const auth = (event.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = auth ? decodeJWT(auth) : null;
  const admin = await isAdmin(db, user);
  if (!admin) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'admin only' }) };
  }

  try {
    // GET: show current paths in database
    if (event.httpMethod === 'GET') {
      const comments = await db.query(
        `SELECT DISTINCT url AS path, COUNT(*)::int AS count FROM wl_comment GROUP BY url ORDER BY url`
      ).catch(() => ({ rows: [] }));

      const ratings = await db.query(
        `SELECT DISTINCT poem AS path, COUNT(*)::int AS count FROM wl_rating GROUP BY poem ORDER BY poem`
      ).catch(() => ({ rows: [] }));

      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ comments: comments.rows, ratings: ratings.rows }),
      };
    }

    // POST: apply path migration
    if (event.httpMethod === 'POST') {
      const { mapping } = JSON.parse(event.body || '{}');
      if (!mapping || !Array.isArray(mapping)) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'mapping array required' }) };
      }

      let commentUpdates = 0;
      let ratingUpdates = 0;

      for (const { from, to } of mapping) {
        // Update comments
        try {
          const r1 = await db.query('UPDATE wl_comment SET url = $2 WHERE url = $1', [from, to]);
          commentUpdates += r1.rowCount;
        } catch {}

        // Update ratings
        try {
          const r2 = await db.query('UPDATE wl_rating SET poem = $2 WHERE poem = $1', [from, to]);
          ratingUpdates += r2.rowCount;
        } catch {}
      }

      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ commentUpdates, ratingUpdates }),
      };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

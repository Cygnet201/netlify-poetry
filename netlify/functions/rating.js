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
    // Waline encodes just the user ID as the JWT payload
    if (typeof payload === 'number') return { id: payload };
    if (typeof payload === 'object' && payload !== null) return payload;
    return null;
  } catch {
    return null;
  }
}

let tableReady = false;
async function ensureTable(db) {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS wl_rating (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      poem VARCHAR(500) NOT NULL,
      score SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 10),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, poem)
    )
  `);
  // Migrate old 1-5 constraint to 1-10 (safe to run repeatedly)
  await db.query(`
    DO $$
    BEGIN
      ALTER TABLE wl_rating DROP CONSTRAINT IF EXISTS wl_rating_score_check;
      ALTER TABLE wl_rating ADD CONSTRAINT wl_rating_score_check CHECK (score BETWEEN 1 AND 10);
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);
  tableReady = true;
}

async function isAdmin(db, user) {
  if (!user || !user.id) return false;

  // JWT only contains user ID, must check database for admin status
  const tables = ['wl_users', '"wl_Users"'];
  for (const table of tables) {
    try {
      const r = await db.query(
        `SELECT "type" FROM ${table} WHERE id = $1`, [user.id]
      );
      if (r.rows[0]) {
        return r.rows[0].type === 'administrator' || r.rows[0].type === 'admin';
      }
    } catch { /* try next table name */ }
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

  try {
    const db = getPool();
    await ensureTable(db);

    // Extract user from JWT (payload is just the user ID number)
    const auth = (event.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = auth ? decodeJWT(auth) : null;

    // Admin: GET ?all=1 returns full stats
    if (event.httpMethod === 'GET' && (event.queryStringParameters || {}).all) {
      const admin = await isAdmin(db, user);
      if (!admin) {
        return {
          statusCode: 403, headers: CORS,
          body: JSON.stringify({
            error: 'admin only',
            debug: { user_id: user ? user.id : null }
          }),
        };
      }

      const allStats = await db.query(`
        SELECT r.poem,
               COUNT(*)::int AS count,
               ROUND(AVG(r.score)::numeric, 1) AS avg,
               json_agg(json_build_object(
                 'user_id', r.user_id,
                 'display_name', u.display_name,
                 'score', r.score,
                 'updated_at', r.updated_at
               ) ORDER BY r.updated_at DESC) AS details
        FROM wl_rating r
        LEFT JOIN wl_users u ON u.id = r.user_id
        GROUP BY r.poem
        ORDER BY count DESC
      `);

      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify(allStats.rows.map(row => ({
          poem: row.poem,
          count: row.count,
          avg: parseFloat(row.avg),
          details: row.details,
        }))),
      };
    }

    if (event.httpMethod === 'POST') {
      if (!user || !user.id) {
        return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'login required' }) };
      }

      const body = JSON.parse(event.body || '{}');
      const poem = (body.poem || '').trim();
      const score = parseInt(body.score);

      if (!poem) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'poem required' }) };
      }
      if (!score || score < 1 || score > 10) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'score must be 1-10' }) };
      }

      await db.query(
        `INSERT INTO wl_rating (user_id, poem, score)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, poem)
         DO UPDATE SET score = $3, updated_at = NOW()`,
        [user.id, poem, score]
      );
    }

    // GET or POST response: return stats for single poem
    const poem =
      event.httpMethod === 'GET'
        ? (event.queryStringParameters || {}).poem
        : (JSON.parse(event.body || '{}').poem || '').trim();

    if (!poem) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'poem required' }) };
    }

    const stats = await db.query(
      'SELECT COUNT(*)::int AS count, ROUND(AVG(score)::numeric, 1) AS avg FROM wl_rating WHERE poem = $1',
      [poem]
    );

    let userScore = null;
    if (user && user.id) {
      const ur = await db.query(
        'SELECT score FROM wl_rating WHERE user_id = $1 AND poem = $2',
        [user.id, poem]
      );
      if (ur.rows[0]) userScore = ur.rows[0].score;
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        count: stats.rows[0].count || 0,
        avg: parseFloat(stats.rows[0].avg) || 0,
        userScore,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

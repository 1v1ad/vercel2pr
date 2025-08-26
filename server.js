// server.js
// Express backend with VK/TG login logging + background account linking via signed 'aid' cookie

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// ----- Config -----
const PORT = process.env.PORT || 3001;
const AID_COOKIE_NAME = 'aid';
const AID_SECRET = process.env.AID_SECRET || 'dev_aid_secret_change_me';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// ----- Middleware -----
app.use(express.json());
app.use(cookieParser(AID_SECRET));

// CORS: allow configured origins or allow all in dev
const corsOptions = {
  origin: function (origin, cb) {
    if (!origin) return cb(null, true); // same-origin / curl
    if (CORS_ORIGINS.length === 0) return cb(null, true);
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));

// ----- DB -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech')
    ? { rejectUnauthorized: false }
    : undefined
});

async function initDB() {
  // Create extensions and tables if not exist
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS identities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(20) NOT NULL CHECK (provider IN ('vk','telegram')),
      provider_user_id TEXT NOT NULL,
      phone_hash TEXT NULL,
      user_data JSONB,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(provider, provider_user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_links (
      aid TEXT PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      first_seen TIMESTAMPTZ DEFAULT now(),
      last_seen TIMESTAMPTZ DEFAULT now(),
      ua_hash TEXT,
      ip_hash TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_actions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      identity_id UUID REFERENCES identities(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS link_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_user_id UUID,
      into_user_id UUID,
      score INT,
      reason JSONB,
      actor TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_identities_phone_hash
      ON identities (phone_hash)
      WHERE phone_hash IS NOT NULL;
  `);

  console.log('[DB] Ready');
}

// ----- Helpers -----
function hmac(data) {
  return crypto.createHmac('sha256', AID_SECRET).update(data).digest('hex');
}

function hashUA(ua='') {
  return hmac('ua:' + ua);
}
function hashIP(ip='') {
  return hmac('ip:' + ip);
}

function newAidToken() {
  // Store random token; cookie value will be signed by cookie-parser
  return crypto.randomBytes(16).toString('hex'); // 32 chars
}

async function ensureUserAndIdentity({ provider, providerUserId, userData, req }) {
  // Returns { userId, identityId, isNewUser }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find or create identity
    let identityRes = await client.query(
      'SELECT * FROM identities WHERE provider = $1 AND provider_user_id = $2',
      [provider, providerUserId]
    );

    let userId, identityId, isNewUser = false;

    if (identityRes.rows.length > 0) {
      identityId = identityRes.rows[0].id;
      userId = identityRes.rows[0].user_id;
      // Update user_data on each login
      await client.query('UPDATE identities SET user_data = $1 WHERE id = $2', [userData, identityId]);
    } else {
      // Create new user + identity
      const u = await client.query('INSERT INTO users DEFAULT VALUES RETURNING id');
      userId = u.rows[0].id;
      const i = await client.query(
        `INSERT INTO identities (user_id, provider, provider_user_id, user_data)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [userId, provider, providerUserId, userData]
      );
      identityId = i.rows[0].id;
      isNewUser = true;
    }

    // Device link via signed cookie
    const signedAid = req.signedCookies[AID_COOKIE_NAME];
    let aid = signedAid;
    if (!aid) {
      aid = newAidToken();
      // set signed cookie (httpOnly, sameSite=Lax)
      const isProd = (process.env.NODE_ENV === 'production');
      req.res.cookie(AID_COOKIE_NAME, aid, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd,
        signed: true,
        maxAge: 1000 * 60 * 60 * 24 * 365 // 1 year
      });
    }

    // Upsert device_links
    const uaHash = hashUA(req.headers['user-agent'] || '');
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString();
    const ipHash = hashIP(ip.split(',')[0].trim());

    const dl = await client.query('SELECT * FROM device_links WHERE aid = $1', [aid]);
    if (dl.rows.length === 0) {
      await client.query(
        `INSERT INTO device_links (aid, user_id, ua_hash, ip_hash) VALUES ($1,$2,$3,$4)`,
        [aid, userId, uaHash, ipHash]
      );
    } else {
      // If cookie mapped to a different user — merge!
      const aidUserId = dl.rows[0].user_id;
      if (aidUserId && aidUserId !== userId) {
        await mergeUsersTx(client, { fromUserId: userId, intoUserId: aidUserId, reason: { by: 'aid' }, score: 100 });
        userId = aidUserId; // after merge, identity is moved
      }
      await client.query('UPDATE device_links SET user_id=$2, last_seen=now(), ua_hash=$3, ip_hash=$4 WHERE aid=$1',
        [aid, userId, uaHash, ipHash]);
    }

    await client.query('COMMIT');
    return { userId, identityId, isNewUser };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function mergeUsersTx(client, { fromUserId, intoUserId, reason = {}, score = 100 }) {
  if (!fromUserId || !intoUserId || fromUserId === intoUserId) return;

  // Move identities
  await client.query('UPDATE identities SET user_id = $2 WHERE user_id = $1', [fromUserId, intoUserId]);
  // Move device links
  await client.query('UPDATE device_links SET user_id = $2 WHERE user_id = $1', [fromUserId, intoUserId]);

  // Optionally, move other related tables (balances, transactions) if you add them later

  // Delete from-user
  await client.query('DELETE FROM users WHERE id = $1', [fromUserId]);

  await client.query(
    'INSERT INTO link_audit (from_user_id, into_user_id, score, reason, actor) VALUES ($1,$2,$3,$4,$5)',
    [fromUserId, intoUserId, score, reason, 'system']
  );
}

function verifyTelegramAuth(data) {
  if (!TELEGRAM_BOT_TOKEN) return { ok: false, reason: 'No TELEGRAM_BOT_TOKEN set' };
  // data is the raw userData with 'hash'
  const { hash, ...fields } = data || {};
  if (!hash) return { ok: false, reason: 'No hash provided' };
  // build data_check_string
  const pairs = Object.keys(fields)
    .sort()
    .map(k => `${k}=${fields[k]}`)
    .join('\n');

  const secret = crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(pairs).digest('hex');
  return { ok: computed === String(hash).toLowerCase(), reason: computed };
}

// ----- Routes -----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Main login event sink (both VK and Telegram)
app.post('/api/log-auth', async (req, res) => {
  try {
    const { userId, action, timestamp, userData } = req.body || {};
    if (!userData || !userData.provider) {
      return res.status(400).json({ success: false, error: 'Missing userData.provider' });
    }
    const provider = userData.provider;
    const providerUserId = String(userId || userData.id || '').trim();
    if (!providerUserId) {
      return res.status(400).json({ success: false, error: 'Missing userId' });
    }

    // Optional: verify Telegram widget signature
    if (provider === 'telegram') {
      const v = verifyTelegramAuth(userData);
      if (!v.ok) {
        return res.status(400).json({ success: false, error: 'Telegram signature invalid' });
      }
    }

    const { userId: uId, identityId, isNewUser } = await ensureUserAndIdentity({
      provider,
      providerUserId,
      userData,
      req
    });

    await pool.query(
      'INSERT INTO user_actions (user_id, identity_id, action, metadata) VALUES ($1,$2,$3,$4)',
      [uId, identityId, action || `${provider}_login`, { timestamp, userData }]
    );

    res.json({ success: true, data: { userId: uId, identityId, provider, isNewUser } });
  } catch (err) {
    console.error('[/api/log-auth] error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Return current "merged" user + identities by device cookie
app.get('/api/me', async (req, res) => {
  try {
    const aid = req.signedCookies[AID_COOKIE_NAME];
    if (!aid) return res.json({ success: true, data: null });

    const dl = await pool.query('SELECT user_id FROM device_links WHERE aid=$1', [aid]);
    if (dl.rows.length === 0) return res.json({ success: true, data: null });

    const userId = dl.rows[0].user_id;

    const user = await pool.query('SELECT id, created_at, updated_at FROM users WHERE id=$1', [userId]);
    const identities = await pool.query(
      'SELECT id, provider, provider_user_id, user_data, created_at FROM identities WHERE user_id=$1 ORDER BY created_at ASC',
      [userId]
    );

    res.json({ success: true, data: { user: user.rows[0], identities: identities.rows } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => res.send('Auth/linking backend is alive'));

// ----- Start -----
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`[BOOT] Listening on ${PORT}`));
  })
  .catch(err => {
    console.error('[BOOT] DB init failed', err);
    process.exit(1);
  });

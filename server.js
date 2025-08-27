// server.js — VK OAuth Code Flow + Telegram verify + background linking
// - CORS preflight fixed
// - DB schema adapts to users.id type (uuid vs int)
// - /api/auth/vk/login and /api/auth/vk/callback for VK code flow
// - /api/log-auth for Telegram (with signature verify)
// - /api/me to read current user by signed 'aid' cookie

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

const PORT = process.env.PORT || 3001;
const AID_COOKIE_NAME = 'aid';
const AID_SECRET = process.env.AID_SECRET || 'dev_aid_secret_change_me';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// VK OAuth (code flow)
const VK_CLIENT_ID = process.env.VK_CLIENT_ID || process.env.VITE_VK_APP_ID || '';
const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET || '';
const VK_REDIRECT_URI = process.env.VK_REDIRECT_URI || ''; // e.g. https://vercel2pr.onrender.com/api/auth/vk/callback
const FRONTEND_RETURN_URL = process.env.FRONTEND_RETURN_URL || (CORS_ORIGINS[0] || '');

app.use(express.json());
app.use(cookieParser(AID_SECRET));

const corsOptions = {
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    if (CORS_ORIGINS.length === 0) return cb(null, true);
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

const { URLSearchParams } = require('url');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech')
    ? { rejectUnauthorized: false }
    : undefined
});

function hmac(data) { return crypto.createHmac('sha256', AID_SECRET).update(data).digest('hex'); }
function hashUA(ua='') { return hmac('ua:' + ua); }
function hashIP(ip='') { return hmac('ip:' + ip); }
function newAidToken() { return crypto.randomBytes(16).toString('hex'); }

async function getUsersIdType(client) {
  const q = await client.query(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name='id'
    LIMIT 1;
  `);
  if (q.rows.length === 0) return null;
  const t = q.rows[0].data_type || '';
  if (t.includes('uuid')) return 'uuid';
  if (t.includes('integer') || t.includes('bigint')) return 'int';
  return 'int';
}

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

    let idType = await getUsersIdType(client);
    if (!idType) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        );
      `);
      idType = 'int';
    }
    const USER_ID_SQLTYPE = idType === 'uuid' ? 'UUID' : 'BIGINT';

    await client.query(`
      CREATE TABLE IF NOT EXISTS identities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id ${USER_ID_SQLTYPE} REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(20) NOT NULL CHECK (provider IN ('vk','telegram')),
        provider_user_id TEXT NOT NULL,
        phone_hash TEXT NULL,
        user_data JSONB,
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE(provider, provider_user_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS device_links (
        aid TEXT PRIMARY KEY,
        user_id ${USER_ID_SQLTYPE} REFERENCES users(id) ON DELETE CASCADE,
        first_seen TIMESTAMPTZ DEFAULT now(),
        last_seen TIMESTAMPTZ DEFAULT now(),
        ua_hash TEXT,
        ip_hash TEXT
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_actions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id ${USER_ID_SQLTYPE} REFERENCES users(id) ON DELETE CASCADE,
        identity_id UUID REFERENCES identities(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS link_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_user_id ${USER_ID_SQLTYPE},
        into_user_id ${USER_ID_SQLTYPE},
        score INT,
        reason JSONB,
        actor TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_identities_phone_hash
        ON identities (phone_hash)
        WHERE phone_hash IS NOT NULL;
    `);

    await client.query('COMMIT');
    console.log('[DB] Ready with users.id type:', idType);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function mergeUsersTx(client, { fromUserId, intoUserId, reason = {}, score = 100 }) {
  if (!fromUserId || !intoUserId || String(fromUserId) === String(intoUserId)) return;
  await client.query('UPDATE identities SET user_id = $2 WHERE user_id = $1', [fromUserId, intoUserId]);
  await client.query('UPDATE device_links SET user_id = $2 WHERE user_id = $1', [fromUserId, intoUserId]);
  await client.query('DELETE FROM users WHERE id = $1', [fromUserId]);
  await client.query(
    'INSERT INTO link_audit (from_user_id, into_user_id, score, reason, actor) VALUES ($1,$2,$3,$4,$5)',
    [fromUserId, intoUserId, score, reason, 'system']
  );
}

async function ensureUserAndIdentity({ provider, providerUserId, userData, req }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let identityRes = await client.query(
      'SELECT * FROM identities WHERE provider = $1 AND provider_user_id = $2',
      [provider, providerUserId]
    );

    let userId, identityId, isNewUser = false;

    if (identityRes.rows.length > 0) {
      identityId = identityRes.rows[0].id;
      userId = identityRes.rows[0].user_id;
      await client.query('UPDATE identities SET user_data = $1 WHERE id = $2', [userData, identityId]);
    } else {
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

    let aid = req.signedCookies[AID_COOKIE_NAME];
    if (!aid) {
      aid = newAidToken();
      const isProd = (process.env.NODE_ENV === 'production');
      req.res.cookie(AID_COOKIE_NAME, aid, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd,
        signed: true,
        maxAge: 1000 * 60 * 60 * 24 * 365
      });
    }

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
      const aidUserId = dl.rows[0].user_id;
      if (aidUserId && String(aidUserId) !== String(userId)) {
        await mergeUsersTx(client, { fromUserId: userId, intoUserId: aidUserId, reason: { by: 'aid' }, score: 100 });
        userId = aidUserId;
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

function verifyTelegramAuth(data) {
  if (!TELEGRAM_BOT_TOKEN) return { ok: false, reason: 'No TELEGRAM_BOT_TOKEN set' };
  const { hash, ...fields } = data || {};
  if (!hash) return { ok: false, reason: 'No hash provided' };
  const pairs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(pairs).digest('hex');
  return { ok: computed === String(hash).toLowerCase(), reason: computed };
}

// === VK OAuth Code Flow endpoints ===
app.get('/api/auth/vk/login', (req, res) => {
  if (!VK_CLIENT_ID || !VK_REDIRECT_URI) {
    return res.status(500).send('VK OAuth not configured');
  }
  const state = crypto.randomBytes(12).toString('hex');
  const next = req.query.next || FRONTEND_RETURN_URL || '';
  const isProd = (process.env.NODE_ENV === 'production');
  res.cookie('vk_oauth_state', state, {
    httpOnly: true, sameSite: 'lax', secure: isProd, signed: true, maxAge: 10 * 60 * 1000
  });
  if (next) {
    res.cookie('vk_oauth_next', String(next), { httpOnly: true, sameSite: 'lax', secure: isProd, signed: true, maxAge: 10*60*1000 });
  }
  const params = new URLSearchParams({
    client_id: String(VK_CLIENT_ID),
    display: 'page',
    redirect_uri: VK_REDIRECT_URI,
    response_type: 'code',
    scope: '0',
    state
  });
  const url = `https://oauth.vk.com/authorize?${params.toString()}`;
  res.redirect(url);
});

app.get('/api/auth/vk/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).send(`VK error: ${error} ${error_description || ''}`);
    const saved = req.signedCookies['vk_oauth_state'];
    if (!state || !saved || String(state) !== String(saved)) return res.status(400).send('Invalid state');

    // exchange code for token
    const params = new URLSearchParams({
      client_id: String(VK_CLIENT_ID),
      client_secret: String(VK_CLIENT_SECRET),
      redirect_uri: VK_REDIRECT_URI,
      code: String(code || '')
    });
    const r = await fetch(`https://oauth.vk.com/access_token?${params.toString()}`);
    const json = await r.json();
    if (json.error) {
      return res.status(400).send(`Token exchange failed: ${json.error_description || json.error}`);
    }
    const vkUserId = json.user_id;
    if (!vkUserId) return res.status(400).send('No user_id in token response');

    // create/attach identity + set aid cookie
    const { userId } = await ensureUserAndIdentity({
      provider: 'vk', providerUserId: String(vkUserId), userData: { provider: 'vk', id: vkUserId }, req
    });
    await pool.query(
      'INSERT INTO user_actions (user_id, action, metadata) VALUES ($1,$2,$3)',
      [userId, 'vk_login_codeflow', { vk_user_id: vkUserId }]
    );

    // redirect back to frontend
    const next = req.signedCookies['vk_oauth_next'] || FRONTEND_RETURN_URL || '/';
    const sep = (next && next.includes('?')) ? '&' : '?';
    res.redirect(`${next}${sep}vk=ok`);
  } catch (e) {
    console.error('[vk/callback] error:', e);
    res.status(500).send('VK callback failed');
  }
});

// Health & auth APIs
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.post('/api/log-auth', async (req, res) => {
  try {
    const { userId, action, timestamp, userData } = req.body || {};
    if (!userData || !userData.provider) return res.status(400).json({ success: false, error: 'Missing userData.provider' });
    const provider = userData.provider;
    const providerUserId = String(userId || userData.id || '').trim();
    if (!providerUserId) return res.status(400).json({ success: false, error: 'Missing userId' });
    if (provider === 'telegram') {
      const v = verifyTelegramAuth(userData);
      if (!v.ok) return res.status(400).json({ success: false, error: 'Telegram signature invalid' });
    }
    const { userId: uId, identityId, isNewUser } = await ensureUserAndIdentity({ provider, providerUserId, userData, req });
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

initDB().then(() => app.listen(PORT, () => console.log(`[BOOT] Listening on ${PORT}`)))
  .catch(err => { console.error('[BOOT] DB init failed', err); process.exit(1); });

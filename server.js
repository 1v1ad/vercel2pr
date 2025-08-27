// server.js (CommonJS) — совместим с Render (node server.js)
// Роуты:
//   GET  /api/health
//   POST /api/log-auth      — валидация Telegram payload (требуется hash)
//   GET  /api/auth/vk/start — редирект на VK ID (id.vk.com/authorize)
//   GET  /api/auth/vk/callback — обмен кода на токен и возврат на фронт

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

// ====== ENV ======
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// VK ID
const VK_CLIENT_ID = process.env.VK_CLIENT_ID || '';
const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET || '';
const VK_REDIRECT_URI = process.env.VK_REDIRECT_URI || '';

// Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// ====== MIDDLEWARE ======
app.use(express.json());
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server / curl
    if (CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true
}));
app.options('*', cors());

// ====== HEALTH ======
app.get('/api/health', (req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() })
);

// ====== TELEGRAM VERIFY ======
function verifyTelegramAuth(data) {
  const { hash, ...rest } = data || {};
  if (!hash || !TELEGRAM_BOT_TOKEN) return false;
  const secret = crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest();
  const checkString = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('\n');
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return hmac === String(hash).toLowerCase();
}

app.post('/api/log-auth', async (req, res) => {
  try {
    const { provider, userData } = req.body || {};
    if (provider === 'telegram') {
      if (!verifyTelegramAuth(userData)) {
        return res.status(400).json({ ok: false, reason: 'telegram_signature_invalid' });
      }
      // здесь можно добавить сохранение в БД и установку cookie для склейки
      return res.json({ ok: true, provider: 'telegram' });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('[log-auth] error', e);
    res.status(500).json({ ok: false });
  }
});

// ====== VK ID (OAuth 2.1) ======
const VK_AUTH_ENDPOINT = 'https://id.vk.com/authorize';
const VK_TOKEN_ENDPOINT = 'https://id.vk.com/oauth2/auth';

app.get('/api/auth/vk/start', (req, res) => {
  if (!VK_CLIENT_ID || !VK_REDIRECT_URI) return res.status(500).send('VK is not configured');
  const state = crypto.randomBytes(16).toString('hex');
  const url = new URL(VK_AUTH_ENDPOINT);
  url.searchParams.set('client_id', VK_CLIENT_ID);
  url.searchParams.set('redirect_uri', VK_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'vkid.personal_info');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/api/auth/vk/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    if (!code) return res.status(400).send('missing code');

    const params = new URLSearchParams();
    params.set('grant_type', 'authorization_code');
    params.set('code', code);
    params.set('client_id', VK_CLIENT_ID);
    params.set('client_secret', VK_CLIENT_SECRET);
    params.set('redirect_uri', VK_REDIRECT_URI);

    // Node 18+ имеет global fetch
    const tokenResp = await fetch(VK_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    if (!tokenResp.ok) {
      const t = await tokenResp.text().catch(() => '');
      console.error('[VK] token exchange error', tokenResp.status, t);
      return res.status(400).send('Token exchange failed');
    }

    // const tokenJson = await tokenResp.json(); // при необходимости — запрос профиля
    const back = FRONTEND_URL || '/';
    const sep = back.includes('?') ? '&' : '?';
    res.redirect(`${back}${sep}vk=ok`);
  } catch (e) {
    console.error('[VK callback] error', e);
    res.status(500).send('Internal error');
  }
});

app.get('/', (req, res) => res.send('Backend up'));

app.listen(PORT, () => {
  console.log(`[BOOT] listening on :${PORT}`);
});

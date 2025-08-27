// server.js — CommonJS, совместим с Render (node server.js)
// Endpoints:
//   GET  /api/health
//   POST /api/log-auth            — валидация Telegram payload по hash
//   GET  /api/auth/vk/start       — VK ID authorize (PKCE: code_challenge S256)
//   GET  /api/auth/vk/callback    — обмен кода на токен (PKCE: code_verifier) и редирект на фронт

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const app = express();

// ===== ENV =====
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

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // server-to-server/curl
      if (CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS: ' + origin));
    },
    credentials: true,
  })
);
app.options('*', cors());

// ===== HEALTH =====
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ===== TELEGRAM verify =====
function verifyTelegramAuth(data) {
  const { hash, ...rest } = data || {};
  if (!hash || !TELEGRAM_BOT_TOKEN) return false;
  const secret = crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest();
  const checkString = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join('\n');
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
      // тут можно сохранить/склеить аккаунт; сейчас просто ок
      return res.json({ ok: true, provider: 'telegram' });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('[log-auth] error', e);
    res.status(500).json({ ok: false });
  }
});

// ===== VK ID (OAuth 2.1 + PKCE) =====
const VK_AUTH_ENDPOINT  = 'https://id.vk.com/authorize';
const VK_TOKEN_ENDPOINT = 'https://id.vk.com/oauth2/auth';

// helpers for PKCE
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function genPkcePair() {
  // code_verifier: 43..128 символов URL-safe
  const verifier = b64url(crypto.randomBytes(32)); // ~43 символа
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

app.get('/api/auth/vk/start', (req, res) => {
  if (!VK_CLIENT_ID || !VK_REDIRECT_URI) return res.status(500).send('VK is not configured');

  // PKCE
  const { verifier, challenge } = genPkcePair();
  // CSRF state
  const state = b64url(crypto.randomBytes(16));

  // Храним verifier/state в HttpOnly cookie (5 минут)
  const cookieOpts = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 5 * 60 * 1000,
    path: '/',
  };
  res.cookie('vk_pkce_verifier', verifier, cookieOpts);
  res.cookie('vk_state', state, cookieOpts);

  // authorize URL с PKCE
  const url = new URL(VK_AUTH_ENDPOINT);
  url.searchParams.set('client_id', VK_CLIENT_ID);
  url.searchParams.set('redirect_uri', VK_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'vkid.personal_info');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return res.redirect(url.toString());
});

app.get('/api/auth/vk/callback', async (req, res) => {
  try {
    const code  = String(req.query.code  || '');
    const state = String(req.query.state || '');
    const cookieState = req.cookies['vk_state'] || '';
    const verifier = req.cookies['vk_pkce_verifier'] || '';

    if (!code)  return res.status(400).send('missing code');
    if (!state || !cookieState || state !== cookieState) return res.status(400).send('invalid state');
    if (!verifier) return res.status(400).send('missing code_verifier');

    // Обмениваем код на токен: добавляем PKCE code_verifier
    const params = new URLSearchParams();
    params.set('grant_type', 'authorization_code');
    params.set('code', code);
    params.set('client_id', VK_CLIENT_ID);
    params.set('client_secret', VK_CLIENT_SECRET);
    params.set('redirect_uri', VK_REDIRECT_URI);
    params.set('code_verifier', verifier);

    const tokenResp = await fetch(VK_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    if (!tokenResp.ok) {
      const t = await tokenResp.text().catch(() => '');
      console.error('[VK] token exchange error', tokenResp.status, t);
      // Чистим куки, чтобы повторить поток
      res.clearCookie('vk_pkce_verifier');
      res.clearCookie('vk_state');
      return res.status(400).send('Token exchange failed');
    }

    // При желании здесь можно запросить профиль через users.get с access_token
    // const tokenJson = await tokenResp.json();

    // Чистим PKCE/state
    res.clearCookie('vk_pkce_verifier');
    res.clearCookie('vk_state');

    // Возвращаем на фронт
    const back = FRONTEND_URL || '/';
    const sep = back.includes('?') ? '&' : '?';
    return res.redirect(`${back}${sep}vk=ok`);
  } catch (e) {
    console.error('[VK callback] error', e);
    res.status(500).send('Internal error');
  }
});

// корень
app.get('/', (req, res) => res.send('Backend up'));

app.listen(PORT, () => {
  console.log(`[BOOT] listening on :${PORT}`);
});

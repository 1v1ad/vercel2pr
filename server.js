import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import crypto from 'crypto';

const app = express();

// ====== ENV ======
const PORT = process.env.PORT || 3001;
const AID_SECRET = process.env.AID_SECRET || 'dev_dev_dev';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// VK ID
const VK_CLIENT_ID = process.env.VK_CLIENT_ID || '';
const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET || '';
const VK_REDIRECT_URI = process.env.VK_REDIRECT_URI || ''; // e.g. https://vercel2pr.onrender.com/api/auth/vk/callback

// TELEGRAM
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// ====== MIDDLEWARE ======
app.use(express.json());
app.use(cors({
  origin: (origin, cb) => {
    // allow same-origin / server-to-server
    if (!origin) return cb(null, true);
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'), false);
  },
  credentials: true
}));

// ====== HEALTH ======
app.get('/api/health', (_, res) => res.json({ ok: true }));

// ====== TELEGRAM VERIFY ======
function verifyTelegramAuth(data) {
  // Док по валидации: сортируем все поля кроме hash, склеиваем, считаем HMAC-SHA256 с ключом = SHA256(bot_token)
  const { hash, ...rest } = data;
  const secret = crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest();
  const checkString = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join('\n');
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return hmac === hash;
}

// ====== AUTH LOG (used by TG) ======
app.post('/api/log-auth', async (req, res) => {
  try {
    const { provider, userData } = req.body || {};
    if (provider === 'telegram') {
      if (!userData || !userData.hash) {
        return res.status(400).json({ ok: false, reason: 'telegram_payload_missing_hash' });
      }
      if (!verifyTelegramAuth(userData)) {
        return res.status(400).json({ ok: false, reason: 'telegram_signature_invalid' });
      }
      // TODO: сохраняем/склеиваем аккаунт в БД. Сейчас просто ок.
      return res.json({ ok: true, provider: 'telegram' });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[log-auth] error', e);
    res.status(500).json({ ok: false });
  }
});

// ====== VK ID (OAuth 2.1 Code Flow) ======
const VK_AUTH_ENDPOINT = 'https://id.vk.com/authorize';
const VK_TOKEN_ENDPOINT = 'https://id.vk.com/oauth2/auth';

// старт авторизации
app.get('/api/auth/vk/start', (req, res) => {
  if (!VK_CLIENT_ID || !VK_REDIRECT_URI) {
    return res.status(500).send('VK is not configured');
  }
  const state = crypto.randomBytes(16).toString('hex');
  const url = new URL(VK_AUTH_ENDPOINT);
  url.searchParams.set('client_id', VK_CLIENT_ID);
  url.searchParams.set('redirect_uri', VK_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'vkid.personal_info');
  url.searchParams.set('state', state);
  return res.redirect(url.toString());
});

// колбэк — обмен кода на токен и получение профиля
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

    const tokenResp = await fetch(VK_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    if (!tokenResp.ok) {
      const t = await tokenResp.text().catch(() => '');
      console.error('[VK] token error', tokenResp.status, t);
      return res.status(400).send('Token exchange failed');
    }

    const tokenJson = await tokenResp.json();
    const accessToken = tokenJson.access_token;
    if (!accessToken) {
      return res.status(400).send('No access_token');
    }

    const meResp = await fetch(`https://api.vk.com/method/users.get?v=5.199&fields=photo_100&access_token=${encodeURIComponent(accessToken)}`);
    const meJson = await meResp.json().catch(() => null);

    const redirectTo = `${process.env.FRONTEND_URL || ''}/auth-complete?vk=1`;
    return res.send(`
      <html><body>
        <script>
          try {
            localStorage.setItem('vk_user', ${JSON.stringify({})});
            localStorage.setItem('user', JSON.stringify({ provider: 'vk' }));
          } catch(e) {}
          location.href='${"${process.env.FRONTEND_URL || ""}/auth-complete?vk=1"}';
        </script>
      </body></html>
    `);
  } catch (e) {
    console.error('[VK callback] error', e);
    res.status(500).send('Internal error');
  }
});

app.listen(PORT, () => {
  console.log(`[BOOT] listening on :${PORT}`);
});
import { Router } from 'express';
import crypto from 'crypto';

const router = Router();

// ------------------------------------------
// helpers
const cookieOpts = {
  httpOnly: true,
  sameSite: 'none',
  secure: true,
  path: '/',
  maxAge: 365 * 24 * 60 * 60 * 1000
};
const setSession = (res, sess) =>
  res.cookie('session', Buffer.from(JSON.stringify(sess)).toString('base64url'), cookieOpts);

const getSession = (req) => {
  try {
    const raw = req.cookies?.session;
    if (!raw) return null;
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const setSrc = (res, src) => res.cookie('src', src, { ...cookieOpts, httpOnly: false });
const getSrc = (req) => req.cookies?.src || null;

// ------------------------------------------
// build-info (для отладки конфигов)
router.get(['/api/auth/_build', '/api/auth/vk/debug'], (req, res) => {
  res.json({
    router: 'v14',
    uses: {
      TELEGRAM_BOT_TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
      TG_BOT_TOKEN: !!process.env.TG_BOT_TOKEN,
      FRONT_ORIGIN: !!process.env.FRONT_ORIGIN,
      FRONTEND_URL: !!process.env.FRONTEND_URL,
      FRONT_URL: !!process.env.FRONT_URL,
      VK_REDIRECT_URI: process.env.VK_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/vk/callback`,
      BACKEND_BASE: process.env.BACKEND_BASE || null,
      VK_CLIENT_ID: !!process.env.VK_CLIENT_ID,
      VK_CLIENT_SECRET: !!process.env.VK_CLIENT_SECRET
    }
  });
});

// ------------------------------------------
// /api/me — отдать пользователя из сессии
router.get('/api/me', (req, res) => {
  const sess = getSession(req);
  const src = getSrc(req);
  if (!sess?.user) return res.json({ ok: true, user: null, provider: null });

  res.json({
    ok: true,
    user: sess.user,
    provider: src || sess.user?.provider || null
  });
});

// ------------------------------------------
// VK OAuth (PKCE + либо client_secret)
function rand(n = 32) { return crypto.randomBytes(n).toString('base64url'); }

router.get('/api/auth/vk/start', (req, res) => {
  const verifier = rand(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  res.cookie('vk_verifier', verifier, cookieOpts);
  const clientId = process.env.VK_CLIENT_ID;
  const redirectUri = process.env.VK_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/vk/callback`;

  const url = new URL('https://id.vk.com/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'email');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  res.redirect(302, url.toString());
});

router.get('/api/auth/vk/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('vk: code missing');

    const clientId = process.env.VK_CLIENT_ID;
    const clientSecret = process.env.VK_CLIENT_SECRET;
    const redirectUri = process.env.VK_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/vk/callback`;
    const verifier = req.cookies?.vk_verifier;

    const params = new URLSearchParams();
    params.set('grant_type', 'authorization_code');
    params.set('redirect_uri', redirectUri);
    params.set('code', code);
    params.set('client_id', clientId);
    if (clientSecret) params.set('client_secret', clientSecret);
    else if (verifier) params.set('code_verifier', verifier);

    // токен
    const r = await fetch('https://id.vk.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    if (!r.ok) {
      const body = await r.text();
      return res.status(502).send(`vk token error: ${body}`);
    }
    const tok = await r.json();
    const access = tok.access_token;
    // профиль
    const meR = await fetch('https://api.vk.com/method/users.get?v=5.154&fields=photo_200', {
      headers: { Authorization: `Bearer ${access}` }
    });
    const meJ = await meR.json();
    const u0 = meJ?.response?.[0];
    if (!u0) return res.status(502).send('vk: cannot resolve user id');

    const user = {
      id: String(u0.id),
      name: [u0.first_name, u0.last_name].filter(Boolean).join(' '),
      photo: u0.photo_200 || null,
      provider: 'vk',
      balance: 0
    };

    setSrc(res, 'vk');
    setSession(res, { user });

    const front = process.env.FRONTEND_URL || process.env.FRONT_URL;
    if (front) return res.redirect(302, `${front.replace(/\/+$/,'')}/lobby.html`);
    res.redirect(302, '/lobby.html');
  } catch (e) {
    res.status(500).send(`vk callback error: ${e?.message || e}`);
  }
});

// ------------------------------------------
// Telegram WebApp auth callback (минимально)
router.get('/api/auth/tg/callback', (req, res) => {
  // Тут упрощённая верификация: для прода нужно проверить hash через TELEGRAM_BOT_TOKEN
  const hasToken = !!(process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN);
  if (!hasToken) return res.status(500).send('TELEGRAM_BOT_TOKEN not set');

  const user = {
    id: String(req.query.id || req.query.user?.id || 'guest'),
    name: req.query.first_name || 'Гость',
    photo: req.query.photo_url || null,
    provider: 'tg',
    balance: 0
  };
  setSrc(res, 'tg');
  setSession(res, { user });

  const front = process.env.FRONTEND_URL || process.env.FRONT_URL;
  if (front) return res.redirect(302, `${front.replace(/\/+$/,'')}/lobby.html`);
  res.redirect(302, '/lobby.html');
});

// ------------------------------------------
// лобби отправляет фон — просто ответим 200 (чтобы не было 404)
router.post('/api/link/background', (req, res) => {
  res.json({ ok: true });
});

export default router;

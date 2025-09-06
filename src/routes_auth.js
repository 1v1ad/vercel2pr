// routes_auth.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const router = express.Router();

// ===== helpers =====
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function genState() {
  return b64url(crypto.randomBytes(24));
}
function genPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
function frontUrl() {
  // один источник истины, чтобы не запутаться
  return process.env.FRONT_URL || 'https://sweet-twilight-63a9b6.netlify.app';
}
function backendBase(req) {
  // вычисляем бэкенд-URL в рантайме (Render за прокси)
  const proto = (req.headers['x-forwarded-proto'] || 'https');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
function vkRedirectUri(req) {
  return `${backendBase(req)}/api/auth/vk/callback`;
}

// ===== tiny session (в куках), чтобы /api/me видел провайдера =====
const SESSION_COOKIE = 'gg_session';
function readSession(req) {
  try { return JSON.parse(req.cookies[SESSION_COOKIE] || '{}'); } catch { return {}; }
}
function writeSession(res, obj) {
  res.cookie(SESSION_COOKIE, JSON.stringify(obj), {
    httpOnly: true, sameSite: 'lax', secure: true, path: '/'
  });
}

// ======/api/auth/vk/debug — быстро понять конфиг =====
router.get('/auth/vk/debug', (req, res) => {
  const useSecret = String(process.env.VK_USE_CLIENT_SECRET || '1') === '1';
  const hasId = !!process.env.VK_CLIENT_ID;
  const hasSecret = !!process.env.VK_CLIENT_SECRET;
  res.type('application/json').send({
    client_id_present: hasId,
    has_secret: hasSecret,
    use_secret_mode: useSecret,
    redirect_uri: vkRedirectUri(req),
    pkce_cookie_present: !!req.cookies.vk_pkce_verifier,
    state_cookie_present: !!req.cookies.vk_state
  });
});

// ===== старт =====
router.get('/auth/vk/start', async (req, res) => {
  const state = genState();
  res.cookie('vk_state', state, { httpOnly: true, sameSite: 'lax', secure: true, path: '/' });

  const useSecret = String(process.env.VK_USE_CLIENT_SECRET || '1') === '1';
  const clientId = process.env.VK_CLIENT_ID;
  if (!clientId) return res.status(500).send('VK_CLIENT_ID not set');

  const redirect_uri = vkRedirectUri(req);
  const scope = 'email'; // можно расширить при необходимости
  const v = '5.199';

  if (useSecret) {
    // КЛАССИЧЕСКИЙ VK OAuth (без PKCE)
    const url = new URL('https://oauth.vk.com/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirect_uri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scope);
    url.searchParams.set('state', state);
    url.searchParams.set('v', v);
    return res.redirect(url.toString());
  } else {
    // VK ID + PKCE
    const { verifier, challenge } = genPkce();
    res.cookie('vk_pkce_verifier', verifier, { httpOnly: true, sameSite: 'lax', secure: true, path: '/' });

    const url = new URL('https://id.vk.com/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirect_uri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return res.redirect(url.toString());
  }
});

// ===== коллбэк =====
router.get('/auth/vk/callback', async (req, res) => {
  const { code, state } = req.query || {};
  const savedState = req.cookies.vk_state;

  if (!code) return res.status(400).send('vk: code missing');
  if (!state || !savedState || state !== savedState) return res.status(400).send('vk: state mismatch');

  // очищаем одноразовые куки
  res.clearCookie('vk_state', { path: '/' });

  const useSecret = String(process.env.VK_USE_CLIENT_SECRET || '1') === '1';
  const clientId = process.env.VK_CLIENT_ID;
  const clientSecret = process.env.VK_CLIENT_SECRET;
  const redirect_uri = vkRedirectUri(req);

  try {
    let access_token, user_id;

    if (useSecret) {
      // ======= КЛАССИЧЕСКИЙ ОБМЕН =======
      // GET https://oauth.vk.com/access_token?client_id&client_secret&redirect_uri&code&v
      const tokenURL = 'https://oauth.vk.com/access_token';
      const r = await axios.get(tokenURL, {
        params: { client_id: clientId, client_secret: clientSecret, redirect_uri, code, v: '5.199' },
        timeout: 8000,
      });
      access_token = r.data.access_token;
      user_id = r.data.user_id; // у классического — присылается сразу
      if (!access_token) throw new Error('no access_token from oauth.vk.com');

    } else {
      // ======= VK ID + PKCE =======
      const verifier = req.cookies.vk_pkce_verifier;
      if (!verifier) return res.status(400).send('vk: verifier missing');
      res.clearCookie('vk_pkce_verifier', { path: '/' });

      // POST https://id.vk.com/oauth2/token
      // { grant_type, code, redirect_uri, client_id, code_verifier }
      const r = await axios.post('https://id.vk.com/oauth2/token', {
        grant_type: 'authorization_code',
        code,
        redirect_uri,
        client_id: clientId,
        code_verifier: verifier,
      }, { timeout: 8000 });

      access_token = r.data.access_token;
      if (!access_token) throw new Error('no access_token from id.vk.com');
    }

    // Подтягиваем пользователя (универсально для обеих схем)
    const u = await axios.get('https://api.vk.com/method/users.get', {
      params: {
        access_token,
        v: '5.199',
        fields: 'photo_100,photo_200,screen_name',
      },
      timeout: 8000,
    });

    if (!u.data || !u.data.response || !u.data.response[0]) {
      return res.status(502).send('vk: cannot resolve user id');
    }
    const vkUser = u.data.response[0];

    // Сохраняем «сессию» для /api/me
    const session = readSession(req);
    session.user = {
      id: String(vkUser.id),
      name: `${vkUser.first_name || ''} ${vkUser.last_name || ''}`.trim(),
      avatar: vkUser.photo_200 || vkUser.photo_100 || null,
    };
    session.provider = 'vk';
    writeSession(res, session);

    // Редиректим на фронт
    const to = `${frontUrl()}/lobby.html`;
    return res.redirect(to);

  } catch (e) {
    // Если вдруг стукнулись в неправильный endpoint (например, id.vk.com → 404),
    // попробуем автоматический фолбэк на классический:
    if (!useSecret) {
      try {
        const r2 = await axios.get('https://oauth.vk.com/access_token', {
          params: {
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri,
            code,
            v: '5.199'
          },
          timeout: 8000,
        });
        const access_token = r2.data.access_token;
        const u = await axios.get('https://api.vk.com/method/users.get', {
          params: { access_token, v: '5.199', fields: 'photo_100,photo_200,screen_name' },
          timeout: 8000,
        });
        const vkUser = u.data.response && u.data.response[0];
        if (vkUser) {
          const session = readSession(req);
          session.user = {
            id: String(vkUser.id),
            name: `${vkUser.first_name || ''} ${vkUser.last_name || ''}`.trim(),
            avatar: vkUser.photo_200 || vkUser.photo_100 || null,
          };
          session.provider = 'vk';
          writeSession(res, session);
          return res.redirect(`${frontUrl()}/lobby.html`);
        }
      } catch (_) { /* ignore, упадём ниже с деталями */ }
    }
    const attempts = (e.response && { status: e.response.status, host: e.config && new URL(e.config.url).host }) || null;
    return res.status(502).type('text/plain').send(`vk token error: ${JSON.stringify({ attempts })}`);
  }
});

// ===== /api/me — выдаём текущую «сессию» фронту =====
router.get('/me', (req, res) => {
  const s = readSession(req);
  res.json({ ok: true, user: s.user || null, provider: s.provider || null });
});

module.exports = router;

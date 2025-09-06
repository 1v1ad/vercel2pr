// src/routes_auth.js  (ESM)
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';

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
  return process.env.FRONT_URL || 'https://sweet-twilight-63a9b6.netlify.app';
}
function backendBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
function vkRedirectUri(req) {
  return `${backendBase(req)}/api/auth/vk/callback`;
}

// ===== cookie-based session (host cookies) =====
const SESSION_COOKIE = 'gg_session';
const COOKIE_OPTS = { httpOnly: true, sameSite: 'none', secure: true, path: '/' }; // SameSite=None для cross-site XHR с Netlify

function readSession(req) {
  try { return JSON.parse(req.cookies[SESSION_COOKIE] || '{}'); } catch { return {}; }
}
function writeSession(res, obj) {
  res.cookie(SESSION_COOKIE, JSON.stringify(obj), COOKIE_OPTS);
}

// ======/api/auth/vk/debug =====
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
  res.cookie('vk_state', state, COOKIE_OPTS);

  const useSecret = String(process.env.VK_USE_CLIENT_SECRET || '1') === '1';
  const clientId = process.env.VK_CLIENT_ID;
  if (!clientId) return res.status(500).send('VK_CLIENT_ID not set');

  const redirect_uri = vkRedirectUri(req);
  const scope = 'email';
  const v = '5.199';

  if (useSecret) {
    const url = new URL('https://oauth.vk.com/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirect_uri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scope);
    url.searchParams.set('state', state);
    url.searchParams.set('v', v);
    return res.redirect(url.toString());
  } else {
    const { verifier, challenge } = genPkce();
    res.cookie('vk_pkce_verifier', verifier, COOKIE_OPTS);

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

  res.clearCookie('vk_state', { path: '/' });

  const useSecret = String(process.env.VK_USE_CLIENT_SECRET || '1') === '1';
  const clientId = process.env.VK_CLIENT_ID;
  const clientSecret = process.env.VK_CLIENT_SECRET;
  const redirect_uri = vkRedirectUri(req);

  try {
    let access_token;

    if (useSecret) {
      // classic flow
      const r = await axios.get('https://oauth.vk.com/access_token', {
        params: { client_id: clientId, client_secret: clientSecret, redirect_uri, code, v: '5.199' },
        timeout: 8000,
      });
      access_token = r.data.access_token;
      if (!access_token) throw new Error('no access_token from oauth.vk.com');
    } else {
      // PKCE flow
      const verifier = req.cookies.vk_pkce_verifier;
      if (!verifier) return res.status(400).send('vk: verifier missing');
      res.clearCookie('vk_pkce_verifier', { path: '/' });

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

    // pull user
    const u = await axios.get('https://api.vk.com/method/users.get', {
      params: { access_token, v: '5.199', fields: 'photo_100,photo_200,screen_name' },
      timeout: 8000,
    });
    if (!u.data || !u.data.response || !u.data.response[0]) {
      return res.status(502).send('vk: cannot resolve user id');
    }
    const vkUser = u.data.response[0];

    const session = readSession(req);
    session.user = {
      id: String(vkUser.id),
      name: `${vkUser.first_name || ''} ${vkUser.last_name || ''}`.trim(),
      avatar: vkUser.photo_200 || vkUser.photo_100 || null,
    };
    session.provider = 'vk';
    writeSession(res, session);

    return res.redirect(`${frontUrl()}/lobby.html`);
  } catch (e) {
    // авто-фолбэк на classic, если вдруг стукнулись не туда
    if (!useSecret) {
      try {
        const r2 = await axios.get('https://oauth.vk.com/access_token', {
          params: { client_id: clientId, client_secret: clientSecret, redirect_uri, code, v: '5.199' },
          timeout: 8000,
        });
        const access_token = r2.data.access_token;
        if (access_token) {
          const u2 = await axios.get('https://api.vk.com/method/users.get', {
            params: { access_token, v: '5.199', fields: 'photo_100,photo_200,screen_name' },
            timeout: 8000,
          });
          const vkUser = u2.data.response && u2.data.response[0];
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
        }
      } catch { /* fall through */ }
    }
    const attempts = (e.response && { status: e.response.status, host: e.config && new URL(e.config.url).host }) || null;
    return res.status(502).type('text/plain').send(`vk token error: ${JSON.stringify({ attempts })}`);
  }
});

// ===== current session for front =====
router.get('/me', (req, res) => {
  const s = readSession(req);
  res.json({ ok: true, user: s.user || null, provider: s.provider || null });
});

export default router;

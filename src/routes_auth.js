// src/routes_auth.js
import express from 'express';
import crypto from 'crypto';
import * as cookie from 'cookie';        // надежнее для CJS-пакета
import { makePkcePair } from './pkce.js';
import { signSession } from './jwt.js';
import { upsertUser, logEvent } from './db.js';

/* axios не нужен — используем встроенный fetch */

const router = express.Router();

/** Helpers */
const publicBase = (req) => {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || 'https';
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0];
  return `${proto}://${host}`;
};

const getenv = () => ({
  clientId: process.env.VK_CLIENT_ID || process.env.VK_ID || '',
  clientSecret: process.env.VK_CLIENT_SECRET || process.env.VK_SECRET || '',
  redirectUri: process.env.VK_REDIRECT_URI || process.env.REDIRECT_URI || '',
  frontendUrl: process.env.FRONT_URL || process.env.FRONTEND_URL || '',
});

const COOKIE_SID = 'sid';
const COOKIE_PKCE = 'vk_pkce';
const COOKIE_STATE = 'vk_state';

/** VK: start (дублируем пути под старый/новый фронт) */
router.get(['/vk/start','/api/auth/vk/start'], async (req, res) => {
  const { clientId, redirectUri } = getenv();
  if (!clientId) return res.status(500).send('vk: clientId not set');

  const { verifier, challenge } = makePkcePair();
  const state = crypto.randomBytes(16).toString('hex');

  res.setHeader('Set-Cookie', [
    cookie.serialize(COOKIE_PKCE, verifier, { httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: 600 }),
    cookie.serialize(COOKIE_STATE, state,   { httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: 600 }),
  ]);

  const cb = redirectUri || `${publicBase(req)}/api/auth/vk/callback`;
  const authUrl = new URL('https://id.vk.com/authorize');
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: cb,
    response_type: 'code',
    scope: 'email',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();

  return res.redirect(authUrl.toString());
});

/** VK: callback (дублируем пути под старый/новый фронт) */
router.get(['/vk/callback','/api/auth/vk/callback'], async (req, res) => {
  try {
    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    if (!code) return res.status(400).send('vk: code is empty');

    const parsed = cookie.parse(req.headers.cookie || '');
    const codeVerifier = parsed[COOKIE_PKCE] || '';
    const savedState  = parsed[COOKIE_STATE] || '';
    if (state && savedState && state !== savedState) {
      return res.status(400).send('vk: bad state');
    }

    const redirect_uri = (redirectUri || `${publicBase(req)}/api/auth/vk/callback`);
    const code_verifier = codeVerifier;
    let tokenData = null;

    // Основной путь — VK ID OAuth2 с PKCE
    try {
      const baseParams = {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri,
        code_verifier,
      };
      if (clientSecret) baseParams.client_secret = clientSecret;

      const body = new URLSearchParams(baseParams).toString();
      const resp = await fetch('https://id.vk.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10000),
      });
      tokenData = await resp.json();
    } catch {
      tokenData = null;
    }

    // Фолбэк — старый endpoint
    if (!tokenData?.access_token) {
      const q = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri,
        code,
        v: '5.199',
        grant_type: 'authorization_code',
      }).toString();
      try {
        const resp2 = await fetch('https://oauth.vk.com/access_token?' + q, {
          method: 'GET',
          signal: AbortSignal.timeout(10000),
        });
        tokenData = await resp2.json();
      } catch {}
    }

    const accessToken = tokenData?.access_token || tokenData?.token || tokenData?.accessToken;
    const vkUserId = tokenData?.user_id || tokenData?.userId;
    if (!accessToken || !vkUserId) {
      return res
        .status(502)
        .send('vk token error: ' + JSON.stringify({
          attempts: [{ host: 'id.vk.com', used_secret: !!clientSecret, status: tokenData?.status || 404, body: tokenData?.body || '---' }]
        }));
    }

    // Профиль
    let first_name = '', last_name = '', avatar = '';
    try {
      const profUrl = new URL('https://api.vk.com/method/users.get');
      profUrl.search = new URLSearchParams({ access_token: accessToken, v: '5.199', fields: 'photo_200,first_name,last_name' }).toString();
      const u = await fetch(profUrl.toString(), { signal: AbortSignal.timeout(10000) });
      const data = await u.json();
      const r = data?.response?.[0];
      if (r) { first_name = r.first_name || ''; last_name = r.last_name || ''; avatar = r.photo_200 || ''; }
    } catch {}

    // upsert
    const user = await upsertUser({
      provider: 'vk',
      provider_user_id: String(vkUserId),
      name: [first_name, last_name].filter(Boolean).join(' ') || `id${vkUserId}`,
      avatar,
    });

    // cookie-сессия
    const payload = { id: user.id, provider: 'vk', vk_id: vkUserId };
    const sid = signSession(payload);
    res.cookie('sid', sid, { httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: 60 * 60 * 24 * 30 });

    // лог и редирект
    logEvent(user.id, 'login', { provider: 'vk' }).catch(() => {});
    return res.redirect(frontendUrl || '/lobby.html');
  } catch (e) {
    return res.status(500).send('vk: ' + (e?.message || 'unknown'));
  }
});

export default router;

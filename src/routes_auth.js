// src/routes_auth.js
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

import { createCodeVerifier, createCodeChallenge } from './pkce.js';
import { signSession } from './jwt.js';
import { upsertUser, logEvent, ensureAuthAccount, getUserById } from './db.js';
import { mergeUsers } from './linking.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

function getenv() {
  const env = process.env;
  const clientId     = env.VK_CLIENT_ID;
  const clientSecret = env.VK_CLIENT_SECRET;
  const redirectUri  = env.VK_REDIRECT_URI || env.REDIRECT_URI;
  const frontendUrl  = env.FRONTEND_URL  || env.CLIENT_URL;
  const mode         = (env.VK_AUTH_MODE || 'classic').toLowerCase(); // 'classic' | 'id'
  if (!clientId || !clientSecret || !redirectUri || !frontendUrl) {
    throw new Error('VK env not configured');
  }
  return { clientId, clientSecret, redirectUri, frontendUrl, mode };
}

function firstIp(req) {
  const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return ipHeader.split(',')[0].trim();
}

function mask(t) {
  if (!t || typeof t !== 'string') return '';
  return t.slice(0, 6) + '…' + t.slice(-4);
}

/* ─────────────────────────  VK OAuth start  ───────────────────────── */
router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri, mode } = getenv();

    // пометим выбранный режим в куке на один заход
    res.cookie('vk_mode', mode, { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 10 * 60 * 1000 });

    let url;
    if (mode === 'id') {
      // VK ID (OIDC) + PKCE
      const state         = crypto.randomBytes(16).toString('hex');
      const codeVerifier  = createCodeVerifier();
      const codeChallenge = createCodeChallenge(codeVerifier);

      res.cookie('vk_state', state, {
        httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 10 * 60 * 1000,
      });
      res.cookie('vk_code_verifier', codeVerifier, {
        httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 10 * 60 * 1000,
      });

      await logEvent({
        user_id: null,
        event_type: 'auth_start',
        payload: { provider: 'vk', mode },
        ip: firstIp(req),
        ua: (req.headers['user-agent'] || '').slice(0, 256),
      });

      const u = new URL('https://id.vk.com/authorize');
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      u.searchParams.set('code_challenge', codeChallenge);
      u.searchParams.set('code_challenge_method', 'S256');
      // обязательно openid, чтобы получить id_token
      u.searchParams.set('scope', 'openid vkid.personal_info');
      url = u.toString();
    } else {
      // Классический OAuth
      await logEvent({
        user_id: null,
        event_type: 'auth_start',
        payload: { provider: 'vk', mode },
        ip: firstIp(req),
        ua: (req.headers['user-agent'] || '').slice(0, 256),
      });

      const u = new URL('https://oauth.vk.com/authorize');
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      // оффлайн-токен не обязателен, но пусть будет
      u.searchParams.set('scope', 'offline');
      u.searchParams.set('display', 'page');
      url = u.toString();
    }

    return res.redirect(url);
  } catch (e) {
    console.error('vk/start error:', e?.message || e);
    return res.status(500).send('auth start failed');
  }
});

/* ─────────────────────────  VK OAuth callback  ───────────────────────── */
router.get('/vk/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();
    const mode = (req.cookies['vk_mode'] || process.env.VK_AUTH_MODE || 'classic').toLowerCase();

    // чистка временной куки режима
    res.clearCookie('vk_mode', { path: '/' });

    let tokenData = null;
    let accessToken = null;

    if (mode === 'id') {
      // --- VK ID (OIDC) ---
      const savedState   = req.cookies['vk_state'];
      const codeVerifier = req.cookies['vk_code_verifier'];
      if (!code || !state || !savedState || savedState !== state || !codeVerifier) {
        return res.status(400).send('Invalid state');
      }
      res.clearCookie('vk_state', { path: '/' });
      res.clearCookie('vk_code_verifier', { path: '/' });

      try {
        const resp = await axios.post(
          'https://id.vk.com/oauth2/token',
          new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          }),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, timeout: 15000 }
        );
        tokenData = resp.data || null;
        accessToken = tokenData?.access_token || null;
        console.log('vk/callback (id) token resp:', {
          has_access_token: !!accessToken,
          has_id_token: !!tokenData?.id_token,
          token_type: tokenData?.token_type || null,
          scope: tokenData?.scope || null,
          access_token_masked: mask(accessToken),
          error: tokenData?.error || null,
          error_description: tokenData?.error_description || null,
        });
      } catch (err) {
        console.error('vk/callback (id) token exchange failed:', err?.response?.data || err?.message);
        return res.status(400).send('Token exchange failed');
      }
    } else {
      // --- Классический OAuth ---
      if (!code) return res.status(400).send('code required');
      try {
        const resp = await axios.get('https://oauth.vk.com/access_token', {
          params: {
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code,
          },
          timeout: 15000,
        });
        tokenData = resp.data || null;
        accessToken = tokenData?.access_token || null;
        console.log('vk/callback (classic) token resp:', {
          has_access_token: !!accessToken,
          user_id: tokenData?.user_id || null,
          email: tokenData?.email ? 'yes' : 'no',
          access_token_masked: mask(accessToken),
        });
      } catch (err) {
        console.error('vk/callback (classic) token exchange failed:', err?.response?.data || err?.message);
        return res.status(400).send('Token exchange failed');
      }
    }

    // 2) Достаём user_id
    let vk_id = null;

    if (mode === 'id') {
      vk_id = tokenData?.user_id || tokenData?.user?.id || null;
      if (!vk_id && tokenData?.id_token) {
        try {
          const payload = JSON.parse(Buffer.from(tokenData.id_token.split('.')[1], 'base64url').toString('utf8'));
          if (payload?.sub) vk_id = payload.sub;
        } catch (e) { /* noop */ }
      }
      if (!vk_id && accessToken) {
        try {
          const ui = await axios.get('https://id.vk.com/oauth2/user_info', {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
            timeout: 8000,
          });
          vk_id = ui.data?.sub || ui.data?.user_id || null;
          console.log('vk/callback (id) user_info got:', !!vk_id);
        } catch (e) {
          console.warn('user_info fail:', e?.response?.data || e?.message);
        }
      }
    } else {
      // classic: user_id возвращается прямо в ответе на access_token
      vk_id = tokenData?.user_id || null;
    }

    // 3) Профиль (общий для обоих режимов — если есть access_token)
    let first_name = '', last_name = '', avatar = '';
    let vkIdFromProfile = null;
    if (accessToken) {
      try {
        const prof = await axios.get('https://api.vk.com/method/users.get', {
          params: { access_token: accessToken, v: '5.199', fields: 'photo_200,first_name,last_name' },
          timeout: 10000,
        });
        const r = prof.data?.response?.[0];
        if (r) {
          vkIdFromProfile = r.id || null;
          first_name = r.first_name || '';
          last_name  = r.last_name  || '';
          avatar     = r.photo_200  || '';
        } else if (prof.data?.error) {
          console.warn('users.get error:', prof.data.error);
        }
      } catch (e) {
        console.warn('users.get fail:', e?.response?.data || e?.message);
      }
    }
    if (!vk_id && vkIdFromProfile) vk_id = vkIdFromProfile;

    if (!vk_id) {
      console.error(`vk/callback: no user_id after attempts (mode=${mode})`);
      return res.status(400).send('vk user id missing');
    }
    vk_id = String(vk_id);

    // 4) upsert user + привязка VK
    let user = await upsertUser({ vk_id, first_name, last_name, avatar });
    await ensureAuthAccount({
      user_id: user.id,
      provider: 'vk',
      provider_user_id: vk_id,
      username: null,
      meta: { first_name, last_name, avatar },
    });

    // 5) Автосклейка по старому sid
    const priorSid = req.cookies?.sid;
    if (priorSid) {
      try {
        const payload = jwt.verify(priorSid, JWT_SECRET);
        const priorUid = Number(payload?.uid);
        if (priorUid && priorUid !== user.id) {
          const [a, b] = await Promise.all([getUserById(priorUid), getUserById(user.id)]);
          const [primaryId, mergedId] =
            (new Date(a.created_at) <= new Date(b.created_at)) ? [a.id, b.id] : [b.id, a.id];

          await mergeUsers(primaryId, mergedId, {
            method: 'auto-merge',
            source: `/api/auth/vk/callback(${mode})`,
            ip: firstIp(req),
            ua: (req.headers['user-agent'] || '').slice(0, 256),
          });

          user = await getUserById(primaryId);
        }
      } catch { /* невалидный sid — игнор */ }
    }

    await logEvent({
      user_id: user.id,
      event_type: 'auth_success',
      payload: { provider: 'vk', mode },
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
    });

    // 6) Выдаём сессию
    const sessionJwt = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sessionJwt, {
      httpOnly: true, sameSite: 'none', secure: true, path: '/', maxAge: 30 * 24 * 3600 * 1000,
    });

    const url = new URL(getenv().frontendUrl);
    url.searchParams.set('logged', '1');
    return res.redirect(url.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e?.message || e);
    return res.status(500).send('auth callback failed');
  }
});

export default router;

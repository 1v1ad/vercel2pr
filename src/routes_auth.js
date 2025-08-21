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
  if (!clientId || !clientSecret || !redirectUri || !frontendUrl) {
    throw new Error('VK env not configured');
  }
  return { clientId, clientSecret, redirectUri, frontendUrl };
}

function firstIp(req) {
  const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return ipHeader.split(',')[0].trim();
}

function mask(t) {
  if (!t || typeof t !== 'string') return '';
  return t.slice(0, 6) + '…' + t.slice(-4);
}

/** ─────────────────────────  VK OAuth start  ───────────────────────── */
router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getenv();
    const state         = crypto.randomBytes(16).toString('hex');
    const codeVerifier  = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    // PKCE + CSRF cookies
    res.cookie('vk_state', state,            { httpOnly:true, sameSite:'lax', secure:true, path:'/', maxAge: 10*60*1000 });
    res.cookie('vk_code_verifier', codeVerifier, { httpOnly:true, sameSite:'lax', secure:true, path:'/', maxAge: 10*60*1000 });

    await logEvent({ user_id:null, event_type:'auth_start', payload:{ provider:'vk' }, ip:firstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) });

    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');

    // КЛЮЧЕВАЯ ПРАВКА: добавляем openid, чтобы получить id_token (JWT с sub)
    // personal_info оставляем для имени/аватарки
    u.searchParams.set('scope', 'openid vkid.personal_info');

    return res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e?.message || e);
    return res.status(500).send('auth start failed');
  }
});

/** ─────────────────────────  VK OAuth callback  ───────────────────────── */
router.get('/vk/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const savedState   = req.cookies['vk_state'];
    const codeVerifier = req.cookies['vk_code_verifier'];
    if (!code || !state || !savedState || savedState !== state || !codeVerifier) {
      return res.status(400).send('Invalid state');
    }

    res.clearCookie('vk_state', { path:'/' });
    res.clearCookie('vk_code_verifier', { path:'/' });

    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();

    // 1) Token exchange (PKCE)
    let tokenData = null;
    try {
      const resp = await axios.post(
        'https://id.vk.com/oauth2/auth',
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 12000 }
      );
      tokenData = resp.data || null;
      console.log('vk/callback token resp:', {
        has_access_token: !!tokenData?.access_token,
        has_id_token: !!tokenData?.id_token,
        token_type: tokenData?.token_type || null,
        scope: tokenData?.scope || null,
        access_token_masked: mask(tokenData?.access_token),
      });
    } catch (err) {
      console.error('vk/callback token exchange failed:', err?.response?.data || err?.message);
      return res.status(400).send('Token exchange failed');
    }

    // 2) Пытаемся получить user_id максимально надёжно
    let vk_id = tokenData?.user_id || tokenData?.user?.id || null;

    // 2a) id_token.sub (если запросили scope=openid)
    if (!vk_id && tokenData?.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(tokenData.id_token.split('.')[1], 'base64url').toString('utf8'));
        if (payload?.sub) vk_id = payload.sub;
      } catch (e) {
        console.warn('vk/callback id_token parse fail:', e?.message || e);
      }
    }

    // 2b) OIDC user_info (некоторые конфиги VK отдают sub только здесь)
    if (!vk_id && tokenData?.access_token) {
      try {
        const ui = await axios.get('https://id.vk.com/oauth2/user_info', {
          headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
          timeout: 8000,
        });
        vk_id = ui.data?.sub || ui.data?.user_id || null;
        console.log('vk/callback user_info:', { got: !!vk_id });
      } catch (e) {
        console.warn('vk/callback user_info fail:', e?.response?.data || e?.message);
      }
    }

    // 2c) users.get через VK API (иногда токен подходит и сюда)
    let first_name = '', last_name = '', avatar = '';
    let vkIdFromProfile = null;
    if (tokenData?.access_token) {
      try {
        const prof = await axios.get('https://api.vk.com/method/users.get', {
          params: { access_token: tokenData.access_token, v: '5.199', fields: 'photo_200,first_name,last_name' },
          timeout: 10000,
        });
        const r = prof.data?.response?.[0];
        if (r) {
          vkIdFromProfile = r.id || null;
          first_name = r.first_name || '';
          last_name  = r.last_name  || '';
          avatar     = r.photo_200  || '';
        } else if (prof.data?.error) {
          console.warn('vk users.get error:', prof.data.error);
        }
      } catch (e) {
        console.warn('vk users.get fail:', e?.response?.data || e?.message);
      }
    }
    if (!vk_id && vkIdFromProfile) vk_id = vkIdFromProfile;

    // Если после всех попыток id так и нет — честно фейлим (без создания unknown)
    if (!vk_id) {
      console.error('vk/callback: no user_id after all attempts');
      return res.status(400).send('vk user id missing');
    }
    vk_id = String(vk_id);

    // 3) upsert user + связка VK в auth_accounts
    let user = await upsertUser({ vk_id, first_name, last_name, avatar });
    await ensureAuthAccount({
      user_id: user.id,
      provider: 'vk',
      provider_user_id: vk_id,
      username: null,
      meta: { first_name, last_name, avatar },
    });

    // 4) Автосклейка по имеющемуся sid (тот же браузер)
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
            source: '/api/auth/vk/callback',
            ip: firstIp(req),
            ua: (req.headers['user-agent'] || '').slice(0,256),
          });

          user = await getUserById(primaryId);
        }
      } catch { /* старый sid невалиден — ок */ }
    }

    await logEvent({
      user_id: user.id,
      event_type: 'auth_success',
      payload: { provider: 'vk' },
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0,256),
    });

    // 5) Выдаём новую сессию sid
    const sessionJwt = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sessionJwt, { httpOnly:true, sameSite:'none', secure:true, path:'/', maxAge: 30*24*3600*1000 });

    const url = new URL(frontendUrl);
    url.searchParams.set('logged', '1');
    return res.redirect(url.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e?.message || e);
    return res.status(500).send('auth callback failed');
  }
});

export default router;

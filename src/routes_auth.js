import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createCodeVerifier, createCodeChallenge } from './pkce.js';
import { signSession } from './jwt.js';
import { upsertUser, logEvent } from './db.js';

const router = express.Router();

/** --- utils --- */
function getenv() {
  const env = process.env;
  const clientId     = env.VK_CLIENT_ID;
  const clientSecret = env.VK_CLIENT_SECRET;
  const redirectUri  = env.VK_REDIRECT_URI || env.REDIRECT_URI;
  const frontendUrl  = env.FRONTEND_URL  || env.CLIENT_URL;

  for (const [k, v] of Object.entries({
    VK_CLIENT_ID: clientId,
    VK_CLIENT_SECRET: clientSecret,
    VK_REDIRECT_URI: redirectUri,
    FRONTEND_URL: frontendUrl,
  })) {
    if (!v) throw new Error(`Missing env ${k}`);
  }
  return { clientId, clientSecret, redirectUri, frontendUrl };
}

function firstIp(req) {
  const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return ipHeader.split(',')[0].trim();
}

/** --- VK: start --- */
router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getenv();

    const state         = crypto.randomBytes(16).toString('hex');
    const codeVerifier  = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    // сохраняем state и PKCE в httpOnly-куках (живут 10 минут)
    res.cookie('vk_state', state,               { httpOnly:true, sameSite:'lax',  secure:true, path:'/', maxAge: 10*60*1000 });
    res.cookie('vk_code_verifier', codeVerifier,{ httpOnly:true, sameSite:'lax',  secure:true, path:'/', maxAge: 10*60*1000 });

    await logEvent({
      user_id: null, event_type: 'auth_start', payload: null,
      ip: firstIp(req), ua: (req.headers['user-agent']||'').slice(0,256)
    });

    // VK ID authorize
    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id',     clientId);
    u.searchParams.set('redirect_uri',  redirectUri);
    u.searchParams.set('state',         state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    // OIDC-скоупы: openid обязателен, email по желанию, vkid.personal_info — имя/аватар
    u.searchParams.set('scope', 'openid email vkid.personal_info');

    return res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e?.response?.data || e?.message);
    return res.status(500).send('auth start failed');
  }
});

/** --- VK: callback --- */
router.get('/vk/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const savedState   = req.cookies['vk_state'];
    const codeVerifier = req.cookies['vk_code_verifier'];

    // базовая защита от CSRF + проверка PKCE
    if (!code || !state || !savedState || savedState !== state || !codeVerifier) {
      console.warn('[VK CALLBACK] invalid state check', {
        hasCode: !!code, hasState: !!state, savedState: !!savedState, cookieVerifier: !!codeVerifier
      });
      return res.status(400).send('Invalid state');
    }

    // подчистим одноразовые куки
    res.clearCookie('vk_state',         { path:'/' });
    res.clearCookie('vk_code_verifier', { path:'/' });

    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();

    // 1) обмениваем code -> token на правильном endpoint
    let tokenData;
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }).toString();

      const resp = await axios.post(
        'https://id.vk.com/oauth2/token',
        body,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
      );
      tokenData = resp.data;
    } catch (err) {
      console.error('[VK CALLBACK] token exchange fail:', err?.response?.status, err?.response?.data || err?.message);
      return res.status(500).send('auth callback failed');
    }

    const accessToken = tokenData?.access_token;
    if (!accessToken) {
      console.error('[VK CALLBACK] no access_token in tokenData:', tokenData);
      return res.status(500).send('auth callback failed');
    }

    // 2) userinfo по OIDC (VK ID)
    let first_name = '', last_name = '', avatar = '', vk_id = '';
    try {
      const ui = await axios.get('https://id.vk.com/oauth2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000
      });
      const u = ui.data || {};
      // поля обычно: sub, name, given_name, family_name, picture, email, ...
      vk_id      = String(u.sub || '');
      first_name = u.given_name || '';
      last_name  = u.family_name || '';
      avatar     = u.picture || '';
      // если only "name", распилим
      if (!first_name && u.name) {
        const parts = String(u.name).split(' ');
        first_name = parts[0] || '';
        last_name  = parts.slice(1).join(' ') || '';
      }
    } catch (err) {
      console.warn('[VK CALLBACK] userinfo fail, will try minimal user_id from token:', err?.response?.data || err?.message);
      vk_id = String(tokenData?.user_id || tokenData?.user?.id || '');
    }

    if (!vk_id) {
      console.error('[VK CALLBACK] cannot resolve vk_id');
      return res.status(500).send('auth callback failed');
    }

    const user = await upsertUser({ vk_id, first_name, last_name, avatar });
    await logEvent({
      user_id: user.id, event_type: 'auth_success', payload: { vk_id },
      ip: firstIp(req), ua: (req.headers['user-agent']||'').slice(0,256)
    });

    // 3) сессия
    const sessionJwt = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sessionJwt, {
      httpOnly: true,
      sameSite: 'none', // чтобы фронт на другом домене увидел cookie
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000
    });

    // 4) редирект на фронт
    const url = new URL(frontendUrl);
    url.searchParams.set('logged', '1');
    url.searchParams.set('provider', 'vk');
    return res.redirect(url.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e?.message);
    return res.status(500).send('auth callback failed');
  }
});

export default router;

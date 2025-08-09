// src/routes_auth.js
import express from 'express';
import axios from 'axios';
import { createCodeVerifier, createCodeChallenge } from './pkce.js';
import { signSession } from './jwt.js';
import { upsertUser } from './db.js';

const router = express.Router();

// Helpers
function setTempCookie(res, name, value) {
  res.cookie(name, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: 10 * 60 * 1000 // 10 min
  });
}

function clearTempCookie(res, name) {
  res.clearCookie(name, { path: '/' });
}

function getEnv() {
  const required = ['VK_CLIENT_ID','VK_CLIENT_SECRET','VK_REDIRECT_URI','FRONTEND_URL'];
  for (const k of required) {
    if (!process.env[k]) {
      throw new Error(`Missing env ${k}`);
    }
  }
  return {
    clientId: process.env.VK_CLIENT_ID,
    clientSecret: process.env.VK_CLIENT_SECRET,
    redirectUri: process.env.VK_REDIRECT_URI,
    frontendUrl: process.env.FRONTEND_URL
  }
}

// 1) Start: set state + PKCE, redirect to VK ID
router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getEnv();
    const state = cryptoRandom();
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    setTempCookie(res, 'vk_state', state);
    setTempCookie(res, 'vk_code_verifier', codeVerifier);

    const authorizeUrl = new URL('https://id.vk.com/authorize');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    // Minimal scope to identify user
    authorizeUrl.searchParams.set('scope', 'vkid.personal_info');

    return res.redirect(authorizeUrl.toString());
  } catch (e) {
    console.error('vk/start error', e);
    res.status(500).send('auth start failed');
  }
});

// 2) Callback: exchange code -> tokens, fetch user, issue our JWT and bounce to frontend
router.get('/vk/callback', async (req, res) => {
  const { code, state, device_id } = req.query;
  if (!code || !state) return res.status(400).send('Bad callback');
  try {
    const savedState = req.cookies['vk_state'];
    const codeVerifier = req.cookies['vk_code_verifier'];
    if (!savedState || !codeVerifier || savedState !== state) {
      console.warn('state or verifier missing/invalid', { savedState, state, hasVerifier: !!codeVerifier });
      return res.status(400).send('Invalid state');
    }

    clearTempCookie(res, 'vk_state');
    clearTempCookie(res, 'vk_code_verifier');

    const { clientId, clientSecret, redirectUri, frontendUrl } = getEnv();

    // --- Try VK ID token endpoint first ---
    let tokenData = null;
    try {
      const tokenResp = await axios.post('https://id.vk.com/oauth2/auth', new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        device_id: device_id || ''
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      });
      tokenData = tokenResp.data;
    } catch (err) {
      console.warn('id.vk.com token exchange failed, fallback to oauth.vk.com', err?.response?.data || err?.message);
      // --- Fallback to legacy endpoint ---
      const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
        params: {
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code: code,
          code_verifier: codeVerifier,
          device_id: device_id || ''
        },
        timeout: 10000
      });
      tokenData = tokenResp.data;
    }

    // tokenData may include: access_token, refresh_token, user_id, expires_in, id_token?
    const accessToken = tokenData.access_token;
    const vkUserId = tokenData.user_id; // might be undefined for VK ID

    // Fetch user profile
    let user = null;
    let first_name = '';
    let last_name = '';
    let avatar = '';

    try {
      const u = await axios.get('https://api.vk.com/method/users.get', {
        params: {
          access_token: accessToken,
          v: '5.199',
          fields: 'photo_200,first_name,last_name'
        },
        timeout: 10000
      });
      const resp = u.data;
      if (resp && resp.response && resp.response[0]) {
        const r = resp.response[0];
        first_name = r.first_name || '';
        last_name  = r.last_name || '';
        avatar     = r.photo_200 || '';
      }
    } catch (e) {
      console.warn('users.get failed', e?.response?.data || e?.message);
    }

    const vk_id = vkUserId ? String(vkUserId) : (tokenData?.user?.id ? String(tokenData.user.id) : null);
    if (!vk_id) {
      // As a last resort, don't block login, but mark unknown
      console.warn('No vk_id in token/userinfo. Proceeding with stub id.');
    }

    user = await upsertUser({
      vk_id: vk_id || 'unknown',
      first_name,
      last_name,
      avatar
    });

    // Issue our session cookie
    const sessionJwt = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sessionJwt, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000
    });

    // Redirect back to frontend
    const url = new URL(frontendUrl);
    url.searchParams.set('logged', '1');
    return res.redirect(url.toString());
  } catch (e) {
    console.error('vk/callback error', e?.response?.data || e?.message);
    res.status(500).send('auth callback failed');
  }
});

// utils
function cryptoRandom() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');
}

// Since Node doesn't have getRandomValues, polyfill using crypto.randomBytes
import crypto from 'crypto';
globalThis.crypto = globalThis.crypto || {
  getRandomValues: (arr) => {
    const buf = crypto.randomBytes(arr.length);
    arr.set(buf);
    return arr;
  }
};

export default router;

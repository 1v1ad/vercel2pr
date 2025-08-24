import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createCodeVerifier, createCodeChallenge } from './pkce.js';
import { signSession } from './jwt.js';
import { upsertUser, logEvent } from './db.js';

const router = express.Router();

function getenv() {
  const env = process.env;

  const clientId     = env.VK_CLIENT_ID;
  const clientSecret = env.VK_CLIENT_SECRET; // may be optional for PKCE, but we support both
  const redirectUri  = env.VK_REDIRECT_URI || env.REDIRECT_URI;
  const frontendUrl  = env.FRONTEND_URL || env.CLIENT_URL;

  for (const [k, v] of Object.entries({
    VK_CLIENT_ID: clientId,
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

function shortUa(req) {
  return (req.headers['user-agent'] || '').toString().slice(0, 256);
}

// ===== VK ID OAuth =====

router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getenv();

    const state         = crypto.randomBytes(16).toString('hex');
    const codeVerifier  = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    // 10 minutes should be enough for the whole auth flow
    const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 10 * 60 * 1000 };
    res.cookie('vk_state', state, cookieOpts);
    res.cookie('vk_code_verifier', codeVerifier, cookieOpts);

    await logEvent({ user_id: null, event_type: 'auth_start', payload: null, ip: firstIp(req), ua: shortUa(req) });

    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('scope', 'vkid.personal_info');

    // Optional: you can pass device_id to authorize (not required for token exchange)
    const deviceId = req.headers['x-device-id'];
    if (typeof deviceId === 'string' && deviceId.length <= 128) {
      u.searchParams.set('device_id', deviceId);
    }

    return res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e?.message || e);
    return res.status(500).send('auth start failed');
  }
});

router.get('/vk/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const savedState   = req.cookies?.vk_state;
    const codeVerifier = req.cookies?.vk_code_verifier;

    const echo = {
      hasCode: !!code,
      hasState: !!state,
      savedState: !!savedState,
      cookieState: savedState === state,
      codeVerifier: !!codeVerifier,
    };
    console.log('[VK CALLBACK] state check:', echo);

    if (!code || !state || !savedState || savedState !== state || !codeVerifier) {
      return res.status(400).send('Invalid state');
    }

    // Clear one-time cookies
    res.clearCookie('vk_state', { path: '/' });
    res.clearCookie('vk_code_verifier', { path: '/' });

    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();

    // --- 1) Try VK ID token endpoint (PKCE) ---
    let tokenData = null;
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        client_id: String(clientId),
        redirect_uri: String(redirectUri),
        code_verifier: String(codeVerifier),
      });
      if (clientSecret) body.set('client_secret', String(clientSecret)); // tolerated by some providers

      const resp = await axios.post('https://id.vk.com/oauth2/token', body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
        validateStatus: () => true, // let us inspect non-2xx
      });

      if (resp.status >= 200 && resp.status < 300) {
        tokenData = resp.data;
      } else {
        console.warn('[VK CALLBACK] VK ID token non-2xx:', resp.status, resp.data);
      }
    } catch (err) {
      console.warn('[VK CALLBACK] VK ID token exception:', err?.message);
    }

    // --- 2) Fallback to legacy oauth.vk.com/access_token (NO device_id, NO PKCE) ---
    if (!tokenData?.access_token) {
      try {
        const resp = await axios.get('https://oauth.vk.com/access_token', {
          params: {
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code,
          },
          timeout: 10000,
          validateStatus: () => true,
        });
        if (resp.status >= 200 && resp.status < 300) {
          tokenData = resp.data;
        } else {
          console.error('[VK CALLBACK] oauth.vk.com access_token fail:', resp.status, resp.data);
        }
      } catch (err) {
        console.error('[VK CALLBACK] oauth.vk.com token exception:', err?.message);
      }
    }

    const accessToken = tokenData?.access_token;
    if (!accessToken) {
      console.error('[VK CALLBACK] no access_token:', tokenData);
      return res.status(500).send('auth callback failed');
    }

    // --- profile fetch (best-effort) ---
    let first_name = '', last_name = '', avatar = '';
    try {
      const u = await axios.get('https://api.vk.com/method/users.get', {
        params: { access_token: accessToken, v: '5.199', fields: 'photo_200,first_name,last_name' },
        timeout: 10000,
      });
      const r = u.data?.response?.[0];
      if (r) {
        first_name = r.first_name || '';
        last_name = r.last_name || '';
        avatar = r.photo_200 || '';
      }
    } catch {}

    const vk_id = String(tokenData?.user_id || tokenData?.user?.id || 'unknown');
    const user = await upsertUser({ vk_id, first_name, last_name, avatar });

    await logEvent({
      user_id: user.id,
      event_type: 'auth_success',
      payload: { vk_id },
      ip: firstIp(req),
      ua: shortUa(req),
    });

    const sessionJwt = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sessionJwt, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000,
    });

    const url = new URL(frontendUrl);
    url.searchParams.set('logged', '1');
    return res.redirect(url.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e?.message || e);
    return res.status(500).send('auth callback failed');
  }
});

export default router;

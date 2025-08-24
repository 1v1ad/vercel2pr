// src/routes_auth.js
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createCodeVerifier, createCodeChallenge } from './pkce.js';
import { signSession } from './jwt.js';

const router = express.Router();

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

// Temporary env probe route (you can remove)
router.get('/env-check', (req, res) => {
  res.json({
    jwtSet: !!(process.env.JWT_SECRET && process.env.JWT_SECRET.trim()),
    vkClientId: !!process.env.VK_CLIENT_ID,
    vkSecret: !!process.env.VK_CLIENT_SECRET,
    vkRedirect: !!process.env.VK_REDIRECT_URI,
  });
});

router.get('/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getenv();
    const state         = crypto.randomBytes(16).toString('hex');
    const codeVerifier  = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    // 10 minutes
    const cookieOpts = { httpOnly:true, sameSite:'lax', secure:true, path:'/', maxAge: 10*60*1000 };
    res.cookie('vk_state', state, cookieOpts);
    res.cookie('vk_code_verifier', codeVerifier, cookieOpts);

    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    // минимальные данные для входа
    u.searchParams.set('scope', 'email');

    console.log('[VK START] redirect to:', u.toString());
    return res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e.message);
    return res.status(500).send('auth start failed');
  }
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query || {};
  try {
    const savedState   = req.cookies['vk_state'];
    const codeVerifier = req.cookies['vk_code_verifier'];
    const hasState = !!state;
    const hasCode = !!code;
    const cookieState = !!savedState;
    const cookieVerifier = !!codeVerifier;

    // Debug line (safe flags, not values)
    console.log('[VK CALLBACK] state check:', {
      hasCode, hasState, cookieState, cookieVerifier
    });

    if (!hasCode || !hasState || !cookieState || !cookieVerifier || savedState !== state) {
      return res.status(400).send('Invalid state');
    }

    // clear temp cookies
    res.clearCookie('vk_state', { path:'/' });
    res.clearCookie('vk_code_verifier', { path:'/' });

    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();

    // 1) Try legacy oauth endpoint (usually works)
    let tokenData = null;
    try {
      const resp = await axios.get('https://oauth.vk.com/access_token', {
        params: {
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code: code,
        },
        timeout: 12000
      });
      tokenData = resp.data;
    } catch (err) {
      console.warn('[VK CALLBACK] oauth.vk.com access_token fail:', err?.response?.status, err?.response?.data);
    }

    // 2) Fallback VK ID oauth2 (with PKCE)
    if (!tokenData?.access_token) {
      try {
        const form = new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(code),
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code_verifier: String(codeVerifier),
        }).toString();
        const resp = await axios.post('https://id.vk.com/oauth2/auth', form, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 12000
        });
        tokenData = resp.data;
      } catch (err) {
        console.error('[VK CALLBACK] id.vk.com token fail:', err?.response?.status, err?.response?.data);
      }
    }

    const accessToken = tokenData?.access_token;
    const vkUserId = String(tokenData?.user_id || tokenData?.user?.id || '');

    if (!accessToken) {
      console.error('[VK CALLBACK] no access_token:', tokenData);
      return res.status(500).send('auth callback failed');
    }

    // fetch profile
    let first_name = '', last_name = '', avatar = '';
    try {
      const u = await axios.get('https://api.vk.com/method/users.get', {
        params: { access_token: accessToken, v: '5.199', fields: 'photo_200,first_name,last_name' },
        timeout: 10000
      });
      const r = u.data?.response?.[0];
      if (r) { first_name = r.first_name || ''; last_name = r.last_name || ''; avatar = r.photo_200 || ''; }
    } catch (e) {
      console.warn('[VK CALLBACK] users.get failed:', e?.response?.data || e.message);
    }

    // issue session cookie
    const sessionJwt = signSession({ uid: vkUserId || 'vk', vk_id: vkUserId, first_name, last_name });
    res.cookie('sid', sessionJwt, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000
    });

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

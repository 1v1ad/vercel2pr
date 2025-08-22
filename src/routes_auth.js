import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createCodeVerifier, createCodeChallenge } from './pkce.js';
import { signSession } from './jwt.js';
import { upsertAndLink, logEvent } from './db.js';

const router = express.Router();

function getenv() {
  const env = process.env;
  return {
    clientId: env.VK_CLIENT_ID,
    clientSecret: env.VK_CLIENT_SECRET,
    redirectUri: env.VK_REDIRECT_URI || env.REDIRECT_URI,
    frontendUrl: env.FRONTEND_URL || env.CLIENT_URL,
  };
}

function getFirstIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
}

// ───────────────  GET /api/auth/vk/start  ───────────────
router.get('/vk/start', async (req, res) => {
  const { clientId, redirectUri } = getenv();
  if (!clientId || !redirectUri) return res.status(500).send('VK client not configured');

  try {
    const did = (req.query.did || '').toString().slice(0, 200) || null;

    const csrf = crypto.randomBytes(16).toString('hex');
    const codeVerifier  = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    // Small, cookie-backed state; all data live in cookies
    const state = csrf;

    const cookieOpts = { httpOnly: true, sameSite: 'none', secure: true, path: '/', maxAge: 10 * 60 * 1000 };
    res.cookie('vk_state', csrf, cookieOpts);
    res.cookie('vk_code_verifier', codeVerifier, cookieOpts);
    if (did) res.cookie('vk_did', did, cookieOpts);

    await logEvent({ user_id:null, event_type:'auth_start', payload:{ provider:'vk' }, ip:getFirstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) });

    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('scope', 'email,phone');

    return res.redirect(302, u.toString());
  } catch (e) {
    console.error('vk/start error:', e?.response?.data || e?.message);
    return res.status(500).send('auth start failed');
  }
});

// ───────────────  GET /api/auth/vk/callback  ───────────────
router.get('/vk/callback', async (req, res) => {
  const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('missing code/state');

    const csrfFromCookie = req.cookies?.vk_state || null;
    if (!csrfFromCookie || state !== csrfFromCookie) {
      return res.status(400).send('invalid state');
    }

    const codeVerifier = req.cookies?.vk_code_verifier || null;
    if (!codeVerifier) return res.status(400).send('missing code_verifier');

    const deviceIdFromCookie = req.cookies?.vk_did || null;

    const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
      params: {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
        code_verifier: codeVerifier,
        device_id: deviceIdFromCookie || 'web',
      },
      timeout: 15000,
    });
    const token = tokenResp.data;
    const vkUserId = token.user_id;

    const apiResp = await axios.get('https://api.vk.com/method/users.get', {
      params: {
        user_ids: vkUserId,
        fields: 'screen_name,photo_200,first_name,last_name',
        v: '5.199',
        access_token: token.access_token,
      },
      timeout: 10000,
    });
    const profile = apiResp.data?.response?.[0] || {};

    const phone_hash = token.phone ? token.phone : null;
    const device_id = deviceIdFromCookie;

    const user = await upsertAndLink({
      provider: 'vk',
      provider_user_id: vkUserId,
      username: profile?.screen_name || null,
      first_name: profile?.first_name || null,
      last_name: profile?.last_name || null,
      avatar_url: profile?.photo_200 || null,
      phone_hash,
      device_id,
    });

    await logEvent({ user_id:user?.id, event_type:'auth_ok', payload:{ provider:'vk' }, ip:getFirstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) });

    const session = signSession({ uid: user.id, prov: 'vk' });
    res.cookie('sid', session, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000,
    });

    const url = new URL(frontendUrl);
    url.searchParams.set('logged', '1');
    return res.redirect(url.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e?.message);
    return res.status(500).send('auth callback failed');
  }
});

export default router;
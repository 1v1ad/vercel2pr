import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
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
    deviceHeader: env.DEVICE_ID_HEADER || 'x-device-id',
    jwtSecret: env.JWT_SECRET || 'dev_secret_change_me',
  };
}

function getFirstIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
}

function signState(payload, secret) {
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: '10m' });
}
function verifyState(token, secret) {
  try { return jwt.verify(token, secret, { algorithms: ['HS256'] }); } catch { return null; }
}

/* ───────────────  GET /api/auth/vk/start  ─────────────── */
router.get('/vk/start', async (req, res) => {
  const { clientId, redirectUri, frontendUrl, jwtSecret } = getenv();
  if (!clientId || !redirectUri) return res.status(500).send('VK client not configured');

  try {
    const did = (req.query.did || '').toString().slice(0, 200) || null;

    const csrf = crypto.randomBytes(16).toString('hex');
    const state = signState({ csrf, did }, jwtSecret);

    const codeVerifier  = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    res.cookie('vk_state', csrf,                 { httpOnly:true, sameSite:'lax', secure:true, path:'/', maxAge: 10*60*1000 });
    res.cookie('vk_code_verifier', codeVerifier, { httpOnly:true, sameSite:'lax', secure:true, path:'/', maxAge: 10*60*1000 });

    await logEvent({ user_id:null, event_type:'auth_start', payload:{ provider:'vk' }, ip:getFirstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) });

    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('scope', 'email,phone'); // если будет одобрено

    return res.redirect(302, u.toString());
  } catch (e) {
    console.error('vk/start error:', e?.response?.data || e?.message);
    return res.status(500).send('auth start failed');
  }
});

/* ───────────────  GET /api/auth/vk/callback  ─────────────── */
router.get('/vk/callback', async (req, res) => {
  const { clientId, clientSecret, redirectUri, frontendUrl, deviceHeader, jwtSecret } = getenv();
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('missing code/state');

    const parsed = verifyState(String(state), jwtSecret);
    const csrfFromCookie = req.cookies?.vk_state || null;
    if (!parsed || !csrfFromCookie || parsed.csrf !== csrfFromCookie) {
      return res.status(400).send('invalid state');
    }
    const deviceIdFromState = parsed.did || null;

    const codeVerifier = req.cookies?.vk_code_verifier || null;
    if (!codeVerifier) return res.status(400).send('missing code_verifier');

    const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
      params: {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
        code_verifier: codeVerifier,
        device_id: deviceIdFromState || 'web',
      },
      timeout: 10000,
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

    const phone_hash = token.phone ? token.phone : null; // редко в вебе
    const device_id = deviceIdFromState;

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

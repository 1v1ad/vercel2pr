import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
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
    const state = csrf;

    const cookieOpts = { httpOnly: true, sameSite: 'none', secure: true, path: '/', maxAge: 10 * 60 * 1000 };
    res.cookie('vk_state', csrf, cookieOpts);
    if (did) res.cookie('vk_did', did, cookieOpts);

    await logEvent({ user_id:null, event_type:'auth_start', payload:{ provider:'vk' }, ip:getFirstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) });

    // classic oauth.vk.com flow (no PKCE)
    const u = new URL('https://oauth.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', 'email,phone');
    u.searchParams.set('v', '5.199');
    u.searchParams.set('state', state);

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

    const deviceIdFromCookie = req.cookies?.vk_did || null;

    const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
      params: {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
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

    res.cookie('sid', (await import('jsonwebtoken')).default.sign({ uid: user.id, prov: 'vk' }, process.env.JWT_SECRET || 'dev_secret_change_me', { algorithm: 'HS256', expiresIn: '30d' }), {
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
    const msg = e?.response?.data ? JSON.stringify(e.response.data) : (e?.message || 'unknown');
    console.error('vk/callback error:', msg);
    return res.status(500).send('auth callback failed: ' + msg);
  }
});

export default router;
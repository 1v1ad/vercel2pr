import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { upsertAndLink, logEvent } from './db.js';
import { signSession } from './jwt.js';

const router = express.Router();

const useVKID = (process.env.VK_FLOW || 'vkid').toLowerCase() !== 'legacy';

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
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

// ───────────────  GET /api/auth/vk/start  ───────────────
router.get('/vk/start', async (req, res) => {
  const { clientId, redirectUri } = getenv();
  if (!clientId || !redirectUri) return res.status(500).send('VK client not configured');
  const did = (req.query.did || '').toString().slice(0, 200) || null;

  const cookieOpts = { httpOnly: true, sameSite: 'none', secure: true, path: '/', maxAge: 10 * 60 * 1000 };
  try {
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('vk_state', state, cookieOpts);
    if (did) res.cookie('vk_did', did, cookieOpts);

    await logEvent({ user_id:null, event_type:'auth_start', payload:{ provider:'vk', flow: useVKID ? 'vkid' : 'legacy' }, ip:getFirstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) });

    if (useVKID) {
      // PKCE
      const verifier = base64url(crypto.randomBytes(32));
      const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
      res.cookie('vk_code_verifier', verifier, cookieOpts);

      const u = new URL('https://id.vk.com/authorize');
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('scope', 'openid',);
      // Для userinfo лучше запросить базовые профайл-поля (VK ID сам выдаёт через /userinfo)
      u.searchParams.set('code_challenge', challenge);
      u.searchParams.set('code_challenge_method', 'S256');
      u.searchParams.set('state', state);
      return res.redirect(302, u.toString());
    } else {
      const u = new URL('https://oauth.vk.com/authorize');
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('scope', 'email,phone');
      u.searchParams.set('v', '5.199');
      u.searchParams.set('state', state);
      return res.redirect(302, u.toString());
    }
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

    const csrf = req.cookies?.vk_state || null;
    if (!csrf || csrf !== state) return res.status(400).send('invalid state token');

    const did = req.cookies?.vk_did || null;

    let profile = null;
    let provider_user_id = null;

    if (useVKID) {
      const verifier = req.cookies?.vk_code_verifier || '';
      const form = new URLSearchParams();
      form.set('grant_type', 'authorization_code');
      form.set('code', String(code));
      form.set('client_id', clientId);
      if (clientSecret) form.set('client_secret', clientSecret);
      form.set('redirect_uri', redirectUri);
      if (verifier) form.set('code_verifier', verifier);

      const tokenResp = await axios.post('https://id.vk.com/oauth2/token', form, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      });
      const token = tokenResp.data;

      const uiResp = await axios.get('https://id.vk.com/oauth2/userinfo', {
        headers: { Authorization: `Bearer ${token.access_token}` },
        timeout: 10000,
      });
      const ui = uiResp.data || {};
      provider_user_id = ui.sub || ui.user_id || null;
      profile = {
        first_name: ui.given_name || null,
        last_name: ui.family_name || null,
        avatar_url: ui.picture || null,
        username: ui.preferred_username || null,
        phone: ui.phone_number || null,
      };
    } else {
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
      const p = apiResp.data?.response?.[0] || {};
      provider_user_id = vkUserId;
      profile = {
        first_name: p?.first_name || null,
        last_name: p?.last_name || null,
        avatar_url: p?.photo_200 || null,
        username: p?.screen_name || null,
        phone: token.phone || null,
      };
    }

    if (!provider_user_id) throw new Error('no provider user id');

    const user = await upsertAndLink({
      provider: 'vk',
      provider_user_id,
      username: profile.username || null,
      first_name: profile.first_name || null,
      last_name: profile.last_name || null,
      avatar_url: profile.avatar_url || null,
      phone_hash: profile.phone || null,
      device_id: did || null,
    });

    await logEvent({ user_id:user?.id, event_type:'auth_ok', payload:{ provider:'vk', flow: useVKID ? 'vkid' : 'legacy' }, ip:getFirstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) });

    res.cookie('sid', signSession({ uid: user.id, prov: 'vk' }), {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000,
    });

    const url = new URL(frontendUrl);
    url.searchParams.set('logged', '1');
    url.searchParams.set('provider', 'vk');
    return res.redirect(url.toString());
  } catch (e) {
    const msg = e?.response?.data ? JSON.stringify(e.response.data) : (e?.message || 'unknown');
    console.error('vk/callback error:', msg);
    return res.status(500).send('auth callback failed: ' + msg);
  }
});

export default router;
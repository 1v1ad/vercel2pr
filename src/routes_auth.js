// src/routes_auth.js
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createCodeVerifier, createCodeChallenge } from './pkce.js';
import { signSession } from './jwt.js';
import { upsertUser, logEvent } from './db.js';

const router = express.Router();

/** ===== helpers ===== */
function getenv() {
  const env = process.env;
  const clientId     = env.VK_CLIENT_ID;
  const clientSecret = env.VK_CLIENT_SECRET; // для public клиента можно без него, но оставим — не мешает
  const redirectUri  = env.VK_REDIRECT_URI || env.REDIRECT_URI;
  const frontendUrl  = env.FRONTEND_URL   || env.CLIENT_URL;

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

const b64url = {
  encode(obj) {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    return Buffer.from(s).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  },
  decode(str) {
    const pad = 4 - (str.length % 4 || 4);
    const b64 = (str + '='.repeat(pad)).replace(/-/g,'+').replace(/_/g,'/');
    return Buffer.from(b64, 'base64').toString('utf8');
  }
};

// простая защита от повторного использования state (живёт в памяти процесса)
const usedNonces = new Set();
function markOnce(nonce) {
  usedNonces.add(nonce);
  setTimeout(() => usedNonces.delete(nonce), 10 * 60 * 1000); // 10 минут
}

/** ===== VK ID: старт (PKCE) ===== */
router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getenv();

    const codeVerifier  = createCodeVerifier();           // 43–128 символов
    const codeChallenge = createCodeChallenge(codeVerifier);
    const nonce = crypto.randomBytes(12).toString('hex'); // короткий id для анти-replay

    // Кладём verifier внутрь state (PKCE это допускает)
    const statePayload = { n: nonce, v: codeVerifier, t: Date.now() };
    const state = b64url.encode(statePayload);

    await logEvent({
      user_id: null,
      event_type: 'auth_start',
      payload: { provider: 'vk', stateLen: state.length },
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
    // минимально достаточно personal_info (у вас в скринах встречалось email/phone — можно добавить при необходимости)
    u.searchParams.set('scope', 'vkid.personal_info');

    return res.redirect(u.toString());
  } catch (e) {
    console.error('VK START error:', e);
    return res.status(500).send('auth start failed');
  }
});

/** ===== VK ID: callback ===== */
router.get('/vk/callback', async (req, res) => {
  const { code, state } = req.query || {};
  const ip = firstIp(req);
  const ua = (req.headers['user-agent'] || '').slice(0, 256);

  try {
    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();

    const hasCode  = typeof code === 'string' && code.length > 0;
    const hasState = typeof state === 'string' && state.length > 0;

    let parsed = null;
    if (hasState) {
      try {
        parsed = JSON.parse(b64url.decode(String(state)));
      } catch {}
    }

    const info = {
      hasCode,
      hasState,
      stateParsed: !!parsed,
      nonce: parsed?.n || null
    };
    console.log('[VK CALLBACK] state check:', info);

    if (!hasCode || !parsed?.v || !parsed?.n) {
      await logEvent({ user_id: null, event_type: 'auth_fail_state', payload: info, ip, ua });
      return res.status(400).send('Invalid state');
    }
    if (usedNonces.has(parsed.n)) {
      await logEvent({ user_id: null, event_type: 'auth_replay_blocked', payload: { nonce: parsed.n }, ip, ua });
      return res.status(400).send('Invalid state'); // повторный клик по "Разрешить"
    }
    markOnce(parsed.n);

    // 1) основная попытка — VK ID PKCE
    let tokenData = null;
    try {
      const tokenResp = await axios.post(
        'https://id.vk.com/oauth2/token',
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(code),
          client_id: clientId,
          redirect_uri: redirectUri,
          code_verifier: parsed.v,
          // client_secret при PKCE опционален, но пускай будет:
          client_secret: clientSecret,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
      );
      tokenData = tokenResp.data;
    } catch (err) {
      // 2) легаси фоллбек (иногда помогает, но может вернуть invalid_grant для PKCE-кодов)
      try {
        const legacy = await axios.get('https://oauth.vk.com/access_token', {
          params: {
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code: String(code),
          },
          timeout: 10000,
        });
        tokenData = legacy.data;
      } catch (e2) {
        console.error('[VK CALLBACK] token exchange fail (both endpoints):',
          { primary: err?.response?.status || err?.message, fallback: e2?.response?.status || e2?.message });
      }
    }

    const accessToken = tokenData?.access_token;
    const vkUserId = tokenData?.user_id || tokenData?.user?.id;

    if (!accessToken) {
      console.error('[VK CALLBACK] no access_token:', tokenData);
      await logEvent({ user_id: null, event_type: 'auth_fail_token', payload: tokenData || null, ip, ua });
      return res.status(500).send('auth callback failed');
    }

    // профиль (first_name/last_name/аватар)
    let first_name = '', last_name = '', avatar = '';
    try {
      const u = await axios.get('https://api.vk.com/method/users.get', {
        params: { access_token: accessToken, v: '5.199', fields: 'photo_200,first_name,last_name' },
        timeout: 10000,
      });
      const r = u?.data?.response?.[0];
      if (r) {
        first_name = r.first_name || '';
        last_name  = r.last_name  || '';
        avatar     = r.photo_200  || '';
      }
    } catch (e) {
      console.warn('[VK CALLBACK] users.get failed:', e?.response?.data || e?.message);
    }

    const vk_id = String(vkUserId || 'unknown');
    const user = await upsertUser({ vk_id, first_name, last_name, avatar });

    await logEvent({
      user_id: user.id,
      event_type: 'auth_success',
      payload: { vk_id },
      ip,
      ua
    });

    // Сессионная кука для вашего API
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

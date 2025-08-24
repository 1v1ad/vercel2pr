// src/routes_auth.js
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
  const clientSecret = env.VK_CLIENT_SECRET;
  const redirectUri  = env.VK_REDIRECT_URI || env.REDIRECT_URI;
  const frontendUrl  = env.FRONTEND_URL  || env.CLIENT_URL;
  const stateSecret  = env.JMT_SECRET || env.JWT_SECRET; // секрет для подписи state

  for (const [k, v] of Object.entries({
    VK_CLIENT_ID: clientId,
    VK_CLIENT_SECRET: clientSecret,
    VK_REDIRECT_URI: redirectUri,
    FRONTEND_URL: frontendUrl,
  })) {
    if (!v) throw new Error(`Missing env ${k}`);
  }
  return { clientId, clientSecret, redirectUri, frontendUrl, stateSecret };
}

function firstIp(req) {
  const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return ipHeader.split(',')[0].trim();
}

// ===== base64url helpers =====
const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''),
  dec: (str) => Buffer.from(str.replace(/-/g,'+').replace(/_/g,'/'), 'base64'),
};

// Подписываем state (HMAC-SHA256), чтобы не тащить хранение на сервере.
function signState(payloadObj, secret) {
  const payloadBuf = Buffer.from(JSON.stringify(payloadObj));
  const sigBuf = crypto.createHmac('sha256', secret).update(payloadBuf).digest();
  return `${b64u.enc(payloadBuf)}.${b64u.enc(sigBuf)}`;
}

function verifyState(stateStr, secret, maxAgeSec = 600) {
  if (!stateStr || !secret || !stateStr.includes('.')) return null;
  const [p, s] = stateStr.split('.');
  try {
    const payloadBuf = b64u.dec(p);
    const expectedSig = b64u.enc(crypto.createHmac('sha256', secret).update(payloadBuf).digest());
    if (s !== expectedSig) return null;
    const obj = JSON.parse(payloadBuf.toString('utf8'));
    if (!obj.ts || Math.abs(Date.now()/1000 - Number(obj.ts)) > maxAgeSec) return null;
    return obj;
  } catch {
    return null;
  }
}

// На всякий случай — куки как запасной вариант
const cookieOpts = {
  httpOnly: true,
  sameSite: 'none',
  secure: true,
  path: '/',
  maxAge: 10 * 60 * 1000,
};

router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri, stateSecret } = getenv();

    const deviceId = typeof req.query.did === 'string' ? req.query.did.trim() : '';
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    // Статлесс state: несём cv + таймштамп (+ did для симметрии)
    const rawState = {
      cv: codeVerifier,
      did: deviceId || undefined,
      ts: Math.floor(Date.now()/1000),
      n: crypto.randomBytes(8).toString('hex'), // nonce
    };
    const state = stateSecret ? signState(rawState, stateSecret) : crypto.randomBytes(16).toString('hex');

    // Кладём куки только как резерв
    res.cookie('vkid_state', state, cookieOpts);
    res.cookie('vkid_code_verifier', codeVerifier, cookieOpts);

    await logEvent({
      user_id: null,
      event_type: 'auth_start',
      payload: { did: deviceId ? 'set' : 'none' },
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
    if (deviceId) u.searchParams.set('device_id', deviceId);

    console.log('[VK START] →', u.toString());
    return res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e?.message || e);
    return res.status(500).send('auth start failed');
  }
});

router.get('/vk/callback', async (req, res) => {
  const { code, state } = req.query;
  const cookies = { st: req.cookies['vkid_state'], cv: req.cookies['vkid_code_verifier'] };

  // Сразу стираем куки (не зависим от них)
  res.clearCookie('vkid_state', { path: '/' });
  res.clearCookie('vkid_code_verifier', { path: '/' });

  const { clientId, clientSecret, redirectUri, frontendUrl, stateSecret } = getenv();

  // Пытаемся достать cv из state (приоритизируем это)
  const parsed = stateSecret ? verifyState(String(state || ''), stateSecret) : null;
  const codeVerifier = parsed?.cv || cookies.cv || null;

  const stateCheck = {
    hasCode: !!code,
    echoedState: !!state,
    stateParsed: !!parsed,
    hasCV: !!codeVerifier,
    cookieState: !!cookies.st,
    cookieCV: !!cookies.cv,
  };
  console.log('[VK CALLBACK] state check:', stateCheck);

  if (!code || !codeVerifier) {
    return res.status(400).send('Invalid state');
  }

  try {
    // Обмен кода на токен (именно token-эндпоинт VK ID)
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }).toString();

    let tokenData;
    try {
      const resp = await axios.post('https://id.vk.com/oauth2/token', form, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      });
      tokenData = resp.data;
    } catch (err) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      console.error('[VK CALLBACK] token exchange fail:', status, data || err?.message);
      return res.status(500).send('auth callback failed');
    }

    const accessToken = tokenData?.access_token || tokenData?.token || tokenData?.access_token_value;
    if (!accessToken) {
      console.error('no access_token in tokenData:', tokenData);
      return res.status(500).send('auth callback failed');
    }

    // Профиль
    let first_name = '', last_name = '', avatar = '';
    try {
      const u = await axios.get('https://api.vk.com/method/users.get', {
        params: { access_token: accessToken, v: '5.199', fields: 'photo_200,first_name,last_name' },
        timeout: 10000,
      });
      const r = u.data?.response?.[0];
      if (r) {
        first_name = r.first_name || '';
        last_name  = r.last_name  || '';
        avatar     = r.photo_200  || '';
      }
    } catch (e) {
      console.warn('users.get failed:', e?.response?.data || e?.message);
    }

    const vk_id = String(tokenData?.user_id || tokenData?.user?.id || 'unknown');
    const user = await upsertUser({ vk_id, first_name, last_name, avatar });

    await logEvent({
      user_id: user.id,
      event_type: 'auth_success',
      payload: { vk_id },
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
    });

    // sid
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

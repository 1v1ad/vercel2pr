// Fixed routes_auth.js — VK ID (id.vk.com) OAuth2 PKCE flow
// Drop-in Express router mounted at `/api/auth`
// Key fixes vs your current file:
// 1) Exchange code at https://id.vk.com/oauth2/token (NOT .../oauth2/auth)
// 2) Send grant_type=authorization_code + code_verifier (PKCE), do NOT send device_id
// 3) No fallback to oauth.vk.com/access_token for codes issued by id.vk.com
// 4) Extra logging to Render logs to help with future diagnostics
// 5) Uses only standard libs + jsonwebtoken; no DB deps (safe drop-in)

import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const router = express.Router();

// ---- helpers ---------------------------------------------------------------
const env = (n, req = true) => {
  const v = process.env[n];
  if (req && !v) throw new Error(`Missing env ${n}`);
  return v;
};
const VK_CLIENT_ID     = env('VK_CLIENT_ID');
const VK_CLIENT_SECRET = env('VK_CLIENT_SECRET');        // optional with PKCE, but we include
const VK_REDIRECT_URI  = env('VK_REDIRECT_URI') || env('REDIRECT_URI');
const FRONTEND_URL     = env('FRONTEND_URL') || env('CLIENT_URL');
const JWT_SECRET       = env('JWT_SECRET');

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function createCodeVerifier() {
  return base64url(crypto.randomBytes(32));
}
function createCodeChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64url(hash);
}
function firstIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || '0.0.0.0';
}
function setTmpCookie(res, name, val) {
  res.cookie(name, val, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: 10 * 60 * 1000, // 10 min
  });
}

// ---- routes ---------------------------------------------------------------
router.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

// Step 1: redirect to VK ID authorize
router.get('/vk/start', async (req, res) => {
  try {
    const state        = crypto.randomBytes(16).toString('hex');
    const codeVerifier = createCodeVerifier();
    const codeChallenge= createCodeChallenge(codeVerifier);

    setTmpCookie(res, 'vk_state', state);
    setTmpCookie(res, 'vk_code_verifier', codeVerifier);

    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', VK_CLIENT_ID);
    u.searchParams.set('redirect_uri', VK_REDIRECT_URI);
    u.searchParams.set('scope', 'email');          // adjust as you wish
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');

    console.log('[VK START]', {
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 120),
      redirect_to: u.toString(),
    });

    return res.redirect(u.toString());
  } catch (e) {
    console.error('[VK START] error:', e);
    return res.status(500).send('auth start failed');
  }
});

// Step 2: callback from VK ID + code exchange at id.vk.com/oauth2/token
router.get('/vk/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code)  return res.status(400).send('Missing code');
    if (!state) return res.status(400).send('Missing state');

    const cookies = Object.fromEntries(
      (req.headers.cookie || '')
        .split(';')
        .map(s => s.trim())
        .filter(Boolean)
        .map(kv => {
          const i = kv.indexOf('=');
          return [decodeURIComponent(kv.slice(0, i)), decodeURIComponent(kv.slice(i + 1))];
        })
    );
    const savedState   = cookies.vk_state;
    const codeVerifier = cookies.vk_code_verifier;

    console.log('[VK CALLBACK] state check', {
      hasCode: !!code, hasState: !!state, savedState: !!savedState, codeVerifier: !!codeVerifier
    });

    if (!savedState || state !== savedState) {
      return res.status(400).send('Invalid state');
    }
    if (!codeVerifier) {
      return res.status(400).send('Missing code_verifier');
    }

    // IMPORTANT: Correct token endpoint (not ".../oauth2/auth")
    const tokenUrl = 'https://id.vk.com/oauth2/token';
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,        // VK allows both secret+PKCE
      redirect_uri: VK_REDIRECT_URI,
      code: String(code),
      code_verifier: codeVerifier
    });

    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    console.log('[VK TOKEN] status:', resp.status, 'body:', json);

    if (!resp.ok || !json || (!json.access_token && !json.id_token)) {
      return res.status(400).send('Token exchange failed');
    }

    // Minimal JWT session – include whatever you need
    const payload = {
      vk: {
        access_token: json.access_token || null,
        user_id: json.user_id || null,
        email: json.email || null,
      },
      iat: Math.floor(Date.now()/1000)
    };
    const session = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    // Redirect back to the app (adjust the path if your frontend expects another one)
    const redirectTo = new URL(FRONTEND_URL);
    redirectTo.searchParams.set('vk_auth', 'ok');
    redirectTo.searchParams.set('session', session);

    return res.redirect(302, redirectTo.toString());
  } catch (e) {
    console.error('[VK CALLBACK] error:', e);
    return res.status(500).send('auth callback failed');
  }
});

export default router;
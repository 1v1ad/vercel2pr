// VK OAuth2 PKCE flow without axios, no events import
import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const router = express.Router();

const {
  VK_CLIENT_ID,
  VK_CLIENT_SECRET,
  VK_REDIRECT_URI,
  FRONTEND_URL,
  JWT_SECRET,
} = process.env;

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

function randomState(len = 16) {
  return crypto.randomBytes(len).toString('hex');
}

function makeCodeVerifier() {
  // 43-128 chars allowed. Use 64 url-safe.
  return b64url(crypto.randomBytes(32));
}

function makeChallenge(codeVerifier) {
  return b64url(sha256(codeVerifier));
}

function setCookie(res, name, value, maxAgeSec = 600) {
  // httpOnly to protect from XSS, Lax so OAuth redirect keeps it
  res.cookie(name, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: maxAgeSec * 1000,
  });
}

router.get('/vk/start', async (req, res) => {
  try {
    const state = randomState(16);
    const codeVerifier = makeCodeVerifier();
    const challenge = makeChallenge(codeVerifier);

    setCookie(res, 'vk_state', state);
    setCookie(res, 'vk_code_verifier', codeVerifier);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: VK_CLIENT_ID || '',
      redirect_uri: VK_REDIRECT_URI || '',
      scope: 'email', // adjust if you need more
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    const url = `https://id.vk.com/authorize?${params.toString()}`;
    res.redirect(url);
  } catch (e) {
    console.error('[VK START] error', e);
    res.status(500).type('text/plain').send('start failed');
  }
});

router.get('/vk/callback', async (req, res) => {
  const { code, state } = req.query;
  const savedState = req.cookies?.vk_state;
  const codeVerifier = req.cookies?.vk_code_verifier;

  if (!code) return res.status(400).type('text/plain').send('auth callback failed: no code');
  if (!state || !savedState || state !== savedState) {
    console.warn('[VK CALLBACK] invalid state', { state, savedState });
    return res.status(400).type('text/plain').send('auth callback failed');
  }
  if (!codeVerifier) {
    console.warn('[VK CALLBACK] no codeVerifier cookie');
    return res.status(400).type('text/plain').send('auth callback failed');
  }

  try {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      client_id: VK_CLIENT_ID || '',
      redirect_uri: VK_REDIRECT_URI || '',
      code_verifier: codeVerifier,
    });
    if (VK_CLIENT_SECRET) form.set('client_secret', VK_CLIENT_SECRET);

    const tokenResp = await fetch('https://id.vk.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    const rawText = await tokenResp.text();
    let tokenJson = null;
    try { tokenJson = JSON.parse(rawText); } catch {}

    if (!tokenResp.ok) {
      console.error('[VK TOKEN] failed', tokenResp.status, rawText);
      return res.status(400).type('text/plain').send('Token exchange failed');
    }
    const access_token = tokenJson?.access_token;
    if (!access_token) {
      console.error('[VK TOKEN] malformed', tokenJson);
      return res.status(400).type('text/plain').send('Token exchange failed');
    }

    // Fetch userinfo
    const uResp = await fetch('https://id.vk.com/api/v1/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const uText = await uResp.text();
    let profile = null;
    try { profile = JSON.parse(uText); } catch {}

    if (!uResp.ok) {
      console.error('[VK USERINFO] failed', uResp.status, uText);
      // proceed with minimal payload
      profile = {};
    }

    // Issue session cookie
    const payload = {
      provider: 'vk',
      sub: profile?.sub || null,
      email: profile?.email || null,
      name: profile?.name || null,
      iat: Math.floor(Date.now()/1000),
    };
    const sid = jwt.sign(payload, JWT_SECRET || 'dev', { expiresIn: '7d' });
    setCookie(res, 'sid', sid, 60*60*24*7);

    // cleanup temp cookies
    res.clearCookie('vk_state', { path: '/' });
    res.clearCookie('vk_code_verifier', { path: '/' });

    const redirectTo = FRONTEND_URL || '/';
    res.redirect(redirectTo);
  } catch (e) {
    console.error('[VK CALLBACK] error', e);
    res.status(500).type('text/plain').send('auth callback failed');
  }
});

export default router;

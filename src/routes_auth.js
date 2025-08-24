// src/routes_auth.js
// Express routes for VK ID OAuth (PKCE) on Render
// ESM module. Mounts at /api/*
// Requires env: VK_CLIENT_ID, VK_REDIRECT_URI, JWT_SECRET
// Optional: VK_CLIENT_SECRET, FRONTEND_URL, COOKIE_SECRET

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import express from 'express';

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function makePkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function readCookiePayload(req) {
  const raw = (req.signedCookies && req.signedCookies.vk_oauth) || (req.cookies && req.cookies.vk_oauth);
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function writeCookiePayload(res, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const cookieOpts = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60 * 1000 // 10 minutes
  };
  // If a cookie secret is configured in the app, user probably uses cookie-parser with 'secret'
  // We set a normal cookie here; if cookie-parser is in signed mode, app will add signature itself on res.cookie(..., { signed: true })
  // To avoid coupling, don't force signed here.
  res.cookie('vk_oauth', encoded, cookieOpts);
}

export default function registerAuthRoutes(app) {
  const router = express.Router();

  const {
    VK_CLIENT_ID,
    VK_CLIENT_SECRET,
    VK_REDIRECT_URI,
    FRONTEND_URL,
    JWT_SECRET,
  } = process.env;

  // Boot log to confirm env presence
  console.log('[BOOT] env check:', {
    JWT_SECRET: !!JWT_SECRET,
    VK_CLIENT_ID: !!VK_CLIENT_ID,
    VK_CLIENT_SECRET: !!VK_CLIENT_SECRET,
    VK_REDIRECT_URI: !!VK_REDIRECT_URI,
    FRONTEND_URL: !!FRONTEND_URL,
  });

  router.get('/auth/healthz', (_, res) => res.json({ ok: true }));

  // 1) Start OAuth
  router.get('/auth/vk/start', (req, res) => {
    try {
      if (!VK_CLIENT_ID || !VK_REDIRECT_URI) {
        return res.status(500).send('VK OAuth is not configured');
      }
      const state = crypto.randomBytes(16).toString('hex');
      const { verifier, challenge } = makePkcePair();

      // persist verifier+state in cookie
      writeCookiePayload(res, { state, verifier, ts: Date.now() });

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: VK_CLIENT_ID,
        redirect_uri: VK_REDIRECT_URI,
        state,
        scope: 'email', // adjust if you need more scopes
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      const url = `https://id.vk.com/authorize?${params.toString()}`;
      console.log('[VK START] redirect_to:', url.replace(/code_challenge=[^&]+/, 'code_challenge=***'));
      res.redirect(url);
    } catch (e) {
      console.error('[VK START] error', e);
      res.status(500).send('OAuth start failed');
    }
  });

  // 2) Callback & token exchange
  router.get('/auth/vk/callback', async (req, res) => {
    const { code, state } = req.query || {};
    try {
      const saved = readCookiePayload(req);
      const hasCode = !!code;
      const hasState = !!state;
      const savedState = !!(saved && saved.state);
      const codeVerifier = !!(saved && saved.verifier);
      console.log('[VK CALLBACK] state check {',
        'hasCode:', hasCode + ',', 'hasState:', hasState + ',',
        'savedState:', savedState + ',', 'codeVerifier:', codeVerifier, '}'
      );

      if (!code || !state || !saved || saved.state !== state) {
        return res.status(400).send('Invalid state');
      }

      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: VK_CLIENT_ID,
        redirect_uri: VK_REDIRECT_URI,
        code: String(code),
        code_verifier: String(saved.verifier),
      });
      if (VK_CLIENT_SECRET) tokenParams.append('client_secret', VK_CLIENT_SECRET);

      // IMPORTANT: Token endpoint for VK ID
      const tokenUrl = 'https://id.vk.com/oauth2/auth';

      const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString(),
      });

      const bodyText = await resp.text();
      if (!resp.ok) {
        console.error('[VK TOKEN] status:', resp.status, 'body:', bodyText.slice(0, 500));
        return res.status(400).send('Token exchange failed');
      }

      let tokenJson;
      try {
        tokenJson = JSON.parse(bodyText);
      } catch {
        console.error('[VK TOKEN] non-json response:', bodyText.slice(0, 500));
        return res.status(400).send('Token exchange failed');
      }

      // Create our own session JWT; extend with whatever you need
      const payload = {
        vk_access_token: tokenJson.access_token,
        vk_token_type: tokenJson.token_type,
        vk_expires_in: tokenJson.expires_in,
      };
      const sessionJwt = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: '7d' });

      // Issue cookie and redirect to frontend
      res.cookie('session', sessionJwt, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 7 * 24 * 3600 * 1000,
      });

      const to = FRONTEND_URL || '/';
      console.log('[VK CALLBACK] success -> redirect', to);
      res.redirect(to);
    } catch (e) {
      console.error('vk callback error', e);
      res.status(500).send('auth callback failed');
    }
  });

  app.use('/api', router);
}
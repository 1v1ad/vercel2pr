import express from 'express';

const router = express.Router();

// --- Utilities --------------------------------------------------------------
const base64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function randomVerifier() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256Base64Url(input) {
  const enc = new TextEncoder();
  const data = enc.encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(Buffer.from(digest));
}

// Polyfill Web Crypto in Node
import { webcrypto as _webcrypto } from 'crypto';
const crypto = _webcrypto;

// --- Config -----------------------------------------------------------------
const {
  VK_CLIENT_ID,
  VK_CLIENT_SECRET,
  VK_REDIRECT_URI,
  FRONTEND_URL,
} = process.env;

// Cookie key to keep PKCE state
const STATE_COOKIE = 'vk_oauth_state';

// --- Routes -----------------------------------------------------------------
router.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

// Support BOTH /start and /vk/start to match old and new links
router.get(['/start', '/vk/start'], async (req, res) => {
  try {
    if (!VK_CLIENT_ID || !VK_REDIRECT_URI) {
      return res.status(500).type('text/plain').send('VK env not configured');
    }
    // PKCE
    const code_verifier = randomVerifier();
    const code_challenge = await sha256Base64Url(code_verifier);
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

    // Save state data in httpOnly cookie for verification on callback
    const statePayload = { state, code_verifier, t: Date.now() };
    res.cookie(STATE_COOKIE, JSON.stringify(statePayload), {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000, // 10 min
    });

    // Build VK authorize URL
    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', VK_CLIENT_ID);
    u.searchParams.set('redirect_uri', VK_REDIRECT_URI);
    u.searchParams.set('code_challenge', code_challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', state);
    // Optional scopes
    if (req.query.scope) u.searchParams.set('scope', String(req.query.scope));

    console.log('[VK START] redirect to:', u.toString());
    return res.redirect(u.toString());
  } catch (e) {
    console.error('start error', e);
    return res.status(500).type('text/plain').send('start failed');
  }
});

// Support BOTH /callback and /vk/callback
router.get(['/callback', '/vk/callback'], async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).type('text/plain').send('Invalid callback params');
    }

    const savedRaw = req.cookies?.[STATE_COOKIE];
    let saved;
    try { saved = savedRaw ? JSON.parse(savedRaw) : null; } catch {}
    if (!saved || saved.state !== state) {
      console.warn('[VK CALLBACK] invalid state', { state, hasSaved: !!saved });
      return res.status(400).type('text/plain').send('Invalid state');
    }

    // Exchange code -> token
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      redirect_uri: VK_REDIRECT_URI,
      code: String(code),
      code_verifier: saved.code_verifier,
    });

    // Try new VK ID endpoint first
    const tokenEndpoints = [
      'https://id.vk.com/oauth2/token',          // VK ID (new)
      'https://oauth.vk.com/access_token',       // Legacy
    ];

    let tokenJson;
    let lastErr;
    for (const ep of tokenEndpoints) {
      try {
        const resp = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody.toString(),
        });
        const txt = await resp.text();
        let json;
        try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
        if (!resp.ok || json.error) {
          lastErr = { status: resp.status, json };
          console.warn('[VK TOKEN] failed @', ep, lastErr);
          continue;
        }
        tokenJson = json;
        break;
      } catch (e) {
        lastErr = { message: String(e) };
        console.warn('[VK TOKEN] fetch error @', ep, lastErr);
      }
    }

    if (!tokenJson) {
      return res.status(400).type('text/plain').send('Token exchange failed');
    }

    // Clear state cookie (one-time)
    res.clearCookie(STATE_COOKIE, { path: '/' });

    // Redirect back to frontend with a tiny success flag (you can swap for JWT/session)
    const redirect = new URL(FRONTEND_URL || '/', 'https://dummy.local');
    redirect.searchParams.set('auth', 'ok');
    return res.redirect(redirect.pathname + redirect.search);
  } catch (e) {
    console.error('vk/callback error:', e);
    return res.status(500).type('text/plain').send('auth callback failed');
  }
});

export default router;
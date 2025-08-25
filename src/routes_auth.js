import express from 'express';
import crypto from 'crypto';

const router = express.Router();

// Helpers
const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const sha256 = (input) => crypto.createHash('sha256').update(input).digest();

const randomString = (len = 32) => b64url(crypto.randomBytes(len)).slice(0, len);

// Cookie options (Path is critical so the cookie reaches the callback)
const cookieBase = {
  httpOnly: true,
  secure: true,        // Render uses HTTPS
  sameSite: 'none',
  path: '/api/auth',
  maxAge: 10 * 60 * 1000, // 10 minutes
};

const VK_AUTH_URL = 'https://id.vk.com/authorize';
const VK_TOKEN_URL = 'https://id.vk.com/oauth2/v2.0/token';

// GET /api/auth/start
router.get('/start', async (req, res) => {
  try {
    const state = randomString(32);
    const verifier = randomString(64);
    const challenge = b64url(sha256(verifier));

    // Save to cookies for the callback to validate
    res.cookie('vk_oauth_state', state, cookieBase);
    res.cookie('vk_pkce_verifier', verifier, cookieBase);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: String(process.env.VK_CLIENT_ID || ''),
      redirect_uri: String(process.env.VK_REDIRECT_URI || ''),
      scope: 'email',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    const redirectTo = `${VK_AUTH_URL}?${params.toString()}`;
    console.log('[VK START] redirect to:', redirectTo.replace(/client_id=\d+/,'client_id=*'));
    return res.redirect(302, redirectTo);
  } catch (e) {
    console.error('[VK START] error', e);
    return res.status(500).type('text/plain').send('auth start failed');
  }
});

// GET /api/auth/vk/callback
router.get('/vk/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const savedState = req.cookies['vk_oauth_state'];
    const verifier = req.cookies['vk_pkce_verifier'];

    console.log('[VK CALLBACK] state check:', {
      hasCode: !!code,
      hasState: !!state,
      savedState: !!savedState,
      codeVerifier: !!verifier,
    });

    if (!code || !state || !savedState || !verifier || state !== savedState) {
      console.warn('[VK CALLBACK] invalid state check', { state, savedState });
      return res.status(400).type('text/plain').send('Invalid state');
    }

    // Clean the cookies to avoid reuse
    res.clearCookie('vk_oauth_state', cookieBase);
    res.clearCookie('vk_pkce_verifier', cookieBase);

    // Exchange code for tokens. IMPORTANT: do NOT send device_id for web flow.
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      client_id: String(process.env.VK_CLIENT_ID || ''),
      client_secret: String(process.env.VK_CLIENT_SECRET || ''),
      redirect_uri: String(process.env.VK_REDIRECT_URI || ''),
      code_verifier: String(verifier),
    });

    const tokenResp = await fetch(VK_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body,
    });

    let data;
    const text = await tokenResp.text();
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!tokenResp.ok || data.error) {
      console.error('[VK CALLBACK] token exchange failed:', data);
      return res.status(400).type('text/plain').send('Token exchange failed');
    }

    console.log('[VK CALLBACK] token ok, scope:', data.scope);

    // Success: redirect to frontend if configured, or say ok
    const to = process.env.FRONTEND_URL;
    if (to) {
      const url = new URL(to);
      url.hash = 'auth=ok';
      return res.redirect(302, url.toString());
    }
    return res.type('text/plain').send('ok');
  } catch (e) {
    console.error('[VK CALLBACK] error', e);
    return res.status(500).type('text/plain').send('auth callback failed');
  }
});

// Optional: tiny logout helper that clears cookies
router.post('/logout', (req, res) => {
  res.clearCookie('vk_oauth_state', cookieBase);
  res.clearCookie('vk_pkce_verifier', cookieBase);
  res.status(204).end();
});

export default router;

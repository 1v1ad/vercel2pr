import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import jwt from 'jsonwebtoken';

const router = express.Router();

const VK_CLIENT_ID = process.env.VK_CLIENT_ID;
const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET;
const VK_REDIRECT_URI = process.env.VK_REDIRECT_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || '/';

function b64url(input) {
  return input.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function makePkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

function makeState() {
  return b64url(crypto.randomBytes(24));
}

// ---- VK START ----
router.get('/vk/start', async (req, res) => {
  try {
    const { verifier, challenge, method } = makePkcePair();
    const state = makeState();

    // store in cookies (httpOnly so JS can't touch)
    res.cookie('vk_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
    res.cookie('vk_code_verifier', verifier, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: VK_CLIENT_ID,
      redirect_uri: VK_REDIRECT_URI,
      scope: 'vkid.personal_info',
      code_challenge: challenge,
      code_challenge_method: method,
      state,
    });

    const url = `https://id.vk.com/authorize?${params.toString()}`;
    return res.redirect(url);
  } catch (e) {
    console.error('[VK START] error:', e);
    return res.status(500).type('text/plain').send('auth start failed');
  }
});

// ---- VK CALLBACK ----
router.get('/vk/callback', async (req, res) => {
  const { code, state } = req.query;

  try {
    const savedState = req.cookies?.vk_state;
    const codeVerifier = req.cookies?.vk_code_verifier;

    if (!code || !state) {
      return res.status(400).type('text/plain').send('Missing code/state');
    }
    if (!savedState || state !== savedState) {
      console.warn('[VK CALLBACK] state mismatch', { state, savedState });
      return res.status(400).type('text/plain').send('Invalid state');
    }
    if (!codeVerifier) {
      console.warn('[VK CALLBACK] no code_verifier cookie');
      return res.status(400).type('text/plain').send('Missing code_verifier');
    }

    // Exchange code -> token at VK ID
    const form = new URLSearchParams({
      client_id: VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      redirect_uri: VK_REDIRECT_URI,
      code,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });

    let tokenResp;
    try {
      tokenResp = await axios.post('https://id.vk.com/oauth2/token', form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
        validateStatus: () => true
      });
    } catch (netErr) {
      console.error('[VK TOKEN] network error:', netErr?.message || netErr);
      return res.status(502).type('text/plain').send('Token exchange failed');
    }

    if (tokenResp.status !== 200) {
      console.error('[VK TOKEN] failed', {
        status: tokenResp.status,
        data: tokenResp.data
      });
      return res.status(400).type('text/plain').send('Token exchange failed');
    }

    const token = tokenResp.data?.access_token;
    const userId = tokenResp.data?.user_id || tokenResp.data?.vk_user_id;

    // Create our own session cookie (JWT)
    const sid = jwt.sign(
      { vk: { user_id: userId, at: !!token } },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });

    // Cleanup temp cookies
    res.clearCookie('vk_state');
    res.clearCookie('vk_code_verifier');

    // Redirect home (or simple OK for debugging)
    if (FRONTEND_URL.startsWith('http')) {
      const sep = FRONTEND_URL.includes('?') ? '&' : '?';
      return res.redirect(`${FRONTEND_URL}${sep}auth=ok`);
    }
    return res.type('text/plain').send('ok');
  } catch (e) {
    console.error('[VK CALLBACK] unexpected error', e);
    return res.status(500).type('text/plain').send('auth callback failed');
  }
});

export default router;

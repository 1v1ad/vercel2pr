import express from 'express';
import crypto from 'crypto';

const router = express.Router();

const { VK_CLIENT_ID, VK_CLIENT_SECRET, VK_REDIRECT_URI, FRONTEND_URL } = process.env;

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const sha256 = (str) => crypto.createHash('sha256').update(str).digest();
const genVerifier = () => b64url(crypto.randomBytes(32));
const genState = () => b64url(crypto.randomBytes(24));

const COOKIE_BASE = { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 10 * 60 * 1000 };

router.get('/vk/start', async (req, res) => {
  try {
    const verifier = genVerifier();
    const challenge = b64url(sha256(verifier));
    const state = genState();
    res.cookie('vk_oauth_state', state, COOKIE_BASE);
    res.cookie('vk_code_verifier', verifier, COOKIE_BASE);
    const params = new URLSearchParams({
      response_type: 'code', client_id: VK_CLIENT_ID, redirect_uri: VK_REDIRECT_URI, scope: 'email', state,
      code_challenge: challenge, code_challenge_method: 'S256'
    });
    return res.redirect(`https://id.vk.com/authorize?${params.toString()}`);
  } catch (e) {
    console.error('[VK START] error:', e);
    return res.status(500).type('text/plain').send('start failed');
  }
});

router.get('/vk/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const savedState = req.cookies?.vk_oauth_state;
    const verifier = req.cookies?.vk_code_verifier;
    if (!code) return res.status(400).type('text/plain').send('auth callback failed');
    if (!state || !savedState || state !== savedState) return res.status(400).type('text/plain').send('Invalid state');
    if (!verifier) return res.status(400).type('text/plain').send('Missing verifier');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      redirect_uri: VK_REDIRECT_URI,
      code: code.toString(),
      code_verifier: verifier
    });

    const resp = await fetch('https://id.vk.com/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });

    if (!resp.ok) {
      const raw = await resp.text().catch(() => '');
      console.error('[VK TOKEN] failed', resp.status, raw.slice(0, 600));
      return res.status(400).type('text/plain').send('Token exchange failed');
    }

    const data = await resp.json().catch(() => ({}));
    console.log('[VK TOKEN] ok keys:', Object.keys(data));
    res.clearCookie('vk_oauth_state', { ...COOKIE_BASE, maxAge: 0 });
    res.clearCookie('vk_code_verifier', { ...COOKIE_BASE, maxAge: 0 });

    return res.type('text/plain').send('ok');
  } catch (e) {
    console.error('[VK CALLBACK] error:', e);
    return res.status(500).type('text/plain').send('auth callback failed');
  }
});

export default router;

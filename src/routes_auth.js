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
  const redirectUri  = env.VK_REDIRECT_URI || env.REDIRECT_URI;    // подстраховка
  const frontendUrl  = env.FRONTEND_URL  || env.CLIENT_URL;        // подстраховка

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

function randomHex(len = 16) {
  return crypto.randomBytes(len).toString('hex');
}

// ===== Start
router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getenv();

    const state = randomHex(16);
    const codeVerifier  = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier); // S256

    res.cookie('vk_state', state,       { httpOnly: true, sameSite: 'lax',  secure: true, path: '/', maxAge: 10*60*1000 });
    res.cookie('vk_code_verifier', codeVerifier, { httpOnly: true, sameSite: 'lax',  secure: true, path: '/', maxAge: 10*60*1000 });

    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('scope', 'vkid.personal_info');

    res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e.message);
    res.status(500).send('auth start failed');
  }
});

// ===== Callback
router.get('/vk/callback', async (req, res) => {
  const { code, state, device_id } = req.query;
  try {
    const savedState   = req.cookies['vk_state'];
    const codeVerifier = req.cookies['vk_code_verifier'];
    if (!code || !state || !savedState || savedState !== state || !codeVerifier) {
      return res.status(400).send('Invalid state');
    }

    res.clearCookie('vk_state', { path: '/' });
    res.clearCookie('vk_code_verifier', { path: '/' });

    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();

    let tokenData = null;
    try {
      const resp = await axios.post(
        'https://id.vk.com/oauth2/auth',
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          device_id: device_id || ''
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
      );
      tokenData = resp.data;
    } catch (err) {
      console.warn('id.vk.com exchange failed, fallback', err?.response?.data || err?.message);
      const resp = await

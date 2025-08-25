import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
// Optional project helpers (present in your repo); keep imports so it's a drop-in
import { addEvent as logEvent } from './events.js';
import { getOrCreateUser, updateUserVkData } from './db.js';

const router = express.Router();

/** Helpers **/
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}
function randomStr(bytes = 32) {
  return b64url(crypto.randomBytes(bytes));
}
async function postForm(url, form) {
  const body = new URLSearchParams(form);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data: json };
}

const VK_AUTH_URL = 'https://id.vk.com/authorize';
const VK_TOKEN_URL = 'https://id.vk.com/oauth2/token';        // correct endpoint for VK ID OAuth2
const VK_USERINFO_URL = 'https://id.vk.com/api/v1/userinfo';

const {
  VK_CLIENT_ID,
  VK_CLIENT_SECRET,
  VK_REDIRECT_URI,
  JWT_SECRET,
  FRONTEND_URL,
} = process.env;

// ---- START ----
router.get('/vk/start', async (req, res) => {
  try {
    const state = randomStr(24);
    const verifier = randomStr(32);
    const challenge = b64url(sha256(verifier));

    // store in cookies (httpOnly so JS can't touch)
    res.cookie('vk_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
    res.cookie('vk_code_verifier', verifier, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });

    const url = new URL(VK_AUTH_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', VK_CLIENT_ID);
    url.searchParams.set('redirect_uri', VK_REDIRECT_URI);
    url.searchParams.set('scope', 'email'); // keep same scope you used earlier
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    await logEvent?.('vk_start', { state });
    return res.redirect(url.toString());
  } catch (e) {
    console.error('[VK START] error:', e);
    return res.status(500).type('text/plain').send('auth start failed');
  }
});

// ---- CALLBACK ----
router.get('/vk/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  const savedState = req.cookies?.vk_state;
  const codeVerifier = req.cookies?.vk_code_verifier;

  if (!code) return res.status(400).type('text/plain').send('Missing code');
  if (!state || !savedState || state !== savedState) {
    console.warn('[VK CALLBACK] state mismatch', { state, savedState });
    return res.status(400).type('text/plain').send('Invalid state');
  }
  if (!codeVerifier) {
    console.warn('[VK CALLBACK] no code_verifier cookie');
    return res.status(400).type('text/plain').send('No verifier');
  }

  try {
    // exchange code for tokens via x-www-form-urlencoded + fetch (no axios)
    const { ok, status, data } = await postForm(VK_TOKEN_URL, {
      grant_type: 'authorization_code',
      client_id: VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      redirect_uri: VK_REDIRECT_URI,
      code,
      code_verifier: codeVerifier,
    });

    if (!ok) {
      console.error('[VK TOKEN] failed', { status, json: data });
      return res.status(502).type('text/plain').send('Token exchange failed');
    }

    const accessToken = data.access_token;
    const idToken = data.id_token; // might present, keep if you need
    if (!accessToken) {
      console.error('[VK TOKEN] no access_token in response', data);
      return res.status(502).type('text/plain').send('Token exchange failed');
    }

    // fetch userinfo
    const uiResp = await fetch(VK_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const userinfo = await uiResp.json().catch(() => ({}));
    await logEvent?.('vk_userinfo', { ok: uiResp.ok, status: uiResp.status });

    // persist/update user in your DB (best effort)
    let userId = userinfo?.sub || userinfo?.user_id || null;
    try {
      const user = await getOrCreateUser?.({
        vk_id: userId,
        email: userinfo?.email ?? null,
        name: userinfo?.name ?? [userinfo?.first_name, userinfo?.last_name].filter(Boolean).join(' '),
      });
      if (user?.id) userId = user.id;
      await updateUserVkData?.(userId, {
        access_token: accessToken,
        userinfo,
      });
    } catch (dbErr) {
      console.warn('[VK CALLBACK] DB ops failed (non-fatal):', dbErr?.message || dbErr);
    }

    // Create our own session cookie (JWT)
    const payload = { sub: String(userId || userinfo?.sub || 'vk'), vk: { sub: userinfo?.sub, email: userinfo?.email } };
    const sid = jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });

    // Cleanup temp cookies
    res.clearCookie('vk_state');
    res.clearCookie('vk_code_verifier');

    await logEvent?.('vk_done', { userId });
    // redirect to your frontend
    const to = FRONTEND_URL || '/';
    return res.redirect(to);
  } catch (e) {
    console.error('[VK CALLBACK] fatal:', e);
    return res.status(500).type('text/plain').send('auth callback failed');
  }
});

export default router;

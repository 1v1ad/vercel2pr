// src/routes_auth.js — VK ID (id.vk.com) с PKCE + куки sid
// ENV: VK_CLIENT_ID, VK_CLIENT_SECRET, VK_REDIRECT_URI, FRONTEND_URL, JWT_SECRET
import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createCodeVerifier, createCodeChallenge } from './pkce.js';
import { upsertUser, logEvent } from './db.js';

const router = express.Router();

function mustEnv() {
  const e = process.env;
  const VK_CLIENT_ID     = e.VK_CLIENT_ID;
  const VK_CLIENT_SECRET = e.VK_CLIENT_SECRET;
  const VK_REDIRECT_URI  = e.VK_REDIRECT_URI || e.REDIRECT_URI;
  const FRONTEND_URL     = e.FRONTEND_URL    || e.CLIENT_URL;
  if (!VK_CLIENT_ID || !VK_CLIENT_SECRET || !VK_REDIRECT_URI || !FRONTEND_URL) {
    throw new Error('VK OAuth not configured (env)');
  }
  return { VK_CLIENT_ID, VK_CLIENT_SECRET, VK_REDIRECT_URI, FRONTEND_URL };
}

function firstIp(req) {
  const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return ipHeader.split(',')[0].trim();
}

function signSession(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '30d' });
}

// 1) Старт: редирект на id.vk.com с PKCE
router.get('/vk/start', async (req, res) => {
  try {
    const { VK_CLIENT_ID, VK_REDIRECT_URI } = mustEnv();

    const state         = crypto.randomBytes(16).toString('hex');
    const codeVerifier  = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    res.cookie('vk_state', state,               { httpOnly:true, sameSite:'lax',  secure:true, path:'/', maxAge: 10*60*1000 });
    res.cookie('vk_code_verifier', codeVerifier,{ httpOnly:true, sameSite:'lax',  secure:true, path:'/', maxAge: 10*60*1000 });

    await logEvent({ user_id:null, event_type:'auth_start', payload:null, ip:firstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) });

    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', VK_CLIENT_ID);
    u.searchParams.set('redirect_uri', VK_REDIRECT_URI);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('scope', 'vkid.personal_info');

    return res.redirect(302, u.toString());
  } catch (e) {
    console.error('vk/start error:', e.message);
    return res.status(500).send('auth start failed');
  }
});

// 2) Callback: обмен кода на токен VK ID → апсерт юзера → кука sid → редирект на фронт
router.get('/vk/callback', async (req, res) => {
  try {
    const { VK_CLIENT_ID, VK_CLIENT_SECRET, VK_REDIRECT_URI, FRONTEND_URL } = mustEnv();
    const { code, state } = req.query;

    const savedState   = req.cookies['vk_state'];
    const codeVerifier = req.cookies['vk_code_verifier'];
    if (!code || !state || !savedState || state !== savedState || !codeVerifier) {
      return res.status(400).send('invalid state');
    }
    res.clearCookie('vk_state', { path:'/' });
    res.clearCookie('vk_code_verifier', { path:'/' });

    // обмен PKCE на id.vk.com
    const resp = await axios.post(
      'https://id.vk.com/oauth2/auth',
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: VK_CLIENT_ID,
        client_secret: VK_CLIENT_SECRET,
        redirect_uri: VK_REDIRECT_URI,
        code_verifier: codeVerifier,
        code
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );

    const tokenData   = resp.data;
    const accessToken = tokenData?.access_token;
    const userId      = tokenData?.user_id || tokenData?.user?.id;
    if (!accessToken || !userId) {
      console.error('VK ID token exchange failed:', tokenData);
      return res.status(401).send('token exchange failed');
    }

    // инфо о пользователе (не критично)
    let first_name = '', last_name = '', avatar = '';
    try {
      const info = await axios.get('https://api.vk.com/method/users.get', {
        params: { user_ids: userId, fields: 'photo_200,first_name,last_name', v: '5.199', access_token: accessToken },
        timeout: 10000,
      });
      const u = info.data?.response?.[0];
      if (u) { first_name = u.first_name || ''; last_name = u.last_name || ''; avatar = u.photo_200 || ''; }
    } catch (e) {
      console.warn('users.get warn:', e?.response?.data || e.message);
    }

    const user = await upsertUser({ vk_id: String(userId), first_name, last_name, avatar });

    await logEvent({ user_id:user.id, event_type:'auth_success', payload:null, ip:firstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) });

    const sid = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sid, { httpOnly:true, sameSite:'none', secure:true, path:'/', maxAge: 30*24*3600*1000 });

    const redirect = new URL(FRONTEND_URL);
    redirect.searchParams.set('logged', '1');
    return res.redirect(302, redirect.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e.message);
    return res.status(500).send('token exchange failed');
  }
});

export default router;

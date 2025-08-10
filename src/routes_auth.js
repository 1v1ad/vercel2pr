// src/routes_auth.js — классический OAuth через oauth.vk.com (без PKCE)
// ENV: VK_CLIENT_ID, VK_CLIENT_SECRET, VK_REDIRECT_URI, FRONTEND_URL, JWT_SECRET
import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
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

/**
 * Шаг 1: редирект на oauth.vk.com/authorize
 */
router.get('/vk/start', async (req, res) => {
  try {
    const { VK_CLIENT_ID, VK_REDIRECT_URI } = mustEnv();

    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('vk_state', state, { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 10 * 60 * 1000 });

    await logEvent({ user_id: null, event_type: 'auth_start', payload: null, ip: firstIp(req), ua: (req.headers['user-agent'] || '').slice(0,256) });

    const url = new URL('https://oauth.vk.com/authorize');
    url.searchParams.set('client_id', VK_CLIENT_ID);
    url.searchParams.set('redirect_uri', VK_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('v', '5.199');
    // при необходимости можно указать scope, например 'offline'
    // url.searchParams.set('scope','offline');

    return res.redirect(302, url.toString());
  } catch (e) {
    console.error('vk/start error:', e.message);
    return res.status(500).send('auth start failed');
  }
});

/**
 * Шаг 2: callback — обмен code → access_token через oauth.vk.com/access_token
 */
router.get('/vk/callback', async (req, res) => {
  try {
    const { VK_CLIENT_ID, VK_CLIENT_SECRET, VK_REDIRECT_URI, FRONTEND_URL } = mustEnv();
    const { code, state } = req.query;

    const savedState = req.cookies['vk_state'];
    if (!code || !state || !savedState || state !== savedState) {
      return res.status(400).send('invalid state');
    }
    res.clearCookie('vk_state', { path: '/' });

    // 1) access_token
    const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
      params: {
        client_id: VK_CLIENT_ID,
        client_secret: VK_CLIENT_SECRET,
        redirect_uri: VK_REDIRECT_URI,
        code,
      },
      timeout: 10000,
    });

    const { access_token, user_id } = tokenResp.data || {};
    if (!access_token || !user_id) {
      console.error('tokenResp:', tokenResp.data);
      return res.status(401).send('token exchange failed');
    }

    // 2) базовая инфа (не критично, но пригодится)
    let first_name = '', last_name = '', avatar = '';
    try {
      const info = await axios.get('https://api.vk.com/method/users.get', {
        params: { user_ids: user_id, fields: 'photo_200,first_name,last_name', v: '5.199', access_token },
        timeout: 10000,
      });
      const u = info.data?.response?.[0];
      if (u) {
        first_name = u.first_name || '';
        last_name  = u.last_name  || '';
        avatar     = u.photo_200  || '';
      }
    } catch (e) {
      console.warn('users.get warn:', e?.response?.data || e.message);
    }

    // 3) апсерт пользователя
    const user = await upsertUser({ vk_id: String(user_id), first_name, last_name, avatar });

    await logEvent({ user_id: user.id, event_type: 'auth_success', payload: null, ip: firstIp(req), ua: (req.headers['user-agent'] || '').slice(0,256) });

    // 4) ставим нашу сессию sid в куку и редиректим на фронт
    const sid = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'none', secure: true, path: '/', maxAge: 30 * 24 * 3600 * 1000 });

    const u = new URL(FRONTEND_URL);
    u.searchParams.set('logged', '1');
    return res.redirect(302, u.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e.message);
    return res.status(500).send('token exchange failed');
  }
});

export default router;

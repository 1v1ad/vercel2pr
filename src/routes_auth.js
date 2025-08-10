// src/routes_auth.js
import express from 'express';
import axios from 'axios';
import db from './db.js';
import { generateCodeChallenge, generateCodeVerifier } from './pkce.js';
import { signJwt } from './jwt.js';

const router = express.Router();

const CLIENT_ID = process.env.VK_CLIENT_ID;
const CLIENT_SECRET = process.env.VK_CLIENT_SECRET;
const REDIRECT_URI = process.env.VK_REDIRECT_URI;

// Хранилище PKCE (в проде — Redis или база)
const pkceStore = {};

// Старт авторизации
router.get('/vk/start', async (req, res) => {
  try {
    const ipHeader = req.headers['x-forwarded-for'] || req.ip || '';
    const ip = ipHeader.split(',')[0].trim();

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    pkceStore[ip] = { codeVerifier };

    const authUrl = `https://id.vk.com/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
      REDIRECT_URI
    )}&response_type=code&scope=openid%20email&code_challenge=${codeChallenge}&code_challenge_method=S256`;

    res.redirect(authUrl);
  } catch (err) {
    console.error('vk/start error:', err.message);
    res.status(500).send('auth start failed');
  }
});

// Callback от VK
router.get('/vk/callback', async (req, res) => {
  try {
    const { code } = req.query;

    const ipHeader = req.headers['x-forwarded-for'] || req.ip || '';
    const ip = ipHeader.split(',')[0].trim();

    const pkceData = pkceStore[ip];
    if (!pkceData) {
      return res.status(400).send('No PKCE data found');
    }

    const tokenResp = await axios.post('https://id.vk.com/oauth2/token', null, {
      params: {
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code,
        code_verifier: pkceData.codeVerifier
      }
    });

    const { access_token } = tokenResp.data;

    const userInfo = await axios.get('https://id.vk.com/oauth2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const { sub: vk_id, given_name, family_name, picture } = userInfo.data;

    let user = await db.getUserByVkId(vk_id);
    if (!user) {
      await db.createUser({
        vk_id,
        firstName: given_name,
        lastName: family_name,
        avatar: picture,
        balance: 0
      });
      user = await db.getUserByVkId(vk_id);
    }

    const token = signJwt({ id: user.id, vk_id: user.vk_id });

    res.redirect(`/lobby.html?token=${token}`);
  } catch (err) {
    console.error('vk/callback error:', err.response?.data || err.message);
    res.status(500).send('auth callback failed');
  }
});

export default router;


import express from 'express';
import fetch from 'node-fetch';
import cookie from 'cookie';
import { createCodeVerifier, sha256, base64url } from './pkce.js';
import { upsertVkUser, attachTelegramToUser } from './db.js';

const router = express.Router();

const FRONT = process.env.FRONTEND_URL || process.env.FRONTEND_RETURN_URL || 'http://localhost:5173';
const CLIENT_ID = process.env.VK_CLIENT_ID || process.env.VK_APP_ID;
const CLIENT_SECRET = process.env.VK_CLIENT_SECRET || process.env.VK_APP_SECRET;
const REDIRECT = process.env.VK_REDIRECT_URI || (process.env.BACKEND_URL ? process.env.BACKEND_URL + '/api/auth/vk/callback' : '');

router.get('/api/auth/vk/start', async (req,res)=>{
  const { verifier, challenge } = createCodeVerifier();
  res.cookie('vk_verifier', verifier, { httpOnly:true, sameSite:'lax', secure:true, path:'/' });
  const url = new URL('https://id.vk.com/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT);
  url.searchParams.set('state', 'vk');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', 'openid,offline');
  res.redirect(url.toString());
});

router.get('/api/auth/vk/callback', async (req,res)=>{
  try{
    const code = req.query.code;
    const verifier = req.cookies.vk_verifier;
    if(!code || !verifier) throw new Error('missing code/verifier');

    const tokenRes = await fetch('https://id.vk.com/oauth2/v2/token', {
      method:'POST',
      headers:{ 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: verifier
      })
    });
    const tokenJson = await tokenRes.json();
    if(!tokenRes.ok) throw new Error('vk token error: ' + JSON.stringify(tokenJson));
    const at = tokenJson.access_token;

    // fetch profile from classic API for names/photo
    const userRes = await fetch('https://api.vk.com/method/users.get?v=5.199&fields=photo_200', {
      headers: { Authorization: `Bearer ${at}` }
    });
    const uj = await userRes.json();
    const vkUser = uj.response && uj.response[0] ? uj.response[0] : null;
    if(!vkUser) throw new Error('no vk user');

    const user = await upsertVkUser(vkUser);
    res.cookie('sid', String(user.id), { httpOnly:false, sameSite:'lax', secure:true, path:'/' });

    // background link if pending telegram exists
    const pending = req.cookies.pending_tg ? (()=>{ try{return JSON.parse(req.cookies.pending_tg)}catch(e){return null} })() : null;
    if(pending && pending.id){
      await attachTelegramToUser(user.id, pending);
      res.clearCookie('pending_tg', { path:'/' });
    }

    res.redirect(FRONT + '/?logged=1');
  }catch(e){
    console.error('[vk/callback]', e);
    res.redirect(FRONT + '/?error=vk');
  }
});

export default router;

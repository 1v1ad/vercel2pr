import express from 'express';
import axios from 'axios';
import { createCodeVerifier, createCodeChallenge } from './pkce.js';
import { signSession } from './jwt.js';
import { upsertUser } from './db.js';
import crypto from 'crypto';

const router = express.Router();

function setTempCookie(res, name, value){
  res.cookie(name, value, { httpOnly:true, sameSite:'lax', secure:true, path:'/', maxAge:10*60*1000 });
}
function clearTempCookie(res, name){ res.clearCookie(name, { path:'/' }); }

function getenv(){
  const req = ['VK_CLIENT_ID','VK_CLIENT_SECRET','VK_REDIRECT_URI','FRONTEND_URL'];
  for (const k of req) if (!process.env[k]) throw new Error('Missing env ' + k);
  return {
    clientId: process.env.VK_CLIENT_ID,
    clientSecret: process.env.VK_CLIENT_SECRET,
    redirectUri: process.env.VK_REDIRECT_URI,
    frontendUrl: process.env.FRONTEND_URL
  };
}

function randomHex(len=32){ return crypto.randomBytes(len).toString('hex'); }

router.get('/vk/start', async (req,res)=>{
  try{
    const { clientId, redirectUri } = getenv();
    const state = randomHex(16);
    const verifier = createCodeVerifier();
    const challenge = createCodeChallenge(verifier);
    setTempCookie(res, 'vk_state', state);
    setTempCookie(res, 'vk_code_verifier', verifier);

    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type','code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('scope','vkid.personal_info');
    return res.redirect(u.toString());
  }catch(e){ console.error('vk/start', e); res.status(500).send('auth start failed'); }
});

router.get('/vk/callback', async (req,res)=>{
  const { code, state, device_id } = req.query;
  if (!code || !state) return res.status(400).send('Bad callback');
  const savedState = req.cookies['vk_state'];
  const verifier = req.cookies['vk_code_verifier'];
  if (!savedState || !verifier || savedState !== state) return res.status(400).send('Invalid state');
  clearTempCookie(res,'vk_state'); clearTempCookie(res,'vk_code_verifier');

  const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();
  let tokenData = null;
  try{
    const resp = await axios.post('https://id.vk.com/oauth2/auth',
      new URLSearchParams({
        grant_type:'authorization_code',
        code, client_id:clientId, client_secret:clientSecret,
        redirect_uri:redirectUri, code_verifier:verifier, device_id:device_id||''
      }).toString(),
      { headers:{'Content-Type':'application/x-www-form-urlencoded'}, timeout:10000 });
    tokenData = resp.data;
  }catch(err){
    console.warn('id.vk.com exchange failed, fallback', err?.response?.data || err?.message);
    const resp = await axios.get('https://oauth.vk.com/access_token', {
      params:{ client_id:clientId, client_secret:clientSecret, redirect_uri:redirectUri, code, code_verifier:verifier, device_id:device_id||'' },
      timeout:10000
    });
    tokenData = resp.data;
  }

  const accessToken = tokenData.access_token;
  let first_name='', last_name='', avatar='';
  try{
    const u = await axios.get('https://api.vk.com/method/users.get', {
      params:{ access_token:accessToken, v:'5.199', fields:'photo_200,first_name,last_name' }, timeout:10000
    });
    const r = u.data?.response?.[0];
    if (r){ first_name=r.first_name||''; last_name=r.last_name||''; avatar=r.photo_200||''; }
  }catch(e){ console.warn('users.get failed', e?.response?.data || e?.message); }

  const vk_id = String(tokenData.user_id || (tokenData?.user?.id || 'unknown'));
  const user = await upsertUser({ vk_id, first_name, last_name, avatar });

  const jwt = signSession({ uid:user.id, vk_id:user.vk_id });
  res.cookie('sid', jwt, { httpOnly:true, sameSite:'lax', secure:true, path:'/', maxAge:30*24*3600*1000 });

  // back to frontend (index will redirect to /lobby.html)
  const url = new URL(frontendUrl);
  url.searchParams.set('logged','1');
  return res.redirect(url.toString());
});

export default router;

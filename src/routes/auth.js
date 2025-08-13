// src/routes/auth.js — VK ID OAuth with PKCE S256 (Render-sleep safe)
import { Router } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import jwt from 'jsonwebtoken';

const r = Router();

// Helpers
const b64url = (buf) => buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const sha256 = (input) => crypto.createHash('sha256').update(input).digest();

function signTmp(obj, ttlSec=600){
  const secret = (process.env.COOKIE_SECRET || process.env.JWT_SECRET || 'dev');
  const payload = { ...obj, exp: Math.floor(Date.now()/1000)+ttlSec };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function readTmp(val){
  if(!val) return null;
  const secret = (process.env.COOKIE_SECRET || process.env.JWT_SECRET || 'dev');
  const [data, sig] = val.split('.');
  const expSig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  if(sig !== expSig) return null;
  const payload = JSON.parse(Buffer.from(data,'base64url').toString('utf8'));
  if(payload.exp < Math.floor(Date.now()/1000)) return null;
  return payload;
}
const setTmp = (res, name, val) => res.cookie(name, val, { httpOnly:true, secure:true, sameSite:'lax', path:'/', maxAge:10*60*1000 });
const clearTmp = (res, name) => res.cookie(name, '', { httpOnly:true, secure:true, sameSite:'lax', path:'/', maxAge:0 });

// GET /api/auth/vk/start
r.get('/vk/start', (req,res)=>{
  const state = crypto.randomBytes(12).toString('hex');
  const device_id = crypto.randomBytes(8).toString('hex');
  const verifier = b64url(crypto.randomBytes(32));               // RFC7636
  const challenge = b64url(sha256(verifier));                    // S256

  setTmp(res, 'vk_tmp', signTmp({ state, device_id, verifier }));

  const redirect_uri = process.env.VK_REDIRECT_URI;
  const auth = new URL('https://id.vk.com/authorize');
  auth.search = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.VK_CLIENT_ID,
    redirect_uri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'email'
  }).toString();
  res.redirect(auth.toString());
});

// GET /api/auth/vk/callback
r.get('/vk/callback', async (req,res)=>{
  try{
    const { code, state } = req.query;
    const saved = readTmp(req.cookies['vk_tmp']);
    clearTmp(res, 'vk_tmp');
    if(!saved || saved.state !== state) {
      return res.redirect((process.env.FRONTEND_URL || '/') + '/index.html?e=state');
    }

    const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
      params: {
        client_id: process.env.VK_CLIENT_ID,
        client_secret: process.env.VK_CLIENT_SECRET,
        code,
        redirect_uri: process.env.VK_REDIRECT_URI,
        code_verifier: saved.verifier,
        device_id: saved.device_id
      }
    });
    const vk = tokenResp.data;
    // выдай свой JWT
    const jwtSecret = process.env.JWT_SECRET || 'dev';
    const token = jwt.sign({ sub: vk.user_id }, jwtSecret, { expiresIn:'1d' });
    // сессионная кука (если нужна для API)
    res.cookie('sid', token, { httpOnly:true, secure:true, sameSite:'none', path:'/', maxAge:30*24*3600*1000 });

    const front = process.env.FRONTEND_URL || '';
    res.redirect(`${front}/lobby.html?logged=1`);
  }catch(e){
    console.error('vk callback error', e?.response?.data || e.message);
    const front = process.env.FRONTEND_URL || '';
    res.redirect(`${front}/index.html?e=callback`);
  }
});

export default r;

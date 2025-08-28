
import express from 'express';
import crypto from 'crypto';
import { attachTelegramToUser } from './db.js';

const FRONT = process.env.FRONTEND_URL || process.env.FRONTEND_RETURN_URL || 'http://localhost:5173';
const router = express.Router();

function checkTelegramAuth(data){
  const secret = crypto.createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const checkHash = data.hash;
  const vals = Object.keys(data).filter(k => k !== 'hash').sort().map(k => `${k}=${data[k]}`).join('\n');
  const hmac = crypto.createHmac('sha256', secret).update(vals).digest('hex');
  return hmac === checkHash;
}

router.get('/api/auth/tg/callback', async (req,res)=>{
  try{
    const data = req.query;
    if(!checkTelegramAuth(data)) throw new Error('tg invalid hash');
    const tg = {
      id: String(data.id),
      username: data.username || '',
      first_name: data.first_name || ''
    };
    const sid = req.cookies.sid;
    if(sid){
      await attachTelegramToUser(sid, tg);
      res.redirect(FRONT + '/?logged=1');
    } else {
      res.cookie('pending_tg', JSON.stringify(tg), { httpOnly:true, sameSite:'lax', secure:true, path:'/' });
      res.redirect(FRONT + '/?tg=pending'); // user will still need to pass VK, then we'll link
    }
  }catch(e){
    console.error('[tg/callback]', e);
    res.redirect(FRONT + '/?error=tg');
  }
});

export default router;

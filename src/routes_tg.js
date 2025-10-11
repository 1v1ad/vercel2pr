// src/routes_tg.js
// Telegram-колбэк + режим привязки (proof-link) + совместимость с link_state и link_tokens

import express from 'express';
import { db, logEvent } from './db.js';
import { signSession } from './jwt.js';

const router = express.Router();

function firstIp(req){ const h=(req.headers['x-forwarded-for']||req.ip||'').toString(); return h.split(',')[0].trim(); }
function ua(req){ return (req.headers['user-agent']||'').slice(0,256); }

function decodeUidFromSid(req){
  try{
    const token=req.cookies?.sid; if(!token) return null;
    const parts=token.split('.'); if(parts.length<2) return null;
    const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
    const uid=Number(payload?.uid||0);
    return Number.isFinite(uid)&&uid>0?uid:null;
  }catch{ return null; }
}
function readLinkStateCookie(req){
  const raw=req.cookies?.link_state; if(!raw) return null;
  try{ return JSON.parse(raw); }
  catch{ try{ return JSON.parse(Buffer.from(raw,'base64url').toString('utf8')); }catch{ return null; } }
}
async function readLinkTokenFromDB(state,target){
  if(!state) return null;
  const r=await db.query(
    `select token, user_id, target, return_url
       from link_tokens
      where token=$1 and target=$2 and now()<expires_at and not coalesce(done,false) limit 1`,
    [String(state), String(target)]
  );
  return r.rows?.[0]||null;
}
async function markLinkTokenDone(token){ if(!token) return; try{ await db.query(`update link_tokens set done=true where token=$1`,[token]); }catch{} }

// ===== TG START =====
// Ставим cookie link_state и возвращаемся на return (фронт покажет/дернёт виджет TG)
router.get('/start', async (req,res)=>{
  try{
    if (req.query.mode==='link' && req.query.state) {
      const st={target:'tg', nonce:String(req.query.state), return:req.query.return?String(req.query.return):null};
      res.cookie('link_state', JSON.stringify(st), { httpOnly:true, sameSite:'lax', secure:true, path:'/', maxAge:15*60*1000 });
    }
    return res.redirect(String(req.query.return || `${process.env.FRONTEND_URL || ''}/lobby.html`));
  }catch(e){
    return res.status(200).send('tg start ok');
  }
});

// ===== TG CALLBACK =====
router.all('/cb', async (req, res) => {
  try { await logEvent({ user_id:null, event_type:'auth_start', payload:{ provider:'tg' }, ip:firstIp(req), ua:ua(req) }); } catch {}

  try {
    const data = { ...(req.query||{}), ...(req.body||{}) };
    const tgId = data.id ? String(data.id) : (data.user && data.user.id ? String(data.user.id) : null);
    const deviceId = String(req.query?.device_id || req.cookies?.device_id || '');

    // ===== PROOF LINK MODE =====
    try {
      let link = readLinkStateCookie(req);
      let linkTokenRow = null;
      if ((!link || link.target!=='tg') && req.query?.state) {
        linkTokenRow = await readLinkTokenFromDB(String(req.query.state), 'tg');
        if (linkTokenRow) link = { target:'tg', nonce:String(linkTokenRow.token), return:linkTokenRow.return_url || null };
      }

      if (link && link.target==='tg' && tgId) {
        let humId = decodeUidFromSid(req);
        if (!humId && linkTokenRow) humId = Number(linkTokenRow.user_id) || null;
        if (!humId) {
          await logEvent({ user_id:null, event_type:'link_error', payload:{ provider:'tg', reason:'no_session' }, ip:firstIp(req), ua:ua(req) });
          res.clearCookie('link_state', { path:'/' });
          return res.redirect((link.return || '/lobby.html') + '?link=error');
        }

        // конфликт?
        const chk = await db.query(
          "select user_id from auth_accounts where provider='tg' and provider_user_id=$1 and user_id is not null limit 1",
          [tgId]
        );
        if (chk.rows?.length && Number(chk.rows[0].user_id)!==Number(humId)) {
          await logEvent({ user_id:humId, event_type:'link_conflict', payload:{ provider:'tg', pid:tgId, other:chk.rows[0].user_id }, ip:firstIp(req), ua:ua(req) });
          res.clearCookie('link_state', { path:'/' });
          return res.redirect((link.return || '/lobby.html') + '?link=conflict');
        }

        await db.query(
          `insert into auth_accounts (user_id, provider, provider_user_id, username, meta)
           values ($1,'tg',$2,$3, jsonb_build_object('linked_at',now(),'ip',$4,'ua',$5))
           on conflict (provider, provider_user_id)
           do update set user_id=excluded.user_id, username=coalesce(excluded.username,auth_accounts.username), meta=coalesce(auth_accounts.meta,'{}')||jsonb_build_object('linked_at',now(),'ip',$4,'ua',$5), updated_at=now()`,
          [humId, tgId, (data.username?String(data.username):null), firstIp(req), ua(req)]
        );

        await logEvent({ user_id:humId, event_type:'link_success', payload:{ provider:'tg', pid:tgId }, ip:firstIp(req), ua:ua(req) });
        res.clearCookie('link_state', { path:'/' });
        if (linkTokenRow) await markLinkTokenDone(linkTokenRow.token);

        return res.redirect((link.return || '/lobby.html') + '?linked=tg');
      }
    } catch (e) {
      try { await logEvent({ event_type:'link_error', payload:{ provider:'tg', error:String(e?.message||e) }, ip:firstIp(req), ua:ua(req) }); } catch {}
    }
    // ===== /PROOF LINK MODE =====

    // Базовый апсерт auth_accounts (без жёсткой привязки) + запоминание device_id
    if (tgId) {
      try {
        await db.query(`
          insert into auth_accounts (user_id, provider, provider_user_id, username, meta)
          values (null,'tg',$1,$2,$3)
          on conflict (provider, provider_user_id) do update set
            username = coalesce(excluded.username, auth_accounts.username),
            meta     = jsonb_strip_nulls(coalesce(auth_accounts.meta,'{}'::jsonb) || excluded.meta),
            updated_at = now()
        `, [
          tgId,
          (data.username ? String(data.username) : null),
          JSON.stringify({ device_id: deviceId || null })
        ]);
      } catch {}
    }

    // при наличии ранее связанного user_id по этому device_id — ставим сессию
    if (deviceId) {
      try {
        const r = await db.query(
          "select user_id from auth_accounts where (meta->>'device_id')=$1 and user_id is not null order by updated_at desc limit 1",
          [deviceId]
        );
        if (r.rows?.length) {
          const jwt = signSession({ uid: Number(r.rows[0].user_id) });
          res.cookie('sid', jwt, { httpOnly:true, sameSite:'none', secure:true, path:'/', maxAge:30*24*3600*1000 });
        }
      } catch {}
    }

    // редирект в лобби
    const frontend = process.env.FRONTEND_URL || 'https://sweet-twilight-63a9b6.netlify.app';
    const url = new URL('/lobby.html', frontend);
    url.searchParams.set('provider','tg');
    if (tgId) url.searchParams.set('id', tgId);
    return res.redirect(302, url.toString());
  } catch (e) {
    console.error('tg/cb error', e);
    return res.redirect(302, (process.env.FRONTEND_URL || '') + '/lobby.html?provider=tg');
  }
});

export default router;

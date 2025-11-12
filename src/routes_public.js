// src/routes_public.js — V1.0 (public user endpoints for lobby balance)
import express from 'express';
import { db } from './db.js';

const router = express.Router();
// decode sid JWT (very light)
function decodeSidCookie(req){
  try{
    const token = (req.cookies && req.cookies.sid) || '';
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return payload; // { uid, ... }
  }catch(_){ return null; }
}


// собрать «канонического» пользователя + HUM-баланс по внутреннему id
async function fetchCanonicalByUserId(userId) {
  const u = await db.query(
    `select id, vk_id, first_name, last_name, avatar, coalesce(hum_id,id) as hum_id
       from users where id = $1 limit 1`,
    [userId]
  );
  if (!u.rows?.length) return null;

  const row = u.rows[0];
  const humId = Number(row.hum_id);
  const sum = await db.query(
    `select sum(coalesce(balance,0))::bigint as hum_balance
       from users where coalesce(hum_id,id) = $1`,
    [humId]
  );

  const balance = Number(sum.rows?.[0]?.hum_balance || 0);
  const provider = String(row.vk_id || '').startsWith('tg:') ? 'tg' : 'vk';
  return {
    ok: true,
    user: {
      id: row.id,
      hum_id: humId,
      vk_id: row.vk_id,
      first_name: row.first_name || '',
      last_name: row.last_name || '',
      avatar: row.avatar || '',
      balance,
      provider
    }
  };
}

// GET /api/user/:id — по внутреннему id
router.get('/user/:id', async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).json({ ok:false, error:'bad_id' });
    const data = await fetchCanonicalByUserId(id);
    if (!data) return res.status(404).json({ ok:false, error:'not_found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// GET /api/user/p/:provider/:pid — по провайдеру (tg/vk) и его id
router.get('/user/p/:provider/:pid', async (req, res) => {
  try {
    const prov = String(req.params.provider || '').toLowerCase();
    const pid  = String(req.params.pid || '').trim();
    if (!prov || !pid) return res.status(400).json({ ok:false, error:'bad_params' });

    let row;
    if (prov === 'tg') {
      const key = 'tg:' + pid;
      const r = await db.query(
        `select id from users where vk_id::text = $1 order by id asc limit 1`,
        [key]
      );
      row = r.rows?.[0];
    } else if (prov === 'vk') {
      const r = await db.query(
        `select id from users where vk_id::text = $1 order by id asc limit 1`,
        [String(Number(pid) || 0)]
      );
      row = r.rows?.[0];
    } else {
      return res.status(400).json({ ok:false, error:'bad_provider' });
    }

    if (!row) return res.status(404).json({ ok:false, error:'not_found' });
    const data = await fetchCanonicalByUserId(Number(row.id));
    if (!data) return res.status(404).json({ ok:false, error:'not_found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok:false, error:'server_error' });
  }
});


// GET /me — current user + preferred provider account (vk first, then tg)
router.get('/me', async (req,res) => {
  try {
    const sid = decodeSidCookie(req);
    if (!sid || !sid.uid) return res.status(401).json({ ok:false, error:'no_session' });
    const uid = Number(sid.uid);
    const u = await db.query(`select id, coalesce(hum_id,id) as hum_id, first_name, last_name, avatar from users where id=$1`, [uid]);
    if (!u.rows?.length) return res.status(404).json({ ok:false, error:'not_found' });

    // try to find provider account(s)
    const aa = await db.query(`select provider, provider_user_id from auth_accounts where user_id=$1 order by (provider='vk') desc`, [uid]);
    let provider=null, pid=null;
    if (aa.rows?.length){
      provider = aa.rows[0].provider;
      pid = aa.rows[0].provider_user_id;
    }

    res.json({ ok:true, user:{ id: uid, hum_id: u.rows[0].hum_id, provider, provider_user_id: pid, first_name: u.rows[0].first_name, last_name: u.rows[0].last_name, avatar: u.rows[0].avatar } });
  } catch(e){
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

export default router;

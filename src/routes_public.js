// Public routes (r4) — exact user by internal id AND provider id
import { Router } from 'express';
import { db } from './db.js';
const router = Router();

// by internal numeric id
router.get('/user/:id', async (req, res) => {
  const id=Number(req.params.id);
  if(!Number.isFinite(id)||id<=0) return res.status(400).json({ok:false,error:'bad_id'});
  try{
    const row=await db.query(
      `select id, vk_id, first_name, last_name, avatar, provider, balance, coalesce(hum_id,id) as hum_id, created_at
       from users where id=$1 limit 1`, [id]);
    if(!row.rows?.length) return res.status(404).json({ok:false,error:'not_found'});
    const u=row.rows[0];
    res.json({ ok:true, user:{
      user_id:u.id, hum_id:u.hum_id,
      provider: u.provider || (String(u.vk_id||'').startsWith('tg:')?'tg':'vk'),
      first_name: u.first_name || null, last_name: u.last_name || null,
      avatar: u.avatar || null, balance: Number(u.balance||0), created_at: u.created_at
    }});
  }catch(e){ console.error('GET /api/user/:id failed', e); res.status(500).json({ok:false,error:'server_error'}); }
});

// by provider id (vk or tg). For tg we accept both "1650011165" and "tg:1650011165"
router.get('/user/p/:provider/:pid', async (req, res) => {
  const provider = String(req.params.provider||'').toLowerCase();
  const pidRaw = String(req.params.pid||'');
  if (!provider || !pidRaw) return res.status(400).json({ ok:false, error:'bad_params' });

  let keys = [];
  if (provider === 'tg' || provider === 'telegram') {
    keys = [`tg:${pidRaw}`, pidRaw]; // vk_id may be stored as 'tg:165...' or simply '165...'
  } else if (provider === 'vk' || provider === 'vkontakte') {
    keys = [pidRaw];
  } else {
    return res.status(400).json({ ok:false, error:'bad_provider' });
  }

  try {
    const row = await db.query(
      `select id, vk_id, first_name, last_name, avatar, provider, balance, coalesce(hum_id,id) as hum_id, created_at
       from users
       where vk_id = any($1::text[])
       order by id asc
       limit 1`,
       [keys]
    );
    if(!row.rows?.length) return res.status(404).json({ ok:false, error:'not_found' });
    const u=row.rows[0];
    res.json({ ok:true, user:{
      user_id:u.id, hum_id:u.hum_id,
      provider: u.provider || (String(u.vk_id||'').startsWith('tg:')?'tg':'vk'),
      first_name: u.first_name || null, last_name: u.last_name || null,
      avatar: u.avatar || null, balance: Number(u.balance||0), created_at: u.created_at
    }});
  } catch (e) {
    console.error('GET /api/user/p failed', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

export default router;

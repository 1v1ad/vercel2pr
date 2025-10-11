// src/routes_public.js — V1.0 (public user endpoints for lobby balance)
import express from 'express';
import { db } from './db.js';

const router = express.Router();

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

export default router;

// src/routes_link.js — persist device_id on provider account + call auto-merge
import { Router } from 'express';
import { autoMergeByDevice, ensureMetaColumns } from './merge.js';
import { db } from './db.js';

const router = Router();

function getUidFromSid(req){
  try{
    const t = (req.cookies && req.cookies['sid']) || null;
    if(!t) return null;
    const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
    return p && p.uid || null;
  }catch(_){ return null; }
}


router.post('/link/background', async (req, res) => {
  try {
    const body = (req && req.body) || {};
    const provider = (body.provider || '').toString().trim();           // 'vk' | 'tg'
    const provider_user_id = (body.provider_user_id || '').toString().trim();
    const device_id = (body.device_id || '').toString().trim();
    const username = (body.username || '').toString().trim();

    await ensureMetaColumns();

    if (provider && provider_user_id) {
      try {
        await db.query(`
          insert into auth_accounts (user_id, provider, provider_user_id, username, phone_hash, meta)
          values ($5, $1, $2, $3, null, jsonb_build_object('device_id',$4))
          on conflict (provider, provider_user_id) do update set
            user_id   = coalesce(auth_accounts.user_id, excluded.user_id),
            username  = coalesce(excluded.username,  auth_accounts.username),
            meta      = jsonb_strip_nulls(coalesce(auth_accounts.meta,'{}'::jsonb) || excluded.meta),
            updated_at = now()
        `, [
          provider,
          provider_user_id,
          username || null,
          device_id || null,
          getUidFromSid(req)
        ]);
      } catch {}
    }

    // 3) Пытаемся автосклеить, отдаём «мягкий» ответ
    const merged = await autoMergeByDevice({ deviceId: device_id || null, tgId: provider === 'tg' ? provider_user_id : null });
    res.json({ ok:true, merged });
  } catch (e) {
    res.json({ ok:false, error: String(e && e.message || e) });
  }
});

export default router;

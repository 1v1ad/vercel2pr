// src/routes_link.js — persist device_id on provider account + call auto-merge
import { Router } from 'express';
import { autoMergeByDevice, ensureMetaColumns } from './merge.js';
import { db } from './db.js';

const router = Router();

router.post('/link/background', async (req, res) => {
  try {
    const body = (req && req.body) || {};
    const provider = (body.provider || '').toString().trim();           // 'vk' | 'tg'
    const provider_user_id = (body.provider_user_id || '').toString().trim();
    const device_id = (body.device_id || '').toString().trim();
    const username = (body.username || '').toString().trim();

    await ensureMetaColumns();

    // 1) Пробуем обновить meta.device_id у текущего аккаунта (он должен существовать после авторизации)
    let updated = 0;
    try {
      const upd = await db.query(
        "update auth_accounts set meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{device_id}', to_jsonb($3::text), true), updated_at=now() where provider=$1 and provider_user_id=$2",
        [provider, provider_user_id, device_id || null]
      );
      updated = upd.rowCount || 0;
    } catch {}

    // 2) На всякий случай, если записи нет — создадим «мягко» (без user_id, чтобы не сломать внешние ключи)
    if (!updated && provider && provider_user_id) {
      try {
        await db.query(
          "insert into auth_accounts (provider, provider_user_id, username, meta) values ($1,$2,$3, jsonb_build_object('device_id',$4)) on conflict do nothing",
          [provider, provider_user_id, username || null, device_id || null]
        );
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


// ======== LINK FLOW (one-time token) ========
import crypto from 'crypto';

const genLinkToken = () => 'link_' + crypto.randomBytes(16).toString('hex');

// Ensure table for link tokens
async function ensureLinkTokens() {
  await db.query(`create table if not exists link_tokens (
    token text primary key,
    owner_user_id bigint not null references users(id) on delete cascade,
    target text not null check (target in ('vk','tg')),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    used_at timestamptz null
  )`);
}

// TEMP user id provider: read from X-User-Id (replace with real session later)
function getUserIdFromHeader(req){
  const h = req.get('X-User-Id');
  const n = h ? parseInt(h,10) : NaN;
  return Number.isFinite(n) && n>0 ? n : null;
}

// Start link: creates token + returns URL
router.post('/profile/link/start', async (req,res)=>{
  try{
    const uid = getUserIdFromHeader(req);
    if(!uid) return res.status(401).json({ ok:false, error:'unauthenticated' });
    const raw = String(req.body?.target || '').toLowerCase();
    const target = raw.startsWith('vk') ? 'vk' : (raw.startsWith('tg') ? 'tg' : null);
    if(!target) return res.status(400).json({ ok:false, error:'bad_target' });

    const u = await db.query('select id from users where id=$1', [uid]);
    if(!u.rowCount) return res.status(404).json({ ok:false, error:'user_not_found' });

    await ensureLinkTokens();
    const token = genLinkToken();
    const ttlMin = 15;
    await db.query(
      `insert into link_tokens(token, owner_user_id, target, created_at, expires_at)
       values ($1,$2,$3, now(), now() + interval '${ttlMin} minutes')`,
      [token, uid, target]
    );

    let url='';
    if(target==='tg'){
      const bot = process.env.TG_BOT_USERNAME || 'YourBot';
      url = `https://t.me/${bot}?start=${encodeURIComponent(token)}`;
    }else{
      const clientId = process.env.VK_CLIENT_ID;
      const redirect = process.env.VK_REDIRECT_URI;
      const scope = 'email';
      const state = `link:${token}`;
      url = `https://oauth.vk.com/authorize?client_id=${clientId}&display=page&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}`;
    }

    res.json({ ok:true, token, url, ttl_minutes: ttlMin });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

// Poll link status
router.get('/profile/link/status', async (req,res)=>{
  try{
    const token = String(req.query?.token || '');
    if(!token) return res.json({ ok:true, exists:false, done:false, expired:false });
    await ensureLinkTokens();
    const r = await db.query('select used_at, expires_at from link_tokens where token=$1', [token]);
    if(!r.rowCount) return res.json({ ok:true, exists:false, done:false, expired:false });
    const row = r.rows[0];
    const expired = row.expires_at && new Date(row.expires_at) < new Date();
    res.json({ ok:true, exists:true, done: !!row.used_at, expired });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

// Complete link (called by VK callback or Telegram bot)
router.post('/internal/link/complete', async (req,res)=>{
  try{
    const token = String(req.body?.token || '');
    const provider = String(req.body?.provider || '').toLowerCase(); // 'vk' | 'tg'
    const provider_user_id = String(req.body?.provider_user_id || '');
    if(!token || !provider || !provider_user_id) return res.status(400).json({ ok:false, error:'bad_args' });

    await ensureLinkTokens();
    const t = await db.query('select * from link_tokens where token=$1', [token]);
    if(!t.rowCount) return res.status(404).json({ ok:false, error:'token_not_found' });
    const tok = t.rows[0];
    if(tok.used_at) return res.json({ ok:true, already:true });
    if(new Date(tok.expires_at) < new Date()) return res.status(410).json({ ok:false, error:'expired' });

    // find second account by provider id
    let other;
    if(provider==='vk'){
      other = await db.query('select id, hum_id from users where vk_id=$1', [provider_user_id]);
    }else{
      other = await db.query('select id, hum_id from users where vk_id=$1', ['tg:'+provider_user_id]);
    }
    if(!other.rowCount) return res.status(404).json({ ok:false, error:'second_account_not_found' });

    const owner = await db.query('select id, hum_id from users where id=$1', [tok.owner_user_id]);
    if(!owner.rowCount) return res.status(404).json({ ok:false, error:'owner_not_found' });
    const a = owner.rows[0], b = other.rows[0];
    const newHum = Math.min(a.hum_id || a.id, b.hum_id || b.id);

    await db.query('begin');
    await db.query(`update users set hum_id=$1 where hum_id in ($2,$3) or id in ($2,$3)`, [newHum, a.id, b.id]);
    await db.query('update link_tokens set used_at=now() where token=$1', [token]);

    // Log event if events table exists
    const cols = await db.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='events'"
    );
    const has = new Set((cols.rows||[]).map(x=>x.column_name));
    const fields=[], values=[], params=[]; let n=1;
    if(has.has('user_id'))    { fields.push('user_id');    values.push(`$${n++}`); params.push(a.id); }
    if(has.has('event_type')) { fields.push('event_type'); values.push(`$${n++}`); params.push(`hum_link_${provider}`); }
    const metaKey = has.has('meta') ? 'meta' : has.has('details') ? 'details' : (has.has('comment') ? 'comment' : null);
    if(metaKey){ fields.push(metaKey); values.push(`$${n++}`); params.push({ token, owner_user_id:a.id, second_user_id:b.id, provider }); }
    if(fields.length) await db.query(`insert into events (${fields.join(',')}) values (${values.join(',')})`, params);

    await db.query('commit');
    res.json({ ok:true, hum_id:newHum, merged_user_ids:[a.id,b.id] });
  }catch(e){
    try { await db.query('rollback'); } catch {}
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});


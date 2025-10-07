// src/linking.js
import jwt from 'jsonwebtoken';
import { db } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const DEVICE_ID_HEADER = (process.env.DEVICE_ID_HEADER || 'x-device-id').toLowerCase();

function ipOf(req){
  const xf = (req.headers['x-forwarded-for'] || '').toString();
  return (xf.split(',')[0] || req.ip || '').trim();
}

export function getDeviceId(req){
  const q = (req.query?.device_id || '').toString().trim();
  const h = (req.headers[DEVICE_ID_HEADER] || '').toString().trim();
  const c = (req.cookies?.device_id || '').toString().trim();
  return q || h || c || null;
}

export function decodeSid(req){
  try{
    const token = req.cookies?.sid;
    if(!token) return null;
    const payload = jwt.verify(token, JWT_SECRET, { algorithms:['HS256'] });
    return (payload && payload.uid) ? Number(payload.uid) : null;
  }catch(_){ return null; }
}

export async function upsertAuthAccount({ userId, provider, providerUserId, username, phoneHash, meta }){
  const q = `
    insert into auth_accounts (user_id, provider, provider_user_id, username, phone_hash, meta)
    values ($1,$2,$3,$4,$5,$6)
    on conflict (provider, provider_user_id) do update set
      user_id   = coalesce(auth_accounts.user_id, excluded.user_id),
      username  = coalesce(excluded.username,  auth_accounts.username),
      phone_hash= coalesce(excluded.phone_hash,auth_accounts.phone_hash),
      meta      = coalesce(excluded.meta,      auth_accounts.meta),
      updated_at = now()
    returning *;
  `;
  const { rows } = await db.query(q, [
    userId || null, provider, providerUserId, username || null, phoneHash || null,
    meta ? JSON.stringify(meta) : null
  ]);
  return rows[0];
}

export async function linkPendingsToUser({ userId, provider, deviceId, phoneHash, ip, ua }){
  if(!userId) return { linked: 0 };
  let linked = 0;

  // Helper to audit links
  async function audit(mergedId, method, details){
    await db.query(`insert into link_audit (primary_id, merged_id, method, source, ip, ua, details)
                    values ($1,$2,$3,$4,$5,$6,$7)`,
      [userId, mergedId || null, 'background', method, ip || null, ua || null, details ? JSON.stringify(details) : null]);
  }

  // Device-based linking: attach any pending accounts with same device_id
  if (deviceId) {
    const q = `select id, provider, provider_user_id, user_id
               from auth_accounts
               where (meta->>'device_id') = $1
                 and (user_id is null or user_id <> $2)`;
    const { rows } = await db.query(q, [deviceId, userId]);
    for (const row of rows) {
      // If account belongs to another user_id, we won't merge users here (too risky) — skip
      if (row.user_id && row.user_id !== userId) continue;
      await db.query('update auth_accounts set user_id = $1, updated_at = now() where id = $2', [userId, row.id]);
      linked++;
      await audit(null, 'device', { device_id: deviceId, matched: row });
    }
  }

  // Phone-hash linking
  if (phoneHash) {
    const q = `select id, provider, provider_user_id, user_id
               from auth_accounts
               where phone_hash = $1
                 and (user_id is null or user_id <> $2)`;
    const { rows } = await db.query(q, [phoneHash, userId]);
    for (const row of rows) {
      if (row.user_id && row.user_id !== userId) continue;
      await db.query('update auth_accounts set user_id = $1, updated_at = now() where id = $2', [userId, row.id]);
      linked++;
      await audit(null, 'phone_hash', { phone_hash: phoneHash, matched: row });
    }
  }

  return { linked };
}

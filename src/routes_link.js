import express from 'express';
import jwt from 'jsonwebtoken';
import { db } from './db.js';
import { verifyTelegramLogin } from './tg.js';
import { normalizePhoneE164, phoneHash } from './phone.js';

const router = express.Router();

const PHONE_HASH_SALT = process.env.PHONE_HASH_SALT || 'salt';
const DEVICE_ID_HEADER = process.env.DEVICE_ID_HEADER || 'x-device-id';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

function bearerUserId(req) {
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(h.slice(7), JWT_SECRET);
    return payload?.uid || payload?.userId || null;
  } catch { return null; }
}

function clientIp(req) {
  return (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || null;
}

async function ensureLinkTables() {
  // idempotent DDL
  await db.query(`create table if not exists auth_accounts (
    id serial primary key,
    user_id integer references users(id) on delete cascade,
    provider varchar(16) not null,
    provider_user_id varchar(128) not null,
    username text,
    phone_hash text,
    meta jsonb,
    created_at timestamp default now(),
    updated_at timestamp default now(),
    unique(provider, provider_user_id)
  );`);
  await db.query('create index if not exists idx_auth_accounts_phone_hash on auth_accounts(phone_hash)');
  await db.query(`create table if not exists link_codes (
    id serial primary key,
    user_id integer references users(id) on delete cascade,
    code varchar(16) unique not null,
    expires_at timestamp not null,
    used_at timestamp,
    created_at timestamp default now()
  );`);
  await db.query(`create table if not exists link_audit (
    id serial primary key,
    primary_id integer,
    merged_id integer,
    method varchar(32),
    source varchar(32),
    ip text,
    device_id text,
    ua text,
    details jsonb,
    created_at timestamp default now()
  );`);
}

// === /api/auth/tg ===
router.post('/auth/tg', async (req, res) => {
  try {
    await ensureLinkTables();
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return res.status(500).json({ ok:false, error:'bot_token_missing' });

    const deviceId = req.headers[DEVICE_ID_HEADER] || null;
    const ua = (req.headers['user-agent']||'').slice(0,256);
    const ip = clientIp(req);

    const tg = req.body?.user || {};
    if (!tg?.id || !tg?.hash) return res.status(400).json({ ok:false, error:'tg_payload_required' });

    if (!verifyTelegramLogin(tg, botToken)) {
      return res.status(400).json({ ok:false, error:'tg_signature_invalid' });
    }

    // Optional phone from bot flow
    const e164 = req.body?.phone ? normalizePhoneE164(req.body.phone) : null;
    const pHash = e164 ? phoneHash(e164, PHONE_HASH_SALT) : null;

    // Find existing auth account
    const { rows: accRows } = await db.query(
      'select * from auth_accounts where provider=$1 and provider_user_id=$2',
      ['tg', String(tg.id)]
    );
    let account = accRows[0] || null;

    if (!account) {
      // Create user + account
      const uIns = await db.query(
        `insert into users (vk_id, first_name, last_name, avatar)
         values ($1,$2,$3,$4) returning *`,
        [ 'tg:'+String(tg.id), tg.first_name || null, tg.last_name || null, tg.photo_url || null ]
      );
      const user = uIns.rows[0];

      const aIns = await db.query(
        `insert into auth_accounts (user_id, provider, provider_user_id, username, phone_hash, meta)
         values ($1,'tg',$2,$3,$4,$5) returning *`,
        [ user.id, String(tg.id), tg.username || null, pHash, JSON.stringify({ auth_date: tg.auth_date }) ]
      );
      account = aIns.rows[0];

      const __token_new = jwt.sign({ uid:user.id }, JWT_SECRET, { expiresIn:'30d' });
res.cookie('sid', __token_new, {
  httpOnly: true,
  secure: true,
  sameSite: 'None',
  path: '/',
  maxAge: 30*24*60*60*1000
});
return res.json({ ok:true, token: __token_new, user, mergeNeeded:false });
    }

    // Existing TG account
    const { rows: userRows } = await db.query('select * from users where id=$1', [account.user_id]);
    const tgUser = userRows[0];

    // who is currently logged in (via VK) ?
    const keeperId = bearerUserId(req);

    // phone-hash target
    let primaryByPhone = null;
    if (pHash) {
      const q = `select u.* from auth_accounts a join users u on u.id=a.user_id where a.phone_hash=$1 limit 1`;
      const r = await db.query(q, [pHash]);
      primaryByPhone = r.rows[0] || null;
      if (account.phone_hash !== pHash) {
        await db.query('update auth_accounts set phone_hash=$2 where id=$1', [account.id, pHash]);
      }
    }

    // Decide merge
    let needMerge = false, primary=null, merged=null, reason=null;
    if (keeperId && keeperId !== tgUser.id) {
      const r = await db.query('select * from users where id=$1', [keeperId]);
      primary = r.rows[0]; merged = tgUser; reason='session-keeper'; needMerge=true;
    } else if (primaryByPhone && primaryByPhone.id !== tgUser.id) {
      primary = primaryByPhone; merged = tgUser; reason='phone-hash'; needMerge=true;
    }

    if (!needMerge) {
      const __token_go = jwt.sign({ uid: tgUser.id }, JWT_SECRET, { expiresIn:'30d' });
res.cookie('sid', __token_go, {
  httpOnly: true,
  secure: true,
  sameSite: 'None',
  path: '/',
  maxAge: 30*24*60*60*1000
});
return res.json({ ok:true, token: __token_go, user: tgUser, mergeNeeded:false });
    }

    // Soft-merge handshake
    res.json({
      ok:true, mergeNeeded:true, reason,
      primary: { id: primary.id, firstName: primary.first_name, lastName: primary.last_name, balance: primary.balance },
      merged:  { id: merged.id,  firstName: merged.first_name,  lastName: merged.last_name,  balance: merged.balance },
    });
  } catch (e) {
    console.error('tg auth failed', e);
    res.status(500).json({ ok:false, error:'tg_auth_failed' });
  }
});

// === /api/link/code/create (JWT required) ===
router.post('/link/code/create', async (req, res) => {
  try {
    await ensureLinkTables();
    const h = req.headers['authorization'] || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ ok:false, error:'no_token' });
    let payload; try { payload = jwt.verify(h.slice(7), JWT_SECRET); } catch { return res.status(401).json({ ok:false, error:'invalid_token' }); }
    const userId = payload?.uid;
    if (!userId) return res.status(401).json({ ok:false });

    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const gen = () => 'LINK-' + Array.from({length:4}).map(()=>alphabet[Math.floor(Math.random()*alphabet.length)]).join('');
    let code = gen();
    // ensure unique
    for (let i=0;i<5;i++) {
      const r = await db.query('select 1 from link_codes where code=$1',[code]);
      if (!r.rowCount) break; code = gen();
    }
    const expires = new Date(Date.now() + 30*60*1000);
    await db.query('insert into link_codes (user_id, code, expires_at) values ($1,$2,$3)', [userId, code, expires]);
    res.json({ ok:true, code, expiresAt: expires.toISOString() });
  } catch (e) {
    console.error('code/create', e);
    res.status(500).json({ ok:false });
  }
});

// === /api/link/code/consume (bot) ===
router.post('/link/code/consume', async (req, res) => {
  try {
    await ensureLinkTables();
    const { code, provider, providerUserId, username, phone } = req.body || {};
    if (!code || !provider || !providerUserId) return res.status(400).json({ ok:false, error:'invalid_payload' });
    const L = await db.query('select * from link_codes where code=$1', [code]);
    const lc = L.rows[0];
    if (!lc || lc.used_at || new Date(lc.expires_at) < new Date()) return res.status(400).json({ ok:false, error:'code_invalid' });

    const e164 = phone ? normalizePhoneE164(phone) : null;
    const pHash = e164 ? phoneHash(e164, PHONE_HASH_SALT) : null;

    const A = await db.query('select * from auth_accounts where provider=$1 and provider_user_id=$2',[provider, String(providerUserId)]);
    const acc = A.rows[0];
    if (!acc) {
      await db.query(
        `insert into auth_accounts (user_id, provider, provider_user_id, username, phone_hash, meta)
         values ($1,$2,$3,$4,$5,$6)`,
        [lc.user_id, provider, String(providerUserId), username || null, pHash, JSON.stringify({})]
      );
      await db.query('update link_codes set used_at=now() where id=$1',[lc.id]);
      await db.query(`insert into link_audit (primary_id, method, source, details) values ($1,'code','bot',$2)`, [lc.user_id, JSON.stringify({ code, provider, providerUserId, createdAccount:true })]);
      return res.json({ ok:true, merged:false, linked:true });
    }

    if (acc.user_id === lc.user_id) {
      // same user, just update phone hash if sent
      if (pHash && acc.phone_hash !== pHash) {
        await db.query('update auth_accounts set phone_hash=$2 where id=$1', [acc.id, pHash]);
      }
      await db.query('update link_codes set used_at=now() where id=$1',[lc.id]);
      await db.query(`insert into link_audit (primary_id, method, source, details) values ($1,'code','bot',$2)`, [lc.user_id, JSON.stringify({ code, provider, providerUserId, createdAccount:false })]);
      return res.json({ ok:true, merged:false, linked:true });
    }

    // Merge two users
    const primaryId = lc.user_id;
    const mergedId  = acc.user_id;
    await db.query('begin');
    try {
      await db.query('update auth_accounts set user_id=$1 where user_id=$2', [primaryId, mergedId]);
      await db.query('update transactions set user_id=$1 where user_id=$2', [primaryId, mergedId]);
      const bal = await db.query('select balance from users where id=$1',[mergedId]);
      const inc = bal.rows[0]?.balance || 0;
      if (inc) await db.query('update users set balance = balance + $2 where id=$1', [primaryId, inc]);
      await db.query('update link_codes set used_at=now() where id=$1',[lc.id]);
      await db.query('delete from users where id=$1', [mergedId]);
      await db.query(`insert into link_audit (primary_id, merged_id, method, source, details) values ($1,$2,'code','bot',$3)`, [primaryId, mergedId, JSON.stringify({ code, provider, providerUserId })]);
      await db.query('commit');
    } catch (e) {
      await db.query('rollback'); throw e;
    }
    res.json({ ok:true, merged:true, primaryId, mergedId });
  } catch (e) {
    console.error('code/consume', e);
    res.status(500).json({ ok:false });
  }
});

// === /api/link/merge/confirm ===
router.post('/link/merge/confirm', async (req, res) => {
  try {
    await ensureLinkTables();
    const { primaryId, mergedId } = req.body || {};
    if (!primaryId || !mergedId || primaryId === mergedId) return res.status(400).json({ ok:false, error:'invalid_merge' });

    await db.query('begin');
    try {
      await db.query('update auth_accounts set user_id=$1 where user_id=$2', [primaryId, mergedId]);
      await db.query('update transactions set user_id=$1 where user_id=$2', [primaryId, mergedId]);
      const bal = await db.query('select balance from users where id=$1',[mergedId]);
      const inc = bal.rows[0]?.balance || 0;
      if (inc) await db.query('update users set balance = balance + $2 where id=$1', [primaryId, inc]);
      await db.query('delete from users where id=$1', [mergedId]);
      await db.query(`insert into link_audit (primary_id, merged_id, method, source, details) values ($1,$2,'manual','web',$3)`, [primaryId, mergedId, JSON.stringify({ reason: 'ui_confirm' })]);
      await db.query('commit');
    } catch (e) {
      await db.query('rollback'); throw e;
    }
    res.json({ ok:true, merged:true });
  } catch (e) {
    console.error('merge/confirm', e);
    res.status(500).json({ ok:false });
  }
});

// === /api/link/phone/submit (bot) ===
router.post('/link/phone/submit', async (req, res) => {
  try {
    await ensureLinkTables();
    const { provider, providerUserId, phone } = req.body || {};
    if (!provider || !providerUserId || !phone) return res.status(400).json({ ok:false, error:'invalid_payload' });

    const e164 = normalizePhoneE164(phone);
    const pHash = e164 ? phoneHash(e164, PHONE_HASH_SALT) : null;
    if (!pHash) return res.status(400).json({ ok:false, error:'bad_phone' });

    const A = await db.query('select id from auth_accounts where provider=$1 and provider_user_id=$2',[provider, String(providerUserId)]);
    if (!A.rowCount) return res.status(404).json({ ok:false, error:'account_not_found' });

    await db.query('update auth_accounts set phone_hash=$2 where id=$1', [A.rows[0].id, pHash]);
    res.json({ ok:true });
  } catch (e) {
    console.error('phone/submit', e);
    res.status(500).json({ ok:false });
  }
});

export default router;

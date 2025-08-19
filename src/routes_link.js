import express from 'express';
import jwt from 'jsonwebtoken';
import { db } from './db.js';
import { verifyTelegramLogin } from './tg.js';
import { normalizePhoneE164, phoneHash } from './phone.js';

const router = express.Router();

const PHONE_HASH_SALT = process.env.PHONE_HASH_SALT || 'salt';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'sid';

// извлекаем userId из Bearer-токена (если пользователь уже залогинен через VK)
function bearerUserId(req) {
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(h.slice(7), JWT_SECRET);
    return payload?.uid || payload?.userId || null;
  } catch { return null; }
}

// idempotent DDL для связки/аудита
async function ensureLinkTables() {
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
    details jsonb,
    created_at timestamp default now()
  );`);
}

/**
 * POST /api/auth/tg
 * Вход через Telegram Login Widget + soft-merge
 */
router.post('/auth/tg', async (req, res) => {
  try {
    await ensureLinkTables();

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return res.status(500).json({ ok:false, error:'bot_token_missing' });

    const tg = req.body?.user || {};
    if (!tg?.id || !tg?.hash) return res.status(400).json({ ok:false, error:'tg_payload_required' });

    // проверка подписи согласно документации Telegram
    if (!verifyTelegramLogin(tg, botToken)) {
      return res.status(400).json({ ok:false, error:'tg_signature_invalid' });
    }

    // возможный телефон из бота (если будет) — храним только hash
    const e164 = req.body?.phone ? normalizePhoneE164(req.body.phone) : null;
    const pHash = e164 ? phoneHash(e164, PHONE_HASH_SALT) : null;

    // найден ли уже TG-аккаунт
    const accQ = await db.query(
      'select * from auth_accounts where provider=$1 and provider_user_id=$2 limit 1',
      ['tg', String(tg.id)]
    );
    let account = accQ.rows[0] || null;

    if (!account) {
      // создаём user + связку TG
      const uIns = await db.query(
        `insert into users (vk_id, first_name, last_name, avatar)
         values ($1,$2,$3,$4) returning *`,
        [ 'tg:'+String(tg.id), tg.first_name || null, tg.last_name || null, tg.photo_url || null ]
      );
      const user = uIns.rows[0];

      await db.query(
        `insert into auth_accounts (user_id, provider, provider_user_id, username, phone_hash, meta)
         values ($1,'tg',$2,$3,$4,$5)`,
        [ user.id, String(tg.id), tg.username || null, pHash, JSON.stringify({ auth_date: tg.auth_date }) ]
      );

      // ставим cookie-сессию как VK
      const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true, secure: true, sameSite: 'None', path: '/', maxAge: 30*24*60*60*1000
      });

      return res.json({ ok:true, token, user, mergeNeeded:false });
    }

    // есть TG-аккаунт → берём пользователя
    const { rows: userRows } = await db.query('select * from users where id=$1', [account.user_id]);
    const tgUser = userRows[0];

    // кто «держатель» текущей сессии (например, уже залогинен через VK)
    const keeperId = bearerUserId(req);

    // обновим phone_hash если прислали
    if (pHash && account.phone_hash !== pHash) {
      await db.query('update auth_accounts set phone_hash=$2 where id=$1', [account.id, pHash]);
    }

    // решаем — нужен ли merge
    let needMerge = false, primary=null, merged=null, reason=null;

    if (keeperId && keeperId !== tgUser.id) {
      const r = await db.query('select * from users where id=$1', [keeperId]);
      primary = r.rows[0]; merged = tgUser; reason='session-keeper'; needMerge=true;
    } else if (pHash) {
      const r = await db.query(
        `select u.* from auth_accounts a join users u on u.id=a.user_id where a.phone_hash=$1 limit 1`, [pHash]);
      const byPhone = r.rows[0] || null;
      if (byPhone && byPhone.id !== tgUser.id) {
        primary = byPhone; merged = tgUser; reason='phone-hash'; needMerge=true;
      }
    }

    if (!needMerge) {
      // обычный вход — ставим куку и возвращаем юзера
      const token = jwt.sign({ uid: tgUser.id }, JWT_SECRET, { expiresIn: '30d' });
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true, secure: true, sameSite: 'None', path: '/', maxAge: 30*24*60*60*1000
      });
      return res.json({ ok:true, token, user: tgUser, mergeNeeded:false });
    }

    // soft-merge: клиент покажет диалог подтверждения
    return res.json({
      ok:true, mergeNeeded:true, reason,
      primary: { id: primary.id, firstName: primary.first_name, lastName: primary.last_name, balance: primary.balance },
      merged:  { id: merged.id,  firstName: merged.first_name,  lastName: merged.last_name,  balance: merged.balance },
    });
  } catch (e) {
    console.error('tg auth failed', e);
    res.status(500).json({ ok:false, error:'tg_auth_failed' });
  }
});

/**
 * POST /api/link/merge/confirm
 * Подтверждение объединения аккаунтов
 */
router.post('/link/merge/confirm', async (req, res) => {
  try {
    await ensureLinkTables();
    const { primaryId, mergedId } = req.body || {};
    if (!primaryId || !mergedId || primaryId === mergedId) {
      return res.status(400).json({ ok:false, error:'invalid_merge' });
    }
    await db.query('begin');
    try {
      await db.query('update auth_accounts set user_id=$1 where user_id=$2', [primaryId, mergedId]);
      await db.query('update transactions set user_id=$1 where user_id=$2', [primaryId, mergedId]);
      const bal = await db.query('select balance from users where id=$1', [mergedId]);
      const inc = bal.rows[0]?.balance || 0;
      if (inc) await db.query('update users set balance=balance+$2 where id=$1', [primaryId, inc]);
      await db.query('delete from users where id=$1', [mergedId]);
      await db.query(`insert into link_audit (primary_id, merged_id, method, source, details)
                      values ($1,$2,'manual','web',$3)`,
        [primaryId, mergedId, JSON.stringify({ reason: 'ui_confirm' })]);
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

export default router;

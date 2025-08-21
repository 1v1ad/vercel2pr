// src/linking.js
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { db } from './db.js';
import { normalizePhoneE164, phoneHash as makePhoneHash } from './phone.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const PHONE_SALT = process.env.PHONE_SALT || '';

/** Достаём userId из серверной куки 'sid' (JWT). */
export function requireUserId(req) {
  const token = req.cookies?.sid || '';
  if (!token) throw Object.assign(new Error('no_session'), { status: 401 });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const uid = payload && (payload.uid || payload.userId || payload.id);
    if (!uid) throw new Error('bad_payload');
    return Number(uid);
  } catch {
    throw Object.assign(new Error('bad_session'), { status: 401 });
  }
}

/** Генерим код вида LINK-XXXX (4 символа, безопасный алфавит), TTL 15 мин. */
export async function generateLinkCode(userId, ttlMinutes = 15) {
  const client = await db.connect();
  try {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    // Алфавит без 0/O/1/I
    const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const makeBody = (len = 4) => {
      let s = '';
      for (let i = 0; i < len; i++) {
        s += ABC[crypto.randomInt(0, ABC.length)];
      }
      return s;
    };

    let code = '';
    for (let tries = 0; tries < 20; tries++) {
      const candidate = `LINK-${makeBody(4)}`;
      const { rows } = await client.query(
        `select id from link_codes where code = $1 and used_at is null and expires_at > now()`,
        [candidate]
      );
      if (rows.length === 0) { code = candidate; break; }
    }
    if (!code) throw new Error('cannot_generate_code');

    await client.query(
      `insert into link_codes (user_id, code, expires_at) values ($1, $2, $3)`,
      [userId, code, expiresAt]
    );

    return { code, expires_at: expiresAt.toISOString() };
  } finally {
    client.release();
  }
}

/** Слияние: переносим всё к primary, младшего удаляем, логируем. */
export async function mergeUsers(primaryId, mergedId, details = {}) {
  if (primaryId === mergedId) return { ok: true, noop: true };
  const client = await db.connect();
  try {
    await client.query('begin');

    // Баланс
    const balRes = await client.query(
      'select id, balance from users where id = any($1::int[]) order by created_at asc',
      [[primaryId, mergedId]]
    );
    const balances = Object.fromEntries(balRes.rows.map(r => [r.id, Number(r.balance || 0)]));
    const newBalance = (balances[primaryId] || 0) + (balances[mergedId] || 0);

    // Переносим все связанные сущности
    await client.query('update transactions set user_id = $1 where user_id = $2', [primaryId, mergedId]);
    await client.query('update auth_accounts set user_id = $1 where user_id = $2', [primaryId, mergedId]);
    await client.query('update events set user_id = $1 where user_id = $2', [primaryId, mergedId]);
    await client.query('update link_codes set user_id = $1 where user_id = $2', [primaryId, mergedId]);

    // Применяем баланс и удаляем младшего
    await client.query('update users set balance = $2 where id = $1', [primaryId, newBalance]);
    await client.query('delete from users where id = $1', [mergedId]);

    // Аудит
    await client.query(
      `insert into link_audit (primary_id, merged_id, method, source, ip, ua, details)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        primaryId,
        mergedId,
        details.method || 'unknown',
        details.source || 'api',
        (details.ip || '').slice(0, 128),
        (details.ua || '').slice(0, 256),
        details
      ]
    );

    await client.query('commit');
    return { ok: true, primary_id: primaryId, merged_id: mergedId, balance: newBalance };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

/** Привязать телефон и попробовать авто-склейку всех юзеров с одинаковым phone_hash. */
export async function setPhoneAndAutoMerge(userId, rawPhone, meta = {}) {
  const e164 = normalizePhoneE164(rawPhone);
  if (!e164) throw Object.assign(new Error('bad_phone'), { status: 400 });
  const hash = makePhoneHash(e164, PHONE_SALT);

  const client = await db.connect();
  try {
    await client.query('begin');

    // На всякий случай: если у юзера нет строки в auth_accounts — создадим заглушку.
    const ex = await client.query('select id from auth_accounts where user_id = $1 limit 1', [userId]);
    if (ex.rows.length === 0) {
      await client.query(
        `insert into auth_accounts (user_id, provider, provider_user_id, username, meta)
         values ($1,'local','local',null,null)`,
        [userId]
      );
    }

    await client.query(
      `update auth_accounts set phone_hash = $2, updated_at = now() where user_id = $1`,
      [userId, hash]
    );

    const { rows } = await client.query(
      `select aa.user_id, min(u.created_at) as created_at
         from auth_accounts aa
         join users u on u.id = aa.user_id
        where aa.phone_hash = $1
        group by aa.user_id
        order by created_at asc`,
      [hash]
    );

    const ids = [...new Set(rows.map(r => Number(r.user_id)))];
    if (ids.length >= 2) {
      const primaryId = ids[0];
      for (const mid of ids.slice(1)) {
        if (primaryId !== mid) {
          await mergeUsers(primaryId, mid, { method: 'phone-match', source: 'api/link/phone', ...meta });
        }
      }
      await client.query('commit');
      return { ok: true, merged: true, primary_id: primaryId, merged_count: ids.length - 1 };
    }

    await client.query('commit');
    return { ok: true, merged: false };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

/** Применить LINK-XXXX: старший определяется по дате создания. */
export async function claimCodeAndMerge(claimantUserId, code, meta = {}) {
  const client = await db.connect();
  try {
    await client.query('begin');

    const { rows } = await client.query(
      `select * from link_codes
        where code = $1 and used_at is null and expires_at > now()
        for update`,
      [code]
    );
    if (rows.length === 0) {
      await client.query('rollback');
      return { ok: false, error: 'invalid_or_expired' };
    }

    const rec = rows[0];
    const ownerId = Number(rec.user_id);

    if (ownerId === claimantUserId) {
      await client.query('update link_codes set used_at = now() where id = $1', [rec.id]);
      await client.query('commit');
      return { ok: true, noop: true };
    }

    const older = await client.query(
      `select id from users where id = any($1::int[]) order by created_at asc`,
      [[ownerId, claimantUserId]]
    );
    const primaryId = Number(older.rows[0].id);
    const mergedId = (primaryId === ownerId) ? claimantUserId : ownerId;

    await mergeUsers(primaryId, mergedId, { method: 'code-link', source: 'api/link/code/claim', ...meta });
    await client.query('update link_codes set used_at = now() where id = $1', [rec.id]);

    await client.query('commit');
    return { ok: true, primary_id: primaryId, merged_id: mergedId };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

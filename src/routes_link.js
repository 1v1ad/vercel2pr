// src/routes_link.js — persist device_id на аккаунте провайдера + попытка автосклейки
import { Router } from 'express';
import { autoMergeByDevice, ensureMetaColumns } from './merge.js';
import { db } from './db.js';

const router = Router();

/**
 * Локальный хелпер, чтобы не тянуть его из routes_auth.js и не ловить циклические импорты.
 * Возвращает user_id из cookie-сессии sid (если вдруг понадобится).
 */
function decodeSid(token) {
  try {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const uid = Number(payload?.uid || 0);
    return Number.isFinite(uid) && uid > 0 ? uid : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/link/background
 * Тихо сохраняем device_id в meta у записи auth_accounts (provider, provider_user_id),
 * создаём при отсутствии, затем пытаемся мягко склеить аккаунты по device_id.
 * Тело: { provider: 'vk'|'tg', provider_user_id: string, device_id?: string, username?: string }
 */
router.post('/link/background', async (req, res) => {
  try {
    const body = (req && req.body) || {};
    const provider = (body.provider || '').toString().trim();           // 'vk' | 'tg'
    const provider_user_id = (body.provider_user_id || '').toString().trim();
    const device_id = (body.device_id || '').toString().trim();
    const username = (body.username || '').toString().trim();

    if (!provider || !provider_user_id) {
      return res.status(400).json({ ok: false, error: 'provider_and_id_required' });
    }

    await ensureMetaColumns();

    // 1) Обновим meta.device_id у существующей записи
    let updated = 0;
    try {
      const upd = await db.query(
        `update auth_accounts
           set meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{device_id}', to_jsonb($3::text), true),
               updated_at = now()
         where provider = $1 and provider_user_id = $2`,
        [provider, provider_user_id, device_id || null]
      );
      updated = upd.rowCount || 0;
    } catch { /* no-op */ }

    // 2) Если записи нет — создадим мягко (без user_id)
    if (!updated) {
      try {
        await db.query(
          `insert into auth_accounts (provider, provider_user_id, username, meta)
           values ($1,$2,$3, jsonb_build_object('device_id',$4))
           on conflict do nothing`,
          [provider, provider_user_id, username || null, device_id || null]
        );
      } catch { /* no-op */ }
    }

    // 3) Пытаемся автосклеить
    const merged = await autoMergeByDevice({
      deviceId: device_id || null,
      tgId: provider === 'tg' ? provider_user_id : null
    });

    res.json({ ok: true, merged });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;

// src/routes_link.js — link flow: persist device_id + start OAuth linking + optional status
// REMARK: soft-link по device_id + автосклейка; кнопки в лобби ведут на /api/profile/link/start?vk=1|tg=1

import { Router } from 'express';
import { autoMergeByDevice, ensureMetaColumns } from './merge.js';
import { db } from './db.js';

const router = Router();

// ───────────────────────────────────────────────────────────────────────────────
// GET /api/profile/link/start?vk=1|tg=1&redirect=/lobby.html
// Делает редирект на существующий OAuth-старт, помечая намерение "link".
// Нужен для кликабельных кнопок в лобби.
router.get('/link/start', async (req, res) => {
  try {
    // provider из query: vk=1 | tg=1 | provider=tg|vk
    const q = req.query || {};
    const provider =
      q.provider?.toString().trim().toLowerCase() ||
      (q.vk ? 'vk' : '') ||
      (q.tg ? 'tg' : '');

    if (provider !== 'vk' && provider !== 'tg') {
      return res.status(400).json({ ok: false, error: 'bad_provider' });
    }

    // куда вернуть после линка (дефолт — в лобби)
    const redirectTo =
      (q.redirect && q.redirect.toString()) ||
      '/lobby.html';

    // Сохраним намерение линка в cookie (прочтёшь на стороне /auth/*/complete при желании)
    res.cookie('link_intent', JSON.stringify({ provider, redirectTo }), {
      httpOnly: true,
      sameSite: 'lax',
      secure: !!(process.env.COOKIE_SECURE || process.env.NODE_ENV === 'production'),
      maxAge: 10 * 60 * 1000, // 10 минут
      path: '/',
    });

    // Проксируем на существующие эндпоинты авторизации
    // Прим.: в проекте уже есть /api/auth/vk/start и /api/auth/tg/start
    const url = `/api/auth/${provider}/start?link=1`;
    return res.redirect(url);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// POST /api/profile/link/background
// Сохраняем device_id в meta аккаунта и сразу пытаемся автосклеить учётки.
router.post('/link/background', async (req, res) => {
  try {
    const body = (req && req.body) || {};
    const provider = (body.provider || '').toString().trim();           // 'vk' | 'tg'
    const provider_user_id = (body.provider_user_id || '').toString().trim();
    const device_id = (body.device_id || '').toString().trim();
    const username = (body.username || '').toString().trim();

    await ensureMetaColumns();

    // 1) meta.device_id для уже существующей записи
    let updated = 0;
    try {
      const upd = await db.query(
        "update auth_accounts set meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{device_id}', to_jsonb($3::text), true), updated_at=now() where provider=$1 and provider_user_id=$2",
        [provider, provider_user_id, device_id || null]
      );
      updated = upd.rowCount || 0;
    } catch {}

    // 2) Если записи нет — создаём «мягко» (без user_id)
    if (!updated && provider && provider_user_id) {
      try {
        await db.query(
          "insert into auth_accounts (provider, provider_user_id, username, meta) values ($1,$2,$3, jsonb_build_object('device_id',$4)) on conflict do nothing",
          [provider, provider_user_id, username || null, device_id || null]
        );
      } catch {}
    }

    // 3) Пытаемся автосклеить по device_id
    const merged = await autoMergeByDevice({
      deviceId: device_id || null,
      tgId: provider === 'tg' ? provider_user_id : null
    });

    res.json({ ok: true, merged });
  } catch (e) {
    res.json({ ok: false, error: String(e && e.message || e) });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// GET /api/profile/link/status?provider=tg&provider_user_id=1650011165
// Вспомогательный эндпоинт для отладки: посмотреть, что хранится по аккаунту.
router.get('/link/status', async (req, res) => {
  try {
    const q = req.query || {};
    const provider = (q.provider || '').toString().trim().toLowerCase();
    const provider_user_id = (q.provider_user_id || '').toString().trim();
    if (!provider || !provider_user_id) {
      return res.status(400).json({ ok: false, error: 'bad_params' });
    }
    const r = await db.query(
      `select id, user_id, hum_id, provider, provider_user_id, username, meta, created_at, updated_at
       from auth_accounts
       where provider=$1 and provider_user_id=$2
       limit 1`,
      [provider, provider_user_id]
    );
    return res.json({ ok: true, account: r.rows?.[0] || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;

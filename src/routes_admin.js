// src/routes_admin.js
import { Router } from 'express';
import { db, logEvent } from './db.js';

export const adminRouter = Router();

// ──────────────────────────────────────────────────────────────────────────────
// helpers
function int(v, d = 0) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function bool(v) {
  if (typeof v === 'boolean') return v;
  if (v == null) return false;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// МСК-время как now()
const NOW_MSK = `now() at time zone 'Europe/Moscow'`;

// обязательный заголовок для админки (простейшая защита)
adminRouter.use((req, res, next) => {
  // если нужен пароль — раскомментируй и установи ADM_PASS в окружении
  const need = process.env.ADM_PASS;
  if (!need) return next();
  const got = req.get('X-Admin-Password') || '';
  if (got !== need) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
});

// ──────────────────────────────────────────────────────────────────────────────
// health
adminRouter.get('/api/admin/health', async (_req, res) => {
  try {
    await db.query('select 1');
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// summary (карточки сверху): users / events / auth7_total / unique7
adminRouter.get('/api/admin/summary', async (req, res) => {
  try {
    const [{ rows: [u] }, { rows: [e] }, { rows: [a7] }, { rows: [q7] }] = await Promise.all([
      db.query(`select count(*)::int as users from users`),
      db.query(`select count(*)::int as events from events`),
      db.query(`
        select count(*)::int as auth7_total
        from events
        where event_type = 'auth_success'
          and created_at >= (${NOW_MSK}) - interval '7 days'
      `),
      db.query(`
        select count(distinct coalesce(hum_id::text, user_id::text))::int as unique7
        from events
        where event_type = 'auth_success'
          and created_at >= (${NOW_MSK}) - interval '7 days'
      `),
    ]);

    return res.json({
      ok: true,
      users: u?.users ?? 0,
      events: e?.events ?? 0,
      auth7_total: a7?.auth7_total ?? 0,
      unique7: q7?.unique7 ?? 0,
    });
  } catch (err) {
    console.error('summary:', err);
    return res.status(500).json({ ok: false, error: 'summary_error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// users (таблица)
// q: take, skip, search
adminRouter.get('/api/admin/users', async (req, res) => {
  const take = clamp(int(req.query.take, 25), 1, 200);
  const skip = clamp(int(req.query.skip, 0), 0, 1000000);
  const search = (req.query.search || '').toString().trim();

  // Поиск: по имени/фамилии, по user_id / hum_id, по provider_user_id (vk/tg и т.д.)
  const params = [];
  let where = 'true';
  if (search) {
    params.push(search, `%${search}%`, `%${search}%`);
    where = `
      (
        cast(u.id as text) = $1
        or cast(u.hum_id as text) = $1
        or u.first_name ilike $2
        or u.last_name  ilike $3
        or exists(
          select 1 from auth_accounts aa2
          where aa2.user_id = u.id
            and (aa2.provider_user_id = $1 or aa2.provider_user_id ilike $2)
        )
      )
    `;
  }

  // агрегируем провайдеров и берём «визитку» vk/tg для удобного отображения
  const sql = `
    with agg as (
      select
        u.id as user_id,
        u.hum_id,
        u.first_name,
        u.last_name,
        u.balance,
        coalesce(nullif(u.country_name,''), u.country_code) as country,
        u.created_at,
        array_remove(array_agg(distinct aa.provider)
          filter (where aa.provider is not null), null) as providers,
        max(case when aa.provider='vk' then aa.provider_user_id end)   as vk_id,
        max(case when aa.provider='tg' then 'tg:'||aa.provider_user_id end) as tg_id
      from users u
      left join auth_accounts aa on aa.user_id = u.id
      where ${where}
      group by u.id
      order by u.created_at desc
      limit ${take} offset ${skip}
    )
    select
      user_id as id,
      hum_id,
      first_name, last_name,
      balance,
      country,
      created_at,
      providers,
      coalesce(vk_id, tg_id) as vk_id
    from agg
  `;

  try {
    const { rows } = await db.query(sql, params);
    return res.json({ ok: true, users: rows });
  } catch (err) {
    console.error('users:', err);
    return res.status(500).json({ ok: false, error: 'users_error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// events (таблица)
// q: take, skip, type / event_type, user_id
adminRouter.get('/api/admin/events', async (req, res) => {
  const take = clamp(int(req.query.take, 50), 1, 500);
  const skip = clamp(int(req.query.skip, 0), 0, 1000000);
  const type = (req.query.type || req.query.event_type || '').toString().trim();
  const userId = (req.query.user_id || '').toString().trim();

  const params = [];
  const cond = ['true'];

  if (type) {
    params.push(type);
    cond.push(`event_type = $${params.length}`);
  }
  if (userId) {
    params.push(int(userId));
    cond.push(`user_id = $${params.length}`);
  }

  const sql = `
    select
      id,
      hum_id,
      user_id,
      event_type,
      (payload->>'type') as type,
      ip::text as ip,
      ua,
      created_at
    from events
    where ${cond.join(' and ')}
    order by created_at desc
    limit ${take} offset ${skip}
  `;

  try {
    const { rows } = await db.query(sql, params);
    return res.json({ ok: true, events: rows });
  } catch (err) {
    console.error('events:', err);
    return res.status(500).json({ ok: false, error: 'events_error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// metrics: 7 days (нижний график)
adminRouter.get('/api/admin/metrics/7d', async (_req, res) => {
  try {
    const { rows } = await db.query(`
      with days as (
        select generate_series(
          date_trunc('day', (${NOW_MSK}) - interval '6 days'),
          date_trunc('day', ${NOW_MSK}),
          interval '1 day'
        )::date d
      )
      select
        d::text as day,
        coalesce((
          select count(distinct coalesce(hum_id::text, user_id::text))
          from events
          where event_type='auth_success'
            and created_at >= d
            and created_at <  d + interval '1 day'
        ), 0)::int as uniques
      from days
      order by day
    `);

    const labels = rows.map(r => r.day);
    const data = rows.map(r => r.uniques);
    return res.json({
      ok: true,
      labels,
      series: [
        { name: 'Уникальные', data }
      ],
      note: `Период: ${labels[0]} — ${labels[labels.length - 1]} (МСК)`,
    });
  } catch (err) {
    console.error('metrics/7d:', err);
    return res.status(500).json({ ok: false, error: 'metrics_7d_error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// metrics: range (верхний график + пресеты 7/30/90/365/всё)
// q: from=YYYY-MM-DD, to=YYYY-MM-DD, include_analytics=0/1
adminRouter.get('/api/admin/metrics/range', async (req, res) => {
  try {
    // границы
    const from = (req.query.from || '').toString().slice(0, 10);
    const to   = (req.query.to   || '').toString().slice(0, 10);
    const includeAnalytics = bool(req.query.include_analytics);

    // если границы не заданы — показываем последние 31 день
    const { rows: base } = await db.query(`
      with bounds as (
        select
          coalesce(nullif($1,''), ((${NOW_MSK})::date - interval '30 days')::date)::date as dfrom,
          coalesce(nullif($2,''), ((${NOW_MSK})::date)::date)::date as dto
      ),
      days as (
        select generate_series(
          (select dfrom from bounds),
          (select dto   from bounds),
          interval '1 day'
        )::date d
      )
      select d::text as day from days order by day
    `, [from, to]);

    // считаем авторизации по дням
    const { rows: met } = await db.query(`
      with bounds as (
        select
          coalesce(nullif($1,''), ((${NOW_MSK})::date - interval '30 days')::date)::date as dfrom,
          coalesce(nullif($2,''), ((${NOW_MSK})::date)::date)::date as dto
      ),
      agg as (
        select
          date_trunc('day', created_at)::date as d,
          count(*)::int as total,
          count(distinct coalesce(hum_id::text, user_id::text))::int as uniques
        from events
        where event_type='auth_success'
          and created_at >= (select dfrom from bounds)
          and created_at <  (select dto   from bounds) + interval '1 day'
        group by 1
      )
      select d::text as day, total, uniques
      from agg
    `, [from, to]);

    const byDay = new Map(met.map(r => [r.day, r]));
    const labels = base.map(r => r.day);
    const total = labels.map(d => (byDay.get(d)?.total ?? 0));
    const uniq  = labels.map(d => (byDay.get(d)?.uniques ?? 0));

    return res.json({
      ok: true,
      labels,
      series: [
        { name: 'Авторизаций', data: total },
        { name: 'Уникальные',  data: uniq  },
      ],
      include_analytics: includeAnalytics ? 1 : 0,
      note: `Период: ${labels[0]} — ${labels[labels.length - 1]} (МСК)`,
    });
  } catch (err) {
    console.error('metrics/range:', err);
    return res.status(500).json({ ok: false, error: 'metrics_range_error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ручное пополнение (как было)
adminRouter.post('/api/admin/users/:id/topup', async (req, res) => {
  const userId = int(req.params.id);
  const amount = int(req.body?.amount, 0);

  if (!userId || !amount) {
    return res.status(400).json({ ok: false, error: 'bad_params' });
  }
  try {
    await db.query('begin');
    await db.query(
      `update users set balance = coalesce(balance,0) + $1, updated_at = now() where id = $2`,
      [amount, userId]
    );
    await db.query(
      `insert into events(user_id, hum_id, event_type, amount, payload)
       values ($1, (select hum_id from users where id=$1), 'admin_topup', $2, $3)`,
      [userId, amount, { source: 'admin' }]
    );
    await db.query('commit');
    res.json({ ok: true });
  } catch (err) {
    await db.query('rollback').catch(() => {});
    console.error('topup:', err);
    res.status(500).json({ ok: false, error: 'topup_error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Склейка «предложения» — заглушка (оставь свою реализацию, если она уже есть)
adminRouter.get('/api/admin/users/merge/suggestions', async (_req, res) => {
  // здесь может быть твоя логика автосклейки по эвристикам
  res.json({ ok: true, merged: 0 });
});

export default adminRouter;

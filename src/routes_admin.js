// src/routes_admin.js — add providers[] for users + keep robust behavior
import { Router } from 'express';
import { db } from './db.js';
import { mergeSuggestions } from './merge.js';

const router = Router();

function adminAuth(req, res, next) {
  const serverPass = (process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || '').toString();
  const given = (req.get('X-Admin-Password') || (req.body && req.body.pwd) || req.query.pwd || '').toString();
  if (!serverPass) return res.status(401).json({ ok:false, error:'admin_password_not_set' });
  if (given !== serverPass) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
}
router.use(adminAuth);

router.get('/health', (_req, res) => res.json({ ok:true }));

router.get('/summary', async (_req, res) => {
  try {
    const u = await db.query('select count(*)::int as c from users');
    let users = u.rows[0]?.c ?? 0;

    const hasT = await db.query("select to_regclass('public.events') as r");
    if (!hasT.rows[0].r) return res.json({ ok:true, users, events:0, auth7:0, unique7:0 });

    const cols = await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='events'");
    const set = new Set(cols.rows.map(r => r.column_name));
    const hasType = set.has('type');
    const hasEventType = set.has('event_type');

    const e = await db.query('select count(*)::int as c from events');
    const events = e.rows[0]?.c ?? 0;

    let auth7 = 0;
    if (hasType || hasEventType) {
      const parts = [];
      if (hasEventType) parts.push("event_type in ('auth','login','auth_start','auth_callback')");
      if (hasType)      parts.push('\"type\" in (\'auth\',\'login\',\'auth_start\',\'auth_callback\')');
      const sql = 'select count(*)::int as c from events where (' + parts.join(' or ') + ") and created_at > now() - interval '7 days'";
      const r = await db.query(sql);
      auth7 = r.rows[0]?.c ?? 0;
    }

    const uq = await db.query("select count(distinct u.hum_id)::int as c from events e join users u on u.id = e.user_id where e.created_at > now() - interval '7 days'");
    const unique7 = uq.rows[0]?.c ?? 0;

    res.json({ ok:true, users, events, auth7, unique7 });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

// Ежедневная сводка для графика: /api/admin/summary/daily?days=7
router.get('/summary/daily', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(31, parseInt(req.query.days || '7', 10) || 7));
    const TZ = process.env.ADMIN_TZ || 'Europe/Moscow';

    // Узнаем, какие колонки есть в events
    const cols = await db.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='events'"
    );
    const have = new Set(cols.rows.map(r => r.column_name));
    const hasType = have.has('type');
    const hasEventType = have.has('event_type');
    const hasCreatedAt = have.has('created_at');
    const hasUserId = have.has('user_id');

    if (!hasCreatedAt || !hasUserId) {
      // Без ключевых полей сводку не посчитаем — вернём окно из нулей
      const today = new Date();
      today.setHours(0,0,0,0);
      const out = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today); d.setDate(today.getDate() - i);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2,'0');
        const dd = String(d.getDate()).padStart(2,'0');
        out.push({ date: `${y}-${m}-${dd}`, auth: 0, unique: 0 });
      }
      return res.json({ ok: true, days: out });
    }

    // Фильтр "события авторизации"
    const authFilters = [];
    // те же типы, что ты считаешь в summary
    const AUTH_SET = `('auth_success')`;
    if (hasEventType) authFilters.push(`event_type in ${AUTH_SET}`);
    if (hasType)      authFilters.push(`"type" in ${AUTH_SET}`);
    // если нет ни одной типовой колонки — просто считаем 0 авторизаций
    const AUTH_WHERE = authFilters.length ? '(' + authFilters.join(' or ') + ')' : 'false';

    // Формируем SQL: окно дней, сегодня включительно, сегодня справа.
    const sql = `
      with bounds as (
        select (date_trunc('day', (now() at time zone $2))::date) as today
      ),
      days as (
        -- генерируем последовательность старейший..сегодня
        select (select today from bounds) - s as day
        from generate_series($1::int - 1, 0, -1) s
        order by day asc
      ),
      agg_auth as (
        select
          (created_at at time zone $2)::date as day,
          count(*) as auth
        from events
        where ${AUTH_WHERE}
          and created_at >= ((select today from bounds)::timestamp - ($1::int - 1) * interval '1 day')
        group by 1
      ),
      agg_uniq as (
        select
          (e.created_at at time zone $2)::date as day,
          count(distinct u.hum_id) as uniq
        from events e
        join users u on u.id = e.user_id
        where e.created_at >= ((select today from bounds)::timestamp - ($1::int - 1) * interval '1 day')
        group by 1
      ),
      uniq as (
        select date_trunc('day', created_at) as d, count(distinct user_id)::int as c
          from events
         group by 1
      )
      select to_char(days.d, 'YYYY-MM-DD') as day,
             coalesce(auth.c, 0)   as auth,
             coalesce(uniq.c, 0)   as uniq
        from days
        left join auth on auth.d = days.d
        left join uniq on uniq.d = days.d
       order by days.d;
    `;

    const r = await db.query(sql, [days]);
    const labels = r.rows.map(x => x.day);
    const auth   = r.rows.map(x => x.auth);
    const unique = r.rows.map(x => x.uniq);

    res.json({ ok:true, labels, auth, unique });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

export default router;

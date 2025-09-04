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

    const uq = await db.query("select count(distinct user_id)::int as c from events where created_at > now() - interval '7 days'");
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
          (created_at at time zone $2)::date as day,
          count(distinct user_id) as uniq
        from events
        where created_at >= ((select today from bounds)::timestamp - ($1::int - 1) * interval '1 day')
        group by 1
      )
      select
        to_char(d.day, 'YYYY-MM-DD') as date,
        coalesce(a.auth, 0) as auth,
        coalesce(u.uniq, 0) as "unique"
      from days d
      left join agg_auth a on a.day = d.day
      left join agg_uniq u on u.day = d.day
      order by d.day asc;
    `;

    const { rows } = await db.query(sql, [days, TZ]);
    res.json({ ok: true, days: rows });
  } catch (e) {
    console.error('summary/daily error:', e);
    res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
});

// USERS with providers list
router.get('/users', async (req, res) => {
  try {
    const search = (req.query.search || '').toString().trim();
    const limit  = Math.min(100, parseInt(req.query.limit || '50', 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);

    const params = [];
    function add(v){ params.push(v); return '$' + params.length; }

    let where = "where coalesce(u.meta->>'merged_into','') = ''";
    if (search) {
      const p = add('%' + search + '%');
      where += ' and (cast(u.vk_id as text) ilike ' + p + ' or u.first_name ilike ' + p + ' or u.last_name ilike ' + p + ')';
    }

    const sql = [
      'select u.id, u.vk_id, u.first_name, u.last_name, u.avatar, u.balance,',
      '       u.country_code, u.country_name, u.created_at, u.updated_at,',
      '       coalesce(array_agg(distinct aa.provider) filter (where aa.user_id is not null), \'{}\') as providers',
      '  from users u',
      '  left join auth_accounts aa on aa.user_id = u.id',
      where,
      ' group by u.id, u.vk_id, u.first_name, u.last_name, u.avatar, u.balance, u.country_code, u.country_name, u.created_at, u.updated_at',
      ' order by u.id desc',
      ' limit ' + add(limit) + ' offset ' + add(offset)
    ].join('\n');

    const r = await db.query(sql, params);
    res.json({ ok:true, users:r.rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

router.get('/events', async (req, res) => {
  try {
    const cols = await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='events'");
    const set = new Set(cols.rows.map(r => r.column_name));
    const hasType = set.has('type');
    const hasEventType = set.has('event_type');
    const hasIp = set.has('ip');
    const hasUa = set.has('ua');
    const hasCreated = set.has('created_at');

    const params = [];
    function add(v){ params.push(v); return '$' + params.length; }

    const selectCols = ['id', 'user_id'];
    if (hasEventType) selectCols.push('event_type'); else selectCols.push("NULL::text as event_type");
    if (hasType)      selectCols.push('\"type\"'); else selectCols.push("NULL::text as type");
    if (hasIp) selectCols.push('ip'); else selectCols.push("NULL::text as ip");
    if (hasUa) selectCols.push('ua'); else selectCols.push("NULL::text as ua");
    if (hasCreated) selectCols.push('created_at'); else selectCols.push('now() as created_at');

    const conds = [];
    const type = (req.query.type || '').toString().trim();
    const event_type = (req.query.event_type || '').toString().trim();
    const user_id = parseInt((req.query.user_id || '').toString(), 10) || null;
    const ip = (req.query.ip || '').toString().trim();
    const ua = (req.query.ua || '').toString().trim();

    if (type && hasType)            conds.push('\"type\" = ' + add(type));
    if (event_type && hasEventType) conds.push('event_type = ' + add(event_type));
    if (user_id) {
      // Map secondary user to its primary (merged_into) for event filtering
      let rootId = parseInt(user_id, 10) || 0;
      if (rootId) {
        try {
          const q = await db.query("select coalesce(nullif(u.meta->>'merged_into','')::int, u.id) as root_id from users u where u.id=$1", [rootId]);
          if (q.rows && q.rows[0] && q.rows[0].root_id) rootId = q.rows[0].root_id;
        } catch {}
      }
      conds.push('user_id = ' + add(rootId));
    }
    if (ip && hasIp)                conds.push('ip = ' + add(ip));
    if (ua && hasUa)                conds.push('ua ilike ' + add('%' + ua + '%'));

    const where = conds.length ? (' where ' + conds.join(' and ')) : '';

    const limit  = Math.min(200, parseInt(req.query.limit || '50', 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);

    const sql = 'select ' + selectCols.join(', ') + ' from events' + where + ' order by id desc limit ' + add(limit) + ' offset ' + add(offset);
    const r = await db.query(sql, params);
    res.json({ ok:true, events:r.rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

router.post('/users/:id/topup', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const amount = parseInt((req.body && req.body.amount) || '0', 10) || 0;
    if (!id || !Number.isFinite(amount)) return res.status(400).json({ ok:false, error:'bad_args' });
    await db.query('update users set balance = coalesce(balance,0) + $1 where id=$2', [amount, id]);
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

router.post('/users/merge', async (req, res) => {
  try {
    const primaryId = parseInt((req.body && req.body.primary_id) || (req.query && req.query.primary_id) || '0', 10);
    const secondaryId = parseInt((req.body && req.body.secondary_id) || (req.query && req.query.secondary_id) || '0', 10);
    if (!primaryId || !secondaryId || primaryId === secondaryId) return res.status(400).json({ ok:false, error:'bad_args' });

    await db.query("alter table users add column if not exists meta jsonb default '{}'::jsonb");

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('update auth_accounts set user_id=$1 where user_id=$2', [primaryId, secondaryId]);
      try { await client.query('update transactions set user_id=$1 where user_id=$2', [primaryId, secondaryId]); } catch {}
      try { await client.query('update events set user_id=$1 where user_id=$2', [primaryId, secondaryId]); } catch {}
      await client.query('update users u set balance = coalesce(u.balance,0) + (select coalesce(balance,0) from users where id=$2) where id=$1', [primaryId, secondaryId]);
      await client.query(
        "update users p set first_name = coalesce(nullif(p.first_name,''), s.first_name), last_name = coalesce(nullif(p.last_name,''), s.last_name), username = coalesce(nullif(p.username,''), s.username), avatar = coalesce(nullif(p.avatar,''), s.avatar), country_code = coalesce(nullif(p.country_code,''), s.country_code) from users s where p.id=$1 and s.id=$2",
        [primaryId, secondaryId]
      );
      await client.query("update users set balance=0, meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{merged_into}', to_jsonb($1)::jsonb), updated_at=now() where id=$2", [primaryId, secondaryId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally {
      client.release();
    }
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

router.get('/users/merge/suggestions', async (_req, res) => {
  try {
    const list = await mergeSuggestions(200);
    res.json({ ok:true, list });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});
// --- DAILY STATS (alias: /summary/daily и /daily) ---
router.get(['/summary/daily', '/daily'], async (req, res) => {
  try {
    const days = Math.max(1, Math.min(31, parseInt(req.query.days || '7', 10) || 7));

    // Таблица events может не существовать – быстро выходим нулями
    const hasT = await db.query("select to_regclass('public.events') as r");
    if (!hasT.rows[0].r) {
      const labels = Array.from({ length: days }, (_, i) => {
        const d = new Date(); d.setDate(d.getDate() - (days - 1 - i));
        return d.toISOString().slice(0,10); // YYYY-MM-DD
      });
      return res.json({ ok:true, labels, auth:Array(days).fill(0), unique:Array(days).fill(0) });
    }

    // Определяем, какие поля в events есть
    const cols = await db.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='events'"
    );
    const set = new Set(cols.rows.map(r => r.column_name));
    const hasType      = set.has('type');
    const hasEventType = set.has('event_type');
    const hasCreated   = set.has('created_at');

    if (!hasCreated) {
      const labels = Array.from({ length: days }, (_, i) => {
        const d = new Date(); d.setDate(d.getDate() - (days - 1 - i));
        return d.toISOString().slice(0,10);
      });
      return res.json({ ok:true, labels, auth:Array(days).fill(0), unique:Array(days).fill(0) });
    }

    const parts = [];
    if (hasEventType) parts.push("event_type in ('auth','login','auth_start','auth_callback')");
    if (hasType)      parts.push(' "type" in (\'auth\',\'login\',\'auth_start\',\'auth_callback\') ');
    const authCond = parts.length ? '(' + parts.join(' or ') + ')' : 'true';

    // Собираем последнюю неделю с нулями через generate_series
    const sql = `
      with days as (
        select generate_series(date_trunc('day', now()) - ($1::int - 1) * interval '1 day',
                               date_trunc('day', now()),
                               interval '1 day') as d
      ),
      auth as (
        select date_trunc('day', created_at) as d, count(*)::int as c
          from events
         where ${authCond}
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

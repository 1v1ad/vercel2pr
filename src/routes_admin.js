// src/routes_admin.js
import { Router } from 'express';
import { db } from './db.js';
import { mergeSuggestions, mergeUsers, resolvePrimaryUserId } from './merge.js';

const router = Router();

// --- простая админ-авторизация через заголовок ---
function adminAuth(req, res, next) {
  const serverPass = (process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || '').toString();
  const given = (req.get('X-Admin-Password') || (req.body && req.body.pwd) || req.query.pwd || '').toString();
  if (!serverPass) return res.status(401).json({ ok:false, error:'admin_password_not_set' });
  if (given !== serverPass) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
}
router.use(adminAuth);

// --- ping ---
router.get('/health', (_req, res) => res.json({ ok:true }));

// --- суммарка для «плиток» (users, events, auth7, unique7) ---
router.get('/summary', async (_req, res) => {
  try {
    const u = await db.query(`select count(*)::int as c from users`);
    const users = u.rows[0]?.c ?? 0;

    // есть ли events
    const hasT = await db.query(`select to_regclass('public.events') as r`);
    if (!hasT.rows[0].r) {
      return res.json({ ok:true, users, events:0, auth7:0, unique7:0 });
    }

    // какие колонки есть у events
    const cols = await db.query(
      `select column_name
         from information_schema.columns
        where table_schema='public' and table_name='events'`
    );
    const set = new Set(cols.rows.map(r => r.column_name));
    const hasType      = set.has('type');
    const hasEventType = set.has('event_type');

    const e = await db.query(`select count(*)::int as c from events`);
    const events = e.rows[0]?.c ?? 0;

    // авторизации за 7 дней (тип может называться по-разному)
    let auth7 = 0;
    if (hasType || hasEventType) {
      const parts = [];
      if (hasEventType) parts.push(`event_type in ('auth','login','auth_start','auth_callback')`);
      if (hasType)      parts.push(`"type" in ('auth','login','auth_start','auth_callback')`);
      const sql = `
        select count(*)::int as c
          from events
         where (${parts.join(' or ')})
           and created_at > now() - interval '7 days'
      `;
      const r = await db.query(sql);
      auth7 = r.rows[0]?.c ?? 0;
    }

    const uq = await db.query(
      `select count(distinct user_id)::int as c
         from events
        where created_at > now() - interval '7 days'`
    );
    const unique7 = uq.rows[0]?.c ?? 0;

    res.json({ ok:true, users, events, auth7, unique7 });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

// --- «плитка» с графиком: единый обработчик + алиас ---
async function handleDaily(req, res) {
  try {
    const days = Math.min(60, Math.max(1, parseInt(req.query.days || '7', 10) || 7));

    const hasT = await db.query(`select to_regclass('public.events') as r`);
    if (!hasT.rows[0].r) return res.json({ ok:true, series: [] });

    const cols = await db.query(
      `select column_name
         from information_schema.columns
        where table_schema='public' and table_name='events'`
    );
    const set = new Set(cols.rows.map(r => r.column_name));
    const hasType      = set.has('type');
    const hasEventType = set.has('event_type');

    const authFilterParts = [];
    if (hasEventType) authFilterParts.push(`event_type in ('auth','login','auth_start','auth_callback')`);
    if (hasType)      authFilterParts.push(`"type" in ('auth','login','auth_start','auth_callback')`);
    const authFilter = authFilterParts.length ? `(${authFilterParts.join(' OR ')})` : 'false';

    // сегодня справа; генерим дни и слева-join'им агрегацию
    const sql = `
      with d as (
        select generate_series(
          date_trunc('day', now()) - ($1::int - 1) * interval '1 day',
          date_trunc('day', now()),
          interval '1 day'
        ) as day
      ),
      e as (
        select date_trunc('day', created_at) as d,
               count(*) filter (where ${authFilter})         as auth_cnt,
               count(distinct user_id)                       as uniq_cnt
          from events
         where created_at >= date_trunc('day', now()) - ($1::int - 1) * interval '1 day'
         group by 1
      )
      select to_char(d.day, 'Dy.DD.MM') as label,
             coalesce(e.auth_cnt, 0)::int  as auth,
             coalesce(e.uniq_cnt, 0)::int  as unique
        from d
        left join e on e.d = d.day
       order by d.day
    `;
    const r = await db.query(sql, [days]);
    res.json({ ok:true, series: r.rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
}
router.get('/daily', handleDaily);
router.get('/summary/daily', handleDaily); // алиас под старый URL фронта

// --- список пользователей с провайдерами, скрываем «слившихся» в primary ---
router.get('/users', async (req, res) => {
  try {
    const search = (req.query.search || '').toString().trim();
    const limit  = Math.min(100, parseInt(req.query.limit || '50', 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);

    const params = [];
    const add = v => { params.push(v); return `$${params.length}`; };

    // показываем только тех, кто НЕ помечен merged_into (пусто или null)
    let where = ` where coalesce(u.meta->>'merged_into','') = ''`;
    if (search) {
      const p = add(`%${search}%`);
      where += ` and (
        cast(u.vk_id as text) ilike ${p}
        or u.first_name ilike ${p}
        or u.last_name  ilike ${p}
      )`;
    }

    const sql = `
      select
         u.id, u.vk_id, u.first_name, u.last_name, u.avatar, u.balance,
         u.country_code, u.country_name, u.created_at, u.updated_at,
         coalesce(
           array_agg(distinct aa.provider) filter (where aa.user_id is not null),
           '{}'::text[]
         ) as providers
      from users u
      left join auth_accounts aa on aa.user_id = u.id
      ${where}
      group by u.id, u.vk_id, u.first_name, u.last_name, u.avatar, u.balance,
               u.country_code, u.country_name, u.created_at, u.updated_at
      order by u.id desc
      limit ${add(limit)} offset ${add(offset)}
    `;

    const r = await db.query(sql, params);
    res.json({ ok:true, users:r.rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

// --- список событий (толерантен к разной схеме таблицы) ---
router.get('/events', async (req, res) => {
  try {
    const cols = await db.query(
      `select column_name
         from information_schema.columns
        where table_schema='public' and table_name='events'`
    );
    const set = new Set(cols.rows.map(r => r.column_name));
    const hasType      = set.has('type');
    const hasEventType = set.has('event_type');
    const hasIp        = set.has('ip');
    const hasUa        = set.has('ua');
    const hasCreated   = set.has('created_at');

    const params = [];
    const add = v => { params.push(v); return `$${params.length}`; };

    const selectCols = ['id', 'user_id'];
    if (hasEventType) selectCols.push('event_type'); else selectCols.push(`NULL::text as event_type`);
    if (hasType)      selectCols.push(`"type"`);    else selectCols.push(`NULL::text as type`);
    if (hasIp)        selectCols.push('ip');        else selectCols.push(`NULL::text as ip`);
    if (hasUa)        selectCols.push('ua');        else selectCols.push(`NULL::text as ua`);
    if (hasCreated)   selectCols.push('created_at'); else selectCols.push('now() as created_at');

    const conds = [];
    const type       = (req.query.type || '').toString().trim();
    const event_type = (req.query.event_type || '').toString().trim();
    const user_id    = parseInt((req.query.user_id || '').toString(), 10) || null;
    const ip         = (req.query.ip || '').toString().trim();
    const ua         = (req.query.ua || '').toString().trim();

    if (type && hasType)            conds.push(`"type" = ${add(type)}`);
    if (event_type && hasEventType) conds.push(`event_type = ${add(event_type)}`);
    if (user_id)                    conds.push(`user_id = ${add(user_id)}`);
    if (ip && hasIp)                conds.push(`ip = ${add(ip)}`);
    if (ua && hasUa)                conds.push(`ua ilike ${add(`%${ua}%`)}`);

    const where = conds.length ? ` where ${conds.join(' and ')}` : '';

    const limit  = Math.min(200, parseInt(req.query.limit || '50', 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);

    const sql = `
      select ${selectCols.join(', ')}
        from events
        ${where}
       order by id desc
       limit ${add(limit)} offset ${add(offset)}
    `;

    const r = await db.query(sql, params);
    res.json({ ok:true, events:r.rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

// --- пополнение баланса ---
router.post('/users/:id/topup', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const amount = parseInt((req.body && req.body.amount) || '0', 10) || 0;
    if (!id || !Number.isFinite(amount)) return res.status(400).json({ ok:false, error:'bad_args' });
    await db.query(`update users set balance = coalesce(balance,0) + $1 where id=$2`, [amount, id]);
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

// --- ручная склейка в админке ---
router.post('/users/merge', async (req, res) => {
  try {
    const primaryId   = parseInt((req.body && req.body.primary_id)   || (req.query && req.query.primary_id)   || '0', 10);
    const secondaryId = parseInt((req.body && req.body.secondary_id) || (req.query && req.query.secondary_id) || '0', 10);
    if (!primaryId || !secondaryId || primaryId === secondaryId) {
      return res.status(400).json({ ok:false, error:'bad_args' });
    }

    // нормализуем primary через цепочку merged_into (на случай повторной склейки)
    const canonicalPrimary = await resolvePrimaryUserId(primaryId);
    await mergeUsers(canonicalPrimary, secondaryId);

    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

// --- подсказки для склейки (по device_id) ---
router.get('/users/merge/suggestions', async (_req, res) => {
  try {
    const list = await mergeSuggestions(200);
    res.json({ ok:true, list });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

export default router;

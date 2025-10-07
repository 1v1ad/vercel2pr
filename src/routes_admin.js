// routes_admin.esm.v3.js
// Админка GGRoom — устойчивый клиент для /admin/* API
// Сохраняет URL и пароль в localStorage, рендерит счётчики, таблицы и графики,
// терпимо относится к разным формам ответа бэка и к временным 500/404.

// -------------------- helpers: dom --------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const txt = (v) => (v == null ? '' : String(v));
const asInt = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const els = {
  service: $('#service') || $('#api') || $('input[name=service]'),
  pwd: $('#pwd') || $('#password') || $('input[name=pwd]'),
  mergeAllBtn: $('#btn-merge-all') || $('#mergeAll') || $('[data-action="merge-all"]'),
  topupBtn: $('#btn-topup') || $('#topupBtn') || $('[data-action="topup"]'),
  topupUser: $('#topup_user') || $('#user_id') || $('input[name="user_id"]'),
  topupAmount: $('#topup_amount') || $('#amount') || $('input[name="amount"]'),
  usersTbody: $('#users_tbody') || $('#usersTable tbody') || $('#users tbody'),
  eventsTbody: $('#events_tbody') || $('#eventsTable tbody') || $('#events tbody'),
  usersSearch: $('#users_search') || $('#user_search') || $('input[name="user_search"]'),
  usersReload: $('#users_reload') || $('#reload_users') || $('[data-action="reload-users"]'),
  eventsType: $('#events_type') || $('#etype') || $('select[name="event_type"]'),
  eventsUserId: $('#events_user_id') || $('input[name="events_user_id"]'),
  eventsReload: $('#events_reload') || $('[data-action="reload-events"]'),
  kUsers: $('#k_users') || $('[data-counter="users"]'),
  kEvents: $('#k_events') || $('[data-counter="events"]'),
  kUniques: $('#k_uniques7') || $('[data-counter="uniques7"]'),
  chartCanvas: $('#chart_daily') || $('#dailyChart') || $('canvas[data-chart="daily"]'),
  flash: $('#flash') || $('[data-ui="flash"]'),
};

const LS_KEYS = { service: 'adm_service', pwd: 'adm_pwd' };

// -------------------- helpers: state --------------------
function getService() {
  return (els.service?.value || localStorage.getItem(LS_KEYS.service) || '').trim().replace(/\/+$/, '');
}
function getPwd() {
  return (els.pwd?.value || localStorage.getItem(LS_KEYS.pwd) || '').trim();
}
function saveAuth() {
  if (els.service) localStorage.setItem(LS_KEYS.service, els.service.value.trim());
  if (els.pwd) localStorage.setItem(LS_KEYS.pwd, els.pwd.value.trim());
}

// -------------------- helpers: api --------------------
async function apiTry(paths, { method = 'GET', body } = {}) {
  const base = getService();
  if (!base) throw new Error('Не указан URL сервиса');
  let lastErr;
  for (const p of paths) {
    const url = base + p;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
          'X-Admin-Password': getPwd(),
        },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });
      // 204 — тоже ок
      if (res.status === 204) return { ok: true };
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await res.json() : await res.text();

      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} @ ${p}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
        continue;
      }
      return data;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr ?? new Error('Нет доступных эндпоинтов');
}

const API = {
  summary: (days = 7) =>
    apiTry([`/admin/summary?days=${days}`, `/api/admin/summary?days=${days}`, `/admin/stats?days=${days}`]),
  users: (params = {}) => {
    const { take = 50, skip = 0, search = '' } = params;
    const qs = `?take=${take}&skip=${skip}&search=${encodeURIComponent(search)}`;
    return apiTry([`/admin/users${qs}`, `/api/admin/users${qs}`]);
  },
  events: (params = {}) => {
    const { take = 50, skip = 0, type = '', user_id = '', search = '' } = params;
    // сервер в наших версиях понимает именно 'type' и 'user_id'
    const qs = `?take=${take}&skip=${skip}&type=${encodeURIComponent(type)}&user_id=${encodeURIComponent(
      user_id
    )}&search=${encodeURIComponent(search)}`;
    return apiTry([`/admin/events${qs}`, `/api/admin/events${qs}`]);
  },
  daily: (days = 7) =>
    apiTry([`/admin/daily?days=${days}`, `/api/admin/daily?days=${days}`, `/admin/stats/daily?days=${days}`]),
  mergeScan: () => apiTry(['/admin/merge/scan', '/api/admin/merge/scan', '/admin/merge-scan'], { method: 'POST' }),
  mergeAll: () => apiTry(['/admin/merge/apply-all', '/api/admin/merge/apply-all', '/admin/merge-all'], { method: 'POST' }),
  topup: (user_id, amount) =>
    apiTry(['/admin/topup', '/api/admin/topup'], { method: 'POST', body: { user_id, amount: asInt(amount) } }),
  health: () => apiTry(['/admin/health', '/api/admin/health']).catch(() => ({ ok: false })),
};

// -------------------- helpers: ui --------------------
function flash(msg, kind = 'info', ms = 2500) {
  console[kind === 'error' ? 'error' : 'log']('[flash]', msg);
  if (!els.flash) return;
  els.flash.textContent = txt(msg);
  els.flash.dataset.kind = kind;
  els.flash.hidden = false;
  clearTimeout(els.flash._t);
  els.flash._t = setTimeout(() => (els.flash.hidden = true), ms);
}

function setCounter(el, v) {
  if (!el) return;
  el.textContent = txt(v);
}

function sanitize(x) {
  return txt(x).replace(/[<>&]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m]));
}

// -------------------- normalize payloads --------------------
function normalizeDailyPayload(payload) {
  // Варианты: [{date,count}], {daily:[…]}, {rows:[…]}, [{d,c}], [{day,cnt}], [{ts,value}]
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.daily)
    ? payload.daily
    : Array.isArray(payload?.rows)
    ? payload.rows
    : Array.isArray(payload?.data)
    ? payload.data
    : [];

  return rows
    .map((r) => {
      const d = r.date ?? r.day ?? r.d ?? r.ts ?? r.t ?? r.when;
      const c = r.count ?? r.cnt ?? r.c ?? r.value ?? r.n ?? r.v;
      return d != null && c != null ? { date: String(d), count: Number(c) } : null;
    })
    .filter(Boolean);
}

function normalizeUsersPayload(payload) {
  // Ожидаем {rows:[…], total:n} или просто массив
  const rows = Array.isArray(payload) ? payload : payload?.rows ?? [];
  return rows.map((u) => ({
    HUMid: u.HUMid ?? u.humid ?? u.hum_id ?? u.hid ?? '',
    user_id: u.user_id ?? u.id ?? '',
    vk_tg: u.provider ?? u.vk_tg ?? u.src ?? '',
    first_name: u.first_name ?? u.name ?? '',
    last_name: u.last_name ?? u.surname ?? '',
    balance: u.balance ?? u.bal ?? 0,
    country: u.country ?? u.cc ?? '',
    created_at: u.created_at ?? u.createdAt ?? u.created ?? '',
    providers: Array.isArray(u.providers) ? u.providers.join(',') : txt(u.providers ?? ''),
  }));
}

function normalizeEventsPayload(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.rows ?? [];
  return rows.map((e) => ({
    id: e.id ?? e.event_id ?? '',
    HUMid: e.HUMid ?? e.humid ?? e.hid ?? '',
    user_id: e.user_id ?? e.uid ?? '',
    type: e.type ?? e.event_type ?? '',
    ip: e.ip ?? '',
    ua: e.ua ?? e.user_agent ?? '',
    created_at: e.created_at ?? e.ts ?? e.time ?? '',
  }));
}

// -------------------- renderers --------------------
function renderUsers(rows) {
  if (!els.usersTbody) return;
  const html = rows
    .map((u) => {
      return `<tr>
        <td>${sanitize(u.HUMid)}</td>
        <td>${sanitize(u.user_id)}</td>
        <td>${sanitize(u.vk_tg)}</td>
        <td>${sanitize(u.first_name)}</td>
        <td>${sanitize(u.last_name)}</td>
        <td class="num">${sanitize(u.balance)}</td>
        <td>${sanitize(u.country)}</td>
        <td>${sanitize(u.created_at)}</td>
        <td>${sanitize(u.providers)}</td>
      </tr>`;
    })
    .join('');
  els.usersTbody.innerHTML = html || `<tr><td colspan="9" class="muted">Пусто</td></tr>`;
}

function renderEvents(rows) {
  if (!els.eventsTbody) return;
  const html = rows
    .map((e) => {
      return `<tr>
        <td>${sanitize(e.id)}</td>
        <td>${sanitize(e.HUMid)}</td>
        <td>${sanitize(e.user_id)}</td>
        <td>${sanitize(e.type)}</td>
        <td>${sanitize(e.ip)}</td>
        <td>${sanitize(e.ua)}</td>
        <td>${sanitize(e.created_at)}</td>
      </tr>`;
    })
    .join('');
  els.eventsTbody.innerHTML = html || `<tr><td colspan="7" class="muted">Нет событий</td></tr>`;
}

let dailyChart;
function renderDailyChart(norm) {
  if (!els.chartCanvas) return;
  const labels = norm.map((r) => r.date);
  const data = norm.map((r) => r.count);

  try {
    if (dailyChart) {
      dailyChart.data.labels = labels;
      dailyChart.data.datasets[0].data = data;
      dailyChart.update();
      return;
    }
    const ctx = els.chartCanvas.getContext('2d');
    dailyChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{ label: 'События в день', data, tension: 0.2 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { display: true }, y: { beginAtZero: true } },
      },
    });
  } catch (e) {
    console.warn('chart init failed:', e);
    flash('График недоступен (нет Chart.js?)', 'error', 4000);
  }
}

// -------------------- load flows --------------------
async function loadSummary() {
  try {
    const s = await API.summary(7);
    // Поддержка разных форм
    const users = s.total_users ?? s.users ?? s.k_users ?? s.total ?? 0;
    const events = s.total_events ?? s.events ?? s.k_events ?? 0;
    const uniques = s.uniques7 ?? s.unique_7d ?? s.uniques ?? 0;
    setCounter(els.kUsers, users);
    setCounter(els.kEvents, events);
    setCounter(els.kUniques, uniques);
  } catch (e) {
    console.warn('summary error:', e);
    // не блокируем интерфейс
  }
}

async function loadUsers() {
  const search = els.usersSearch?.value?.trim() ?? '';
  try {
    const raw = await API.users({ take: 100, skip: 0, search });
    const rows = normalizeUsersPayload(raw);
    renderUsers(rows);
  } catch (e) {
    console.error('users error:', e);
    renderUsers([]);
    flash('Ошибка загрузки пользователей', 'error');
  }
}

async function loadEvents() {
  const type = els.eventsType?.value?.trim() ?? '';
  const user_id = els.eventsUserId?.value?.trim() ?? '';
  try {
    const raw = await API.events({ take: 100, skip: 0, type, user_id, search: '' });
    const rows = normalizeEventsPayload(raw);
    renderEvents(rows);
  } catch (e) {
    console.error('events error:', e);
    renderEvents([]);
    flash('Ошибка загрузки событий', 'error');
  }
}

async function loadDaily() {
  try {
    const raw = await API.daily(7);
    const norm = normalizeDailyPayload(raw);
    if (!norm.length) throw new Error('unrecognized payload shape');
    renderDailyChart(norm);
  } catch (e) {
    console.warn('daily chart error:', e);
    // тихо не рисуем, но не ломаем остальной UI
  }
}

// -------------------- actions --------------------
async function doMergeAll() {
  saveAuth();
  try {
    await API.mergeAll();
    flash('Склейка выполнена', 'info');
    await Promise.all([loadSummary(), loadUsers(), loadEvents()]);
  } catch (e) {
    console.error(e);
    flash('Склейка: ошибка (см. консоль)', 'error', 4000);
  }
}

async function doTopup() {
  saveAuth();
  const uid = els.topupUser?.value?.trim();
  const amt = asInt(els.topupAmount?.value, NaN);
  if (!uid || !Number.isFinite(amt)) {
    flash('Укажите user_id и сумму', 'error');
    return;
  }
  try {
    await API.topup(uid, amt);
    flash('Пополнение выполнено', 'info');
    await loadUsers();
    // События и счётчики часто тоже меняются
    await Promise.all([loadSummary(), loadEvents()]);
  } catch (e) {
    console.error(e);
    flash('Пополнение: ошибка (см. консоль)', 'error', 4000);
  }
}

// -------------------- wiring --------------------
function wire() {
  // начальные значения из LS
  if (els.service && !els.service.value) els.service.value = localStorage.getItem(LS_KEYS.service) || '';
  if (els.pwd && !els.pwd.value) els.pwd.value = localStorage.getItem(LS_KEYS.pwd) || '';

  els.service?.addEventListener('change', saveAuth);
  els.pwd?.addEventListener('change', saveAuth);

  els.usersReload?.addEventListener('click', (e) => {
    e.preventDefault();
    saveAuth();
    loadUsers();
  });
  els.eventsReload?.addEventListener('click', (e) => {
    e.preventDefault();
    saveAuth();
    loadEvents();
  });
  els.mergeAllBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    doMergeAll();
  });
  els.topupBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    doTopup();
  });
}

// -------------------- boot --------------------
(async function boot() {
  try {
    wire();
    // Не стопорим UI даже если /health 404
    await API.health().catch(() => null);
    await Promise.all([loadSummary(), loadUsers(), loadEvents(), loadDaily()]);
  } catch (e) {
    console.error('boot error:', e);
    flash('Ошибка инициализации админки', 'error', 4000);
  }
})();

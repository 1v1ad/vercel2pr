// admin/app.js — shim + users table refresh with flags decoration
(function(){
  function getApi() {
    const api = (window.API || localStorage.getItem('ADMIN_API') || '').toString().trim();
    return api.replace(/\/+$/,''); // strip trailing /
  }
  function getPwd() {
    return (localStorage.getItem('ADMIN_PWD') || '').toString();
  }

  // 1) Headers helper
  window.adminHeaders = function adminHeaders(){
    return { 'X-Admin-Password': getPwd() };
  };

  // 2) Patch fetch: auto-inject X-Admin-Password for {API}/api/admin/*
  const _fetch = window.fetch;
  window.fetch = function patchedFetch(input, init){
    init = init || {};
    let url = '';
    try { url = (typeof input === 'string') ? input : input.url; } catch(_){ url = ''; }

    try {
      const api = getApi();
      if (api && url && url.indexOf(api + '/api/admin') === 0) {
        let headers = init.headers || {};
        const h = new Headers(headers);
        if (!h.has('X-Admin-Password')) h.set('X-Admin-Password', getPwd());
        const obj = {};
        h.forEach((v,k) => { obj[k] = v; });
        init.headers = obj;
      }
    } catch(_){}

    return _fetch(input, init);
  };

  // 3) Small safe helper
  window.toArrayOrEmpty = function(x){ return Array.isArray(x) ? x : []; };

  // ------------------------------
  // USERS TABLE + FLAGS DECORATION
  // ------------------------------
  async function refreshUsers() {
    try {
      const API = (localStorage.getItem('ADMIN_API') || '').toString().trim().replace(/\/+$/, '');
      if (!API) { alert('Укажи API и пароль серверу'); return; }

      const params = new URLSearchParams();
      const q = (document.getElementById('users_search')?.value || '').trim();
      if (q) params.set('search', q);

      const url = API + '/api/admin/users' + (params.toString() ? ('?' + params.toString()) : '');
      const r = await fetch(url, {
        headers: (window.adminHeaders ? window.adminHeaders() : {}),
        cache: 'no-store'
      });
      const data = await r.json().catch(() => ({}));
      if (!data || !data.ok) throw new Error(data && data.error || 'bad_response');

      const users = Array.isArray(data.users) ? data.users : [];
      const tbody = document.getElementById('users_tbody');
      if (!tbody) return;

      tbody.innerHTML = users.map(u => `
        <tr>
          <td>${u.id ?? ''}</td>
          <td>${u.vk_id ?? ''}</td>
          <td>${u.first_name ?? ''}</td>
          <td>${u.last_name ?? ''}</td>
          <td class="right">${u.balance ?? 0}</td>
          <td data-cc="${((u.country_code || '') + '').toUpperCase()}"></td>
          <td>${(u.created_at || '').toString().slice(0,19).replace('T',' ')}</td>
          <td>${Array.isArray(u.providers) ? u.providers.join(', ') : ''}</td>
        </tr>
      `).join('');

      // ДОрисуем флаги для только что вставленных строк
      if (window.decorateFlags) window.decorateFlags(tbody);
    } catch (e) {
      console.error('refreshUsers error:', e);
      alert('Ошибка загрузки пользователей: ' + (e && e.message ? e.message : e));
    }
  }
  window.refreshUsers = refreshUsers;

  // Привяжем кнопку и сделаем автозагрузку таблицы при открытии админки
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('users_refresh');
    if (btn) btn.addEventListener('click', refreshUsers);

    // если на странице есть таблица — подтянем данные сразу
    if (document.getElementById('users_tbody')) refreshUsers();
  });
})();

// admin/admin-auth-headers.js
// Safe shim: auto-add X-Admin-Password to ALL /api/admin requests (absolute or relative).
// Does not touch your existing app logic.

(function(){
  function getApi(){
    const raw = (window.API || localStorage.getItem('ADMIN_API') || '').toString().trim();
    if (raw) return raw.replace(/\/+$/,''); // drop trailing /
    return location.origin;
  }
  function getPwd(){
    return (localStorage.getItem('ADMIN_PWD') || '').toString();
  }

  // Expose helper for manual use if needed
  window.adminHeaders = function adminHeaders(){
    return { 'X-Admin-Password': getPwd() };
  };

  const _fetch = window.fetch;
  window.fetch = function patchedFetch(input, init){
    init = init || {};
    let urlStr = '';
    try { urlStr = (typeof input === 'string') ? input : input.url; } catch(_){ urlStr = ''; }

    // Decide if request targets admin API (absolute or relative)
    try {
      const api = getApi();
      const relPrefix = '/api/admin';
      let isAdmin = false;

      if (urlStr) {
        try {
          const u = new URL(urlStr, location.href);
          // matches {API}/api/admin* or same-origin /api/admin*
          if ((api && u.href.startsWith(api + relPrefix)) ||
              (u.origin === location.origin && u.pathname.startsWith(relPrefix))) {
            isAdmin = true;
          }
        } catch(_) {}
      }

      if (isAdmin) {
        let headers = init.headers || {};
        const h = new Headers(headers);
        if (!h.has('X-Admin-Password')) h.set('X-Admin-Password', getPwd());
        const obj = {};
        h.forEach((v,k)=>{ obj[k]=v; });
        init.headers = obj;
      }
    } catch(_){}

    return _fetch(input, init);
  };
})();

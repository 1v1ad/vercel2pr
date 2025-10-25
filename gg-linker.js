
/*! gg-linker.js v2 — auto-link VK/TG accounts by device_id with explicit API base + logging */
(function () {
  const LS_KEY = 'gg_device_id';
  const COOKIE_NAME = 'device_id';

  function getApiBase() {
    try {
      const ls = localStorage.getItem('api_base');
      if (ls && typeof ls === 'string' && ls.trim()) return ls.trim().replace(/\/+$/, '');
    } catch (_) {}
    if (typeof window !== 'undefined' && window.API_BASE) {
      try { return String(window.API_BASE).trim().replace(/\/+$/, ''); } catch (_) {}
    }
    return '';
  }

  function uuid() {
    try { return crypto.randomUUID(); } catch (_) {
      return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }
  function getDeviceId() {
    let did = null;
    try { did = localStorage.getItem(LS_KEY); } catch(_) {}
    if (!did) {
      did = uuid();
      try { localStorage.setItem(LS_KEY, did); } catch(_) {}
    }
    try {
      const oneYear = 365 * 24 * 3600;
      document.cookie = COOKIE_NAME + "=" + encodeURIComponent(did) + "; path=/; max-age=" + oneYear + "; samesite=lax";
    } catch(_) {}
    return did;
  }

  async function fetchMe(API) {
    const url = (API ? API : '') + "/api/me";
    try {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) { console.warn("[gg-linker] /api/me status", r.status); return null; }
      return await r.json();
    } catch (e) { console.warn("[gg-linker] /api/me error", e); return null; }
  }

  function detectProvider(me) {
    const vk = String(me?.user?.vk_id ?? '');
    if (!vk) return null;
    if (vk.startsWith('tg:')) return { provider: 'tg', id: vk.slice(3) };
    return { provider: 'vk', id: vk };
  }

  async function linkBackground() {
    const API = getApiBase();
    const me = await fetchMe(API);
    if (!me || !me.user) { console.log("[gg-linker] skip: no /api/me user"); return; }
    const info = detectProvider(me);
    if (!info) { console.log("[gg-linker] skip: cannot detect provider"); return; }
    const device_id = getDeviceId();

    const url = (API ? API : '') + "/api/link/background";
    const payload = { provider: info.provider, provider_user_id: info.id, username: null, device_id };
    console.log("[gg-linker] POST", url, payload);
    try {
      const r = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      let body = null;
      try { body = await r.clone().json(); } catch(_) { body = await r.text(); }
      console.log("[gg-linker] response", r.status, body);
    } catch (e) {
      console.error("[gg-linker] link/background error", e);
    }
  }

  function patchLoginLinks() {
    const did = getDeviceId();
    const anchors = Array.from(document.querySelectorAll("a[href*='/api/auth/vk']"));
    anchors.forEach(a => {
      try {
        const href = a.getAttribute("href");
        const url = new URL(href, location.origin);
        if (!url.searchParams.has("device_id")) {
          url.searchParams.set("device_id", did);
          a.setAttribute("href", url.toString());
          console.log("[gg-linker] patched VK href", a.getAttribute("href"));
        }
      } catch(e) { console.warn("[gg-linker] patch href failed", e); }
    });
  }

  window.GG = Object.assign(window.GG || {}, {
    getDeviceId,
    linkAccountsNow: linkBackground,
    ggDebug: { getApiBase }
  });

  console.log("[gg-linker] init: api_base=", getApiBase(), "device_id=", getDeviceId());
  patchLoginLinks();
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(linkBackground, 300);
  } else {
    document.addEventListener("DOMContentLoaded", () => setTimeout(linkBackground, 300));
  }
})();

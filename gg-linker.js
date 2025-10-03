(function () {
  const win = window;
  const doc = document;
  const defaultConfig = win.GG_LINKER_CONFIG || {};
  const API_BASE = defaultConfig.apiBase || '/api';
  const STORAGE_KEY = defaultConfig.storageKey || 'gg:device-id';
  const DEBUG = Boolean(defaultConfig.debug) || new URLSearchParams(location.search).has('gglinker_debug');
  const pending = new Map();
  const history = [];
  let currentDeviceId = null;
  let observer = null;

  function debug(...args) {
    if (DEBUG) {
      console.log('[gg-linker]', ...args);
    }
  }

  function clampHistory() {
    if (history.length > 25) {
      history.splice(0, history.length - 25);
    }
  }

  function readCookie(name) {
    try {
      const token = doc.cookie.split(';').map((s) => s.trim()).find((row) => row.startsWith(name + '='));
      if (!token) return null;
      const value = token.split('=').slice(1).join('=');
      return value ? decodeURIComponent(value) : null;
    } catch (_) {
      return null;
    }
  }

  function setCookie(name, value) {
    const safeValue = encodeURIComponent(value);
    const secureContext = location.protocol === 'https:';
    const sameSite = secureContext ? 'None' : 'Lax';
    const maxAge = 365 * 24 * 3600 * 4; // 4 years
    let cookie = `${name}=${safeValue}; path=/; max-age=${maxAge}; SameSite=${sameSite}`;
    if (secureContext) cookie += '; Secure';
    const extra = defaultConfig.cookieAttributes || {};
    if (extra.domain) cookie += `; domain=${extra.domain}`;
    if (extra.path) cookie += `; path=${extra.path}`;
    if (typeof extra.maxAge === 'number') cookie = cookie.replace(/max-age=\d+/, `max-age=${extra.maxAge}`);
    if (extra.sameSite) cookie = cookie.replace(/SameSite=[^;]+/, `SameSite=${extra.sameSite}`);
    if (extra.secure === true && !cookie.includes('Secure')) cookie += '; Secure';
    doc.cookie = cookie;
  }

  function randomHex(size) {
    const cryptoObj = win.crypto || win.msCrypto;
    if (cryptoObj && cryptoObj.getRandomValues) {
      const bytes = new Uint8Array(size);
      cryptoObj.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    let str = '';
    for (let i = 0; i < size; i += 1) {
      str += Math.floor(Math.random() * 256)
        .toString(16)
        .padStart(2, '0');
    }
    return str;
  }

  function generateDeviceId() {
    if (defaultConfig.deviceIdFactory) {
      try {
        const custom = defaultConfig.deviceIdFactory();
        if (custom) return String(custom);
      } catch (err) {
        debug('deviceIdFactory error', err);
      }
    }
    if (win.crypto && typeof win.crypto.randomUUID === 'function') {
      return win.crypto.randomUUID();
    }
    return `gg-${Date.now().toString(16)}-${randomHex(6)}`;
  }

  function ensureDeviceId() {
    if (currentDeviceId) return currentDeviceId;

    let deviceId = null;
    try {
      deviceId = win.localStorage.getItem(STORAGE_KEY) || null;
    } catch (err) {
      debug('localStorage read failed', err);
    }
    if (!deviceId) {
      deviceId = readCookie('device_id');
    }
    if (!deviceId) {
      deviceId = generateDeviceId();
    }

    try {
      win.localStorage.setItem(STORAGE_KEY, deviceId);
    } catch (err) {
      debug('localStorage write failed', err);
    }
    setCookie('device_id', deviceId);

    currentDeviceId = deviceId;
    win.GG_DEVICE_ID = deviceId;
    try {
      doc.documentElement.dataset.ggDeviceId = deviceId;
    } catch (_) {}
    win.dispatchEvent(new CustomEvent('gg:device-id', { detail: { deviceId } }));
    return deviceId;
  }

  function withDeviceId(url, deviceId) {
    if (!url) return url;
    try {
      const u = new URL(url, location.href);
      if (!u.searchParams.has('device_id')) {
        u.searchParams.set('device_id', deviceId);
      }
      return u.toString();
    } catch (err) {
      debug('withDeviceId parse failed', err, url);
      return url;
    }
  }

  function updateLinkElement(el, deviceId) {
    if (!el) return;
    const attr = el.tagName === 'FORM' ? 'action' : 'href';
    const original = el.getAttribute(attr);
    if (!original) return;
    const updated = withDeviceId(original, deviceId);
    if (updated && updated !== original) {
      el.setAttribute(attr, updated);
    }
    if (el.tagName === 'FORM') {
      let hidden = el.querySelector('input[type="hidden"][name="device_id"][data-gg-device-id]');
      if (!hidden) {
        hidden = doc.createElement('input');
        hidden.type = 'hidden';
        hidden.name = 'device_id';
        hidden.setAttribute('data-gg-device-id', '1');
        el.appendChild(hidden);
      }
      hidden.value = deviceId;
    }
  }

  function rewriteAuthLinks(deviceId) {
    if (!deviceId) return;
    const selector = defaultConfig.linkSelector || 'a[href*="/api/auth/"], form[action*="/api/auth/"]';
    doc.querySelectorAll(selector).forEach((node) => updateLinkElement(node, deviceId));
    doc.querySelectorAll('[data-gg-device-href]').forEach((node) => {
      const template = node.getAttribute('data-gg-device-href');
      if (!template) return;
      node.setAttribute('href', template.replace(/\{device_id\}/g, deviceId));
    });
  }

  function startMutationObserver(deviceId) {
    if (observer) return;
    observer = new MutationObserver(() => rewriteAuthLinks(deviceId));
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'action'] });
  }

  async function postJson(url, body) {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = new Headers({ 'Accept': 'application/json' });
    if (typeof body !== 'string') {
      headers.set('Content-Type', 'application/json');
    }
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      mode: 'cors',
      headers,
      body: payload,
    });
    let data = null;
    try {
      data = await resp.json();
    } catch (_) {
      data = null;
    }
    if (!resp.ok) {
      const error = new Error(`HTTP ${resp.status}`);
      error.response = resp;
      error.payload = data;
      throw error;
    }
    return data;
  }

  function normaliseProvider(provider) {
    const map = { telegram: 'tg', tg: 'tg', vk: 'vk', vkontakte: 'vk' };
    return map[(provider || '').toLowerCase()] || null;
  }

  function extractQueryContext() {
    const params = new URLSearchParams(location.search);
    const providerFromParam = normaliseProvider(params.get('provider'));
    if (providerFromParam === 'tg') {
      const provider_user_id = params.get('id') || params.get('tg_id') || params.get('user_id');
      if (provider_user_id) {
        return {
          provider: 'tg',
          provider_user_id,
          username: params.get('username') || params.get('user') || null,
          first_name: params.get('first_name') || null,
          last_name: params.get('last_name') || null,
          photo_url: params.get('photo_url') || null,
        };
      }
    }
    if (providerFromParam === 'vk') {
      const provider_user_id = params.get('id') || params.get('vk_id') || params.get('user_id');
      if (provider_user_id) {
        return { provider: 'vk', provider_user_id };
      }
    }
    const vkUserId = params.get('vk_user_id');
    if (vkUserId) {
      return { provider: 'vk', provider_user_id: vkUserId };
    }
    return null;
  }

  function extractTelegramWebAppUser() {
    try {
      const tg = win.Telegram && win.Telegram.WebApp && win.Telegram.WebApp.initDataUnsafe;
      if (tg && tg.user && tg.user.id) {
        return {
          provider: 'tg',
          provider_user_id: String(tg.user.id),
          username: tg.user.username || null,
          first_name: tg.user.first_name || null,
          last_name: tg.user.last_name || null,
        };
      }
    } catch (err) {
      debug('telegram webapp parse failed', err);
    }
    return null;
  }

  async function fetchSessionUser() {
    try {
      const resp = await fetch(`${API_BASE}/me`, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      if (!resp.ok) return null;
      const json = await resp.json();
      if (json && json.ok && json.user) return json.user;
    } catch (err) {
      debug('fetchSessionUser failed', err);
    }
    return null;
  }

  function normalisePayload(payload) {
    if (!payload) return null;
    const provider = normaliseProvider(payload.provider);
    const provider_user_id = payload.provider_user_id || payload.providerUserId || payload.id;
    if (!provider || !provider_user_id) return null;
    const normalised = {
      provider,
      provider_user_id: String(provider_user_id),
      device_id: payload.device_id || ensureDeviceId(),
    };
    if (payload.username) normalised.username = payload.username;
    if (payload.first_name) normalised.first_name = payload.first_name;
    if (payload.last_name) normalised.last_name = payload.last_name;
    if (payload.photo_url) normalised.photo_url = payload.photo_url;
    return normalised;
  }

  function backgroundLink(payload) {
    const normalised = normalisePayload(payload);
    if (!normalised) {
      debug('backgroundLink skipped', payload);
      return Promise.resolve({ ok: false, reason: 'invalid_payload' });
    }
    const key = `${normalised.provider}:${normalised.provider_user_id}`;
    if (pending.has(key)) {
      return pending.get(key);
    }
    const request = (async () => {
      try {
        const data = await postJson(`${API_BASE}/link/background`, normalised);
        history.push({ type: 'success', at: Date.now(), payload: normalised, response: data });
        clampHistory();
        win.dispatchEvent(new CustomEvent('gg:background-link', { detail: { payload: normalised, response: data } }));
        return data;
      } catch (err) {
        history.push({ type: 'error', at: Date.now(), payload: normalised, error: err });
        clampHistory();
        debug('backgroundLink failed', err);
        return { ok: false, error: err.message || 'request_failed' };
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, request);
    return request;
  }

  async function autoLinkFromSources() {
    const tasks = [];
    const queryPayload = extractQueryContext();
    if (queryPayload) {
      tasks.push(backgroundLink(queryPayload));
    }
    const tgPayload = extractTelegramWebAppUser();
    if (tgPayload) {
      tasks.push(backgroundLink(tgPayload));
    }
    try {
      const sessionUser = await fetchSessionUser();
      if (sessionUser && sessionUser.vk_id) {
        tasks.push(backgroundLink({
          provider: 'vk',
          provider_user_id: sessionUser.vk_id,
          username: [sessionUser.first_name, sessionUser.last_name].filter(Boolean).join(' ') || null,
        }));
      }
    } catch (err) {
      debug('autoLink session failed', err);
    }
    return Promise.all(tasks);
  }

  function onDomReady(cb) {
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', cb, { once: true });
    } else {
      cb();
    }
  }

  function init() {
    const deviceId = ensureDeviceId();
    rewriteAuthLinks(deviceId);
    startMutationObserver(deviceId);

    win.GG_LINKER = {
      getDeviceId: ensureDeviceId,
      backgroundLink,
      autoLinkFromSources,
      fetchSessionUser,
      history,
      config: defaultConfig,
    };

    doc.addEventListener('gg:link-account', (event) => {
      backgroundLink(event.detail || {});
    });

    autoLinkFromSources();
  }

  onDomReady(init);
})();

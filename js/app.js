// /js/app.js — линковка Telegram/VK из лобби, без завязки на другие скрипты
(function(){
  // ---------- утилиты ----------
  function byId(id){ return document.getElementById(id); }
  function qs(sel){ return document.querySelector(sel); }
  function readMeta(name){
    const m = document.querySelector(`meta[name="${name}"]`);
    return m ? (m.getAttribute('content')||'').trim() : '';
  }
  function apiBase(){
    // приоритет: <meta name="api-base">, затем window.API_BASE, затем хардкод
    return readMeta('api-base') || (window.API_BASE||'').trim() || 'https://vercel2pr.onrender.com';
  }
  function tgBotId(){
    const raw = readMeta('tg-bot-id') || (window.TG_BOT_ID || '');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function genUuid(){
    try{
      const a = new Uint8Array(16);
      (crypto.getRandomValues||crypto.randomFillSync).call(crypto, a);
      return Array.from(a).map(x=>x.toString(16).padStart(2,'0')).join('');
    }catch(_){
      return (Date.now().toString(16)+Math.random().toString(16).slice(2)).slice(0,32);
    }
  }
  function getDeviceId(){
    try{
      let id = localStorage.getItem('device_id');
      if(!id){ id = genUuid(); localStorage.setItem('device_id', id); }
      // продублируем в cookie — бэкенду так проще
      document.cookie = 'device_id=' + id + '; Path=/; Max-Age=' + (60*60*24*365) + '; SameSite=Lax';
      return id;
    }catch(_){ return null; }
  }
  function getPrimaryUidFromCache(){
    try{
      // твой код кладёт пользователя в localStorage как 'gg_user' (см. inline-скрипт в lobby.html)
      const u = JSON.parse(localStorage.getItem('gg_user')||'null');
      return (u && u.id) ? u.id : null;
    }catch(_){ return null; }
  }
  async function getPrimaryUid(){
    // надёжнее — спросим бэкенд
    try{
      const r = await fetch(apiBase() + '/api/me', { credentials:'include', cache:'no-store' });
      if(!r.ok) throw 0;
      const j = await r.json();
      if (j && j.ok && j.user && j.user.id) return j.user.id;
    }catch(_){}
    return getPrimaryUidFromCache();
  }
  function currentReturnUrl(){
    // вернёмся в лобби туда же, включая query-параметры
    try{ return location.href; }catch(_){ return '/lobby.html'; }
  }

  // ---------- Telegram ----------
  function ensureTelegramScriptLoaded(){
    return new Promise((resolve)=>{
      if (window.Telegram && window.Telegram.Login && typeof window.Telegram.Login.auth === 'function') {
        return resolve(true);
      }
      // если тег ещё не подгрузился (async), подождём до ~3 секунд
      let tries = 0;
      const t = setInterval(()=>{
        tries++;
        if (window.Telegram && window.Telegram.Login && typeof window.Telegram.Login.auth === 'function') {
          clearInterval(t); resolve(true);
        } else if (tries > 30) {
          clearInterval(t); resolve(false);
        }
      }, 100);
    });
  }

  async function linkTelegram(){
    const API = apiBase();
    const device_id = getDeviceId();
    const primary_uid = await getPrimaryUid();
    const botId = tgBotId();

    if(!botId){
      console.warn('[link-tg] tg-bot-id не задан в <meta name="tg-bot-id">');
      alert('Не указан ID Telegram-бота. Добавь <meta name="tg-bot-id" content="..."> в <head>.');
      return;
    }
    const ok = await ensureTelegramScriptLoaded();
    if(!ok){
      console.warn('[link-tg] Telegram widget не успел загрузиться');
      alert('Telegram Login не загрузился. Обнови страницу и попробуй ещё раз.');
      return;
    }

    try{
      Telegram.Login.auth({ bot_id: botId, request_access: 'write' }, function(user){
        // user: {id, first_name, last_name, username, photo_url, auth_date, hash}
        if(!user || !user.id){ alert('Telegram не прислал профиль.'); return; }
        const p = new URLSearchParams({
          ...user,
          mode: 'link',
          primary_uid: String(primary_uid||''),
          device_id: String(device_id||'')
        });
        // Прямо в наш бэкенд, который примет и свяжет: /tg/callback
        const target = API + '/tg/callback?' + p.toString();
        window.location.href = target;
      });
    }catch(e){
      console.error('[link-tg] error', e);
      alert('Не удалось запустить Telegram Login. Проверь ID бота.');
    }
  }

  // ---------- VK ----------
  function linkVK(){
    const API = apiBase();
    const device_id = getDeviceId();
    const ret = encodeURIComponent(currentReturnUrl());
    // У тебя VK-старт уже используется как /api/auth/vk/start (см. ensureVkStartLinkHasDevice в lobby.html)
    // Добавим mode=link + device_id + return
    let url = `${API}/api/auth/vk/start?mode=link&return=${ret}`;
    if (device_id) url += `&device_id=${encodeURIComponent(device_id)}`;
    window.location.href = url;
  }

  // ---------- навесим обработчики на ВСЕ варианты кнопок ----------
  function bind(el, handler){
    if(!el) return;
    el.removeAttribute('disabled');
    el.style.pointerEvents = 'auto';
    el.addEventListener('click', function(e){
      e.preventDefault();
      handler();
    }, { passive:false });
  }

  function attachAllButtons(){
    // Шапка
    bind(byId('link-tg'), linkTelegram);
    bind(byId('link-vk'), linkVK);
    // Блок link-actions
    bind(byId('btnLinkTG'), linkTelegram);
    bind(byId('btnLinkVK'), linkVK);
    // Дубли в .hdr-linkers (на странице у тебя эти ID повторяются второй раз)
    const hdrLinkTG = document.querySelector('.hdr-linkers #btnLinkTG');
    const hdrLinkVK = document.querySelector('.hdr-linkers #btnLinkVK');
    bind(hdrLinkTG, linkTelegram);
    bind(hdrLinkVK, linkVK);
  }

  // ---------- показать «правильную» кнопку (если helper не сделал) ----------
  async function revealCorrectButtons(){
    // Если твой helper window.__setLinkButtons уже повесил кнопки — отлично.
    // Если нет, мы сами вычислим провайдера и раскроем нужную кнопку в шапке.
    try{
      const r = await fetch(apiBase() + '/api/me', { credentials:'include', cache:'no-store' });
      if(!r.ok) return;
      const j = await r.json();
      if(!(j && j.ok && j.user)) return;
      const provider = (j.user.vk_id && !String(j.user.vk_id).startsWith('tg:')) ? 'vk' : 'tg';
      if (window.__setLinkButtons) {
        window.__setLinkButtons(provider);
      } else {
        // fallback: просто покажем противоположную
        const btnTG = byId('link-tg');
        const btnVK = byId('link-vk');
        if (provider === 'vk') { if(btnTG) btnTG.style.display = 'inline-flex'; }
        else                   { if(btnVK) btnVK.style.display = 'inline-flex'; }
      }
    }catch(_){}
  }

  // ---------- старт ----------
  document.addEventListener('DOMContentLoaded', function(){
    attachAllButtons();
    revealCorrectButtons();
  });
})();

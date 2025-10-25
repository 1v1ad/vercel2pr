// /js/lobby-balance-fix.js — HUM-баланс + «связан»/блокировка + одна кнопка в шапке (по флагам linked)
(function(){
  // ----- helpers -----
  function byId(id){ return document.getElementById(id); }
  function readMeta(name){ const m=document.querySelector(`meta[name="${name}"]`); return m?(m.getAttribute('content')||'').trim():''; }
  function API(){ return readMeta('api-base') || (window.API_BASE||'').trim() || 'https://vercel2pr.onrender.com'; }
  function rub(n){ try{ return '₽ ' + (Number(n)||0).toLocaleString('ru-RU'); }catch(_){ return '₽ 0'; } }
  function getDeviceId(){
    try{
      let id = localStorage.getItem('device_id');
      if(!id){
        id = (crypto.randomUUID?crypto.randomUUID():(Date.now().toString(16)+Math.random().toString(16).slice(2)));
        localStorage.setItem('device_id', id);
      }
      document.cookie = 'device_id='+id+'; Path=/; Max-Age='+(60*60*24*365)+'; SameSite=Lax';
      return id;
    }catch(_){ return null; }
  }
  function tgBotId(){
    const raw = readMeta('tg-bot-id') || (window.TG_BOT_ID||'');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function ensureTelegramScript(){
    if (window.Telegram && window.Telegram.Login && typeof Telegram.Login.auth === 'function') return Promise.resolve(true);
    return new Promise(function(resolve){
      const s = document.createElement('script');
      s.src = 'https://telegram.org/js/telegram-widget.js?22';
      s.async = true; s.onload = ()=>resolve(true); s.onerror = ()=>resolve(false);
      document.head.appendChild(s);
    });
  }

  // ----- действия линковки -----
  function startLinkVK(){
    const ret = encodeURIComponent(location.href);
    const did = getDeviceId();
    let url = API() + '/api/auth/vk/start?mode=link&return=' + ret;
    if (did) url += '&device_id=' + encodeURIComponent(did);
    location.href = url;
  }
  async function startLinkTG(){
    const ok = await ensureTelegramScript();
    if(!ok){ alert('Не удалось загрузить Telegram Login. Обновите страницу.'); return; }
    const botId = tgBotId();
    if(!botId){
      alert('Не указан ID Telegram-бота. Добавь <meta name="tg-bot-id" content="ЧИСЛО"> в <head>.');
      return;
    }
    const did = getDeviceId();
    try{
      Telegram.Login.auth({ bot_id: botId, request_access:'write' }, function(user){
        if(!user || !user.id){ alert('Telegram не прислал профиль.'); return; }
        const p = new URLSearchParams(Object.assign({}, user, { mode:'link', primary_uid:'', device_id:String(did||'') }));
        location.href = API() + '/api/auth/tg/callback?' + p.toString();
      });
    }catch(e){
      console.error(e);
      alert('Не удалось запустить Telegram Login.');
    }
  }

  // ----- показать правильную кнопку у баланса -----
  function placeHeaderLinkButton(currentProvider, merged){
    const btnTG = byId('link-tg');
    const btnVK = byId('link-vk');

    // спрячем старый блок (нижние кнопки), чтобы не было дублей
    const extra = byId('link-actions');
    if (extra) extra.style.display = 'none';

    function disable(btn, label){
      if(!btn) return;
      btn.textContent = label;
      btn.setAttribute('disabled','disabled');
      btn.style.opacity = '0.75';
      btn.style.cursor = 'default';
    }

    if (merged === true){
      if (currentProvider === 'vk'){
        if (btnTG){ btnTG.classList.add('tg'); btnTG.style.display='inline-flex'; disable(btnTG, 'Телеграм связан'); }
        if (btnVK) btnVK.style.display='none';
      } else {
        if (btnVK){ btnVK.classList.add('vk'); btnVK.style.display='inline-flex'; disable(btnVK, 'ВКонтакте связан'); }
        if (btnTG) btnTG.style.display='none';
      }
      return;
    }

    if (currentProvider === 'tg'){
      if (btnVK){
        btnVK.classList.add('vk');
        btnVK.style.display = 'inline-flex';
        btnVK.onclick = function(e){ e.preventDefault(); startLinkVK(); };
      }
      if (btnTG) btnTG.style.display = 'none';
    } else if (currentProvider === 'vk'){
      if (btnTG){
        btnTG.classList.add('tg');
        btnTG.style.display = 'inline-flex';
        btnTG.onclick = function(e){ e.preventDefault(); startLinkTG(); };
      }
      if (btnVK) btnVK.style.display = 'none';
    }
  }

  // ----- баланс -----
  async function fetchMe(){
    try{
      const r = await fetch(API() + '/api/me', { credentials:'include', cache:'no-store' });
      if(!r.ok) return null;
      const j = await r.json();
      if (j && j.ok && j.user) return j.user;
    }catch(_){}
    return null;
  }
  async function fetchByProvider(provider, provider_user_id){
    try{
      const url = API() + '/api/balance/by-provider?provider=' + encodeURIComponent(provider) + '&provider_user_id=' + encodeURIComponent(provider_user_id);
      const r = await fetch(url, { credentials:'include', cache:'no-store' });
      if(!r.ok) return null;
      const j = await r.json();
      if (j && j.ok && j.user) return j.user;
    }catch(_){}
    return null;
  }
  function applyUser(u){
    const nameEl = byId('user-name');
    const avatarEl = byId('user-avatar');
    const balanceWrap = byId('user-balance');
    const balSpan = balanceWrap ? balanceWrap.querySelector('[data-balance]') : null;
    const note = document.getElementById('provider-note');

    if (nameEl) nameEl.textContent = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Гость';
    if (avatarEl && u.avatar) avatarEl.src = u.avatar;
    const n = Number(u.balance || 0);
    if (balSpan) balSpan.textContent = String(n);
    else if (balanceWrap) balanceWrap.textContent = rub(n);
    if (note) note.textContent = 'Источник данных: ' + (u.provider||'').toUpperCase();
  }

  // ----- init -----
  // отдаём приоритет профилю провайдера входа
 document.addEventListener('DOMContentLoaded', async function(){
  const p = new URLSearchParams(location.search);
  const fromProvider = (p.get('provider')||'').toLowerCase(); // 'tg' | 'vk' | ''
  const pid = p.get('id') || '';

  const [up, me] = await Promise.all([
    (fromProvider === 'tg' && pid) ? fetchByProvider('tg', pid) : Promise.resolve(null),
    fetchMe()
  ]);

  let u = null;
  let merged = !!(me && me.linked && me.linked.vk && me.linked.tg);

  // helper: выбираем профиль, от которого берём first_name/last_name/avatar
  const pickProfile = (preferUp) => {
    const A = preferUp ? (up || {}) : (me || {});
    const B = preferUp ? (me || {}) : (up || {});
    return {
      first_name: A.first_name || B.first_name || '',
      last_name:  A.last_name  || B.last_name  || '',
      avatar:     A.avatar     || B.avatar     || ''
    };
  };

  if (up && me && up.id === me.id) {
    // один и тот же HUM-юзер; баланс берём из me (HUM), а профиль — от провайдера входа
    const preferUp = (fromProvider === 'tg'); // если пришли из TG — берём up-профиль
    const prof = pickProfile(preferUp);
    u = {
      provider: fromProvider || ((me && me.vk_id && !String(me.vk_id).startsWith('tg:')) ? 'vk' : 'tg'),
      id: me.id,
      ...prof,
      balance: Number(me.balance || 0)
    };
  } else if (up) {
    // ещё не склеено (или нет me) — показываем TG-профиль; баланс отдаст by-provider (HUM уже после склейки)
    u = Object.assign({ provider:'tg' }, up);
  } else if (me) {
    const isVK = me.vk_id && !String(me.vk_id).startsWith('tg:');
    const prof = pickProfile(false);
    u = {
      provider: isVK ? 'vk' : 'tg',
      id: me.id || null,
      ...prof,
      balance: Number(me.balance||0),
    };
  } else {
    u = { provider: fromProvider||'vk', first_name:'Гость', last_name:'', avatar:'', balance:0 };
  }

  try{ localStorage.setItem('gg_user', JSON.stringify(u)); }catch(_){}
  applyUser(u);

  const note = document.getElementById('provider-note');
  if (note) {
    if (merged) note.textContent = 'Источник данных: общий кошелёк (VK↔TG)';
    else        note.textContent = 'Источник данных: ' + u.provider.toUpperCase();
  }

  placeHeaderLinkButton(u.provider, merged);
});
})();

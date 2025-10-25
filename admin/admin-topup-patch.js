/**
 * FEAT: admin_topup_redirect_safely
 * WHY:  не светим пароль в URL; открываем topup в новой вкладке; передаём pwd через sessionStorage
 * DATE: 2025-10-11
 */
(function () {
  function $(s){ return document.querySelector(s); }
  function val(el){ return (el && el.value || '').trim(); }

  function pickApi() {
    const input = $('#apiBase') || $('#api') || $('input[name="api"]');
    const ls = (localStorage.getItem('admin_api') || localStorage.getItem('ADMIN_API') || '').trim();
    const meta = document.querySelector('meta[name="api-base"]');
    return val(input) || ls || (meta && meta.content) || 'https://vercel2pr.onrender.com';
  }
  function pickPwd() {
    const pass = $('input[type="password"]');
    const ls = (localStorage.getItem('admin_pwd') || '').trim();
    return val(pass) || ls || '';
  }
  function pickUserId() {
    // пытаемся взять значение из блока "Пополнение"
    // 1) явные id
    const hard = $('#topup-user-id') || $('#topup_user_id') || $('#user_id') || $('#uid');
    if (hard) return val(hard);
    // 2) два инпута рядом в карточке "Пополнение" — берём первый числовой
    const cards = Array.from(document.querySelectorAll('.card, .panel, section'));
    for (const c of cards) {
      if (!/попол/i.test(c.textContent || '')) continue;
      const nums = Array.from(c.querySelectorAll('input')).map(x => val(x)).filter(x => /^\d+$/.test(x));
      if (nums.length) return nums[0];
    }
    // 3) fallback
    const any = document.querySelector('input[type="number"]');
    return val(any);
  }

  function findButton() {
    // явные id/атрибуты
    const direct = document.querySelector('#topup-run, #btnManualTopup, #btnTopup, [data-action="manual-topup"]');
    if (direct) return direct;
    // по тексту
    const btns = Array.from(document.querySelectorAll('button, .btn'));
    return btns.find(b => /попол(нить|нение)\s+вручн/i.test(b.textContent || ''));
  }

  function wire() {
    let btn = findButton();
    if (!btn || btn.dataset._wired) return;

    const clone = btn.cloneNode(true);
    clone.type = 'button';
    btn.replaceWith(clone);
    btn = clone;

    btn.addEventListener('click', (e) => {
      e.preventDefault();

      const api = pickApi();
      const pwd = pickPwd();
      const uid = pickUserId();

      try { if (pwd) sessionStorage.setItem('admin_pwd', pwd); } catch {}
      if (api) try { localStorage.setItem('admin_api', api); } catch {}

      const p = new URLSearchParams();
      if (uid) p.set('user_id', uid);
      if (api) p.set('api', api);

      const url = '/admin/topup.html' + (p.toString() ? ('?' + p.toString()) : '');
      window.open(url, '_blank', 'noopener');
    });

    btn.dataset._wired = '1';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

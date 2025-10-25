// Вставляет кнопку "Перейти на страницу" рядом с кнопкой "Пополнить вручную".
(function(){
  function inject(){
    // пробуем надёжные селекторы
    let btn = document.getElementById('btnManualTopup')
          || document.getElementById('btnTopup')
          || document.querySelector('[data-action="manual-topup"]');

    // если не нашли — ищем по тексту
    if (!btn) {
      const candidates = Array.from(document.querySelectorAll('button, .btn'));
      btn = candidates.find(el => /попол(нить|нение)/i.test(el.textContent||''));
    }
    if (!btn || btn.dataset._linked) return;

    const a = document.createElement('a');
    a.href = '/admin/topup.html';
    a.target = '_blank';
    a.textContent = 'Перейти на страницу';
    a.style.marginLeft = '8px';
    a.style.background = '#0f1730';
    a.style.color = '#8ecbff';
    a.style.padding = '8px 12px';
    a.style.border = '1px solid #2a3a57';
    a.style.borderRadius = '10px';
    a.style.textDecoration = 'none';
    btn.after(a);
    btn.dataset._linked = '1';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject); else inject();
})();

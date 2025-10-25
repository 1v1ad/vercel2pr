// admin/chart-range.js — линейный график по произвольному диапазону дат
// Цвета: всего (Total) — СИНИЙ, уникальные (Unique) — ЗЕЛЁНЫЙ.
// Поддержка hover: вертикальная линия, точки и тултип (дата + значения).

(function(){
  const SVG = document.getElementById('chart-range');
  if (!SVG) return;

  const fromEl = document.getElementById('range-from');
  const toEl   = document.getElementById('range-to');
  const noteEl = document.getElementById('range-note');
  const applyBtn = document.getElementById('range-apply');

  // ===== helpers =====
  function apiBase(){
    return (localStorage.getItem('ADMIN_API') || '').replace(/\/+$/,'');
  }
  function headers(){
    return window.adminHeaders ? window.adminHeaders() : {};
  }
  function today(tz){
    const d = new Date();
    const fmt = new Intl.DateTimeFormat('sv-SE',{ timeZone: tz||'Europe/Moscow', year:'numeric',month:'2-digit',day:'2-digit' });
    return fmt.format(d); // YYYY-MM-DD
  }
  function addDays(iso, delta){
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0,10);
  }
  function setPreset(days){
    const tz='Europe/Moscow';
    const t = today(tz);
    fromEl.value = addDays(t, -Number(days));
    toEl.value   = t;
    run();
  }
  const clamp = (v, a, b)=> Math.max(a, Math.min(b, v));
  const fmtInt = (n)=> (Number(n)||0).toLocaleString('ru-RU');

  // ===== fetch & draw =====
  async function run(){
    const API = apiBase();
    if (!API) return;

    const qs = new URLSearchParams({ tz:'Europe/Moscow' });
    if (fromEl.value) qs.set('from', fromEl.value);
    if (toEl.value)   qs.set('to',   toEl.value);

    const r = await fetch(API + '/api/admin/range?' + qs.toString(), { headers: headers(), cache:'no-store' });
    const j = await r.json().catch(()=>({}));
    if (!j || !j.ok || !Array.isArray(j.days)) {
      draw([], []);
      noteEl.textContent = 'Нет данных';
      return;
    }

    const xs = j.days.map(d => d.date || d.day);
    const sTotal  = j.days.map(d => Number(d.auth_total  || 0));   // СИНИЙ
    const sUnique = j.days.map(d => Number(d.auth_unique || 0));   // ЗЕЛЁНЫЙ
    drawLine(xs, sTotal, sUnique);
    noteEl.textContent = `Период: ${j.from} – ${j.to} • дней: ${j.days.length}`;
  }

  function drawLine(xDates, yTotal, yUnique){
    // очистка SVG
    while (SVG.firstChild) SVG.removeChild(SVG.firstChild);

    const box = SVG.getBoundingClientRect();
    const W = Math.max(320, box.width|0);
    const H = Math.max(180, (SVG.getAttribute('height')|0) || 260);
    SVG.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const pad = { l:42, r:12, t:12, b:26 };
    const X0 = pad.l, X1 = W - pad.r;
    const Y0 = H - pad.b, Y1 = pad.t;
    const n  = xDates.length;

    // границы и шкалы
    const maxY = Math.max(1, Math.max(...yTotal, ...yUnique));
    const scaleX = (i)=> (n<=1 ? X0 : X0 + (i*(X1-X0)/(n-1)));
    const scaleY = (v)=> (Y0 - (v * (Y0-Y1) / maxY));

    // сетка Y (4 линии)
    for (let g=0; g<=4; g++){
      const val = Math.round(maxY * g / 4);
      const y = scaleY(val);
      const line = elt('line', {x1:X0, y1:y, x2:X1, y2:y, stroke:'#1b2737','stroke-width':1});
      const lbl  = elt('text', {x:X0-6, y:y+4, fill:'#8fa4c6','font-size':11,'text-anchor':'end'}, String(val));
      SVG.appendChild(line); SVG.appendChild(lbl);
    }

    // ось X: 6 меток
    const ticks = Math.min(6, Math.max(2, n));
    for (let i=0;i<ticks;i++){
      const idx = Math.round(i*(n-1)/(ticks-1));
      const x = scaleX(idx);
      const lbl = elt('text',{x, y:H-6, fill:'#8fa4c6','font-size':11,'text-anchor': i==0?'start':(i==ticks-1?'end':'middle')}, xDates[idx]||'');
      SVG.appendChild(lbl);
    }

    // путь из массива
    function pathFor(arr){
      let d = '';
      for (let i=0;i<n;i++){
        const x = scaleX(i), y = scaleY(arr[i]||0);
        d += (i?'L':'M') + x + ' ' + y;
      }
      return d;
    }

    // Линии: TOTAL — синий, UNIQUE — зелёный
    const colorBlue  = '#0a84ff';
    const colorGreen = '#4ed1a9';

    const pTotal  = elt('path',{ d: pathFor(yTotal),  fill:'none', stroke: colorBlue,  'stroke-width':2.5 });
    const pUnique = elt('path',{ d: pathFor(yUnique), fill:'none', stroke: colorGreen, 'stroke-width':2.5 });
    SVG.appendChild(pTotal);
    SVG.appendChild(pUnique);

    // легенда
    const kx = X0 + 6, ky = Y1 + 10;
    SVG.appendChild(elt('rect',{x:kx, y:ky, width:10, height:10, fill: colorBlue,  rx:2}));
    SVG.appendChild(elt('text',{x:kx+16, y:ky+9, fill:'#a5c4f1','font-size':12}, 'Всего авторизаций'));
    SVG.appendChild(elt('rect',{x:kx+180, y:ky, width:10, height:10, fill: colorGreen, rx:2}));
    SVG.appendChild(elt('text',{x:kx+196, y:ky+9, fill:'#a5c4f1','font-size':12}, 'Уникальных'));

    // --- Hover: линия, точки и тултип ---
    if (n >= 1) {
      const hover = elt('g', {style:'pointer-events:none'});
      const vline = elt('line', {x1:X0, y1:Y1, x2:X0, y2:Y0, stroke:'#8fa4c6','stroke-opacity':'0.5','stroke-width':1});
      const dotTotal  = elt('circle', {r:4, fill: colorBlue,  stroke:'#0b1a2b','stroke-width':1});
      const dotUnique = elt('circle', {r:4, fill: colorGreen, stroke:'#0b1a2b','stroke-width':1});
      const tip = tooltipGroup();
      hover.appendChild(vline); hover.appendChild(dotTotal); hover.appendChild(dotUnique); hover.appendChild(tip.g);
      SVG.appendChild(hover);

      // прозрачный оверлей для событий мыши/тача
      const overlay = elt('rect', {x:X0, y:Y1, width:(X1-X0), height:(Y0-Y1), fill:'transparent', style:'cursor:crosshair'});
      SVG.appendChild(overlay);

      function onPos(clientX){
        const rect = SVG.getBoundingClientRect();
        const x = clamp(clientX - rect.left, X0, X1);
        const t = (X1===X0) ? 0 : (x - X0) * (n-1) / (X1 - X0);
        const i = clamp(Math.round(t), 0, n-1);

        const xi = scaleX(i);
        const yTi = scaleY(yTotal[i]||0);
        const yUi = scaleY(yUnique[i]||0);

        vline.setAttribute('x1', xi);
        vline.setAttribute('x2', xi);

        dotTotal.setAttribute('cx', xi);
        dotTotal.setAttribute('cy', yTi);
        dotUnique.setAttribute('cx', xi);
        dotUnique.setAttribute('cy', yUi);

        const leftSide = (xi > (X0 + X1)/2) ? (xi - 8 - tip.W) : (xi + 8);
        const tipX = clamp(leftSide, X0, X1 - tip.W);
        const tipY = clamp(Math.min(yTi, yUi) - 10 - tip.H, Y1, Y0 - tip.H);

        tip.set([
          { color:'#a5c4f1', label: xDates[i] },
          { color: colorBlue,  label: 'Всего: ' + fmtInt(yTotal[i]||0) },
          { color: colorGreen, label: 'Уник.: ' + fmtInt(yUnique[i]||0) }
        ], tipX, tipY);
      }

      function handleMove(e){
        if (e.touches && e.touches.length) onPos(e.touches[0].clientX);
        else onPos(e.clientX);
      }
      overlay.addEventListener('mousemove', handleMove, {passive:true});
      overlay.addEventListener('touchmove', handleMove, {passive:true});
      overlay.addEventListener('mouseenter', (e)=> handleMove(e), {passive:true});
      overlay.addEventListener('mouseleave', ()=>{
        // спрячем hover, пока мышь вне зоны
        vline.setAttribute('x1', X0);
        vline.setAttribute('x2', X0);
        dotTotal.setAttribute('cx', -9999);
        dotTotal.setAttribute('cy', -9999);
        dotUnique.setAttribute('cx', -9999);
        dotUnique.setAttribute('cy', -9999);
        tip.set([], -9999, -9999);
      });
    }

    // --- helpers ---
    function elt(tag, attrs, text){
      const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
      if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
      if (text!=null) e.appendChild(document.createTextNode(text));
      return e;
    }
    function tooltipGroup(){
      const g = elt('g');
      const bg = elt('rect', {x:0,y:0,rx:6,ry:6,fill:'#0b1a2b',stroke:'#213047','stroke-width':1,opacity:'0.95'});
      const line1 = elt('text',{x:10,y:16,fill:'#a5c4f1','font-size':12});
      const line2 = elt('text',{x:10,y:34,fill:'#a5c4f1','font-size':12});
      const line3 = elt('text',{x:10,y:52,fill:'#a5c4f1','font-size':12});
      const dot2 = elt('rect',{x:10,y:24,width:8,height:8,rx:2,ry:2,fill:'#0a84ff'});   // blue
      const dot3 = elt('rect',{x:10,y:42,width:8,height:8,rx:2,ry:2,fill:'#4ed1a9'});  // green
      g.appendChild(bg); g.appendChild(line1);
      g.appendChild(dot2); g.appendChild(line2);
      g.appendChild(dot3); g.appendChild(line3);

      const obj = {
        g, W: 160, H: 62,
        set(items, x, y){
          // items: [{color?, label}, ...] — первая строка дата
          const l1 = items[0]?.label || '';
          const l2 = items[1]?.label || '';
          const l3 = items[2]?.label || '';
          line1.textContent = l1;
          line2.textContent = l2;
          line3.textContent = l3;
          if (items[1]?.color) dot2.setAttribute('fill', items[1].color);
          if (items[2]?.color) dot3.setAttribute('fill', items[2].color);

          // простая ширина по макс длине
          const maxLen = Math.max(l1.length, l2.length, l3.length);
          this.W = clamp(20 + maxLen*7.2, 120, 220);
          bg.setAttribute('width', this.W);
          bg.setAttribute('height', this.H);
          g.setAttribute('transform', `translate(${x},${y})`);
        }
      };
      // скрыть по умолчанию — уводим влево
      obj.set([], -9999, -9999);
      return obj;
    }
  }

  // пресеты
  document.querySelectorAll('[data-preset]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const p = btn.getAttribute('data-preset');
      if (p === 'all') {
        fromEl.value = ''; toEl.value = '';
        run();
      } else {
        setPreset(Number(p));
      }
    });
  });
  applyBtn?.addEventListener('click', run);
  fromEl?.addEventListener('change', ()=>{ if (toEl.value && fromEl.value>toEl.value) toEl.value=fromEl.value; });
  toEl?.addEventListener('change',   ()=>{ if (fromEl.value && toEl.value<fromEl.value) fromEl.value=toEl.value; });

  // старт: 30 дней
  (function init(){
    const tz='Europe/Moscow';
    const t = today(tz);
    fromEl.value = addDays(t, -30);
    toEl.value   = t;
    run();
  })();
})();

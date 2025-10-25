// admin/chart.js — V3.8 (grouped bars, safe labels, outer spacing)
(function(){
  const svg = document.getElementById('chart'); if (!svg) return;
  const NS = 'http://www.w3.org/2000/svg';
  const api = () => (localStorage.getItem('ADMIN_API') || window.API || '').replace(/\/+$/,'');
  const headers = () => (window.adminHeaders ? window.adminHeaders() : {});

  const labelDM = s => (s && s.length>=10 ? `${s.slice(8,10)}.${s.slice(5,7)}` : (s||''));

  function draw(days){
    const W = svg.clientWidth || 900, H = svg.clientHeight || 300;
    const padL = 46, padB = 28, padT = 22;
    const headroom = 1.12;

    // --- ключ к «раздвижке» между днями:
    const innerGap = 8;     // между синим и зелёным внутри дня
    const outerGap = 12;    // отступ слева/справа внутри каждого «дня» (даёт визуальный зазор между днями)

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const totals  = days.map(d => Number(d.auth_total ?? d.count ?? 0));
    const uniques = days.map(d => Number(d.auth_unique ?? d.unique ?? 0));
    const maxBase = Math.max(1, ...totals, ...uniques);
    const max = Math.ceil(maxBase * headroom);

    const plotH = H - padB - padT;
    const groupW = Math.max(28, (W - padL - 16) / Math.max(1, days.length)); // ширина «дня» как контейнера

    // ширина каждой колонки с учётом внутреннего (innerGap) и внешнего (outerGap) зазоров
    const barW = Math.max(10, (groupW - innerGap - outerGap*2) / 2);

    // оси/сетка
    const axis = document.createElementNS(NS,'line');
    axis.setAttribute('x1', padL); axis.setAttribute('y1', padT);
    axis.setAttribute('x2', padL); axis.setAttribute('y2', H-padB);
    axis.setAttribute('stroke','#274260'); svg.appendChild(axis);

    for(let i=0;i<=4;i++){
      const y = padT + plotH * i/4;
      const ln = document.createElementNS(NS,'line');
      ln.setAttribute('x1', padL); ln.setAttribute('y1', y);
      ln.setAttribute('x2', W-8);  ln.setAttribute('y2', y);
      ln.setAttribute('stroke', i===4 ? '#274260' : '#173046');
      ln.setAttribute('stroke-dasharray', i===4 ? '0' : '3 5');
      svg.appendChild(ln);

      const t = document.createElementNS(NS,'text');
      t.setAttribute('x', 8); t.setAttribute('y', y+4);
      t.setAttribute('fill','#88a7d6'); t.setAttribute('font-size','11');
      t.textContent = Math.round(max * (1 - i/4));
      svg.appendChild(t);
    }

    days.forEach((d,i)=>{
      // левая граница «контейнера дня»
      const gx = padL + 10 + i*groupW;
      const baseY = H - padB;

      const vt = Number(d.auth_total ?? d.count ?? 0);
      const vu = Number(d.auth_unique ?? d.unique ?? 0);
      const ht = plotH * (vt / max);
      const hu = plotH * (vu / max);

      // внутри контейнера дня отступаем outerGap слева
      const xT = gx + outerGap;                 // total (синий)
      const xU = xT + barW + innerGap;          // unique (зелёный)

      const rt = document.createElementNS(NS,'rect');
      rt.setAttribute('x', xT); rt.setAttribute('y', baseY - ht);
      rt.setAttribute('width', barW); rt.setAttribute('height', ht);
      rt.setAttribute('fill', '#4ea0ff'); svg.appendChild(rt);

      const lt = document.createElementNS(NS,'text');
      lt.setAttribute('x', xT + barW/2);
      lt.setAttribute('y', Math.max(12, baseY - ht - 4));
      lt.setAttribute('fill', '#cfe3ff'); lt.setAttribute('font-size','11');
      lt.setAttribute('text-anchor','middle'); lt.textContent = vt; svg.appendChild(lt);

      const ru = document.createElementNS(NS,'rect');
      ru.setAttribute('x', xU); ru.setAttribute('y', baseY - hu);
      ru.setAttribute('width', barW); ru.setAttribute('height', hu);
      ru.setAttribute('fill', '#39d98a'); svg.appendChild(ru);

      const lu = document.createElementNS(NS,'text');
      lu.setAttribute('x', xU + barW/2);
      lu.setAttribute('y', Math.max(12, baseY - hu - 4));
      lu.setAttribute('fill', '#d6ffe8'); lu.setAttribute('font-size','11');
      lu.setAttribute('text-anchor','middle'); lu.textContent = vu; svg.appendChild(lu);

      // центр подписи — по центру реального контента: 2 бара + innerGap, со сдвигом outerGap
      const tx = document.createElementNS(NS,'text');
      tx.setAttribute('x', gx + outerGap + (barW*2 + innerGap)/2);
      tx.setAttribute('y', H - 8);
      tx.setAttribute('fill','#9fb4d9'); tx.setAttribute('font-size','11');
      tx.setAttribute('text-anchor','middle'); tx.textContent = labelDM(d.date||'');
      svg.appendChild(tx);
    });

    const legend = document.createElementNS(NS,'g');
    [['#4ea0ff','Авторизации'],['#39d98a','Уникальные HUM']].forEach((it,idx)=>{
      const x = padL + 10 + idx*150, y = 16;
      const r = document.createElementNS(NS,'rect');
      r.setAttribute('x',x); r.setAttribute('y',y-10);
      r.setAttribute('width',14); r.setAttribute('height',14);
      r.setAttribute('rx',3); r.setAttribute('fill',it[0]); legend.appendChild(r);
      const t = document.createElementNS(NS,'text');
      t.setAttribute('x',x+20); t.setAttribute('y',y+1);
      t.setAttribute('fill','#9fb4d9'); t.setAttribute('font-size','12');
      t.textContent = it[1]; legend.appendChild(t);
    });
    svg.appendChild(legend);
  }

  async function load(){
    const root = api(); if (!root) return;
    const r = await fetch(root + `/api/admin/daily?days=7&tz=Europe/Moscow`, { headers: headers(), cache:'no-store' });
    const j = await r.json().catch(()=>({}));
    const days = Array.isArray(j.days) ? j.days : (Array.isArray(j.daily) ? j.daily : []);
    draw(days);
  }
  load();
})();

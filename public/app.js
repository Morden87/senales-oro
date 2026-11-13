(function () {
  const $ = (id) => document.getElementById(id);
  const TA = window.GoldTA, SYS = window.GoldSys, Data = window.GoldData, RV = window.GoldReview;
  const REFRESH_MS = 30000, SLOW_MS = 5 * 60000;

  const store = {
    get() { try { return JSON.parse(localStorage.getItem('oro.cfg') || '{}'); } catch { return {}; } },
    set(v) { try { localStorage.setItem('oro.cfg', JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
  };
  const cfg = Object.assign({ source: 'etoro', apiKey: '', userKey: '', pin: '', notify: false }, store.get());
  cfg.proxy = false;
  let timer = null, busy = false, last = null; // last: { level, signalT } para los avisos con la app abierta
  let slow = { at: 0, sys: null, pf: null, rv: null, rvAt: 0 }; // datos que cambian despacio
  const save = () => { const { proxy, params, refs, ...persist } = cfg; store.set(persist); };

  async function getJSON(url) { try { const r = await fetch(url, { cache: 'no-store' }); return r.ok ? r.json() : null; } catch { return null; } }

  // ---------- gráfico ----------
  const chart = LightweightCharts.createChart($('chart'), {
    layout: { background: { color: 'transparent' }, textColor: '#a89f88' },
    grid: { vertLines: { color: '#2a261c' }, horzLines: { color: '#2a261c' } },
    rightPriceScale: { borderColor: '#3a3426' },
    timeScale: { borderColor: '#3a3426', timeVisible: true, secondsVisible: false },
    localization: { locale: 'es-ES' }, autoSize: true,
  });
  const candleS = chart.addCandlestickSeries({ upColor: '#2fbf71', downColor: '#e5534b', borderVisible: false, wickUpColor: '#2fbf71', wickDownColor: '#e5534b' });
  let lines = [], fitted = false;

  const fmt = (x, d = 2) => (x == null || isNaN(x) ? '—' : x.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (x) => (x == null || isNaN(x) ? '—' : Math.round(x * 100) + '%');
  const hhmm = (t) => new Date(t * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const dayhm = (t) => new Date(t * 1000).toLocaleString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  function showError(msg) { const e = $('err'); e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; }
  const CHIP = { BAJO: 'BAJO', MEDIO: 'MEDIO', ALTO: 'ALTO' };

  // ---------- los tres pasos ----------
  function renderSystem(e, live, hourly) {
    const px = live && isFinite(live.bid) ? live.bid : hourly[hourly.length - 1].close;
    $('price').textContent = '$' + fmt(px) + (live && isFinite(live.ask) ? '  ·  ask ' + fmt(live.ask) : '');
    $('updated').textContent = `Última vela de 1 h cerrada: ${hhmm(e.time)}–${hhmm(e.closeTime)} · actualizado ${new Date().toLocaleTimeString('es-ES')}`;
    // ①
    const lv = $('lvl'); lv.textContent = e.levelText; lv.className = 'chip big ' + CHIP[e.level];
    $('prob').textContent = pct(e.prob);
    $('probBar').style.width = Math.min(100, Math.round(e.prob * 100)) + '%';
    $('probThr').style.left = isFinite(e.threshold) ? Math.min(100, e.threshold * 100) + '%' : '-10px';
    $('why').textContent = `Probabilidad de que el oro se mueva más de un 0,8 % en las próximas 6 h. "Movimiento probable" desde ${pct(e.threshold)} (marca blanca: el 20 % de horas más altas de las últimas semanas).` +
      (e.reasons.length ? ' Ahora pesa: ' + e.reasons.join(', ') + '.' : '');
    $('news').textContent = e.nextEvent ? `Próxima noticia: ${e.nextEvent.name}, ${dayhm(e.nextEvent.t + 1800)} (hora de este móvil).` : '';
    // ②
    const on1 = e.level === 'ALTO';
    $('s2').classList.toggle('off', !on1); $('s3').classList.toggle('off', !on1);
    $('start').textContent = !on1 ? 'En espera del paso 1' : e.step2;
    $('start').className = 'state ' + (on1 && e.bdir > 0 ? 'up' : on1 && e.bdir < 0 ? 'dn' : 'nt');
    $('hh').textContent = fmt(e.hh); $('ll').textContent = fmt(e.ll); $('big').textContent = fmt(e.bigBar, 1) + ' $';
    // ③
    $('trend').innerHTML = `Tendencia diaria <b class="${e.trend === 'alcista' ? 'up' : e.trend === 'bajista' ? 'dn' : 'nt'}">${e.trend}</b>: cierre diario frente a su media de 20 días (${fmt(e.ema20d)}). Solo se opera a su favor.`;
    // Señal vigente: la operación abierta en papel (servidor) o, sin servidor, la de las últimas 6 h.
    const paper = slow.sys && slow.sys.paper;
    let open = paper && paper.open && paper.open[0];
    if (!cfg.proxy) {
      const s = e.series, n = s.length; open = null;
      for (let i = n - 1; i >= Math.max(0, n - SYS.HOLD_H); i--) if (s[i] && s[i].signal) { open = { side: s[i].side > 0 ? 'COMPRA' : 'VENTA', time: s[i].time, signalPrice: s[i].price, stop: s[i].price - s[i].side * SYS.STOP_ATR * s[i].atr, entry: hourly.find((k) => k.time === s[i].time + 3600)?.open ?? null }; break; }
    }
    const act = $('act');
    if (open) {
      act.textContent = open.side; act.className = 'act ' + open.side;
      $('actWhy').textContent = `Señal de las ${hhmm(open.time + 3600)}: movimiento probable + ruptura a favor de la tendencia diaria.`;
      $('trade').style.display = '';
      $('tEntry').textContent = fmt(open.entry ?? open.signalPrice); $('tExit').textContent = hhmm(open.time + 3600 * (1 + SYS.HOLD_H)); $('tStop').textContent = fmt(open.stop);
    } else {
      act.textContent = 'ESPERAR'; act.className = 'act ESPERAR'; $('trade').style.display = 'none';
      $('actWhy').textContent = e.note || (on1 ? 'Falta que empiece el movimiento a favor de la tendencia diaria.' : 'Sin aviso de movimiento.');
    }
    // gráfico
    lines.forEach((l) => candleS.removePriceLine(l)); lines = [];
    lines.push(candleS.createPriceLine({ price: e.hh, color: '#2fbf71', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'máx 20 h' }));
    lines.push(candleS.createPriceLine({ price: e.ll, color: '#e5534b', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'mín 20 h' }));
    if (open) lines.push(candleS.createPriceLine({ price: open.stop, color: '#e2b23c', lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: 'stop' }));
    // avisos con la app abierta
    if (last && e.level === 'ALTO' && last.level !== 'ALTO') notify('Cortés: atento, movimiento probable', `Probabilidad ${pct(e.prob)}. Espera la ruptura a favor de la tendencia diaria (${e.trend}).`);
    if (last && open && last.signalT !== open.time) notify(`Cortés: ${open.side} oro`, `Precio ${fmt(open.signalPrice)} $. Cerrar a las ${hhmm(open.time + 3600 * (1 + SYS.HOLD_H))}. Stop orientativo ${fmt(open.stop)} $.`);
    last = { level: e.level, signalT: open ? open.time : null };
  }

  function renderPaper() {
    const el = $('paper'), p = slow.sys && slow.sys.paper;
    if (!cfg.proxy) { el.textContent = 'Solo disponible con tu servidor de Cloudflare: es el que anota las señales aunque el móvil esté apagado.'; return; }
    if (!p) { el.textContent = 'Todavía no hay datos: el servidor empieza a anotar en la próxima vela de 1 h.'; return; }
    const a = SYS.stats(p.closed), b = SYS.stats(p.base && p.base.closed);
    const sign = (x, d = 2) => (x == null ? '—' : (x >= 0 ? '+' : '') + fmt(x, d));
    let html = '<table class="pp"><tr><th></th><th>Ops.</th><th>Aciertos</th><th>Total $</th><th>Media ATR</th></tr>' +
      `<tr><td><b>Dos pasos</b></td><td>${a.n}</td><td>${pct(a.hit)}</td><td class="${a.total >= 0 ? 'up' : 'dn'}">${sign(a.total)}</td><td class="${(a.avgAtr || 0) >= 0 ? 'up' : 'dn'}">${sign(a.avgAtr)}</td></tr>` +
      `<tr><td>Sin el paso 1</td><td>${b.n}</td><td>${pct(b.hit)}</td><td class="${b.total >= 0 ? 'up' : 'dn'}">${sign(b.total)}</td><td>${sign(b.avgAtr)}</td></tr></table>`;
    html += `<p>${a.n < 60 ? `Llevas ${a.n} de unas 60 señales para decidir.` : (a.avgAtr > 0.1 ? 'Supera +0,1 ATR por operación: se puede seguir.' : 'No supera +0,1 ATR por operación: según la regla, retirarlo.')} Resultado por onza, con 0,5 $ de diferencial.${p.since ? ' Anotando desde ' + dayhm(p.since) + '.' : ''}</p>`;
    const o = (p.open || [])[0];
    if (o) html += `<p>Abierta: <b>${o.side}</b> desde ${fmt(o.entry ?? o.signalPrice)} $ (${dayhm(o.time + 3600)}), se cierra hacia las ${hhmm(o.time + 3600 * (1 + SYS.HOLD_H))}.</p>`;
    if (p.closed && p.closed.length) html += '<table class="pp"><tr><th>Entrada</th><th>Lado</th><th>Precio</th><th>Salida</th><th>$</th></tr>' +
      p.closed.slice(-10).reverse().map((t) => `<tr><td>${dayhm(t.time + 3600)}</td><td>${t.side}</td><td>${fmt(t.entry)}</td><td>${fmt(t.exit)}</td><td class="${t.pnl >= 0 ? 'up' : 'dn'}">${sign(t.pnl)}</td></tr>`).join('') + '</table>';
    el.innerHTML = html;
  }

  // ---------- posiciones de eToro ----------
  async function loadPortfolio() {
    if (!cfg.proxy) return { error: 'Solo disponible con tu servidor de Cloudflare.' };
    if (!cfg.pin) return { error: 'Escribe tu PIN en Ajustes (⚙︎) para ver tus posiciones.' };
    try {
      const r = await fetch('api/portfolio', { cache: 'no-store', headers: { 'x-admin-pin': cfg.pin }, signal: AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined });
      const j = await r.json().catch(() => ({}));
      return r.ok ? j : { error: j.error || 'El servidor respondió ' + r.status };
    } catch { return { error: 'El servidor o eToro no responden. Se reintentará en unos minutos.' }; }
  }
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (x) => (x == null || isNaN(x) ? '—' : (x > 0 ? '+' : '') + fmt(x) + '\u00a0$');
  const cls = (x) => (x == null ? 'nt' : x >= 0 ? 'up' : 'dn');
  const when = (s) => (s ? new Date(s).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const side = (p) => `<span class="${p.isBuy ? 'up' : 'dn'}">${p.isBuy ? 'Compra' : 'Venta'}</span>${p.leverage > 1 ? ' x' + p.leverage : ''}${p.copied ? ' · copiada' : ''}`;
  function renderPortfolio() {
    const el = $('pf'), p = slow.pf;
    if (!cfg.proxy) { el.textContent = 'Solo disponible con tu servidor de Cloudflare.'; return; }
    if (!p) { el.textContent = 'Cargando…'; return; }
    if (p.error) { el.textContent = p.error; return; }
    const o = p.open || [], c = p.closed || [];
    let html = `<div class="pf-sum"><div>Abiertas<b>${o.length}</b>${fmt(p.invested)} $</div>` +
      `<div>Resultado abierto<b class="${cls(p.unrealizedPnL)}">${money(p.unrealizedPnL)}</b>&nbsp;</div>` +
      `<div>Cerradas ${p.statsFrom ? 'desde ' + new Date(p.statsFrom).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }) : p.days + ' días'}<b class="${cls(p.closedPnL)}">${money(p.closedPnL)}</b>${c.length} ${c.length === 1 ? 'operación' : 'operaciones'}</div></div>`;
    // Pirámide de oro: precio medio y TP común para ganar un 5 % de lo invertido.
    const gold = o.filter((x) => RV.isGold(x) && !x.copied);
    const now = gold.find((x) => x.rate != null);
    const py = gold.length && window.GoldPyr ? window.GoldPyr.state(gold, now ? now.rate : NaN, p.pyramid || {}) : null;
    if (py && py.tpLevel) {
      html += `<div class="pos" style="border-left:3px solid var(--buy)"><div class="t"><b>Pirámide de oro · ${py.side.toLowerCase()} · ${py.steps} ${py.steps > 1 ? 'escalones' : 'escalón'}</b><span class="${cls(py.pnl)}">${money(py.pnl)}</span></div>` +
        `Invertido ${fmt(py.invested)} $ · precio medio ${fmt(py.avg)}` +
        `<br><b>TP para +${py.tpPct} % (${money(py.tpProfit)}): ${fmt(py.tpLevel)}</b>` +
        `<br>Pon ese TP en todas las posiciones de oro y se cierran juntas con esa ganancia (sin contar comisiones ni el diferencial). Si añades un escalón, el TP cambia.</div>`;
    }
    html += '<h2 style="margin-top:4px">Abiertas</h2>' + (o.length ? o.map((x) => `<div class="pos"><div class="t"><b>${esc(x.name)}</b><span class="${cls(x.pnl)}">${money(x.pnl)}</span></div>` +
      `${side(x)} · ${fmt(x.amount)} $ · entrada ${fmt(x.openRate, x.openRate < 10 ? 4 : 2)}${x.rate != null ? ' · ahora ' + fmt(x.rate, x.rate < 10 ? 4 : 2) : ''}` +
      `<br>Abierta ${when(x.openTime)}${x.stopLoss ? ' · SL ' + fmt(x.stopLoss) : ''}${x.takeProfit ? ' · TP ' + fmt(x.takeProfit) : ''}</div>`).join('') : '<p>No tienes posiciones abiertas.</p>');
    html += `<h2 style="margin-top:12px">Cerradas (${p.statsFrom ? 'desde el ' + new Date(p.statsFrom).toLocaleDateString('es-ES') : 'últimos ' + p.days + ' días'})</h2>` + (p.historyError ? `<p>${esc(p.historyError)}</p>` : c.length ? c.slice(0, 30).map((x) => `<div class="pos"><div class="t"><b>${esc(x.name)}</b><span class="${cls(x.pnl)}">${money(x.pnl)}</span></div>` +
      `${side(x)} · ${fmt(x.amount)} $ · ${fmt(x.openRate, x.openRate < 10 ? 4 : 2)} → ${fmt(x.closeRate, x.closeRate < 10 ? 4 : 2)}<br>${when(x.openTime)} → ${when(x.closeTime)}</div>`).join('') : '<p>No has cerrado ninguna posición en este periodo.</p>');
    html += `<p style="margin-top:10px">Cuenta ${p.account === 'demo' ? 'demo' : 'real'} · solo lectura · actualizado ${new Date(p.updatedAt).toLocaleTimeString('es-ES')}</p>`;
    el.innerHTML = html;
  }

  // ---------- análisis: tus operaciones de oro frente a la recomendación ----------
  async function loadReview() {
    const p = slow.pf;
    if (!p || p.error) return null;
    const from = p.statsFrom ? Date.parse(p.statsFrom) : 0;
    if (!(p.open || []).concat(p.closed || []).some((x) => RV.isGold(x) && Date.parse(x.openTime) >= from)) return { rows: [], empty: true };
    if (slow.rv && Date.now() - slow.rvAt < 30 * 60000) return slow.rv;
    const [h, log] = await Promise.all([getJSON('api/history?days=30'), getJSON('api/recs')]);
    const c1 = ((h && h.candles) || []).map((k) => ({ time: k[0], open: k[1], high: k[2], low: k[3], close: k[4] }));
    const c15 = SYS.resample(c1, 15).filter((k) => k.time + 900 <= Date.now() / 1000);
    const res = RV.analyze({ open: p.open, closed: p.closed, c15, params: TA.DEFAULTS, log, from: p.statsFrom });
    res.from = c15.length ? c15[0].time : null;
    slow.rvAt = Date.now();
    return res;
  }
  function renderReview() {
    const el = $('rv'), p = slow.pf, r = slow.rv;
    if (!cfg.proxy) { el.textContent = 'Solo disponible con tu servidor de Cloudflare.'; return; }
    if (!p || p.error) { el.textContent = p && p.error ? 'Hace falta ver tus posiciones primero (PIN en Ajustes).' : 'Cargando…'; return; }
    if (!r) { el.textContent = 'Cargando…'; return; }
    const desde = p.statsFrom ? 'desde el ' + new Date(p.statsFrom).toLocaleDateString('es-ES') : `en los últimos ${p.days} días`;
    if (r.empty) { el.textContent = `No hay operaciones de oro ${desde}.`; return; }
    const g = r.groups, rowG = (k) => { const x = g[k]; return x.n ? `<tr><td>${RV.GROUPS[k]}</td><td>${x.n}</td><td>${pct(x.winRate)}</td><td class="${cls(x.total)}">${money(x.total)}</td><td class="${cls(x.avg)}">${money(x.avg)}</td></tr>` : ''; };
    let html = `<p style="margin:0 0 6px">Operaciones de oro abiertas ${desde}${p.statsFrom ? ' (creación de Cortés)' : ''}.</p>` + '<table class="pp"><tr><th>Cerradas</th><th>Nº</th><th>Ganadoras</th><th>Total</th><th>Media</th></tr>' +
      ['favor', 'contra', 'esperar', 'sin'].map(rowG).join('') +
      `<tr><td><b>Todas</b></td><td>${r.all.n}</td><td>${pct(r.all.winRate)}</td><td class="${cls(r.all.total)}">${money(r.all.total)}</td><td class="${cls(r.all.avg)}">${money(r.all.avg)}</td></tr></table>`;
    const cs = r.cycleStats;
    if (r.cycles.length) {
      const dur = (m) => (m < 120 ? m + ' min' : m < 2880 ? (m / 60).toFixed(1) + ' h' : (m / 1440).toFixed(1) + ' d');
      html += `<h2 style="margin-top:12px">Pirámides (${r.cycles.length})</h2><p style="margin:0 0 6px">Las posiciones que añades mientras otras siguen abiertas cuentan como una sola operación. ` +
        `Media ${cs.avgSteps.toFixed(1)} escalones, máximo ${cs.maxSteps} · margen máximo ${fmt(cs.maxMargin)} $ · peor pérdida latente <b class="dn">${cs.worst == null ? '—' : money(cs.worst)}</b> · cerradas: ${cs.n}, ${pct(cs.winRate)} ganadoras, total <b class="${cls(cs.total)}">${money(cs.total)}</b>.</p>` +
        '<table class="pp"><tr><th>Inicio</th><th>Esc.</th><th>Margen</th><th>Peor</th><th>Result.</th></tr>' +
        r.cycles.slice().reverse().slice(0, 20).map((c) => `<tr><td>${when(c.start)}${c.isOpen ? ' · abierta' : ' · ' + dur(c.minutes)}</td><td>${c.steps}</td><td>${fmt(c.maxMargin, 0)}</td><td class="dn">${c.worst == null ? '—' : fmt(Math.round(c.worst) || 0, 0)}</td><td class="${cls(c.pnl)}">${money(c.pnl)}</td></tr>`).join('') + '</table>' +
        '<p style="margin:4px 0 0">"Peor": la mayor pérdida latente de la pirámide, estimada con velas de 15 min.</p>';
    }
    html += '<h2 style="margin-top:12px">Sugerencias</h2><ul style="margin:0;padding-left:18px">' + r.suggestions.map((s) => `<li style="margin:4px 0">${esc(s)}</li>`).join('') + '</ul>';
    const word = { favor: '<span class="up">a favor</span>', contra: '<span class="dn">en contra</span>', esperar: 'en ESPERAR', sin: 'sin datos' };
    html += '<h2 style="margin-top:12px">Detalle</h2>' + r.rows.slice().sort((a, b) => Date.parse(b.openTime) - Date.parse(a.openTime)).slice(0, 30).map((x) =>
      `<div class="pos"><div class="t"><b>${x.isBuy ? 'Compra' : 'Venta'} ${when(x.openTime)}${x.isOpen ? ' · abierta' : ''}</b><span class="${cls(x.pnl)}">${money(x.pnl)}</span></div>` +
      `Al abrir: ${x.recOpen || '—'}${x.group === 'favor' || x.group === 'contra' ? ` (${word[x.group]})` : ''}${x.stageOpen ? ', tendencia ' + esc(x.stageOpen) : ''}${x.isOpen ? '' : ` · al cerrar: ${x.recClose || '—'}`}${x.minutes != null ? ` · ${x.minutes < 120 ? x.minutes + ' min' : (x.minutes / 60).toFixed(1) + ' h'}` : ''}${x.source === 'recalculada' ? ' · recalculada' : ''}</div>`).join('');
    if (r.otherClosed) html += `<p style="margin-top:8px">${r.otherClosed} ${r.otherClosed === 1 ? 'operación cerrada' : 'operaciones cerradas'} de otros instrumentos no ${r.otherClosed === 1 ? 'entra' : 'entran'} en este análisis.</p>`;
    html += '<div class="actions" style="justify-content:flex-start"><button id="rvCopy">Copiar resumen</button></div>';
    el.innerHTML = html;
    $('rvCopy').onclick = () => {
      const lines = [`Operaciones de oro ${desde}:`, ...['favor', 'contra', 'esperar', 'sin'].filter((k) => g[k].n).map((k) => `- ${RV.GROUPS[k]}: ${g[k].n} ops, ${pct(g[k].winRate)} ganadoras, total ${money(g[k].total)}, media ${money(g[k].avg)}`),
        '', `Pirámides: ${r.cycles.length} · media ${cs.avgSteps ? cs.avgSteps.toFixed(1) : '-'} escalones, máx ${cs.maxSteps} · margen máx ${cs.maxMargin} $ · peor latente ${cs.worst == null ? '-' : cs.worst.toFixed(0)} $`,
        ...r.cycles.map((c) => `${c.start} ${c.isBuy ? 'COMPRA' : 'VENTA'} ${c.steps} escalones, margen ${c.maxMargin}$, peor ${c.worst == null ? '-' : c.worst.toFixed(0)}$, ${c.isOpen ? 'abierta' : 'P/L ' + c.pnl.toFixed(2)}, rec. al empezar ${c.recStart || '-'}`),
        '', `Pirámides: ${r.cycles.length} · media ${cs.avgSteps ? cs.avgSteps.toFixed(1) : '-'} escalones, máx ${cs.maxSteps} · margen máx ${cs.maxMargin} $ · peor latente ${cs.worst == null ? '-' : cs.worst.toFixed(0)} $`,
        ...r.cycles.map((c) => `${c.start} ${c.isBuy ? 'COMPRA' : 'VENTA'} ${c.steps} escalones, margen ${c.maxMargin}$, peor ${c.worst == null ? '-' : c.worst.toFixed(0)}$, ${c.isOpen ? 'abierta' : 'P/L ' + c.pnl.toFixed(2)}, rec. al empezar ${c.recStart || '-'}`),
        '', 'Detalle:', ...r.rows.map((x) => `${x.openTime} ${x.isBuy ? 'COMPRA' : 'VENTA'} x${x.leverage} ${x.amount}$ → ${x.isOpen ? 'abierta' : x.closeTime} P/L ${x.pnl} · rec. al abrir ${x.recOpen || '-'} (${x.stageOpen || '-'}) · al cerrar ${x.recClose || '-'}`)];
      navigator.clipboard.writeText(lines.join('\n')).then(() => { $('rvCopy').textContent = 'Copiado'; }, () => { $('rvCopy').textContent = 'No se pudo copiar'; });
    };
  }

  function render(res) {
    const { candles, live, label } = res;
    const now = Date.now() / 1000;
    const closed = candles.filter((k) => k.time + 3600 <= now);
    if (closed.length < 400) throw new Error('Pocas velas de 1 h recibidas (' + closed.length + '). El mercado puede estar cerrado.');
    $('src').textContent = label;
    const e = SYS.evaluate(closed, { tail: 48 });
    renderSystem(e, live, closed);
    renderPaper();
    candleS.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    if (!fitted) { chart.timeScale().setVisibleLogicalRange({ from: candles.length - 120, to: candles.length + 3 }); fitted = true; }
  }

  function notify(title, body) {
    if (!cfg.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    navigator.serviceWorker && navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(title, { body, icon: 'icon-192.png', tag: 'oro' }))
      .catch(() => new Notification(title, { body }));
    if (navigator.vibrate) navigator.vibrate(200);
  }

  // Tus posiciones y el análisis: nunca bloquean ni rompen el resto de la app.
  function renderAccount() {
    try { renderPortfolio(); } catch (e) { console.warn(e); $('pf').textContent = 'No se pudieron mostrar tus posiciones: ' + e.message; }
    try { renderReview(); } catch (e) { console.warn(e); $('rv').textContent = 'No se pudo calcular el análisis: ' + e.message; }
  }
  let accountBusy = false;
  async function refreshAccount() {
    if (accountBusy) return; accountBusy = true;
    try {
      slow.pf = await loadPortfolio();
      try { slow.rv = await loadReview(); } catch (e) { slow.rv = null; console.warn(e); }
    } finally { accountBusy = false; renderAccount(); }
  }

  async function refreshSlow() {
    if (Date.now() - slow.at < SLOW_MS) return;
    slow.at = Date.now();
    if (cfg.proxy) {
      slow.sys = await getJSON('api/sistema');
      refreshAccount(); // en segundo plano: si eToro tarda, el resto de la app no espera
    }
  }

  async function refresh() {
    if (busy) return; busy = true; $('refresh').disabled = true;
    try {
      await refreshSlow();
      renderAccount();
      const res = await Data.load(cfg, 60);
      showError(''); render(res);
    } catch (e) {
      showError(e.message);
      if (e.kind === 'keys') openSettings();
    } finally { busy = false; $('refresh').disabled = false; }
  }

  function schedule() { clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS); }

  // ---------- ajustes ----------
  function syncSettingsUI() {
    $('source').value = cfg.source; $('apiKey').value = cfg.apiKey; $('userKey').value = cfg.userKey;
    $('pin').value = cfg.pin; $('notify').checked = !!cfg.notify;
    $('pinBox').style.display = cfg.proxy ? '' : 'none';
    $('ntfyBox').style.display = cfg.proxy ? '' : 'none';
    $('etoroBox').style.display = cfg.source === 'etoro' ? '' : 'none';
    $('keysBox').style.display = cfg.proxy ? 'none' : '';
    $('proxyState').textContent = cfg.proxy ? 'Conectado a través de tu servidor: las claves están guardadas allí, no en el móvil.' : '';
  }
  // Estado de los avisos de ntfy (los envía el servidor, con el móvil apagado).
  const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'ahora' : m < 90 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`; };
  function ntfyText(s) {
    if (!s) return 'No se pudo leer el estado del servidor.';
    const out = [s.ntfy ? `Tema configurado: ${s.ntfy.topic} en ${s.ntfy.server}.` : 'Falta el secreto NTFY_TOPIC en Cloudflare: sin él no se envía ningún aviso.'];
    if (!s.etoroKeys) out.push('Faltan las claves de eToro en Cloudflare.');
    out.push(s.cronLast ? `Última comprobación automática ${ago(s.cronLast.t)}: ${s.cronLast.result}.` : 'El servidor aún no ha registrado ninguna comprobación automática (o es anterior a esta versión).');
    if (s.cronLast && Date.now() - Date.parse(s.cronLast.t) > 40 * 60000) out.push('⚠︎ Lleva más de 40 min sin comprobar: revisa en Cloudflare que el Worker tenga el cron activo y no dé errores (con el mercado cerrado es normal).');
    if (s.ntfyLast) out.push(`Último aviso ${ago(s.ntfyLast.t)}: «${s.ntfyLast.title}» ${s.ntfyLast.ok ? 'enviado' : 'FALLÓ: ' + s.ntfyLast.error}.`);
    out.push('Se avisa de: movimiento probable (como mucho 2 al día), señal de COMPRA o VENTA, cierre a las 6 h y víspera de NFP o Fed.');
    return out.join(' ');
  }
  async function loadNtfyState() { if (cfg.proxy) $('ntfyState').textContent = ntfyText(await getJSON('api/status')); }
  $('ntfyTest').addEventListener('click', async () => {
    const pin = $('pin').value.trim();
    if (!pin) { $('ntfyState').textContent = 'Escribe tu PIN arriba para enviar la prueba.'; return; }
    $('ntfyTest').disabled = true; $('ntfyState').textContent = 'Enviando…';
    try {
      const r = await fetch('api/ntfy-test?run=1', { method: 'POST', headers: { 'x-admin-pin': pin } });
      const j = await r.json().catch(() => ({}));
      $('ntfyState').textContent = (r.ok ? 'Prueba enviada: debería llegarte ya al móvil. Si no llega, revisa que en la app ntfy estés suscrito exactamente al mismo tema. ' : 'La prueba falló: ' + (j.error || 'el servidor respondió ' + r.status) + '. ') + (j.status ? ntfyText(j.status) : '');
    } catch (e) { $('ntfyState').textContent = 'La prueba falló: ' + e.message; }
    finally { $('ntfyTest').disabled = false; }
  });
  function openSettings() { syncSettingsUI(); loadNtfyState(); $('settings').showModal(); }
  $('source').addEventListener('change', () => { $('etoroBox').style.display = $('source').value === 'etoro' ? '' : 'none'; });
  $('openSettings').addEventListener('click', openSettings);
  $('settings').addEventListener('close', async () => {
    if ($('settings').returnValue !== 'ok') return;
    const sourceChanged = cfg.source !== $('source').value;
    Object.assign(cfg, { source: $('source').value, apiKey: $('apiKey').value.trim(), userKey: $('userKey').value.trim(), pin: $('pin').value.trim(), notify: $('notify').checked });
    delete cfg.instrumentId;
    save();
    if (cfg.notify && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    if (sourceChanged) { slow = { at: 0, sys: null, pf: null, rv: null, rvAt: 0 }; fitted = false; }
    slow.at = 0; last = null; refresh();
  });

  $('refresh').addEventListener('click', () => { slow.at = 0; refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  (async function init() {
    cfg.proxy = await Data.detectProxy();
    if (cfg.source === 'etoro' && !cfg.proxy && !(cfg.apiKey && cfg.userKey)) {
      showError('Para usar tu cuenta de eToro añade tus claves en Ajustes, o elige la fuente demo.');
      openSettings(); return schedule();
    }
    refresh(); schedule();
  })();
})();

(function () {
  const $ = (id) => document.getElementById(id);
  const TA = window.GoldTA, MV = window.GoldMove, Data = window.GoldData, RV = window.GoldReview;
  const REFRESH_MS = 30000, SLOW_MS = 5 * 60000;

  const store = {
    get() { try { return JSON.parse(localStorage.getItem('oro.cfg') || '{}'); } catch { return {}; } },
    set(v) { try { localStorage.setItem('oro.cfg', JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
  };
  const cfg = Object.assign({ source: 'etoro', apiKey: '', userKey: '', pin: '', notify: false, refs: { m15: 5, h1: 10, h4: 20 } }, store.get());
  cfg.proxy = false;
  // Parámetros del motor de dirección (informativo). Con servidor, se guardan allí.
  const PARAM_KEYS = ['mode', 'threshold', 'agree', 'htf', 'minMove'];
  const pick = (o) => Object.fromEntries(PARAM_KEYS.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
  let params = { ...pick(TA.DEFAULTS), ...pick(cfg.params) };
  let timer = null, busy = false, lastLevel = null;
  let slow = { at: 0, c15: null, history: [], paper: null, pf: null, rv: null, rvAt: 0 }; // datos que cambian despacio
  const save = () => { const { proxy, ...persist } = cfg; persist.params = params; store.set(persist); };
  const paramsText = (p) => `${TA.MODES[p.mode] || p.mode} · exigencia ${(+p.threshold).toFixed(2)} · coincidencia ${Math.round(p.agree * 100)}%${p.htf ? ' · con tendencia 15 min' : ''}`;

  async function getJSON(url) { try { const r = await fetch(url, { cache: 'no-store' }); return r.ok ? r.json() : null; } catch { return null; } }
  async function loadServerParams() { const j = await getJSON('api/params'); if (j) { params = { ...params, ...pick(j) }; save(); } }
  async function pushServerParams(p) {
    if (!cfg.proxy) { params = { ...params, ...pick(p) }; save(); return; }
    if (!cfg.pin) throw new Error('Escribe tu PIN en Ajustes para cambiar los ajustes de dirección.');
    const r = await fetch('api/params', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-pin': cfg.pin }, body: JSON.stringify(pick(p)) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'El servidor respondió ' + r.status);
    params = { ...params, ...pick(j) }; save();
  }

  // ---------- gráfico ----------
  const chart = LightweightCharts.createChart($('chart'), {
    layout: { background: { color: 'transparent' }, textColor: '#a89f88' },
    grid: { vertLines: { color: '#2a261c' }, horzLines: { color: '#2a261c' } },
    rightPriceScale: { borderColor: '#3a3426' },
    timeScale: { borderColor: '#3a3426', timeVisible: true, secondsVisible: false },
    localization: { locale: 'es-ES' }, autoSize: true,
  });
  const candleS = chart.addCandlestickSeries({ upColor: '#2fbf71', downColor: '#e5534b', borderVisible: false, wickUpColor: '#2fbf71', wickDownColor: '#e5534b' });
  const e21 = chart.addLineSeries({ color: '#7aa2f7', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  let bands = [], fitted = false;

  const line = (candles, arr) => candles.map((k, i) => ({ time: k.time, value: arr[i] })).filter((p) => !isNaN(p.value));
  const fmt = (x, d = 2) => (x == null || isNaN(x) ? '—' : x.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (x) => (isNaN(x) ? '—' : Math.round(x * 100) + '%');
  const hhmm = (t) => new Date(t * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  function showError(msg) { const e = $('err'); e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; }

  // Une el histórico guardado en el servidor con las velas recién descargadas.
  function merged(c1) {
    const by = new Map(slow.history.map((k) => [k[0], { time: k[0], open: k[1], high: k[2], low: k[3], close: k[4] }]));
    for (const k of c1) by.set(k.time, k);
    return [...by.values()].sort((a, b) => a.time - b.time).slice(-6000); // ~4 días bastan para calibrar
  }

  function renderMovement(c1, live) {
    const f = MV.forecast({ 1: merged(c1), ...(slow.c15 ? { 15: slow.c15 } : {}) }, cfg.refs);
    const px = live && isFinite(live.bid) ? live.bid : c1[c1.length - 1].close;
    $('price').textContent = '$' + fmt(px) + (live && isFinite(live.ask) ? '  ·  ask ' + fmt(live.ask) : '');
    $('mv').innerHTML = f.map((x) => `<div><div class="h">${x.label}</div><div class="r">±${fmt(x.excursion, 1)} $</div>
      <div class="p">rango ~${fmt(x.range, 0)} $</div><div class="pbar"><i style="width:${Math.round(x.prob * 100)}%"></i></div>
      <div class="p">${pct(x.prob)} de alejarse ≥${x.ref} $</div><span class="chip ${x.level}">${x.level}</span></div>`).join('');
    const h1 = f.find((x) => x.id === 'h1');
    const cal = f.length && f.every((x) => x.calibrated) ? 'calibrado con ' + Math.min(...f.map((x) => x.samples)).toLocaleString('es-ES') + '+ ventanas pasadas'
      : 'calibración provisional: aún hay pocos datos guardados';
    $('moveNote').textContent = `Alejamiento típico desde el precio actual según la volatilidad y la hora (UTC ${new Date().getUTCHours()} h) · ${cal}.`;
    bands.forEach((b) => candleS.removePriceLine(b)); bands = [];
    if (h1) for (const s of [1, -1]) bands.push(candleS.createPriceLine({ price: px + s * h1.excursion, color: '#e2b23c', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '1 h' }));
    if (h1 && lastLevel && h1.level === 'ALTO' && lastLevel !== 'ALTO') notify(h1);
    if (h1) lastLevel = h1.level;
  }

  function renderDirection(c1) {
    const I = TA.computeAll(c1);
    const s = TA.stableSignal(slow.c15, params);
    const act = $('act'); act.textContent = s.action; act.className = 'act ' + s.action;
    $('reason').textContent = s.reason + (s.action !== 'ESPERAR' && s.since ? ` (desde las ${hhmm(s.since)})` : '');
    $('paramsLine').textContent = 'Velas de 15 min cerradas · ' + paramsText(params);
    $('meters').innerHTML = s.parts.map((p) => {
      const w = Math.abs(p.v) * 45, left = p.v >= 0 ? 50 : 50 - w;
      const cls = p.v > 0.1 ? 'up' : p.v < -0.1 ? 'dn' : 'nt';
      const tag = p.v > 0.1 ? 'Alcista' : p.v < -0.1 ? 'Bajista' : 'Neutral';
      const col = p.v > 0.1 ? 'var(--buy)' : p.v < -0.1 ? 'var(--sell)' : 'var(--muted)';
      return `<div class="row"><div class="n">${p.name}<small>${p.txt}</small></div>
        <div class="bar"><i style="left:${left}%;width:${Math.max(w, 2)}%;background:${col}"></i></div><div class="tag ${cls}">${tag}</div></div>`;
    }).join('');
    return I;
  }

  function renderPaper() {
    const el = $('paper'), p = slow.paper;
    if (!cfg.proxy) { el.textContent = 'Solo disponible con tu servidor de Cloudflare.'; return; }
    if (!p) { el.textContent = 'Sin datos todavía.'; return; }
    const closed = p.closed || [], open = p.open || [];
    const total = closed.reduce((a, t) => a + t.pnl, 0), wins = closed.filter((t) => t.pnl > 0).length;
    let html = closed.length
      ? `<p><b>${closed.length}</b> operaciones cerradas · ${wins} ganadoras · resultado total <b class="${total >= 0 ? 'up' : 'dn'}">${total >= 0 ? '+' : ''}${fmt(total)} $</b> (${fmt(total / closed.length)} $ de media). Hacen falta unas 250 para sacar conclusiones.</p>`
      : '<p>Todavía no se ha producido ninguna ruptura. Suele haber una cada dos días.</p>';
    if (open.length) html += `<p>Abierta: <b>${open[0].side}</b> desde ${fmt(open[0].entry)} $ (${hhmm(open[0].time + 3600)}), se cierra hacia las ${hhmm(open[0].time + 3600 + 4 * 3600)}.</p>`;
    if (closed.length) html += '<table class="pp"><tr><th>Entrada</th><th>Lado</th><th>Precio</th><th>Salida</th><th>Resultado</th></tr>' +
      closed.slice(-8).reverse().map((t) => `<tr><td>${new Date((t.time + 3600) * 1000).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td>${t.side}</td><td>${fmt(t.entry)}</td><td>${fmt(t.exit)}</td><td class="${t.pnl >= 0 ? 'up' : 'dn'}">${t.pnl >= 0 ? '+' : ''}${fmt(t.pnl)}</td></tr>`).join('') + '</table>';
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
    const c15 = MV.resample(c1, 15).filter((k) => k.time + 900 <= Date.now() / 1000);
    const res = RV.analyze({ open: p.open, closed: p.closed, c15, params, log, from: p.statsFrom });
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
    if (candles.length < 80) throw new Error('Pocas velas recibidas (' + candles.length + '). El mercado puede estar cerrado.');
    $('src').textContent = label;
    const I = renderDirection(candles);
    renderMovement(candles, live);
    renderPaper();
    $('updated').textContent = 'Última vela ' + hhmm(candles[candles.length - 1].time) + ' · actualizado ' + new Date().toLocaleTimeString('es-ES');
    candleS.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    e21.setData(line(candles, I.ema21));
    if (!fitted) { chart.timeScale().setVisibleLogicalRange({ from: candles.length - 120, to: candles.length + 3 }); fitted = true; }
  }

  function notify(h1) {
    if (!cfg.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    const body = `Próxima hora: ±${fmt(h1.excursion, 1)} $ (${pct(h1.prob)} de alejarse ≥${h1.ref} $). Indica tamaño, no dirección.`;
    navigator.serviceWorker && navigator.serviceWorker.ready
      .then((reg) => reg.showNotification('Cortés: se espera mucho movimiento', { body, icon: 'icon-192.png', tag: 'oro' }))
      .catch(() => new Notification('Cortés: se espera mucho movimiento', { body }));
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
    try { slow.c15 = (await Data.load(cfg, 15)).candles.filter((k) => k.time + 900 <= Date.now() / 1000); } catch { slow.c15 = null; }
    if (cfg.proxy) {
      const [h, p] = await Promise.all([getJSON('api/history?days=4'), getJSON('api/paper')]);
      slow.history = (h && h.candles) || []; slow.paper = p;
      refreshAccount(); // en segundo plano: si eToro tarda, el resto de la app no espera
    }
  }

  async function refresh() {
    if (busy) return; busy = true; $('refresh').disabled = true;
    try {
      await refreshSlow();
      renderAccount();
      const res = await Data.load(cfg, 1);
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
    for (const k of ['m15', 'h1', 'h4']) $('ref_' + k).value = cfg.refs[k];
    $('mode').value = params.mode; $('threshold').value = String(params.threshold); $('agree').value = String(params.agree);
    $('htf').checked = !!params.htf; $('pin').value = cfg.pin; $('notify').checked = !!cfg.notify;
    $('pinBox').style.display = cfg.proxy ? '' : 'none';
    $('ntfyBox').style.display = cfg.proxy ? '' : 'none';
    $('etoroBox').style.display = cfg.source === 'etoro' ? '' : 'none';
    $('keysBox').style.display = cfg.proxy ? 'none' : '';
    $('proxyState').textContent = cfg.proxy ? 'Conectado a través de tu servidor: las claves están guardadas allí, no en el móvil.' : '';
  }
  // Estado de los avisos de ntfy (los envía el servidor cada 15 min, con el móvil apagado).
  const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'ahora' : m < 90 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`; };
  function ntfyText(s) {
    if (!s) return 'No se pudo leer el estado del servidor.';
    const out = [s.ntfy ? `Tema configurado: ${s.ntfy.topic} en ${s.ntfy.server}.` : 'Falta el secreto NTFY_TOPIC en Cloudflare: sin él no se envía ningún aviso.'];
    if (!s.etoroKeys) out.push('Faltan las claves de eToro en Cloudflare.');
    out.push(s.cronLast ? `Última comprobación automática ${ago(s.cronLast.t)}: ${s.cronLast.result}.` : 'El servidor aún no ha registrado ninguna comprobación automática (o es anterior a esta versión).');
    if (s.cronLast && Date.now() - Date.parse(s.cronLast.t) > 40 * 60000) out.push('⚠︎ Lleva más de 40 min sin comprobar: revisa en Cloudflare que el Worker tenga el cron */15 activo y no dé errores.');
    if (s.ntfyLast) out.push(`Último aviso ${ago(s.ntfyLast.t)}: «${s.ntfyLast.title}» ${s.ntfyLast.ok ? 'enviado' : 'FALLÓ: ' + s.ntfyLast.error}.`);
    out.push('Solo se avisa al cambiar: COMPRAR/VENDER/ESPERAR o movimiento de la próxima hora a ALTO y de vuelta.');
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
    const refs = {};
    for (const k of ['m15', 'h1', 'h4']) refs[k] = Math.max(1, +$('ref_' + k).value || cfg.refs[k]);
    const sourceChanged = cfg.source !== $('source').value;
    Object.assign(cfg, { source: $('source').value, apiKey: $('apiKey').value.trim(), userKey: $('userKey').value.trim(), pin: $('pin').value.trim(), notify: $('notify').checked, refs });
    delete cfg.instrumentId;
    const next = { ...params, mode: $('mode').value, threshold: +$('threshold').value, agree: +$('agree').value, htf: $('htf').checked };
    save();
    if (JSON.stringify(pick(next)) !== JSON.stringify(pick(params))) {
      try { await pushServerParams(next); } catch (e) { showError(e.message); }
    }
    if (cfg.notify && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    if (sourceChanged) { slow = { at: 0, c15: null, history: [], paper: null, pf: null, rv: null, rvAt: 0 }; fitted = false; }
    slow.at = 0;
    lastLevel = null; refresh();
  });

  $('refresh').addEventListener('click', () => { slow.at = 0; refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  (async function init() {
    cfg.proxy = await Data.detectProxy();
    if (cfg.proxy) await loadServerParams();
    if (cfg.source === 'etoro' && !cfg.proxy && !(cfg.apiKey && cfg.userKey)) {
      showError('Para usar tu cuenta de eToro añade tus claves en Ajustes, o elige la fuente demo.');
      openSettings(); return schedule();
    }
    refresh(); schedule();
  })();
})();

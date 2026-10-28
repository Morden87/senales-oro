(function () {
  const $ = (id) => document.getElementById(id);
  const TA = window.GoldTA, Data = window.GoldData;
  const HORIZON_MIN = 15, REFRESH_MS = 30000;

  const store = {
    get() { try { return JSON.parse(localStorage.getItem('oro.cfg') || '{}'); } catch { return {}; } },
    set(v) { try { localStorage.setItem('oro.cfg', JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
  };
  const cfg = Object.assign({ source: 'etoro', apiKey: '', userKey: '', pin: '', notify: false, minutes: 1 }, store.get());
  cfg.proxy = false;
  // Parámetros del motor. Con servidor, la fuente de verdad son los guardados allí (los mismos que usan los avisos).
  const PARAM_KEYS = ['mode', 'threshold', 'agree', 'htf', 'minMove'];
  const pick = (o) => Object.fromEntries(PARAM_KEYS.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
  let params = { ...pick(TA.DEFAULTS), ...pick(cfg.params) };
  let lastAction = null, timer = null, busy = false, lastCandles = null;
  const save = () => { const { proxy, ...persist } = cfg; persist.params = params; store.set(persist); };
  const paramsText = (p) => `${TA.MODES[p.mode] || p.mode} · exigencia ${(+p.threshold).toFixed(2)} · coincidencia ${Math.round(p.agree * 100)}%` +
    `${p.htf ? ' · con tendencia 15 min' : ''} · mínimo ${p.minMove} $`;
  async function loadServerParams() {
    try { const r = await fetch('api/params', { cache: 'no-store' }); if (r.ok) { params = { ...params, ...pick(await r.json()) }; save(); } } catch { /* sin conexión */ }
  }
  async function pushServerParams(p, note) {
    if (!cfg.proxy) { params = { ...params, ...pick(p) }; save(); return; }
    if (!cfg.pin) throw new Error('Escribe tu PIN en Ajustes para cambiar los ajustes de la app y de los avisos.');
    const r = await fetch('api/params', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-pin': cfg.pin }, body: JSON.stringify({ ...pick(p), note }) });
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
  const e9 = chart.addLineSeries({ color: '#e2b23c', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  const e21 = chart.addLineSeries({ color: '#7aa2f7', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  const bbU = chart.addLineSeries({ color: 'rgba(168,159,136,.45)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
  const bbL = chart.addLineSeries({ color: 'rgba(168,159,136,.45)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
  let fitted = false;

  const line = (candles, arr) => candles.map((k, i) => ({ time: k.time, value: arr[i] })).filter((p) => !isNaN(p.value));
  const fmt = (x, d = 2) => (x == null || isNaN(x) ? '—' : x.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }));

  function showError(msg) { const e = $('err'); e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; }

  function render(res) {
    const { candles, live, label } = res;
    if (candles.length < 80) throw new Error('Pocas velas recibidas (' + candles.length + '). El mercado puede estar cerrado.');
    const I = TA.computeAll(candles);
    const bars = HORIZON_MIN / cfg.minutes;
    const opts = { ...params, horizon: bars };
    // Se decide con la última vela cerrada; la más reciente puede estar todavía formándose.
    const now = Date.now() / 1000;
    let i = candles.length - 1;
    if (candles[i].time + cfg.minutes * 60 > now) i--;
    if (cfg.minutes === 1) lastCandles = candles;
    $('paramsLine').textContent = 'Ajustes: ' + paramsText(params);
    const s = TA.signalAt(I, i, opts);

    $('src').textContent = label;
    const act = $('act'); act.textContent = s.action; act.className = 'act ' + s.action;
    const px = live && isFinite(live.bid) ? live.bid : s.price;
    $('price').textContent = '$' + fmt(px) + (live && isFinite(live.ask) ? '  ·  ask ' + fmt(live.ask) : '');
    $('reason').textContent = s.reason + (s.expectedMove ? ` · recorrido probable ~${fmt(s.expectedMove, 1)} $` : '') + (s.agree != null ? ` · ${Math.round(s.agree * 100)}% de medidores de acuerdo` : '');
    $('needle').style.left = ((s.score + 1) / 2 * 100).toFixed(1) + '%';
    $('score').textContent = 'puntuación ' + (s.score >= 0 ? '+' : '') + s.score.toFixed(2);
    $('atr').textContent = fmt(s.atr) + ' (' + fmt(s.atrPct, 3) + '%)';
    $('stop').textContent = s.stop ? fmt(s.stop) : '—';
    $('target').textContent = s.target ? fmt(s.target) : '—';
    const lastT = new Date(candles[i].time * 1000);
    $('updated').textContent = 'Última vela ' + lastT.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) + ' · actualizado ' + new Date().toLocaleTimeString('es-ES');

    $('meters').innerHTML = s.parts.map((p) => {
      const w = Math.abs(p.v) * 45, left = p.v >= 0 ? 50 : 50 - w;
      const cls = p.v > 0.1 ? 'up' : p.v < -0.1 ? 'dn' : 'nt';
      const tag = p.v > 0.1 ? 'Alcista' : p.v < -0.1 ? 'Bajista' : 'Neutral';
      const col = p.v > 0.1 ? 'var(--buy)' : p.v < -0.1 ? 'var(--sell)' : 'var(--muted)';
      return `<div class="row"><div class="n">${p.name}<small>${p.txt}</small></div>
        <div class="bar"><i style="left:${left}%;width:${Math.max(w, 2)}%;background:${col}"></i></div><div class="tag ${cls}">${tag}</div></div>`;
    }).join('');

    const bt = TA.backtest(I, opts);
    $('btRate').textContent = isNaN(bt.rate) ? '—' : Math.round(bt.rate * 100) + '%';
    $('btN').textContent = bt.total;
    $('btBase').textContent = isNaN(bt.baseRate) ? '—' : Math.round(bt.baseRate * 100) + '%';
    $('btNote').textContent = bt.total
      ? `En las últimas ${bt.bars} velas, cuando la app dijo comprar o vender, el precio llegó a moverse ${params.minMove} $ a favor dentro de los ${HORIZON_MIN} min siguientes el ${Math.round(bt.rate * 100)}% de las veces. Sin hacer caso a ninguna señal, eso pasa el ${Math.round(bt.baseRate * 100)}% de las veces: la señal solo aporta algo si supera esa cifra. ${bt.total < 30 ? 'Son muy pocas señales para sacar conclusiones.' : ''}`
      : `Todavía no hay señales con recorrido de ${params.minMove} $ en los datos cargados.`;

    candleS.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    e9.setData(line(candles, I.ema9)); e21.setData(line(candles, I.ema21));
    bbU.setData(line(candles, I.bb.up)); bbL.setData(line(candles, I.bb.lo));
    if (!fitted) { chart.timeScale().setVisibleLogicalRange({ from: candles.length - 90, to: candles.length + 3 }); fitted = true; }

    if (lastAction && s.action !== lastAction) notifyChange(s);
    lastAction = s.action;
  }

  function notifyChange(s) {
    if (!cfg.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    const body = `${s.action} a $${fmt(s.price)} · ${s.reason}`;
    navigator.serviceWorker && navigator.serviceWorker.ready
      .then((reg) => reg.showNotification('Cortés: ' + s.action, { body, icon: 'icon-192.png', tag: 'oro' }))
      .catch(() => new Notification('Cortés: ' + s.action, { body }));
    if (navigator.vibrate) navigator.vibrate(200);
  }

  async function refresh() {
    if (busy) return; busy = true; $('refresh').disabled = true;
    try {
      const res = await Data.load(cfg, cfg.minutes);
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
    $('mode').value = params.mode; $('threshold').value = String(params.threshold); $('agree').value = String(params.agree);
    $('htf').checked = !!params.htf; $('minMove').value = params.minMove; $('pin').value = cfg.pin; $('notify').checked = !!cfg.notify;
    $('pinBox').style.display = cfg.proxy ? '' : 'none';
    $('etoroBox').style.display = cfg.source === 'etoro' ? '' : 'none';
    $('keysBox').style.display = cfg.proxy ? 'none' : '';
    $('proxyState').textContent = cfg.proxy ? 'Conectado a través de tu servidor: las claves están guardadas allí, no en el móvil.' : '';
  }
  function openSettings() { syncSettingsUI(); $('settings').showModal(); }
  $('source').addEventListener('change', () => { $('etoroBox').style.display = $('source').value === 'etoro' ? '' : 'none'; });
  $('openSettings').addEventListener('click', openSettings);
  $('settings').addEventListener('close', async () => {
    if ($('settings').returnValue !== 'ok') return;
    Object.assign(cfg, {
      source: $('source').value, apiKey: $('apiKey').value.trim(), userKey: $('userKey').value.trim(),
      pin: $('pin').value.trim(), notify: $('notify').checked,
    });
    delete cfg.instrumentId;
    const next = { mode: $('mode').value, threshold: +$('threshold').value, agree: +$('agree').value,
      htf: $('htf').checked, minMove: Math.max(0, +$('minMove').value || 0) };
    save();
    if (JSON.stringify(pick(next)) !== JSON.stringify(pick(params))) {
      try { await pushServerParams(next, 'manual'); } catch (e) { showError(e.message); }
    }
    if (cfg.notify && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    lastAction = null; fitted = false; refresh();
  });

  $('tf').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    cfg.minutes = +b.dataset.m; [...$('tf').children].forEach((x) => x.classList.toggle('on', x === b));
    save(); fitted = false; lastAction = null; refresh();
  });
  $('refresh').addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  // ---------- optimizador ----------
  let proposal = null;
  async function historyCandles() {
    let rows = [];
    if (cfg.proxy) {
      try { const r = await fetch('api/history?days=30', { cache: 'no-store' }); if (r.ok) rows = (await r.json()).candles || []; } catch { /* sin histórico */ }
    }
    const byTime = new Map(rows.map((k) => [k[0], { time: k[0], open: k[1], high: k[2], low: k[3], close: k[4] }]));
    for (const k of lastCandles || []) byTime.set(k.time, k);
    const now = Date.now() / 1000;
    return [...byTime.values()].filter((k) => k.time + 60 <= now).sort((a, b) => a.time - b.time);
  }
  const pct = (x) => (isNaN(x) ? '—' : Math.round(x * 100) + '%');
  const stat = (b) => `${b.hits}/${b.total} (${pct(b.rate)}) vs ${pct(b.baseRate)} sin señal`;
  $('optRun').addEventListener('click', async () => {
    const btn = $('optRun'); btn.disabled = true; $('optApply').hidden = true; proposal = null;
    try {
      if (!lastCandles) throw new Error('Abre primero las velas de 1 min para cargar datos.');
      $('optOut').textContent = 'Cargando histórico…';
      const candles = await historyCandles();
      const days = (candles[candles.length - 1].time - candles[0].time) / 86400;
      const r = await TA.optimize(candles, { ...params, horizon: 15 }, (f) => { $('optOut').textContent = `Probando combinaciones… ${Math.round(f * 100)}%`; });
      let html = `<p>${candles.length.toLocaleString('es-ES')} velas (${days.toFixed(1)} días). ${r.tried} combinaciones probadas con el 70% más antiguo y validadas con el 30% más reciente.</p>`;
      html += `<p><b>Ajustes actuales</b> · ${paramsText(params)}<br>Validación: ${stat(r.current.test)}</p>`;
      if (!r.best) html += '<p>No hay suficientes señales para comparar. Vuelve a intentarlo cuando el servidor haya guardado más días.</p>';
      else {
        const better = r.best.test.total >= 5 && r.best.test.rate - r.best.test.baseRate > r.current.test.rate - r.current.test.baseRate;
        html += `<p><b>Mejor combinación</b> · ${paramsText(r.best.p)}<br>Aprendizaje: ${stat(r.best.train)}<br>Validación: ${stat(r.best.test)}</p>`;
        html += better
          ? '<p>Mejora también en los datos que no había visto. Puedes aplicarla.</p>'
          : '<p>No mejora a los ajustes actuales en los datos que no había visto, así que no la recomiendo.</p>';
        if (r.best.test.total < 20) html += `<p>Con solo ${r.best.test.total} señales de validación el resultado todavía es poco fiable.</p>`;
        proposal = r.best.p; $('optApply').hidden = false; $('optApply').textContent = better ? 'Aplicar a la app y a los avisos' : 'Aplicar de todos modos';
      }
      $('optOut').innerHTML = html;
    } catch (e) { $('optOut').textContent = e.message; }
    finally { btn.disabled = false; }
  });
  $('optApply').addEventListener('click', async () => {
    if (!proposal) return;
    try {
      await pushServerParams(proposal, 'optimizador');
      $('optApply').hidden = true; $('optOut').insertAdjacentHTML('beforeend', '<p><b>Aplicado.</b> Los avisos de ntfy usarán estos ajustes desde el próximo cuarto de hora.</p>');
      lastAction = null; refresh();
    } catch (e) { showError(e.message); }
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  (async function init() {
    [...$('tf').children].forEach((x) => x.classList.toggle('on', +x.dataset.m === cfg.minutes));
    cfg.proxy = await Data.detectProxy();
    if (cfg.proxy) await loadServerParams();
    if (cfg.source === 'etoro' && !cfg.proxy && !(cfg.apiKey && cfg.userKey)) {
      showError('Para usar tu cuenta de eToro añade tus claves en Ajustes, o elige la fuente demo.');
      openSettings(); return schedule();
    }
    refresh(); schedule();
  })();
})();

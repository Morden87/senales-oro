(function () {
  const $ = (id) => document.getElementById(id);
  const TA = window.GoldTA, MV = window.GoldMove, Data = window.GoldData;
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
  let slow = { at: 0, c15: null, history: [], paper: null }; // datos que cambian despacio
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

  async function refreshSlow() {
    if (Date.now() - slow.at < SLOW_MS) return;
    slow.at = Date.now();
    try { slow.c15 = (await Data.load(cfg, 15)).candles.filter((k) => k.time + 900 <= Date.now() / 1000); } catch { slow.c15 = null; }
    if (cfg.proxy) {
      const [h, p] = await Promise.all([getJSON('api/history?days=4'), getJSON('api/paper')]);
      slow.history = (h && h.candles) || []; slow.paper = p;
    }
  }

  async function refresh() {
    if (busy) return; busy = true; $('refresh').disabled = true;
    try {
      await refreshSlow();
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
    $('etoroBox').style.display = cfg.source === 'etoro' ? '' : 'none';
    $('keysBox').style.display = cfg.proxy ? 'none' : '';
    $('proxyState').textContent = cfg.proxy ? 'Conectado a través de tu servidor: las claves están guardadas allí, no en el móvil.' : '';
  }
  function openSettings() { syncSettingsUI(); $('settings').showModal(); }
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
    if (sourceChanged) { slow = { at: 0, c15: null, history: [], paper: null }; fitted = false; }
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

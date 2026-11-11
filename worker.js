// Cloudflare Worker: sirve la app (carpeta public/), reenvía /etoro/* a la API de eToro
// añadiendo las claves (secretos del Worker, nunca llegan al navegador), guarda el histórico
// de velas de 1 min, muestra tus posiciones de eToro (solo lectura, con PIN) y, cada 15 minutos, calcula cuánto se espera que se mueva el oro, avisa por ntfy
// cuando se espera mucho movimiento y sigue en papel la ruptura de 1 h a favor de la tendencia diaria.
import './public/indicators.js'; // define globalThis.GoldTA
import './public/movement.js'; // define globalThis.GoldMove
import './public/pyramid.js'; // define globalThis.GoldPyr

const ETORO = 'https://public-api.etoro.com';
const GOLD_ID_FALLBACK = 18;
const HISTORY_DAYS_MAX = 30;

function etoro(env, path) {
  return fetch(ETORO + path, {
    headers: {
      'x-api-key': env.ETORO_API_KEY,
      'x-user-key': env.ETORO_USER_KEY,
      'x-request-id': crypto.randomUUID(),
      accept: 'application/json',
    },
  });
}

async function goldId(env) {
  const cached = await env.STATE.get('goldId');
  if (cached) return +cached;
  let id = GOLD_ID_FALLBACK;
  const r = await etoro(env, '/api/v1/market-data/search?internalSymbolFull=GOLD&fields=instrumentId,internalSymbolFull&pageSize=50');
  if (r.ok) {
    const hit = ((await r.json()).items || []).find((x) => String(x.internalSymbolFull).toUpperCase() === 'GOLD');
    if (hit) id = hit.instrumentId;
  }
  await env.STATE.put('goldId', String(id), { expirationTtl: 7 * 86400 });
  return id;
}

const INTERVAL_MIN = { OneMinute: 1, FifteenMinutes: 15, OneHour: 60, OneDay: 1440 };
async function fetchCandles(env, count = 1000, interval = 'OneMinute') {
  const id = await goldId(env);
  const r = await etoro(env, `/api/v1/market-data/instruments/${id}/history/candles/asc/${interval}/${count}`);
  if (!r.ok) throw new Error('eToro respondió ' + r.status);
  const j = await r.json();
  return ((j.candles && j.candles[0] && j.candles[0].candles) || [])
    .map((k) => ({ time: Math.floor(Date.parse(k.fromDate) / 1000), open: +k.open, high: +k.high, low: +k.low, close: +k.close }))
    .filter((k) => isFinite(k.close)).sort((a, b) => a.time - b.time);
}
const closedOnly = (candles, interval, now = Date.now() / 1000) => candles.filter((k) => k.time + INTERVAL_MIN[interval] * 60 <= now);

// Histórico: una clave por día UTC, con velas compactas [t, o, h, l, c]. Solo se guardan velas cerradas.
const dayKey = (t) => 'c1:' + new Date(t * 1000).toISOString().slice(0, 10);
async function storeHistory(env, candles) {
  const now = Date.now() / 1000;
  const closed = candles.filter((k) => k.time + 60 <= now);
  const byDay = new Map();
  for (const k of closed) {
    const key = dayKey(k.time);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push([k.time, k.open, k.high, k.low, k.close]);
  }
  // Para ahorrar CPU (plan gratuito: 10 ms por ejecución) no se parsea el día entero: las filas están
  // ordenadas, así que basta con leer la hora de la última y añadir detrás las posteriores como texto.
  for (const [key, rows] of byDay) {
    const old = (await env.STATE.get(key)) || '[]';
    const tail = old.length > 2 ? old.slice(old.lastIndexOf('['), -1) : '';
    const last = tail ? +JSON.parse(tail)[0] : -Infinity;
    const add = rows.filter((r) => r[0] > last);
    if (!add.length) continue;
    const addText = JSON.stringify(add).slice(1, -1);
    const merged = old.length > 2 ? old.slice(0, -1) + ',' + addText + ']' : '[' + addText + ']';
    await env.STATE.put(key, merged, { expirationTtl: (HISTORY_DAYS_MAX + 2) * 86400 });
  }
}

async function readHistory(env, days) {
  const keys = [];
  for (let d = days - 1; d >= 0; d--) keys.push(dayKey(Date.now() / 1000 - d * 86400));
  // Se unen los textos sin parsear para no gastar CPU (el plan gratuito da 10 ms por petición).
  const parts = await Promise.all(keys.map((k) => env.STATE.get(k)));
  return '[' + parts.filter((p) => p && p.length > 2).map((p) => p.slice(1, -1)).join(',') + ']';
}

async function getParams(env) {
  const stored = JSON.parse((await env.STATE.get('params')) || 'null');
  return {
    ...globalThis.GoldTA.DEFAULTS,
    threshold: +(env.THRESHOLD || 0.22), minMove: +(env.MIN_MOVE || 5),
    ...(stored || {}), horizon: 15,
  };
}

function cleanParams(p) {
  const out = {};
  if (Object.keys(globalThis.GoldTA.MODES).includes(p.mode)) out.mode = p.mode;
  for (const [k, lo, hi] of [['threshold', 0.05, 0.9], ['agree', 0.3, 1], ['minMove', 0, 100]]) {
    const v = +p[k]; if (isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v));
  }
  if (typeof p.htf === 'boolean') out.htf = p.htf;
  if (p.note) out.note = String(p.note).slice(0, 300);
  out.updatedAt = new Date().toISOString();
  return out;
}

const fmt = (x, d = 2) => (x == null || !isFinite(x) ? '—' : x.toFixed(d));
const pct = (x) => Math.round(x * 100) + '%';

// Acepta el tema solo ("mi-tema") o la dirección completa ("https://ntfy.sh/mi-tema"), con espacios o barras de sobra.
function ntfyTarget(env) {
  let topic = String(env.NTFY_TOPIC || '').trim().replace(/^["']|["']$/g, '');
  let server = String(env.NTFY_SERVER || 'https://ntfy.sh').trim().replace(/\/+$/, '');
  if (!topic) return null;
  if (topic.includes('/')) {
    const full = /^https?:\/\//i.test(topic) ? topic : 'https://' + topic.replace(/^\/+/, '');
    try { const u = new URL(full); server = u.origin; topic = u.pathname.split('/').filter(Boolean).pop() || ''; } catch { /* se queda como está */ }
  }
  return topic ? { server, topic } : null;
}

async function ntfy(env, { title, message, tags, priority }) {
  const target = ntfyTarget(env);
  if (!target) throw new Error('Falta el secreto NTFY_TOPIC en Cloudflare');
  const headers = { 'content-type': 'application/json' };
  if (env.NTFY_TOKEN) headers.authorization = 'Bearer ' + String(env.NTFY_TOKEN).trim();
  let error = null;
  try {
    const r = await fetch(target.server, {
      method: 'POST', headers,
      body: JSON.stringify({ topic: target.topic, title, message, tags, priority, click: env.APP_URL || undefined }),
    });
    if (!r.ok) error = 'ntfy respondió ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 200);
  } catch (e) { error = 'No se pudo contactar con ntfy: ' + e.message; }
  // Último envío, para verlo en GET /api/status.
  await env.STATE.put('ntfyLast', JSON.stringify({ t: new Date().toISOString(), title, ok: !error, error })).catch(() => {});
  if (error) throw new Error(error);
}

const refs = (env) => ({ m15: +(env.REF_15M || 5), h1: +(env.REF_1H || 10), h4: +(env.REF_4H || 20) });

// Avisa al pasar a movimiento ALTO en la próxima hora, y otra vez cuando se calma.
async function movementAlert(env, c1, c15) {
  const f = globalThis.GoldMove.forecast({ 1: c1, 15: c15 }, refs(env));
  const h1 = f.find((x) => x.id === 'h1'); if (!h1) return 'sin previsión';
  const prev = (await env.STATE.get('moveLevel')) || 'BAJO';
  const now = h1.level;
  // Sin cambio entre ALTO y no ALTO no hay aviso; si lo hay, el nivel se guarda tras enviarlo, así un fallo de ntfy se reintenta.
  if ((now === 'ALTO') === (prev === 'ALTO') || !ntfyTarget(env)) {
    if (now !== prev) await env.STATE.put('moveLevel', now);
    return `${prev} -> ${now}`;
  }
  const lines = f.map((x) => `${x.label}: rango ~${fmt(x.range, 0)} $ · ${pct(x.prob)} de alejarse ≥${x.ref} $`).join('\n');
  // La dirección la da la recomendación de la app (velas de 15 min y tendencia de 1 h), solo como contexto.
  let rec = '';
  try { const r = globalThis.GoldTA.stableSignal(c15, await getParams(env)); rec = `\nRecomendación ahora: ${r.action} (${r.reason}).`; } catch { /* sin recomendación */ }
  await ntfy(env, now === 'ALTO'
    ? { title: 'Cortés: se espera mucho movimiento en el oro', message: `Precio ${fmt(h1.price)} $.\n${lines}\nEste aviso indica tamaño, no dirección: puede ser hacia arriba o hacia abajo.${rec}`, tags: ['zap'], priority: 4 }
    : { title: 'Cortés: el oro se calma', message: `Precio ${fmt(h1.price)} $.\n${lines}`, tags: ['zzz'], priority: 2 });
  await env.STATE.put('moveLevel', now);
  return `${prev} -> ${now} (aviso enviado)`;
}

// Avisa cuando la recomendación (velas de 15 min + tendencia de 1 h) pasa a COMPRAR o VENDER, y cuando vuelve a ESPERAR.
async function directionAlert(env, c15, pyr = null, signal = null) {
  const r = signal || globalThis.GoldTA.stableSignal(c15, await getParams(env));
  const prev = (await env.STATE.get('recAction')) || 'ESPERAR';
  // Registro de recomendaciones (cada cambio), para comparar luego con tus operaciones reales.
  const log = JSON.parse((await env.STATE.get('recLog')) || 'null');
  if (!log || r.action !== prev) {
    const next = log || { start: Math.floor(Date.now() / 1000), items: [] };
    next.items.push({ t: Math.floor(Date.now() / 1000), a: r.action, p: r.price, s: r.stage || null });
    next.items = next.items.slice(-3000);
    await env.STATE.put('recLog', JSON.stringify(next));
  }
  if (r.action === prev) return 'dirección ' + r.action;
  // Con una pirámide abierta los cambios de COMPRAR/VENDER/ESPERAR no se avisan: de eso se encarga pyramidAlert.
  if (pyr || !ntfyTarget(env)) { await env.STATE.put('recAction', r.action); return `${prev} -> ${r.action}`; }
  const px = fmt(r.price);
  // Al entrar: ATR de 1 h de ahora y dónde caerían los escalones si abres la pirámide a este precio.
  let plan = '';
  if (r.action !== 'ESPERAR') {
    try {
      const o = pyrOpts(env), atr = await atr1h(env), step = o.stepAtr ? atr * o.stepAtr : o.step;
      const sgn = (r.action === 'COMPRAR' ? 1 : -1) * (o.mode === 'favor' ? 1 : -1);
      const lv = Array.from({ length: o.maxSteps }, (_, k) => r.price + sgn * step * k);
      const stop = o.mode === 'favor' ? lv[0] - sgn * step : r.price + sgn * step * o.maxSteps;
      plan = `\nATR de 1 h hoy: ${fmt(atr)} $ → escalones cada ${fmt(step)} $${o.stepAtr ? ` (${o.stepAtr} ATR)` : ''}: ${lv.map((x, k) => `${k + 1}) ${fmt(x)}`).join(' · ')} · stop ${fmt(stop)} $.`;
    } catch { /* sin ATR */ }
  }
  await ntfy(env, r.action === 'ESPERAR'
    ? { title: `Cortés: fin de ${prev} en el oro`, message: `Precio ${px} $. Ahora ESPERAR: ${r.reason}.`, tags: ['pause_button'], priority: 3 }
    : { title: `Cortés: ${r.action} oro`, message: `Precio ${px} $. ${r.reason}.${plan}\nRecomendación informativa, sin ventaja probada en el histórico. No es asesoramiento financiero.`, tags: [r.action === 'COMPRAR' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'], priority: 4 });
  await env.STATE.put('recAction', r.action); // tras enviar: si ntfy falla, se reintenta en la próxima comprobación
  return `${prev} -> ${r.action} (aviso enviado)`;
}

// ---------- Pirámide de posiciones (lee tu cartera de eToro, solo lectura) ----------
// PYR_STEP en dólares ("20") o en ATR de 1 h ("1ATR"): con ATR la separación se fija al abrir la pirámide y no cambia hasta cerrarla.
const stepAtrOf = (env) => { const m = /^\s*([\d.]+)\s*atr\s*$/i.exec(String(env.PYR_STEP || '')); return m ? +m[1] : 0; };
const pyrOpts = (env) => ({
  mode: String(env.PYR_MODE || 'contra').toLowerCase() === 'favor' ? 'favor' : 'contra',
  step: stepAtrOf(env) ? 20 : +(env.PYR_STEP || 20), stepAtr: stepAtrOf(env),
  maxSteps: +(env.PYR_MAX_STEPS || 5), maxLoss: +(env.PYR_MAX_LOSS || 0), tpPct: +(env.PYR_TP_PCT ?? 5),
});

// ATR(14) de las velas de 1 h ya cerradas.
async function atr1h(env) {
  const h = closedOnly(await fetchCandles(env, 60, 'OneHour'), 'OneHour');
  const a = globalThis.GoldTA.atr(h.map((k) => k.high), h.map((k) => k.low), h.map((k) => k.close), 14);
  const v = a[a.length - 1];
  if (!isFinite(v) || v <= 0) throw new Error('sin ATR de 1 h');
  return v;
}

// Opciones con la separación ya resuelta: la guardada al abrir la pirámide o, si no hay, el ATR de 1 h de ahora.
async function pyrOptsResolved(env, memo) {
  const o = pyrOpts(env);
  if (!o.stepAtr) return o;
  if (memo && memo.step > 0) return { ...o, step: memo.step, atr: memo.atr };
  const atr = await atr1h(env);
  return { ...o, step: +(atr * o.stepAtr).toFixed(2), atr };
}

// Tus posiciones abiertas de oro (propias, no copiadas).
async function goldPositions(env) {
  const demo = String(env.ETORO_ACCOUNT || 'real').toLowerCase() === 'demo';
  const [r, id] = await Promise.all([etoro(env, `/api/v1/trading/info/${demo ? 'demo' : 'real'}/pnl`), goldId(env)]);
  if (!r.ok) throw new Error('eToro respondió ' + r.status + ' al leer la cartera');
  const cp = (await r.json()).clientPortfolio || {};
  return (cp.positions || []).map(openPosition).filter((p) => +p.instrumentId === +id && !p.copied);
}

// Detecta la pirámide y avisa de escalones, stop, vuelta a precio medio y tendencia en contra.
// Devuelve el estado de la pirámide (o null si no hay), para silenciar los avisos normales mientras esté abierta.
async function pyramidAlert(env, c1, action) {
  // Precio actual y mínimo/máximo desde la comprobación anterior (como mucho, las últimas 20 velas de 1 min).
  const lastT = +((await env.STATE.get('pyrT')) || 0);
  const recent = c1.slice(-20).filter((k) => k.time >= lastT - 60);
  const price = c1[c1.length - 1].close;
  const range = recent.length ? { lo: Math.min(...recent.map((k) => k.low)), hi: Math.max(...recent.map((k) => k.high)) } : null;
  if (!env.ETORO_API_KEY || !env.ETORO_USER_KEY) return { cur: null, text: 'pirámide: sin claves' };
  const positions = await goldPositions(env);
  const prev = JSON.parse((await env.STATE.get('pyr')) || 'null');
  // La separación guardada solo vale para la misma pirámide (mismo lado); una nueva toma el ATR de ahora.
  const keep = prev && positions.some((p) => p.isBuy === prev.isBuy);
  const o = positions.length ? await pyrOptsResolved(env, keep ? prev : null) : pyrOpts(env);
  const cur = globalThis.GoldPyr.state(positions, price, o);
  const { alerts, memo } = globalThis.GoldPyr.decide(prev, cur, price, action, o, range);
  if (alerts.length && ntfyTarget(env)) {
    for (const a of alerts) await ntfy(env, a); // si ntfy falla, no se guarda y se reintenta en la próxima comprobación
  }
  if (memo) await env.STATE.put('pyr', JSON.stringify(memo)); else if (prev) await env.STATE.delete('pyr');
  await env.STATE.put('pyrT', String(c1[c1.length - 1].time));
  const text = cur ? `pirámide: ${cur.side} ${cur.steps} esc., medio ${fmt(cur.avg)}` : 'pirámide: no';
  return { cur, text: text + (alerts.length ? ` (${alerts.length} aviso${alerts.length > 1 ? 's' : ''})` : '') };
}

// Comprobación ligera entre las de 15 min: solo la pirámide, con el último precio y la última recomendación guardada.
async function pyramidOnly(env) {
  if (!env.ETORO_API_KEY || !env.ETORO_USER_KEY) return 'pirámide: sin claves';
  const c1 = closedOnly(await fetchCandles(env, 8), 'OneMinute');
  if (!c1.length || Date.now() / 1000 - c1[c1.length - 1].time > 20 * 60) return 'mercado cerrado';
  const action = (await env.STATE.get('recAction')) || 'ESPERAR';
  return (await pyramidAlert(env, c1, action)).text;
}

// Ruptura de 1 h en papel: abre al cierre de la vela de 1 h y cierra 4 h después con el precio de ese momento.
const SPREAD = 0.5;
async function paperBreakout(env, c1) {
  const paper = JSON.parse((await env.STATE.get('paper')) || '{"open":[],"closed":[]}');
  const now = Date.now() / 1000, price = c1.length ? c1[c1.length - 1].close : NaN;
  let changed = false;
  for (const t of paper.open.filter((x) => now >= x.time + 3600 + 4 * 3600 && isFinite(price))) {
    const dir = t.side === 'LARGO' ? 1 : -1;
    paper.closed.push({ ...t, exitTime: Math.floor(now), exit: price, pnl: +(dir * (price - t.entry) - SPREAD).toFixed(2) });
    paper.open = paper.open.filter((x) => x !== t); changed = true;
  }
  let opened = null;
  if (new Date().getUTCMinutes() < 15 && !paper.open.length) { // primera ejecución tras el cierre de cada hora
    const [h, d] = await Promise.all([fetchCandles(env, 30, 'OneHour'), fetchCandles(env, 40, 'OneDay')]);
    const sig = globalThis.GoldMove.breakout1h(closedOnly(h, 'OneHour'), closedOnly(d, 'OneDay'));
    if (sig && !paper.closed.some((x) => x.time === sig.time)) {
      opened = { side: sig.side, time: sig.time, entry: sig.price, level: sig.level };
      paper.open.push(opened); changed = true;
    }
  }
  paper.closed = paper.closed.slice(-300);
  if (changed) await env.STATE.put('paper', JSON.stringify(paper));
  return opened ? `papel: abre ${opened.side} a ${opened.entry}` : 'papel: sin cambios';
}

// Cada 15 min: guarda velas, avisa de movimiento y actualiza la prueba en papel.
async function checkAndNotify(env) {
  const [raw1, raw15] = await Promise.all([fetchCandles(env, 1000), fetchCandles(env, 300, 'FifteenMinutes')]);
  await storeHistory(env, raw1);
  const c1 = closedOnly(raw1, 'OneMinute'), c15 = closedOnly(raw15, 'FifteenMinutes');
  if (!c1.length || Date.now() / 1000 - c1[c1.length - 1].time > 20 * 60) return 'mercado cerrado';
  // Cada parte por separado: un fallo en una (p. ej. ntfy) no impide las demás.
  const a = await movementAlert(env, c1, c15).catch((e) => 'movimiento: ERROR ' + e.message);
  // La pirámide va antes que la dirección: si está abierta, los cambios de COMPRAR/VENDER/ESPERAR no se avisan.
  // Si no se puede leer la cartera, se sigue con los avisos normales.
  let sig = null;
  try { sig = globalThis.GoldTA.stableSignal(c15, await getParams(env)); } catch { /* sin recomendación */ }
  const p = await pyramidAlert(env, c1, sig ? sig.action : 'ESPERAR').catch((e) => ({ cur: null, text: 'pirámide: ERROR ' + e.message }));
  const d = await directionAlert(env, c15, p.cur, sig).catch((e) => 'dirección: ERROR ' + e.message);
  const b = await paperBreakout(env, c1).catch((e) => 'papel: ERROR ' + e.message);
  return a + ' · ' + p.text + ' · ' + d + ' · ' + b;
}

// El cron va cada 5 min: la comprobación completa en la primera de cada cuarto de hora, y en las otras solo la pirámide.
async function runCron(env, time = Date.now()) {
  let result, ok = true;
  const full = new Date(time).getUTCMinutes() % 15 < 5;
  try { result = full ? await checkAndNotify(env) : await pyramidOnly(env); } catch (e) { ok = false; result = 'ERROR ' + e.message; }
  if (result.includes('ERROR')) ok = false;
  await env.STATE.put('cronLast', JSON.stringify({ t: new Date().toISOString(), ok, result })).catch(() => {});
  (ok ? console.log : console.error)('cron:', result);
  return { ok, result };
}

async function status(env) {
  const target = ntfyTarget(env);
  const [cron, last] = await Promise.all([env.STATE.get('cronLast'), env.STATE.get('ntfyLast')]);
  const mask = (t) => (t.length <= 4 ? '****' : t.slice(0, 2) + '…' + t.slice(-2) + ` (${t.length} caracteres)`);
  return {
    ntfy: target ? { server: target.server, topic: mask(target.topic), token: !!env.NTFY_TOKEN } : null,
    etoroKeys: Boolean(env.ETORO_API_KEY && env.ETORO_USER_KEY),
    cronLast: JSON.parse(cron || 'null'), ntfyLast: JSON.parse(last || 'null'),
    moveLevel: await env.STATE.get('moveLevel'), recAction: await env.STATE.get('recAction'),
    pyramid: { ...pyrOpts(env), last: JSON.parse((await env.STATE.get('pyr')) || 'null') },
  };
}

// ---------- Cartera de eToro (solo lectura) ----------
// Usa las mismas claves. Con ETORO_ACCOUNT = "demo" lee la cuenta demo; por defecto, la real.
const pick = (o, ...ks) => { for (const k of ks) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
const num = (x) => (x === undefined || x === null || x === '' || !isFinite(+x) ? null : +x);

async function instrumentNames(env, ids) {
  const names = {}, missing = [];
  await Promise.all(ids.map(async (id) => { const n = await env.STATE.get('inst:' + id); if (n) names[id] = JSON.parse(n); else missing.push(id); }));
  for (let i = 0; i < missing.length; i += 50) {
    const r = await etoro(env, '/api/v1/market-data/instruments?instrumentIds=' + missing.slice(i, i + 50).join(','));
    if (!r.ok) continue;
    for (const d of (await r.json()).instrumentDisplayDatas || []) {
      const id = pick(d, 'instrumentID', 'instrumentId');
      const v = { name: pick(d, 'instrumentDisplayName', 'displayName') || String(id), symbol: pick(d, 'symbolFull', 'symbol') || '' };
      names[id] = v;
      await env.STATE.put('inst:' + id, JSON.stringify(v), { expirationTtl: 30 * 86400 });
    }
  }
  return names;
}

function openPosition(p) {
  const u = p.unrealizedPnL && typeof p.unrealizedPnL === 'object' ? p.unrealizedPnL : {};
  return {
    id: pick(p, 'positionID', 'positionId'), instrumentId: pick(p, 'instrumentID', 'instrumentId'),
    isBuy: !!p.isBuy, leverage: num(p.leverage) || 1, openRate: num(p.openRate), units: num(p.units),
    amount: num(pick(p, 'amount', 'initialAmountInDollars')), openTime: pick(p, 'openDateTime', 'openTimestamp') || null,
    stopLoss: p.isNoStopLoss ? null : num(p.stopLossRate), takeProfit: p.isNoTakeProfit ? null : num(p.takeProfitRate),
    rate: num(pick(u, 'closeRate') ?? p.closeRate), pnl: num(pick(u, 'pnL', 'pnl') ?? p.pnL ?? (typeof p.unrealizedPnL === 'number' ? p.unrealizedPnL : undefined)),
    copied: !!num(pick(p, 'mirrorID', 'mirrorId')),
  };
}

function closedPosition(t) {
  return {
    id: pick(t, 'positionId', 'positionID'), instrumentId: pick(t, 'instrumentId', 'instrumentID'),
    isBuy: !!t.isBuy, leverage: num(t.leverage) || 1, openRate: num(t.openRate), closeRate: num(t.closeRate), units: num(t.units),
    amount: num(pick(t, 'investment', 'initialInvestment')), openTime: t.openTimestamp || null, closeTime: t.closeTimestamp || null,
    pnl: num(t.netProfit), fees: num(t.fees), copied: !!num(t.parentPositionId),
  };
}

async function portfolio(env, days) {
  const demo = String(env.ETORO_ACCOUNT || 'real').toLowerCase() === 'demo';
  const minDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const histPath = (demo ? '/api/v1/trading/info/demo/trade/history' : '/api/v1/trading/info/trade/history') + `?minDate=${minDate}&pageSize=500`;
  const [rp, rh] = await Promise.all([etoro(env, `/api/v1/trading/info/${demo ? 'demo' : 'real'}/pnl`), etoro(env, histPath)]);
  if (!rp.ok) {
    const hint = rp.status === 401 || rp.status === 403 ? ' Revisa que la clave de eToro sea de la cuenta ' + (demo ? 'demo' : 'real') + ' y tenga permiso de lectura.' : '';
    throw Object.assign(new Error('eToro respondió ' + rp.status + ' al leer la cartera.' + hint), { status: 502 });
  }
  const cp = (await rp.json()).clientPortfolio || {};
  const raw = (cp.positions || []).concat(...(cp.mirrors || []).map((m) => m.positions || []));
  const open = raw.map(openPosition);
  let closed = [], historyError = null;
  if (rh.ok) {
    const h = await rh.json();
    closed = (Array.isArray(h) ? h : h.items || h.trades || []).map(closedPosition)
      .sort((a, b) => Date.parse(b.closeTime || 0) - Date.parse(a.closeTime || 0)).slice(0, 200);
  } else historyError = 'eToro respondió ' + rh.status + ' al leer el historial';
  const names = await instrumentNames(env, [...new Set(open.concat(closed).map((x) => x.instrumentId).filter((x) => x != null))]);
  for (const x of open.concat(closed)) Object.assign(x, names[x.instrumentId] || { name: 'Instrumento ' + x.instrumentId, symbol: '' });
  const sum = (a, k) => a.reduce((s, x) => s + (x[k] || 0), 0);
  return {
    account: demo ? 'demo' : 'real', days, statsFrom: env.STATS_FROM || null, updatedAt: new Date().toISOString(), historyError,
    credit: num(cp.credit), unrealizedPnL: num(typeof cp.unrealizedPnL === 'number' ? cp.unrealizedPnL : pick(cp.unrealizedPnL || {}, 'pnL')) ?? sum(open, 'pnl'),
    invested: sum(open, 'amount'), closedPnL: sum(closed, 'pnl'), open, closed,
    pyramid: await pyrOptsResolved(env, JSON.parse((await env.STATE.get('pyr')) || 'null')).catch(() => pyrOpts(env)),
  };
}

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Ajustes compartidos entre la app y los avisos. Cambiarlos exige el PIN (secreto ADMIN_PIN).
    if (url.pathname.endsWith('/api/params')) {
      if (request.method === 'GET') return json(await getParams(env));
      if (request.method === 'POST') {
        if (!env.ADMIN_PIN) return json({ error: 'Falta el secreto ADMIN_PIN en Cloudflare' }, 501);
        if (request.headers.get('x-admin-pin') !== env.ADMIN_PIN) return json({ error: 'PIN incorrecto' }, 403);
        const p = cleanParams(await request.json().catch(() => ({})));
        await env.STATE.put('params', JSON.stringify(p));
        return json(await getParams(env));
      }
      return json({ error: 'No permitido' }, 405);
    }
    // Posiciones de tu cuenta de eToro: son privadas, así que piden el mismo PIN que los ajustes.
    if (url.pathname.endsWith('/api/portfolio')) {
      if (request.method !== 'GET') return json({ error: 'No permitido' }, 405);
      if (!env.ADMIN_PIN) return json({ error: 'Falta el secreto ADMIN_PIN en Cloudflare' }, 501);
      if (request.headers.get('x-admin-pin') !== env.ADMIN_PIN) return json({ error: 'PIN incorrecto' }, 403);
      if (!env.ETORO_API_KEY || !env.ETORO_USER_KEY) return json({ error: 'Faltan las claves de eToro en Cloudflare' }, 501);
      // Por defecto, desde STATS_FROM (creación de Cortés) o 30 días.
      const since = Date.parse(env.STATS_FROM || '');
      const auto = isFinite(since) ? Math.ceil((Date.now() - since) / 86400000) : 30;
      const days = Math.min(364, Math.max(1, +url.searchParams.get('days') || auto));
      try { return json(await portfolio(env, days)); } catch (e) { return json({ error: e.message }, e.status || 500); }
    }
    // Estado de los avisos: última comprobación programada y último envío a ntfy.
    if (url.pathname.endsWith('/api/status')) return json(await status(env));
    // Aviso de prueba (con PIN). Con ?run=1 además hace ahora mismo la comprobación de cada 15 min.
    if (url.pathname.endsWith('/api/ntfy-test')) {
      if (request.method !== 'POST') return json({ error: 'No permitido' }, 405);
      if (!env.ADMIN_PIN) return json({ error: 'Falta el secreto ADMIN_PIN en Cloudflare' }, 501);
      if (request.headers.get('x-admin-pin') !== env.ADMIN_PIN) return json({ error: 'PIN incorrecto' }, 403);
      try {
        await ntfy(env, { title: 'Cortés: aviso de prueba', message: 'Si ves esto, los avisos de ntfy funcionan.', tags: ['white_check_mark'], priority: 3 });
      } catch (e) { return json({ ok: false, error: e.message, status: await status(env) }, 502); }
      const run = url.searchParams.get('run') ? await runCron(env, 0) : null; // 0: siempre la comprobación completa
      return json({ ok: true, run, status: await status(env) });
    }
    if (url.pathname.endsWith('/api/recs')) {
      return new Response((await env.STATE.get('recLog')) || 'null', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    if (url.pathname.endsWith('/api/paper')) {
      return new Response((await env.STATE.get('paper')) || '{"open":[],"closed":[]}', {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    if (url.pathname.endsWith('/api/history')) {
      const days = Math.min(HISTORY_DAYS_MAX, Math.max(1, +url.searchParams.get('days') || 14));
      return new Response(`{"days":${days},"candles":${await readHistory(env, days)}}`, {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }

    const i = url.pathname.indexOf('/etoro/');
    if (i === -1) return env.ASSETS.fetch(request);

    const path = url.pathname.slice(i + '/etoro'.length);
    if (path === '/__ping') return json({ ok: Boolean(env.ETORO_API_KEY && env.ETORO_USER_KEY) });

    // Solo lectura de datos de mercado: el proxy no da acceso a la cartera ni a operar.
    if (request.method !== 'GET' || !path.startsWith('/api/v1/market-data/')) {
      return new Response('No permitido', { status: 403 });
    }
    const upstream = await etoro(env, path + url.search);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, event.scheduledTime));
  },
};

export { checkAndNotify, directionAlert, runCron, ntfyTarget, status, pyramidAlert };

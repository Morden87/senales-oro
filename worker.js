// Cloudflare Worker: sirve la app (carpeta public/), reenvía /etoro/* a la API de eToro
// añadiendo las claves (secretos del Worker, nunca llegan al navegador), guarda el histórico
// de velas de 1 min, muestra tus posiciones de eToro (solo lectura, con PIN) y, al cierre de cada vela de 1 h, calcula el
// sistema en dos pasos (¿viene movimiento? → ¿ha empezado? → ¿hacia dónde?), lo sigue en papel y avisa por ntfy.
import './public/sistema.js'; // define globalThis.GoldSys
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

// ---------- Pirámide de posiciones (lee tu cartera de eToro, solo lectura) ----------
const pyrOpts = (env) => ({
  mode: String(env.PYR_MODE || 'contra').toLowerCase() === 'favor' ? 'favor' : 'contra',
  step: +(env.PYR_STEP || 20), maxSteps: +(env.PYR_MAX_STEPS || 5), maxLoss: +(env.PYR_MAX_LOSS || 0), tpPct: +(env.PYR_TP_PCT ?? 5),
});

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
  const o = pyrOpts(env);
  const cur = globalThis.GoldPyr.state(await goldPositions(env), price, o);
  const prev = JSON.parse((await env.STATE.get('pyr')) || 'null');
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
  const action = actionOf(JSON.parse((await env.STATE.get('sysPaper')) || 'null'));
  return (await pyramidAlert(env, c1, action)).text;
}

// ---------- Sistema en dos pasos (velas de 1 h) ----------
const extraFed = (env) => String(env.FED_DATES || '').split(/[\s,;]+/).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
const madrid = (t, o = { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) =>
  new Date(t * 1000).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', ...o });
const hm = (t) => madrid(t, { hour: '2-digit', minute: '2-digit' });
const actionOf = (paper) => (paper && paper.open && paper.open.length ? (paper.open[0].side === 'COMPRA' ? 'COMPRAR' : 'VENDER') : 'ESPERAR');

// Registro de cambios de la señal (para comparar luego con tus operaciones reales).
async function logAction(env, action, price) {
  const prev = (await env.STATE.get('recAction')) || 'ESPERAR';
  const log = JSON.parse((await env.STATE.get('recLog')) || 'null');
  if (!log || action !== prev) {
    const next = log || { start: Math.floor(Date.now() / 1000), items: [] };
    next.items.push({ t: Math.floor(Date.now() / 1000), a: action, p: price, s: 'dos pasos' });
    next.items = next.items.slice(-3000);
    await env.STATE.put('recLog', JSON.stringify(next));
  }
  if (action !== prev) await env.STATE.put('recAction', action);
}

// Al cierre de cada vela de 1 h: calcula los tres pasos, actualiza la prueba en papel y avisa.
// pyr: estado de tu pirámide (si hay), para no mezclar los avisos de COMPRA/VENTA con los de la pirámide.
async function systemCheck(env, pyr = null, force = false) {
  const h = closedOnly(await fetchCandles(env, 1000, 'OneHour'), 'OneHour');
  if (!h.length) return 'sistema: sin velas';
  const lastT = h[h.length - 1].time;
  const done = +((await env.STATE.get('sysT')) || 0);
  if (!force && done === lastT) return 'sistema: sin vela nueva';
  const e = globalThis.GoldSys.evaluate(h, { tail: 8, extraFed: extraFed(env) });
  if (!e) return 'sistema: pocas velas';
  const prevPaper = JSON.parse((await env.STATE.get('sysPaper')) || 'null');
  const { state, events } = globalThis.GoldSys.paper(prevPaper, h, e.series);
  const { series, ...snap } = e;
  const out = [`${e.levelText} (${Math.round(e.prob * 100)} %)`];
  const can = !!ntfyTarget(env);
  const f = (x) => fmt(x, 2);
  // 1) Aviso de movimiento probable (al entrar en ese nivel, como mucho 2 al día)
  const prevLevel = (await env.STATE.get('sysLevel')) || 'BAJO';
  if (e.level === 'ALTO' && prevLevel !== 'ALTO' && can) {
    const day = new Date().toISOString().slice(0, 10), cnt = JSON.parse((await env.STATE.get('sysAlertDay')) || '{}');
    if ((cnt.day === day ? cnt.n : 0) < 2) {
      await ntfy(env, { title: 'Cortés: atento, movimiento probable en el oro', priority: 4, tags: ['zap'],
        message: `Precio ${f(e.price)} $. Probabilidad de moverse más de un 0,8 % en 6 h: ${Math.round(e.prob * 100)} %.
Por: ${e.reasons.join(', ') || 'varias medidas'}.
Ahora toca esperar a que empiece: cierre de 1 h por encima de ${f(e.hh)} o por debajo de ${f(e.ll)}, o una vela de más de ${f(e.bigBar)} $. Tendencia diaria ${e.trend}.` });
      await env.STATE.put('sysAlertDay', JSON.stringify({ day, n: (cnt.day === day ? cnt.n : 0) + 1 }));
      out.push('aviso de movimiento');
    }
  }
  await env.STATE.put('sysLevel', e.level);
  // 2) Señales y cierres de la prueba en papel
  for (const ev of events) {
    const t = ev.trade;
    if (ev.type === 'open') {
      out.push('señal ' + t.side);
      if (can && !pyr) await ntfy(env, { title: `Cortés: ${t.side} oro`, priority: 4, tags: [t.side === 'COMPRA' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'],
        message: `Precio ${f(t.signalPrice)} $. Movimiento probable + ${t.side === 'COMPRA' ? 'ruptura al alza' : 'ruptura a la baja'} a favor de la tendencia diaria.
Cerrar hacia las ${hm(t.time + 3600 * (1 + globalThis.GoldSys.HOLD_H))} (6 h). Stop orientativo ${f(t.stop)} $ (2 ATR).
Se sigue en papel: ventaja pequeña y sin demostrar. No es asesoramiento financiero.` });
    } else {
      out.push(`cierre ${t.pnl >= 0 ? '+' : ''}${t.pnl} $`);
      if (can && !pyr) await ntfy(env, { title: `Cortés: cierra la ${t.side.toLowerCase()} de oro`, priority: 3, tags: ['checkered_flag'],
        message: `Han pasado 6 h. Entrada ${f(t.entry)} $, salida ${f(t.exit)} $: ${t.pnl >= 0 ? '+' : ''}${f(t.pnl)} $ por onza en papel (con 0,5 $ de diferencial).` });
    }
  }
  // 3) Víspera de noticia (una vez por noticia, cuando falta menos de 24 h)
  const nx = e.nextEvent;
  if (nx && nx.t - Date.now() / 1000 < 86400 && nx.t > Date.now() / 1000 && can) {
    if (+((await env.STATE.get('newsWarned')) || 0) !== nx.t) {
      await ntfy(env, { title: `Cortés: ${nx.name} ${madrid(nx.t, { weekday: 'long' })} a las ${hm(nx.t + 1800)}`, priority: 3, tags: ['calendar'],
        message: `Suele mover mucho el oro (la vela de la noticia es 2-4 veces la normal). Hacia dónde, no se sabe de antemano: espera a la señal o no operes justo antes.` });
      await env.STATE.put('newsWarned', String(nx.t)); out.push('aviso de noticia');
    }
  }
  await env.STATE.put('sysPaper', JSON.stringify(state));
  await env.STATE.put('sys', JSON.stringify({ ...snap, updatedAt: new Date().toISOString() }));
  await env.STATE.put('sysT', String(lastT));
  await logAction(env, actionOf(state), e.price);
  return 'sistema: ' + out.join(', ');
}

// Cada 15 min: guarda velas, revisa la pirámide y, en la primera media hora tras el cierre de cada vela de 1 h, el sistema.
async function checkAndNotify(env, force = false) {
  const raw1 = await fetchCandles(env, 1000);
  await storeHistory(env, raw1);
  const c1 = closedOnly(raw1, 'OneMinute');
  if (!c1.length || Date.now() / 1000 - c1[c1.length - 1].time > 20 * 60) return 'mercado cerrado';
  // Cada parte por separado: un fallo en una (p. ej. ntfy) no impide las demás.
  const action = actionOf(JSON.parse((await env.STATE.get('sysPaper')) || 'null'));
  const p = await pyramidAlert(env, c1, action).catch((e) => ({ cur: null, text: 'pirámide: ERROR ' + e.message }));
  const s = force || new Date().getUTCMinutes() < 35 ? await systemCheck(env, p.cur, force).catch((e) => 'sistema: ERROR ' + e.message) : 'sistema: espera a la próxima hora';
  return p.text + ' · ' + s;
}

// El cron va cada 5 min: la comprobación completa en la primera de cada cuarto de hora, y en las otras solo la pirámide.
async function runCron(env, time = Date.now()) {
  let result, ok = true;
  const full = new Date(time).getUTCMinutes() % 15 < 5;
  try { result = full ? await checkAndNotify(env, time === 0) : await pyramidOnly(env); } catch (e) { ok = false; result = 'ERROR ' + e.message; }
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
    sysLevel: await env.STATE.get('sysLevel'), recAction: await env.STATE.get('recAction'),
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
    invested: sum(open, 'amount'), closedPnL: sum(closed, 'pnl'), open, closed, pyramid: pyrOpts(env),
  };
}

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
    // Sistema en dos pasos: último cálculo y prueba en papel.
    if (url.pathname.endsWith('/api/sistema')) {
      const [sys, paper] = await Promise.all([env.STATE.get('sys'), env.STATE.get('sysPaper')]);
      return new Response(`{"sys":${sys || 'null'},"paper":${paper || 'null'}}`, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
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

export { checkAndNotify, systemCheck, runCron, ntfyTarget, status, pyramidAlert };

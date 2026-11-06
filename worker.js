// Cloudflare Worker: sirve la app (carpeta public/), reenvía /etoro/* a la API de eToro
// añadiendo las claves (secretos del Worker, nunca llegan al navegador), guarda el histórico
// de velas de 1 min, muestra tus posiciones de eToro (solo lectura, con PIN) y, cada 15 minutos, calcula cuánto se espera que se mueva el oro, avisa por ntfy
// cuando se espera mucho movimiento y sigue en papel la ruptura de 1 h a favor de la tendencia diaria.
import './public/indicators.js'; // define globalThis.GoldTA
import './public/movement.js'; // define globalThis.GoldMove

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
  for (const [key, rows] of byDay) {
    const old = JSON.parse((await env.STATE.get(key)) || '[]');
    const seen = new Set(old.map((r) => r[0]));
    const add = rows.filter((r) => !seen.has(r[0]));
    if (!add.length) continue;
    const merged = old.concat(add).sort((a, b) => a[0] - b[0]);
    await env.STATE.put(key, JSON.stringify(merged), { expirationTtl: (HISTORY_DAYS_MAX + 2) * 86400 });
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

async function ntfy(env, { title, message, tags, priority }) {
  const headers = { 'content-type': 'application/json' };
  if (env.NTFY_TOKEN) headers.authorization = 'Bearer ' + env.NTFY_TOKEN;
  const r = await fetch((env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, ''), {
    method: 'POST', headers,
    body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message, tags, priority, click: env.APP_URL || undefined }),
  });
  if (!r.ok) throw new Error('ntfy respondió ' + r.status);
}

const refs = (env) => ({ m15: +(env.REF_15M || 5), h1: +(env.REF_1H || 10), h4: +(env.REF_4H || 20) });

// Avisa al pasar a movimiento ALTO en la próxima hora, y otra vez cuando se calma.
async function movementAlert(env, c1, c15) {
  const f = globalThis.GoldMove.forecast({ 1: c1, 15: c15 }, refs(env));
  const h1 = f.find((x) => x.id === 'h1'); if (!h1) return 'sin previsión';
  const prev = (await env.STATE.get('moveLevel')) || 'BAJO';
  const now = h1.level;
  if (now !== prev) await env.STATE.put('moveLevel', now);
  if (!env.NTFY_TOPIC || (now === 'ALTO') === (prev === 'ALTO')) return `${prev} -> ${now}`;
  const lines = f.map((x) => `${x.label}: rango ~${fmt(x.range, 0)} $ · ${pct(x.prob)} de alejarse ≥${x.ref} $`).join('\n');
  // La dirección la da la recomendación de la app (velas de 15 min y tendencia de 1 h), solo como contexto.
  let rec = '';
  try { const r = globalThis.GoldTA.stableSignal(c15, await getParams(env)); rec = `\nRecomendación ahora: ${r.action} (${r.reason}).`; } catch { /* sin recomendación */ }
  await ntfy(env, now === 'ALTO'
    ? { title: 'Cortés: se espera mucho movimiento en el oro', message: `Precio ${fmt(h1.price)} $.\n${lines}\nEste aviso indica tamaño, no dirección: puede ser hacia arriba o hacia abajo.${rec}`, tags: ['zap'], priority: 4 }
    : { title: 'Cortés: el oro se calma', message: `Precio ${fmt(h1.price)} $.\n${lines}`, tags: ['zzz'], priority: 2 });
  return `${prev} -> ${now} (aviso enviado)`;
}

// Avisa cuando la recomendación (velas de 15 min + tendencia de 1 h) pasa a COMPRAR o VENDER, y cuando vuelve a ESPERAR.
async function directionAlert(env, c15) {
  const r = globalThis.GoldTA.stableSignal(c15, await getParams(env));
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
  await env.STATE.put('recAction', r.action);
  if (!env.NTFY_TOPIC) return `${prev} -> ${r.action}`;
  const px = fmt(r.price);
  await ntfy(env, r.action === 'ESPERAR'
    ? { title: `Cortés: fin de ${prev} en el oro`, message: `Precio ${px} $. Ahora ESPERAR: ${r.reason}.`, tags: ['pause_button'], priority: 3 }
    : { title: `Cortés: ${r.action} oro`, message: `Precio ${px} $. ${r.reason}.\nRecomendación informativa, sin ventaja probada en el histórico. No es asesoramiento financiero.`, tags: [r.action === 'COMPRAR' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'], priority: 4 });
  return `${prev} -> ${r.action} (aviso enviado)`;
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
  const a = await movementAlert(env, c1, c15);
  const d = await directionAlert(env, c15).catch((e) => 'dirección: ' + e.message);
  const b = await paperBreakout(env, c1);
  return a + ' · ' + d + ' · ' + b;
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
    account: demo ? 'demo' : 'real', days, updatedAt: new Date().toISOString(), historyError,
    credit: num(cp.credit), unrealizedPnL: num(typeof cp.unrealizedPnL === 'number' ? cp.unrealizedPnL : pick(cp.unrealizedPnL || {}, 'pnL')) ?? sum(open, 'pnl'),
    invested: sum(open, 'amount'), closedPnL: sum(closed, 'pnl'), open, closed,
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
      const days = Math.min(364, Math.max(1, +url.searchParams.get('days') || 30));
      try { return json(await portfolio(env, days)); } catch (e) { return json({ error: e.message }, e.status || 500); }
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
    ctx.waitUntil(checkAndNotify(env).then((r) => console.log('cron:', r), (e) => console.error('cron:', e.message)));
  },
};

export { checkAndNotify, directionAlert };

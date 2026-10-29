// Cloudflare Worker: sirve la app (carpeta public/), reenvía /etoro/* a la API de eToro
// añadiendo las claves (secretos del Worker, nunca llegan al navegador), guarda el histórico
// de velas de 1 min y, cada 15 minutos, calcula cuánto se espera que se mueva el oro, avisa por ntfy
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

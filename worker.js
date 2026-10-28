// Cloudflare Worker: sirve la app (carpeta public/), reenvía /etoro/* a la API de eToro
// añadiendo las claves (secretos del Worker, nunca llegan al navegador), guarda el histórico
// de velas de 1 min y, cada 15 minutos, calcula la recomendación y la envía por ntfy.
import './public/indicators.js'; // define globalThis.GoldTA

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

async function fetchCandles(env, count = 1000) {
  const id = await goldId(env);
  const r = await etoro(env, `/api/v1/market-data/instruments/${id}/history/candles/asc/OneMinute/${count}`);
  if (!r.ok) throw new Error('eToro respondió ' + r.status);
  const j = await r.json();
  return ((j.candles && j.candles[0] && j.candles[0].candles) || [])
    .map((k) => ({ time: Math.floor(Date.parse(k.fromDate) / 1000), open: +k.open, high: +k.high, low: +k.low, close: +k.close }))
    .filter((k) => isFinite(k.close)).sort((a, b) => a.time - b.time);
}

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

const fmt = (x) => (x == null ? '—' : x.toFixed(2));

async function ntfy(env, s, prev) {
  const changed = s.action === 'ESPERAR';
  const message = changed
    ? `Pasa de ${prev} a ESPERAR a $${fmt(s.price)}. ${s.reason}.`
    : `${s.action} a $${fmt(s.price)} · stop ${fmt(s.stop)} · objetivo ${fmt(s.target)}\n` +
      `Puntuación ${s.score >= 0 ? '+' : ''}${s.score.toFixed(2)}, ${Math.round(s.agree * 100)}% de medidores de acuerdo.\n` +
      'Orientativo, no es asesoramiento financiero.';
  const headers = { 'content-type': 'application/json' };
  if (env.NTFY_TOKEN) headers.authorization = 'Bearer ' + env.NTFY_TOKEN;
  const r = await fetch((env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, ''), {
    method: 'POST', headers,
    body: JSON.stringify({
      topic: env.NTFY_TOPIC,
      title: changed ? 'Cortés: oro, ahora ESPERAR' : `Cortés: ${s.action} oro`,
      message,
      tags: [changed ? 'pause_button' : s.action === 'COMPRAR' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'],
      priority: changed ? 3 : 4,
      click: env.APP_URL || undefined,
    }),
  });
  if (!r.ok) throw new Error('ntfy respondió ' + r.status);
}

// Cada 15 min: guarda velas y avisa si hay COMPRAR/VENDER, o si se pasa de COMPRAR/VENDER a ESPERAR.
async function checkAndNotify(env) {
  const candles = await fetchCandles(env);
  await storeHistory(env, candles);
  if (!env.NTFY_TOPIC) return 'sin tema de ntfy';
  // Solo velas cerradas: la última puede estar todavía formándose.
  const closed = candles.filter((k) => k.time + 60 <= Date.now() / 1000);
  if (closed.length < 80) return 'sin datos';
  // Con el mercado cerrado (fin de semana, pausa diaria) la última vela se queda vieja: no avisamos.
  if (Date.now() / 1000 - closed[closed.length - 1].time > 20 * 60) return 'mercado cerrado';
  const I = globalThis.GoldTA.computeAll(closed);
  const s = globalThis.GoldTA.signalAt(I, closed.length - 1, await getParams(env));
  const prev = (await env.STATE.get('lastAction')) || 'ESPERAR';
  const send = s.action !== 'ESPERAR' || prev !== 'ESPERAR';
  if (send) await ntfy(env, s, prev);
  if (s.action !== prev) await env.STATE.put('lastAction', s.action);
  return `${prev} -> ${s.action}${send ? ' (aviso enviado)' : ''}`;
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

export { checkAndNotify };

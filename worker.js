// Cloudflare Worker: sirve la app (carpeta public/), reenvía /etoro/* a la API de eToro
// añadiendo las claves (secretos del Worker, nunca llegan al navegador) y, cada 15 minutos,
// calcula la recomendación y la envía por ntfy.
import './public/indicators.js'; // define globalThis.GoldTA

const ETORO = 'https://public-api.etoro.com';
const GOLD_ID_FALLBACK = 18;

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
  const r = await etoro(env, '/api/v1/market-data/search?internalSymbolFull=GOLD&fields=instrumentId,internalSymbolFull&pageSize=10');
  if (r.ok) {
    const hit = ((await r.json()).items || []).find((x) => String(x.internalSymbolFull).toUpperCase() === 'GOLD');
    if (hit) id = hit.instrumentId;
  }
  await env.STATE.put('goldId', String(id), { expirationTtl: 7 * 86400 });
  return id;
}

async function currentSignal(env) {
  const id = await goldId(env);
  const r = await etoro(env, `/api/v1/market-data/instruments/${id}/history/candles/asc/OneMinute/500`);
  if (!r.ok) throw new Error('eToro respondió ' + r.status);
  const j = await r.json();
  const candles = ((j.candles && j.candles[0] && j.candles[0].candles) || [])
    .map((k) => ({ time: Date.parse(k.fromDate), open: +k.open, high: +k.high, low: +k.low, close: +k.close }))
    .filter((k) => isFinite(k.close)).sort((a, b) => a.time - b.time);
  if (candles.length < 80) return null;
  // Con el mercado cerrado (fines de semana, pausa diaria) la última vela se queda vieja: no avisamos.
  if (Date.now() - candles[candles.length - 1].time > 20 * 60000) return null;
  const I = globalThis.GoldTA.computeAll(candles);
  return globalThis.GoldTA.signalAt(I, candles.length - 1, { threshold: +(env.THRESHOLD || 0.22), minMove: +(env.MIN_MOVE || 5), horizon: 15 });
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
      title: changed ? 'Oro: ahora ESPERAR' : `Oro: ${s.action}`,
      message,
      tags: [changed ? 'pause_button' : s.action === 'COMPRAR' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'],
      priority: changed ? 3 : 4,
      click: env.APP_URL || undefined,
    }),
  });
  if (!r.ok) throw new Error('ntfy respondió ' + r.status);
}

// Avisa si hay COMPRAR/VENDER, o si se pasa de COMPRAR/VENDER a ESPERAR.
async function checkAndNotify(env) {
  const s = await currentSignal(env);
  if (!s) return 'mercado cerrado o sin datos';
  const prev = (await env.STATE.get('lastAction')) || 'ESPERAR';
  const send = s.action !== 'ESPERAR' || prev !== 'ESPERAR';
  if (send) await ntfy(env, s, prev);
  await env.STATE.put('lastAction', s.action);
  return `${prev} -> ${s.action}${send ? ' (aviso enviado)' : ''}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const i = url.pathname.indexOf('/etoro/');
    if (i === -1) return env.ASSETS.fetch(request);

    const path = url.pathname.slice(i + '/etoro'.length);
    if (path === '/__ping') return Response.json({ ok: Boolean(env.ETORO_API_KEY && env.ETORO_USER_KEY) });

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
    if (!env.NTFY_TOPIC) return;
    ctx.waitUntil(checkAndNotify(env).then((r) => console.log('ntfy:', r)));
  },
};

export { checkAndNotify };

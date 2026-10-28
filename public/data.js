// Fuentes de datos: eToro (directo o a través del servidor propio) y PAXG de Binance como respaldo sin claves.
(function (root) {
  const ETORO = 'https://public-api.etoro.com';
  const INTERVALS = { 1: 'OneMinute', 5: 'FiveMinutes', 15: 'FifteenMinutes' };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16);
  }));

  class ApiError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }

  // Cuando la app la sirve el Worker de Cloudflare, /etoro/* reenvía a eToro con las claves guardadas como secretos.
  async function detectProxy() {
    try {
      const r = await fetch('etoro/__ping', { cache: 'no-store' });
      if (!r.ok) return false;
      const j = await r.json(); return j && j.ok === true;
    } catch { return false; }
  }

  async function etoroGet(cfg, path) {
    const base = cfg.proxy ? 'etoro' : ETORO;
    const headers = { 'x-request-id': uuid() };
    if (!cfg.proxy) {
      if (!cfg.apiKey || !cfg.userKey) throw new ApiError('Faltan las claves de eToro. Ábrelas en Ajustes.', 'keys');
      headers['x-api-key'] = cfg.apiKey; headers['x-user-key'] = cfg.userKey;
    }
    let r;
    try { r = await fetch(base + path, { headers, cache: 'no-store' }); }
    catch (e) {
      throw new ApiError(cfg.proxy ? 'No se pudo contactar con el servidor.' :
        'El navegador bloqueó la llamada directa a eToro (CORS o red). Usa el servidor propio (ver README).', 'network');
    }
    if (r.status === 401 || r.status === 403) throw new ApiError('eToro rechazó las claves (' + r.status + '). Revisa que la clave sea de lectura y del entorno correcto.', 'auth');
    if (r.status === 429) throw new ApiError('Límite de peticiones de eToro alcanzado. Espera un minuto.', 'rate');
    if (!r.ok) throw new ApiError('eToro respondió ' + r.status, 'http');
    return r.json();
  }

  async function resolveGoldId(cfg) {
    if (cfg.instrumentId) return cfg.instrumentId;
    try {
      const j = await etoroGet(cfg, '/api/v1/market-data/search?internalSymbolFull=GOLD&fields=instrumentId,internalSymbolFull,displayname&pageSize=10');
      const hit = (j.items || []).find((x) => String(x.internalSymbolFull).toUpperCase() === 'GOLD');
      if (hit) return hit.instrumentId;
    } catch (e) { if (e.kind === 'auth' || e.kind === 'keys' || e.kind === 'network') throw e; }
    return 18; // id histórico de GOLD en eToro, por si la búsqueda falla
  }

  async function etoroCandles(cfg, minutes, count = 1000) {
    const id = await resolveGoldId(cfg); cfg.instrumentId = id;
    const j = await etoroGet(cfg, `/api/v1/market-data/instruments/${id}/history/candles/asc/${INTERVALS[minutes]}/${count}`);
    const raw = (j.candles && j.candles[0] && j.candles[0].candles) || [];
    const candles = raw.map((k) => ({
      time: Math.floor(new Date(k.fromDate).getTime() / 1000),
      open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: +k.volume || 0,
    })).filter((k) => isFinite(k.close)).sort((a, b) => a.time - b.time);
    let live = null;
    try {
      const rj = await etoroGet(cfg, `/api/v1/market-data/instruments/rates?instrumentIds=${id}`);
      const rt = (rj.rates || [])[0];
      if (rt) live = { bid: +rt.bid, ask: +rt.ask, last: +rt.lastExecution, date: rt.date };
    } catch { /* el precio en vivo es opcional */ }
    return { candles, live, label: `eToro · GOLD (id ${id})` };
  }

  async function paxgCandles(minutes, count = 1000) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${minutes}m&limit=${count}`, { cache: 'no-store' });
    if (!r.ok) throw new ApiError('Binance respondió ' + r.status, 'http');
    const j = await r.json();
    const candles = j.map((k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    return { candles, live: null, label: 'Demo · PAXG/USDT (Binance), sigue al oro' };
  }

  root.GoldData = {
    detectProxy, ApiError,
    async load(cfg, minutes) {
      return cfg.source === 'etoro' ? etoroCandles(cfg, minutes) : paxgCandles(minutes);
    },
  };
})(window);

// Previsión del tamaño del movimiento (no de la dirección) y ruptura de 1 h seguida en papel.
// El análisis de 2 años de XAU/USD mostró que la dirección a 15 min, 1 h y 4 h no se puede
// predecir con ventaja, pero el tamaño del movimiento sí, a partir de la volatilidad (ATR) y la hora.
(function (root) {
  const TA = root.GoldTA;

  // Actividad relativa por hora UTC (1 = media), aproximada a partir del análisis de 2 años:
  // lo más movido de 12 a 15 h y de 00 a 01 h; lo más quieto, de 19 a 22 h.
  const HOUR_FACTOR = [1.15, 1.05, 0.9, 0.8, 0.8, 0.8, 0.8, 0.8, 0.85, 1.0, 1.25, 1.3,
    1.45, 1.5, 1.45, 1.35, 1.1, 1.0, 0.9, 0.7, 0.65, 0.7, 0.75, 0.9];

  const HORIZONS = [
    { id: 'm15', label: '15 min', minutes: 15, barMin: 1, ref: 5 },
    { id: 'h1', label: '1 hora', minutes: 60, barMin: 15, ref: 10 },
    { id: 'h4', label: '4 horas', minutes: 240, barMin: 15, ref: 20 },
  ];

  // Agrupa velas (time en segundos) en velas de `minutes`. Solo bloques completos salvo el último.
  function resample(candles, minutes) {
    const sec = minutes * 60, out = [];
    for (const k of candles) {
      const b = Math.floor(k.time / sec) * sec, last = out[out.length - 1];
      if (last && last.time === b) { last.high = Math.max(last.high, k.high); last.low = Math.min(last.low, k.low); last.close = k.close; }
      else out.push({ time: b, open: k.open, high: k.high, low: k.low, close: k.close });
    }
    return out;
  }

  const hourOf = (t) => new Date(t * 1000).getUTCHours();
  // Actividad media prevista para la ventana [t, t+minutes) respecto a la hora actual.
  function hourAdj(t, minutes) {
    let s = 0, n = 0;
    for (let m = 0; m < minutes; m += 15) { s += HOUR_FACTOR[hourOf(t + m * 60)]; n++; }
    return s / n / HOUR_FACTOR[hourOf(t)];
  }

  // Normal acumulada (Abramowitz-Stegun).
  function phi(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }

  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

  // Previsión para un horizonte. Calibra con los propios datos: compara lo previsto con lo que pasó
  // (rango y alejamiento máximo desde el precio de partida) y ajusta escala y dispersión.
  // `src` son velas de 1 min, o un objeto {1: velas1m, 15: velas15m} con las de cada intervalo ya descargadas.
  function forecastOne(src, hz, nowSec) {
    const byTf = Array.isArray(src) ? { 1: src } : src;
    const bars = byTf[hz.barMin] || resample(byTf[1] || [], hz.barMin);
    const closed = bars.filter((k) => k.time + hz.barMin * 60 <= nowSec);
    if (closed.length < 30) return null;
    const I = TA.computeAll(closed); const n = closed.length; const H = hz.minutes / hz.barMin;
    const pred = (i) => I.atr[i] * Math.sqrt(H) * hourAdj(closed[i].time + hz.barMin * 60, hz.minutes);
    const rr = [], ee = [];
    for (let i = 20; i < n - H; i++) {
      if (closed[i + H].time - closed[i].time > H * hz.barMin * 60 * 1.5) continue; // hueco de mercado
      const p = pred(i); if (!(p > 0)) continue;
      let hi = -Infinity, lo = Infinity;
      for (let j = i + 1; j <= i + H; j++) { hi = Math.max(hi, closed[j].high); lo = Math.min(lo, closed[j].low); }
      const c = closed[i].close;
      rr.push((hi - lo) / p); ee.push(Math.max(hi - c, c - lo) / p);
    }
    // Valores por defecto razonables si todavía hay pocos datos para calibrar.
    const enough = ee.length >= 30;
    const kR = enough ? median(rr) : 1.0, kE = enough ? median(ee) : 0.65;
    const logs = ee.filter((x) => x > 0).map((x) => Math.log(x / kE));
    const sigma = enough ? Math.max(0.25, Math.sqrt(logs.reduce((a, b) => a + b * b, 0) / logs.length)) : 0.5;
    const p = pred(n - 1), price = closed[n - 1].close;
    const range = kR * p, excursion = kE * p;
    const probAbove = (x) => (excursion > 0 ? 1 - phi((Math.log(x) - Math.log(excursion)) / sigma) : 0);
    const prob = probAbove(hz.ref);
    return {
      ...hz, price, atr: I.atr[n - 1], range, excursion, prob, probAbove, sigma, samples: ee.length, calibrated: enough,
      level: prob >= 0.6 ? 'ALTO' : prob >= 0.3 ? 'MEDIO' : 'BAJO',
    };
  }

  function forecast(src, refs = {}, nowSec = Date.now() / 1000, only) {
    return HORIZONS.filter((h) => !only || only.includes(h.id))
      .map((h) => forecastOne(src, { ...h, ref: refs[h.id] ?? h.ref }, nowSec)).filter(Boolean);
  }

  // Ruptura Donchian de 20 velas de 1 h a favor de la tendencia diaria (cierre diario sobre/bajo su EMA 20).
  // Devuelve 'LARGO', 'CORTO' o null para la última vela de 1 h cerrada.
  function breakout1h(hourly, daily) {
    if (hourly.length < 22 || daily.length < 21) return null;
    const last = hourly[hourly.length - 1], prev = hourly.slice(-21, -1);
    const hh = Math.max(...prev.map((k) => k.high)), ll = Math.min(...prev.map((k) => k.low));
    const dc = daily.map((k) => k.close), e = TA.ema(dc, 20), dl = dc.length - 1;
    const trend = dc[dl] > e[dl] ? 1 : dc[dl] < e[dl] ? -1 : 0;
    if (last.close > hh && trend > 0) return { side: 'LARGO', time: last.time, price: last.close, level: hh };
    if (last.close < ll && trend < 0) return { side: 'CORTO', time: last.time, price: last.close, level: ll };
    return null;
  }

  root.GoldMove = { HORIZONS, HOUR_FACTOR, resample, forecast, breakout1h, phi };
})(typeof window !== 'undefined' ? window : globalThis);

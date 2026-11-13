// Sistema en dos pasos sobre velas de 1 h del oro (lógica pura, sin red; la usan el Worker y la app).
// ① ¿Viene movimiento? Probabilidad de que en 6 h el precio se aleje más de un 0,8 %, con pesos fijos ajustados en 2022-24
//    y comprobados en 2025-26 (AUC 0,71 / 0,74). "Movimiento probable" = en el 20 % más alto de las horas anteriores.
// ② ¿Ha empezado? Cierre por encima del máximo (o debajo del mínimo) de las 20 velas anteriores, o vela de más de 1,2 ATR.
// ③ ¿Hacia dónde? Tendencia diaria: último cierre diario frente a su EMA 20, hasta ayer.
// Señal COMPRA/VENTA solo si ① está en "Movimiento probable", ② empieza y su dirección coincide con ③. Se cierra a las 6 h.
// Estudio: impulso-oro/cero/ (velas de 1 h dic 2021 – oct 2026). Ventaja pequeña y sin demostrar: se sigue en papel.
(function (root) {
  const HOLD_H = 6, SPREAD = 0.5, BIG_BAR = 1.2, DON = 20, STOP_ATR = 2, QUANT = 0.8, QWIN = 24 * 60;
  // Movimiento medio de cada hora UTC (rango de la vela / ATR de 5 días), 2022-2026.
  const HOUR = [0.854, 1.182, 0.896, 0.728, 0.611, 0.859, 0.952, 1.03, 1.018, 0.896, 0.881, 0.933, 1.475, 1.828, 1.761, 1.432,
    1.063, 0.917, 0.895, 0.827, 0.648, 0.544, 0.816, 0.719];
  const MODEL = {
    cols: ['atr_pct', 'atrL_pct', 'actividad_hora_sig', 'noticia_prox_2h', 'noticia_ult_3h', 'rango_vela_atr', 'nr7', 'bb_ancho_pct'],
    mu: [0.0024595976433097505, 0.0024574858982580245, 1.0002785304553918, 0.006538120567375886, 0.01174645390070922, 1.017086284214359, 0.16777482269503546, 0.5007326630768121],
    sd: [0.0007464973507631791, 0.0005928373636208505, 0.3273661884283689, 0.08059611318873897, 0.10774561688147757, 0.7218192417826442, 0.3736765558433631, 0.2938081691308033],
    w: [0.24114956318437883, 0.2905307101985546, 0.3154439124685039, 0.23552954692495193, 0.04787269018491862, 0.1398340900034467, -0.13598834965569898, -0.10365682871684892],
    b: -1.9316396236422246,
  };
  const LABEL = { atr_pct: 'volatilidad alta', atrL_pct: 'semana movida', actividad_hora_sig: 'hora activa', noticia_prox_2h: 'noticia en menos de 2 h',
    noticia_ult_3h: 'noticia reciente', rango_vela_atr: 'vela grande', nr7: 'vela muy estrecha', bb_ancho_pct: 'bandas estrechas' };

  // ---------- calendario: empleo de EE. UU. (NFP) y decisiones de la Fed ----------
  // Horario de verano de EE. UU.: del 2.º domingo de marzo al 1.er domingo de noviembre.
  function usDst(t) {
    const d = new Date(t * 1000), y = d.getUTCFullYear();
    const m = new Date(Date.UTC(y, 2, 1)), n = new Date(Date.UTC(y, 10, 1));
    const start = Date.UTC(y, 2, 1 + ((7 - m.getUTCDay()) % 7) + 7) / 1000, end = Date.UTC(y, 10, 1 + ((7 - n.getUTCDay()) % 7)) / 1000;
    return t >= start && t < end;
  }
  // Fed: día de la decisión (las 14 h de Nueva York). Fuente: federalreserve.gov (2027 es provisional). Ampliable con FED_DATES.
  const FED = ['2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
    '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
    '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08'];
  // Devuelve [{ t (segundos, inicio de la vela de 1 h de la noticia), name }] ordenado, entre dos fechas.
  function events(fromSec, toSec, extraFed = []) {
    const out = [];
    for (const s of FED.concat(extraFed)) {
      const t0 = Date.parse(s + 'T00:00:00Z') / 1000; if (!isFinite(t0)) continue;
      out.push({ t: t0 + (usDst(t0) ? 18 : 19) * 3600, name: 'Fed (tipos de interés)' });
    }
    const d = new Date(fromSec * 1000); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
    while (d.getTime() / 1000 <= toSec) {
      const first = new Date(d); while (first.getUTCDay() !== 5) first.setUTCDate(first.getUTCDate() + 1); // primer viernes
      const t0 = first.getTime() / 1000;
      out.push({ t: t0 + (usDst(t0) ? 12 : 13) * 3600, name: 'Empleo EE. UU. (NFP)' });
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return out.filter((e) => e.t >= fromSec - 86400 && e.t <= toSec).sort((a, b) => a.t - b.t);
  }

  // ---------- utilidades ----------
  const tr = (c, i) => (i ? Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)) : c[i].high - c[i].low);
  function quantile(arr, q) { // como pandas (interpolación lineal)
    const s = arr.filter((x) => isFinite(x)).sort((a, b) => a - b); if (!s.length) return NaN;
    const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }
  // EMA de pandas con adjust=True (pesos (1-α)^k normalizados)
  function emaAdj(v, span) {
    const a = 2 / (span + 1); let num = 0, den = 0; const out = [];
    for (const x of v) { num = x + (1 - a) * num; den = 1 + (1 - a) * den; out.push(num / den); }
    return out;
  }
  const dayOf = (t) => Math.floor(t / 86400);
  // Velas diarias (día UTC) a partir de las de 1 h.
  function dailyFromHourly(h) {
    const out = [];
    for (const k of h) { const d = dayOf(k.time), last = out[out.length - 1]; if (last && last.day === d) last.close = k.close; else out.push({ day: d, time: d * 86400, close: k.close }); }
    return out;
  }

  // Calcula, para cada vela de 1 h cerrada, las medidas, la probabilidad y la señal. `h`: velas de 1 h cerradas, en orden.
  // opts.daily: velas diarias cerradas (si no, se hacen con las de 1 h). opts.extraFed: fechas de la Fed añadidas.
  function series(h, opts = {}) {
    const n = h.length; if (n < 230) return null;
    const T = h.map((_, i) => tr(h, i));
    const atr = []; let e = T[0]; for (let i = 0; i < n; i++) { e = i ? e + (T[i] - e) / 14 : T[0]; atr.push(e); }
    const ev = events(h[0].time, h[n - 1].time + 7 * 86400, opts.extraFed || []);
    // tendencia diaria: EMA 20 de los cierres diarios hasta el día anterior
    const daily = (opts.daily && opts.daily.length ? opts.daily.map((k) => ({ day: dayOf(k.time), close: k.close })) : dailyFromHourly(h));
    const de = emaAdj(daily.map((k) => k.close), 20), dayIdx = new Map(daily.map((k, i) => [k.day, i]));
    const ratio = h.map((k, i) => { if (i < 19) return NaN; let s = 0, s2 = 0; for (let j = i - 19; j <= i; j++) { s += h[j].close; s2 += h[j].close ** 2; } const m = s / 20; const sd = Math.sqrt(Math.max(0, (s2 - 20 * m * m) / 19)); return sd / m; });
    const cumT = [0]; for (let i = 0; i < n; i++) cumT.push(cumT[i] + T[i]);
    const out = new Array(n).fill(null);
    let evi = 0;
    for (let i = 200; i < n; i++) {
      const k = h[i], t = k.time;
      // ATR de 5 días (media simple de 120 rangos) y % de anchura de bandas entre las 500 anteriores
      const atrL = (cumT[i + 1] - cumT[i - 119]) / 120;
      const w0 = Math.max(19, i - 499), ri = ratio[i], cnt = i - w0 + 1; let below = 0, eq = 0;
      for (let j = w0; j <= i; j++) { const r = ratio[j]; if (r < ri) below++; else if (r === ri) eq++; }
      const bbPct = cnt >= 200 ? (below + (eq + 1) / 2) / cnt : 0.5;
      let mn = Infinity; for (let j = i - 6; j <= i; j++) mn = Math.min(mn, T[j]);
      while (evi < ev.length && ev[evi].t <= t) evi++;
      const next = ev[evi], prev = ev[evi - 1];
      const x = {
        atr_pct: atr[i] / k.close, atrL_pct: atrL / k.close, actividad_hora_sig: HOUR[(new Date(t * 1000).getUTCHours() + 1) % 24],
        noticia_prox_2h: next && next.t - t <= 2 * 3600 ? 1 : 0, noticia_ult_3h: prev && t - prev.t <= 3 * 3600 ? 1 : 0,
        rango_vela_atr: T[i] / atr[i - 1], nr7: T[i] === mn ? 1 : 0, bb_ancho_pct: bbPct,
      };
      let z = MODEL.b; const contrib = {};
      MODEL.cols.forEach((c, j) => { const v = MODEL.w[j] * (x[c] - MODEL.mu[j]) / MODEL.sd[j]; contrib[c] = v; z += v; });
      const prob = 1 / (1 + Math.exp(-z));
      let hh = -Infinity, ll = Infinity; for (let j = i - DON; j < i; j++) { hh = Math.max(hh, h[j].high); ll = Math.min(ll, h[j].low); }
      const don = k.close > hh ? 1 : k.close < ll ? -1 : 0;
      const bdir = don || (x.rango_vela_atr > BIG_BAR ? Math.sign(k.close - k.open) : 0);
      const di = dayIdx.get(dayOf(t)); const yi = di != null ? di - 1 : daily.findLastIndex((d) => d.day < dayOf(t));
      const trend = yi >= 0 ? Math.sign(k.close - de[yi]) : 0;
      out[i] = { time: t, price: k.close, atr: atr[i], atrL, prob, x, contrib, hh, ll, don, bdir, trend, ema20d: yi >= 0 ? de[yi] : NaN, nextEvent: next || null };
    }
    // umbral: 80 % de las probabilidades de las horas anteriores (hasta 60 días)
    const probs = out.map((o) => (o ? o.prob : NaN));
    let prevSide = 0; const from = opts.tail ? Math.max(0, n - opts.tail) : 0;
    for (let i = 0; i < n; i++) {
      const o = out[i]; if (!o) continue;
      if (i < from) { o.threshold = NaN; o.alert = false; o.level = 'BAJO'; o.side = 0; o.signal = false; o.baseSide = 0; continue; }
      const past = probs.slice(Math.max(0, i - QWIN), i).filter((p) => isFinite(p));
      o.threshold = past.length >= (opts.minPast ?? 300) ? quantile(past, QUANT) : NaN;
      o.alert = isFinite(o.threshold) && o.prob >= o.threshold;
      o.level = o.alert ? 'ALTO' : isFinite(o.threshold) && o.prob >= quantile(past, 0.5) ? 'MEDIO' : 'BAJO';
      const side = o.alert && o.bdir !== 0 && o.bdir === o.trend ? o.trend : 0;
      o.side = side; o.signal = side !== 0 && side !== prevSide; prevSide = side;
      // misma ruptura a favor de la tendencia sin el paso ① (para comparar en papel)
      o.baseSide = o.bdir !== 0 && o.bdir === o.trend ? o.trend : 0;
    }
    let pb = 0; for (const o of out) { if (!o) continue; o.baseSignal = o.baseSide !== 0 && o.baseSide !== pb; pb = o.baseSide; }
    return out;
  }

  const LEVEL_TXT = { BAJO: 'Tranquilo', MEDIO: 'Atento', ALTO: 'Movimiento probable' };
  // Estado actual (última vela cerrada) en lenguaje sencillo.
  function evaluate(h, opts = {}) {
    const s = series(h, opts); if (!s) return null;
    const o = s[s.length - 1];
    const reasons = Object.entries(o.contrib).filter(([, v]) => v > 0.12).sort((a, b) => b[1] - a[1]).map(([k]) => LABEL[k]);
    const side = o.side > 0 ? 'COMPRA' : o.side < 0 ? 'VENTA' : null;
    let step2 = 'Esperando', note = '';
    if (o.bdir !== 0) step2 = o.bdir > 0 ? 'Empieza ↑' : 'Empieza ↓';
    if (o.alert && o.bdir !== 0 && o.bdir !== o.trend) note = 'Empieza, pero contra la tendencia diaria: no entrar.';
    if (!o.alert && o.bdir !== 0) note = 'Ruptura sin aviso de movimiento: no cuenta.';
    return {
      time: o.time, closeTime: o.time + 3600, price: o.price, atr: o.atr, prob: o.prob, threshold: o.threshold, level: o.level, levelText: LEVEL_TXT[o.level],
      reasons, nextEvent: o.nextEvent, hh: o.hh, ll: o.ll, bigBar: BIG_BAR * o.atr, step2, bdir: o.bdir,
      trend: o.trend > 0 ? 'alcista' : o.trend < 0 ? 'bajista' : '—', ema20d: o.ema20d, note,
      action: side, isNew: o.signal, stop: side ? o.price - o.side * STOP_ATR * o.atr : null, exitTime: o.time + 3600 + HOLD_H * 3600,
      series: s,
    };
  }

  // Prueba en papel. state = { lastT, open, closed, base: { open, closed } }. Recorre en orden las velas de 1 h cerradas
  // posteriores a lastT: entra en la apertura de la vela siguiente a la señal y sale con el cierre de la 6.ª vela, con 0,5 $
  // de diferencial. Mientras hay una abierta no se abre otra. `base` es la misma ruptura sin el paso ① (para comparar).
  function paper(state, h, s) {
    const st = { lastT: 0, open: [], closed: [], ...(state || {}) };
    st.base = { open: [], closed: [], ...(st.base || {}) };
    const ev = []; let changed = false;
    const first = s.findIndex((o) => o); if (first < 0) return { state: st, changed, events: ev };
    if (!st.lastT) { st.lastT = h[h.length - 1].time; st.since = st.lastT + 3600; } // primera vez: empieza ahora, sin rellenar el pasado
    const book = (b, sideKey, sigKey, tag) => (i) => {
      const k = h[i], o = s[i];
      for (const t of b.open.slice()) {
        if (t.entry == null && k.time === t.time + 3600) t.entry = k.open;
        if (t.entry == null && k.time > t.time) t.entry = k.open; // hueco de mercado
        if (t.entry != null && k.time >= t.time + HOLD_H * 3600) {
          const dir = t.side === 'COMPRA' ? 1 : -1, pnl = +(dir * (k.close - t.entry) - SPREAD).toFixed(2);
          const c = { ...t, exitTime: k.time + 3600, exit: k.close, pnl, pnlAtr: +(pnl / t.atr).toFixed(3) };
          b.closed.push(c); b.open = b.open.filter((x) => x !== t); if (tag) ev.push({ type: 'close', trade: c });
        }
      }
      if (o && o[sigKey] && !b.open.length) {
        const sd = o[sideKey];
        const t = { side: sd > 0 ? 'COMPRA' : 'VENTA', time: o.time, signalPrice: o.price, atr: +o.atr.toFixed(2), stop: +(o.price - sd * STOP_ATR * o.atr).toFixed(2), entry: null };
        b.open.push(t); if (tag) ev.push({ type: 'open', trade: t });
      }
      b.closed = b.closed.slice(-1000);
    };
    const A = book(st, 'side', 'signal', true), B = book(st.base, 'baseSide', 'baseSignal', false);
    for (let i = first; i < h.length; i++) {
      if (h[i].time <= st.lastT) continue;
      A(i); B(i); st.lastT = h[i].time; changed = true;
    }
    return { state: st, changed, events: ev };
  }

  function stats(list) {
    const c = list || [], wins = c.filter((t) => t.pnl > 0).length, total = c.reduce((a, t) => a + t.pnl, 0), atr = c.reduce((a, t) => a + (t.pnlAtr || 0), 0);
    return { n: c.length, wins, hit: c.length ? wins / c.length : null, total, avg: c.length ? total / c.length : null, avgAtr: c.length ? atr / c.length : null };
  }

  // Agrupa velas (time en segundos) en velas de `minutes` minutos.
  function resample(candles, minutes) {
    const sec = minutes * 60, out = [];
    for (const k of candles) {
      const b = Math.floor(k.time / sec) * sec, last = out[out.length - 1];
      if (last && last.time === b) { last.high = Math.max(last.high, k.high); last.low = Math.min(last.low, k.low); last.close = k.close; }
      else out.push({ time: b, open: k.open, high: k.high, low: k.low, close: k.close });
    }
    return out;
  }

  root.GoldSys = { HOLD_H, SPREAD, STOP_ATR, BIG_BAR, LEVEL_TXT, MODEL, HOUR, events, series, evaluate, paper, stats, resample, usDst };
})(typeof window !== 'undefined' ? window : globalThis);

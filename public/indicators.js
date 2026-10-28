// Indicadores técnicos y motor de señales. Funciones puras: arrays de números -> arrays.
(function (root) {
  const NaNArr = (n) => new Array(n).fill(NaN);

  function sma(v, p) {
    const out = NaNArr(v.length); let s = 0;
    for (let i = 0; i < v.length; i++) {
      s += v[i]; if (i >= p) s -= v[i - p];
      if (i >= p - 1) out[i] = s / p;
    }
    return out;
  }

  function ema(v, p) {
    const out = NaNArr(v.length); const k = 2 / (p + 1); let prev = NaN;
    for (let i = 0; i < v.length; i++) {
      if (isNaN(v[i])) continue;
      if (isNaN(prev)) {
        // arranque con la media simple de los primeros p valores válidos
        if (i >= p - 1 && v.slice(i - p + 1, i + 1).every((x) => !isNaN(x))) {
          prev = v.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p; out[i] = prev;
        }
        continue;
      }
      prev = v[i] * k + prev * (1 - k); out[i] = prev;
    }
    return out;
  }

  function rsi(c, p = 14) {
    const out = NaNArr(c.length); let g = 0, l = 0;
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1]; const up = Math.max(d, 0), dn = Math.max(-d, 0);
      if (i <= p) { g += up; l += dn; if (i === p) { g /= p; l /= p; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; }
      g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  function macd(c, f = 12, s = 26, sig = 9) {
    const ef = ema(c, f), es = ema(c, s);
    const line = c.map((_, i) => ef[i] - es[i]);
    const signal = ema(line, sig);
    return { line, signal, hist: line.map((x, i) => x - signal[i]) };
  }

  function bollinger(c, p = 20, k = 2) {
    const mid = sma(c, p), up = NaNArr(c.length), lo = NaNArr(c.length);
    for (let i = p - 1; i < c.length; i++) {
      let s = 0; for (let j = i - p + 1; j <= i; j++) s += (c[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / p); up[i] = mid[i] + k * sd; lo[i] = mid[i] - k * sd;
    }
    return { mid, up, lo };
  }

  function atr(h, l, c, p = 14) {
    const tr = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    const out = NaNArr(c.length); let prev = NaN;
    for (let i = 0; i < c.length; i++) {
      if (i === p - 1) { prev = tr.slice(0, p).reduce((a, b) => a + b, 0) / p; out[i] = prev; }
      else if (i >= p) { prev = (prev * (p - 1) + tr[i]) / p; out[i] = prev; }
    }
    return out;
  }

  function stochastic(h, l, c, p = 14, d = 3) {
    const k = NaNArr(c.length);
    for (let i = p - 1; i < c.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - p + 1; j <= i; j++) { hh = Math.max(hh, h[j]); ll = Math.min(ll, l[j]); }
      k[i] = hh === ll ? 50 : ((c[i] - ll) / (hh - ll)) * 100;
    }
    return { k, d: sma(k.map((x) => (isNaN(x) ? 0 : x)), d).map((x, i) => (i < p + d - 2 ? NaN : x)) };
  }

  const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));

  // Tendencia en velas de 15 min construidas a partir de las de 1 o 5 min.
  // Para la vela i solo se usa el último bloque de 15 min ya cerrado (sin mirar al futuro).
  function htfTrend(t, c) {
    const out = new Array(c.length).fill(0); if (!t) return out;
    const bucket = t.map((x) => Math.floor(x / 900));
    const closes = [], idxOf = new Map();
    for (let i = 0; i < c.length; i++) {
      if (!idxOf.has(bucket[i])) { idxOf.set(bucket[i], closes.length); closes.push(c[i]); } else closes[idxOf.get(bucket[i])] = c[i];
    }
    const f = ema(closes, 9), sl = ema(closes, 21);
    for (let i = 0; i < c.length; i++) {
      const k = idxOf.get(bucket[i]) - 1; // bloque anterior, ya cerrado
      if (k >= 0 && !isNaN(f[k]) && !isNaN(sl[k])) out[i] = f[k] > sl[k] ? 1 : f[k] < sl[k] ? -1 : 0;
    }
    return out;
  }

  // Calcula todos los indicadores una sola vez para la serie completa. time en segundos.
  function computeAll(candles) {
    const o = candles.map((x) => x.open), h = candles.map((x) => x.high), l = candles.map((x) => x.low), c = candles.map((x) => x.close);
    const t = candles.every((x) => isFinite(x.time)) ? candles.map((x) => x.time) : null;
    return {
      o, h, l, c, t,
      ema9: ema(c, 9), ema21: ema(c, 21), ema50: ema(c, 50),
      rsi: rsi(c, 14), macd: macd(c), bb: bollinger(c), atr: atr(h, l, c), stoch: stochastic(h, l, c),
      htf: htfTrend(t, c),
    };
  }

  // Cada medidor emite un voto en [-1, 1] (negativo = bajista) y un peso.
  const METERS = [
    { id: 'trend', family: 'trend', name: 'Tendencia EMA 9/21/50', weight: 1.5, vote(I, i) {
      const { ema9: a, ema21: b, ema50: e, atr: t } = I;
      if ([a[i], b[i], e[i], t[i]].some(isNaN) || t[i] === 0) return null;
      const spread = clamp((a[i] - b[i]) / t[i] / 1.5);
      const align = a[i] > b[i] && b[i] > e[i] ? 0.3 : a[i] < b[i] && b[i] < e[i] ? -0.3 : 0;
      return { v: clamp(spread * 0.7 + align), txt: `EMA9 ${a[i] > b[i] ? '>' : '<'} EMA21 ${b[i] > e[i] ? '>' : '<'} EMA50` };
    } },
    { id: 'macd', family: 'trend', name: 'MACD (12,26,9)', weight: 1.25, vote(I, i) {
      const hcur = I.macd.hist[i], hprev = I.macd.hist[i - 1], t = I.atr[i];
      if ([hcur, hprev, t].some(isNaN) || t === 0) return null;
      const lvl = clamp(hcur / (t * 0.25)), slope = clamp((hcur - hprev) / (t * 0.08));
      return { v: clamp(lvl * 0.6 + slope * 0.4), txt: `histograma ${hcur >= 0 ? '+' : ''}${hcur.toFixed(3)} (${hcur > hprev ? 'subiendo' : 'bajando'})` };
    } },
    { id: 'rsi', family: 'rev', name: 'RSI (14)', weight: 1, vote(I, i) {
      const r = I.rsi[i]; if (isNaN(r)) return null;
      // Extremos: reversión a la media. Zona media: acompaña el impulso.
      let v;
      if (r >= 75) v = -1; else if (r >= 68) v = -0.5;
      else if (r <= 25) v = 1; else if (r <= 32) v = 0.5;
      else v = clamp((r - 50) / 25) * 0.5;
      return { v, txt: r.toFixed(1) + (r >= 70 ? ' · sobrecompra' : r <= 30 ? ' · sobreventa' : '') };
    } },
    { id: 'bb', family: 'rev', name: 'Bandas de Bollinger (20,2)', weight: 1, vote(I, i) {
      const { up, lo } = I.bb; if (isNaN(up[i]) || up[i] === lo[i]) return null;
      const pb = (I.c[i] - lo[i]) / (up[i] - lo[i]);
      let v = 0;
      if (pb > 1) v = -0.8; else if (pb > 0.85) v = -0.4; else if (pb < 0) v = 0.8; else if (pb < 0.15) v = 0.4;
      return { v, txt: `%B ${(pb * 100).toFixed(0)}%` };
    } },
    { id: 'stoch', family: 'rev', name: 'Estocástico (14,3)', weight: 0.75, vote(I, i) {
      const k = I.stoch.k[i], d = I.stoch.d[i]; if (isNaN(k) || isNaN(d)) return null;
      let v = clamp((k - d) / 15) * 0.5;
      if (k > 80 && k < d) v = -0.8; else if (k < 20 && k > d) v = 0.8;
      return { v, txt: `%K ${k.toFixed(0)} · %D ${d.toFixed(0)}` };
    } },
    { id: 'mom', family: 'trend', name: 'Impulso (5 velas)', weight: 0.75, vote(I, i) {
      if (i < 5 || isNaN(I.atr[i]) || I.atr[i] === 0) return null;
      const m = (I.c[i] - I.c[i - 5]) / I.atr[i];
      return { v: clamp(m / 2), txt: `${m >= 0 ? '+' : ''}${m.toFixed(2)} ATR` };
    } },
  ];

  // Parámetros del motor. mode: 'mixto' (todos los medidores), 'tendencia' (EMA, MACD, impulso;
  // RSI/Bollinger/Estocástico solo vetan extremos en contra) o 'rebote' (al revés).
  const DEFAULTS = { mode: 'tendencia', threshold: 0.22, agree: 0.5, htf: false, minMove: 5, minAtrPct: 0.006, horizon: 15 };
  const MODES = { mixto: 'Mixto', tendencia: 'Tendencia', rebote: 'Rebote' };

  function familyScore(parts, fam) {
    let s = 0, w = 0;
    for (const p of parts) if (!fam || p.family === fam) { s += p.v * p.weight; w += p.weight; }
    return w ? s / w : 0;
  }

  // Señal combinada para la vela i.
  function signalAt(I, i, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const parts = [];
    for (const m of METERS) {
      const r = m.vote(I, i); if (!r) continue;
      parts.push({ id: m.id, name: m.name, family: m.family, weight: m.weight, ...r });
    }
    if (!parts.length) return { action: 'ESPERAR', score: 0, parts, reason: 'Datos insuficientes' };
    const main = o.mode === 'tendencia' ? 'trend' : o.mode === 'rebote' ? 'rev' : null;
    const used = main ? parts.filter((p) => p.family === main) : parts;
    const score = familyScore(parts, main);
    const other = main ? familyScore(parts, main === 'trend' ? 'rev' : 'trend') : 0;
    const price = I.c[i], a = I.atr[i];
    const atrPct = (a / price) * 100;
    // Acuerdo: proporción de medidores usados que votan claramente en la dirección del score.
    const agree = used.filter((p) => Math.sign(p.v) === Math.sign(score) && Math.abs(p.v) > 0.1).length / used.length;
    const hz = a * Math.sqrt(o.horizon); // recorrido probable: la volatilidad crece con la raíz del tiempo
    let action = 'ESPERAR', reason = 'Los medidores no coinciden lo suficiente';
    const want = score >= o.threshold ? 1 : score <= -o.threshold ? -1 : 0;
    const word = want > 0 ? 'Alcista' : 'Bajista';
    if (atrPct < o.minAtrPct) reason = 'Mercado demasiado quieto (volatilidad muy baja)';
    else if (!want) reason = 'Los medidores no coinciden lo suficiente';
    else if (agree < o.agree) reason = `${word}, pero solo coincide el ${Math.round(agree * 100)}% de los medidores`;
    else if (main && other * want < -0.5) reason = `${word}, pero ${main === 'trend' ? 'en sobrecompra/sobreventa' : 'la tendencia va en contra'}`;
    else if (o.htf && I.htf && I.htf[i] !== want) reason = `${word}, pero la tendencia de 15 min no acompaña`;
    else if (o.minMove > 0 && hz < o.minMove) reason = `${word}, pero el recorrido probable (~${hz.toFixed(1)} $) no llega a ${o.minMove} $`;
    else { action = want > 0 ? 'COMPRAR' : 'VENDER'; reason = want > 0 ? 'Mayoría de medidores alcistas' : 'Mayoría de medidores bajistas'; }
    const dir = action === 'COMPRAR' ? 1 : action === 'VENDER' ? -1 : 0;
    return {
      action, score, agree, parts, reason, price, atr: a, atrPct, expectedMove: hz, htf: I.htf ? I.htf[i] : 0,
      stop: dir ? price - dir * hz : null, target: dir ? price + dir * Math.max(o.minMove, hz * 1.2) : null,
    };
  }

  // ¿Hay un hueco (cierre diario, fin de semana) entre i y j?
  function gap(I, i, j, barSec) { return I.t && I.t[j] - I.t[i] > (j - i) * barSec * 1.5; }

  // Prueba histórica entre las velas [from, to): ¿alcanzó el precio el objetivo mínimo dentro del horizonte?
  function backtest(I, opts = {}, from = 60, to = I.c.length) {
    const o = { ...DEFAULTS, ...opts }; const H = o.horizon; const barSec = 900 / H;
    const end = Math.min(to, I.c.length - H);
    let hits = 0, total = 0, pnl = 0, reach = 0, windows = 0;
    for (let i = Math.max(from, 60); i < end; i++) {
      if (gap(I, i, i + H, barSec)) continue;
      let up = -Infinity, dn = -Infinity;
      for (let j = i + 1; j <= i + H; j++) { up = Math.max(up, I.h[j] - I.c[i]); dn = Math.max(dn, I.c[i] - I.l[j]); }
      windows += 2; reach += (up >= o.minMove) + (dn >= o.minMove);
    }
    for (let i = Math.max(from, 60); i < end; i++) {
      if (gap(I, i, i + H, barSec)) continue;
      const s = signalAt(I, i, o); if (s.action === 'ESPERAR') continue;
      const dir = s.action === 'COMPRAR' ? 1 : -1;
      let best = -Infinity;
      for (let j = i + 1; j <= i + H; j++) best = Math.max(best, dir > 0 ? I.h[j] - I.c[i] : I.c[i] - I.l[j]);
      total++; if (best >= o.minMove) hits++; pnl += dir * (I.c[i + H] - I.c[i]);
      i += H - 1; // no contar dos veces la misma ventana de 15 min
    }
    return { total, hits, rate: total ? hits / total : NaN, avgMove: total ? pnl / total : NaN,
      baseRate: windows ? reach / windows : NaN, bars: Math.max(0, end - Math.max(from, 60)) };
  }

  // Optimizador: elige parámetros con el 70% más antiguo de los datos y los valida con el 30% más reciente,
  // que no ha visto. Asíncrono para no bloquear la pantalla; onProgress(0..1).
  async function optimize(candles, base = {}, onProgress) {
    const I = computeAll(candles); const n = candles.length; const cut = Math.floor(n * 0.7);
    const grid = [];
    for (const mode of Object.keys(MODES)) for (const threshold of [0.15, 0.2, 0.25, 0.3, 0.4])
      for (const agree of [0.5, 0.6, 0.75]) for (const htf of [false, true]) grid.push({ ...base, mode, threshold, agree, htf });
    const minTrain = Math.max(10, Math.round(cut / 400)); // al menos ~1 señal cada 400 velas
    const rows = [];
    for (let g = 0; g < grid.length; g++) {
      const p = grid[g]; const tr = backtest(I, p, 60, cut);
      if (tr.total >= minTrain) rows.push({ p, train: tr, edge: tr.rate - tr.baseRate });
      if (g % 5 === 4) { onProgress && onProgress((g + 1) / grid.length); await new Promise((r) => setTimeout(r, 0)); }
    }
    rows.sort((a, b) => b.edge - a.edge || b.train.total - a.train.total);
    const best = rows[0] || null;
    const current = { train: backtest(I, base, 60, cut), test: backtest(I, base, cut, n) };
    if (best) best.test = backtest(I, best.p, cut, n);
    return { best, current, candles: n, trainBars: cut, testBars: n - cut, tried: grid.length };
  }

  root.GoldTA = { sma, ema, rsi, macd, bollinger, atr, stochastic, computeAll, signalAt, backtest, optimize, METERS, DEFAULTS, MODES };
})(typeof window !== 'undefined' ? window : globalThis);

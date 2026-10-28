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

  // Calcula todos los indicadores una sola vez para la serie completa.
  function computeAll(candles) {
    const o = candles.map((x) => x.open), h = candles.map((x) => x.high), l = candles.map((x) => x.low), c = candles.map((x) => x.close);
    return {
      o, h, l, c,
      ema9: ema(c, 9), ema21: ema(c, 21), ema50: ema(c, 50),
      rsi: rsi(c, 14), macd: macd(c), bb: bollinger(c), atr: atr(h, l, c), stoch: stochastic(h, l, c),
    };
  }

  // Cada medidor emite un voto en [-1, 1] (negativo = bajista) y un peso.
  const METERS = [
    { id: 'trend', name: 'Tendencia EMA 9/21/50', weight: 1.5, vote(I, i) {
      const { ema9: a, ema21: b, ema50: e, atr: t } = I;
      if ([a[i], b[i], e[i], t[i]].some(isNaN) || t[i] === 0) return null;
      const spread = clamp((a[i] - b[i]) / t[i] / 1.5);
      const align = a[i] > b[i] && b[i] > e[i] ? 0.3 : a[i] < b[i] && b[i] < e[i] ? -0.3 : 0;
      return { v: clamp(spread * 0.7 + align), txt: `EMA9 ${a[i] > b[i] ? '>' : '<'} EMA21 ${b[i] > e[i] ? '>' : '<'} EMA50` };
    } },
    { id: 'macd', name: 'MACD (12,26,9)', weight: 1.25, vote(I, i) {
      const hcur = I.macd.hist[i], hprev = I.macd.hist[i - 1], t = I.atr[i];
      if ([hcur, hprev, t].some(isNaN) || t === 0) return null;
      const lvl = clamp(hcur / (t * 0.25)), slope = clamp((hcur - hprev) / (t * 0.08));
      return { v: clamp(lvl * 0.6 + slope * 0.4), txt: `histograma ${hcur >= 0 ? '+' : ''}${hcur.toFixed(3)} (${hcur > hprev ? 'subiendo' : 'bajando'})` };
    } },
    { id: 'rsi', name: 'RSI (14)', weight: 1, vote(I, i) {
      const r = I.rsi[i]; if (isNaN(r)) return null;
      // Extremos: reversión a la media. Zona media: acompaña el impulso.
      let v;
      if (r >= 75) v = -1; else if (r >= 68) v = -0.5;
      else if (r <= 25) v = 1; else if (r <= 32) v = 0.5;
      else v = clamp((r - 50) / 25) * 0.5;
      return { v, txt: r.toFixed(1) + (r >= 70 ? ' · sobrecompra' : r <= 30 ? ' · sobreventa' : '') };
    } },
    { id: 'bb', name: 'Bandas de Bollinger (20,2)', weight: 1, vote(I, i) {
      const { up, lo } = I.bb; if (isNaN(up[i]) || up[i] === lo[i]) return null;
      const pb = (I.c[i] - lo[i]) / (up[i] - lo[i]);
      let v = 0;
      if (pb > 1) v = -0.8; else if (pb > 0.85) v = -0.4; else if (pb < 0) v = 0.8; else if (pb < 0.15) v = 0.4;
      return { v, txt: `%B ${(pb * 100).toFixed(0)}%` };
    } },
    { id: 'stoch', name: 'Estocástico (14,3)', weight: 0.75, vote(I, i) {
      const k = I.stoch.k[i], d = I.stoch.d[i]; if (isNaN(k) || isNaN(d)) return null;
      let v = clamp((k - d) / 15) * 0.5;
      if (k > 80 && k < d) v = -0.8; else if (k < 20 && k > d) v = 0.8;
      return { v, txt: `%K ${k.toFixed(0)} · %D ${d.toFixed(0)}` };
    } },
    { id: 'mom', name: 'Impulso (5 velas)', weight: 0.75, vote(I, i) {
      if (i < 5 || isNaN(I.atr[i]) || I.atr[i] === 0) return null;
      const m = (I.c[i] - I.c[i - 5]) / I.atr[i];
      return { v: clamp(m / 2), txt: `${m >= 0 ? '+' : ''}${m.toFixed(2)} ATR` };
    } },
  ];

  const DEFAULTS = { threshold: 0.22, minAtrPct: 0.006, horizon: 15 };

  // Señal combinada para la vela i.
  function signalAt(I, i, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const enabled = o.enabled || METERS.map((m) => m.id);
    let sum = 0, wsum = 0; const parts = [];
    for (const m of METERS) {
      if (!enabled.includes(m.id)) continue;
      const r = m.vote(I, i); if (!r) continue;
      sum += r.v * m.weight; wsum += m.weight; parts.push({ id: m.id, name: m.name, ...r });
    }
    if (wsum === 0) return { action: 'ESPERAR', score: 0, parts, reason: 'Datos insuficientes' };
    const score = sum / wsum;
    const price = I.c[i], a = I.atr[i];
    const atrPct = (a / price) * 100;
    // Acuerdo: proporción de medidores que votan en la dirección del score.
    const agree = parts.filter((p) => Math.sign(p.v) === Math.sign(score) && Math.abs(p.v) > 0.1).length / parts.length;
    let action = 'ESPERAR', reason = 'Los medidores no coinciden lo suficiente';
    if (atrPct < o.minAtrPct) reason = 'Mercado demasiado quieto (volatilidad muy baja)';
    else if (score >= o.threshold && agree >= 0.5) { action = 'COMPRAR'; reason = 'Mayoría de medidores alcistas'; }
    else if (score <= -o.threshold && agree >= 0.5) { action = 'VENDER'; reason = 'Mayoría de medidores bajistas'; }
    const dir = action === 'COMPRAR' ? 1 : action === 'VENDER' ? -1 : 0;
    // Niveles orientativos escalados al horizonte (volatilidad ~ raíz del tiempo).
    const hz = a * Math.sqrt(o.horizon);
    return {
      action, score, agree, parts, reason, price, atr: a, atrPct,
      stop: dir ? price - dir * hz * 1.0 : null, target: dir ? price + dir * hz * 1.2 : null,
    };
  }

  // Prueba histórica sobre las velas cargadas: ¿acertó la dirección a N velas vista?
  function backtest(I, opts = {}) {
    const o = { ...DEFAULTS, ...opts }; const n = I.c.length; const H = o.horizonBars || o.horizon;
    let hits = 0, total = 0, pnl = 0;
    for (let i = 60; i < n - H; i++) {
      const fwd = I.c[i + H] - I.c[i];
      const s = signalAt(I, i, o); if (s.action === 'ESPERAR') continue;
      const dir = s.action === 'COMPRAR' ? 1 : -1;
      total++; if (dir * fwd > 0) hits++; pnl += dir * fwd;
      i += H - 1; // no contar dos veces la misma ventana de 15 min
    }
    return { total, hits, rate: total ? hits / total : NaN, avgMove: total ? pnl / total : NaN, bars: Math.max(0, n - H - 60) };
  }

  root.GoldTA = { sma, ema, rsi, macd, bollinger, atr, stochastic, computeAll, signalAt, backtest, METERS, DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);

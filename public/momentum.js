// Semáforo de impulso a 6 h: si el oro se mueve con fuerza ahora, tiende a seguir un poco más en las 6 h siguientes.
// Media de seis medidores sobre velas de 1 h cerradas, cada uno entre −1 y +1:
// CCI(20), Bollinger(20), Keltner(EMA 20 ± 2 ATR), precio frente a la apertura del día (UTC), pendiente de la EMA 20 (3 velas)
// y subida de las últimas 6 h. Verde (COMPRA) si la media supera +0,6, rojo (VENTA) si baja de −0,6, gris si no.
// Histórico 2022-sep 2026 (Dukascopy, 0,5 $ de spread): unas 4 señales al día; ganó en 2024-2026 y perdió en 2022-2023.
// Sin ventaja confirmada: se sigue en papel. Lógica pura, la usan el Worker y la app.
(function (root) {
  const THRESHOLD = 0.6, HOURS = 6, SPREAD = 0.5;
  const clip = (x) => Math.max(-1, Math.min(1, x));
  const ema = (v, n) => { const k = 2 / (n + 1), o = []; let e = v[0]; for (let i = 0; i < v.length; i++) { e = i ? v[i] * k + e * (1 - k) : v[0]; o.push(e); } return o; };
  const rma = (v, n) => { const o = []; let e = v[0]; for (let i = 0; i < v.length; i++) { e = i ? e + (v[i] - e) / n : v[0]; o.push(e); } return o; };
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

  // c: velas de 1 h cerradas [{ time, open, high, low, close }], en orden. Hacen falta al menos 60.
  function score(c) {
    const n = c.length;
    if (n < 60) return null;
    const cl = c.map((k) => k.close), hi = c.map((k) => k.high), lo = c.map((k) => k.low);
    const tr = c.map((k, i) => (i ? Math.max(k.high - k.low, Math.abs(k.high - cl[i - 1]), Math.abs(k.low - cl[i - 1])) : k.high - k.low));
    const atr = rma(tr, 14), e20 = ema(cl, 20);
    const i = n - 1, a = atr[i], px = cl[i];
    if (!(a > 0)) return null;
    // CCI con desviación media de las 20 últimas (cada una con su propia media de 20)
    const tp = c.map((k) => (k.high + k.low + k.close) / 3);
    const sma = (j) => mean(tp.slice(j - 19, j + 1));
    const dev = []; for (let j = i - 19; j <= i; j++) dev.push(Math.abs(tp[j] - sma(j)));
    const cci = (tp[i] - sma(i)) / (0.015 * mean(dev));
    const last20 = cl.slice(i - 19), m20 = mean(last20);
    const sd = Math.sqrt(last20.reduce((s, x) => s + (x - m20) ** 2, 0) / 19);
    // Apertura del día UTC: la primera vela de 1 h de ese día
    const day = Math.floor(c[i].time / 86400);
    let j0 = i; while (j0 > 0 && Math.floor(c[j0 - 1].time / 86400) === day) j0--;
    const parts = {
      cci: clip(Math.tanh(cci / 200)),
      bollinger: clip(Math.tanh((px - m20) / (2 * sd))),
      keltner: clip(Math.tanh((px - e20[i]) / (2 * a))),
      apertura: clip(Math.tanh((px - c[j0].open) / a)),
      pendiente: clip(Math.tanh((e20[i] - e20[i - 3]) / a)),
      impulso6h: clip(Math.tanh((px - cl[i - 6]) / (a * Math.sqrt(6)))),
    };
    const s = mean(Object.values(parts));
    const action = s > THRESHOLD ? 'COMPRA' : s < -THRESHOLD ? 'VENTA' : 'NADA';
    return { time: c[i].time, price: px, atr: a, score: s, action, parts };
  }

  // Prueba en papel. state = { open: [], closed: [] }. Abre una operación ficticia en cada vela de 1 h con señal
  // (pueden solaparse, como en el análisis) y la cierra 6 h después con el precio de ese momento, descontando el spread.
  function paperStep(state, sig, price, now) {
    const st = { open: (state && state.open) || [], closed: (state && state.closed) || [] };
    let changed = false, opened = null;
    for (const t of st.open.filter((x) => now >= x.time + 3600 + HOURS * 3600 && isFinite(price))) {
      const dir = t.side === 'COMPRA' ? 1 : -1;
      st.closed.push({ ...t, exitTime: Math.floor(now), exit: price, pnl: +(dir * (price - t.entry) - SPREAD).toFixed(2) });
      st.open = st.open.filter((x) => x !== t); changed = true;
    }
    if (sig && sig.action !== 'NADA' && !st.open.concat(st.closed).some((x) => x.time === sig.time)) {
      opened = { side: sig.action, time: sig.time, entry: sig.price, score: +sig.score.toFixed(2), atr: +sig.atr.toFixed(2) };
      st.open.push(opened); changed = true;
    }
    st.closed = st.closed.slice(-1000);
    return { state: st, changed, opened };
  }

  function stats(state) {
    const c = (state && state.closed) || [];
    const wins = c.filter((t) => t.pnl > 0).length, total = c.reduce((a, t) => a + t.pnl, 0);
    return { n: c.length, wins, hit: c.length ? wins / c.length : null, total, avg: c.length ? total / c.length : null };
  }

  root.GoldMomentum = { THRESHOLD, HOURS, SPREAD, score, paperStep, stats };
})(typeof window !== 'undefined' ? window : globalThis);

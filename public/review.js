// Cruza tus operaciones de oro en eToro con la recomendación de Cortés en el momento de abrir y de cerrar,
// resume ganancias y pérdidas por grupo y propone mejoras. Funciona en el navegador y en Node.
(function (root) {
  const TA = root.GoldTA;
  const sec = (s) => (s ? Math.floor(Date.parse(s) / 1000) : null);
  const isGold = (p) => String(p.symbol || '').toUpperCase() === 'GOLD' || /^(gold|oro)\b/i.test(p.name || '');

  // Recomendación vigente en el instante t: primero el registro real del servidor; si no cubre ese momento,
  // se recalcula con las velas de 15 min cerradas antes de t y los ajustes actuales.
  function recAt(t, c15, params, log) {
    if (log && log.start && t >= log.start) {
      let last = null;
      for (const x of log.items || []) { if (x.t <= t) last = x; else break; }
      return { action: last ? last.a : 'ESPERAR', stage: last && last.s, source: 'registro' };
    }
    let hi = c15.length; // primera vela que aún no había cerrado en t
    for (let i = 0; i < c15.length; i++) if (c15[i].time + 900 > t) { hi = i; break; }
    if (hi < 80 || t - (c15[hi - 1].time + 900) > 6 * 3600) return null; // sin velas suficientes antes de t
    const s = TA.stableSignal(c15.slice(Math.max(0, hi - 300), hi), params);
    return { action: s.action, stage: s.stage, source: 'recalculada' };
  }

  const relation = (isBuy, action) => (action === 'ESPERAR' ? 'esperar' : (action === 'COMPRAR') === isBuy ? 'favor' : 'contra');
  const GROUPS = { favor: 'A favor de la recomendación', contra: 'En contra de la recomendación', esperar: 'Con la app en ESPERAR', sin: 'Sin datos de la app' };

  function stats(list) {
    const n = list.length, wins = list.filter((x) => x.pnl > 0);
    const total = list.reduce((a, x) => a + (x.pnl || 0), 0);
    const gw = wins.reduce((a, x) => a + x.pnl, 0), gl = -list.filter((x) => x.pnl < 0).reduce((a, x) => a + x.pnl, 0);
    const mins = list.filter((x) => x.minutes != null).map((x) => x.minutes);
    return { n, wins: wins.length, winRate: n ? wins.length / n : null, total, avg: n ? total / n : null,
      profitFactor: gl ? gw / gl : null, avgMinutes: mins.length ? mins.reduce((a, b) => a + b, 0) / mins.length : null };
  }

  function analyze({ open = [], closed = [], c15 = [], params = {}, log = null, from = null }) {
    const rows = [], fromT = sec(from);
    // Solo cuentan las operaciones abiertas desde `from` (creación de Cortés).
    if (fromT) { open = open.filter((p) => sec(p.openTime) >= fromT); closed = closed.filter((p) => sec(p.openTime) >= fromT); }
    for (const [p, isOpen] of [...closed.map((p) => [p, false]), ...open.map((p) => [p, true])]) {
      if (!isGold(p)) continue;
      const to = sec(p.openTime), tc = isOpen ? null : sec(p.closeTime);
      const ro = to ? recAt(to, c15, params, log) : null, rc = tc ? recAt(tc, c15, params, log) : null;
      rows.push({
        id: p.id, isOpen, isBuy: p.isBuy, pnl: p.pnl, amount: p.amount, leverage: p.leverage, openTime: p.openTime, closeTime: p.closeTime,
        openRate: p.openRate, units: p.units || (p.amount && p.leverage && p.openRate ? p.amount * p.leverage / p.openRate : null), to, tc,
        minutes: to && tc ? Math.round((tc - to) / 60) : null,
        recOpen: ro && ro.action, stageOpen: ro && ro.stage, source: ro && ro.source, recClose: rc && rc.action,
        group: ro ? relation(p.isBuy, ro.action) : 'sin',
        // Al cerrar: ¿la app seguía a favor de tu posición, o ya había cambiado?
        closeRel: rc ? relation(p.isBuy, rc.action) : null,
      });
    }
    const done = rows.filter((r) => !r.isOpen);
    const groups = Object.fromEntries(Object.keys(GROUPS).map((g) => [g, stats(done.filter((r) => r.group === g))]));
    const all = stats(done);
    const cycles = pyramids(rows, c15);
    return { rows, groups, all, cycles, cycleStats: cycleStats(cycles), suggestions: suggestCycles(cycles).concat(suggest(done, groups, all)), otherClosed: closed.filter((p) => !isGold(p)).length };
  }

  // Pirámides: posiciones del mismo lado que se abren mientras otra del grupo sigue abierta cuentan como una sola operación.
  function pyramids(rows, c15) {
    const list = rows.filter((r) => r.to).sort((a, b) => a.to - b.to), out = [];
    let cur = null;
    for (const r of list) {
      const live = cur && cur.isBuy === r.isBuy && cur.legs.some((x) => x.tc == null || x.tc > r.to);
      if (!live) { cur = { isBuy: r.isBuy, legs: [] }; out.push(cur); }
      cur.legs.push(r);
    }
    const now = Date.now() / 1000;
    return out.map((c) => {
      const L = c.legs, start = L[0].to, isOpen = L.some((x) => x.tc == null);
      const end = isOpen ? now : Math.max(...L.map((x) => x.tc));
      // Peor pérdida latente: con el mínimo (o máximo, si vendes) de cada vela de 15 min, sumando las posiciones abiertas en ese momento.
      let worst = null, maxMargin = 0;
      for (const k of c15) {
        if (k.time + 900 <= start || k.time >= end) continue;
        const px = c.isBuy ? k.low : k.high;
        let pl = 0, margin = 0, any = false;
        for (const x of L) {
          if (x.to > k.time + 900 || (x.tc != null && x.tc <= k.time) || !x.units || !x.openRate) continue;
          pl += (c.isBuy ? 1 : -1) * x.units * (px - x.openRate); margin += x.amount || 0; any = true;
        }
        if (any && (worst == null || pl < worst)) worst = pl;
        if (margin > maxMargin) maxMargin = margin;
      }
      if (!maxMargin) maxMargin = L.reduce((a, x) => a + (x.amount || 0), 0);
      const gaps = L.slice(1).map((x, i) => (x.to - L[i].to) / 60);
      return {
        isBuy: c.isBuy, isOpen, steps: L.length, start: L[0].openTime, end: isOpen ? null : new Date(end * 1000).toISOString(),
        minutes: Math.round((end - start) / 60), pnl: L.reduce((a, x) => a + (x.pnl || 0), 0), margin: L.reduce((a, x) => a + (x.amount || 0), 0), maxMargin,
        worst: worst == null ? null : Math.min(0, worst), stepGapMin: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
        recStart: L[0].recOpen || null, group: L[0].group, legs: L.map((x) => x.id),
      };
    });
  }

  function cycleStats(cycles) {
    const done = cycles.filter((c) => !c.isOpen), st = stats(done);
    const w = done.map((c) => c.worst).filter((x) => x != null);
    return { ...st, maxSteps: Math.max(0, ...cycles.map((c) => c.steps)), avgSteps: cycles.length ? cycles.reduce((a, c) => a + c.steps, 0) / cycles.length : null,
      maxMargin: Math.max(0, ...cycles.map((c) => c.maxMargin)), worst: w.length ? Math.min(...w) : null };
  }

  function suggestCycles(cycles) {
    const out = [], done = cycles.filter((c) => !c.isOpen);
    if (!cycles.length) return out;
    const st = cycleStats(cycles), wins = done.filter((c) => c.pnl > 0);
    const avgWin = wins.length ? wins.reduce((a, c) => a + c.pnl, 0) / wins.length : null;
    if (st.worst != null && avgWin) {
      const k = Math.abs(st.worst) / avgWin;
      if (k >= 3) out.push(`Tu peor pérdida latente en una pirámide fue de ${n2(-st.worst)} $, lo mismo que ${Math.round(k)} cierres ganadores medios (${n2(avgWin)} $). Pon un stop de pérdida total por pirámide.`);
    }
    if (st.maxSteps > 5) out.push(`Tu pirámide más larga tuvo ${st.maxSteps} escalones y llegó a ${n2(st.maxMargin)} $ de margen. Limítala a 4 o 5 escalones.`);
    const gaps = cycles.map((c) => c.stepGapMin).filter((x) => x != null);
    if (gaps.length >= 2) {
      const g = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      if (g < 120) out.push(`De media añades un escalón cada ${Math.round(g)} min: es el ruido normal del oro. Separa los escalones por precio (por ejemplo, 20-25 $ de caída) en lugar de por el % de la posición.`);
    }
    const lost = done.filter((c) => c.pnl < 0);
    if (lost.length) out.push(`${lost.length} de ${done.length} pirámides cerraron en pérdidas, con ${usd(lost.reduce((a, c) => a + c.pnl, 0))} en total.`);
    const contra = done.filter((c) => c.group === 'contra');
    if (contra.length >= 2) out.push(`${contra.length} pirámides empezaron con Cortés en contra (${usd(contra.reduce((a, c) => a + c.pnl, 0))}). No empieces una pirámide de compra con la app en VENDER.`);
    return out;
  }

  const n2 = (x) => x.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd = (x) => (x >= 0 ? '+' : '') + n2(x) + ' $';
  function suggest(done, g, all) {
    const out = [];
    if (!done.length) return ['Todavía no hay operaciones de oro cerradas en el periodo para evaluar.'];
    if (done.length < 20) out.push(`Solo hay ${done.length} operaciones de oro cerradas: las conclusiones son orientativas hasta tener al menos 20 o 30.`);
    const f = g.favor, c = g.contra, e = g.esperar;
    if (f.n && c.n) {
      if (f.avg > c.avg) out.push(`A tus operaciones a favor de la recomendación les va mejor (${usd(f.avg)} de media frente a ${usd(c.avg)} en contra). Evita ir contra la señal.`);
      else out.push(`A tus operaciones en contra de la recomendación les va mejor (${usd(c.avg)} frente a ${usd(f.avg)}): la señal de dirección no te está aportando ventaja, conviene revisar sus ajustes.`);
    } else if (c.n && c.total < 0) out.push(`Has abierto ${c.n} operaciones en contra de la recomendación, con ${usd(c.total)} en total.`);
    if (e.n >= 3 && e.total < 0) out.push(`Con la app en ESPERAR perdiste ${n2(-e.total)} $ en ${e.n} operaciones. Esperar a COMPRAR o VENDER filtraría esas entradas.`);
    if (f.n >= 3 && f.total < 0) out.push(`Incluso siguiendo la recomendación el resultado es negativo (${usd(f.total)}): la señal sola no basta; prueba la exigencia más alta o el optimizador.`);
    const late = done.filter((r) => r.group === 'favor' && /avanzada/.test(r.stageOpen || ''));
    if (late.length >= 3 && stats(late).avg < (f.avg || 0)) out.push(`Las entradas con la tendencia ya "avanzada" rinden peor (${usd(stats(late).avg)} de media). Entra cuando la señal está recién empezada o en curso.`);
    const W = done.filter((r) => r.pnl > 0 && r.minutes != null), L = done.filter((r) => r.pnl < 0 && r.minutes != null);
    if (W.length >= 3 && L.length >= 3) {
      const mw = stats(W).avgMinutes, ml = stats(L).avgMinutes;
      if (ml > mw * 1.5) out.push(`Mantienes las perdedoras más tiempo que las ganadoras (${Math.round(ml)} min frente a ${Math.round(mw)} min). Un stop loss fijo ayudaría a cortar pérdidas antes.`);
      const aw = stats(W).avg, al = -stats(L).avg;
      if (al > aw * 1.5) out.push(`La pérdida media (${n2(al)} $) es mucho mayor que la ganancia media (${n2(aw)} $). Ajusta el stop loss o el take profit para equilibrarlas.`);
    }
    const heldAgainst = done.filter((r) => r.closeRel === 'contra');
    if (heldAgainst.length >= 3 && stats(heldAgainst).total < 0) out.push(`En ${heldAgainst.length} operaciones la recomendación ya iba en contra cuando cerraste (${usd(stats(heldAgainst).total)}). Cerrar cuando la señal se da la vuelta podría reducir pérdidas.`);
    if (all.profitFactor != null && all.profitFactor < 1) out.push(`En conjunto, lo que pierdes supera a lo que ganas (factor de beneficio ${n2(all.profitFactor)}). Reduce el tamaño o el apalancamiento mientras ajustas la estrategia.`);
    if (out.length === (done.length < 20 ? 1 : 0)) out.push('No hay un patrón claro de mejora todavía. Sigue operando con tamaños pequeños y revisa de nuevo con más operaciones.');
    return out;
  }

  root.GoldReview = { analyze, recAt, isGold, GROUPS };
})(typeof window !== 'undefined' ? window : globalThis);

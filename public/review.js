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

  function analyze({ open = [], closed = [], c15 = [], params = {}, log = null }) {
    const rows = [];
    for (const [p, isOpen] of [...closed.map((p) => [p, false]), ...open.map((p) => [p, true])]) {
      if (!isGold(p)) continue;
      const to = sec(p.openTime), tc = isOpen ? null : sec(p.closeTime);
      const ro = to ? recAt(to, c15, params, log) : null, rc = tc ? recAt(tc, c15, params, log) : null;
      rows.push({
        id: p.id, isOpen, isBuy: p.isBuy, pnl: p.pnl, amount: p.amount, leverage: p.leverage, openTime: p.openTime, closeTime: p.closeTime,
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
    return { rows, groups, all, suggestions: suggest(done, groups, all), otherClosed: closed.filter((p) => !isGold(p)).length };
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

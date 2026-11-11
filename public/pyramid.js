// Pirámide de posiciones de oro: calcula su estado a partir de tus posiciones abiertas en eToro y decide qué avisos tocan.
// Lógica pura (sin red ni almacenamiento), la usa el Worker en cada comprobación.
//   modo "contra": añades un escalón cada `step` $ que el precio va en tu contra (promediar).
//   modo "favor":  añades un escalón cada `step` $ que el precio va a tu favor.
(function (root) {
  const DEFAULTS = { mode: 'contra', step: 20, maxSteps: 5, maxLoss: 0, tpPct: 5 };

  const f2 = (x) => (x == null || !isFinite(x) ? '—' : x.toFixed(2));
  const usd = (x) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2) + ' $';

  // positions: posiciones abiertas de oro (propias, no copiadas) con { id, isBuy, openRate, units, amount, openTime }.
  function state(positions, price, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const valid = (positions || []).filter((p) => p && p.id != null && p.openRate > 0 && p.units > 0);
    if (!valid.length) return null;
    // Si conviven compras y ventas, manda el lado con más dinero invertido.
    const money = (b) => valid.filter((p) => p.isBuy === b).reduce((a, p) => a + (p.amount || p.units * p.openRate), 0);
    const isBuy = money(true) >= money(false);
    const legs = valid.filter((p) => p.isBuy === isBuy).sort((a, b) => Date.parse(a.openTime || 0) - Date.parse(b.openTime || 0));
    const dir = isBuy ? 1 : -1;
    const units = legs.reduce((a, p) => a + p.units, 0);
    const avg = legs.reduce((a, p) => a + p.units * p.openRate, 0) / units;
    const rates = legs.map((p) => p.openRate);
    // Escalón más alejado en la dirección en que se añade: en "contra" el más bajo si compras; en "favor", el más alto.
    const ext = (o.mode === 'favor') === isBuy ? Math.max(...rates) : Math.min(...rates);
    const nextLevel = o.mode === 'favor' ? ext + dir * o.step : ext - dir * o.step;
    // Stop: en "favor", un escalón por detrás del último.
    // En "contra", un escalón más allá del último permitido (con 5 escalones de 20 $, 100 $ por debajo del primero si compras);
    // si además hay pérdida máxima (maxLoss > 0), el precio en que la pirámide entera pierde eso, el que llegue antes.
    let stopLevel;
    if (o.mode === 'favor') stopLevel = ext - dir * o.step;
    else {
      const first = isBuy ? Math.max(...rates) : Math.min(...rates);
      stopLevel = first - dir * o.step * o.maxSteps;
      if (o.maxLoss > 0) { const byLoss = avg - dir * o.maxLoss / units; stopLevel = isBuy ? Math.max(stopLevel, byLoss) : Math.min(stopLevel, byLoss); }
    }
    const pnl = isFinite(price) ? dir * units * (price - avg) : null;
    // TP común: el precio en que la pirámide entera gana tpPct % de lo invertido (sin contar comisiones ni el diferencial).
    // Poniendo ese mismo TP en todas las posiciones, se cierran a la vez con esa ganancia total.
    const invested = legs.reduce((a, p) => a + (p.amount || 0), 0);
    const tpProfit = invested * o.tpPct / 100;
    const tpLevel = invested > 0 && o.tpPct > 0 ? avg + dir * tpProfit / units : null;
    return {
      isBuy, side: isBuy ? 'COMPRA' : 'VENTA', steps: legs.length, ids: legs.map((p) => String(p.id)).sort(),
      units, avg, ext, nextLevel, stopLevel, pnl, invested, tpLevel, tpProfit, tpPct: o.tpPct,
      lastRate: legs[legs.length - 1].openRate, mode: o.mode, maxSteps: o.maxSteps, maxLoss: o.maxLoss, step: o.step,
      atr: o.atr || null, stepAtr: o.stepAtr || 0,
      // Precios de todos los escalones del plan, contados desde el primero.
      plan: (() => {
        const fav = o.mode === 'favor', base = fav === isBuy ? Math.min(...rates) : Math.max(...rates), sgn = fav ? dir : -dir;
        return Array.from({ length: o.maxSteps }, (_, k) => base + sgn * o.step * k);
      })(),
    };
  }

  // prev: lo guardado en la comprobación anterior (o null). cur: state() de ahora (o null). action: recomendación actual.
  // range: { lo, hi } mínimo y máximo del precio desde la comprobación anterior, para no perder un toque breve entre comprobaciones.
  // Devuelve { alerts: [{ title, message, tags, priority }], memo } con memo = lo que hay que guardar para la próxima vez.
  function decide(prev, cur, price, action, opts = {}, range = null) {
    const o = { ...DEFAULTS, ...opts };
    const alerts = [];
    if (!cur) {
      if (prev && prev.ids && prev.ids.length) {
        alerts.push({ title: `Cortés: pirámide de ${prev.side} cerrada`, priority: 3, tags: ['checkered_flag'],
          message: `Has cerrado ${prev.ids.length > 1 ? `los ${prev.ids.length} escalones` : 'el escalón'} (precio medio ${f2(prev.avg)} $, oro ahora a ${f2(price)} $).\nVuelven los avisos normales de COMPRAR, VENDER y ESPERAR.` });
      }
      return { alerts, memo: null };
    }
    const dir = cur.isBuy ? 1 : -1;
    const against = action === (cur.isBuy ? 'VENDER' : 'COMPRAR');
    const summary = `Precio medio ${f2(cur.avg)} $ · ${cur.steps} ${cur.steps > 1 ? 'escalones' : 'escalón'} · resultado ${cur.pnl == null ? '—' : usd(cur.pnl)}.\n` +
      (cur.steps >= cur.maxSteps ? `Ya tienes el máximo de ${cur.maxSteps} escalones.` : `Próximo escalón a ${f2(cur.nextLevel)} $.`) +
      ` Stop de la pirámide a ${f2(cur.stopLevel)} $` + (cur.pnl == null ? '.' : ` (resultado allí ≈ ${usd(dir * cur.units * (cur.stopLevel - cur.avg))}).`) +
      (cur.tpLevel ? `\nTP para +${cur.tpPct} % de lo invertido (${usd(cur.tpProfit)}): ${f2(cur.tpLevel)} $ en todas las posiciones.` : '');
    const sameSet = prev && prev.ids && prev.ids.join() === cur.ids.join() && prev.isBuy === cur.isBuy;
    // Memoria de avisos ya enviados; se reinicia cada vez que cambian los escalones.
    // La tendencia en contra se recuerda aunque cambien los escalones, para no repetir el aviso.
    let m = sameSet ? { ...prev.flags } : { trend: !!(prev && prev.isBuy === cur.isBuy && prev.flags && prev.flags.trend) };
    if (!prev || !prev.ids || !prev.ids.length || prev.isBuy !== cur.isBuy) {
      const sep = cur.stepAtr && cur.atr ? `ATR de 1 h ahora: ${f2(cur.atr)} $ → escalones cada ${f2(cur.step)} $ (${cur.stepAtr} ATR), fijos hasta cerrar la pirámide.\n` : `Escalones cada ${f2(cur.step)} $.\n`;
      const plan = `Plan: ${cur.plan.map((x, k) => `${k + 1}) ${f2(x)}`).join(' · ')} · stop ${f2(cur.stopLevel)} $.\n`;
      alerts.push({ title: `Cortés: pirámide de ${cur.side} abierta`, priority: 3, tags: ['triangular_flag_on_post'],
        message: `Escalón 1 a ${f2(cur.lastRate)} $.\n${sep}${plan}A partir de ahora no te aviso de cada vuelta a ESPERAR: solo de escalones, stop y tendencia en contra.\n${summary}` });
    } else if (!sameSet) {
      const added = cur.ids.filter((id) => !prev.ids.includes(id)).length;
      const removed = prev.ids.filter((id) => !cur.ids.includes(id)).length;
      if (added && !removed) {
        alerts.push({ title: `Cortés: escalón ${cur.steps} añadido`, priority: 2, tags: ['heavy_plus_sign'], message: `Abierto a ${f2(cur.lastRate)} $.\n${summary}` });
      } else if (removed && !added) {
        alerts.push({ title: removed > 1 ? `Cortés: cerrados ${removed} escalones` : 'Cortés: cerrado 1 escalón', priority: 2, tags: ['heavy_minus_sign'], message: `Quedan ${cur.steps}.\n${summary}` });
      } else {
        alerts.push({ title: 'Cortés: tu pirámide ha cambiado', priority: 2, tags: ['arrows_counterclockwise'], message: summary });
      }
    }
    if (isFinite(price)) {
      const lo = range && isFinite(range.lo) ? Math.min(range.lo, price) : price;
      const hi = range && isFinite(range.hi) ? Math.max(range.hi, price) : price;
      const worst = cur.isBuy ? lo : hi, best = cur.isBuy ? hi : lo; // lo más en contra y lo más a favor desde la última comprobación
      // 1) Stop de la pirámide.
      const hitStop = dir * (worst - cur.stopLevel) <= 0;
      if (hitStop && !m.stop) {
        alerts.push({ title: `Cortés: STOP de la pirámide de ${cur.side}`, priority: 5, tags: ['rotating_light'],
          message: `El oro ha llegado a ${f2(worst)} $ (stop en ${f2(cur.stopLevel)} $; ahora ${f2(price)} $). Resultado ahora ${usd(cur.pnl)}.\n` +
            (cur.mode === 'contra' ? `El precio ha pasado el último escalón de tu plan (${cur.maxSteps} de ${cur.step} $). Cierra la pirámide antes de que la pérdida crezca más.` : 'El precio ha deshecho el último escalón: es momento de cerrar.') });
        m.stop = true;
      }
      // 2) Siguiente escalón.
      const touch = cur.mode === 'favor' ? best : worst;
      const reached = !hitStop && (cur.mode === 'favor' ? dir * (touch - cur.nextLevel) >= 0 : dir * (touch - cur.nextLevel) <= 0);
      if (reached && !m.next) {
        if (cur.steps >= cur.maxSteps) {
          alerts.push({ title: `Cortés: límite de ${cur.maxSteps} escalones`, priority: 4, tags: ['no_entry'],
            message: `El oro ha llegado a ${f2(touch)} $ (ahora ${f2(price)} $), donde tocaría el escalón ${cur.steps + 1}, pero ya tienes el máximo. No añadas más.\n${summary}` });
        } else {
          const warn = against ? `\nOjo: Cortés está en ${action}, con 15 min y 1 h en tu contra.` + (cur.mode === 'contra' ? ' Añadir ahora es promediar contra la tendencia; mejor esperar.' : ' Mejor no añadir.') : '';
          alerts.push({ title: `Cortés: nivel del escalón ${cur.steps + 1}`, priority: against ? 3 : 4, tags: ['ladder'],
            message: `El oro ha llegado a ${f2(touch)} $ (nivel ${f2(cur.nextLevel)} $; ahora ${f2(price)} $). Si sigues el plan, añade otro escalón.${warn}\n${summary}` });
        }
        m.next = true;
      }
      // 2b) Objetivo de ganancia (TP común) alcanzado.
      if (cur.tpLevel && dir * (best - cur.tpLevel) >= 0 && !m.tp) {
        alerts.push({ title: `Cortés: objetivo +${cur.tpPct} % alcanzado`, priority: 4, tags: ['moneybag'],
          message: `El oro ha llegado a ${f2(best)} $ (TP en ${f2(cur.tpLevel)} $; ahora ${f2(price)} $). Resultado ahora ${usd(cur.pnl)}.\nSi no tenías el TP puesto en eToro, es el momento de cerrar.` });
        m.tp = true;
      }
      // 3) En "contra": vuelta al precio medio tras haber estado medio escalón por debajo.
      if (cur.mode === 'contra') {
        if (dir * (worst - cur.avg) <= -cur.step / 2) m.down = true;
        if (m.down && dir * (best - cur.avg) >= 0) {
          alerts.push({ title: 'Cortés: la pirámide vuelve a precio medio', priority: 4, tags: ['white_check_mark'],
            message: `El oro está a ${f2(price)} $, por ${cur.isBuy ? 'encima' : 'debajo'} de tu precio medio (${f2(cur.avg)} $). Resultado ${usd(cur.pnl)}.\nBuen momento para cerrar o asegurar la pirámide.` });
          m.down = false;
        }
      }
    }
    // 4) Tendencia en contra confirmada (la recomendación contraria ya exige 30 min seguidos y la tendencia de 1 h).
    if (against && !m.trend) {
      alerts.push({ title: `Cortés: tendencia en contra de tu ${cur.side}`, priority: 4, tags: ['warning'],
        message: `Cortés ha pasado a ${action} (15 min y 1 h en tu contra).\n` + (cur.mode === 'contra' ? 'No añadas escalones mientras dure; vigila el stop.' : 'Valora cerrar o subir el stop.') + `\n${summary}` });
      m.trend = true;
    } else if (!against && m.trend) m.trend = false;
    // Si el precio se aleja del nivel ya avisado, se puede volver a avisar al regresar.
    if (m.next && isFinite(price) && Math.abs(price - cur.nextLevel) > cur.step / 2) m.next = false;
    if (m.stop && isFinite(price) && dir * (price - cur.stopLevel) > cur.step / 2) m.stop = false;
    return { alerts, memo: { ids: cur.ids, isBuy: cur.isBuy, side: cur.side, avg: cur.avg, step: cur.step, atr: cur.atr, flags: m } };
  }

  root.GoldPyr = { DEFAULTS, state, decide };
})(typeof window !== 'undefined' ? window : globalThis);

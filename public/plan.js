// Estrategia "señal": comprar con la recomendación, SL fijo y sin TP; cerrar cuando Cortés pase a VENDER.
// Es la que mejor salió en la prueba de ene 2023 a nov 2026 (solo compras, x10, SL al 5 % de lo invertido).
// Lógica pura (sin red ni almacenamiento): la usan el Worker para los avisos y la app para la tarjeta de posiciones.
(function (root) {
  const DEFAULTS = { amount: 750, leverage: 10, slPct: 5 };

  const f2 = (x) => (x == null || !isFinite(x) ? '—' : x.toFixed(2));

  // Precio del SL para una compra a `entry`: pierde slPct % de lo invertido, es decir slPct / apalancamiento % del precio.
  function stopFor(entry, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    return { level: entry * (1 - o.slPct / 100 / o.leverage), loss: o.amount * o.slPct / 100 };
  }

  // Aviso que toca cuando la recomendación cambia de `prev` a `action` (o null si no toca ninguno).
  // hasBuy: si tienes alguna compra de oro abierta (null si no se sabe).
  function alertFor(prev, action, price, reason, opts = {}, hasBuy = null) {
    const o = { ...DEFAULTS, ...opts };
    if (action === prev) return null;
    if (action === 'COMPRAR') {
      const s = stopFor(price, o);
      return {
        title: 'Cortés: COMPRAR oro', priority: 4, tags: ['chart_with_upwards_trend'],
        message: `Precio ${f2(price)} $. ${reason}.\n` +
          `Plan: compra ${f2(o.amount)} $ a x${o.leverage} con SL en ${f2(s.level)} $ (−${f2(s.loss)} $, un ${o.slPct} % de lo invertido) y sin TP. ` +
          'Mantenla aunque Cortés vuelva a ESPERAR; ciérrala cuando pase a VENDER.\n' +
          'Si entras a otro precio, el SL va un ' + f2(o.slPct / o.leverage) + ' % por debajo de tu entrada. No es asesoramiento financiero.',
      };
    }
    if (action === 'VENDER') {
      if (hasBuy === false) {
        return { title: 'Cortés: VENDER oro', priority: 2, tags: ['chart_with_downwards_trend'],
          message: `Precio ${f2(price)} $. No tienes compras de oro abiertas: no hay nada que cerrar. No abras ventas (en la prueba perdían).` };
      }
      return {
        title: 'Cortés: VENDER · cierra tus compras de oro', priority: 5, tags: ['checkered_flag'],
        message: `Precio ${f2(price)} $. ${reason}.\n${hasBuy ? 'Tienes una compra de oro abierta: ciérrala ahora.' : 'Si tienes una compra de oro abierta, ciérrala ahora.'} ` +
          'No abras ventas (en la prueba perdían).',
      };
    }
    // Vuelta a ESPERAR: no se avisa, la compra se mantiene hasta VENDER o el SL.
    return null;
  }

  root.GoldPlan = { DEFAULTS, stopFor, alertFor };
})(typeof window !== 'undefined' ? window : globalThis);

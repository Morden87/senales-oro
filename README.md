# Cortés · el oro en dos pasos

Web app (PWA) para Android que lee las velas de 1 h del oro (instrumento GOLD) desde la API pública de eToro y responde, en orden, a tres preguntas: **¿viene un movimiento fuerte?**, **¿ha empezado?** y **¿hacia dónde?** Solo da **COMPRA** o **VENTA** cuando coinciden las tres.

> No es asesoramiento financiero. La app solo avisa y anota en papel; nunca opera.

## Qué hace

El planteamiento sale de un estudio con velas de 1 h de XAU/USD de dic 2021 a oct 2026 (Dukascopy). Las medidas se ajustaron con 2022-24 y se comprobaron con 2025-26. Los scripts están en la carpeta del proyecto `impulso-oro/cero/`.

1. **¿Viene movimiento?** Calcula la probabilidad de que el oro se aleje más de un 0,8 % en las 6 h siguientes. Usa pesos fijos sobre ocho medidas: la volatilidad (ATR de 1 h y de 5 días, en % del precio), la actividad típica de la hora que empieza, si hay una noticia NFP o de la Fed (en las próximas 2 h o en las 3 últimas), el rango de la última vela, si la vela es muy estrecha (NR7) y la anchura de las bandas de Bollinger. Niveles: *Tranquilo*, *Atento* y *Movimiento probable*. Este último es el 20 % de horas más altas de las semanas anteriores. Con ese aviso, un movimiento fuerte fue unas 2,5 veces más probable (en 2025-26, el 58 % frente al 21 % y el 78 % frente al 42 %; AUC 0,74).
2. **¿Ha empezado?** Una vela de 1 h cierra por encima del máximo o por debajo del mínimo de las 20 anteriores, o es una vela de más de 1,2 ATR. Solo cuenta con el paso 1 en *Movimiento probable*.
3. **¿Hacia dónde?** La tendencia diaria: el cierre diario frente a su EMA 20, hasta el día anterior. De 19 medidas de dirección probadas, fue la única que aguantó casi todos los años. Seguir la dirección de la propia ruptura perdía.

Con los tres pasos (unas 5 señales por semana, salida a las 6 h, 0,5 $ de diferencial), la ganancia media por operación fue de −0,05, +0,16, +0,21, +0,18 y −0,16 ATR en 2022, 2023, 2024, 2025 y 2026. Es una ventaja pequeña y sin demostrar: depende del tipo de mercado y falla en los giros bruscos. Por eso la app la **sigue en papel** antes de que arriesgues dinero.

- Junto a cada señal muestra la entrada, la hora de cierre (6 h) y un stop orientativo de 2 ATR. En el estudio, un stop de 2-3 ATR apenas cambiaba el resultado; sirve para limitar una mala racha.
- **Seguimiento en papel** (en el servidor): cada señal entra en la apertura de la vela siguiente y se cierra con el cierre de la 6.ª vela, con 0,5 $ de diferencial. Mientras hay una abierta no se abre otra. Al lado se anota la misma ruptura sin el paso 1, para comparar. Regla: tras unas 60 señales (unos 3 meses), si la media no supera +0,1 ATR por operación, se retira. `GET /api/sistema` devuelve el último cálculo y el papel.
- Calendario: el NFP se calcula solo (primer viernes del mes, 14:30 en España). Las fechas de la Fed (de federalreserve.gov; las de 2027 son provisionales) están en `public/sistema.js`. Para añadir más, usa la variable `FED_DATES` con fechas `AAAA-MM-DD` separadas por comas. La inflación (IPC) no se incluye.
- Toda la lógica está en `public/sistema.js`, sin red. La usan el Worker y la app, así que los dos calculan lo mismo. Se comprobó que da exactamente las mismas 1.336 señales que el estudio en Python.

## Claves de eToro

eToro → Ajustes → Trading → API Key Management → Create New Key. Elige entorno **Real** (o Demo) y permiso **Read** (solo lectura). Obtendrás una *Public API Key* y una *User Key*.

## Mis posiciones de eToro

La tarjeta **Mis posiciones en eToro** muestra tus posiciones abiertas (con el resultado sin realizar, SL y TP) y las que cerraste en los últimos 30 días. El Worker las lee con las mismas claves (`GET /api/v1/trading/info/real/pnl` y `/api/v1/trading/info/trade/history`) y las sirve en `GET /api/portfolio?days=30`, que pide la cabecera `x-admin-pin` porque son datos privados. En la app basta con escribir el PIN en Ajustes.

- La clave debe ser de entorno **Real** y permiso **Read**. Si tu clave es de la cuenta demo, añade la variable `ETORO_ACCOUNT = "demo"`.
- Es solo lectura: la app no puede abrir, cerrar ni modificar posiciones.

## Tus operaciones de oro frente a Cortés

La tarjeta compara cada operación de oro (abierta o cerrada en los últimos 30 días) con la recomendación de la app al abrirla y al cerrarla, y las agrupa en *a favor*, *en contra*, *con la app en ESPERAR* o *sin datos*. Para cada grupo da el número de operaciones, el porcentaje de ganadoras y el resultado total y medio, y propone mejoras (evitar ir contra la señal, no entrar en ESPERAR, no entrar con la tendencia avanzada, cortar antes las pérdidas…). El botón *Copiar resumen* copia los datos en texto para analizarlos con más calma.

- Desde este cambio el Worker guarda cada cambio de recomendación en KV (`recLog`, `GET /api/recs`), con la hora y el precio. Para operaciones anteriores al registro, la recomendación se recalcula con las velas de 1 min guardadas (hasta 30 días) y los ajustes actuales, y se marca como *recalculada*.
- **Pirámides**: las posiciones del mismo lado que se abren mientras otra del grupo sigue abierta cuentan como una sola operación. Para cada una: escalones, margen máximo, peor pérdida latente (estimada con los mínimos o máximos de las velas de 15 min), duración y resultado. Las sugerencias comparan la peor pérdida latente con la ganancia media, avisan de pirámides largas o con escalones muy seguidos y de las que empezaron con Cortés en contra.
- El análisis se hace en el navegador (`public/review.js`).

## Publicarla desde el móvil (Cloudflare + GitHub, gratis)

1. Sube este proyecto a un repositorio de GitHub.
2. Cloudflare → Workers & Pages → Create → Import a repository → elige el repositorio → Deploy.
3. En el Worker → Settings → Variables and Secrets añade como *Secret* `ETORO_API_KEY`, `ETORO_USER_KEY`, `NTFY_TOPIC` (el nombre de tu canal de ntfy) y `ADMIN_PIN` (un PIN para cambiar los ajustes desde la app).
4. Abre `https://senales-oro.<tu-subdominio>.workers.dev` en Chrome → ⋮ → Añadir a pantalla de inicio.

## Publicarla desde un ordenador

El Worker sirve la app y hace de intermediario con eToro, así las claves quedan en el servidor y se evita el bloqueo CORS del navegador. El proxy `/etoro/*` solo reenvía lecturas de `/api/v1/market-data/`; la cartera solo se lee en `/api/portfolio`, con PIN, y nunca se envían órdenes.

```bash
cd oro-app
npx wrangler login
npx wrangler secret put ETORO_API_KEY   # pega la Public API Key
npx wrangler secret put ETORO_USER_KEY  # pega la User Key
npx wrangler deploy
```

## Histórico de 1 min

Cada 15 min el servidor guarda las velas de 1 min en KV (una clave por día, 30 días). `GET /api/history?days=N` las devuelve. Las usa la tarjeta que compara tus operaciones con Cortés.

## Avisos por ntfy

El cron de Cloudflare va cada 5 min (`*/5 * * * *`). Una de cada tres veces (cada 15 min) el Worker guarda las velas de 1 min y revisa tu pirámide. En la primera media hora tras el cierre de cada vela de 1 h, además, calcula los tres pasos con las últimas 1.000 velas de 1 h (unas 6 semanas), actualiza el papel y avisa por ntfy de esto:

- **"Atento: movimiento probable"** al pasar a ese nivel, como mucho 2 al día, con los niveles de ruptura que vigilar.
- **"COMPRA / VENTA oro"** con el precio, la hora de cierre y el stop orientativo.
- **"Cierra la compra / venta"** a las 6 h, con el resultado en papel.
- **Víspera de noticia**: menos de 24 h antes de un NFP o de una decisión de la Fed.

Con el mercado cerrado no avisa. Funciona con el móvil apagado. En el móvil, instala la app ntfy y suscríbete al mismo tema. En ntfy.sh cualquiera que adivine el nombre del tema puede leerlo, así que elige uno difícil de adivinar.

**Si no llegan los avisos**: abre Ajustes (⚙︎) en la app. La sección *Avisos por ntfy* muestra si el servidor tiene el tema configurado, cuándo fue la última comprobación automática y si el último envío funcionó o qué respondió ntfy. El botón *Enviar aviso de prueba* (pide el PIN) manda un aviso al momento y lanza la comprobación. Lo mismo en `GET /api/status` y `POST /api/ntfy-test?run=1` (cabecera `x-admin-pin`). `NTFY_TOPIC` puede ser solo el nombre del tema o la dirección completa (`https://ntfy.sh/tu-tema`). Si ntfy falla, el cambio de estado no se da por avisado y se reintenta en la siguiente comprobación.

### Modo pirámide

Si tienes abierta alguna posición propia de oro en eToro (se lee con las mismas claves, solo lectura), el Worker la trata como una pirámide y cambia los avisos. Mientras esté abierta no manda los avisos de COMPRA, VENTA y cierre del sistema (sí los de movimiento probable y noticias), y avisa de esto:

- **Pirámide abierta, escalón añadido o cerrado, pirámide cerrada**, con precio medio, próximo escalón, stop y TP. Cada posición de oro abierta cuenta como un escalón.
- **Nivel del siguiente escalón**: el precio se ha alejado `PYR_STEP` $ (20) en tu contra desde el escalón más lejano. Si Cortés está en la dirección contraria, te lo advierte. Si ya tienes `PYR_MAX_STEPS` (5), te avisa de que no añadas más.
- **Stop de la pirámide**: un escalón más allá del último permitido (con 5 escalones de 20 $, 100 $ por debajo del primero si compras). Con `PYR_MAX_LOSS` > 0, además, el precio en que toda la pirámide pierde esa cantidad, el que llegue antes.
- **TP común**: el precio en que toda la pirámide gana `PYR_TP_PCT` % (5) de lo invertido, sin contar comisiones ni el diferencial. Poniendo ese TP en todas las posiciones de oro, se cierran juntas con esa ganancia. Sale también en la tarjeta *Mis posiciones* de la app, y hay aviso cuando el precio llega.
- **Vuelta a precio medio** después de haber estado al menos medio escalón en pérdidas.
- **Señal en contra**: el sistema da una señal de COMPRA o VENTA contraria a tu pirámide.

Los niveles se comparan con el mínimo y el máximo de las velas de 1 min desde la comprobación anterior, para no perder un toque breve. Entre las comprobaciones de 15 min, cada 5 min se revisa solo la pirámide. Al cerrarlo todo vuelven los avisos normales. Ajustes en `[vars]` de `wrangler.toml`: `PYR_MODE` (`contra` para promediar, o `favor` si añades cuando el precio va a tu favor), `PYR_STEP`, `PYR_MAX_STEPS`, `PYR_MAX_LOSS` y `PYR_TP_PCT`. El estado se ve en `GET /api/status` (`pyramid`).

Opcional: `NTFY_SERVER` (en `[vars]`, por defecto https://ntfy.sh), el secreto `NTFY_TOKEN` si tu servidor pide autenticación, `APP_URL` para abrir la app al tocar el aviso.

Abre en Chrome de Android la URL `https://senales-oro.<tu-cuenta>.workers.dev` → menú ⋮ → **Añadir a pantalla de inicio**.

## Sin servidor

También funciona como web estática (GitHub Pages, Netlify…) con las claves escritas en Ajustes del móvil, pero eToro puede bloquear las llamadas directas desde el navegador (CORS). En ese caso usa el Worker.

## Archivos

- `public/` la app: `index.html`, `app.js` (interfaz), `sistema.js` (los tres pasos, el papel y el calendario, sin red), `data.js` (eToro y Binance), `review.js` e `indicators.js` (comparación con tus operaciones; `indicators.js` solo recalcula la recomendación antigua para operaciones anteriores al registro), `sw.js`, `manifest.webmanifest`, iconos, `lwc.js` (TradingView Lightweight Charts 4.2.0, Apache-2.0).
- `public/pyramid.js` lógica de la pirámide (estado, TP y avisos, sin red).
- `worker.js`, `wrangler.toml` intermediario, avisos ntfy programados y despliegue en Cloudflare.

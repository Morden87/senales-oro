# Cortés · señales del oro a 15 min

Web app (PWA) para Android que lee el histórico del oro (instrumento GOLD) desde la API pública de eToro, calcula seis medidores técnicos y los combina en una recomendación de **COMPRAR**, **VENDER** o **ESPERAR** para los próximos 15 minutos.

> No es asesoramiento financiero. El movimiento del oro a 15 minutos es mayormente ruido; la app solo recomienda y nunca opera.

## Qué hace

Un análisis de 2 años de XAU/USD de 1 minuto (Dukascopy, contrastado con eToro) no encontró ninguna regla técnica que prediga la **dirección** a 15 min, 1 h o 4 h mejor que el azar tras el spread. Lo que sí se puede prever es el **tamaño** del movimiento, a partir de la volatilidad (ATR) y la hora. Por eso Cortés es un indicador de movimiento:

- Para 15 min, 1 h y 4 h muestra el alejamiento típico desde el precio actual, el rango esperado y la probabilidad de alejarse al menos una cantidad de referencia (5, 10 y 20 $ por defecto). Nivel BAJO (<30 %), MEDIO o ALTO (≥60 %).
- Fórmula: ATR(14) × √(barras del horizonte) × ajuste horario (actividad típica por hora UTC), calibrado con los propios datos (mediana real/previsto y dispersión logarítmica). 15 min usa velas de 1 min; 1 h y 4 h, velas de 15 min.
- **Ruptura de 1 h en papel**: cierre de 1 h por encima del máximo (o debajo del mínimo) de las 20 anteriores a favor de la tendencia diaria (cierre vs EMA 20 diaria). El servidor la anota y la cierra 4 h después, con 0,5 $ de spread. Es la única pista débil del análisis, sin confirmar.
- La dirección (seis medidores: EMA, MACD, RSI, Bollinger, Estocástico, impulso) se muestra solo como información.

## Claves de eToro

eToro → Ajustes → Trading → API Key Management → Create New Key. Elige entorno **Real** (o Demo) y permiso **Read** (solo lectura). Obtendrás una *Public API Key* y una *User Key*.

## Publicarla desde el móvil (Cloudflare + GitHub, gratis)

1. Sube este proyecto a un repositorio de GitHub.
2. Cloudflare → Workers & Pages → Create → Import a repository → elige el repositorio → Deploy.
3. En el Worker → Settings → Variables and Secrets añade como *Secret* `ETORO_API_KEY`, `ETORO_USER_KEY`, `NTFY_TOPIC` (el nombre de tu canal de ntfy) y `ADMIN_PIN` (un PIN para cambiar los ajustes desde la app).
4. Abre `https://senales-oro.<tu-subdominio>.workers.dev` en Chrome → ⋮ → Añadir a pantalla de inicio.

## Publicarla desde un ordenador

El Worker sirve la app y hace de intermediario con eToro, así las claves quedan en el servidor y se evita el bloqueo CORS del navegador. Solo reenvía lecturas de `/api/v1/market-data/`, nunca cartera ni órdenes.

```bash
cd oro-app
npx wrangler login
npx wrangler secret put ETORO_API_KEY   # pega la Public API Key
npx wrangler secret put ETORO_USER_KEY  # pega la User Key
npx wrangler deploy
```

## Estrategias, histórico y optimizador

- **Estrategia** (Ajustes): *Mixto* (votan los seis medidores), *Tendencia* (EMA, MACD e impulso deciden; RSI, Bollinger y Estocástico solo vetan extremos en contra) o *Rebote* (al revés).
- **Coincidencia mínima** entre medidores (50/60/75 %) y filtro opcional **a favor de la tendencia de 15 min** (EMA 9/21 sobre velas de 15 min ya cerradas).
- Las señales se calculan siempre con la **última vela cerrada**.
- Sin filtro de horario: se trabaja las ~23 h diarias de lunes a viernes en que cotiza el oro. Los huecos (pausa diaria, fin de semana) se excluyen de la prueba histórica.
- Cada 15 min el servidor guarda las velas de 1 min en KV (una clave por día, 30 días). `GET /api/history?days=N` las devuelve.
- **Optimizador** (botón en la app): prueba 90 combinaciones con el 70 % más antiguo del histórico y las valida con el 30 % más reciente. Solo recomienda aplicar si también mejora en esa parte no vista. Al aplicar, los ajustes se guardan en el servidor (`POST /api/params`, cabecera `x-admin-pin`) y los usan la app y los avisos.

## Avisos por ntfy

Cada 15 minutos (`*/15 * * * *`, cron de Cloudflare) el Worker descarga velas de 1 y 15 min de GOLD, calcula el movimiento esperado y avisa a ntfy cuando el nivel de la **próxima hora** pasa a ALTO (≥60 % de alejarse 10 $) y cuando deja de serlo. Con el mercado cerrado no avisa. Funciona con el móvil apagado. En el móvil instala la app ntfy y suscríbete al mismo tema. En ntfy.sh cualquiera que adivine el nombre del tema puede leerlo, así que elige uno difícil de adivinar.

Solo se recomienda COMPRAR o VENDER si el recorrido probable en 15 min (ATR × √15) es de al menos `MIN_MOVE` dólares (5 por defecto, también ajustable en Ajustes de la app); el objetivo se fija a esa distancia como mínimo.

Opcional: `NTFY_SERVER` (en `[vars]`, por defecto https://ntfy.sh), el secreto `NTFY_TOKEN` si tu servidor pide autenticación, `APP_URL` para abrir la app al tocar el aviso y `THRESHOLD` para la exigencia (0.22 por defecto).

Abre en Chrome de Android la URL `https://senales-oro.<tu-cuenta>.workers.dev` → menú ⋮ → **Añadir a pantalla de inicio**.

## Sin servidor

También funciona como web estática (GitHub Pages, Netlify…) con las claves escritas en Ajustes del móvil, pero eToro puede bloquear las llamadas directas desde el navegador (CORS). En ese caso usa el Worker.

## Archivos

- `public/` la app: `index.html`, `app.js` (interfaz), `indicators.js` (indicadores y señales), `data.js` (eToro y Binance), `sw.js`, `manifest.webmanifest`, iconos, `lwc.js` (TradingView Lightweight Charts 4.2.0, Apache-2.0).
- `worker.js`, `wrangler.toml` intermediario, avisos ntfy programados y despliegue en Cloudflare.

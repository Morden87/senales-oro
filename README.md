# Cortés · señales del oro a 15 min

Web app (PWA) para Android que lee el histórico del oro (instrumento GOLD) desde la API pública de eToro, calcula seis medidores técnicos y los combina en una recomendación de **COMPRAR**, **VENDER** o **ESPERAR** para los próximos 15 minutos.

> No es asesoramiento financiero. El movimiento del oro a 15 minutos es mayormente ruido; la app solo recomienda y nunca opera.

## Qué hace

- Velas de 1 o 5 minutos (500 velas) de `GET /api/v1/market-data/instruments/{id}/history/candles/asc/{intervalo}/500` y precio bid/ask en vivo de `/market-data/instruments/rates`. Se actualiza cada 30 s (el límite de eToro es 120 peticiones/min).
- Busca el id de GOLD con `/market-data/search?internalSymbolFull=GOLD`; si falla usa 18.
- Medidores y peso en la votación:
  | Medidor | Peso | Lógica |
  |---|---|---|
  | Tendencia EMA 9/21/50 | 1.5 | separación EMA9–EMA21 en ATRs + alineación de las tres |
  | MACD 12/26/9 | 1.25 | nivel y pendiente del histograma |
  | RSI 14 | 1 | >70 / <30 reversión; zona media sigue el impulso |
  | Bollinger 20/2 | 1 | %B fuera de bandas = reversión |
  | Estocástico 14/3 | 0.75 | cruces %K/%D en extremos |
  | Impulso 5 velas | 0.75 | cambio de precio medido en ATRs |
- Señal: media ponderada de votos en [-1, 1]. COMPRAR/VENDER si supera la exigencia (0.15 / 0.22 / 0.30) **y** al menos la mitad de los medidores coincide; ESPERAR si no, o si la volatilidad es demasiado baja.
- Stop y objetivo orientativos: 1.0 y 1.2 × ATR × √(velas en 15 min).
- Prueba histórica sobre las velas cargadas: porcentaje de señales en las que el precio fue en esa dirección 15 min después (ventanas sin solapar, sin spread).
- Notificación opcional cuando cambia la recomendación (con la app abierta).
- Fuente demo sin claves: PAXG/USDT de Binance (token respaldado por oro, sigue al XAU/USD).

## Claves de eToro

eToro → Ajustes → Trading → API Key Management → Create New Key. Elige entorno **Real** (o Demo) y permiso **Read** (solo lectura). Obtendrás una *Public API Key* y una *User Key*.

## Publicarla desde el móvil (Cloudflare + GitHub, gratis)

1. Sube este proyecto a un repositorio de GitHub.
2. Cloudflare → Workers & Pages → Create → Import a repository → elige el repositorio → Deploy.
3. En el Worker → Settings → Variables and Secrets añade como *Secret* `ETORO_API_KEY`, `ETORO_USER_KEY` y `NTFY_TOPIC` (el nombre de tu canal de ntfy).
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

## Avisos por ntfy

Cada 15 minutos (`*/15 * * * *`, cron de Cloudflare) el Worker descarga las velas de 1 min de GOLD, calcula la recomendación con el mismo motor que la app y envía un aviso a ntfy cuando:

- la recomendación es **COMPRAR** o **VENDER** (se repite cada 15 min mientras se mantenga), o
- pasa de COMPRAR o VENDER a **ESPERAR**.

Con ESPERAR seguido no avisa, y tampoco con el mercado cerrado (última vela de hace más de 20 min). Funciona con el móvil apagado. En el móvil instala la app ntfy y suscríbete al mismo tema. En ntfy.sh cualquiera que adivine el nombre del tema puede leerlo, así que elige uno difícil de adivinar.

Solo se recomienda COMPRAR o VENDER si el recorrido probable en 15 min (ATR × √15) es de al menos `MIN_MOVE` dólares (5 por defecto, también ajustable en Ajustes de la app); el objetivo se fija a esa distancia como mínimo.

Opcional: `NTFY_SERVER` (en `[vars]`, por defecto https://ntfy.sh), el secreto `NTFY_TOKEN` si tu servidor pide autenticación, `APP_URL` para abrir la app al tocar el aviso y `THRESHOLD` para la exigencia (0.22 por defecto).

Abre en Chrome de Android la URL `https://senales-oro.<tu-cuenta>.workers.dev` → menú ⋮ → **Añadir a pantalla de inicio**.

## Sin servidor

También funciona como web estática (GitHub Pages, Netlify…) con las claves escritas en Ajustes del móvil, pero eToro puede bloquear las llamadas directas desde el navegador (CORS). En ese caso usa el Worker.

## Archivos

- `public/` la app: `index.html`, `app.js` (interfaz), `indicators.js` (indicadores y señales), `data.js` (eToro y Binance), `sw.js`, `manifest.webmanifest`, iconos, `lwc.js` (TradingView Lightweight Charts 4.2.0, Apache-2.0).
- `worker.js`, `wrangler.toml` intermediario, avisos ntfy programados y despliegue en Cloudflare.

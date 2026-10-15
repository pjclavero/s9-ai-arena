# Aceptación visual del visor/panel (R-DEPLOY · R3)

Prueba de aceptación **visual** mínima con Playwright: carga del visor, ausencia
de errores JS, conexión WebSocket, render inicial (canvas de Phaser),
panel/spectator si existe, y un screenshot como evidencia.

No forma parte de `npm test` (Vitest) ni bloquea despliegues: requiere un
navegador. Vive en `acceptance/visual/` (config + spec).

## Dependencia

Playwright NO está en `package.json` (dependencia pesada con navegador; se evita
churn del lockfile en un entorno sin red). Se instala bajo demanda en la máquina
que ejecute la prueba:

```bash
npm i -D @playwright/test          # o: npx --yes playwright ...
npx playwright install chromium    # descarga el navegador
```

## Modo CI / headless local

Contra un stack levantado localmente (web en :3000):

```bash
S9_VISUAL_BASE_URL=http://localhost:3000 \
  npx playwright test -c acceptance/visual/playwright.config.ts
```

Evidencia: `acceptance/visual/evidence/visor.png` y, si algo falla,
`acceptance/visual/playwright-report/`.

## Modo validación manual VM108

Contra el dominio/IP reales (recuerda R6: **s9arena**, no arena):

```bash
S9_VISUAL_BASE_URL=https://s9arena.seccionnueve.duckdns.org \
  npx playwright test -c acceptance/visual/playwright.config.ts
# o por IP LAN detrás de VM104:
S9_VISUAL_BASE_URL=http://192.168.1.208:8080 \
  npx playwright test -c acceptance/visual/playwright.config.ts
```

## Estado en este entorno

**NO EJECUTADA** en VM102: no hay navegador. La suite y su runbook quedan listos;
la ejecución es un paso de operador (o de la CI con un runner que tenga navegador)
en un entorno con el visor servido.

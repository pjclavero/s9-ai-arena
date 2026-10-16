/**
 * FC-D · E2E de navegador REAL (Chromium 130 de la imagen oficial
 * mcr.microsoft.com/playwright:v1.48.2-jammy, fijada por digest en run.sh).
 *
 * NO se ejecuta a mano con `npx playwright test`: lo lanza tests/browser/run.sh,
 * que levanta el entorno aislado (API+PG embebido, worker, replay-service, web,
 * gateway real y TLS delante) y pasa por entorno:
 *   S9_E2E_BASE       https://127.0.0.1:<tls>  (origen del navegador)
 *   S9_E2E_OUT        directorio de capturas/informe (fuera del repo)
 *   S9_E2E_REPLAY_ID  batalla con replay sembrado
 *   S9_E2E_DEV_EMAIL / S9_E2E_DEV_PASSWORD  usuario semilla de la BD efímera
 */
import { defineConfig, devices } from "@playwright/test";

const out = process.env.S9_E2E_OUT ?? "/out";

export default defineConfig({
  testDir: "./specs",
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: `${out}/test-results`,
  reporter: [["list"], ["json", { outputFile: `${out}/report.json` }]],
  use: {
    baseURL: process.env.S9_E2E_BASE,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }],
});

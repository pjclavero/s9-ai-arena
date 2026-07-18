/**
 * R-DEPLOY · R3 — configuración de la prueba de aceptación VISUAL del visor.
 *
 * NO forma parte de `npm test` (Vitest): es una suite Playwright aparte que
 * requiere un navegador. Dos modos, por variable de entorno:
 *
 *   CI / headless local:  S9_VISUAL_BASE_URL=http://localhost:3000  (por defecto)
 *   Manual VM108:         S9_VISUAL_BASE_URL=https://s9arena.seccionnueve.duckdns.org
 *
 * Ejecutar (en una máquina CON navegador):
 *   npx playwright install chromium
 *   npx playwright test -c acceptance/visual/playwright.config.ts
 *
 * En VM102 NO se ejecuta (sin navegador): ver docs/ops/acceptance-visual.md.
 */
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.S9_VISUAL_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL,
    // Evidencia: captura y traza solo cuando algo falla, más el screenshot que
    // la propia prueba guarda siempre.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

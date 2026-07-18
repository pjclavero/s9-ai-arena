/**
 * R3.3 · ERR-VIS-11 — Configuración Playwright de la prueba de RENDIMIENTO.
 *
 * NO se ejecuta en el entorno de desarrollo (ia-server VM102): no hay navegador,
 * ni docker, ni sudo. Esta configuración y el test asociado están escritos para
 * la CI real (runner con navegadores instalados). El pipeline arranca el visor
 * (o usa la URL desplegada) y corre `playwright test` con este config.
 *
 * Uso en CI:
 *   PERF_BASE_URL=http://localhost:5173 npx playwright test -c tests/perf/playwright.config.ts
 */
import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.PERF_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.perf\.spec\.ts/,
  // El rendimiento no se mide en paralelo (compiten por GPU/CPU) ni con reintentos
  // (un fallo de fps es una señal, no un flake que enmascarar).
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [["list"], ["json", { outputFile: "tests/perf/.results/perf.json" }]],
  use: {
    baseURL: BASE_URL,
    headless: true,
    // Chromium con WebGL real: sin esto el visor cae a canvas y la medida de
    // draw calls (que instrumenta el contexto WebGL) no aplica.
    launchOptions: {
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

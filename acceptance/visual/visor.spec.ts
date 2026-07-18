/**
 * R-DEPLOY · R3 — aceptación VISUAL mínima del visor/panel.
 *
 * Comprueba, sobre S9_VISUAL_BASE_URL: (1) el visor carga, (2) sin errores JS en
 * consola, (3) se abre al menos un WebSocket, (4) hay render inicial (canvas de
 * Phaser), (5) el panel/spectator, si existe, es accesible. Deja un screenshot
 * como evidencia. NO bloquea despliegues: es una suite aparte de la CI unitaria.
 */
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const EVIDENCE_DIR = "acceptance/visual/evidence";

test.beforeAll(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
});

test("el visor carga sin errores JS, conecta por WebSocket y renderiza", async ({ page }) => {
  const jsErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") jsErrors.push(msg.text());
  });
  page.on("pageerror", (err) => jsErrors.push(String(err)));

  // (3) Registrar apertura de WebSocket antes de navegar.
  let wsOpened = false;
  page.on("websocket", () => {
    wsOpened = true;
  });

  // (1) Carga del visor.
  const resp = await page.goto("/", { waitUntil: "networkidle" });
  expect(resp?.ok(), "el visor debe responder 2xx/3xx").toBeTruthy();

  // (4) Render inicial: Phaser dibuja en un <canvas>.
  const canvas = page.locator("canvas");
  await expect(canvas.first()).toBeVisible({ timeout: 15_000 });

  // (3) Conexión WebSocket (el visor se suscribe al canal de espectador).
  await expect.poll(() => wsOpened, { timeout: 15_000, message: "el visor debe abrir un WebSocket" }).toBe(true);

  // (5) Panel/spectator si existe (no falla si la ruta no está publicada).
  const panel = page.locator('[data-testid="panel"], nav, header').first();
  if ((await panel.count()) > 0) {
    await expect(panel).toBeVisible();
  }

  // Evidencia siempre.
  await page.screenshot({ path: `${EVIDENCE_DIR}/visor.png`, fullPage: true });

  // (2) Sin errores JS.
  expect(jsErrors, `errores JS en consola:\n${jsErrors.join("\n")}`).toHaveLength(0);
});

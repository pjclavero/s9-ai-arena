/**
 * FC-D (D3/D5/D6, TD-009/TD-014) · Replay en navegador real, detrás de TLS:
 * listar → abrir → cargar → inicializar canvas (Phaser real) → avanzar ticks → fin.
 *
 * Mutación obligatoria (SPEC D9): romper la espera de READY de Phaser
 * (waitForViewerScene → getScene directo) ⇒ esta spec se pone ROJA.
 */
import { test, expect } from "@playwright/test";
import { REPLAY_ID, go, registerNewUser, shot, watchProblems } from "./helpers.js";

test.describe("@fase1 Replays", () => {
  test.beforeEach(() => {
    expect(REPLAY_ID, "run.sh debe sembrar un replay (S9_E2E_REPLAY_ID)").not.toBe("");
  });

  test("GET /replays (sin barra) bajo TLS no redirige a http:// (TD-014)", async ({ page }) => {
    const res = await page.request.get("/replays", { maxRedirects: 0 });
    expect(res.status(), `Location=${res.headers()["location"]}`).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });

  test("#/replays lista el replay sin contenido mixto y abre el reproductor", async ({ page }, info) => {
    const problems = watchProblems(page);
    await registerNewUser(page);
    await go(page, "#/replays");
    const row = page.locator(`[data-testid="replay-row"][data-battle-id="${REPLAY_ID}"]`);
    await expect(row).toBeVisible();
    await shot(page, info, "replay-lista");
    await row.getByTestId("replay-open").click();
    await expect(page.getByTestId("replay-status")).toHaveAttribute("data-state", /playing|finished/);
    expect(problems).toEqual([]);
  });

  test("reproductor: canvas real, ticks que avanzan, pausa y fin", async ({ page }, info) => {
    const problems = watchProblems(page);
    await page.goto(`/#/replay/${encodeURIComponent(REPLAY_ID)}?t=0`); // ruta pública, sin cuenta
    const status = page.getByTestId("replay-status");
    await expect(status).toHaveAttribute("data-state", "playing", { timeout: 20_000 });

    const canvas = page.getByTestId("replay-canvas-host").locator("canvas");
    await expect(canvas).toHaveCount(1);
    const box = await canvas.boundingBox();
    expect(box && box.width > 100 && box.height > 100).toBe(true);

    const tickEl = page.getByTestId("replay-tick");
    const total = Number(await tickEl.getAttribute("data-total"));
    expect(total).toBeGreaterThan(0);
    // El tick AVANZA (antes: «tick 0 / N» inmóvil con el lienzo vacío).
    await expect
      .poll(async () => Number(await tickEl.getAttribute("data-tick")), { timeout: 10_000 })
      .toBeGreaterThan(30);
    const a = await canvas.screenshot();
    await page.waitForTimeout(700);
    const b = await canvas.screenshot();
    // El lienzo se repinta: dos fotogramas distintos ⇒ hay render real.
    expect(Buffer.compare(a, b)).not.toBe(0);
    await shot(page, info, "replay-reproduciendo");

    await page.getByRole("button", { name: "Pausa" }).click();
    await expect(status).toHaveAttribute("data-state", "paused");
    const paused = Number(await tickEl.getAttribute("data-tick"));
    await page.waitForTimeout(800);
    expect(Number(await tickEl.getAttribute("data-tick"))).toBe(paused);

    await page.getByRole("button", { name: "8×" }).click();
    await page.getByRole("button", { name: "Reproducir" }).click();
    await expect(status).toHaveAttribute("data-state", "finished", { timeout: 30_000 });
    await expect(status).toHaveText("fin del replay");
    await shot(page, info, "replay-fin");
    expect(problems).toEqual([]);
  });

  test("un replay inexistente dice que no existe (404), sin canvas ni reintentos inútiles", async ({ page }, info) => {
    await page.goto("/#/replay/no-existe-fcd?t=0");
    const status = page.getByTestId("replay-status");
    await expect(status).toHaveAttribute("data-state", "error");
    await expect(status).toHaveAttribute("data-error-kind", "notFound");
    await shot(page, info, "replay-404");
  });
});

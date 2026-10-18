/**
 * FC-D (D3/D5/D6, TD-009/TD-014) · Replay en navegador real, detrás de TLS:
 * listar → abrir → cargar → inicializar canvas (Phaser real) → avanzar ticks → fin.
 *
 * Mutación obligatoria (SPEC D9): romper la espera de READY de Phaser
 * (waitForViewerScene → getScene directo) ⇒ esta spec se pone ROJA.
 * PRC (TD-004): re-exponer `location /replays/` con proxy_pass al replay-service
 * ⇒ la primera spec se pone ROJA (200 con el índice del replay privado).
 */
import { test, expect, type Page } from "@playwright/test";
import { REPLAY_ID, go, login, shot, watchProblems } from "./helpers.js";

/**
 * PRC (TD-004) · El replay del golden es de bots PRIVADOS: sólo lo leen sus
 * participantes y el staff. Aquí se entra como el usuario semilla `organizer`
 * (staff) por la UI real; el anónimo y el ajeno reciben 404.
 */
async function loginStaff(page: Page) {
  await login(page, process.env.S9_E2E_DEV_EMAIL ?? "", process.env.S9_E2E_DEV_PASSWORD ?? "");
}

test.describe("@fase1 Replays", () => {
  test.beforeEach(() => {
    expect(REPLAY_ID, "run.sh debe sembrar un replay (S9_E2E_REPLAY_ID)").not.toBe("");
  });

  test("TD-004 · /replays* del gateway ya no sirve replays: 404 sin redirección a http:// (TD-014)", async ({
    page,
  }) => {
    for (const path of ["/replays", "/replays/", `/replays/${REPLAY_ID}/index`, `/replays/${REPLAY_ID}/segment`]) {
      const res = await page.request.get(path, { maxRedirects: 0 });
      expect(res.status(), `${path} Location=${res.headers()["location"]}`).toBe(404);
      expect(res.headers()["location"], path).toBeUndefined();
      expect(await res.text(), path).not.toMatch(/keyframes|snapshots|battleId/);
    }
  });

  test("TD-004 · anónimo: la API no entrega el replay privado (404) y el reproductor dice «no existe»", async ({
    page,
  }, info) => {
    for (const path of [
      `/api/v1/replays/${REPLAY_ID}/index`,
      `/api/v1/replays/${REPLAY_ID}/segment?fromTick=0&toTick=60`,
    ]) {
      const res = await page.request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
    }
    await page.goto(`/#/replay/${encodeURIComponent(REPLAY_ID)}?t=0`);
    const status = page.getByTestId("replay-status");
    await expect(status).toHaveAttribute("data-state", "error");
    await expect(status).toHaveAttribute("data-error-kind", "notFound");
    await expect(page.getByTestId("replay-canvas-host").locator("canvas")).toHaveCount(0);
    await shot(page, info, "replay-anonimo-404");
  });

  test("#/replays lista el replay sin contenido mixto y abre el reproductor", async ({ page }, info) => {
    const problems = watchProblems(page);
    await loginStaff(page);
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
    await loginStaff(page);
    // Carga directa de la ruta (F5): el reproductor espera a recuperar la sesión.
    await page.goto(`/#/replay/${encodeURIComponent(REPLAY_ID)}?t=0`);
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

/**
 * FC-D (D2, TD-022) · Fallos REALES de servicios (sin mocks): run.sh para de
 * verdad el proceso correspondiente antes de cada fase.
 *  - @fase2: replay-service parado ⇒ los replays SIGUEN (van por la API, TD-004).
 *  - @fase3: API parada ⇒ /api/v1 responde 502 en el arranque (F5) y en el reproductor.
 */
import { test, expect } from "@playwright/test";
import { REPLAY_ID, go, shot } from "./helpers.js";

test.describe("@fase2 replay-service caído", () => {
  // PRC (TD-004) · el replay-service ya NO está en el camino de lectura del
  // navegador (los replays van por la API autorizada, que lee el volumen). Con el
  // proceso PARADO de verdad, listado y reproductor siguen funcionando; antes esta
  // fase esperaba un 502 del gateway, que ya no existe en /replays (404 siempre).
  test("#/replays y el reproductor SIGUEN funcionando con el replay-service parado", async ({ page }, info) => {
    const email = process.env.S9_E2E_DEV_EMAIL ?? "";
    const password = process.env.S9_E2E_DEV_PASSWORD ?? "";
    await page.goto("/");
    await page.getByLabel("email").fill(email);
    await page.getByLabel("contraseña").fill(password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByTestId("logout")).toBeVisible();
    await go(page, "#/replays");
    const row = page.locator(`[data-testid="replay-row"][data-battle-id="${REPLAY_ID}"]`);
    await expect(row).toBeVisible();
    await row.getByTestId("replay-open").click();
    await expect(page.getByTestId("replay-status")).toHaveAttribute("data-state", /playing|finished/, {
      timeout: 20_000,
    });
    await shot(page, info, "degradado-replay-service-parado");
  });
});

test.describe("@fase3 API caída", () => {
  test("F5 con la API caída NO manda al login: «No se puede contactar» con Reintentar", async ({ page }, info) => {
    // UX-E (C-G13) · el arranque sólo pregunta por la sesión si el navegador ya
    // la tuvo (marca `s9_session_hint`, la deja el login): éste es el F5 de un
    // usuario CON sesión. Un visitante anónimo ve el login (sin POST /auth/refresh).
    await page.addInitScript(() => window.localStorage.setItem("s9_session_hint", "1"));
    await page.goto("/");
    const box = page.getByTestId("boot-error");
    await expect(box).toBeVisible();
    await expect(box).toContainText("502");
    await expect(page.getByLabel("email")).toHaveCount(0);
    await shot(page, info, "degradado-api-caida");
  });

  // PRC (TD-004) · el reproductor depende ahora de la API: con la API parada,
  // 502 real del gateway ⇒ error «no disponible» con Reintentar (antes en @fase2).
  test("reproductor: 502 real de la API ⇒ error con Reintentar", async ({ page }, info) => {
    await page.goto(`/#/replay/${encodeURIComponent(REPLAY_ID)}?t=0`);
    const status = page.getByTestId("replay-status");
    await expect(status).toHaveAttribute("data-state", "error", { timeout: 20_000 });
    await expect(status).toHaveAttribute("data-error-kind", "unavailable");
    await expect(page.getByRole("button", { name: "Reintentar" })).toBeVisible();
    await shot(page, info, "degradado-reproductor-502");
  });
});

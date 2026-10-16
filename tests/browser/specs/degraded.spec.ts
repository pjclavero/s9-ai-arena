/**
 * FC-D (D2, TD-022) · Fallos REALES de servicios (sin mocks): run.sh para de
 * verdad el proceso correspondiente antes de cada fase.
 *  - @fase2: replay-service parado ⇒ el gateway real responde 502.
 *  - @fase3: API parada ⇒ /api/v1 responde 502 en el arranque (F5).
 */
import { test, expect } from "@playwright/test";
import { REPLAY_ID, go, shot } from "./helpers.js";

test.describe("@fase2 replay-service caído", () => {
  test("#/replays: 502 real ⇒ «Servicio no disponible» con Reintentar, nunca lista vacía", async ({ page }, info) => {
    // #/replays es del panel: se entra como usuario semilla (la API sigue viva en esta fase).
    const email = process.env.S9_E2E_DEV_EMAIL ?? "";
    const password = process.env.S9_E2E_DEV_PASSWORD ?? "";
    await page.goto("/");
    await page.getByLabel("email").fill(email);
    await page.getByLabel("contraseña").fill(password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByTestId("logout")).toBeVisible();
    await go(page, "#/replays");
    const alert = page.getByTestId("resource-error-los-replays");
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute("data-error-kind", "unavailable");
    await expect(alert).toContainText("502");
    await expect(alert.getByRole("button", { name: "Reintentar" })).toBeVisible();
    await expect(page.getByTestId("replays-empty")).toHaveCount(0);
    await shot(page, info, "degradado-replays-502");
  });

  test("reproductor: 502 real ⇒ error con Reintentar", async ({ page }, info) => {
    await page.goto(`/#/replay/${encodeURIComponent(REPLAY_ID)}?t=0`);
    const status = page.getByTestId("replay-status");
    await expect(status).toHaveAttribute("data-state", "error");
    await expect(status).toHaveAttribute("data-error-kind", "unavailable");
    await expect(page.getByRole("button", { name: "Reintentar" })).toBeVisible();
    await shot(page, info, "degradado-reproductor-502");
  });
});

test.describe("@fase3 API caída", () => {
  test("F5 con la API caída NO manda al login: «No se puede contactar» con Reintentar", async ({ page }, info) => {
    await page.goto("/");
    const box = page.getByTestId("boot-error");
    await expect(box).toBeVisible();
    await expect(box).toContainText("502");
    await expect(page.getByLabel("email")).toHaveCount(0);
    await shot(page, info, "degradado-api-caida");
  });
});

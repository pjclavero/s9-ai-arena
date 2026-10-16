/**
 * FC-D (D3/D4) · Visor en directo en navegador real: Phaser arranca (READY real),
 * pide el ticket a la API real y, si la batalla no se puede ver, lo DICE y para
 * (antes: «conectando…» eterno sin pedir siquiera el ticket).
 *
 * La parte ticket→WebSocket→worker con batalla viva depende de que exista una
 * batalla ejecutándose (carriles A/B); el contrato de verificación del ticket
 * en la cadena real lo prueba la sonda de run.sh (TD-028: 4404 vs 4401).
 */
import { test, expect } from "@playwright/test";
import { REPLAY_ID, registerNewUser, shot, watchProblems } from "./helpers.js";

test.describe("@fase1 Visor", () => {
  test("con sesión: pide UN ticket, la API dice 404 y el visor lo explica con enlace al replay", async ({ page }, info) => {
    const problems = watchProblems(page);
    await registerNewUser(page);
    let tickets = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/spectate-ticket")) tickets++;
    });
    await page.evaluate((id) => (window.location.hash = `#/viewer/${id}`), REPLAY_ID || "sin-id");
    const status = page.getByTestId("viewer-status");
    await expect(status).toHaveAttribute("data-state", "rejected", { timeout: 20_000 });
    await expect(status).toContainText("no existe");
    await expect(page.getByTestId("viewer-replay-link")).toBeVisible();
    await page.waitForTimeout(3000);
    expect(tickets).toBe(1); // sin bucle de reconexión ante un rechazo definitivo
    await shot(page, info, "viewer-rechazo-404");
    expect(problems.filter((p) => !p.startsWith("console.error"))).toEqual([]);
  });

  test("anónimo con el espectador público apagado: rechazo explicado, no «conectando…»", async ({ page }, info) => {
    await page.goto(`/#/viewer/${encodeURIComponent(REPLAY_ID || "sin-id")}`);
    const status = page.getByTestId("viewer-status");
    await expect(status).toHaveAttribute("data-state", "rejected", { timeout: 20_000 });
    await shot(page, info, "viewer-anonimo");
  });
});

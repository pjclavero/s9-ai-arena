/**
 * [REVIEW] borradores de sesión (UX-R, apps/web/src/ui/draft.ts) · el código que una
 * cuenta escribe en el editor NO debe aparecer a OTRA cuenta que inicie sesión
 * después en la misma pestaña (ordenador compartido). «Salir» es explícito: lo
 * escrito no debe sobrevivir al cambio de usuario.
 */
import { test, expect } from "@playwright/test";
import { go, registerNewUser, shot } from "./helpers.js";
import { evidence } from "./review-lib.js";

test.describe("@fase1 [REVIEW] aislamiento de borradores entre cuentas", () => {
  test("lo que A dejó en el editor no se le enseña a B tras «Salir» y entrar como B", async ({ page }, info) => {
    test.setTimeout(180_000);
    const marker = `SECRETO-DE-A-${Date.now().toString(36)}`;
    await registerNewUser(page);
    await go(page, "#/bots");
    await page.getByLabel("nuevo-bot").fill(`rv-draft-a-${Date.now().toString(36)}`);
    await page.getByRole("button", { name: "Crear bot" }).click();
    await page.getByRole("button", { name: /^rv-draft-a-/ }).click();
    await page.getByLabel("codigo").fill(`# ${marker}\nfrom arena_sdk import ArenaBot\n`);
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("logout")).toHaveCount(0);

    await registerNewUser(page); // B, en la MISMA pestaña
    await go(page, "#/bots");
    await page.getByLabel("nuevo-bot").fill(`rv-draft-b-${Date.now().toString(36)}`);
    await page.getByRole("button", { name: "Crear bot" }).click();
    await page.getByRole("button", { name: /^rv-draft-b-/ }).click();
    const seen = await page.getByLabel("codigo").inputValue();
    const restored = await page.getByTestId("code-draft-restored").count();
    evidence("draft-isolation", { leaked: seen.includes(marker), restoredBanner: restored, head: seen.slice(0, 120) });
    await shot(page, info, "review-draft-b");
    expect(seen, "el editor de B contiene el borrador de A").not.toContain(marker);
  });
});

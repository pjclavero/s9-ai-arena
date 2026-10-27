/**
 * UX-C · UX-03 · Una versión publicada ANTIGUA sigue siendo elegible aunque la
 * última esté RECHAZADA.
 *
 * Builds REALES (fase golden: bot-build-worker → sandbox): v1 correcta → validada →
 * publicada; v2 con un error de sintaxis → rechazada. En «Nueva batalla» el bot sigue
 * apareciendo, juega la v1 y la página dice que la última (v2) está rechazada. La
 * API acepta esa v1 (published) — la misma regla que aplica el selector.
 */
import { test, expect } from "@playwright/test";
import { go, registerNewUser, shot, watchProblems } from "./helpers.js";

const GOOD = `from arena_sdk import ArenaBot


class Quieto(ArenaBot):
    def on_observation(self, observation):
        return {"move": {"throttle": 0.0, "steer": 0.0}}
`;
// Error de sintaxis: el build lo rechaza sin ejecutar nada.
const BROKEN = `from arena_sdk import ArenaBot


class Roto(ArenaBot):
    def on_observation(self, observation:
        return {}
`;

test.describe("@golden UX-C versión publicada antigua", () => {
  test("v1 publicada + v2 rechazada ⇒ el bot sigue siendo elegible con la v1", async ({ page }, info) => {
    test.setTimeout(600_000);
    const problems = watchProblems(page);
    await registerNewUser(page);
    const name = `uxc-veterano-${Date.now().toString(36)}`;

    await go(page, "#/bots");
    await page.getByLabel("nuevo-bot").fill(name);
    await page.getByRole("button", { name: "Crear bot" }).click();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByLabel("chasis").selectOption("chassis.medium@1");
    await page.getByLabel("slot-drive").selectOption("movement.wheels@1");
    await page.getByLabel("slot-power").selectOption("power.battery@1");
    await page.getByTestId("save-loadout").click();
    await expect(page.getByTestId("saved")).toBeVisible();

    // v1: correcta → build real → publicada
    await page.getByLabel("codigo").fill(GOOD);
    await page.getByRole("button", { name: "Subir como versión nueva" }).click();
    await page.getByRole("button", { name: "Enviar a validación v1" }).click();
    await expect(page.getByTestId("version-row-1")).toContainText("validated", { timeout: 240_000 });
    await page.getByRole("button", { name: "Publicar v1" }).click();
    await expect(page.getByTestId("version-row-1")).toContainText("published");

    // v2: rota → build real → rechazada
    await page.getByLabel("codigo").fill(BROKEN);
    await page.getByRole("button", { name: "Subir como versión nueva" }).click();
    await page.getByRole("button", { name: "Enviar a validación v2" }).click();
    await expect(page.getByTestId("version-row-2")).toContainText("rejected", { timeout: 240_000 });

    await go(page, "#/battles/new");
    const label = `${name} (v1) · última versión: v2 rechazada`;
    const opt = page.getByLabel("bot rojo").locator("option", { hasText: name });
    await expect(opt).toHaveText(label);
    await expect(opt).toBeEnabled();
    await page.getByLabel("bot rojo").selectOption({ label });
    await expect(page.getByLabel("versión rojo")).toHaveValue("1");
    await expect(page.getByTestId("bot-status-rojo")).toContainText("juega la v1 (publicada)");
    await expect(page.getByTestId("battle-checklist")).toContainText(`✓ Bando rojo: ${name} v1`);
    await expect(page.getByTestId("ineligible-bots")).toHaveCount(0);
    await shot(page, info, "uxc-version-antigua-elegible");
    expect(problems).toEqual([]);
  });
});

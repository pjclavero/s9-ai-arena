/**
 * UX-C · UX-03 · El selector de batalla EXPLICA por qué un bot no puede jugar.
 *
 * Antes: un bot sin versión publicada desaparecía del desplegable y la página sólo
 * decía «Elige dos bots con versión publicada». Ahora, contra la API real (fase 1,
 * sin builds): un bot con una v1 subida pero sin enviar aparece DESHABILITADO con
 * el motivo y el siguiente paso, la lista ✓/✗ dice qué falta, y la página distingue
 * BOT de VERSIÓN DE BOT y BANDO de EQUIPO.
 */
import { test, expect } from "@playwright/test";
import { go, registerNewUser, shot, watchProblems } from "./helpers.js";

const CODE = `from arena_sdk import ArenaBot


class Quieto(ArenaBot):
    def on_observation(self, observation):
        return {"move": {"throttle": 0.0, "steer": 0.0}}
`;

test.describe("@fase1 UX-C selector de batalla", () => {
  test("un bot con v1 sin publicar sale deshabilitado con el motivo y qué hacer", async ({ page }, info) => {
    const problems = watchProblems(page);
    await registerNewUser(page);
    const name = `uxc-novato-${Date.now().toString(36)}`;

    await go(page, "#/bots");
    await page.getByLabel("nuevo-bot").fill(name);
    await page.getByRole("button", { name: "Crear bot" }).click();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByLabel("chasis").selectOption("chassis.medium@1");
    await page.getByLabel("slot-drive").selectOption("movement.wheels@1");
    await page.getByLabel("slot-power").selectOption("power.battery@1");
    await page.getByTestId("save-loadout").click();
    await expect(page.getByTestId("saved")).toBeVisible();
    await page.getByLabel("codigo").fill(CODE);
    await page.getByRole("button", { name: "Subir como versión nueva" }).click();
    await expect(page.getByTestId("version-row-1")).toBeVisible();

    await go(page, "#/battles/new");
    const why = page.getByTestId("ineligible-bots");
    await expect(why).toContainText(name);
    await expect(why).toContainText("ninguna versión publicada");
    await expect(why).toContainText("tienes v1");
    await expect(why.getByRole("link", { name })).toHaveAttribute("href", /#\/bots\//);
    const opt = page.getByLabel("bot rojo").locator("option", { hasText: name });
    await expect(opt).toBeDisabled();
    await expect(page.getByTestId("battle-checklist")).toContainText("✗ Bando rojo: elige un bot");
    await expect(page.getByTestId("battle-concepts")).toContainText("versión de bot");
    await expect(page.getByTestId("battle-concepts")).toContainText("no es un equipo de la sección Equipos");
    await expect(page.getByText("Elige dos bots con versión publicada")).toHaveCount(0);
    await shot(page, info, "uxc-selector-bot-no-elegible");
    expect(problems).toEqual([]);
  });
});

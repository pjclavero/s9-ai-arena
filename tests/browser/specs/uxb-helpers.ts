/**
 * UX-B · utillaje de las specs de bots/código/build/versionado. Todo por la UI
 * real contra el entorno de run.sh (build REAL en el sandbox), sin mocks.
 */
import { expect, type Page } from "@playwright/test";
import { go } from "./helpers.js";

/** Un build real (cola → bot-build-worker → contenedor) tarda; esto es su techo. */
export const BUILD_TIMEOUT_MS = 240_000;

export const PY_STILL = `from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observation(self, observation):
        return {}
`;

/** Crea el bot por la UI (queda abierto) y guarda un loadout legal con arma y radar. */
export async function newBotWithLoadout(page: Page, name: string): Promise<void> {
  await go(page, "#/bots");
  await page.getByLabel("nuevo-bot").fill(name);
  await page.getByRole("button", { name: "Crear bot" }).click();
  // #255 · el bot recién creado queda abierto en «Equipamiento»; su nombre es un ENLACE.
  await page.getByRole("link", { name, exact: true }).click();
  await page.getByLabel("chasis").selectOption("chassis.medium@1");
  await page.getByLabel("slot-drive").selectOption("movement.wheels@1");
  await page.getByLabel("slot-power").selectOption("power.battery@1");
  await page.getByLabel("slot-sensor_a").selectOption("sensor.radar@1");
  await page.getByLabel("slot-turret_main").selectOption("weapon.cannon@1");
  await page.getByTestId("save-loadout").click();
  await expect(page.getByTestId("saved")).toBeVisible();
}

/** Sube el código que haya en el editor como versión nueva y la envía a validación. */
export async function uploadAndSubmit(page: Page, version: number, code?: string): Promise<void> {
  await openBotSection(page, "codigo");
  if (code !== undefined) await page.getByLabel("codigo").fill(code);
  await page.getByRole("button", { name: "Subir como versión nueva" }).click();
  // #255 · subir lleva solo a «Versiones y build», donde está «Enviar a validación».
  await expect(page.getByTestId("bot-section")).toHaveAttribute("data-section", "versiones");
  await expect(page.getByTestId(`version-row-${version}`)).toContainText("draft");
  await page.getByRole("button", { name: `Enviar a validación v${version}` }).click();
}

/** Espera al estado terminal REAL del build de la versión (validated o rejected). */
export async function expectVersionState(page: Page, version: number, state: "validated" | "rejected") {
  await expect(page.getByTestId(`version-row-${version}`)).toContainText(state, { timeout: BUILD_TIMEOUT_MS });
}

/** #255 · abre una sección del panel del bot (cambia el contenido central, no hace scroll). */
export async function openBotSection(
  page: Page,
  section: "resumen" | "visibilidad" | "equipamiento" | "codigo" | "versiones" | "batallas" | "replays",
): Promise<void> {
  await page.getByTestId(`bot-section-link-${section}`).click();
  await expect(page.getByTestId("bot-section")).toHaveAttribute("data-section", section);
}

/** #255 · «En batallas» vive en «Resumen»: se mira allí y se vuelve a «Versiones y build». */
export async function expectInBattles(page: Page, text: string): Promise<void> {
  await openBotSection(page, "resumen");
  await expect(page.getByTestId("in-battles")).toContainText(text);
  await openBotSection(page, "versiones");
}

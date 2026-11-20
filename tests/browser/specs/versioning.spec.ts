/**
 * UX-B · B6 · versionado de extremo a extremo con builds REALES:
 *   v1 válida (publicada) → v2 inválida (rechazada; v1 SIGUE en batallas) → v3
 *   válida (publicada; pasa a ser la de batallas) → diff v2↔v3 → clonar v3 → v4
 *   borrador → historial con las cuatro y la marca de la versión en batallas.
 */
import { test, expect } from "@playwright/test";
import { go, registerNewUser, shot, watchProblems } from "./helpers.js";
import {
  PY_STILL,
  expectInBattles,
  expectVersionState,
  newBotWithLoadout,
  openBotSection,
  uploadAndSubmit,
} from "./uxb-helpers.js";

const PY_BROKEN = PY_STILL.replace("class Bot(ArenaBot):", "class Bot(ArenaBot)");
const PY_V3 = PY_STILL.replace("return {}", 'return {"move": {"throttle": 0.4, "steer": 0.1}}');

test.describe("@fase1 UX-B versionado", () => {
  test("v1 publicada / v2 rechazada / v1 sigue en batallas / v3 publicada / diff / clone / historial", async ({
    page,
  }, info) => {
    test.setTimeout(840_000);
    const problems = watchProblems(page);
    await registerNewUser(page);
    const name = `uxb-vers-${Date.now().toString(36)}`;
    await newBotWithLoadout(page, name);

    await uploadAndSubmit(page, 1, PY_STILL);
    await expectVersionState(page, 1, "validated");
    await page.getByRole("button", { name: "Publicar v1" }).click();
    await expect(page.getByTestId("version-row-1")).toContainText("published");

    await uploadAndSubmit(page, 2, PY_BROKEN);
    await expectVersionState(page, 2, "rejected");
    await expect(page.getByTestId("build-diagnosis-not-published")).toContainText(
      "v2 NO está publicada y no puede usarse en batallas. Sigue en juego la v1 publicada.",
    );
    await expect(page.getByTestId("in-battles-1")).toBeVisible();
    await expectInBattles(page, "usan la v1");

    await uploadAndSubmit(page, 3, PY_V3);
    await expectVersionState(page, 3, "validated");
    await page.getByRole("button", { name: "Publicar v3" }).click();
    await expect(page.getByTestId("version-row-3")).toContainText("published");
    await expect(page.getByTestId("in-battles-3")).toBeVisible();
    await expect(page.getByTestId("in-battles-1")).toHaveCount(0);

    // #255 · todo en el MISMO panel, por secciones: historial, diff y clonado.
    await expectInBattles(page, "usan la v3");
    for (const v of [1, 2, 3]) await expect(page.getByTestId(`version-row-${v}`)).toBeVisible();
    // #255 R1 (P3-5) · antes se comprobaba la marca de la v3 en la SEGUNDA tabla del detalle
    // (`detail-in-battles-3`); esa tabla ya no existe (una sola tabla de versiones). Se
    // comprueba la misma marca en la tabla única: sólo la v3 está en batallas.
    await expect(page.getByTestId("in-battles-3")).toBeVisible();
    for (const v of [1, 2]) await expect(page.getByTestId(`in-battles-${v}`)).toHaveCount(0);
    await openBotSection(page, "codigo");
    await page.getByLabel("version-visor").selectOption("3");
    await page.getByLabel("diff-contra").selectOption("2");
    await expect(page.getByTestId("diff-view")).toContainText("v2 → v3");
    await expect(page.getByTestId("diff-src/bot.py")).toContainText("throttle");
    await openBotSection(page, "versiones");
    await page.getByTestId("clone-3").click();
    await expect(page.getByTestId("bot-notice")).toContainText("Creada v4 (borrador) desde v3. v3 no cambia.");
    await expect(page.getByTestId("version-row-4")).toContainText("(desde v3)");
    await expect(page.getByTestId("version-row-4")).toContainText("draft");
    // El clon (borrador) no se lleva la marca: sigue en batallas la v3.
    await expect(page.getByTestId("in-battles-3")).toBeVisible();
    await expect(page.getByTestId("in-battles-4")).toHaveCount(0);
    await shot(page, info, "uxb-versionado-historial");

    await go(page, "#/bots");
    expect(problems).toEqual([]);
  });
});

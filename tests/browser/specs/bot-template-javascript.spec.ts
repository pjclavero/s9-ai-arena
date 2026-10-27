/**
 * UX-B · B3 + UX-05 · al elegir JavaScript, el editor ofrece una plantilla
 * JavaScript ESM (no TypeScript) que pasa el build REAL hasta `validated`.
 */
import { test, expect } from "@playwright/test";
import { registerNewUser, shot, watchProblems } from "./helpers.js";
import { expectVersionState, newBotWithLoadout, uploadAndSubmit } from "./uxb-helpers.js";

test.describe("@fase1 UX-B plantilla JavaScript", () => {
  test("la plantilla JavaScript del editor construye sin tocarla", async ({ page }, info) => {
    test.setTimeout(420_000);
    const problems = watchProblems(page);
    await registerNewUser(page);
    await newBotWithLoadout(page, `uxb-tpl-js-${Date.now().toString(36)}`);

    await page.getByLabel("runtime").selectOption("node");
    const area = page.getByLabel("codigo");
    await expect(area).toHaveValue(/export default class Bot extends ArenaBot/);
    await expect(area).toHaveValue(/onObservation\(observation\)/);
    await expect(area).not.toHaveValue(/: (string|number|ObservationPayload)\b/); // nada de anotaciones TS
    await expect(page.getByTestId("hook-help")).toContainText("TypeScript no se acepta");

    await uploadAndSubmit(page, 1);
    await expectVersionState(page, 1, "validated");
    await expect(page.getByTestId("version-row-1")).toContainText("node");
    await shot(page, info, "uxb-template-javascript");
    expect(problems).toEqual([]);
  });
});

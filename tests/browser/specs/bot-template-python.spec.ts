/**
 * UX-B · B3 · el editor de código NO empieza vacío: la plantilla Python se sube
 * tal cual y pasa el build REAL hasta `validated` y `published`.
 */
import { test, expect } from "@playwright/test";
import { registerNewUser, shot, watchProblems } from "./helpers.js";
import { expectVersionState, newBotWithLoadout, uploadAndSubmit } from "./uxb-helpers.js";

test.describe("@fase1 UX-B plantilla Python", () => {
  test("la plantilla Python del editor construye y se publica sin tocarla", async ({ page }, info) => {
    test.setTimeout(420_000);
    const problems = watchProblems(page);
    await registerNewUser(page);
    await newBotWithLoadout(page, `uxb-tpl-py-${Date.now().toString(36)}`);

    const area = page.getByLabel("codigo");
    await expect(area).toHaveValue(/class Bot\(ArenaBot\):/);
    await expect(area).toHaveValue(/def on_observation\(self, observation\):/);
    await expect(page.getByTestId("hook-help")).toContainText("on_observation");

    await uploadAndSubmit(page, 1);
    await expectVersionState(page, 1, "validated");
    await page.getByRole("button", { name: "Publicar v1" }).click();
    await expect(page.getByTestId("version-row-1")).toContainText("published");
    await expect(page.getByTestId("in-battles-1")).toBeVisible();
    await shot(page, info, "uxb-template-python");
    expect(problems).toEqual([]);
  });
});

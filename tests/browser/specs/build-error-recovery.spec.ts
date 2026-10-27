/**
 * UX-B · UX-02 · un build rechazado se entiende y se arregla desde la UI: fase,
 * fichero y línea destacados, «v1 NO está publicada», origen del fallo (el código
 * del usuario) y un botón que carga ese código en el editor para subir la versión
 * corregida (v2), que pasa el build REAL.
 */
import { test, expect } from "@playwright/test";
import { registerNewUser, shot, watchProblems } from "./helpers.js";
import { PY_STILL, expectVersionState, newBotWithLoadout, uploadAndSubmit } from "./uxb-helpers.js";

const PY_SYNTAX = `from arena_sdk import ArenaBot


class Bot(ArenaBot)
    def on_observation(self, observation):
        return {}
`;

test.describe("@fase1 UX-B recuperación de un error de build", () => {
  test("error de sintaxis → diagnóstico con fichero y línea → corregir → v2 validated", async ({ page }, info) => {
    test.setTimeout(420_000);
    const problems = watchProblems(page);
    await registerNewUser(page);
    await newBotWithLoadout(page, `uxb-recover-${Date.now().toString(36)}`);

    await uploadAndSubmit(page, 1, PY_SYNTAX);
    await expectVersionState(page, 1, "rejected");
    const diag = page.getByTestId("build-diagnosis");
    await expect(diag).toHaveAttribute("data-fault", "user");
    await expect(page.getByTestId("build-diagnosis-stage")).toContainText("análisis estático");
    await expect(page.getByTestId("build-diagnosis-location")).toContainText("src/bot.py, línea 4");
    await expect(page.getByTestId("build-diagnosis-not-published")).toContainText("v1 NO está publicada");
    await expect(page.getByTestId("in-battles")).toContainText("Ninguna versión publicada");
    await shot(page, info, "uxb-build-error-diagnostico");

    await page.getByTestId("build-diagnosis-fix").click();
    await expect(page.getByLabel("codigo")).toHaveValue(PY_SYNTAX);
    await expect(page.getByTestId("editing-from")).toContainText("se crea la v2; v1 no cambia");

    await uploadAndSubmit(page, 2, PY_STILL);
    await expectVersionState(page, 2, "validated");
    await expect(page.getByTestId("version-row-1")).toContainText("rejected"); // v1 sigue como estaba
    expect(problems).toEqual([]);
  });
});

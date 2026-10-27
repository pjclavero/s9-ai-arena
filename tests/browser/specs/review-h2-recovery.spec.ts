/**
 * [REVIEW] H2 + UX-04 · un usuario nuevo se equivoca, ENTIENDE el fallo en la UI y
 * lo corrige, con builds REALES:
 *   v1 error de sintaxis (línea 6) → rejected, diagnóstico con fichero, línea, causa
 *      y «v1 NO está publicada»;
 *   v2 hook mal escrito (`on_observaton`) → rejected con «¿Quisiste decir…?»;
 *   v3 bot QUIETO que implementa el hook → validated → published → elegible.
 */
import { test, expect } from "@playwright/test";
import { go, registerNewUser, shot, watchProblems } from "./helpers.js";
import { GARBAGE, createBotWithLoadout, evidence, expectState, publish, submitVersion } from "./review-lib.js";

const SYNTAX = `from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observation(self, observation):
        return {"move": {"throttle": 1.0, "steer": 0.0}
`;
const TYPO = `from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observaton(self, observation):
        return {"move": {"throttle": 1.0, "steer": 0.0}}
`;
const STILL = `from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observation(self, observation):
        return {}
`;

test.describe("@fase1 [REVIEW] H2 error → entender → corregir → publicar", () => {
  test("sintaxis y hook mal escrito se rechazan con causa y línea; el bot quieto pasa y se publica", async ({
    page,
  }, info) => {
    test.setTimeout(900_000);
    const problems = watchProblems(page);
    await registerNewUser(page);
    const name = `rv-h2-${Date.now().toString(36)}`;
    await createBotWithLoadout(page, name, {
      chassis: "chassis.medium@1",
      slots: { drive: "movement.wheels@1", power: "power.battery@1" },
    });

    await submitVersion(page, 1, SYNTAX);
    await expectState(page, 1, "rejected");
    const diag = page.getByTestId("build-diagnosis");
    await expect(diag).toHaveAttribute("data-fault", "user");
    const loc1 = await page.getByTestId("build-diagnosis-location").innerText();
    const text1 = await diag.innerText();
    await expect(page.getByTestId("build-diagnosis-not-published")).toContainText("v1 NO está publicada");
    await expect(page.getByTestId("in-battles")).toContainText("Ninguna versión publicada");
    await shot(page, info, "review-h2-sintaxis");
    expect(text1).not.toMatch(GARBAGE);
    // El usuario tiene que ver fichero y línea del error (Python señala la línea 6 o la 5).
    expect(loc1).toMatch(/src\/bot\.py, línea [56]\b/);

    await submitVersion(page, 2, TYPO);
    await expectState(page, 2, "rejected");
    await expect(diag).toContainText("no implementa on_observation");
    await expect(diag).toContainText("¿Quisiste decir «on_observaton»?");
    await expect(diag).toContainText("v2 NO está publicada");
    const text2 = await diag.innerText();
    await shot(page, info, "review-h2-hook");

    await submitVersion(page, 3, STILL);
    await expectState(page, 3, "validated");
    await expect(page.getByTestId("build-diagnosis")).toHaveCount(0);
    await publish(page, 3);

    await go(page, "#/battles/new");
    const opt = page.getByLabel("bot rojo").locator("option", { hasText: name });
    await expect(opt).toBeEnabled();
    const optText = await opt.innerText();
    evidence("h2", { loc1, text1, text2, optText });
    expect(problems).toEqual([]);
  });
});

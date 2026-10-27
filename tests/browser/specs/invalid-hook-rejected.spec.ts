/**
 * UX-B · UX-04 (G-05, P1) · falso verde: un bot con el hook mal escrito se
 * RECHAZA en el build real con un motivo que lo nombra y sugiere el correcto;
 * un bot quieto a propósito (implementa el hook y devuelve {}) se VALIDA.
 */
import { test, expect, type Page } from "@playwright/test";
import { registerNewUser, shot, watchProblems } from "./helpers.js";
import { PY_STILL, expectVersionState, newBotWithLoadout, uploadAndSubmit } from "./uxb-helpers.js";

const PY_TYPO = `from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observaton(self, observation):
        return {"move": {"throttle": 1.0, "steer": 0.0}}
`;

const JS_TYPO = `import { ArenaBot } from "@arena/sdk";

export default class Bot extends ArenaBot {
  onObservaton(observation) {
    return { move: { throttle: 1, steer: 0 } };
  }
}
`;

async function expectHookRejection(page: Page, version: number, hook: string, typo: string) {
  await expectVersionState(page, version, "rejected");
  const diag = page.getByTestId("build-diagnosis");
  await expect(diag).toHaveAttribute("data-fault", "user");
  await expect(diag).toContainText(`no implementa ${hook}`);
  await expect(diag).toContainText(`¿Quisiste decir «${typo}»?`);
  await expect(diag).toContainText(`v${version} NO está publicada`);
  await expect(page.getByTestId("build-diagnosis-stage")).toContainText("prueba de protocolo");
}

test.describe("@fase1 UX-B hook inválido", () => {
  test("on_observaton (Python) y onObservaton (JS) se rechazan; un bot quieto que implementa el hook pasa", async ({
    page,
  }, info) => {
    test.setTimeout(840_000);
    const problems = watchProblems(page);
    await registerNewUser(page);
    await newBotWithLoadout(page, `uxb-hook-${Date.now().toString(36)}`);

    await uploadAndSubmit(page, 1, PY_TYPO);
    await expectHookRejection(page, 1, "on_observation", "on_observaton");
    await shot(page, info, "uxb-hook-python-rechazado");

    await page.getByLabel("runtime").selectOption("node");
    await uploadAndSubmit(page, 2, JS_TYPO);
    await expectHookRejection(page, 2, "onObservation", "onObservaton");

    await page.getByLabel("runtime").selectOption("python");
    await uploadAndSubmit(page, 3, PY_STILL);
    await expectVersionState(page, 3, "validated");
    await expect(page.getByTestId("build-diagnosis")).toHaveCount(0);
    expect(problems).toEqual([]);
  });
});

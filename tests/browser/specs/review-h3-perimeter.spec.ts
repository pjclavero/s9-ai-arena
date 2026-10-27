/**
 * [REVIEW] H3 + perímetro + diagnóstico entre cuentas, en UNA batalla real.
 *
 *  - Cuenta A: bot JavaScript «fugitivo» (corre hacia fuera del mapa), publicado y
 *    hecho PÚBLICO (no hay control en la web: PATCH /bots/{id} de la API pública
 *    con el Bearer del dueño; se registra como hallazgo de UX).
 *  - Cuenta B: bot Python con v1 = fugitivo (published), v2 = error de sintaxis
 *    (rejected), v3 = quieto (published). En «Nueva batalla» la v1 sigue siendo
 *    elegible; B elige EXPLÍCITAMENTE la v1 contra el bot público de A.
 *  - La batalla real demuestra: juega la v1 (el vehículo de B se desplaza; la v3
 *    no se movería), ninguna posición del replay sale del mapa aunque los dos bots
 *    lo intentan, y cada dueño ve SÓLO el diagnóstico de su bot. Un tercero y un
 *    anónimo reciben 404 (la batalla tiene un bot privado).
 */
import { test, expect } from "@playwright/test";
import { go, registerNewUser, shot, watchProblems } from "./helpers.js";
import {
  PublicApi,
  createBattle,
  createBotWithLoadout,
  evidence,
  expectBattleHidden,
  expectState,
  pickBot,
  publish,
  replaySnapshots,
  submitVersion,
  waitFinished,
  waitStatsReady,
} from "./review-lib.js";

const STAMP = Date.now().toString(36);
const BOT_A = `rv-fuga-js-${STAMP}`;
const BOT_B = `rv-veterano-${STAMP}`;

const LOADOUT = {
  chassis: "chassis.medium@1",
  slots: { drive: "movement.wheels@1", power: "power.battery@1" },
};

// Cambia de objetivo lejano cada 300 ticks (O, S, E, N): empuja contra los cuatro bordes.
const PY_FUGA = `from arena_sdk import ArenaBot, angle_diff, angle_to

TARGETS = [(-2000.0, 40.0), (60.0, -2000.0), (2000.0, 40.0), (60.0, 2000.0)]


class Fuga(ArenaBot):
    def on_observation(self, observation):
        me = observation["self"]
        tx, ty = TARGETS[(observation["tick"] // 300) % 4]
        turn = angle_diff(me["heading"], angle_to(me["position"], {"x": tx, "y": ty}))
        return {"move": {"throttle": 1.0, "steer": max(-1.0, min(1.0, turn * 2.0))}}
`;

const PY_BROKEN = `from arena_sdk import ArenaBot


class Roto(ArenaBot):
    def on_observation(self, observation)
        return {}
`;

const PY_STILL = `from arena_sdk import ArenaBot


class Quieto(ArenaBot):
    def on_observation(self, observation):
        return {"move": {"throttle": 0.0, "steer": 0.0}}
`;

const JS_FUGA = `import { ArenaBot, angleDiff, angleTo } from "@arena/sdk";

const TARGETS = [
  { x: 2000, y: 40 },
  { x: 60, y: 2000 },
  { x: -2000, y: 40 },
  { x: 60, y: -2000 },
];

export default class Fuga extends ArenaBot {
  onObservation(observation) {
    const me = observation.self;
    const t = TARGETS[Math.floor(observation.tick / 300) % 4];
    const turn = angleDiff(me.heading, angleTo(me.position, t));
    return { move: { throttle: 1, steer: Math.max(-1, Math.min(1, turn * 2)) } };
  }
}
`;

test.describe("@golden [REVIEW] H3 versión antigua + perímetro + diagnóstico por dueño", () => {
  test("v1 publicada / v2 rechazada / v3 publicada → juega la v1 elegida; nadie sale del mapa; diagnóstico sólo del dueño", async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(840_000);
    const base = info.project.use.baseURL;

    // --- cuenta A: bot JS fugitivo, publicado y público ---------------------------
    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: base });
    const pageA = await ctxA.newPage();
    const credsA = await registerNewUser(pageA);
    const apiA = new PublicApi(pageA.request, credsA);
    await apiA.login();
    await createBotWithLoadout(pageA, BOT_A, LOADOUT);
    await pageA.getByLabel("runtime").selectOption("node");
    await submitVersion(pageA, 1, JS_FUGA);
    await expectState(pageA, 1, "validated");
    await publish(pageA, 1);
    const botA = ((await apiA.ok("GET", "/bots?limit=100")).items as any[]).find((b) => b.name === BOT_A);
    await apiA.ok("PATCH", `/bots/${botA.id}`, { visibility: "public" });

    // --- cuenta B: v1 fugitivo published, v2 rejected, v3 quieto published ----------
    const problems = watchProblems(page);
    const credsB = await registerNewUser(page);
    const apiB = new PublicApi(page.request, credsB);
    await apiB.login();
    await createBotWithLoadout(page, BOT_B, LOADOUT);
    await submitVersion(page, 1, PY_FUGA);
    await expectState(page, 1, "validated");
    await publish(page, 1);
    await submitVersion(page, 2, PY_BROKEN);
    await expectState(page, 2, "rejected");

    await go(page, "#/battles/new");
    const optB = page.getByLabel("bot rojo").locator("option", { hasText: BOT_B });
    await expect(optB).toHaveText(`${BOT_B} (v1) · última versión: v2 rechazada`);
    await expect(optB).toBeEnabled();
    await shot(page, info, "review-h3-v1-elegible-con-v2-rechazada");

    await go(page, "#/bots");
    await page.getByRole("button", { name: BOT_B, exact: true }).click();
    await submitVersion(page, 3, PY_STILL);
    await expectState(page, 3, "validated");
    await publish(page, 3);
    const botB = ((await apiB.ok("GET", "/bots?limit=100")).items as any[]).find((b) => b.name === BOT_B);

    // --- B crea la batalla eligiendo la v1 explícitamente -----------------------------
    await go(page, "#/battles/new");
    await pickBot(page, "rojo", BOT_B);
    const verSel = page.getByLabel("versión rojo");
    await expect(verSel).toHaveValue("3"); // por defecto, la más reciente publicada
    const offered = await verSel.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(offered.sort()).toEqual(["1", "3"]); // la v2 rechazada no se ofrece
    await verSel.selectOption("1");
    await expect(page.getByTestId("battle-checklist")).toContainText(`${BOT_B} v1`);
    const publicVisibleToB = await page.getByLabel("bot azul").locator("option", { hasText: BOT_A }).count();
    expect(publicVisibleToB, "el bot público de otra cuenta aparece en el selector").toBe(1);
    await pickBot(page, "azul", BOT_A);
    const battleId = await createBattle(page);
    await shot(page, info, "review-h3-batalla-v1-creada");

    const battle = await waitFinished(apiB, battleId);
    expect(battle.status, JSON.stringify(battle)).toBe("finished");
    const pB = battle.participants.find((p: any) => p.botId === botB.id);
    const pA = battle.participants.find((p: any) => p.botId === botA.id);
    expect(pB.version).toBe(1);
    expect(pA.version).toBe(1);

    // --- perímetro: posiciones del replay real ----------------------------------------
    const { index, snapshots } = await replaySnapshots(apiB, battleId);
    const W = index.world.widthM as number;
    const H = index.world.heightM as number;
    const vehB = (index.roster as any[]).find((r) => r.botId === botB.id).id;
    let outside = 0;
    const firstOutside: unknown[] = [];
    let minMargin = Infinity;
    let maxDispB = 0;
    let startB: { x: number; y: number } | null = null;
    for (const s of snapshots)
      for (const v of s.vehicles) {
        if (!v.position) continue;
        const { x, y } = v.position;
        if (x < 0 || x > W || y < 0 || y > H) {
          outside++;
          if (firstOutside.length < 5) firstOutside.push({ tick: s.tick, id: v.id, x, y });
        }
        minMargin = Math.min(minMargin, x, W - x, y, H - y);
        if (v.id === vehB) {
          startB ??= { x, y };
          maxDispB = Math.max(maxDispB, Math.hypot(x - startB.x, y - startB.y));
        }
      }
    const verify = await apiB.ok("POST", `/replays/${battleId}/verify`);
    evidence("h3-perimeter", {
      battleId,
      W,
      H,
      walls: index.world.walls?.length,
      snapshots: snapshots.length,
      outside,
      firstOutside,
      minMargin,
      maxDispB,
      verify,
      result: battle.result,
    });
    expect(outside, `posiciones fuera del mapa ${W}×${H}: ${JSON.stringify(firstOutside)}`).toBe(0);
    // Calibración: los fugitivos llegaron de verdad al borde (si no, la prueba no prueba nada).
    expect(minMargin, "algún vehículo llegó a < 3 m del borde").toBeLessThan(3);
    // Juega la v1 (fugitiva), no la v3 (quieta).
    expect(maxDispB, "el vehículo de B se desplazó: corrió la v1").toBeGreaterThan(20);
    expect(verify.matches, JSON.stringify(verify)).toBe(true);

    // --- diagnóstico: cada dueño ve SÓLO el suyo -------------------------------------
    const statsB = await waitStatsReady(apiB, battleId);
    expect(Object.keys(statsB.diagnostics)).toEqual([botB.id]);
    expect(JSON.stringify(statsB.perBot[botA.id] ?? {})).not.toMatch(/cpuMs|rejectionsByReason|"decisions"/);
    const detailB = await apiB.ok("GET", `/battles/${battleId}`);
    expect(detailB.participants.find((p: any) => p.botId === botA.id).cpuMs).toBeNull();
    expect(detailB.participants.find((p: any) => p.botId === botA.id).diagnosticsVisible).toBe(false);
    await go(page, `#/battles/${battleId}`);
    await expect(page.locator(`[data-testid="bot-diagnostics"][data-bot-id="${botB.id}"]`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator(`[data-testid="bot-diagnostics"][data-bot-id="${botA.id}"]`)).toHaveCount(0);
    await shot(page, info, "review-h3-diagnostico-dueño-B");

    const statsA = await apiA.ok("GET", `/battles/${battleId}/stats`);
    expect(Object.keys(statsA.diagnostics)).toEqual([botA.id]);
    await go(pageA, `#/battles/${battleId}`);
    await expect(pageA.locator(`[data-testid="bot-diagnostics"][data-bot-id="${botA.id}"]`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(pageA.locator(`[data-testid="bot-diagnostics"][data-bot-id="${botB.id}"]`)).toHaveCount(0);

    // --- tercero y anónimo: 404 en todo (hay un bot privado) -------------------------
    const ctxC = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: base });
    const pageC = await ctxC.newPage();
    const apiC = new PublicApi(pageC.request, await registerNewUser(pageC));
    await apiC.login();
    const third = await expectBattleHidden(apiC, battleId, "tercero");
    const ctxAnon = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: base });
    const anon = await expectBattleHidden(new PublicApi((await ctxAnon.newPage()).request, null), battleId, "anónimo");
    evidence("h3-access", {
      battleId,
      third,
      anon,
      diagB: statsB.diagnostics,
      diagAkeys: Object.keys(statsA.diagnostics),
    });

    await ctxA.close();
    await ctxC.close();
    await ctxAnon.close();
    expect(problems.filter((p) => !p.startsWith("console.error"))).toEqual([]);
  });
});

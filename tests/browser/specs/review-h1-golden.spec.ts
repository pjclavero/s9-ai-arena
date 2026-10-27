/**
 * [REVIEW] H1 + H4 + H5 + defectos cerrados · recorrido completo de un usuario
 * NUEVO, sólo navegador y API pública con su cuenta normal:
 *
 *   registro → bot Python (loadout medio) con la PLANTILLA tal cual → build real →
 *   published → bot JavaScript (loadout ligero) con la PLANTILLA → build → published →
 *   equipo con los dos → batalla con los DOS bots del MISMO equipo (H4: bando ≠
 *   equipo) → visor → detalle (resultado, stats, diagnóstico) → replay en la web.
 *
 * Además comprueba sobre el replay REAL: que el vehículo de cada bot es el loadout
 * guardado (chasis, ranuras, vida máxima), que ninguna posición sale del mapa, que
 * el replay se verifica con el motor, y que un AJENO y un ANÓNIMO reciben 404 en
 * todas las vistas de la batalla (TD-047) y no ven el diagnóstico. H5: recorrido
 * por pantallas registrando qué ve un usuario normal y un anónimo.
 */
import { test, expect } from "@playwright/test";
import { go, registerNewUser, shot, watchProblems } from "./helpers.js";
import {
  GARBAGE,
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
const PY = `rv-py-${STAMP}`;
const JS = `rv-js-${STAMP}`;
const TEAM = `Revisión ${STAMP}`;

const PY_LOADOUT = {
  chassis: "chassis.medium@1",
  slots: {
    drive: "movement.wheels@1",
    power: "power.battery@1",
    sensor_a: "sensor.radar@1",
    turret_main: "weapon.cannon@1",
  },
};
const JS_LOADOUT = {
  chassis: "chassis.light@1",
  slots: { drive: "movement.wheels@1", power: "power.battery@1", sensor_a: "sensor.radar@1" },
};

test.describe("@golden [REVIEW] H1 usuario nuevo de extremo a extremo", () => {
  test("H1/H4/H5: dos bots de plantilla (Py+JS) del mismo equipo → batalla real → visor → stats → replay; TD-047 y perímetro", async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(840_000);
    const problems = watchProblems(page);
    const owner = await registerNewUser(page);
    const api = new PublicApi(page.request, owner);
    await api.login();

    // --- bot Python: loadout + PLANTILLA sin tocar --------------------------------
    await createBotWithLoadout(page, PY, PY_LOADOUT);
    await expect(page.getByTestId("effect-note")).toContainText("es el vehículo que juega");
    await expect(page.getByLabel("runtime")).toHaveValue("python");
    await expect(page.getByLabel("codigo")).toHaveValue(/def on_observation\(self, observation\)/);
    await submitVersion(page, 1);
    await expectState(page, 1, "validated");
    await publish(page, 1);
    await shot(page, info, "review-h1-py-publicado");

    // --- bot JavaScript: runtime node + PLANTILLA sin tocar -----------------------
    await createBotWithLoadout(page, JS, JS_LOADOUT);
    await page.getByLabel("runtime").selectOption("node");
    await expect(page.getByLabel("codigo")).toHaveValue(/export default class Bot extends ArenaBot/);
    await submitVersion(page, 1);
    await expectState(page, 1, "validated");
    await expect(page.getByTestId("version-row-1")).toContainText("node");
    await publish(page, 1);

    const mine = (await api.ok("GET", "/bots?limit=100")).items as { id: string; name: string }[];
    const pyId = mine.find((b) => b.name === PY)!.id;
    const jsId = mine.find((b) => b.name === JS)!.id;

    // --- equipo con los dos ----------------------------------------------------------
    await go(page, "#/teams");
    await page.getByLabel("nuevo-equipo").fill(TEAM);
    await page.getByRole("button", { name: "Crear equipo" }).click();
    const team = page.getByRole("region", { name: `equipo ${TEAM}` });
    await expect(team).toBeVisible();
    for (const b of [PY, JS]) {
      await team.getByLabel(`añadir-bot-${TEAM}`).selectOption({ label: b });
      await team.getByRole("button", { name: "Añadir bot" }).click();
      await expect(team.getByText(b)).toBeVisible();
    }

    // --- batalla: los dos del MISMO equipo, uno por bando (H4) -----------------------
    await go(page, "#/battles/new");
    await expect(page.getByTestId("battle-concepts")).toContainText("Dos bots del mismo equipo pueden enfrentarse");
    await page.getByLabel("equipo rojo").selectOption({ label: TEAM });
    await page.getByLabel("equipo azul").selectOption({ label: TEAM });
    await pickBot(page, "rojo", PY);
    await pickBot(page, "azul", JS);
    await expect(page.getByLabel("versión rojo")).toHaveValue("1");
    await expect(page.getByLabel("versión azul")).toHaveValue("1");
    await expect(page.getByTestId("ineligible-bots")).toHaveCount(0);
    const battleId = await createBattle(page);
    await shot(page, info, "review-h1-batalla-creada");

    // --- visor en directo --------------------------------------------------------------
    await expect
      .poll(async () => (await api.ok("GET", `/battles/${battleId}`)).status, { timeout: 120_000 })
      .not.toBe("scheduled");
    await page.getByTestId("battle-detail-link").click();
    await expect(page.getByTestId("battle-detail")).toBeVisible();
    await go(page, `#/viewer/${battleId}`);
    await expect(page.getByTestId("viewer-status")).toHaveAttribute("data-state", /live|finished/, { timeout: 30_000 });
    const viewerState = await page.getByTestId("viewer-status").getAttribute("data-state");
    await shot(page, info, "review-h1-visor");

    // --- resultado ------------------------------------------------------------------
    const battle = await waitFinished(api, battleId);
    expect(battle.status, JSON.stringify(battle)).toBe("finished");
    expect(battle.result.agents).toBe("container");
    const stats = await waitStatsReady(api, battleId);

    await go(page, `#/battles/${battleId}`);
    await expect(page.getByTestId("battle-winner")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("battle-participants")).toContainText(PY);
    await expect(page.getByTestId("battle-participants")).toContainText(JS);
    await expect(page.getByTestId("battle-stats")).toBeVisible({ timeout: 30_000 });
    // Dueño de los dos: ve el diagnóstico de los dos.
    await expect(page.locator(`[data-testid="bot-diagnostics"][data-bot-id="${pyId}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="bot-diagnostics"][data-bot-id="${jsId}"]`)).toBeVisible();
    const detailText = (await page.getByTestId("battle-detail").innerText()) ?? "";
    expect(detailText).not.toMatch(GARBAGE);
    await shot(page, info, "review-h1-detalle");
    expect(Object.keys(stats.diagnostics).sort()).toEqual([pyId, jsId].sort());

    // --- replay en la web --------------------------------------------------------------
    await go(page, "#/replays");
    const rrow = page.locator(`[data-testid="replay-row"][data-battle-id="${battleId}"]`);
    await expect(rrow).toBeVisible({ timeout: 30_000 });
    await rrow.getByTestId("replay-open").click();
    const status = page.getByTestId("replay-status");
    await expect(status).toHaveAttribute("data-state", /playing|finished/, { timeout: 20_000 });
    await page.getByRole("button", { name: "8×" }).click();
    await expect(status).toHaveAttribute("data-state", "finished", { timeout: 240_000 });
    await shot(page, info, "review-h1-replay-fin");

    // --- loadout de la batalla == loadout guardado; perímetro; verificación ------------
    const { index, snapshots } = await replaySnapshots(api, battleId);
    const W = index.world?.widthM as number;
    const H = index.world?.heightM as number;
    expect(W, "el índice del replay trae el mundo").toBeGreaterThan(0);
    const roster = index.roster as { id: string; botId: string; chassis?: string }[];
    const vehOf = (botId: string) => roster.find((r) => r.botId === botId)!.id;
    const last = snapshots[snapshots.length - 1];
    const vehicleState = (vid: string) => last.vehicles.find((v: any) => v.id === vid);
    const pyVeh = vehicleState(vehOf(pyId));
    const jsVeh = vehicleState(vehOf(jsId));
    expect(roster.find((r) => r.botId === pyId)!.chassis).toBe("chassis.medium@1");
    expect(roster.find((r) => r.botId === jsId)!.chassis).toBe("chassis.light@1");
    expect(pyVeh.hullHpMax).toBe(300);
    expect(jsVeh.hullHpMax).toBe(180);
    expect(pyVeh.modules.map((m: any) => m.slot).sort()).toEqual(
      [...Object.keys(PY_LOADOUT.slots), "ammo_main"].sort(),
    ); // el resolvedor materializa la munición del arma (resolve/index.ts:91)
    expect(jsVeh.modules.map((m: any) => m.slot).sort()).toEqual(Object.keys(JS_LOADOUT.slots).sort());

    let outside = 0;
    let minMargin = Infinity;
    for (const s of snapshots)
      for (const v of s.vehicles) {
        if (!v.position) continue;
        const { x, y } = v.position;
        if (x < 0 || x > W || y < 0 || y > H) outside++;
        minMargin = Math.min(minMargin, x, W - x, y, H - y);
      }
    expect(outside, `posiciones fuera de ${W}×${H}`).toBe(0);
    const verify = await api.ok("POST", `/replays/${battleId}/verify`);
    expect(verify.matches, JSON.stringify(verify)).toBe(true);

    // --- TD-047: un AJENO y un ANÓNIMO no ven NADA de esta batalla ----------------------
    const ctxOther = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: info.project.use.baseURL });
    const other = await ctxOther.newPage();
    const otherCreds = await registerNewUser(other);
    const otherApi = new PublicApi(other.request, otherCreds);
    await otherApi.login();
    const foreign = await expectBattleHidden(otherApi, battleId, "ajeno");
    await go(other, `#/battles/${battleId}`);
    await expect(other.getByTestId("error-title")).toContainText("No existe o no está disponible", { timeout: 20_000 });
    await expect(other.getByTestId("battle-participants")).toHaveCount(0);
    await expect(other.getByTestId("bot-diagnostics")).toHaveCount(0);
    await go(other, `#/replay/${battleId}?t=0`);
    await expect(other.locator("body")).not.toContainText(PY, { timeout: 10_000 });
    await shot(other, info, "review-h1-ajeno-404");

    const ctxAnon = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: info.project.use.baseURL });
    const anonPage = await ctxAnon.newPage();
    const anon = await expectBattleHidden(new PublicApi(anonPage.request, null), battleId, "anónimo");

    // --- H5: recorrido por pantallas (usuario normal y anónimo) ------------------------
    const tour: Record<string, unknown>[] = [];
    const visit = async (p: typeof page, who: string, hash: string) => {
      await go(p, hash);
      const h2ok = await p
        .locator("main h2")
        .first()
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      expect.soft(h2ok, `${who} ${hash}: la pantalla tiene título`).toBe(true);
      // Espera a que acabe la carga (sin «Cargando» visible) o 10 s, lo que antes ocurra.
      await expect
        .poll(async () => /Cargando/.test(await p.locator("main").innerText()), { timeout: 10_000 })
        .toBe(false)
        .catch(() => undefined);
      const text = await p.locator("main").innerText();
      const alerts = await p.locator("main [role=alert]").allInnerTexts();
      tour.push({
        who,
        hash,
        h2: h2ok ? await p.locator("main h2").first().innerText() : null,
        alerts,
        garbage: (text.match(GARBAGE) ?? []).map(String),
        excerpt: text.slice(0, 400),
      });
      await shot(p, info, `review-h5-${who}-${hash.replace(/[^a-z]/gi, "_")}`);
      expect.soft(text, `${who} ${hash}`).not.toMatch(GARBAGE);
    };
    for (const h of [
      "#/",
      "#/bots",
      "#/teams",
      "#/maps",
      "#/tournaments",
      "#/battles",
      "#/replays",
      "#/live",
      "#/ranking",
      "#/help",
      "#/admin",
      "#/system",
      "#/audit",
      "#/roles",
      "#/account",
    ])
      await visit(page, "usuario", h);
    await anonPage.goto("/"); // la página anónima arranca en about:blank: primero se abre la SPA
    for (const h of ["#/", "#/live", "#/ranking", "#/help", "#/bots", "#/battles", "#/maps"])
      await visit(anonPage, "anonimo", h);

    evidence("h1", {
      battleId,
      viewerState,
      result: battle.result,
      participants: battle.participants,
      world: { W, H, minMargin, snapshots: snapshots.length },
      verify,
      foreign,
      anon,
      tour,
    });
    await ctxOther.close();
    await ctxAnon.close();
    expect(problems.filter((p) => !p.startsWith("console.error"))).toEqual([]);
  });
});

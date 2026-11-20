/**
 * UX-F (DEF-R7) · dos bots de la PLANTILLA JavaScript del editor
 * (apps/web/src/bot-templates.ts), con el loadout de artillero (radar + cañón),
 * se encuentran y se disparan en el mapa MVP.
 *
 * Antes la plantilla «patrullaba» girando en el sitio: con el radar a 50 m y las
 * salidas a 100 m, dos plantillas no se veían nunca (5 min sin un disparo, medido
 * por la revisión). Aquí corre el código de la plantilla TAL CUAL con el SDK real
 * (sdks/javascript), por WebSocket contra el ProtocolServer y el motor reales; los
 * disparos los cuenta el mismo cálculo de estadísticas que producción
 * (replay-service computeBattleStats). La plantilla Python tiene su gemelo en
 * sdks/python/tests/test_editor_templates.py.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { ArenaBot, angleDiff, angleTo } from "../../../sdks/javascript/src/index.js";
import { JAVASCRIPT_TEMPLATE } from "../../web/src/bot-templates.js";
import { computeBattleStats } from "../../replay-service/src/stats.js";
import { initPhysics } from "../src/sim/physics.js";
import { Battle, type Participant } from "../src/sim/battle.js";
import { mvpArena } from "../src/fixtures.js";
import { ProtocolServer, type ExpectedBot } from "../src/protocol-server.js";

const TICKS = 9000; // 5 minutos de partida, lo que midió la revisión

/** La clase `Bot` de la plantilla, evaluada con el SDK real (sin tocar su cuerpo). */
function templateClass(): new (botId: string) => ArenaBot {
  const imp = 'import { ArenaBot, angleDiff, angleTo } from "@arena/sdk";';
  expect(JAVASCRIPT_TEMPLATE.startsWith(imp)).toBe(true);
  const body = JAVASCRIPT_TEMPLATE.slice(imp.length).replace("export default class Bot", "class Bot");
  return new Function("ArenaBot", "angleDiff", "angleTo", `${body}\nreturn Bot;`)(ArenaBot, angleDiff, angleTo);
}

let server: ProtocolServer | undefined;
beforeAll(async () => {
  await initPhysics();
});
afterAll(() => {
  server?.stop();
});

describe("DEF-R7 · la plantilla JS busca, apunta y dispara", () => {
  it("dos plantillas (radar + cañón) en el mapa MVP: las dos disparan antes de 5 minutos", async () => {
    const catalog = loadCatalog();
    const participants: Participant[] = ["bot_tplred", "bot_tplblue"].map((botId, i) => ({
      id: `veh_${i + 1}`,
      botId,
      team: i === 0 ? "red" : "blue",
      spec: resolveVehicle(ARCHETYPES.gunner, catalog),
    }));
    const battle = await Battle.create({
      battleId: `uxf_tpl_${randomUUID().slice(0, 8)}`,
      seed: "uxf-templates",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: TICKS }),
      map: mvpArena(),
      participants,
      recordReplay: true,
    });
    const expected: ExpectedBot[] = participants.map((p) => ({
      botId: p.botId,
      vehicleId: p.id,
      battleToken: randomUUID(),
    }));
    server = new ProtocolServer({
      battle,
      catalogVersion: CATALOG_VERSION,
      expected,
      port: 0,
      tickIntervalMs: 2,
      decisionDeadlineMs: 80,
    });
    server.start();
    const Bot = templateClass();
    const runs = expected.map((e) => new Bot(e.botId).run(`ws://127.0.0.1:${server!.port}`, e.battleToken));
    const result = await server.waitForResult();
    await Promise.allSettled(runs);
    const replay = server.getReplay();
    const stats = await computeBattleStats(replay);
    const shots = Object.fromEntries(Object.values(stats.perBot).map((s: any) => [s.botId, s.shotsFired]));
    process.stderr.write(`[DEF-R7] disparos por bot: ${JSON.stringify(shots)}\n`);
    expect(result.ticks).toBeGreaterThan(0);
    expect(shots.bot_tplred, JSON.stringify(shots)).toBeGreaterThan(0);
    expect(shots.bot_tplblue, JSON.stringify(shots)).toBeGreaterThan(0);
  }, 180_000);
});

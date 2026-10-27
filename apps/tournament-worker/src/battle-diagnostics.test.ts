/**
 * UX-06 · Diagnóstico por bot de extremo a extremo en el lado del ejecutor:
 *  1. containerAgents (ProtocolServer + SandboxHost + motor REALES; el
 *     contenedor lo sustituye FakeBootstrapRunner, sin Docker) devuelve
 *     `diagnosticsByBot` con arranque, HELLO y comandos de cada bot;
 *  2. el handler de run_battle lo PERSISTE en `participants.diagnostics` en la
 *     transacción del resultado (también el «no arrancó» de un fallo deportivo);
 *  3. la API lo entrega en /battles/{id}/stats SÓLO al dueño de cada bot.
 * Antes no existía nada de esto: el dueño de un bot descalificado no sabía si
 * había arrancado, si su HELLO era correcto ni cuántos COMMAND se tiraron.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { Battle, type Participant } from "../../arena-engine/src/sim/battle.js";
import { emptyArena } from "../../arena-engine/src/fixtures.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { SandboxHost } from "../../bot-manager/src/sandbox-host.js";
import { FakeBootstrapRunner } from "../../bot-manager/tests/fake-bootstrap-runner.js";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { tokenFor } from "../../api/src/testing/helpers.js";
import { createApp } from "../../api/src/app.js";
import { containerAgents, type BotLaunchProvider } from "./container-agents.js";
import { makeRunBattleHandler, type BattleContext, type BattleExecution } from "./battle-runner.js";
import { SportingFailure } from "./errors.js";
import type { JobRow } from "./queue.js";
import { createBots, insertScheduledBattle, type TestBot } from "./testing/fixtures.js";

const IMAGE = `ghcr.io/example/runtime-python@sha256:${"1a".repeat(32)}`;
const VEHICLES = [
  { botId: "11111111-1111-4111-8111-111111111111", version: 1, vehicleId: "veh_1", team: "red" },
  { botId: "22222222-2222-4222-8222-222222222222", version: 1, vehicleId: "veh_2", team: "blue" },
];

let runners: FakeBootstrapRunner[] = [];
afterEach(() => {
  for (const r of runners.splice(0)) r.closeAll();
});

let h: TestDbHandle;
let bots: TestBot[];
beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  bots = await createBots(h.db, 2, "uxdiag");
}, 120_000);
afterAll(async () => {
  await h?.stop();
});

function provider(): BotLaunchProvider {
  return {
    async openBattle() {
      const host = await SandboxHost.start({ advertiseHost: "127.0.0.1", bindHost: "127.0.0.1", port: 0 });
      return {
        wss: host.wss,
        port: host.port,
        async plan() {
          const offer = host.offerArtifact(Buffer.from("arena-artifact/v1\n"), "0".repeat(64));
          return {
            imageDigest: IMAGE,
            env: { ARTIFACT_URL: offer.url, ARTIFACT_TOKEN: offer.token, ARTIFACT_SHA256: offer.sha256 },
            cmd: ["-c", "bootstrap"],
            autoRemove: true,
            startup: offer.signals,
          };
        },
        close: () => host.close(),
      };
    },
  };
}

function fakeJob(battleId: string, id: string): JobRow {
  return { id, kind: "run_battle", payload: { battleId }, attempts: 1 } as unknown as JobRow;
}

async function ownerToken(bot: TestBot): Promise<string> {
  const u = await h.db("users").where({ id: bot.ownerId }).first();
  return tokenFor(h.db, u.email);
}

describe("UX-06 · containerAgents devuelve el diagnóstico de cada bot", () => {
  it("dos bots que arrancan y juegan: startup ok, HELLO ok, comandos recibidos, ninguno inválido", async () => {
    const catalog = loadCatalog();
    const ruleset = loadRuleset("dm_practice@1", { timeLimitTicks: 90 });
    const participants: Participant[] = VEHICLES.map((b, i) => ({
      id: b.vehicleId,
      botId: `bot_p${i}`,
      team: b.team,
      spec: resolveVehicle(ARCHETYPES.gunner, catalog),
    }));
    const engine = await Battle.create({
      battleId: `uxdiag-${Math.random().toString(16).slice(2, 10)}`,
      seed: "uxdiag",
      ruleset,
      map: emptyArena(),
      participants,
      recordReplay: true,
    });
    const runner = new FakeBootstrapRunner(() => ({}));
    runners.push(runner);
    const agents = containerAgents({
      runner,
      provider: provider(),
      network: "arena",
      engineHost: "127.0.0.1",
      tickIntervalMs: 5,
      timeouts: { sandboxStartupMs: 5_000, botExecutionMs: 2_000 },
    });
    const out = await agents.run({
      battleId: engine.config.battleId,
      engine,
      vehicles: VEHICLES,
      ruleset,
      catalogVersion: CATALOG_VERSION,
    });
    expect(Object.keys(out.diagnosticsByBot ?? {}).sort()).toEqual(VEHICLES.map((v) => v.botId).sort());
    for (const v of VEHICLES) {
      const d = out.diagnosticsByBot![v.botId];
      expect(d.schema).toBe("bot-diagnostics/v1");
      expect(d.startup).toEqual({ ok: true });
      expect(d.protocol).toMatchObject({ helloOk: true, invalidCommands: 0, invalidJson: 0 });
      expect(d.protocol!.commandsReceived).toBeGreaterThan(0);
      // Nada del sandbox: sólo estas claves.
      expect(Object.keys(d).sort()).toEqual(["protocol", "schema", "startup"]);
    }
  }, 30_000);
});

describe("UX-06 · el runner persiste el diagnóstico y la API se lo da sólo al dueño", () => {
  const app = () => createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });

  it("batalla completada: participants.diagnostics escrito; cada dueño ve SÓLO el suyo", async () => {
    const id = await insertScheduledBattle(h.db, bots[0], bots[1]);
    const executor = async (_ctx: BattleContext): Promise<BattleExecution> => ({
      winner: "A",
      ticks: 300,
      score: { A: 1, B: 0 },
      finalStateHash: "h-diag",
      disqualified: [],
      versions: { engine: "test" },
      diagnosticsByBot: {
        [bots[0].botId]: {
          schema: "bot-diagnostics/v1",
          startup: { ok: true },
          protocol: {
            helloOk: true,
            helloTick: 0,
            reconnects: 0,
            commandsReceived: 95,
            invalidCommands: 4,
            firstInvalidReason: "/fire minItems",
            invalidJson: 0,
            lateCommands: 1,
            wrongTickCommands: 0,
            extraCommands: 0,
            disconnectedAtTick: null,
          },
        },
      },
    });
    await makeRunBattleHandler({ executor })(fakeJob(id, "00000000-0000-0000-0000-00000000d1a0"), {
      db: h.db,
      workerId: "D",
    });
    const p0 = await h.db("participants").where({ battle_id: id, bot_id: bots[0].botId }).first();
    expect(p0.diagnostics).toMatchObject({ schema: "bot-diagnostics/v1", protocol: { invalidCommands: 4 } });
    const p1 = await h.db("participants").where({ battle_id: id, bot_id: bots[1].botId }).first();
    expect(p1.diagnostics).toBeNull(); // no medido ⇒ NULL, nunca inventado

    const r0 = await request(app())
      .get(`/battles/${id}/stats`)
      .set("Authorization", `Bearer ${await ownerToken(bots[0])}`);
    expect(r0.status).toBe(200);
    expect(Object.keys(r0.body.diagnostics)).toEqual([bots[0].botId]);
    expect(r0.body.diagnostics[bots[0].botId]).toMatchObject({
      measured: true,
      hello: { ok: true, tick: 0 },
      commands: { received: 95, invalid: 4, firstInvalidReason: "/fire minItems", late: 1 },
      disqualified: false,
    });
    const r1 = await request(app())
      .get(`/battles/${id}/stats`)
      .set("Authorization", `Bearer ${await ownerToken(bots[1])}`);
    expect(Object.keys(r1.body.diagnostics)).toEqual([bots[1].botId]);
    expect(r1.body.diagnostics[bots[1].botId]).toMatchObject({ measured: false, commands: null, hello: null });
  });

  it("fallo deportivo en el arranque: el culpable queda «no arrancó: bot_crash» y descalificado", async () => {
    const id = await insertScheduledBattle(h.db, bots[0], bots[1]);
    const executor = async (): Promise<BattleExecution> => {
      throw new SportingFailure("bot_crash", bots[1].botId, "[bot_crash] detalle interno que no sale", "container");
    };
    await expect(
      makeRunBattleHandler({ executor })(fakeJob(id, "00000000-0000-0000-0000-00000000d1a1"), {
        db: h.db,
        workerId: "D",
      }),
    ).rejects.toBeInstanceOf(SportingFailure);
    const p1 = await h.db("participants").where({ battle_id: id, bot_id: bots[1].botId }).first();
    expect(p1.diagnostics).toEqual({ schema: "bot-diagnostics/v1", startup: { ok: false, reason: "bot_crash" } });

    const r = await request(app())
      .get(`/battles/${id}/stats`)
      .set("Authorization", `Bearer ${await ownerToken(bots[1])}`);
    expect(r.body.status).toBe("unavailable"); // sin replay no habrá estadísticas
    const d = r.body.diagnostics[bots[1].botId];
    expect(d).toMatchObject({
      startup: { ok: false, reason: "bot_crash" },
      disqualified: true,
      disqualifiedReason: "bot_crash",
    });
    expect(JSON.stringify(r.body)).not.toContain("detalle interno");
  });
});

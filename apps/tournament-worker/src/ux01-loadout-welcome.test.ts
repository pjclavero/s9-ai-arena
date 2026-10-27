/**
 * UX-01 (G-16) · ¿Qué vehículo juega una batalla? Se DEMUESTRA, no se infiere.
 *
 * El editor de loadout decía que «en la ejecución real se usan los módulos fijos
 * del arquetipo». Eso describía un camino de batalla (API → arena-engine
 * `/run`, battle-run-http-launcher.ts) que ya no ejecuta nada: `POST
 * /battles/{id}/run` delega en el tournament-worker (DEV-B, TD-002). Aquí se
 * recorre el camino REAL del worker (makeEngineExecutor, BD real) con un loadout
 * persistido que NO es el de su arquetipo, y se comprueban las tres piezas:
 *
 *   loadout persistido (bot_loadouts) ↔ WELCOME que recibe el bot por arena/1
 *   ↔ vehículo que simula el motor (engine.getVehicle(...).spec).
 *
 * El driver de agentes es el ProtocolServer REAL con clientes WebSocket que hacen
 * HELLO como el SDK: lo único que cambia frente a producción es que no hay
 * contenedor (el contenedor no decide el vehículo; el executor sí).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { ProtocolServer } from "../../arena-engine/src/protocol-server.js";
import { protocolBotHandle } from "../../../packages/protocol/bot-handle.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { makeEngineExecutor, type AgentDriver } from "./engine-executor.js";
import { createBots, insertScheduledBattle, type TestBot } from "./testing/fixtures.js";

/** Loadout del usuario: chasis medio (arquetipo gunner) con módulos que el gunner NO lleva. */
const USER_MODULES = [
  { slot: "drive", moduleId: "movement.wheels@1" },
  { slot: "power", moduleId: "power.battery@1" },
  { slot: "sensor_a", moduleId: "sensor.lidar_front@1" },
  { slot: "turret_main", moduleId: "weapon.mg@1", ammo: "ammo.standard@1" },
  { slot: "mine_bay", moduleId: "mine.explosive@1" },
];

let h: TestDbHandle;
let bots: TestBot[];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  bots = await createBots(h.db, 2, "ux01");
  await h.db("bot_loadouts").insert({
    bot_id: bots[0].botId,
    revision: 2,
    name: "ux01-propio",
    catalog_version: "mvp@1",
    chassis: "chassis.medium@1",
    modules: JSON.stringify(USER_MODULES),
  });
  // Versión 2 PUBLICADA con la revisión 2 del loadout (las versiones publicadas son
  // inmutables: el loadout de una versión se fija al crearla).
  await h.db("bot_versions").insert({
    bot_id: bots[0].botId,
    version: 2,
    state: "published",
    runtime: "node",
    loadout_revision: 2,
    artifact_hash: "hash-ux01-v2",
  });
  const [build] = await h.db("builds").insert({ bot_id: bots[0].botId, version: 2, status: "passed" }).returning("id");
  await h.db("artifacts").insert({
    build_id: build.id,
    hash: "hash-ux01-v2",
    signature: "sig-ux01-v2",
    storage_ref: "mem://artifacts/ux01-v2",
  });
  bots[0] = { ...bots[0], version: 2, loadoutRevision: 2 };
}, 120_000);
afterAll(async () => {
  await h?.stop();
});

/** Driver con el ProtocolServer real: captura el WELCOME que recibe cada bot. */
function welcomeCapturingDriver(welcomes: Map<string, any>, specs: Map<string, any>): AgentDriver {
  return {
    kind: "scripted",
    async run({ engine, vehicles, catalogVersion }) {
      for (const v of vehicles) specs.set(v.botId, engine.getVehicle(v.vehicleId)!.spec);
      const expected = vehicles.map((v, i) => ({
        botId: protocolBotHandle(i),
        vehicleId: v.vehicleId,
        battleToken: randomUUID(),
      }));
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await new Promise<void>((r) => wss.once("listening", () => r()));
      const port = (wss.address() as { port: number }).port;
      const server = new ProtocolServer({ battle: engine, catalogVersion, expected, wss, tickIntervalMs: 1 });
      const sockets: WebSocket[] = [];
      try {
        await Promise.all(
          expected.map(
            (e, i) =>
              new Promise<void>((resolve, reject) => {
                const ws = new WebSocket(`ws://127.0.0.1:${port}`);
                sockets.push(ws);
                ws.on("error", reject);
                ws.on("open", () =>
                  ws.send(
                    JSON.stringify({
                      proto: "arena/1",
                      type: "HELLO",
                      seq: 0,
                      payload: {
                        botId: e.botId,
                        botVersion: "1",
                        sdk: { name: "custom", version: "0.1.0" },
                        battleToken: e.battleToken,
                      },
                    }),
                  ),
                );
                ws.on("message", (raw) => {
                  const msg = JSON.parse(String(raw));
                  if (msg.type === "WELCOME") {
                    welcomes.set(vehicles[i].botId, msg.payload);
                    resolve();
                  }
                });
              }),
          ),
        );
        server.start();
        const result = await server.waitForResult();
        return { result, replay: server.getReplay() };
      } finally {
        for (const ws of sockets) ws.close();
        server.stop();
        await new Promise((r) => wss.close(() => r(undefined)));
      }
    },
  };
}

describe("UX-01 · la batalla juega el loadout PERSISTIDO de la versión, no el arquetipo", () => {
  it("loadout persistido ↔ WELCOME recibido ↔ vehículo simulado coinciden; el arquetipo no aparece", async () => {
    const welcomes = new Map<string, any>();
    const specs = new Map<string, any>();
    const executor = makeEngineExecutor({
      db: h.db,
      agents: welcomeCapturingDriver(welcomes, specs),
      rulesetOverrides: { timeLimitTicks: 30 },
    });
    const battleId = await insertScheduledBattle(h.db, bots[0], bots[1]);
    const battle = await h.db("battles").where({ id: battleId }).first();
    const participants = await h.db("participants").where({ battle_id: battleId });
    await executor({ battle, participants, adminDisqualified: [] } as never);

    // 1) lo persistido
    const version = await h.db("bot_versions").where({ bot_id: bots[0].botId, version: 2 }).first();
    const persisted = await h
      .db("bot_loadouts")
      .where({ bot_id: bots[0].botId, revision: version.loadout_revision })
      .first();
    const persistedModules = (typeof persisted.modules === "string" ? JSON.parse(persisted.modules) : persisted.modules)
      .map((m: { moduleId: string }) => m.moduleId)
      .sort();
    expect(persistedModules).toEqual(USER_MODULES.map((m) => m.moduleId).sort());

    // 2) lo que recibe el bot (WELCOME.vehicle.modules) incluye cada módulo elegido
    const welcome = welcomes.get(bots[0].botId);
    expect(welcome, "el bot no recibió WELCOME").toBeDefined();
    const welcomed = (welcome.vehicle.modules as { moduleId: string; slot: string }[]).map((m) => m.moduleId);
    for (const id of persistedModules) expect(welcomed).toContain(id);
    // la munición elegida se materializa como módulo (resolveVehicle)
    expect(welcomed).toContain("ammo.standard@1");

    // 3) lo que simula el motor
    const simulated = (specs.get(bots[0].botId).modules as { moduleId: string }[]).map((m) => m.moduleId).sort();
    expect(simulated).toEqual([...welcomed].sort());

    // y NO es el arquetipo del chasis (medium → gunner: orugas, generador, cañón)
    const archetype = ARCHETYPES.gunner.modules.map((m) => m.moduleId);
    expect(welcomed).not.toContain("weapon.cannon@1");
    expect(welcomed).not.toContain("movement.tracks@1");
    expect(archetype).toContain("weapon.cannon@1");
  }, 120_000);
});

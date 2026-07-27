/**
 * B10 (issue #9) · La CPU medida en los contenedores llega hasta la BD.
 *
 * Cadena real: arena-engine devuelve `cpuMsByBot` en el cuerpo de `POST /run`
 * (`ContainerBattleOutcome`) → este launcher la persiste en
 * `participants.cpu_ms` → `runStatsJob` (replay-service) la lee para rellenar
 * `battle_stats.stats.cpuMs`. Sin este eslabón la medida existiría durante
 * medio segundo dentro de arena-engine y se perdería al responder.
 *
 * Aquí se prueba el eslabón del launcher contra PostgreSQL REAL (embebido) y un
 * arena-engine simulado con un servidor HTTP de verdad. Nunca se lanza Docker.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { DEV_USERS, seedDev, DEFAULT_RULESET_ID } from "../db/seeds/dev.js";
import { createHttpBattleRunLauncher } from "./battle-run-http-launcher.js";
import type { BattleRunInput } from "../battle-run.js";

let h: TestDbHandle;
let adminId: string;
let catalogVersion: string;
const REAL_HASH = "sha256:" + "cd".repeat(32);
const SECRET = "secreto-interno-de-pruebas";

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  adminId = (await h.db("users").where({ email: DEV_USERS.admin }).first()).id;
  catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
}, 120000);
afterAll(async () => {
  await h.stop();
});

async function seedBot(name: string) {
  const id = randomUUID();
  await h.db("bots").insert({ id, name: `${name}-${id.slice(0, 8)}`, owner_id: adminId });
  await h.db("bot_loadouts").insert({
    bot_id: id,
    revision: 1,
    catalog_version: catalogVersion,
    chassis: "chassis.light@1",
    modules: JSON.stringify([]),
  });
  await h.db("bot_versions").insert({
    bot_id: id,
    version: 1,
    state: "published",
    runtime: "python",
    loadout_revision: 1,
    artifact_hash: REAL_HASH,
  });
  return { botId: id, version: 1 };
}

/** Batalla REAL en BD (uuid) con sus dos participantes, para poder consultar cpu_ms. */
async function seedBattle(): Promise<{ input: BattleRunInput; red: string; blue: string }> {
  const red = await seedBot("cpu-red");
  const blue = await seedBot("cpu-blue");
  const [battle] = await h
    .db("battles")
    .insert({
      status: "running",
      official: true,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "cpu-seed",
    })
    .returning("*");
  await h.db("participants").insert([
    { battle_id: battle.id, bot_id: red.botId, version: 1, team: "red" },
    { battle_id: battle.id, bot_id: blue.botId, version: 1, team: "blue" },
  ]);
  return {
    red: red.botId,
    blue: blue.botId,
    input: {
      battleId: battle.id,
      mode: "deathmatch",
      mapId: "mvp-arena-01",
      mapVersion: 1,
      seed: "cpu-seed",
      participants: [
        { botId: red.botId, version: 1, team: "red", artifactHash: REAL_HASH },
        { botId: blue.botId, version: 1, team: "blue", artifactHash: REAL_HASH },
      ],
    },
  };
}

/** arena-engine simulado: responde 200 con el cuerpo que se le pase. */
function startFakeEngine(body: unknown) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

let closeEngine: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeEngine?.();
  closeEngine = undefined;
});

/** Lanza la batalla contra un arena-engine que devuelve `cpuMsByBot` y devuelve lo persistido. */
async function runWith(cpuMsByBot: unknown, seeded: { input: BattleRunInput }) {
  const engine = await startFakeEngine({ result: { winner: "red", ticks: 100 }, postures: {}, cpuMsByBot });
  closeEngine = engine.close;
  const launcher = createHttpBattleRunLauncher({ engineUrl: engine.url, sharedSecret: SECRET, db: h.db });
  const outcome = await launcher.launch(seeded.input);
  const rows = await h.db("participants").where({ battle_id: seeded.input.battleId }).orderBy("team");
  return { outcome, cpuByBot: new Map(rows.map((r) => [r.bot_id as string, r.cpu_ms as number | null])) };
}

describe("B10 · el launcher persiste la CPU real medida en los contenedores", () => {
  it("guarda en participants.cpu_ms la medida de cada bot que arena-engine reportó", async () => {
    const seeded = await seedBattle();
    const { outcome, cpuByBot } = await runWith({ [seeded.red]: 5120.5, [seeded.blue]: 4098 }, seeded);
    expect(outcome.status).toBe("completed");
    expect(cpuByBot.get(seeded.red)).toBe(5120.5);
    expect(cpuByBot.get(seeded.blue)).toBe(4098);
  }, 60000);

  it("un bot sin medida (null) queda sin medida: no se le inventa un número", async () => {
    const seeded = await seedBattle();
    const { cpuByBot } = await runWith({ [seeded.red]: 777.25, [seeded.blue]: null }, seeded);
    expect(cpuByBot.get(seeded.red)).toBe(777.25);
    expect(cpuByBot.get(seeded.blue)).toBeNull();
  }, 60000);

  it("una batalla sin cpuMsByBot (arena-engine antiguo) deja las dos medidas a null", async () => {
    const seeded = await seedBattle();
    const { outcome, cpuByBot } = await runWith(undefined, seeded);
    // La batalla se completa igual: la métrica es diagnóstico, no un requisito.
    expect(outcome.status).toBe("completed");
    expect(cpuByBot.get(seeded.red)).toBeNull();
    expect(cpuByBot.get(seeded.blue)).toBeNull();
  }, 60000);

  it("valores corruptos NO se escriben (string, negativo, objeto): la columna queda null", async () => {
    const seeded = await seedBattle();
    const { cpuByBot } = await runWith({ [seeded.red]: "5120.5", [seeded.blue]: -3 }, seeded);
    expect(cpuByBot.get(seeded.red)).toBeNull();
    expect(cpuByBot.get(seeded.blue)).toBeNull();
  }, 60000);

  it("arena-engine no puede escribir la CPU de un bot ajeno a esta batalla", async () => {
    const seeded = await seedBattle();
    const otro = await seedBattle(); // otra batalla, otros bots
    const { cpuByBot } = await runWith({ [otro.red]: 99999, [seeded.red]: 12.5 }, seeded);
    // Solo se escribe lo de los participantes que la API pidió lanzar.
    expect(cpuByBot.get(seeded.red)).toBe(12.5);
    const ajenos = await h.db("participants").where({ battle_id: otro.input.battleId });
    for (const r of ajenos) expect(r.cpu_ms).toBeNull();
  }, 60000);

  it("claves de prototipo en el payload no escriben nada ni ensucian Object.prototype", async () => {
    const seeded = await seedBattle();
    // El payload viaja como JSON: `__proto__` llega como propiedad propia, y
    // `constructor`/`toString` son las que un `dict[k]` sin guarda resolvería.
    const hostil = JSON.parse(`{"__proto__": 1000, "constructor": 2000, "toString": 3000}`);
    const { cpuByBot } = await runWith(hostil, seeded);
    expect(cpuByBot.get(seeded.red)).toBeNull();
    expect(cpuByBot.get(seeded.blue)).toBeNull();
    expect(({} as Record<string, unknown>).cpu_ms).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("bot_red");
  }, 60000);
});

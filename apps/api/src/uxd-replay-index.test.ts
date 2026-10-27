/**
 * UX-D (D4 · C-G9) · El índice del replay trae el MUNDO y la NÓMINA.
 *
 * Antes `GET /replays/{id}/index` sólo devolvía el índice del almacén: el visor
 * pintaba el replay sin muros ni destructibles y con `veh_1` en lugar del nombre
 * del bot. Ahora la API añade `world` (de la cabecera del propio replay: el mapa
 * exacto con el que se jugó) y `roster` (vehículo → bot, con el nombre de `bots`),
 * con la MISMA política de acceso de siempre (td004-replay-access.test.ts).
 * Replay REAL del motor (mvpArena, con muros); PostgreSQL embebido.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record } from "../../arena-engine/src/replay.js";
import { gunnerLoadout, mvpArena, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { ingestReplay } from "../../replay-service/src/store.js";

let h: TestDbHandle;
let app: Express;
let dir: string;
let ownerToken: string;
let strangerToken: string;
let battleId: string;
const bots: string[] = [];

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 100_000, windowMs: 3600_000 } });
  dir = mkdtempSync(join(tmpdir(), "uxd-replay-index-"));
  const catalogVersion = (await h.db("catalog_versions").first()).catalog_version;

  const users: string[] = [];
  for (const label of ["owner", "stranger"]) {
    const email = `uxd-ri-${label}-${randomUUID().slice(0, 8)}@uxd.example.internal`;
    const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: label }).returning("id");
    await h.db("user_roles").insert({ user_id: u.id, role: "user" });
    users.push(u.id);
    if (label === "owner") ownerToken = await tokenFor(h.db, email);
    else strangerToken = await tokenFor(h.db, email);
  }
  for (const name of ["Tanque Rojo", "Muro Azul"]) {
    const id = randomUUID();
    await h.db("bots").insert({ id, name, owner_id: users[0], visibility: "private" });
    await h.db("bot_loadouts").insert({
      bot_id: id,
      revision: 1,
      catalog_version: catalogVersion,
      chassis: "chassis.scout@1",
      modules: JSON.stringify([]),
    });
    await h
      .db("bot_versions")
      .insert({ bot_id: id, version: 1, state: "published", runtime: "python", loadout_revision: 1 });
    bots.push(id);
  }

  battleId = randomUUID();
  const replay = await record(
    {
      battleId,
      seed: "uxd-ri",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 60 }),
      map: mvpArena(),
      participants: [
        { id: "veh_1", botId: bots[0], team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: bots[1], team: "blue", spec: scoutLoadout() },
      ],
    },
    (b) => {
      b.attachBot("veh_1", new HunterBot(bots[0]));
      b.attachBot("veh_2", new HunterBot(bots[1]));
    },
  );
  const stored = ingestReplay(dir, replay, { official: false });
  await h.db("battles").insert({
    id: battleId,
    status: "finished",
    official: false,
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
    replay_ref: stored.path,
    replay_hash: stored.index.sha256,
    final_state_hash: replay.result.finalStateHash,
    result: JSON.stringify({ score: replay.result.score, ticks: replay.result.ticks }),
    finished_at: h.db.fn.now(),
  });
  await h.db("participants").insert([
    { battle_id: battleId, bot_id: bots[0], version: 1, team: "red" },
    { battle_id: battleId, bot_id: bots[1], version: 1, team: "blue" },
  ]);
}, 180_000);

afterAll(async () => {
  await h?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("UX-D · GET /replays/{id}/index con mundo y nómina", () => {
  it("el dueño recibe los muros del mapa jugado y el NOMBRE de cada bot por vehículo", async () => {
    const r = await request(app).get(`/replays/${battleId}/index`).set("Authorization", `Bearer ${ownerToken}`);
    expect(r.status).toBe(200);
    const map = mvpArena();
    expect(r.body.world.widthM).toBe(map.widthM);
    expect(r.body.world.heightM).toBe(map.heightM);
    expect(r.body.world.walls.length).toBe(map.walls.length);
    expect(r.body.world.walls.length).toBeGreaterThan(0);
    expect(r.body.world.walls[0]).toEqual({
      position: map.walls[0].position,
      halfW: map.walls[0].halfW,
      halfH: map.walls[0].halfH,
    });
    expect(r.body.roster).toEqual([
      { id: "veh_1", botId: bots[0], team: "red", chassis: gunnerLoadout().chassisId, name: "Tanque Rojo" },
      { id: "veh_2", botId: bots[1], team: "blue", chassis: scoutLoadout().chassisId, name: "Muro Azul" },
    ]);
    // Nada que el directo no mande ya: ni semilla ni loadouts.
    expect(JSON.stringify(r.body)).not.toContain('uxd-ri"');
    expect(JSON.stringify(r.body.roster)).not.toContain("modules");
  });

  it("la política de acceso no cambia: un ajeno sigue recibiendo el 404 uniforme", async () => {
    const r = await request(app).get(`/replays/${battleId}/index`).set("Authorization", `Bearer ${strangerToken}`);
    expect(r.status).toBe(404);
    expect(r.body.world).toBeUndefined();
  });
});

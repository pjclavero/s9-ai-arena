/**
 * T7.5 · DoD: barrido de fugas por contrato (x-private), espectador anónimo
 * (batalla en directo + replay sin cuenta), cuotas anónimas (429 + api_usage)
 * y caché de clasificaciones que nunca sirve datos obsoletos >60 s.
 * También: torneos (inscripción/cierre, cap. 17.2) y mapas con código real de E4.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { loadContract } from "./openapi.js";
import { implementedOperations } from "./registry.js";
import { getStandings, updateStandings, clearStandingsCache } from "./services/standings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");
const GOOD_LOADOUT = JSON.parse(readFileSync(join(REPO, "packages", "module-catalog", "examples", "loadout-medium-gunner.json"), "utf8"));

let h: TestDbHandle;
let app: Express;
let dev: string;
let organizer: string;
let botId: string;
let liveBattleId: string;
let finishedBattleId: string;
let replayBytes: Buffer;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  clearStandingsCache();
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 1000, windowMs: 3600_000 } });
  dev = await tokenFor(h.db, DEV_USERS.developer);
  organizer = await tokenFor(h.db, DEV_USERS.organizer);

  // Bot publicado (vía API real, con FakeBotManager)
  const auth = { Authorization: `Bearer ${dev}` };
  const bot = await request(app).post("/bots").set(auth).send({ name: "public-bot", visibility: "public" });
  botId = bot.body.id;
  await request(app).post(`/bots/${botId}/loadouts`).set(auth).send(GOOD_LOADOUT);
  const v = await request(app)
    .post(`/bots/${botId}/versions`)
    .set(auth)
    .field("runtime", "python")
    .field("loadoutRevision", "1")
    .attach("source", Buffer.from("print('x')"), "bot.py");
  await request(app).post(`/bots/${botId}/versions/${v.body.version}/actions/submit`).set(auth);
  await request(app).post(`/bots/${botId}/versions/${v.body.version}/actions/publish`).set(auth).send({});

  // Batalla en directo + batalla terminada con replay en archivo (política 23.1)
  const [live] = await h.db("battles")
    .insert({
      status: "running",
      official: false,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "seed-live",
    })
    .returning("*");
  liveBattleId = live.id;
  await h.db("participants").insert({ battle_id: liveBattleId, bot_id: botId, version: 1, team: "A" });

  const replayDir = mkdtempSync(join(tmpdir(), "e7-replays-"));
  replayBytes = Buffer.from("replay-comprimido-de-prueba");
  const replayPath = join(replayDir, "battle.replay.zst");
  writeFileSync(replayPath, replayBytes);
  const [done] = await h.db("battles")
    .insert({
      status: "finished",
      official: true,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "seed-done",
      replay_ref: replayPath,
      final_state_hash: "ab".repeat(32),
      engine_versions: JSON.stringify({ engine: "e2@1", physics: "rapier2d-compat", rules: "1", catalog: "mvp@1", protocol: "arena/1" }),
      result: JSON.stringify({ score: { A: 1 }, ticks: 9000 }),
    })
    .returning("*");
  finishedBattleId = done.id;
  await h.db("participants").insert({ battle_id: finishedBattleId, bot_id: botId, version: 1, team: "A", outcome: "win" });
  await h.db("battle_stats").insert({ battle_id: finishedBattleId, bot_id: botId, stats: JSON.stringify({ damageDealt: 120 }) });
  await updateStandings(h.db, "current", "deathmatch", [{ botId, rank: 1, rating: 1520, wins: 3, losses: 1 }]);
}, 120000);

afterAll(async () => {
  await h.stop();
});

describe("T7.5 espectador anónimo (DoD: batalla en directo y replay sin cuenta)", () => {
  it("un visitante lista batallas en directo, saca ticket de espectador y baja un replay", async () => {
    const live = await request(app).get("/battles?status=running");
    expect(live.status).toBe(200);
    expect(live.body.items.some((b: { id: string }) => b.id === liveBattleId)).toBe(true);

    const ticket = await request(app).post(`/battles/${liveBattleId}/spectate-ticket`);
    expect(ticket.status).toBe(201);
    expect(ticket.body.ticket).toBeTruthy();
    expect(ticket.body.wsUrl).toContain(liveBattleId);
    expect(new Date(ticket.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const replay = await request(app).get(`/replays/${finishedBattleId}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(replay.status).toBe(200);
    expect(Buffer.compare(replay.body as Buffer, replayBytes)).toBe(0);
    expect(replay.headers["cache-control"]).toContain("max-age=3600");

    const audit = await request(app).get(`/battles/${finishedBattleId}/audit`);
    expect(audit.status).toBe(200);
    expect(audit.body.finalStateHash).toBe("ab".repeat(32));
    expect(audit.body.artifacts[0].artifactHash).toBeTruthy();

    const stats = await request(app).get(`/battles/${finishedBattleId}/stats`);
    expect(stats.status).toBe(200);
    expect(stats.body.perBot[botId].damageDealt).toBe(120);
  });
});

describe("T7.5 barrido de fugas por contrato (x-private)", () => {
  it("ninguna respuesta pública contiene campos x-private del OpenAPI", async () => {
    const contract = loadContract();
    const privateFields = contract.privateFieldNames;
    expect(privateFields.size).toBeGreaterThan(3); // email, roles, accessToken, logUrl…

    const params: Record<string, string> = {
      userId: (await h.db("users").where({ email: DEV_USERS.developer }).first()).id,
      botId,
      battleId: finishedBattleId,
      buildId: "",
      mapId: "mvp-arena-01",
      tournamentId: "",
      sessionId: "",
      version: "1",
      catalogVersion: "mvp@1",
      teamId: "",
    };

    const swept: string[] = [];
    for (const op of implementedOperations) {
      // Se barren los endpoints ANÓNIMOS del contrato, salvo el intercambio de
      // credenciales (tag auth: login/refresh devuelven SUS propios tokens).
      if (!op.anonymous || op.extension || op.tags.includes("auth")) continue;
      if (op.method !== "get" && op.operationId !== "getSpectateTicket") continue;
      const path = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => params[name] ?? "1");
      const r =
        op.method === "get" ? await request(app).get(path) : await request(app).post(path).send({});
      if (r.status >= 400 || !r.headers["content-type"]?.includes("json")) continue;
      swept.push(op.operationId);

      const offenders: string[] = [];
      (function walk(node: unknown): void {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node === null || typeof node !== "object") return;
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (privateFields.has(k)) offenders.push(k);
          walk(v);
        }
      })(r.body);
      expect(offenders, `${op.operationId} filtra campos privados: ${offenders.join(",")}`).toEqual([]);
    }
    // El barrido debe haber ejercitado los recursos públicos principales
    for (const must of ["getUserPublic", "listBots", "getBot", "listBattles", "getBattle", "getBattleAudit", "getStandings", "listMaps", "getSpectateTicket"]) {
      expect(swept, `barrido incluye ${must}`).toContain(must);
    }
  });

  it("el perfil público de un usuario no expone email ni roles; el bot no expone código", async () => {
    const user = await h.db("users").where({ email: DEV_USERS.developer }).first();
    const profile = await request(app).get(`/users/${user.id}`);
    expect(profile.body).toEqual({
      id: user.id,
      displayName: "dev-developer",
      createdAt: expect.any(String),
    });
    // La descarga de código exige autenticación (x-min-role user) + dueño/codePublic
    const src = await request(app).get(`/bots/${botId}/versions/1/source`);
    expect(src.status).toBe(401);
  });
});

describe("T7.5 cuotas anónimas (DoD: 429 y registro en api_usage)", () => {
  it("la cuota anónima corta con 429 y queda registrada", async () => {
    // Limpia el consumo previo de esta IP/ruta (otros tests de este archivo)
    await h.db("api_usage").where({ route: "spectate-ticket" }).delete();
    const strict = createApp({
      db: h.db,
      botManager: new FakeBotManager(h.db),
      anonQuota: { max: 3, windowMs: 3600_000 },
    });
    for (let i = 0; i < 3; i++) {
      const ok = await request(strict).post(`/battles/${liveBattleId}/spectate-ticket`);
      expect(ok.status).toBe(201);
    }
    const blocked = await request(strict).post(`/battles/${liveBattleId}/spectate-ticket`);
    expect(blocked.status).toBe(429);

    const usage = await h.db("api_usage").where({ route: "spectate-ticket" }).first();
    expect(usage).toBeTruthy();
    expect(Number(usage.count)).toBeGreaterThanOrEqual(4);

    // Un usuario autenticado no consume cuota anónima
    const authd = await request(strict)
      .post(`/battles/${liveBattleId}/spectate-ticket`)
      .set("Authorization", `Bearer ${dev}`);
    expect(authd.status).toBe(201);
  });
});

describe("T7.5 caché de clasificaciones (DoD: nunca obsoleta >60 s)", () => {
  it("sirve desde caché dentro del TTL y se invalida INMEDIATAMENTE al actualizar", async () => {
    clearStandingsCache();
    const first = await getStandings(h.db, "current", "deathmatch");
    expect(first.fromCache).toBe(false);
    const second = await getStandings(h.db, "current", "deathmatch");
    expect(second.fromCache).toBe(true);

    // Actualización de ratings ⇒ la siguiente lectura ya ve el dato nuevo
    await updateStandings(h.db, "current", "deathmatch", [{ botId, rank: 1, rating: 1600, wins: 4, losses: 1 }]);
    const after = await request(app).get("/standings?seasonId=current&mode=deathmatch");
    expect(after.status).toBe(200);
    expect(after.headers["cache-control"]).toBe("public, max-age=60");
    expect(after.body[0].rating).toBe(1600);
    expect(after.body[0].botName).toBe("public-bot");
  });

  it("la entrada de caché caduca sola a los 60 s aunque nadie invalide", async () => {
    clearStandingsCache();
    const t0 = Date.now();
    await getStandings(h.db, "current", "deathmatch", t0);
    const stale = await getStandings(h.db, "current", "deathmatch", t0 + 59_000);
    expect(stale.fromCache).toBe(true);
    const expired = await getStandings(h.db, "current", "deathmatch", t0 + 61_000);
    expect(expired.fromCache).toBe(false);
  });
});

describe("T7.5 torneos (cap. 17.2) y batallas de práctica", () => {
  it("crear torneo (budget por competición, D7) → inscribir → cerrar congela versiones y revela semillas", async () => {
    const t = await request(app)
      .post("/tournaments")
      .set("Authorization", `Bearer ${organizer}`)
      .send({ name: "liga-skirmish", format: "round_robin", mode: "deathmatch", rulesetId: DEFAULT_RULESET_ID, budgetCredits: 600 });
    expect(t.status).toBe(201);
    expect(t.body.budgetCredits).toBe(600);
    expect(t.body.state).toBe("open");

    const entry = await request(app)
      .post(`/tournaments/${t.body.id}/entries`)
      .set("Authorization", `Bearer ${dev}`)
      .send({ botId, version: 1 });
    expect(entry.status).toBe(201);
    expect(entry.body.loadoutRevision).toBe(1);
    expect(entry.body.frozen).toBe(false);

    const closed = await request(app)
      .post(`/tournaments/${t.body.id}/actions/close-entries`)
      .set("Authorization", `Bearer ${organizer}`);
    expect(closed.status).toBe(200);
    expect(closed.body.state).toBe("closed");
    expect(closed.body.seedsRevealed.length).toBeGreaterThan(0);

    const frozenEntry = await h.db("entries").where({ tournament_id: t.body.id }).first();
    expect(frozenEntry.frozen).toBe(true);
    const version = await h.db("bot_versions").where({ bot_id: botId, version: 1 }).first();
    expect(version.state).toBe("frozen");

    // Tras el cierre no hay inscripciones nuevas
    const late = await request(app)
      .post(`/tournaments/${t.body.id}/entries`)
      .set("Authorization", `Bearer ${dev}`)
      .send({ botId, version: 1 });
    expect(late.status).toBe(409);

    // ...y el calendario queda encolado para E9 (pendiente de reconciliación)
    const job = await h.db("jobs").where({ kind: "generate_schedule" }).first();
    expect(job).toBeTruthy();
  });

  it("una batalla de práctica se encola (202) como no oficial", async () => {
    const r = await request(app)
      .post("/battles")
      .set("Authorization", `Bearer ${dev}`)
      .send({
        mode: "deathmatch",
        rulesetId: DEFAULT_RULESET_ID,
        mapId: "mvp-arena-01",
        participants: [{ botId, version: 1, team: "A" }],
      });
    expect(r.status).toBe(202);
    expect(r.body.official).toBe(false);
    expect(r.body.status).toBe("scheduled");
    const job = await h.db("jobs").where({ kind: "run_battle" }).first();
    expect(job).toBeTruthy();
  });
});

describe("T7.5 mapas con el código real de E4", () => {
  it("importar el mapa MVP → publicar (miniatura) → PUT siempre 409 (inmutable)", async () => {
    const mapDoc = readFileSync(join(REPO, "maps", "mvp-arena-01.json"));
    const imported = await request(app)
      .post("/maps")
      .set("Authorization", `Bearer ${dev}`)
      .attach("file", mapDoc, "mvp-arena-01.json");
    expect(imported.status).toBe(201);
    expect(imported.body.state).toBe("validated");
    const { mapId, version } = imported.body;

    const published = await request(app)
      .post(`/maps/${mapId}/versions/${version}/actions/publish`)
      .set("Authorization", `Bearer ${organizer}`);
    expect(published.status).toBe(200);
    expect(published.body.state).toBe("published");
    expect(published.body.thumbnailUrl).toContain("data:image/svg+xml");

    const replaced = await request(app)
      .put(`/maps/${mapId}/versions/${version}`)
      .set("Authorization", `Bearer ${await tokenFor(h.db, DEV_USERS.admin)}`);
    expect(replaced.status).toBe(409);
  });

  it("la generación procedural es determinista: misma semilla ⇒ mismo checksum", async () => {
    const params = { widthM: 120, heightM: 80, mode: "deathmatch", mapId: "gen-test" };
    const a = await request(app)
      .post("/maps/generate")
      .set("Authorization", `Bearer ${organizer}`)
      .send({ params: { ...params, mapId: "gen-a" }, seed: "semilla-42" });
    expect(a.status).toBe(201);
    const b = await request(app)
      .post("/maps/generate")
      .set("Authorization", `Bearer ${organizer}`)
      .send({ params: { ...params, mapId: "gen-a" }, seed: "semilla-42" });
    expect(b.status).toBe(201);
    expect(a.body.checksum).toBe(b.body.checksum);

    const c = await request(app)
      .post("/maps/generate")
      .set("Authorization", `Bearer ${organizer}`)
      .send({ params: { ...params, mapId: "gen-a" }, seed: "semilla-43" });
    expect(c.body.checksum).not.toBe(a.body.checksum);
  });
});

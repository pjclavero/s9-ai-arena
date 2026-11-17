/**
 * FROZEN-REUSE (B1-B7) · Una versión exacta y `frozen` se REUTILIZA en varios torneos.
 *
 * Decisión de producto: `frozen` = INMUTABLE (mismo código, hash y loadout para siempre,
 * replay reproducible), NO «usada una vez». La misma versión V del bot X entra en el torneo
 * A (published → frozen al cerrar A) y después en el torneo B: sin clonarla, sin
 * republicarla y sin descongelarla, y pasando TODAS las comprobaciones de elegibilidad.
 *
 * BD efímera (embedded-postgres) + replay REAL del motor (E2) para B6. Cada `it` deja
 * evidencia para un mutante de `scripts/mutants/frozen-reuse-mutants.mjs`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { createLoadoutRevision } from "./services/bots.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { ingestReplay } from "../../replay-service/src/store.js";

let h: TestDbHandle;
let app: Express;
let devTok: string;
let userTok: string;
let orgTok: string;
let adminTok: string;
let devId: string;
let userId: string;

const SUMMARY = { massKg: 0, costCredits: 0, energyBalanceEUs: 0 };
const L = (chassis: string, modules: { slot: string; moduleId: string; ammo?: string }[]) => ({
  catalogVersion: "mvp@1",
  chassis,
  modules,
});
/** Loadout VÁLIDO hoy (cañón con munición AP). */
const GOOD = L("chassis.medium@2", [
  { slot: "drive", moduleId: "movement.wheels@1" },
  { slot: "power", moduleId: "power.generator@2" },
  { slot: "sensor_a", moduleId: "sensor.radar@1" },
  { slot: "turret_main", moduleId: "weapon.cannon@1" },
  { slot: "ammo_main", moduleId: "ammo.ap@1" },
  { slot: "radio_a", moduleId: "radio.short@1" },
  { slot: "armor_front", moduleId: "armor.steel_front@1" },
]);
/** Loadout que hoy NO valida: cañón con munición estándar (INVALID_AMMO, clase functional). */
const BAD_AMMO = L("chassis.heavy@1", [
  { slot: "drive", moduleId: "movement.tracks@1" },
  { slot: "power", moduleId: "power.generator@2" },
  { slot: "sensor_a", moduleId: "sensor.radar@1" },
  { slot: "turret_main", moduleId: "weapon.cannon@1" },
  { slot: "ammo_main", moduleId: "ammo.standard@1" },
  { slot: "radio_a", moduleId: "radio.short@1" },
  { slot: "armor_front", moduleId: "armor.steel_front@1" },
]);
/** Otra revisión válida, posterior a la de la versión: una inscripción NO debe usarla. */
const GOOD_V2 = L("chassis.medium@2", [
  { slot: "drive", moduleId: "movement.wheels@1" },
  { slot: "power", moduleId: "power.generator@2" },
  { slot: "sensor_a", moduleId: "sensor.radar@1" },
  { slot: "turret_main", moduleId: "weapon.cannon@1" },
  { slot: "ammo_main", moduleId: "ammo.ap@1" },
  { slot: "radio_a", moduleId: "radio.short@1" },
]);

/** Bot con UNA versión v1 en `state`, anclada a la revisión 1 de `loadout`. */
async function mkBot(name: string, ownerId: string, state: string, loadout: object, visibility = "private") {
  const [bot] = await h.db("bots").insert({ name, owner_id: ownerId, visibility }).returning("*");
  await createLoadoutRevision(h.db, bot.id, loadout as never, SUMMARY);
  await h.db("bot_versions").insert({
    bot_id: bot.id,
    version: 1,
    state,
    runtime: "python",
    loadout_revision: 1,
    source: Buffer.from(`# ${name} v1\nprint("hola")\n`),
    source_filename: "bot.py",
    artifact_hash: `sha256:${name}-v1`,
    code_public: false,
    published_at: h.db.fn.now(),
  });
  return bot.id as string;
}

const as = (tok: string) => ({ Authorization: `Bearer ${tok}` });
const versionRow = (botId: string, version = 1) => h.db("bot_versions").where({ bot_id: botId, version }).first();
const versionCount = async (botId: string) =>
  Number((await h.db("bot_versions").where({ bot_id: botId }).count({ n: "*" }))[0].n);
const auditFor = (botId: string, version = 1) =>
  h
    .db("audit_log")
    .where({ target: `bot:${botId}@${version}` })
    .orderBy("id", "asc");

async function openTournament(name: string) {
  const r = await request(app)
    .post("/tournaments")
    .set(as(orgTok))
    .send({ name, format: "round_robin", mode: "deathmatch", rulesetId: DEFAULT_RULESET_ID });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
const enter = (tok: string, t: string, botId: string, version: number) =>
  request(app).post(`/tournaments/${t}/entries`).set(as(tok)).send({ botId, version });
const closeEntries = (t: string) =>
  request(app).post(`/tournaments/${t}/actions/close-entries`).set(as(orgTok)).send({});

/** Fila de la versión SIN cambiar nada: lo que debe seguir idéntico para siempre. */
const immutableView = (v: Record<string, unknown>) => ({
  id: v.id,
  bot_id: v.bot_id,
  version: v.version,
  state: v.state,
  runtime: v.runtime,
  loadout_revision: v.loadout_revision,
  source: Buffer.from(v.source as Buffer).toString("hex"),
  source_sha256: v.source_sha256,
  source_filename: v.source_filename,
  artifact_hash: v.artifact_hash,
  code_public: v.code_public,
  parent_version: v.parent_version ?? null,
  published_at: String(v.published_at),
});
const privacyView = async (botId: string) => {
  const b = await h.db("bots").where({ id: botId }).first();
  const vs = await h.db("bot_versions").where({ bot_id: botId }).orderBy("version").select("version", "code_public");
  return { visibility: b.visibility, owner_id: b.owner_id, team_id: b.team_id ?? null, versions: vs };
};

// ---------------------------------------------------------------- escenario
let X: string; // bot del developer: v1 published → frozen en A → reutilizada en B
let tA: string;
let tB: string;
let xV1Id: string;
let beforeB: ReturnType<typeof immutableView>;
let privacyBefore: Awaited<ReturnType<typeof privacyView>>;
let anonSourceBefore: number;
let replay: Replay;
let battleA: string;
let verifyA: Record<string, unknown>;

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  devTok = await tokenFor(h.db, DEV_USERS.developer);
  userTok = await tokenFor(h.db, DEV_USERS.user);
  orgTok = await tokenFor(h.db, DEV_USERS.organizer);
  adminTok = await tokenFor(h.db, DEV_USERS.admin);
  devId = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id;
  userId = (await h.db("users").where({ email: DEV_USERS.user }).first()).id;

  X = await mkBot("FR-X", devId, "published", GOOD);
  // Revisión de loadout POSTERIOR a la versión: la versión sigue anclada a la 1.
  await createLoadoutRevision(h.db, X, GOOD_V2 as never, SUMMARY);
  xV1Id = (await versionRow(X)).id;
  privacyBefore = await privacyView(X);
  anonSourceBefore = (await request(app).get(`/bots/${X}/versions/1/source`)).status;

  // ---- Torneo A: published → inscrita → cierre → frozen.
  tA = await openTournament("FR-A");
  const eA = await enter(devTok, tA, X, 1);
  expect(eA.status, JSON.stringify(eA.body)).toBe(201);
  const cA = await closeEntries(tA);
  expect(cA.status, JSON.stringify(cA.body)).toBe(200);

  // Batalla oficial del torneo A con un replay REAL (motor E2 + replay-service).
  replay = await record(
    {
      battleId: "frozen_reuse_A",
      seed: "frozen_reuse_A",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 200 }),
      map: emptyArena(),
      participants: [
        { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
        { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
      ],
    },
    (b) => {
      b.attachBot("v_red", new HunterBot("bot_red"));
      b.attachBot("v_blue", new HunterBot("bot_blue"));
    },
  );
  const stored = ingestReplay(mkdtempSync(join(tmpdir(), "frozen-reuse-")), replay, { official: true });
  const [bA] = await h
    .db("battles")
    .insert({
      status: "finished",
      official: true,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "frozen_reuse_A",
      tournament_id: tA,
      replay_ref: stored.path,
      replay_hash: stored.index.sha256,
      final_state_hash: replay.result.finalStateHash,
      engine_versions: JSON.stringify(replay.header.versions),
      result: JSON.stringify({ score: replay.result.score, ticks: replay.result.ticks }),
    })
    .returning("*");
  battleA = bA.id;
  await h.db("participants").insert({ battle_id: battleA, bot_id: X, version: 1, team: "red", outcome: "win" });
  const vA = await request(app).post(`/replays/${battleA}/verify`).set(as(adminTok));
  expect(vA.status, JSON.stringify(vA.body)).toBe(200);
  verifyA = vA.body;

  beforeB = immutableView(await versionRow(X));
  tB = await openTournament("FR-B");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("B2 · published → torneo A → frozen; la MISMA versión frozen → torneo B", () => {
  it("tras cerrar A la versión está frozen y se congeló UNA vez (auditado)", async () => {
    expect((await versionRow(X)).state).toBe("frozen");
    const freezes = (await auditFor(X)).filter((a: Record<string, unknown>) => a.action === "bot.version.freeze");
    expect(freezes).toHaveLength(1);
  });

  it("FROZEN_VERSION_REUSABLE: inscribir v1 (frozen) en B ⇒ 201 con la versión y el loadout EXACTOS", async () => {
    const r = await enter(devTok, tB, X, 1);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.version).toBe(1);
    expect(r.body.loadoutRevision).toBe(1);
    // B3 · la inscripción NO cambia el estado (ni lo republica ni lo descongela).
    expect((await versionRow(X)).state).toBe("frozen");
  });

  it("NO_IMPLICIT_CLONE: no aparece ninguna versión nueva del bot (ni hija de v1)", async () => {
    expect(await versionCount(X)).toBe(1);
    expect(await h.db("bot_versions").where({ bot_id: X, parent_version: 1 }).first()).toBeUndefined();
  });

  it("SAME_VERSION_ID_REUSED: las inscripciones de A y de B apuntan a la MISMA fila de bot_versions", async () => {
    const eA = await h.db("entries").where({ tournament_id: tA, bot_id: X }).first();
    const eB = await h.db("entries").where({ tournament_id: tB, bot_id: X }).first();
    expect([eA.version, eA.loadout_revision]).toEqual([1, 1]);
    expect([eB.version, eB.loadout_revision]).toEqual([eA.version, eA.loadout_revision]);
    const idOf = async (e: Record<string, unknown>) =>
      (await h.db("bot_versions").where({ bot_id: e.bot_id, version: e.version }).first()).id;
    expect(await idOf(eA)).toBe(xV1Id);
    expect(await idOf(eB)).toBe(xV1Id);
    // La inscripción de A sigue igual (congelada, misma versión).
    expect(eA.frozen).toBe(true);
  });

  it("B3 · cerrar B con la versión YA frozen ⇒ 200; no se transita, no se audita, la fila no cambia", async () => {
    const auditBefore = (await auditFor(X)).length;
    const c = await closeEntries(tB);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const after = immutableView(await versionRow(X));
    expect(after).toEqual(beforeB);
    expect(after.state).toBe("frozen");
    const trail = await auditFor(X);
    expect(trail.length).toBe(auditBefore);
    // Nunca hubo republicación ni «descongelado»: sólo la congelación de A.
    expect(trail.map((a: Record<string, unknown>) => a.action)).toEqual(["bot.version.freeze"]);
    expect((await h.db("entries").where({ tournament_id: tB, bot_id: X }).first()).frozen).toBe(true);
  });

  it("REPLAY_REFERENCES_STABLE: B referencia el mismo version_id y el replay de A verifica IGUAL después de B", async () => {
    const [bB] = await h
      .db("battles")
      .insert({
        status: "scheduled",
        official: true,
        mode: "deathmatch",
        ruleset_id: DEFAULT_RULESET_ID,
        map_id: "mvp-arena-01",
        map_version: 1,
        seed: "frozen_reuse_B",
        tournament_id: tB,
      })
      .returning("*");
    await h.db("participants").insert({ battle_id: bB.id, bot_id: X, version: 1, team: "red" });
    const pA = await h.db("participants").where({ battle_id: battleA, bot_id: X }).first();
    const pB = await h.db("participants").where({ battle_id: bB.id, bot_id: X }).first();
    const idOf = async (p: Record<string, unknown>) =>
      (await h.db("bot_versions").where({ bot_id: p.bot_id, version: p.version }).first()).id;
    expect(await idOf(pA)).toBe(xV1Id);
    expect(await idOf(pB)).toBe(xV1Id);

    const r = await request(app).post(`/replays/${battleA}/verify`).set(as(adminTok));
    expect(r.status).toBe(200);
    expect(r.body.matches).toBe(true);
    expect(r.body.valid).toBe(true);
    expect(r.body.officialHash).toBe(replay.result.finalStateHash);
    expect(r.body).toEqual(verifyA);
  }, 120_000);

  it("PRIVACY_PRESERVED: visibilidad, dueño, equipo y code_public intactos; un anónimo sigue sin ver el bot", async () => {
    expect(await privacyView(X)).toEqual(privacyBefore);
    expect(privacyBefore.visibility).toBe("private");
    const anon = await request(app).get(`/bots/${X}`);
    expect(anon.status).toBe(404);
    // El código sigue sin ser legible para un anónimo, con la MISMA respuesta que antes de A.
    const anonSrc = await request(app).get(`/bots/${X}/versions/1/source`);
    expect(anonSrc.status).not.toBe(200);
    expect(anonSrc.status).toBe(anonSourceBefore);
  });
});

describe("B7 · FROZEN_REMAINS_IMMUTABLE: una versión frozen no se edita ni se reemplaza", () => {
  it("editar su CÓDIGO ⇒ FAIL (bot_version_immutable)", async () => {
    await expect(
      h
        .db("bot_versions")
        .where({ bot_id: X, version: 1 })
        .update({ source: Buffer.from("print('otro')") }),
    ).rejects.toThrow(/bot_version_immutable/);
    await expect(
      h.db("bot_versions").where({ bot_id: X, version: 1 }).update({ source_filename: "otro.py" }),
    ).rejects.toThrow(/bot_version_immutable/);
    await expect(h.db("bot_versions").where({ bot_id: X, version: 1 }).update({ runtime: "node" })).rejects.toThrow(
      /bot_version_immutable/,
    );
  });

  it("editar su LOADOUT ⇒ FAIL (bot_version_immutable)", async () => {
    await expect(h.db("bot_versions").where({ bot_id: X, version: 1 }).update({ loadout_revision: 2 })).rejects.toThrow(
      /bot_version_immutable/,
    );
  });

  it("REEMPLAZARLA ⇒ FAIL: ni borrar, ni renumerar, ni insertar otra con el mismo número, ni cambiar su artefacto", async () => {
    await expect(h.db("bot_versions").where({ bot_id: X, version: 1 }).del()).rejects.toThrow(/bot_version_immutable/);
    await expect(h.db("bot_versions").where({ bot_id: X, version: 1 }).update({ version: 7 })).rejects.toThrow(
      /bot_version_immutable/,
    );
    await expect(
      h
        .db("bot_versions")
        .insert({ bot_id: X, version: 1, state: "published", runtime: "python", loadout_revision: 2 }),
    ).rejects.toThrow(/duplicate key|unique/i);
    await expect(
      h.db("bot_versions").where({ bot_id: X, version: 1 }).update({ artifact_hash: "sha256:otro" }),
    ).rejects.toThrow(/bot_version_immutable/);
  });

  it("por la API: ni republicar ni retirar una frozen (409 illegal_transition), y A cerrado no admite cambios", async () => {
    const pub = await request(app).post(`/bots/${X}/versions/1/actions/publish`).set(as(devTok)).send({});
    expect(pub.status).toBe(409);
    expect(pub.body.error).toBe("illegal_transition");
    const ret = await request(app).post(`/bots/${X}/versions/1/actions/retire`).set(as(devTok)).send({});
    expect(ret.status).toBe(409);
    expect(ret.body.error).toBe("illegal_transition");
    const again = await enter(devTok, tA, X, 1);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("entries_closed");
    expect(immutableView(await versionRow(X))).toEqual(beforeB);
  });
});

describe("B4 · ELIGIBILITY_RULES_PRESERVED: frozen reutilizable NO salta ninguna comprobación", () => {
  it("frozen INVÁLIDA (munición incompatible) ⇒ 409 bot_version_not_eligible con el motivo real; sin inscripción", async () => {
    const Z = await mkBot("FR-Z-BAD", devId, "frozen", BAD_AMMO);
    const t = await openTournament("FR-elig-bad");
    const r = await enter(devTok, t, Z, 1);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("bot_version_not_eligible");
    expect(r.body.notEligible[0]).toMatchObject({ botId: Z, version: 1, eligible: false, category: "INVALID_AMMO" });
    // OLA 2 (EQUIPMENT_PRIVATE) · quien inscribe es el DUEÑO: ve el motivo real de su
    // loadout (violaciones), no el veredicto genérico que recibe un tercero.
    expect(r.body.notEligible[0].violations.length).toBeGreaterThan(0);
    expect(r.body.message).not.toMatch(/la versión no es elegible\./);
    expect(await h.db("entries").where({ tournament_id: t, bot_id: Z }).first()).toBeUndefined();
    expect((await versionRow(Z)).state).toBe("frozen");
  });

  for (const state of ["suspended", "retired", "draft", "validated", "validating", "rejected"]) {
    it(`versión ${state} ⇒ 409 bot_not_published con currentState=${state}; sin inscripción`, async () => {
      const B = await mkBot(`FR-${state}`, devId, state, GOOD);
      const t = await openTournament(`FR-st-${state}`);
      const r = await enter(devTok, t, B, 1);
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("bot_not_published");
      expect(r.body.currentState).toBe(state);
      expect(await h.db("entries").where({ tournament_id: t, bot_id: B }).first()).toBeUndefined();
    });
  }

  it("versión inexistente ⇒ 409 bot_not_published (sin currentState)", async () => {
    const t = await openTournament("FR-noexiste");
    const r = await enter(devTok, t, X, 99);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("bot_not_published");
    expect(r.body.currentState).toBeUndefined();
  });

  it("propiedad: la frozen de OTRO dueño ⇒ 403 aunque sea válida", async () => {
    const t = await openTournament("FR-ajeno");
    const r = await enter(userTok, t, X, 1);
    expect(r.status).toBe(403);
    expect(await h.db("entries").where({ tournament_id: t, bot_id: X }).first()).toBeUndefined();
  });

  it("una vez por torneo: la misma frozen dos veces en el MISMO torneo ⇒ 409 already_entered", async () => {
    const t = await openTournament("FR-dos-veces");
    expect((await enter(devTok, t, X, 1)).status).toBe(201);
    const again = await enter(devTok, t, X, 1);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_entered");
  });

  it("frozen válida de otro dueño que también juega: cada dueño la suya (un bot del user entra con su frozen)", async () => {
    const U = await mkBot("FR-U", userId, "frozen", GOOD, "public");
    const t = await openTournament("FR-user");
    const r = await enter(userTok, t, U, 1);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await versionRow(U)).state).toBe("frozen");
  });

  it("battles: POST /battles con la frozen válida sigue aceptándose (misma regla de estado)", async () => {
    const O = await mkBot("FR-O", devId, "published", GOOD, "public");
    const r = await request(app)
      .post("/battles")
      .set(as(devTok))
      .send({
        mode: "deathmatch",
        rulesetId: DEFAULT_RULESET_ID,
        mapId: "mvp-arena-02",
        participants: [
          { botId: X, version: 1, team: "red" },
          { botId: O, version: 1, team: "blue" },
        ],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
  });
});

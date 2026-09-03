/**
 * CARRIL I · GATE DE EJECUCIÓN REAL — invariantes que deben poder COMPROBARSE
 * antes de encender `S9_ENABLE_REAL_BATTLE_RUNS`.
 *
 * Cubre lo que `battle-run.test.ts` (contrato del endpoint) no cubría: qué pasa
 * con el ESTADO y el RASTRO cuando la ejecución sí se lanza. Todo con un
 * `BattleRunLauncher` FAKE inyectado — NUNCA Docker real, nunca producción.
 *
 * Los tres invariantes:
 *   G-1 · RESERVA: dos lanzamientos simultáneos de la misma batalla no ejecutan
 *         dos batallas. La segunda recibe 409 y NO llega al launcher.
 *   G-2 · TECHO: por encima del techo de batallas en `running`, se rechaza con
 *         429 sin lanzar nada.
 *   G-3 · RASTRO: toda ejecución real deja `battle.run_started` +
 *         `battle.run_finished` en `audit_log` con el actor real.
 * Y el corolario de reversibilidad: un fallo (ordenado o excepción) DEVUELVE la
 * batalla a `scheduled` — no la deja atrapada en `running` sin que nadie la corra.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_USERS, DEV_PASSWORD, seedDev } from "./db/seeds/dev.js";
import { createApp } from "./app.js";
import { claimBattleForRun } from "./routes/battles.js";
import { battleRunConfigFromEnv, parseMaxConcurrentRuns, type BattleRunLauncher } from "./battle-run.js";

let h: TestDbHandle;
let adminId: string;
let catalogVersion: string;
let rulesetId: string;
const REAL_HASH = "sha256:" + "ab".repeat(32);

/** Launcher que se queda BLOQUEADO hasta que el test lo suelta: así hay una
 *  batalla realmente "en vuelo" mientras llega la segunda petición. */
function gatedRunner() {
  let release!: () => void;
  const started: string[] = [];
  const gate = new Promise<void>((r) => (release = r));
  const runner: BattleRunLauncher = {
    async launch(input) {
      started.push(input.battleId);
      await gate;
      return { status: "completed", runner: "fake", replay: { ingested: true, battleId: input.battleId } };
    },
  };
  return { runner, started, release: () => release() };
}

const okRunner: BattleRunLauncher = {
  async launch(input) {
    return {
      status: "completed",
      runner: "fake",
      replay: { ingested: true, battleId: input.battleId, verify_matches: true },
    };
  },
};

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  adminId = (await h.db("users").where({ email: DEV_USERS.admin }).first()).id;
  catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
  rulesetId = (await h.db("rulesets").first()).id;
}, 120000);
afterAll(async () => {
  await h.stop();
});

async function token(app: Express): Promise<string> {
  const r = await request(app).post("/auth/login").send({ email: DEV_USERS.admin, password: DEV_PASSWORD });
  return r.body.accessToken;
}

async function seedBot(name: string) {
  const id = randomUUID();
  await h.db("bots").insert({ id, name: `${name}-${id.slice(0, 8)}`, owner_id: adminId });
  await h.db("bot_loadouts").insert({
    bot_id: id,
    revision: 1,
    catalog_version: catalogVersion,
    chassis: "chassis.scout@1",
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

async function seedBattle(status = "scheduled"): Promise<string> {
  const a = await seedBot("bot_a");
  const b = await seedBot("bot_b");
  const [row] = await h
    .db("battles")
    .insert({
      status,
      official: false,
      mode: "deathmatch",
      ruleset_id: rulesetId,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "s",
    })
    .returning("*");
  await h.db("participants").insert([
    { battle_id: row.id, bot_id: a.botId, version: 1, team: "red" },
    { battle_id: row.id, bot_id: b.botId, version: 1, team: "blue" },
  ]);
  return row.id as string;
}

const statusOf = async (id: string) => (await h.db("battles").where({ id }).first()).status as string;
const auditFor = async (id: string) =>
  (await h
    .db("audit_log")
    .where({ target: `battle:${id}` })
    .orderBy("id")) as Array<Record<string, unknown>>;

// OJO: `audit_log` es de SOLO INSERCIÓN (trigger `audit_log_append_only`): no se
// puede limpiar entre tests. Por eso cada aserción filtra por el `target` de SU
// batalla, cuyo id es un UUID nuevo en cada test.
beforeEach(async () => {
  await h.db("participants").del();
  await h.db("battles").del();
});

describe("CARRIL I · G-1 reserva atómica de la batalla", () => {
  it("la reserva es ATÓMICA: N intentos en paralelo sobre la misma batalla, UNO solo se la lleva", async () => {
    const id = await seedBattle();
    // Directo contra la BD, sin la comprobación de estado previa de la ruta: eso
    // es lo que aísla la propiedad. Si el UPDATE no estuviera condicionado a
    // `scheduled`, los 8 dirían que sí y habría 8 batallas del mismo id.
    const results = await Promise.all(Array.from({ length: 8 }, () => claimBattleForRun(h.db, id)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await statusOf(id)).toBe("running");
    // Y una vez reservada, nadie más la reserva (ni siquiera más tarde).
    expect(await claimBattleForRun(h.db, id)).toBe(false);
  });

  it("dos lanzamientos simultáneos ejecutan UNA sola batalla: el segundo recibe 409 y no llega al launcher", async () => {
    const id = await seedBattle();
    const g = gatedRunner();
    const app = createApp({ db: h.db, realBattleRuns: { enabled: true, runner: g.runner, maxConcurrentRuns: 5 } });
    const auth = `Bearer ${await token(app)}`;
    // `.then()` es lo que hace que supertest ENVÍE la petición: sin él la primera
    // no saldría y el test comprobaría una carrera que nunca ocurrió.
    const first = request(app)
      .post(`/battles/${id}/run`)
      .set("Authorization", auth)
      .then((r) => r);
    // Se espera a que la primera esté DENTRO del launcher (reserva ya tomada), no
    // a un sleep fijo: la condición observable, no el reloj.
    const deadline = Date.now() + 10_000;
    while (g.started.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(g.started).toEqual([id]);

    const second = await request(app).post(`/battles/${id}/run`).set("Authorization", auth);
    g.release();
    const r1 = await first;

    expect(r1.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("invalid_state");
    // LO QUE IMPORTA: el launcher se invocó UNA vez. Un 409 que igualmente
    // hubiera lanzado la batalla no serviría de nada.
    expect(g.started).toEqual([id]);
  });

  it("una batalla completada queda en `running` (jugada), no vuelve a `scheduled` ni es relanzable", async () => {
    const id = await seedBattle();
    const app = createApp({ db: h.db, realBattleRuns: { enabled: true, runner: okRunner } });
    const auth = `Bearer ${await token(app)}`;
    expect((await request(app).post(`/battles/${id}/run`).set("Authorization", auth)).status).toBe(200);
    expect(await statusOf(id)).toBe("running");
    const again = await request(app).post(`/battles/${id}/run`).set("Authorization", auth);
    // 409 `invalid_state`: la comprobación de estado ya la ve `running`. Lo que
    // importa es que NO se relanza; el 429 del techo es la otra red, más abajo.
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("invalid_state");
  });

  it("un `failed` ordenado DEVUELVE la batalla a scheduled (reversible, no atrapada en running)", async () => {
    const id = await seedBattle();
    const failing: BattleRunLauncher = {
      async launch() {
        return { status: "failed", runner: "fake", errorCode: "map_not_published", error: "no publicado" };
      },
    };
    const app = createApp({ db: h.db, realBattleRuns: { enabled: true, runner: failing } });
    const r = await request(app)
      .post(`/battles/${id}/run`)
      .set("Authorization", `Bearer ${await token(app)}`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("failed");
    expect(await statusOf(id)).toBe("scheduled");
    expect((await h.db("battles").where({ id }).first()).started_at).toBeNull();
  });

  it("una EXCEPCIÓN del launcher también libera la reserva (el fallo no deja estado sucio)", async () => {
    const id = await seedBattle();
    const boom: BattleRunLauncher = {
      async launch() {
        throw new Error("arena-engine explotó");
      },
    };
    const app = createApp({ db: h.db, realBattleRuns: { enabled: true, runner: boom } });
    const r = await request(app)
      .post(`/battles/${id}/run`)
      .set("Authorization", `Bearer ${await token(app)}`);
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await statusOf(id)).toBe("scheduled");
    const actions = (await auditFor(id)).map((e) => e.action);
    expect(actions).toContain("battle.run_error");
  });
});

describe("CARRIL I · G-2 techo de batallas reales simultáneas", () => {
  it("con una batalla ya en `running`, el techo por defecto (1) rechaza la siguiente con 429 SIN lanzarla", async () => {
    await seedBattle("running"); // ocupa el único hueco
    const id = await seedBattle();
    const g = gatedRunner();
    const app = createApp({ db: h.db, realBattleRuns: { enabled: true, runner: g.runner } });
    const r = await request(app)
      .post(`/battles/${id}/run`)
      .set("Authorization", `Bearer ${await token(app)}`);
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("too_many_running_battles");
    expect(g.started).toEqual([]); // no se lanzó nada
    expect(await statusOf(id)).toBe("scheduled");
  });

  it("el rechazo por techo queda AUDITADO (un 429 silencioso no se puede investigar)", async () => {
    await seedBattle("running");
    const id = await seedBattle();
    const app = createApp({ db: h.db, realBattleRuns: { enabled: true, runner: okRunner } });
    await request(app)
      .post(`/battles/${id}/run`)
      .set("Authorization", `Bearer ${await token(app)}`);
    const events = await auditFor(id);
    expect(events.map((e) => e.action)).toEqual(["battle.run_rejected"]);
    expect(events[0].actor_id).toBe(adminId);
  });

  it("subir el techo permite la segunda batalla (el límite es configurable, no un muro)", async () => {
    await seedBattle("running");
    const id = await seedBattle();
    const app = createApp({ db: h.db, realBattleRuns: { enabled: true, runner: okRunner, maxConcurrentRuns: 2 } });
    const r = await request(app)
      .post(`/battles/${id}/run`)
      .set("Authorization", `Bearer ${await token(app)}`);
    expect(r.status).toBe(200);
  });

  it("el techo se lee del entorno solo si es un entero >= 1; la basura NO significa 'sin límite'", () => {
    expect(parseMaxConcurrentRuns("3")).toBe(3);
    for (const bad of [undefined, "", "  ", "0", "-3", "dos", "1.5", "Infinity", "1e999", "NaN"]) {
      expect(parseMaxConcurrentRuns(bad), `valor ${JSON.stringify(bad)}`).toBeUndefined();
    }
    expect(battleRunConfigFromEnv({ S9_MAX_CONCURRENT_REAL_BATTLE_RUNS: "dos" }).maxConcurrentRuns).toBeUndefined();
    expect(battleRunConfigFromEnv({ S9_MAX_CONCURRENT_REAL_BATTLE_RUNS: "4" }).maxConcurrentRuns).toBe(4);
  });
});

describe("CARRIL I · G-3 rastro de auditoría de una ejecución real", () => {
  it("una ejecución deja `battle.run_started` y `battle.run_finished` con actor, bots y desenlace", async () => {
    const id = await seedBattle();
    const app = createApp({ db: h.db, realBattleRuns: { enabled: true, runner: okRunner } });
    await request(app)
      .post(`/battles/${id}/run`)
      .set("Authorization", `Bearer ${await token(app)}`);
    const events = await auditFor(id);
    expect(events.map((e) => e.action)).toEqual(["battle.run_started", "battle.run_finished"]);
    for (const e of events) expect(e.actor_id).toBe(adminId);
    const started = typeof events[0].detail === "string" ? JSON.parse(events[0].detail as string) : events[0].detail;
    const finished = typeof events[1].detail === "string" ? JSON.parse(events[1].detail as string) : events[1].detail;
    // Quién jugó: sin los bots y su versión, un incidente no se puede acotar.
    expect(started.participants).toHaveLength(2);
    expect(started.mapId).toBe("mvp-arena-01");
    expect(finished).toMatchObject({ status: "completed", runner: "fake", replayIngested: true });
  });

  it("la ejecución NO auditada es imposible: sin llegar al launcher no hay run_started", async () => {
    const id = await seedBattle();
    const app = createApp({ db: h.db, realBattleRuns: { enabled: false, runner: okRunner } });
    await request(app)
      .post(`/battles/${id}/run`)
      .set("Authorization", `Bearer ${await token(app)}`);
    expect(await auditFor(id)).toEqual([]);
  });
});

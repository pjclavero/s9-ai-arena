/**
 * V1 · B4 · D-OP-18/19 · modificar datos DESPUÉS de inscribir no permite saltarse el presupuesto,
 * y `module_cost_cap_exceeded` bloquea inscripción y participación. BD efímera + API real.
 * Etiquetas B4_* para scripts/budget-ammo-mutants.mjs (cada una se pone roja sin su control).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { createLoadoutRevision } from "./services/bots.js";
import { evaluateTournamentBudget } from "./services/version-eligibility.js";
import { MAX_MODULE_COST_FRACTION } from "../../../packages/game-rules/index.js";

let h: TestDbHandle;
let app: Express;
let userTok: string;
let orgTok: string;
let userId: string;
let seq = 0;
const as = (tok: string) => ({ Authorization: `Bearer ${tok}` });
const SUMMARY = { massKg: 0, costCredits: 0, energyBalanceEUs: 0 };

/** 900 cr con la munición embebida (chasis medio 220, pieza más cara 220). */
const GUNNER = {
  catalogVersion: "mvp@1",
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "sensor_a", moduleId: "sensor.lidar360@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ],
};
/** 540 cr con la munición embebida (arquetipo explorador: chasis ligero 150, pieza más cara 150). */
const SCOUT = {
  catalogVersion: "mvp@1",
  chassis: "chassis.light@1",
  modules: [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "sensor_a", moduleId: "sensor.lidar_front@1" },
    { slot: "turret_main", moduleId: "weapon.mg@1", ammo: "ammo.standard@1" },
    { slot: "radio_a", moduleId: "radio.short@1" },
  ],
};
/** 485 cr: el chasis pesado (280) es el 58 % del total, así que el TOPE POR PIEZA decide antes que el total. */
const MINI = {
  catalogVersion: "mvp@1",
  chassis: "chassis.heavy@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@2" },
  ],
};

async function mkBot(loadout: object, version = 1, botId?: string): Promise<string> {
  let id = botId;
  if (!id) {
    const [bot] = await h
      .db("bots")
      .insert({ name: `b4t-${++seq}`, owner_id: userId, visibility: "private" })
      .returning("*");
    id = bot.id as string;
  }
  await createLoadoutRevision(h.db, id, loadout as never, SUMMARY);
  const rev = (await h.db("bot_loadouts").where({ bot_id: id }).max({ m: "revision" }).first()).m;
  await h.db("bot_versions").insert({
    bot_id: id,
    version,
    state: "published",
    runtime: "python",
    loadout_revision: rev,
    source: Buffer.from(`# b4 v${version}\n`),
    source_filename: "bot.py",
    artifact_hash: `sha256:b4-${id}-${version}`,
    code_public: false,
    published_at: h.db.fn.now(),
  });
  return id;
}
async function mkTournament(budgetCredits?: number) {
  const r = await request(app)
    .post("/tournaments")
    .set(as(orgTok))
    .send({
      name: `b4t-t-${++seq}`,
      format: "round_robin",
      mode: "deathmatch",
      rulesetId: "deathmatch-mvp",
      ...(budgetCredits ? { budgetCredits } : {}),
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
const enter = (t: string, botId: string, version = 1) =>
  request(app).post(`/tournaments/${t}/entries`).set(as(userTok)).send({ botId, version });
const close = (t: string) => request(app).post(`/tournaments/${t}/actions/close-entries`).set(as(orgTok)).send({});

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  userTok = await tokenFor(h.db, DEV_USERS.user);
  orgTok = await tokenFor(h.db, DEV_USERS.organizer);
  userId = (await h.db("users").where({ email: DEV_USERS.user }).first()).id;
}, 180_000);
afterAll(async () => {
  await h.stop();
});

describe("B4 · datos modificados DESPUÉS de inscribir no saltan el presupuesto (D-OP-18 b)", () => {
  it("B4_TAMPER_LOWER_BUDGET · bajar budgetCredits del torneo tras inscribir ⇒ el cierre no materializa al que se pasa", async () => {
    const [a, b] = [await mkBot(GUNNER), await mkBot(GUNNER)];
    const t = await mkTournament(900);
    expect((await enter(t, a)).status).toBe(201);
    expect((await enter(t, b)).status).toBe(201);
    await h.db("tournaments").where({ id: t }).update({ budget_credits: 500 });
    const r = await close(t);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toBe("entries_not_eligible");
    expect(r.body.message).toContain("presupuesto");
    expect(await h.db("entries").where({ tournament_id: t, frozen: true })).toHaveLength(0);
    expect((await h.db("tournaments").where({ id: t }).first()).state).toBe("open");
  });

  it("B4_TAMPER_LOADOUT_CONTENT · reescribir el contenido de la revisión inscrita ⇒ el cierre lo detecta", async () => {
    const a = await mkBot(SCOUT);
    const b = await mkBot(SCOUT);
    const t = await mkTournament(600);
    expect((await enter(t, a)).status).toBe(201);
    expect((await enter(t, b)).status).toBe(201);
    // Sin ningún trigger sobre bot_loadouts, alguien con acceso a BD abarata… o encarece la revisión.
    await h
      .db("bot_loadouts")
      .where({ bot_id: a, revision: 1 })
      .update({
        chassis: GUNNER.chassis,
        modules: JSON.stringify(GUNNER.modules),
      });
    const r = await close(t);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toBe("entries_not_eligible");
    expect(r.body.details?.notEligibleEntries?.length ?? r.body.notEligibleEntries?.length).toBe(1);
  });

  it("B4_TAMPER_VERSION · cambiar de versión a una más cara no entra: la inscripción sigue con la versión fijada", async () => {
    const a = await mkBot(SCOUT);
    const b = await mkBot(SCOUT);
    const t = await mkTournament(600);
    expect((await enter(t, a)).status).toBe(201);
    expect((await enter(t, b)).status).toBe(201);
    // El dueño publica una v2 de 900 cr e intenta cambiar la inscripción a ella.
    await mkBot(GUNNER, 2, a);
    const swap = await enter(t, a, 2);
    expect(swap.status, JSON.stringify(swap.body)).toBe(409);
    expect(swap.body.error).toBe("bot_version_not_eligible");
    const e = await h.db("entries").where({ tournament_id: t, bot_id: a }).first();
    expect(e.version).toBe(1);
    expect((await close(t)).status).toBe(200); // control: lo inscrito válido cierra
  });

  it("B4_TAMPER_REVISION_REPOINT · la revisión FIJADA manda aunque la versión apunte a otra revisión", async () => {
    // La versión (inmutable) apunta a la rev. 1 de 900 cr; la inscripción fijó la rev. 2 barata.
    const a = await mkBot(GUNNER);
    await createLoadoutRevision(h.db, a, SCOUT as never, SUMMARY);
    const verdict = await evaluateTournamentBudget(h.db, [{ botId: a, version: 1, loadoutRevision: 2 }], 600);
    expect([...verdict.values()][0].over).toBe(false);
    const current = await evaluateTournamentBudget(h.db, [{ botId: a, version: 1 }], 600);
    expect([...current.values()][0].over).toBe(true);
    // idempotente: repetir da lo mismo y no escribe
    const again = await evaluateTournamentBudget(h.db, [{ botId: a, version: 1, loadoutRevision: 2 }], 600);
    expect([...again.values()][0].costCredits).toBe([...verdict.values()][0].costCredits);
  });

  it("B4_CLOSE_UNBLOCK · lo que bloquea el cierre por presupuesto lo puede excluir el organizador", async () => {
    const [a, b, c] = [await mkBot(GUNNER), await mkBot(SCOUT), await mkBot(SCOUT)];
    const t = await mkTournament(900);
    for (const x of [a, b, c]) expect((await enter(t, x)).status).toBe(201);
    await h.db("tournaments").where({ id: t }).update({ budget_credits: 600 });
    expect((await close(t)).status).toBe(409);
    const entry = await h.db("entries").where({ tournament_id: t, bot_id: a }).first();
    const ex = await request(app)
      .post(`/tournaments/${t}/entries/${entry.id}/actions/exclude`)
      .set(as(orgTok))
      .send({ reason: "supera el presupuesto del torneo" });
    expect(ex.status, JSON.stringify(ex.body)).toBe(200);
    expect((await close(t)).status).toBe(200);
  });
});

describe("B4 · module_cost_cap_exceeded en torneos con presupuesto (D-OP-19)", () => {
  // Tope por pieza = presupuesto × MAX_MODULE_COST_FRACTION (contrato vigente de validateLoadout), con la
  // MISMA expresión en coma flotante que el validador (nada de aritmética propia).
  const PIECE = 280;
  const MIN_BUDGET = (() => {
    let b = 485;
    while (b * MAX_MODULE_COST_FRACTION < PIECE) b++;
    return b;
  })();

  it("B4_CAP_EXACT · coste de la pieza = tope ⇒ permitido; un crédito menos de presupuesto ⇒ rechazado SÓLO por el tope", async () => {
    expect(MIN_BUDGET).toBeGreaterThan(485); // el total (485) cabe: aísla el tope por pieza
    const bot = await mkBot(MINI);
    const ok = await enter(await mkTournament(MIN_BUDGET), bot);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const low = await enter(await mkTournament(MIN_BUDGET - 1), bot);
    expect(low.status, JSON.stringify(low.body)).toBe(409);
    expect(low.body.error).toBe("bot_version_not_eligible");
    expect(JSON.stringify(low.body)).toContain("module_cost_cap_exceeded");
    expect(JSON.stringify(low.body)).not.toContain('"budget_exceeded"');
  });

  it("B4_CAP_MESSAGE · el mensaje dice el tope, no sólo el total", async () => {
    const bot = await mkBot(MINI);
    const low = await enter(await mkTournament(MIN_BUDGET - 1), bot);
    expect(low.body.message).toContain("chassis.heavy");
  });

  it("B4_CAP_CLOSE · el tope por pieza también bloquea el cierre si el presupuesto baja tras inscribir", async () => {
    const [a, b] = [await mkBot(MINI), await mkBot(MINI)];
    const t = await mkTournament(MIN_BUDGET);
    expect((await enter(t, a)).status).toBe(201);
    expect((await enter(t, b)).status).toBe(201);
    await h
      .db("tournaments")
      .where({ id: t })
      .update({ budget_credits: MIN_BUDGET - 1 });
    const r = await close(t);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toBe("entries_not_eligible");
  });

  it("B4_CAP_NO_BUDGET · sin presupuesto propio no hay tope de torneo (nada nuevo)", async () => {
    const bot = await mkBot(MINI);
    expect((await enter(await mkTournament(), bot)).status).toBe(201);
  });

  it("B4_CAP_NULL_COST · un coste nulo o ausente cuenta 0 y no lanza ni bloquea", async () => {
    const { loadoutCostCredits } = await import("../../../packages/module-catalog/validator/index.js");
    const { getCatalog } = await import("./services/catalog.js");
    const catalog = (await getCatalog(h.db, "mvp@1")).map((m) =>
      m.id === "weapon.mg" ? ({ ...m, costCredits: undefined as unknown as number } as typeof m) : m,
    );
    expect(() => loadoutCostCredits(SCOUT, catalog)).not.toThrow();
    expect(loadoutCostCredits(SCOUT, catalog)).toBe(540 - 90);
  });

  it("B4_CAP_LEGACY_CATALOG · un equipamiento del catálogo antiguo mvp@1 se evalúa con SU catálogo", async () => {
    const bot = await mkBot(SCOUT);
    const v = [...(await evaluateTournamentBudget(h.db, [{ botId: bot, version: 1 }], 600)).values()][0];
    expect(v.costCredits).toBe(540);
    expect(v.over).toBe(false);
  });
});

/**
 * ELIG-REVIEW (ronda 2, sujeto ad5c502) · Intentos de romper lo NUEVO: exclusión de
 * inscripciones, otras formas de uuid y el fallo cerrado. BD efímera.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { Knex } from "knex";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { createLoadoutRevision } from "./services/bots.js";
import { canonicalUuid, excludeTournamentEntry } from "./services/version-eligibility.js";

let h: TestDbHandle;
let app: Express;
let devTok: string;
let userTok: string;
let orgTok: string;
let adminTok: string;
let devId: string;
let userId: string;
let orgId: string;

const SUMMARY = { massKg: 0, costCredits: 0, energyBalanceEUs: 0 };
const L = (chassis: string, modules: { slot: string; moduleId: string; ammo?: string }[]) => ({
  catalogVersion: "mvp@1",
  chassis,
  modules,
});
const defender = (ammo: string, power: string) =>
  L("chassis.heavy@1", [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: power },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1" },
    { slot: "ammo_main", moduleId: ammo },
    { slot: "radio_a", moduleId: "radio.short@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ]);
const ATK = L("chassis.medium@2", [
  { slot: "drive", moduleId: "movement.wheels@1" },
  { slot: "power", moduleId: "power.generator@2" },
  { slot: "sensor_a", moduleId: "sensor.radar@1" },
  { slot: "turret_main", moduleId: "weapon.cannon@1" },
  { slot: "ammo_main", moduleId: "ammo.ap@1" },
  { slot: "radio_a", moduleId: "radio.short@1" },
  { slot: "armor_front", moduleId: "armor.steel_front@1" },
]);

async function histBot(name: string, ownerId: string, revs: object[], versionRevs: number[], visibility = "private") {
  const [bot] = await h.db("bots").insert({ name, owner_id: ownerId, visibility }).returning("*");
  for (const r of revs) await createLoadoutRevision(h.db, bot.id, r as never, SUMMARY);
  for (const [i, rev] of versionRevs.entries()) {
    await h.db("bot_versions").insert({
      bot_id: bot.id,
      version: i + 1,
      state: "published",
      runtime: "python",
      loadout_revision: rev,
      artifact_hash: `hash-${name}-${i + 1}`,
      published_at: h.db.fn.now(),
    });
  }
  return bot.id as string;
}

let aDef: string;
let atk: string;
let userBot: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  devTok = await tokenFor(h.db, DEV_USERS.developer);
  userTok = await tokenFor(h.db, DEV_USERS.user);
  orgTok = await tokenFor(h.db, DEV_USERS.organizer);
  adminTok = await tokenFor(h.db, DEV_USERS.admin);
  devId = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id;
  userId = (await h.db("users").where({ email: DEV_USERS.user }).first()).id;
  orgId = (await h.db("users").where({ email: DEV_USERS.organizer }).first()).id;
  const bad = defender("ammo.standard@1", "power.generator@2");
  const good = defender("ammo.ap@1", "power.generator@1");
  aDef = await histBot("A-DEF", devId, [bad, good], [1, 1, 2]);
  atk = await histBot("A-ATK-1", devId, [ATK], [1]);
  userBot = await histBot("U-BOT", userId, [ATK], [1]);
}, 120_000);

afterAll(async () => {
  await h.stop();
});

const as = (tok: string) => ({ Authorization: `Bearer ${tok}` });
const battle = (ps: { botId: unknown; version: unknown; team: string }[]) => ({
  mode: "deathmatch",
  rulesetId: DEFAULT_RULESET_ID,
  mapId: "mvp-arena-02",
  participants: ps,
});
const nBattles = async () => Number((await h.db("battles").count({ n: "*" }))[0].n);

async function openTournament(name: string) {
  const r = await request(app)
    .post("/tournaments")
    .set(as(orgTok))
    .send({ name, format: "round_robin", mode: "deathmatch", rulesetId: DEFAULT_RULESET_ID });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
async function rawEntry(t: string, botId: string, version: number, rev: number, frozen = false) {
  const [e] = await h
    .db("entries")
    .insert({ tournament_id: t, bot_id: botId, version, loadout_revision: rev, frozen })
    .returning("*");
  return e.id as string;
}
const exclude = (tok: string, t: string, e: string, body: object = { reason: "revisión" }) =>
  request(app).post(`/tournaments/${t}/entries/${e}/actions/exclude`).set(as(tok)).send(body);

describe("R10 · otras formas de uuid en POST /battles", () => {
  const variants = (id: string) => ({
    mayusculasParciales: id.slice(0, 9).toUpperCase() + id.slice(9),
    sinGuiones: id.replace(/-/g, ""),
    guionesRaros: id
      .replace(/-/g, "")
      .replace(/(.{4})/g, "$1-")
      .replace(/-$/, ""),
    espacios: `  ${id}  `,
    llavesMayus: `{${id.toUpperCase()}}`,
  });
  for (const k of ["mayusculasParciales", "sinGuiones", "guionesRaros", "espacios", "llavesMayus"] as const) {
    it(`${k}: nunca 202 con A-DEF v2`, async () => {
      const before = await nBattles();
      const botId = variants(aDef)[k];
      const r = await request(app)
        .post("/battles")
        .set(as(devTok))
        .send(
          battle([
            { botId, version: 2, team: "red" },
            { botId: atk, version: 1, team: "blue" },
          ]),
        );
      expect([400, 404, 409], `${k} ${botId} → ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);
      expect(await nBattles()).toBe(before);
    });
  }

  for (const [k, botId] of [
    ["fullwidth (unicode)", "８９４７a8b3-e6c5-4118-aba2-edb71022a556"],
    ["uuid inválido", "not-a-uuid"],
    ["uuid con 31 hex", "8947a8b3-e6c5-4118-aba2-edb71022a55"],
    ["cero", "00000000-0000-0000-0000-000000000000"],
    ["NUL incrustado", "8947a8b3-e6c5-4118-aba2-edb71022a556\u0000"],
  ] as const) {
    it(`${k} → 400/404, nunca 500 ni 202`, async () => {
      const before = await nBattles();
      const r = await request(app)
        .post("/battles")
        .set(as(devTok))
        .send(
          battle([
            { botId, version: 2, team: "red" },
            { botId: atk, version: 1, team: "blue" },
          ]),
        );
      expect([400, 404], `${k} → ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);
      expect(await nBattles()).toBe(before);
    });
  }

  it("el mismo bot en dos formas → 400 (no 500 por la PK)", async () => {
    const r = await request(app)
      .post("/battles")
      .set(as(devTok))
      .send(
        battle([
          { botId: atk, version: 1, team: "red" },
          { botId: atk.toUpperCase(), version: 1, team: "blue" },
        ]),
      );
    expect(r.status, JSON.stringify(r.body)).toBe(400);
  });

  it("canonicalUuid no convierte en uuid lo que PG no aceptaría como tal (fullwidth)", () => {
    expect(canonicalUuid("８９４７a8b3-e6c5-4118-aba2-edb71022a556")).toBe("８９４７a8b3-e6c5-4118-aba2-edb71022a556");
  });
});

describe("R11 · exclusión de inscripciones", () => {
  it("organizador NO excluye una inscripción elegible (409) ni deja rastro", async () => {
    const t = await openTournament("x-eleg");
    const e = await rawEntry(t, atk, 1, 1);
    const r = await exclude(orgTok, t, e);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(await h.db("entries").where({ id: e })).toHaveLength(1);
    expect(
      await h.db("audit_log").where({ action: "tournament.entry.excluded", target: `tournament:${t}` }),
    ).toHaveLength(0);
  });

  it("dueño de OTRO bot (no organizador) → 403, y uuid de entry inválido → 404 (no 500)", async () => {
    const t = await openTournament("x-tercero");
    const e = await rawEntry(t, aDef, 1, 1);
    expect((await exclude(userTok, t, e)).status).toBe(403);
    expect((await exclude(userTok, t, "not-a-uuid")).status).toBe(404);
    expect((await exclude(orgTok, "not-a-uuid", e)).status).toBe(404);
    expect(await h.db("entries").where({ id: e })).toHaveLength(1);
  });

  it("entry de OTRO torneo con el tournamentId de éste → 404", async () => {
    const t1 = await openTournament("x-t1");
    const t2 = await openTournament("x-t2");
    const e = await rawEntry(t1, aDef, 1, 1);
    expect((await exclude(orgTok, t2, e)).status).toBe(404);
  });

  it("congelada, torneo cerrado/en curso/finalizado → 409 y nada se borra", async () => {
    const t = await openTournament("x-frozen");
    const e = await rawEntry(t, aDef, 1, 1, true);
    expect((await exclude(orgTok, t, e)).status).toBe(409);
    expect((await exclude(devTok, t, e)).status).toBe(409);
    for (const state of ["closed", "running", "finished"]) {
      const t2 = await openTournament(`x-${state}`);
      const e2 = await rawEntry(t2, aDef, 1, 1);
      await h.db("tournaments").where({ id: t2 }).update({ state });
      expect((await exclude(orgTok, t2, e2)).status, state).toBe(409);
      expect((await exclude(devTok, t2, e2)).status, state).toBe(409);
      expect(await h.db("entries").where({ id: e2 }), state).toHaveLength(1);
    }
  });

  it("sin reason / reason no string / >256 → 400", async () => {
    const t = await openTournament("x-reason");
    const e = await rawEntry(t, aDef, 1, 1);
    expect((await exclude(orgTok, t, e, {})).status).toBe(400);
    expect((await exclude(orgTok, t, e, { reason: 5 })).status).toBe(400);
    expect((await exclude(orgTok, t, e, { reason: "x".repeat(257) })).status).toBe(400);
    expect((await exclude(orgTok, t, e, { reason: "   " })).status).toBe(400);
  });

  it("organizador excluye la NO elegible: borrada + audit_log completo (actor, motivo, versión, rev, cuándo)", async () => {
    const t = await openTournament("x-ok");
    const e = await rawEntry(t, aDef, 1, 1);
    const r = await exclude(orgTok, t, e, { reason: "versión no elegible" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await h.db("entries").where({ id: e })).toHaveLength(0);
    const a = await h.db("audit_log").where({ action: "tournament.entry.excluded", target: `tournament:${t}` });
    expect(a).toHaveLength(1);
    const d = typeof a[0].detail === "string" ? JSON.parse(a[0].detail) : a[0].detail;
    expect(a[0].actor_id).toBe(orgId);
    expect(a[0].created_at ?? a[0].at ?? a[0].timestamp).toBeTruthy();
    expect(d).toMatchObject({
      entryId: e,
      botId: aDef,
      version: 1,
      loadoutRevision: 1,
      by: "organizer",
      reason: "versión no elegible",
      eligible: false,
    });
    // El organizador no ve el loadout del bot privado ajeno en la respuesta.
    expect(JSON.stringify(r.body)).not.toMatch(/ammo|weapon|cannon/);
    // Repetir → 404 (ya no existe), no 500.
    expect((await exclude(orgTok, t, e)).status).toBe(404);
  });

  it("dueño retira la suya (aunque sea elegible) → 200 auditado como owner", async () => {
    const t = await openTournament("x-owner");
    const e = await rawEntry(t, userBot, 1, 1);
    const r = await exclude(userTok, t, e, { reason: "me retiro" });
    expect(r.status).toBe(200);
    expect(r.body.by).toBe("owner");
  });

  it("admin sin ser dueño: igual que organizador (sólo no elegibles)", async () => {
    const t = await openTournament("x-admin");
    const e = await rawEntry(t, atk, 1, 1);
    expect((await exclude(adminTok, t, e)).status).toBe(409);
  });

  it("TOCTOU: si el dueño sustituye por una versión ELEGIBLE entre la comprobación y el borrado, el organizador NO debe borrarla", async () => {
    const t = await openTournament("x-toctou");
    const e = await rawEntry(t, aDef, 1, 1);
    // Ventana determinista: el dueño cambia la inscripción a v3 (elegible) justo antes
    // de que se abra la transacción de borrado del organizador.
    const racy = new Proxy(h.db, {
      get(target, prop, recv) {
        if (prop === "transaction") {
          return async (fn: (trx: Knex.Transaction) => Promise<unknown>) => {
            await target("entries").where({ id: e }).update({ version: 3, loadout_revision: 2 });
            return target.transaction(fn);
          };
        }
        return Reflect.get(target, prop, recv);
      },
      apply(target, thisArg, args) {
        return Reflect.apply(target as never, thisArg, args);
      },
    }) as unknown as Knex;
    const out = await excludeTournamentEntry(racy, { userId: orgId, isOrganizer: true }, t, e, "carrera").then(
      () => "borrada",
      (err: { status?: number }) => `rechazada ${err.status}`,
    );
    const left = await h.db("entries").where({ id: e }).first();
    expect({ out, left: left ? { version: left.version } : null }).toEqual({
      out: "rechazada 409",
      left: { version: 3 },
    });
  });

  it("R12 · carrera: se congela entre la evaluación y el bloqueo → 409 y nada se borra ni audita", async () => {
    const t = await openTournament("x-frozen-race");
    const e = await rawEntry(t, aDef, 1, 1);
    const racy = new Proxy(h.db, {
      get(target, prop, recv) {
        if (prop === "transaction") {
          return async (fn: (trx: Knex.Transaction) => Promise<unknown>) => {
            await target("entries").where({ id: e }).update({ frozen: true });
            return target.transaction(fn);
          };
        }
        return Reflect.get(target, prop, recv);
      },
      apply(target, thisArg, args) {
        return Reflect.apply(target as never, thisArg, args);
      },
    }) as unknown as Knex;
    const out = await excludeTournamentEntry(racy, { userId: orgId, isOrganizer: true }, t, e, "carrera").then(
      () => "borrada",
      (err: { status?: number }) => `rechazada ${err.status}`,
    );
    expect(out).toBe("rechazada 409");
    expect(await h.db("entries").where({ id: e })).toHaveLength(1);
    expect(
      await h.db("audit_log").where({ action: "tournament.entry.excluded", target: `tournament:${t}` }),
    ).toHaveLength(0);
  });

  it("R12 · exclusión SIMULTÁNEA dueño + organizador (x5): exactamente una gana, un solo audit, nunca 500", async () => {
    for (let i = 0; i < 5; i++) {
      const t = await openTournament(`x-sim-${i}`);
      const e = await rawEntry(t, aDef, 1, 1);
      const rs = await Promise.all([
        exclude(devTok, t, e, { reason: "dueño" }),
        exclude(orgTok, t, e, { reason: "organizador" }),
      ]);
      const st = rs.map((r) => r.status).sort();
      expect(
        st.filter((s) => s === 200),
        JSON.stringify(st),
      ).toHaveLength(1);
      expect(
        st.every((s) => [200, 404, 409].includes(s)),
        JSON.stringify(st),
      ).toBe(true);
      expect(await h.db("entries").where({ id: e })).toHaveLength(0);
      expect(
        await h.db("audit_log").where({ action: "tournament.entry.excluded", target: `tournament:${t}` }),
      ).toHaveLength(1);
    }
  });

  it("R12 · exclusión simultánea con sustitución del dueño y con closeEntries: sin deadlock ni 500, estado coherente", async () => {
    for (let i = 0; i < 5; i++) {
      const t = await openTournament(`x-mix-${i}`);
      const e = await rawEntry(t, aDef, 1, 1);
      await rawEntry(t, atk, 1, 1);
      const [ex, rep, close] = await Promise.all([
        exclude(orgTok, t, e, { reason: "organizador" }),
        request(app).post(`/tournaments/${t}/entries`).set(as(devTok)).send({ botId: aDef, version: 3 }),
        request(app).post(`/tournaments/${t}/actions/close-entries`).set(as(orgTok)).send({}),
      ]);
      const sts = [ex.status, rep.status, close.status];
      expect(
        sts.every((s) => s < 500),
        JSON.stringify(sts),
      ).toBe(true);
      const left = await h.db("entries").where({ tournament_id: t, bot_id: aDef }).first();
      const audits = await h.db("audit_log").where({ action: "tournament.entry.excluded", target: `tournament:${t}` });
      // Si se excluyó, no queda inscripción y hay un audit; si no, sigue (v1 o v3) y no hay audit.
      if (ex.status === 200) {
        // Orden serializable legítimo: excluida y, DESPUÉS, el dueño se reinscribe con v3 (201, otra fila).
        if (left)
          expect({ rep: rep.status, nueva: left.id !== e, v: Number(left.version) }).toEqual({
            rep: 201,
            nueva: true,
            v: 3,
          });
        expect(audits).toHaveLength(1);
      } else {
        expect(left, JSON.stringify(sts)).toBeTruthy();
        expect(audits).toHaveLength(0);
      }
      // Nunca se cierra con la versión no elegible dentro.
      const tt = await h.db("tournaments").where({ id: t }).first();
      if (tt.state === "closed" && left) expect(Number(left.version), JSON.stringify(sts)).toBe(3);
    }
  });
});

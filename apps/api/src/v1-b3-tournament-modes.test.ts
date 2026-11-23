/**
 * B3 (V1, D-OP-9) · CTF y control de zona FUERA de los torneos (API).
 *
 *  B3_CTF_CLASSIC / B3_ZONE_CLASSIC   modo excluido con reglas clásicas -> 400 estable, sin fila.
 *  B3_CTF_PRESET / B3_ZONE_CUSTOM     con `rules` (preset o personalizado) -> 400 estable, sin fila.
 *  B3_RULES_MISMATCH                  modo permitido + reglas de CTF -> sigue sin crear fila (409).
 *  B3_RULESET_CROSS_*                 modo permitido + ruleset de plataforma que juega CTF/zona -> 400.
 *  B3_ALLOWED_OK                      Deathmatch y Deathmatch por equipos se siguen creando (201).
 *  B3_NO_OTHER_ROUTE                  no existe edición, clonado ni plantilla de torneos.
 *  B3_HISTORIC_VISIBLE                un torneo antiguo con CTF se sigue leyendo (detalle y listado).
 *  B3_OPENAPI                         el 400 está documentado.
 *  B3_SINGLE_SOURCE                   la lista permitida es una sola.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { loadContract } from "./openapi.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { TOURNAMENT_ALLOWED_MODES } from "../../tournament-worker/src/tournament-modes.js";

let h: TestDbHandle;
let app: Express;
let organizer: string;
let seq = 0;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  organizer = await tokenFor(h.db, DEV_USERS.organizer);
}, 180_000);

afterAll(async () => {
  await h.stop();
});

const count = async () => Number((await h.db("tournaments").count("* as n").first())?.n);
const create = (body: Record<string, unknown>) =>
  request(app)
    .post("/tournaments")
    .set(bearer(organizer))
    .send({ name: `b3-${++seq}`, format: "round_robin", ...body });

async function expectRejected(body: Record<string, unknown>, status = 400, code = "tournament_mode_not_allowed") {
  const before = await count();
  const r = await create(body);
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body.error).toBe(code);
  expect(await count()).toBe(before); // nada a medias
  return r;
}

describe("B3 · crear torneos con modos excluidos", () => {
  it("B3_CTF_CLASSIC · capture_the_flag sin reglas -> 400 tournament_mode_not_allowed con motivo y lista", async () => {
    const r = await expectRejected({ mode: "capture_the_flag", rulesetId: "capture-the-flag-mvp" });
    expect(r.body.mode).toBe("capture_the_flag");
    expect(r.body.allowedModes).toEqual(["deathmatch", "team_deathmatch"]);
    expect(String(r.body.message)).toMatch(/no está disponible en torneos/);
  });

  it("B3_ZONE_CLASSIC · zone_control sin reglas -> 400 tournament_mode_not_allowed", async () => {
    await expectRejected({ mode: "zone_control", rulesetId: "zone-control-mvp" });
  });

  it("B3_CTF_FOREIGN_RULESET · capture_the_flag con el ruleset de OTRO modo (antes se creaba con reglas nulas) -> 400", async () => {
    await expectRejected({ mode: "capture_the_flag", rulesetId: "deathmatch-mvp" });
    await expectRejected({ mode: "zone_control", rulesetId: "deathmatch-mvp" });
  });

  it("B3_CTF_PRESET · capture_the_flag con preset oficial -> 400 tournament_mode_not_allowed", async () => {
    await expectRejected({
      mode: "capture_the_flag",
      rulesetId: "capture-the-flag-mvp",
      rules: { preset: "ctf", teamSize: 2 },
    });
  });

  it("B3_ZONE_CUSTOM · zone_control con reglas personalizadas -> 400 tournament_mode_not_allowed", async () => {
    await expectRejected({
      mode: "zone_control",
      rulesetId: "zone-control-mvp",
      rules: { preset: "custom", teamSize: 2, params: { game: "zone_control" } },
    });
  });

  it("B3_RULES_MISMATCH · un modo permitido con un preset de CTF no crea nada (409 rules_mode_mismatch)", async () => {
    await expectRejected(
      { mode: "deathmatch", rulesetId: "deathmatch-mvp", rules: { preset: "ctf", teamSize: 2 } },
      409,
      "rules_mode_mismatch",
    );
  });

  it("B3_RULESET_CROSS_CTF · Deathmatch con el ruleset de plataforma de CTF -> 400 tournament_mode_not_allowed", async () => {
    const r = await expectRejected({ mode: "deathmatch", rulesetId: "capture-the-flag-mvp" });
    expect(r.body.engineRulesetId).toBe("ctf_mvp@1");
  });

  it("B3_RULESET_CROSS_ZONE · Deathmatch por equipos con el ruleset de zona -> 400 tournament_mode_not_allowed", async () => {
    await expectRejected({
      mode: "team_deathmatch",
      format: "teams",
      rulesetId: "zone-control-mvp",
      rules: { preset: "team_deathmatch", teamSize: 2 },
    });
  });

  it("B3_UNKNOWN_MODE · un modo inexistente sigue siendo 400 bad_request", async () => {
    await expectRejected({ mode: "no_existe", rulesetId: "deathmatch-mvp" }, 400, "bad_request");
  });

  it("B3_ALLOWED_OK · Deathmatch y Deathmatch por equipos se siguen creando (control positivo)", async () => {
    const dm = await create({ mode: "deathmatch", rulesetId: "deathmatch-mvp" });
    expect(dm.status, JSON.stringify(dm.body)).toBe(201);
    const tdm = await create({
      mode: "team_deathmatch",
      format: "teams",
      rulesetId: "team-deathmatch-mvp",
      rules: { preset: "team_deathmatch", teamSize: 2 },
    });
    expect(tdm.status, JSON.stringify(tdm.body)).toBe(201);
  });
});

describe("B3 · no hay otras vías para conseguir un torneo con modo excluido", () => {
  it("B3_NO_OTHER_ROUTE · el contrato no tiene edición, clonado ni plantillas de torneos", async () => {
    const spec = loadContract().raw.paths as Record<string, Record<string, unknown>>;
    const paths = Object.keys(spec);
    const tp = paths.filter((p) => p.startsWith("/tournaments"));
    expect(tp.filter((p) => /clone|duplicate|template|rematch/i.test(p))).toEqual([]);
    // Sin edición del torneo en sí (los PUT/DELETE que existen cuelgan de sub-rutas: consentimientos de equipo).
    for (const m of ["put", "patch", "delete"]) {
      expect(
        spec["/tournaments/{tournamentId}"]?.[m],
        `${m.toUpperCase()} /tournaments/{tournamentId}`,
      ).toBeUndefined();
    }
    // Sólo `createTournament` inserta torneos: cualquier otro POST de /tournaments es una acción sobre uno existente.
    const creators = tp.filter((p) => spec[p].post && !p.includes("{tournamentId}"));
    expect(creators).toEqual(["/tournaments"]);
  });

  it("B3_NO_EDIT_ROUTE · PATCH/PUT sobre un torneo no existen en la API real (404/405)", async () => {
    const ok = await create({ mode: "deathmatch", rulesetId: "deathmatch-mvp" });
    for (const m of ["patch", "put"] as const) {
      const r = await request(app)
        [m](`/tournaments/${ok.body.id}`)
        .set(bearer(organizer))
        .send({ mode: "capture_the_flag" });
      expect([404, 405], `${m} -> ${r.status}`).toContain(r.status);
    }
    const t = await h.db("tournaments").where({ id: ok.body.id }).first();
    expect(t.mode).toBe("deathmatch");
  });
});

describe("B3 · los torneos existentes no se tocan", () => {
  it("B3_HISTORIC_VISIBLE · un torneo antiguo con CTF se sigue leyendo en detalle y en listado", async () => {
    const ok = await create({ mode: "deathmatch", rulesetId: "deathmatch-mvp", name: "historico-ctf" });
    await h.db("tournaments").where({ id: ok.body.id }).update({ mode: "capture_the_flag" });
    const g = await request(app).get(`/tournaments/${ok.body.id}`);
    expect(g.status).toBe(200);
    expect(g.body.mode).toBe("capture_the_flag");
    const l = await request(app).get("/tournaments").query({ limit: 100 });
    expect(l.status).toBe(200);
    expect(
      l.body.items.some((t: { id: string; mode: string }) => t.id === ok.body.id && t.mode === "capture_the_flag"),
    ).toBe(true);
    // Y se puede seguir cancelando (no queda inmovilizado por la restricción).
    const c = await request(app).post(`/tournaments/${ok.body.id}/actions/cancel`).set(bearer(organizer)).send({});
    expect(c.status, JSON.stringify(c.body)).toBe(200);
  });
});

describe("B3 · contrato y fuente única", () => {
  it("B3_OPENAPI · createTournament documenta el 400 tournament_mode_not_allowed", async () => {
    const spec = loadContract().raw as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
      components: { schemas: { TournamentInput: { properties: { mode: { description: string } } } } };
    };
    expect(spec.paths["/tournaments"].post.responses["400"].description).toMatch(/tournament_mode_not_allowed/);
    expect(spec.components.schemas.TournamentInput.properties.mode.description).toMatch(/tournament_mode_not_allowed/);
  });

  it("B3_SINGLE_SOURCE · la lista permitida es exactamente Deathmatch y Deathmatch por equipos", () => {
    expect([...TOURNAMENT_ALLOWED_MODES]).toEqual(["deathmatch", "team_deathmatch"]);
  });
});

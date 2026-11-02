/**
 * EQ2 · ADR-022 · API con las reglas de 0.4.0 (PostgreSQL REAL):
 *  - GET /rulesets: presets VIGENTES (incluye ctf@1), desempates y defectos de CTF;
 *  - POST /battles con CTF (preset y personalizado): copia con prórroga; bandos sin base y
 *    bandera en el mapa ⇒ 409 map_team_mismatch; modo distinto ⇒ 409 rules_mode_mismatch;
 *  - maxRespawns 0 ⇒ aceptado (1 vida);
 *  - GET /maps: modeCompatibility con el porqué;
 *  - POST /tournaments: COPIA INMUTABLE en el torneo (también clásica), y lo que no se
 *    admite todavía (topes de composición, NvN incoherente con el formato).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { createPublishedBot, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";
import { CTF_OVERTIME_MAX_SECONDS, TIEBREAK_RULES, currentPresets } from "../../../packages/game-rules/battle-rules.js";

let h: TestDbHandle;
let app: Express;
let tok: string;
let orgTok: string;
const bots: TestBot[] = [];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
  const user = await h.db("users").where({ email: DEV_USERS.user }).first();
  tok = await tokenFor(h.db, DEV_USERS.user);
  orgTok = await tokenFor(h.db, DEV_USERS.organizer);
  for (let i = 0; i < 4; i++) bots.push(await createPublishedBot(h.db, `r040-${i + 1}`, { ownerId: user.id }));
}, 120_000);

afterAll(async () => {
  await h.stop();
});

const parts = (a: string, b: string) => [
  { botId: bots[0].botId, version: 1, team: a },
  { botId: bots[1].botId, version: 1, team: a },
  { botId: bots[2].botId, version: 1, team: b },
  { botId: bots[3].botId, version: 1, team: b },
];
const ctfBody = (rules: unknown, teams: [string, string] = ["red", "blue"]) => ({
  mode: "capture_the_flag",
  rulesetId: "capture-the-flag-mvp",
  mapId: "mvp-arena-01",
  participants: parts(...teams),
  rules,
});
const post = (body: object) => request(app).post("/battles").set("Authorization", `Bearer ${tok}`).send(body);

describe("GET /rulesets (0.4.0)", () => {
  it("presets vigentes con ctf@1, desempates y defectos de CTF", async () => {
    const r = await request(app).get("/rulesets");
    expect(r.status).toBe(200);
    expect(r.body.presets.map((p: any) => `${p.id}@${p.version}`)).toEqual(
      currentPresets().map((p) => `${p.id}@${p.version}`),
    );
    expect(r.body.presets.find((p: any) => p.id === "ctf").game).toBe("capture_the_flag");
    expect(r.body.tiebreaks).toEqual(JSON.parse(JSON.stringify(TIEBREAK_RULES)));
    expect(r.body.custom.ctfDefaults.ctf).toEqual({ flagReturnSeconds: 10, requireOwnFlagAtBase: true });
    expect(r.body.custom.overtimeMaxSeconds).toBe(CTF_OVERTIME_MAX_SECONDS);
  });
});

describe("POST /battles · CTF", () => {
  it("preset ctf 2v2 ⇒ 202 con copia: ctf_mvp@1 + prórroga + desempate visible", async () => {
    const r = await post(ctfBody({ preset: "ctf", teamSize: 2 }));
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const row = await h.db("battles").where({ id: r.body.id }).first();
    expect(row.rules.presetId).toBe("ctf");
    expect(row.rules.presetVersion).toBe(1);
    expect(row.rules.mode).toBe("capture_the_flag");
    expect(row.rules.engineRuleset).toMatchObject({
      rulesetId: "ctf@1",
      mode: "capture_the_flag",
      scoreToWin: 3,
      timeLimitTicks: 9000,
      respawn: { enabled: true, delayTicks: 150 },
      ctf: { requireOwnFlagAtBase: true, flagReturnTicks: 300 },
      overtime: { kind: "next_score_wins", maxTicks: CTF_OVERTIME_MAX_SECONDS * 30 },
      friendlyFire: false,
    });
    expect(r.body.rules.profile).toBe("capture_the_flag");
    expect(r.body.rules.tiebreak.family).toBe("capture_the_flag");
    expect(r.body.rules.engine.overtime).toEqual({ kind: "next_score_wins", maxTicks: 5400 });
  });

  it("bandos sin base y bandera en el mapa (A/B) ⇒ 409 map_team_mismatch, sin crear nada", async () => {
    const [before] = await h.db("battles").count({ n: "*" });
    const r = await post(ctfBody({ preset: "ctf", teamSize: 2 }, ["A", "B"]));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("map_team_mismatch");
    expect(r.body.message).toContain("«A» no tiene base y bandera");
    const [after] = await h.db("battles").count({ n: "*" });
    expect(Number(after.n)).toBe(Number(before.n));
    // rules-check dice lo mismo (misma regla).
    const c = await request(app)
      .post("/battles/rules-check")
      .set("Authorization", `Bearer ${tok}`)
      .send(ctfBody({ preset: "ctf", teamSize: 2 }, ["A", "B"]));
    expect(c.status).toBe(409);
    expect(c.body.error).toBe("map_team_mismatch");
  });

  it("preset ctf con mode team_deathmatch ⇒ 409 rules_mode_mismatch", async () => {
    const r = await post({
      ...ctfBody({ preset: "ctf", teamSize: 2 }),
      mode: "team_deathmatch",
      rulesetId: "team-deathmatch-mvp",
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("rules_mode_mismatch");
  });

  it("personalizado CTF (4 capturas, retorno 20 s, sin bandera propia) ⇒ 202 con esos valores en el motor", async () => {
    const r = await post(
      ctfBody({
        preset: "custom",
        teamSize: 2,
        params: {
          game: "capture_the_flag",
          respawn: { mode: "unlimited", delaySeconds: 3 },
          victory: "score_limit",
          scoreLimit: 4,
          timeLimitMinutes: 6,
          ctf: { flagReturnSeconds: 20, requireOwnFlagAtBase: false },
        },
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const row = await h.db("battles").where({ id: r.body.id }).first();
    expect(row.rules.engineRuleset).toMatchObject({
      rulesetId: "custom_ctf@1",
      scoreToWin: 4,
      timeLimitTicks: 6 * 60 * 30,
      respawn: { enabled: true, delayTicks: 90 },
      ctf: { requireOwnFlagAtBase: false, flagReturnTicks: 600 },
    });
  });

  it("personalizado con gravedad o daño ⇒ 400 rules_invalid con forbidden_field", async () => {
    const r = await post({
      mode: "team_deathmatch",
      rulesetId: "team-deathmatch-mvp",
      mapId: "mvp-arena-01",
      participants: parts("red", "blue"),
      rules: {
        preset: "custom",
        teamSize: 2,
        params: {
          respawn: { mode: "none" },
          victory: "elimination",
          timeLimitMinutes: 5,
          gravity: 2,
          damageMultiplier: 3,
        },
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("rules_invalid");
    expect(r.body.errors.map((e: any) => e.code)).toEqual(["forbidden_field", "forbidden_field"]);
  });

  it("maxRespawns 0 con respawn limitado ⇒ 202: una sola vida, contada en la copia", async () => {
    const r = await post({
      mode: "team_deathmatch",
      rulesetId: "team-deathmatch-mvp",
      mapId: "mvp-arena-01",
      participants: parts("red", "blue"),
      rules: {
        preset: "custom",
        teamSize: 2,
        params: {
          respawn: { mode: "limited", maxRespawns: 0, delaySeconds: 5 },
          victory: "elimination",
          timeLimitMinutes: 5,
        },
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.rules.respawnLabel).toBe("0 reapariciones por bot (1 vida en total)");
    expect(r.body.rules.engine.respawn).toEqual({ enabled: true, delayTicks: 150, maxRespawns: 0 });
  });
});

describe("GET /maps · compatibilidad por modo con el porqué", () => {
  it("mvp-arena-01 sirve para CTF y TDM y explica por qué no para zone_control", async () => {
    const r = await request(app).get("/maps?limit=100").set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(200);
    const m = r.body.items.find((x: any) => x.mapId === "mvp-arena-01");
    expect(m.modeCompatibility.capture_the_flag).toEqual({ ok: true, declared: true, reasons: [] });
    expect(m.modeCompatibility.team_deathmatch.ok).toBe(true);
    expect(m.modeCompatibility.zone_control.ok).toBe(false);
    expect(m.modeCompatibility.zone_control.reasons.join(" ")).toContain("zona de captura");
  });
});

describe("POST /tournaments · copia inmutable de reglas", () => {
  const tbody = (extra: Record<string, unknown>) => ({
    name: `t-${Math.random().toString(36).slice(2, 8)}`,
    format: "teams",
    mode: "team_deathmatch",
    rulesetId: "team-deathmatch-mvp",
    ...extra,
  });
  const create = (body: object) =>
    request(app).post("/tournaments").set("Authorization", `Bearer ${orgTok}`).send(body);

  it("con preset: guarda la copia (preset, versión, ruleset del motor) y la devuelve", async () => {
    const r = await create(tbody({ rules: { preset: "team_deathmatch", teamSize: 4 } }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.rules.presetId).toBe("team_deathmatch");
    expect(r.body.rules.presetVersion).toBe(1);
    expect(r.body.rules.engine.timeoutTiebreak).toEqual(["score", "kills"]);
    const row = await h.db("tournaments").where({ id: r.body.id }).first();
    expect(row.rules.engineRuleset.rulesetId).toBe("team_deathmatch@1");
    expect(row.rules.engineVersion).toBe("0.4.0");
    // Retardo anti-coaching del directo en torneos (escalado EQ5); no toca la simulación.
    expect(row.rules.engineRuleset.spectator).toEqual({ delaySeconds: 30 });
  });

  it("sin reglas: copia CLÁSICA congelada al crear (cambiar después la fila de rulesets no la toca)", async () => {
    const r = await create(tbody({ budgetCredits: 900 }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const before = (await h.db("tournaments").where({ id: r.body.id }).first()).rules;
    expect(before.source).toBe("classic");
    expect(before.engineRuleset.rulesetId).toBe("tdm_mvp@1");
    expect(before.engineRuleset.budgetCredits).toBe(900);
    expect(before.engineRuleset.spectator.delaySeconds).toBe(30);
    await h
      .db("rulesets")
      .where({ id: "team-deathmatch-mvp" })
      .update({ config: JSON.stringify({ mode: "team_deathmatch", engineRulesetId: "skirmish_low@1" }) });
    try {
      const after = (await h.db("tournaments").where({ id: r.body.id }).first()).rules;
      expect(after).toEqual(before);
    } finally {
      await h
        .db("rulesets")
        .where({ id: "team-deathmatch-mvp" })
        .update({ config: JSON.stringify({ mode: "team_deathmatch", engineRulesetId: "tdm_mvp@1" }) });
    }
  });

  it("rechaza lo que no se aplica todavía o es incoherente con el formato", async () => {
    const limits = await create(
      tbody({
        rules: {
          preset: "custom",
          teamSize: 2,
          params: { respawn: { mode: "none" }, victory: "elimination", timeLimitMinutes: 5, teamCredits: 3000 },
        },
      }),
    );
    expect(limits.status).toBe(400);
    expect(limits.body.error).toBe("rules_invalid");
    const oneVsOne = await create(
      tbody({
        format: "league",
        mode: "deathmatch",
        rulesetId: "deathmatch-mvp",
        rules: { preset: "team_deathmatch", teamSize: 2 },
      }),
    );
    expect(oneVsOne.status).toBe(409); // preset de equipos en modo deathmatch
    const teamsFormat1v1 = await create(
      tbody({ mode: "deathmatch", rulesetId: "deathmatch-mvp", rules: { preset: "duel", teamSize: 1 } }),
    );
    expect(teamsFormat1v1.status).toBe(400);
    expect(teamsFormat1v1.body.error).toBe("rules_team_size");
    const leagueDuel = await create(
      tbody({
        format: "league",
        mode: "deathmatch",
        rulesetId: "deathmatch-mvp",
        rules: { preset: "duel", teamSize: 1 },
      }),
    );
    expect(leagueDuel.status, JSON.stringify(leagueDuel.body)).toBe(201);
    expect(leagueDuel.body.rules.presetId).toBe("duel");
    // CTF en torneos: rechazado con el motivo (bandos A/B sin bandera en los mapas CTF).
    const ctfT = await create(
      tbody({ mode: "capture_the_flag", rulesetId: "capture-the-flag-mvp", rules: { preset: "ctf", teamSize: 2 } }),
    );
    expect(ctfT.status).toBe(400);
    expect(ctfT.body.message).toContain("CTF todavía no se admite en torneos");
  });
});

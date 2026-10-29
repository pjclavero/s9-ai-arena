/**
 * R-API (ADR-021) · POST /battles con REGLAS: presets oficiales, personalizado,
 * topes de créditos/masa con los loadouts REALES, copia inmutable y rules-check.
 *
 * El coste y la masa de referencia se calculan aquí a partir de los JSON del
 * catálogo (chasis + módulos), de forma independiente del código de la API.
 * Cada rechazo se comprueba por su EFECTO: no se crea batalla ni trabajo.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { createPublishedBot, EXAMPLE_LOADOUT, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { RULES_LIMITS, RULES_PRESETS } from "../../../packages/game-rules/battle-rules.js";

const DATA = join(import.meta.dirname, "../../../packages/module-catalog/data");
function moduleJson(id: string) {
  return JSON.parse(readFileSync(join(DATA, `${id}.json`), "utf8"));
}
/**
 * Coste y masa de referencia, leídos de los JSON del catálogo. Coste = chasis + módulos
 * (la regla del presupuesto del loadout). Masa = la FÍSICA del motor: chasis + módulos
 * + munición embebida.
 */
function reference(loadout: { chassis: string; modules: { moduleId: string; ammo?: string }[] }) {
  const ids = [loadout.chassis, ...loadout.modules.map((m) => m.moduleId)];
  const ammo = loadout.modules.flatMap((m) => (m.ammo ? [m.ammo] : []));
  return {
    cost: ids.reduce((s, id) => s + moduleJson(id).costCredits, 0),
    mass: [...ids, ...ammo].reduce((s, id) => s + moduleJson(id).massKg, 0),
  };
}

let h: TestDbHandle;
let app: Express;
let tok: string;
let otherTok: string;
const bots: TestBot[] = [];
let heavy: TestBot;
let privateForeign: TestBot;
const GUN = reference(EXAMPLE_LOADOUT);
const HEAVY = reference(ARCHETYPES.heavy);

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
  const user = await h.db("users").where({ email: DEV_USERS.user }).first();
  tok = await tokenFor(h.db, DEV_USERS.user);
  otherTok = await tokenFor(h.db, DEV_USERS.developer);
  for (let i = 0; i < 8; i++) bots.push(await createPublishedBot(h.db, `rules-${i + 1}`, { ownerId: user.id }));
  // Un bot más pesado y caro: misma versión 1, loadout heavy.
  heavy = await createPublishedBot(h.db, "rules-heavy", { ownerId: user.id });
  await h
    .db("bot_loadouts")
    .where({ bot_id: heavy.botId, revision: 1 })
    .update({ chassis: ARCHETYPES.heavy.chassis, modules: JSON.stringify(ARCHETYPES.heavy.modules) });
  // Bot PRIVADO de otro usuario: no se puede meter en batallas ni inspeccionar.
  privateForeign = await createPublishedBot(h.db, "rules-private");
  await h.db("bots").where({ id: privateForeign.botId }).update({ visibility: "private" });
}, 120_000);

afterAll(async () => {
  await h.stop();
});

type P = { botId: string; version: number; team: string };
const side = (list: TestBot[], team: string): P[] => list.map((b) => ({ botId: b.botId, version: 1, team }));
function duel(rules?: unknown, p: P[] = [...side([bots[0]], "red"), ...side([bots[1]], "blue")]) {
  return { mode: "deathmatch", rulesetId: "deathmatch-mvp", mapId: "mvp-arena-02", participants: p, rules };
}
function team(n: number, rules: unknown, a = bots.slice(0, n), b = bots.slice(4, 4 + n)) {
  return {
    mode: "team_deathmatch",
    rulesetId: "team-deathmatch-mvp",
    mapId: "mvp-arena-01",
    participants: [...side(a, "red"), ...side(b, "blue")],
    rules,
  };
}
const custom = (teamSize: number, params: Record<string, unknown>) => ({ preset: "custom", teamSize, params });
const P_OK = {
  respawn: { mode: "limited", respawnsPerBot: 2, delaySeconds: 5 },
  victory: "elimination",
  timeLimitMinutes: 10,
};

async function counts() {
  const [bt] = await h.db("battles").count({ n: "*" });
  const [jb] = await h.db("jobs").where({ kind: "run_battle" }).count({ n: "*" });
  return { battles: Number(bt.n), jobs: Number(jb.n) };
}
const post = (body: object, t = tok) => request(app).post("/battles").set("Authorization", `Bearer ${t}`).send(body);
async function rejected(body: object, status: number, code: string) {
  const before = await counts();
  const r = await post(body);
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body.error).toBe(code);
  expect(await counts()).toEqual(before);
  return r;
}
async function accepted(body: object) {
  const before = await counts();
  const r = await post(body);
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  expect(await counts()).toEqual({ battles: before.battles + 1, jobs: before.jobs + 1 });
  const row = await h.db("battles").where({ id: r.body.id }).first();
  return { r, rules: row.rules };
}

describe("GET /rulesets · presets y límites", () => {
  it("expone los 7 presets oficiales versionados y los límites del servidor", async () => {
    const r = await request(app).get("/rulesets");
    expect(r.status).toBe(200);
    expect(r.body.presets.map((p: any) => `${p.id}@${p.version}`)).toEqual(
      RULES_PRESETS.map((p) => `${p.id}@${p.version}`),
    );
    expect(r.body.custom.limits).toEqual(JSON.parse(JSON.stringify(RULES_LIMITS)));
    expect(r.body.custom.maxParticipants).toBe(8);
    // Contrato anterior intacto.
    expect(r.body.modes).toContain("deathmatch");
    expect(r.body.items.some((i: any) => i.id === "deathmatch-mvp")).toBe(true);
  });
});

describe("presets 1v1", () => {
  it("Duelo ⇒ 202 y copia inmutable: sin respawn, 5 min, desempate vidas→bajas→casco", async () => {
    const { r, rules } = await accepted(duel({ preset: "duel", teamSize: 1 }));
    expect(rules.source).toBe("preset");
    expect(rules.presetId).toBe("duel");
    expect(rules.presetVersion).toBe(1);
    expect(rules.engineRuleset).toMatchObject({
      rulesetId: "duel@1",
      mode: "deathmatch",
      timeLimitTicks: 5 * 60 * 30,
      scoreToWin: Number.MAX_SAFE_INTEGER,
      respawn: { enabled: false, delayTicks: 0 },
      timeoutTiebreak: ["lives", "score", "hull"],
    });
    expect(rules.catalogVersion).toBeTruthy();
    expect(r.body.rules.summary).toContain("Respawns: ninguno (1 vida)");
    const g = await request(app).get(`/battles/${r.body.id}`).set("Authorization", `Bearer ${tok}`);
    expect(g.body.rules.profile).toBe("elimination");
  });

  it("Combate ⇒ respawn ilimitado 5 s y 5 bajas", async () => {
    const { rules } = await accepted(duel({ preset: "combat", teamSize: 1 }));
    expect(rules.engineRuleset.respawn).toEqual({ enabled: true, delayTicks: 150 });
    expect(rules.engineRuleset.scoreToWin).toBe(5);
  });

  it("sin `rules` ⇒ clásico: copia EXACTA de lo que resolvía el worker (dm_practice@1 + presupuesto de BD)", async () => {
    const { rules } = await accepted(duel(undefined));
    expect(rules.source).toBe("classic");
    expect(rules.engineRuleset).toEqual(
      JSON.parse(JSON.stringify(loadRuleset("dm_practice@1", { budgetCredits: 1000 }))),
    );
  });

  it("un preset de equipos en 1v1 ⇒ 400 rules_invalid", async () => {
    await rejected(duel({ preset: "team_deathmatch", teamSize: 1 }), 400, "rules_invalid");
  });

  it("preset con parámetros ⇒ 400 (un oficial no se modifica)", async () => {
    await rejected(duel({ preset: "duel", teamSize: 1, params: { timeLimitMinutes: 30 } }), 400, "rules_invalid");
  });

  it("preset desconocido o __proto__ ⇒ 400", async () => {
    await rejected(duel({ preset: "__proto__", teamSize: 1 }), 400, "rules_invalid");
    await rejected(duel({ preset: "duel@2", teamSize: 1 }), 400, "rules_invalid");
  });
});

describe("presets por equipos (2v2, 3v3, 4v4)", () => {
  for (const n of [2, 3, 4]) {
    it(`Respawn limitado ${n}v${n} ⇒ maxRespawns 2 (3 vidas)`, async () => {
      const { rules } = await accepted(team(n, { preset: "team_limited_respawn", teamSize: n }));
      expect(rules.engineRuleset.respawn).toEqual({ enabled: true, delayTicks: 150, maxRespawns: 2 });
      expect(rules.params.teamSize).toBe(n);
    });
  }

  it("Eliminación 4v4 y Team Deathmatch 4v4 ⇒ 202", async () => {
    const e = await accepted(team(4, { preset: "team_elimination", teamSize: 4 }));
    expect(e.rules.engineRuleset.respawn).toEqual({ enabled: false, delayTicks: 0 });
    const t = await accepted(team(4, { preset: "team_deathmatch", teamSize: 4 }));
    expect(t.rules.engineRuleset.scoreToWin).toBe(10);
  });

  it("4v4 declarado con 3v4 ⇒ 400 rules_team_size", async () => {
    await rejected(
      team(4, { preset: "team_deathmatch", teamSize: 4 }, bots.slice(0, 3), bots.slice(4, 8)),
      400,
      "rules_team_size",
    );
  });

  it("preset de equipos con modo deathmatch ⇒ 409 rules_mode_mismatch", async () => {
    await rejected(
      {
        ...team(2, { preset: "team_deathmatch", teamSize: 2 }),
        mode: "deathmatch",
        rulesetId: "deathmatch-mvp",
        mapId: "mvp-arena-02",
      },
      409,
      "deathmatch_shared_team",
    );
    await rejected(duel({ preset: "team_deathmatch", teamSize: 2 }), 409, "rules_mode_mismatch");
  });
});

describe("personalizado · parámetros", () => {
  it("válido 2v2 ⇒ 202; parámetros normalizados en la copia", async () => {
    const { rules } = await accepted(team(2, custom(2, P_OK)));
    expect(rules.source).toBe("custom");
    expect(rules.params).toMatchObject({
      teamSize: 2,
      respawn: { mode: "limited", respawnsPerBot: 2, delaySeconds: 5 },
    });
  });

  it("extremos válidos (máximos) ⇒ 202", async () => {
    await accepted(
      team(
        4,
        custom(4, {
          respawn: {
            mode: "limited",
            respawnsPerBot: RULES_LIMITS.respawnsPerBot.max,
            delaySeconds: RULES_LIMITS.delaySeconds.max,
          },
          victory: "score_limit",
          // 4 bots × 11 vidas = 44 bajas posibles: el máximo alcanzable con este roster.
          scoreLimit: 44,
          timeLimitMinutes: RULES_LIMITS.timeLimitMinutes.max,
          botCredits: RULES_LIMITS.botCredits.max,
          teamCredits: RULES_LIMITS.teamCredits.max,
          botMassKg: RULES_LIMITS.botMassKg.max,
          teamMassKg: RULES_LIMITS.teamMassKg.max,
          friendlyFire: true,
        }),
      ),
    );
  });

  const bad: [string, Record<string, unknown>, string][] = [
    [
      "respawns negativos",
      { ...P_OK, respawn: { mode: "limited", respawnsPerBot: -1, delaySeconds: 5 } },
      "rules.params.respawn.respawnsPerBot",
    ],
    [
      "respawns 0 con limitado",
      { ...P_OK, respawn: { mode: "limited", respawnsPerBot: 0, delaySeconds: 5 } },
      "rules.params.respawn.respawnsPerBot",
    ],
    [
      "respawns por encima del máximo",
      { ...P_OK, respawn: { mode: "limited", respawnsPerBot: 11, delaySeconds: 5 } },
      "rules.params.respawn.respawnsPerBot",
    ],
    [
      "respawns no entero",
      { ...P_OK, respawn: { mode: "limited", respawnsPerBot: 1.5, delaySeconds: 5 } },
      "rules.params.respawn.respawnsPerBot",
    ],
    [
      "respawns como texto",
      { ...P_OK, respawn: { mode: "limited", respawnsPerBot: "2", delaySeconds: 5 } },
      "rules.params.respawn.respawnsPerBot",
    ],
    [
      "retardo 0",
      { ...P_OK, respawn: { mode: "limited", respawnsPerBot: 2, delaySeconds: 0 } },
      "rules.params.respawn.delaySeconds",
    ],
    [
      "retardo 31 s",
      { ...P_OK, respawn: { mode: "limited", respawnsPerBot: 2, delaySeconds: 31 } },
      "rules.params.respawn.delaySeconds",
    ],
    ["tiempo 0", { ...P_OK, timeLimitMinutes: 0 }, "rules.params.timeLimitMinutes"],
    ["tiempo 31 min", { ...P_OK, timeLimitMinutes: 31 }, "rules.params.timeLimitMinutes"],
    ["tiempo enorme", { ...P_OK, timeLimitMinutes: 1e12 }, "rules.params.timeLimitMinutes"],
    ["créditos por bot 199", { ...P_OK, botCredits: 199 }, "rules.params.botCredits"],
    ["créditos de equipo enormes", { ...P_OK, teamCredits: 20_001 }, "rules.params.teamCredits"],
    ["masa negativa", { ...P_OK, botMassKg: -5 }, "rules.params.botMassKg"],
    ["masa de equipo excesiva", { ...P_OK, teamMassKg: 40_001 }, "rules.params.teamMassKg"],
    ["campo desconocido", { ...P_OK, godMode: true }, "rules.params.godMode"],
    [
      "eliminación con respawn ilimitado",
      { ...P_OK, respawn: { mode: "unlimited", delaySeconds: 5 } },
      "rules.params.victory",
    ],
    ["tiempo sin respawn", { ...P_OK, respawn: { mode: "none" }, victory: "time_score" }, "rules.params.victory"],
    [
      "límite de bajas inalcanzable sin respawn",
      { ...P_OK, respawn: { mode: "none" }, victory: "score_limit", scoreLimit: 3 },
      "rules.params.scoreLimit",
    ],
    ["límite de bajas sin victoria por bajas", { ...P_OK, scoreLimit: 5 }, "rules.params.scoreLimit"],
    [
      "respawnsPerBot con ilimitado",
      {
        ...P_OK,
        victory: "score_limit",
        scoreLimit: 5,
        respawn: { mode: "unlimited", respawnsPerBot: 2, delaySeconds: 5 },
      },
      "rules.params.respawn.respawnsPerBot",
    ],
    [
      "retardo sin respawn",
      { ...P_OK, respawn: { mode: "none", delaySeconds: 5 } },
      "rules.params.respawn.delaySeconds",
    ],
    [
      "modo de respawn inventado",
      { ...P_OK, respawn: { mode: "infinite", delaySeconds: 5 } },
      "rules.params.respawn.mode",
    ],
    ["fuego amigo no booleano", { ...P_OK, friendlyFire: "yes" }, "rules.params.friendlyFire"],
  ];
  for (const [name, params, field] of bad) {
    it(`${name} ⇒ 400 rules_invalid (${field})`, async () => {
      const r = await rejected(team(2, custom(2, params)), 400, "rules_invalid");
      expect(r.body.errors.map((e: any) => e.field)).toContain(field);
    });
  }

  it("1v1 con tope de equipo o fuego amigo ⇒ 400 (combinación incompatible)", async () => {
    const p = { respawn: { mode: "none" }, victory: "elimination", timeLimitMinutes: 3 };
    await rejected(duel(custom(1, { ...p, teamCredits: 2000 })), 400, "rules_invalid");
    await rejected(duel(custom(1, { ...p, friendlyFire: true })), 400, "rules_invalid");
  });

  it("teamSize fuera de rango ⇒ 400 (no se sube el límite de 8)", async () => {
    await rejected(team(4, custom(5, P_OK)), 400, "rules_invalid");
    await rejected(team(4, custom(0, P_OK)), 400, "rules_invalid");
  });
});

describe("personalizado · topes de créditos y masa (loadouts reales)", () => {
  const tdm2 = (limits: Record<string, number>) => team(2, custom(2, { ...P_OK, ...limits }));

  it("créditos por bot: justo en el límite ⇒ 202; 1 cr por debajo del coste ⇒ 422 con exceso 1", async () => {
    await accepted(tdm2({ botCredits: GUN.cost }));
    const r = await rejected(tdm2({ botCredits: GUN.cost - 1 }), 422, "composition_invalid");
    const v = r.body.composition.violations;
    expect(v).toHaveLength(4);
    expect(v.every((x: any) => x.code === "bot_credits_exceeded" && x.excess === 1 && x.actual === GUN.cost)).toBe(
      true,
    );
  });

  it("créditos por equipo: 2×coste ⇒ 202; 2×coste − 1 ⇒ 422 team_credits_exceeded en los dos bandos", async () => {
    await accepted(tdm2({ teamCredits: 2 * GUN.cost }));
    const r = await rejected(tdm2({ teamCredits: 2 * GUN.cost - 1 }), 422, "composition_invalid");
    expect(r.body.composition.violations.map((x: any) => [x.code, x.team, x.excess])).toEqual([
      ["team_credits_exceeded", "red", 1],
      ["team_credits_exceeded", "blue", 1],
    ]);
  });

  it("masa por bot: justo en el límite ⇒ 202; 1 kg por debajo ⇒ 422 bot_mass_exceeded", async () => {
    await accepted(tdm2({ botMassKg: GUN.mass }));
    const r = await rejected(tdm2({ botMassKg: GUN.mass - 1 }), 422, "composition_invalid");
    expect(r.body.composition.violations[0]).toMatchObject({ code: "bot_mass_exceeded", actual: GUN.mass, excess: 1 });
  });

  it("masa por equipo: 2×masa ⇒ 202; 2×masa − 1 ⇒ 422 team_mass_exceeded", async () => {
    await accepted(tdm2({ teamMassKg: 2 * GUN.mass }));
    await rejected(tdm2({ teamMassKg: 2 * GUN.mass - 1 }), 422, "composition_invalid");
  });

  it("los dos topes a la vez: un bot pesado y caro rompe el individual; el informe lo señala por nombre", async () => {
    const limits = { botCredits: GUN.cost, teamCredits: GUN.cost + HEAVY.cost };
    const body = team(2, custom(2, { ...P_OK, ...limits }), [bots[0], heavy], bots.slice(4, 6));
    expect(HEAVY.cost).toBeGreaterThan(GUN.cost);
    const r = await rejected(body, 422, "composition_invalid");
    const v = r.body.composition.violations;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: "bot_credits_exceeded", botId: heavy.botId, excess: HEAVY.cost - GUN.cost });
    expect(v[0].message).toContain("rules-heavy v1");
    // Informe completo por bando.
    const red = r.body.composition.teams.find((t: any) => t.team === "red");
    expect(red.totalCredits).toBe(GUN.cost + HEAVY.cost);
    expect(red.bots.map((b: any) => [b.botId, b.ok])).toEqual([
      [bots[0].botId, true],
      [heavy.botId, false],
    ]);
  });

  it("el cliente NO puede declarar coste ni masa: campos así en participantes se ignoran", async () => {
    const body: any = tdm2({ botCredits: GUN.cost - 1 });
    body.participants = body.participants.map((p: any) => ({ ...p, costCredits: 1, massKg: 1 }));
    await rejected(body, 422, "composition_invalid");
  });
});

describe("POST /battles/rules-check (FASE 11)", () => {
  const check = (body: object, t = tok) =>
    request(app).post("/battles/rules-check").set("Authorization", `Bearer ${t}`).send(body);

  it("informe por bot sin crear nada; ok=false con la violación", async () => {
    const before = await counts();
    const r = await check(team(2, custom(2, { ...P_OK, botCredits: GUN.cost - 1 })));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.composition.teams[0].bots[0]).toMatchObject({ costCredits: GUN.cost, massKg: GUN.mass, ok: false });
    expect(r.body.rules.summary).toContain(`Máx. por bot: ${GUN.cost - 1} cr`);
    expect(await counts()).toEqual(before);
  });

  it("reglas inválidas ⇒ 200 ok=false con errores por campo", async () => {
    const r = await check(team(2, custom(2, { ...P_OK, timeLimitMinutes: 0 })));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.errors.map((e: any) => e.field)).toContain("rules.params.timeLimitMinutes");
  });

  it("bot privado ajeno ⇒ 404 (no revela coste ni masa)", async () => {
    const body = team(1, undefined, [privateForeign], [bots[4]]);
    const r = await check(body);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain("costCredits");
  });

  it("anónimo ⇒ 401", async () => {
    const r = await request(app)
      .post("/battles/rules-check")
      .send(duel({ preset: "duel", teamSize: 1 }));
    expect(r.status).toBe(401);
  });
});

describe("copia inmutable y batallas anteriores", () => {
  it("cambiar el ruleset de plataforma DESPUÉS de crear no cambia la copia", async () => {
    const { r, rules } = await accepted(team(2, { preset: "team_deathmatch", teamSize: 2 }));
    await h.db("rulesets").where({ id: "team-deathmatch-mvp" }).update({ budget_credits: 600 });
    const row = await h.db("battles").where({ id: r.body.id }).first();
    expect(row.rules).toEqual(rules);
    await h.db("rulesets").where({ id: "team-deathmatch-mvp" }).update({ budget_credits: 1000 });
  });

  it("una batalla sin copia (anterior a R-RULES) se sirve sin `rules` y con perfil classic", async () => {
    const { r } = await accepted(duel({ preset: "duel", teamSize: 1 }));
    await h.db("battles").where({ id: r.body.id }).update({ rules: null });
    const g = await request(app).get(`/battles/${r.body.id}`).set("Authorization", `Bearer ${tok}`);
    expect(g.status).toBe(200);
    expect(g.body.rules).toBeUndefined();
    const s = await request(app).get(`/battles/${r.body.id}/stats`).set("Authorization", `Bearer ${tok}`);
    expect(s.body.profile).toBe("classic");
  });

  it("las reglas de una batalla ajena privada no se filtran (misma política de lectura)", async () => {
    const { r } = await accepted(duel({ preset: "duel", teamSize: 1 }));
    await h.db("bots").whereIn("id", [bots[0].botId, bots[1].botId]).update({ visibility: "private" });
    const g = await request(app).get(`/battles/${r.body.id}`).set("Authorization", `Bearer ${otherTok}`);
    expect(g.status).toBe(404);
    expect(g.body.rules).toBeUndefined();
    await h.db("bots").whereIn("id", [bots[0].botId, bots[1].botId]).update({ visibility: "public" });
  });
});

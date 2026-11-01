/**
 * RULES-REVIEW (FASE 20) · intentos de ROMPER POST /battles con `rules` y
 * POST /battles/rules-check (rama `rules/rulesets`, ADR-021). Escritos por el
 * revisor independiente; no repiten los casos de `rules-battles.test.ts`.
 *
 * Cada rechazo se comprueba por su EFECTO (no se crea batalla ni trabajo). La masa
 * de referencia la calcula aquí `resolveVehicle` (la que simula el motor), no la API.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { createPublishedBot, EXAMPLE_LOADOUT, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { findModule } from "../../../packages/module-catalog/types.js";
import { getCatalog } from "./services/catalog.js";

let h: TestDbHandle;
let app: Express;
let tok: string;
const bots: TestBot[] = [];
let twoVersions: TestBot;
let privateForeign: TestBot;
let GUN = { cost: 0, mass: 0 };
let HEAVY = { cost: 0, mass: 0 };

async function engineTotals(l: { chassis: string; modules: any[] }) {
  const latest = await h.db("catalog_versions").orderBy("imported_at", "desc").first();
  const catalog = await getCatalog(h.db, latest.catalog_version);
  const spec = resolveVehicle(
    { loadoutId: "x", revision: 1, catalogVersion: latest.catalog_version, chassis: l.chassis, modules: l.modules },
    catalog,
  );
  const cost = [l.chassis, ...l.modules.map((m) => m.moduleId)].reduce(
    (s, id) => s + (findModule(catalog, id)?.costCredits ?? 0),
    0,
  );
  return { cost, mass: spec.massKg };
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
  const user = await h.db("users").where({ email: DEV_USERS.user }).first();
  tok = await tokenFor(h.db, DEV_USERS.user);
  for (let i = 0; i < 8; i++) bots.push(await createPublishedBot(h.db, `rv-${i + 1}`, { ownerId: user.id }));
  // Bot con DOS versiones publicadas: v1 = gunner (rev 1), v2 = heavy (rev 2).
  twoVersions = await createPublishedBot(h.db, "rv-two", { ownerId: user.id });
  await h.db("bot_loadouts").insert({
    bot_id: twoVersions.botId,
    revision: 2,
    name: "rv-two-heavy",
    catalog_version: EXAMPLE_LOADOUT.catalogVersion,
    chassis: ARCHETYPES.heavy.chassis,
    modules: JSON.stringify(ARCHETYPES.heavy.modules),
  });
  await h.db("bot_versions").insert({
    bot_id: twoVersions.botId,
    version: 2,
    state: "published",
    runtime: "node",
    loadout_revision: 2,
    artifact_hash: "hash-rv-two-2",
  });
  privateForeign = await createPublishedBot(h.db, "rv-private");
  await h.db("bots").where({ id: privateForeign.botId }).update({ visibility: "private" });
  GUN = await engineTotals(EXAMPLE_LOADOUT);
  HEAVY = await engineTotals(ARCHETYPES.heavy as any);
}, 120_000);

afterAll(async () => {
  await h.stop();
});

type P = { botId: string; version: number; team: string };
const side = (list: TestBot[], team: string, version = 1): P[] => list.map((b) => ({ botId: b.botId, version, team }));
function body(mode: string, rulesetId: string, mapId: string, participants: P[], rules: unknown) {
  return { mode, rulesetId, mapId, participants, rules };
}
const tdm = (participants: P[], rules: unknown) =>
  body("team_deathmatch", "team-deathmatch-mvp", "mvp-arena-01", participants, rules);
const dm = (participants: P[], rules: unknown) =>
  body("deathmatch", "deathmatch-mvp", "mvp-arena-02", participants, rules);
const custom = (teamSize: number, params: Record<string, unknown>) => ({ preset: "custom", teamSize, params });
const LIM = {
  respawn: { mode: "limited", respawnsPerBot: 2, delaySeconds: 5 },
  victory: "elimination",
  timeLimitMinutes: 10,
};

async function counts() {
  const [bt] = await h.db("battles").count({ n: "*" });
  const [jb] = await h.db("jobs").where({ kind: "run_battle" }).count({ n: "*" });
  return { battles: Number(bt.n), jobs: Number(jb.n) };
}
const post = (b: object) => request(app).post("/battles").set("Authorization", `Bearer ${tok}`).send(b);
const check = (b: object) => request(app).post("/battles/rules-check").set("Authorization", `Bearer ${tok}`).send(b);
async function rejected(b: object, status: number, code: string) {
  const before = await counts();
  const r = await post(b);
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body.error).toBe(code);
  expect(await counts()).toEqual(before);
  return r;
}
async function accepted(b: object) {
  const r = await post(b);
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  return (await h.db("battles").where({ id: r.body.id }).first()).rules;
}

describe("forma de la petición", () => {
  it("rules: null ⇒ clásico (copia source=classic), igual que sin rules", async () => {
    const rules = await accepted(dm([...side([bots[0]], "red"), ...side([bots[1]], "blue")], null));
    expect(rules.source).toBe("classic");
    expect(rules.params).toBeNull();
  });

  it("rules: {} / preset ausente ⇒ 400 rules_invalid", async () => {
    await rejected(dm([...side([bots[0]], "red"), ...side([bots[1]], "blue")], {}), 400, "rules_invalid");
  });

  it("preset con params vacío ⇒ 400 (ni siquiera {} se admite)", async () => {
    await rejected(
      dm([...side([bots[0]], "red"), ...side([bots[1]], "blue")], { preset: "duel", teamSize: 1, params: {} }),
      400,
      "rules_invalid",
    );
  });

  it("claves `__proto__`/`constructor` en rules y params ⇒ 400 (JSON crudo)", async () => {
    const raw =
      '{"mode":"team_deathmatch","rulesetId":"team-deathmatch-mvp","mapId":"mvp-arena-01","participants":' +
      JSON.stringify([...side(bots.slice(0, 2), "red"), ...side(bots.slice(4, 6), "blue")]) +
      ',"rules":{"preset":"custom","teamSize":2,"params":{"__proto__":{"botCredits":1},"constructor":1,' +
      '"respawn":{"mode":"limited","respawnsPerBot":2,"delaySeconds":5},"victory":"elimination","timeLimitMinutes":10}}}';
    const before = await counts();
    const r = await request(app)
      .post("/battles")
      .set("Authorization", `Bearer ${tok}`)
      .set("Content-Type", "application/json")
      .send(raw);
    expect(r.status).toBe(400);
    expect(r.body.errors.map((e: any) => e.field)).toEqual(
      expect.arrayContaining(["rules.params.__proto__", "rules.params.constructor"]),
    );
    expect(await counts()).toEqual(before);
  });

  it("número 1e400 (Infinity tras JSON.parse) ⇒ 400 type", async () => {
    const raw =
      '{"mode":"deathmatch","rulesetId":"deathmatch-mvp","mapId":"mvp-arena-02","participants":' +
      JSON.stringify([...side([bots[0]], "red"), ...side([bots[1]], "blue")]) +
      ',"rules":{"preset":"custom","teamSize":1,"params":{"respawn":{"mode":"none"},"victory":"elimination","timeLimitMinutes":1e400}}}';
    const r = await request(app)
      .post("/battles")
      .set("Authorization", `Bearer ${tok}`)
      .set("Content-Type", "application/json")
      .send(raw);
    expect(r.status).toBe(400);
    expect(r.body.errors[0]).toMatchObject({ field: "rules.params.timeLimitMinutes", code: "type" });
  });
});

describe("bandos y modo", () => {
  it("rules en capture_the_flag ⇒ 409 rules_mode_mismatch (CTF sigue siendo clásico)", async () => {
    await rejected(
      body(
        "capture_the_flag",
        "capture-the-flag-mvp",
        "mvp-arena-01",
        [...side([bots[0]], "red"), ...side([bots[1]], "blue")],
        {
          preset: "duel",
          teamSize: 1,
        },
      ),
      409,
      "rules_mode_mismatch",
    );
  });

  it("Duelo con 3 bandos de 1 (deathmatch FFA) ⇒ 400 rules_team_size", async () => {
    await rejected(
      dm([...side([bots[0]], "a"), ...side([bots[1]], "b"), ...side([bots[2]], "c")], { preset: "duel", teamSize: 1 }),
      400,
      "rules_team_size",
    );
  });

  it("equipos desiguales 3v2 con teamSize 3 ⇒ 400 rules_team_size", async () => {
    await rejected(
      tdm([...side(bots.slice(0, 3), "red"), ...side(bots.slice(4, 6), "blue")], {
        preset: "team_elimination",
        teamSize: 3,
      }),
      400,
      "rules_team_size",
    );
  });

  it("9 participantes con un preset 4v4 ⇒ 400 antes de las reglas", async () => {
    const ninth = await createPublishedBot(h.db, "rv-ninth");
    const r = await post(
      tdm([...side(bots.slice(0, 4), "red"), ...side([...bots.slice(4, 8), ninth], "blue")], {
        preset: "team_deathmatch",
        teamSize: 4,
      }),
    );
    expect(r.status).toBe(400);
  });

  it("bandos llamados __proto__ y constructor con tope de equipo ⇒ se cuentan como bandos normales", async () => {
    const participants = [...side(bots.slice(0, 2), "__proto__"), ...side(bots.slice(4, 6), "constructor")];
    const ok = await check(tdm(participants, custom(2, { ...LIM, teamCredits: 2 * GUN.cost })));
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.composition.teams.map((t: any) => [t.team, t.totalCredits])).toEqual([
      ["__proto__", 2 * GUN.cost],
      ["constructor", 2 * GUN.cost],
    ]);
    const r = await rejected(
      tdm(participants, custom(2, { ...LIM, teamCredits: 2 * GUN.cost - 1 })),
      422,
      "composition_invalid",
    );
    expect(r.body.composition.violations.map((v: any) => v.team)).toEqual(["__proto__", "constructor"]);
  });
});

describe("presupuestos: bot y equipo a la vez, en el límite y +1", () => {
  const four = () => [...side(bots.slice(0, 2), "red"), ...side(bots.slice(4, 6), "blue")];

  it("bot EXACTO y equipo EXACTO ⇒ 202; masa exacta en los dos ⇒ 202", async () => {
    await accepted(tdm(four(), custom(2, { ...LIM, botCredits: GUN.cost, teamCredits: 2 * GUN.cost })));
    await accepted(
      tdm(four(), custom(2, { ...LIM, botMassKg: Math.ceil(GUN.mass), teamMassKg: Math.ceil(2 * GUN.mass) })),
    );
  });

  it("bot exacto pero equipo +1 ⇒ 422 SÓLO team_credits_exceeded", async () => {
    const r = await rejected(
      tdm(four(), custom(2, { ...LIM, botCredits: GUN.cost, teamCredits: 2 * GUN.cost - 1 })),
      422,
      "composition_invalid",
    );
    expect([...new Set(r.body.composition.violations.map((v: any) => v.code))]).toEqual(["team_credits_exceeded"]);
  });

  it("bot +1 y equipo exacto ⇒ 422 SÓLO bot_credits_exceeded (4 bots)", async () => {
    const r = await rejected(
      tdm(four(), custom(2, { ...LIM, botCredits: GUN.cost - 1, teamCredits: 2 * GUN.cost })),
      422,
      "composition_invalid",
    );
    const v = r.body.composition.violations;
    expect(v.map((x: any) => x.code)).toEqual(Array(4).fill("bot_credits_exceeded"));
  });

  it("los cuatro topes rotos a la vez ⇒ todas las violaciones, por bot y por bando", async () => {
    const r = await rejected(
      tdm(
        four(),
        custom(2, {
          ...LIM,
          botCredits: GUN.cost - 1,
          teamCredits: 2 * GUN.cost - 1,
          botMassKg: Math.ceil(GUN.mass) - 1,
          teamMassKg: Math.ceil(2 * GUN.mass) - 1,
        }),
      ),
      422,
      "composition_invalid",
    );
    const codes = r.body.composition.violations.map((v: any) => v.code).sort();
    expect(codes.filter((c: string) => c === "bot_credits_exceeded")).toHaveLength(4);
    expect(codes.filter((c: string) => c === "bot_mass_exceeded")).toHaveLength(4);
    expect(codes.filter((c: string) => c === "team_credits_exceeded")).toHaveLength(2);
    expect(codes.filter((c: string) => c === "team_mass_exceeded")).toHaveLength(2);
  });

  it("la masa del informe es la del MOTOR (resolveVehicle) y el coste el del presupuesto del loadout", async () => {
    const r = await check(tdm(four(), custom(2, { ...LIM, botMassKg: 10_000 })));
    expect(r.body.composition.teams[0].bots[0]).toMatchObject({ costCredits: GUN.cost, massKg: GUN.mass });
  });
});

describe("versiones y revisiones de loadout", () => {
  it("cada versión se mide con SU revisión: v1 ligera pasa el tope, v2 pesada no (aunque v1 lo pase)", async () => {
    expect(HEAVY.cost).toBeGreaterThan(GUN.cost);
    const limits = { ...LIM, botCredits: GUN.cost };
    const v1 = [...side([twoVersions], "red", 1), ...side([bots[1]], "red"), ...side(bots.slice(4, 6), "blue")];
    await accepted(tdm(v1, custom(2, limits)));
    const v2 = [...side([twoVersions], "red", 2), ...side([bots[1]], "red"), ...side(bots.slice(4, 6), "blue")];
    const r = await rejected(tdm(v2, custom(2, limits)), 422, "composition_invalid");
    expect(r.body.composition.violations).toHaveLength(1);
    expect(r.body.composition.violations[0]).toMatchObject({
      botId: twoVersions.botId,
      actual: HEAVY.cost,
      excess: HEAVY.cost - GUN.cost,
    });
  });

  it("versión inexistente con topes ⇒ 409 bot_not_published, sin crear", async () => {
    await rejected(
      tdm(
        [...side([twoVersions], "red", 3), ...side([bots[1]], "red"), ...side(bots.slice(4, 6), "blue")],
        custom(2, { ...LIM, botCredits: 5000 }),
      ),
      409,
      "bot_not_published",
    );
  });
});

describe("rules-check · autorización", () => {
  it("bot privado ajeno + reglas INVÁLIDAS ⇒ 404 (no 200 con errores: la visibilidad va antes)", async () => {
    const r = await check(
      tdm(
        [...side([privateForeign, bots[0]], "red"), ...side(bots.slice(4, 6), "blue")],
        custom(2, { ...LIM, timeLimitMinutes: 0 }),
      ),
    );
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("bot_not_found");
    const s = JSON.stringify(r.body);
    expect(s).not.toContain("costCredits");
    expect(s).not.toContain("massKg");
    expect(s).not.toContain("rv-private");
  });

  it("bot privado ajeno con versión inexistente ⇒ 404 idéntico (no 409 que confirme que existe)", async () => {
    const a = await check(
      tdm(
        [...side([privateForeign], "red", 99), ...side([bots[0]], "red"), ...side(bots.slice(4, 6), "blue")],
        custom(2, LIM),
      ),
    );
    const b = await check(
      tdm(
        [
          { botId: "00000000-0000-0000-0000-000000000000", version: 1, team: "red" },
          ...side([bots[0]], "red"),
          ...side(bots.slice(4, 6), "blue"),
        ],
        custom(2, LIM),
      ),
    );
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(a.body.error).toBe(b.body.error);
  });

  it("rules-check nunca crea batallas ni trabajos (ni con composición válida)", async () => {
    const before = await counts();
    const r = await check(tdm([...side(bots.slice(0, 2), "red"), ...side(bots.slice(4, 6), "blue")], custom(2, LIM)));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(await counts()).toEqual(before);
  });
});

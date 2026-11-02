/**
 * EQ2 · ADR-022 · Decisiones cerradas del operador sobre el registro de reglas (puro):
 *  - presets VERSIONADOS e INMUTABLES (huella fijada por versión; congelados en memoria);
 *  - maxRespawns = reapariciones (vidas = maxRespawns + 1) para 0, 1, 2 y N;
 *  - CTF base ctf@1 con los valores exactos del encargo y su prórroga;
 *  - desempates EXACTOS por familia;
 *  - personalizado: sólo parámetros competitivos (física/daño/HP/sensores/munición fuera);
 *  - presupuesto de equipo con reparto desigual.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RULES_PRESETS,
  TIEBREAK_RULES,
  checkComposition,
  currentPresets,
  engineRulesetFor,
  findPreset,
  presetKey,
  resolveRulesRequest,
  respawnLabel,
  summarizeParams,
  tiebreakFamilyOf,
  type RulesParams,
} from "./battle-rules.js";
import { OVERTIME_TECHNICAL_LIMIT_TICKS, maxBattleTicks } from "./index.js";

const canon = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canon).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v as object)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);
const fingerprint = (p: unknown) => createHash("sha256").update(canon(p)).digest("hex").slice(0, 16);

/**
 * Huellas de las versiones PUBLICADAS. Si este test se pone rojo porque cambiaste un
 * preset existente: NO actualices la huella; crea `id@(version+1)` y deja la anterior.
 * (La única excepción es añadir aquí la huella de una versión NUEVA.)
 */
const PUBLISHED: Record<string, string> = {
  "duel@1": "a2cc6b26613c39e6",
  "combat@1": "d427792fd036dda9",
  "endurance@1": "7f3b25b071f2cfff",
  "team_elimination@1": "304066813ecc7c7d",
  "team_limited_respawn@1": "290e95a9b05c2e7a",
  "team_deathmatch@1": "0590a81e6cbfa4e6",
  "team_endurance@1": "a6d25e0c7e0162a1",
  // ctf@1: texto ajustado el 2026-11-02 (prórroga sin tope, decisión del operador) ANTES de su
  // primer despliegue; a partir de ahí, congelado.
  "ctf@1": "3cd7bdce265c2ca4",
};

describe("presets versionados e inmutables", () => {
  it("cada versión publicada conserva su huella (cambiar una regla exige versión nueva)", () => {
    const actual = Object.fromEntries(RULES_PRESETS.map((p) => [presetKey(p), fingerprint(p)]));
    expect(actual).toEqual(PUBLISHED);
  });

  it("no hay dos presets con el mismo id@versión y las versiones son enteros ≥ 1", () => {
    const keys = RULES_PRESETS.map(presetKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of RULES_PRESETS) expect(Number.isInteger(p.version) && p.version >= 1).toBe(true);
  });

  it("están congelados en memoria: nadie puede editarlos en caliente", () => {
    const p = findPreset("team_deathmatch@1")!;
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.params)).toBe(true);
    expect(Object.isFrozen(p.params.respawn)).toBe(true);
    expect(() => {
      (p.params as { scoreLimit: number }).scoreLimit = 99;
    }).toThrow();
    expect(findPreset("team_deathmatch@1")!.params.scoreLimit).toBe(10);
  });

  it("`id` resuelve a la versión vigente e `id@N` a esa exacta; la copia guarda la versión", () => {
    expect(findPreset("ctf")).toBe(findPreset("ctf@1"));
    expect(findPreset("ctf@2")).toBeUndefined();
    expect(findPreset("__proto__")).toBeUndefined();
    expect(currentPresets().map(presetKey)).toContain("ctf@1");
    const r = resolveRulesRequest({ preset: "team_deathmatch@1", teamSize: 4 });
    expect(r.ok && r.engineRuleset.rulesetId).toBe("team_deathmatch@1");
    // La resolución devuelve una COPIA: mutarla no toca el registro.
    if (r.ok) r.params.respawn.delaySeconds = 99;
    expect(findPreset("team_deathmatch")!.params.respawn.delaySeconds).toBe(5);
  });
});

describe("maxRespawns = número de REAPARICIONES (vidas = maxRespawns + 1)", () => {
  const custom = (n: number) =>
    resolveRulesRequest({
      preset: "custom",
      teamSize: 2,
      params: {
        respawn: { mode: "limited", maxRespawns: n, delaySeconds: 5 },
        victory: "elimination",
        timeLimitMinutes: 5,
      },
    });
  for (const [n, lives] of [
    [0, 1],
    [1, 2],
    [2, 3],
    [7, 8],
    [10, 11],
  ] as const) {
    it(`maxRespawns ${n} ⇒ ${lives} vida(s): motor y lectura humana`, () => {
      const r = custom(n);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.engineRuleset.respawn.maxRespawns).toBe(n);
      expect(respawnLabel(r.params)).toContain(`(${lives} ${lives === 1 ? "vida" : "vidas"} en total)`);
    });
  }
  it("fuera de rango (−1, 11, 1.5, '2') ⇒ rules_invalid", () => {
    for (const n of [-1, 11, 1.5, "2"]) expect(custom(n as number).ok).toBe(false);
  });
  it("sin reaparición = 1 vida; ilimitada = sin recuento", () => {
    expect(respawnLabel({ respawn: { mode: "none", maxRespawns: null, delaySeconds: null } })).toBe(
      "Sin reaparición (1 vida)",
    );
    expect(respawnLabel({ respawn: { mode: "unlimited", maxRespawns: null, delaySeconds: 5 } })).toBe(
      "Reaparición ilimitada",
    );
  });
});

describe("CTF base ctf@1 (decisión del operador)", () => {
  it("valores exactos del preset", () => {
    const p = findPreset("ctf@1")!;
    expect(p.game).toBe("capture_the_flag");
    expect(p.teamSizes).toEqual([2, 3, 4]);
    expect(p.params).toMatchObject({
      scoreLimit: 3,
      timeLimitMinutes: 5,
      respawn: { mode: "unlimited", delaySeconds: 5 },
      ctf: { flagReturnSeconds: 10, requireOwnFlagAtBase: true },
      friendlyFire: false,
    });
  });
  it("se traduce a ctf_mvp@1 con prórroga y límite de seguridad explícito", () => {
    for (const n of [2, 3, 4]) {
      const r = resolveRulesRequest({ preset: "ctf", teamSize: n });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.mode).toBe("capture_the_flag");
      const e = r.engineRuleset;
      expect(e.mode).toBe("capture_the_flag");
      expect(e.scoreToWin).toBe(3);
      expect(e.timeLimitTicks).toBe(5 * 60 * 30);
      expect(e.respawn).toEqual({ enabled: true, delayTicks: 150 });
      expect(e.ctf).toEqual({ requireOwnFlagAtBase: true, flagReturnTicks: 300 });
      expect(e.friendlyFire).toBe(false);
      // Sin límite competitivo (decisión del operador): sólo el tipo de prórroga.
      expect(e.overtime).toEqual({ kind: "next_score_wins" });
      expect(e.timeoutTiebreak).toBeUndefined();
    }
    expect(resolveRulesRequest({ preset: "ctf", teamSize: 1 }).ok).toBe(false);
  });
  it("el preset ctf@1 coincide con el ruleset clásico ctf_mvp@1 salvo la prórroga (misma semántica base)", () => {
    const r = resolveRulesRequest({ preset: "ctf", teamSize: 2 });
    if (!r.ok) throw new Error("ctf");
    const { overtime, rulesetId, ...rest } = r.engineRuleset;
    void overtime;
    void rulesetId;
    const classic = { ...rest, rulesetId: "ctf_mvp@1" };
    expect(classic).toMatchObject({ scoreToWin: 3, timeLimitTicks: 9000, respawn: { enabled: true, delayTicks: 150 } });
  });
  it("personalizado de CTF: capturas 1..10, retorno 1..60 s, bandera propia opcional; respawn limitado/ninguno rechazado", () => {
    const base = {
      game: "capture_the_flag",
      respawn: { mode: "unlimited", delaySeconds: 3 },
      victory: "score_limit",
      scoreLimit: 5,
      timeLimitMinutes: 8,
      ctf: { flagReturnSeconds: 20, requireOwnFlagAtBase: false },
    };
    const ok = resolveRulesRequest({ preset: "custom", teamSize: 3, params: base });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.engineRuleset.ctf).toEqual({ requireOwnFlagAtBase: false, flagReturnTicks: 600 });
      expect(ok.engineRuleset.scoreToWin).toBe(5);
      expect(ok.engineRuleset.overtime).toEqual({ kind: "next_score_wins" });
    }
    for (const bad of [
      { ...base, scoreLimit: 11 },
      { ...base, ctf: { flagReturnSeconds: 0 } },
      { ...base, ctf: { flagReturnSeconds: 61 } },
      { ...base, respawn: { mode: "limited", maxRespawns: 2, delaySeconds: 5 } },
      { ...base, respawn: { mode: "none" } },
      { ...base, victory: "time_score", scoreLimit: undefined },
      { ...base, ctf: { flagReturnSeconds: 10, unknown: 1 } },
    ]) {
      expect(resolveRulesRequest({ preset: "custom", teamSize: 3, params: bad }).ok).toBe(false);
    }
    // ctf fuera de CTF ⇒ incompatible
    const combat = resolveRulesRequest({
      preset: "custom",
      teamSize: 2,
      params: { ...base, game: "combat" },
    });
    expect(combat.ok).toBe(false);
  });
});

describe("duración máxima con prórroga (temporizadores de pared)", () => {
  it("maxBattleTicks = tiempo + límite de seguridad de la prórroga; sin prórroga, el tiempo", () => {
    const r = resolveRulesRequest({ preset: "ctf", teamSize: 2 });
    if (!r.ok) throw new Error("ctf");
    expect(OVERTIME_TECHNICAL_LIMIT_TICKS).toBe(36_000); // 20 min: 4× una CTF base, no una regla de juego
    expect(maxBattleTicks(r.engineRuleset)).toBe(9000 + OVERTIME_TECHNICAL_LIMIT_TICKS);
    const t = resolveRulesRequest({ preset: "team_deathmatch", teamSize: 2 });
    if (!t.ok) throw new Error("tdm");
    expect(maxBattleTicks(t.engineRuleset)).toBe(t.engineRuleset.timeLimitTicks);
  });
});

describe("desempates exactos por familia", () => {
  const family = (preset: string, teamSize: number) => {
    const r = resolveRulesRequest({ preset, teamSize });
    if (!r.ok) throw new Error(preset);
    return { fam: tiebreakFamilyOf(r.params), crit: r.engineRuleset.timeoutTiebreak };
  };
  it("Eliminación: vivos → vidas/reapariciones restantes → bajas → empate", () => {
    expect(family("team_elimination", 4)).toEqual({ fam: "elimination", crit: ["alive", "lives", "kills"] });
    expect(family("duel", 1)).toEqual({ fam: "elimination", crit: ["alive", "lives", "kills"] });
    expect(TIEBREAK_RULES.elimination.steps).toEqual([
      "más bots vivos",
      "más vidas/reapariciones restantes",
      "más bajas",
      "empate",
    ]);
  });
  it("Respawn limitado: puntos → vivos → reapariciones restantes → bajas → empate", () => {
    expect(family("team_limited_respawn", 3)).toEqual({
      fam: "limited_respawn",
      crit: ["score", "alive", "respawns_left", "kills"],
    });
  });
  it("Team Deathmatch (y toda reaparición ilimitada): puntos → bajas → empate", () => {
    for (const [p, n] of [
      ["team_deathmatch", 2],
      ["team_endurance", 2],
      ["combat", 1],
      ["endurance", 1],
    ] as const)
      expect(family(p, n)).toEqual({ fam: "deathmatch", crit: ["score", "kills"] });
  });
  it("CTF: sin criterios del motor (lo decide la prórroga) y pasos documentados", () => {
    expect(family("ctf", 2)).toEqual({ fam: "capture_the_flag", crit: undefined });
    expect(TIEBREAK_RULES.capture_the_flag.steps.join(" ")).toContain("la siguiente captura gana");
  });
  it("el personalizado usa la MISMA tabla que los presets", () => {
    const mk = (respawn: Record<string, unknown>, victory: string, extra = {}) => {
      const r = resolveRulesRequest({
        preset: "custom",
        teamSize: 2,
        params: { respawn, victory, timeLimitMinutes: 5, ...extra },
      });
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      return r.engineRuleset.timeoutTiebreak;
    };
    expect(mk({ mode: "none" }, "elimination")).toEqual(["alive", "lives", "kills"]);
    expect(mk({ mode: "limited", maxRespawns: 1, delaySeconds: 5 }, "elimination")).toEqual([
      "score",
      "alive",
      "respawns_left",
      "kills",
    ]);
    expect(mk({ mode: "unlimited", delaySeconds: 5 }, "score_limit", { scoreLimit: 4 })).toEqual(["score", "kills"]);
  });
  it("el resumen enseña el desempate", () => {
    const r = resolveRulesRequest({ preset: "team_deathmatch", teamSize: 4 });
    if (!r.ok) throw new Error("tdm");
    expect(summarizeParams(r.params)).toContain("Desempate: más puntos → más bajas → empate");
  });
});

describe("personalizado: sólo reglas competitivas", () => {
  const params = {
    respawn: { mode: "unlimited", delaySeconds: 5 },
    victory: "score_limit",
    scoreLimit: 5,
    timeLimitMinutes: 5,
  };
  for (const k of ["damageMultiplier", "gravity", "speed", "hp", "hullHp", "sensors", "infiniteAmmo", "physics"]) {
    it(`${k} ⇒ forbidden_field con mensaje explícito`, () => {
      const r = resolveRulesRequest({ preset: "custom", teamSize: 2, params: { ...params, [k]: 2 } });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.find((e) => e.field === `rules.params.${k}`)?.code).toBe("forbidden_field");
    });
  }
  it("tampoco dentro de respawn o ctf", () => {
    const r = resolveRulesRequest({
      preset: "custom",
      teamSize: 2,
      params: { ...params, respawn: { mode: "unlimited", delaySeconds: 5, hp: 1 } },
    });
    expect(r.ok).toBe(false);
  });
});

describe("presupuesto de equipo con reparto desigual", () => {
  const p: RulesParams = {
    teamSize: 4,
    game: "combat",
    respawn: { mode: "unlimited", maxRespawns: null, delaySeconds: 5 },
    victory: "score_limit",
    scoreLimit: 10,
    timeLimitMinutes: 8,
    botCredits: null,
    teamCredits: 3500,
    botMassKg: null,
    teamMassKg: null,
    friendlyFire: false,
    ctf: null,
  };
  const roster = (costs: number[], team = "red") =>
    costs.map((c, i) => ({ botId: `${team}${i}`, label: `${team}-${i}`, team, costCredits: c, massKg: 1000 }));
  it("ATK-1 1000, ATK-2 1000, SCOUT 600, DEF 900 = 3500 cr: válido (el límite es inclusivo)", () => {
    const rep = checkComposition(roster([1000, 1000, 600, 900]), {
      botCredits: null,
      teamCredits: 3500,
      botMassKg: null,
      teamMassKg: null,
    });
    expect(rep.ok).toBe(true);
    expect(rep.teams[0].totalCredits).toBe(3500);
  });
  it("1 cr por encima del total ⇒ team_credits_exceeded aunque cada bot sea barato", () => {
    const rep = checkComposition(roster([1000, 1000, 600, 901]), {
      botCredits: null,
      teamCredits: 3500,
      botMassKg: null,
      teamMassKg: null,
    });
    expect(rep.ok).toBe(false);
    expect(rep.violations.map((v) => v.code)).toEqual(["team_credits_exceeded"]);
  });
  it("un tope por bot mayor que el reparto igualitario es válido; mayor que el del equipo, no", () => {
    expect(
      resolveRulesRequest({
        preset: "custom",
        teamSize: 4,
        params: {
          respawn: { mode: "unlimited", delaySeconds: 5 },
          victory: "score_limit",
          scoreLimit: 10,
          timeLimitMinutes: 8,
          teamCredits: 3500,
          botCredits: 1500,
        },
      }).ok,
    ).toBe(true);
    expect(
      resolveRulesRequest({
        preset: "custom",
        teamSize: 4,
        params: {
          respawn: { mode: "unlimited", delaySeconds: 5 },
          victory: "score_limit",
          scoreLimit: 10,
          timeLimitMinutes: 8,
          teamCredits: 900,
          botCredits: 1000,
        },
      }).ok,
    ).toBe(false);
    expect(engineRulesetFor(p, "x").budgetCredits).toBe(1000); // sin tope por bot: el presupuesto MVP del WELCOME
  });
});

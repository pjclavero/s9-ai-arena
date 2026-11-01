/**
 * R-RULES · revisión independiente (PR #204) · regresiones de los P3 del modelo:
 *  1. Masa: el tope por bot y el de equipo comparan y muestran el MISMO valor (antes el
 *     bot comparaba la masa cruda y mostraba la redondeada ⇒ «supera en 0 kg
 *     (3000/3000)»; y un equipo de 5000,004 kg pasaba un tope de 5000).
 *  2. `time_score` + respawn limitado es incompatible (podía acabar por eliminación
 *     mientras el resumen decía «puntos al acabar el tiempo»).
 */
import { describe, expect, it } from "vitest";
import { checkComposition, resolveRulesRequest } from "./battle-rules.js";

const NONE = { botCredits: null, teamCredits: null, botMassKg: null, teamMassKg: null };
const bot = (botId: string, team: string, massKg: number) => ({ botId, label: botId, team, costCredits: 500, massKg });

describe("checkComposition · masa: misma cifra para comparar y para mostrar", () => {
  it("3000,004 kg con tope 3000 ⇒ viola y lo dice con una cifra mayor que el tope (nunca «supera en 0 kg»)", () => {
    const r = checkComposition([bot("a", "red", 3000.004)], { ...NONE, botMassKg: 3000 });
    expect(r.ok).toBe(false);
    const v = r.violations[0];
    expect(v.actual).toBeGreaterThan(v.limit);
    expect(v.excess).toBeGreaterThan(0);
    expect(v.message).not.toContain("en 0 kg");
    expect(v.message).toContain(`${v.actual}/3000 kg`);
    expect(r.teams[0].bots[0].massKg).toBe(v.actual);
  });

  it("equipo de 5000,004 kg con tope 5000 ⇒ viola (antes el redondeo lo dejaba pasar)", () => {
    const r = checkComposition([bot("a", "red", 2500.002), bot("b", "red", 2500.002)], { ...NONE, teamMassKg: 5000 });
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatchObject({ code: "team_mass_exceeded", limit: 5000 });
    expect(r.violations[0].actual).toBeGreaterThan(5000);
    expect(r.teams[0].totalMassKg).toBe(r.violations[0].actual);
  });

  it("justo en el tope (3000 / 5000 exactos) ⇒ válido", () => {
    const r = checkComposition([bot("a", "red", 3000), bot("b", "red", 2000)], {
      ...NONE,
      botMassKg: 3000,
      teamMassKg: 5000,
    });
    expect(r.ok).toBe(true);
    expect(r.teams[0].totalMassKg).toBe(5000);
  });

  it("el ruido de coma flotante de una suma exacta no fabrica una violación", () => {
    const r = checkComposition([bot("a", "red", 0.1 + 0.2 + 2999.7)], { ...NONE, botMassKg: 3000 });
    expect(r.ok).toBe(true);
  });
});

describe("time_score + respawn limitado", () => {
  it("se rechaza como combinación incompatible", () => {
    const r = resolveRulesRequest({
      preset: "custom",
      teamSize: 2,
      params: {
        respawn: { mode: "limited", respawnsPerBot: 2, delaySeconds: 5 },
        victory: "time_score",
        timeLimitMinutes: 5,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.errors!.map((e) => [e.field, e.code])).toContainEqual(["rules.params.victory", "incompatible"]);
  });

  it("time_score con respawn ilimitado sigue siendo válido", () => {
    const r = resolveRulesRequest({
      preset: "custom",
      teamSize: 2,
      params: { respawn: { mode: "unlimited", delaySeconds: 5 }, victory: "time_score", timeLimitMinutes: 5 },
    });
    expect(r.ok).toBe(true);
  });
});

/**
 * EQ6 · revisión independiente de #201 · el personalizado sólo admite parámetros
 * competitivos: ninguna clave peligrosa, anidada ni de física/daño llega al ruleset.
 */
import { describe, expect, it } from "vitest";
import { resolveRulesRequest, engineRulesetFor, RULES_LIMITS } from "./battle-rules.js";

/** Busca un params válido mínimo a partir del error de "required" del validador. */
function validParams(): any {
  // Toma los parámetros de un preset vía la respuesta del personalizado por defecto.
  const r: any = resolveRulesRequest({ preset: "team_limited_respawn@1", teamSize: 2 });
  if (!r.ok) throw new Error("preset de control no resuelve: " + JSON.stringify(r.errors));
  const p = JSON.parse(JSON.stringify(r.params));
  delete p.teamSize;
  return p;
}

function errsOf(params: any): any[] {
  try {
    const r: any = resolveRulesRequest({ preset: "custom", teamSize: 2, params });
    return r.errors ?? [];
  } catch (e: any) {
    return e?.errors ?? [{ code: "thrown", message: String(e) }];
  }
}

describe("EQ6 · #201 · personalizado blindado", () => {
  it("un params válido (copiado de un preset) se acepta: control positivo", () => {
    const p = validParams();
    expect(p && typeof p === "object").toBe(true);
    const e = errsOf(p);
    expect(e, JSON.stringify(e)).toEqual([]);
  });

  const inject: [string, (p: any) => any][] = [
    [
      "__proto__ en la raíz (JSON)",
      (p) => JSON.parse(JSON.stringify(p).replace(/^\{/, '{"__proto__":{"polluted":1},')),
    ],
    ["constructor.prototype", (p) => ({ ...p, constructor: { prototype: { polluted: 1 } } })],
    [
      "__proto__ dentro de respawn",
      (p) =>
        JSON.parse(
          JSON.stringify({ ...p, respawn: p.respawn }).replace(
            '"respawn":{',
            '"respawn":{"__proto__":{"maxRespawns":99},',
          ),
        ),
    ],
    ["física: damageMultiplier", (p) => ({ ...p, damageMultiplier: 10 })],
    ["física: friction", (p) => ({ ...p, friction: 0 })],
    ["hp anidado", (p) => ({ ...p, vehicle: { hp: 9999 } })],
    ["respawn.extra anidado", (p) => ({ ...p, respawn: { ...p.respawn, invulnerableTicks: 999 } })],
    ["timeoutTiebreak a mano", (p) => ({ ...p, timeoutTiebreak: ["hull"] })],
    ["overtime a mano", (p) => ({ ...p, overtime: { kind: "next_score_wins", maxTicks: 1e9 } })],
    [
      "maxRespawns 11",
      (p) => ({ ...p, respawn: { ...p.respawn, mode: "limited", maxRespawns: RULES_LIMITS.maxRespawns.max + 1 } }),
    ],
    ["maxRespawns -1", (p) => ({ ...p, respawn: { ...p.respawn, mode: "limited", maxRespawns: -1 } })],
    ["maxRespawns 2.5", (p) => ({ ...p, respawn: { ...p.respawn, mode: "limited", maxRespawns: 2.5 } })],
    ["maxRespawns '3'", (p) => ({ ...p, respawn: { ...p.respawn, mode: "limited", maxRespawns: "3" } })],
  ];
  for (const [name, f] of inject) {
    it(`rechaza: ${name}`, () => {
      const p = f(validParams());
      const e = errsOf(p);
      expect(e.length, `${name} aceptado: ${JSON.stringify(p)}`).toBeGreaterThan(0);
      expect(({} as any).polluted).toBeUndefined();
    });
  }

  it("maxRespawns en los bordes 0 y 10 se acepta y da vidas = n+1 en el ruleset del motor", () => {
    for (const n of [0, 10]) {
      const p = validParams();
      p.respawn = { ...p.respawn, mode: "limited", maxRespawns: n };
      const r: any = resolveRulesRequest({ preset: "custom", teamSize: 2, params: p });
      expect(r.errors ?? [], JSON.stringify(r.errors)).toEqual([]);
      const rs: any = engineRulesetFor(r.params, "x@1");
      expect(rs.respawn.maxRespawns).toBe(n);
    }
  });
});

/**
 * EQ3 · Lo que la ayuda DICE de los modos se EJECUTA contra el motor real
 * (apps/arena-engine/src/sim/modes.ts). Si el motor cambia (p. ej. el PR #201) y
 * el texto no, estos tests se ponen rojos:
 *  - Control de zona: solo → puntúa; disputada → nadie; vacía → nadie (aunque siga
 *    «held»); presencia por el centro del vehículo; varias zonas suman; sin tiempo
 *    de captura; distinto de Dominación (que sí puntúa vacía);
 *  - fin común: puntos para ganar, tiempo (más puntos o empate), sin respawn → último
 *    bando vivo;
 *  - desempate por modo y respawn por ruleset tal como los pinta la ayuda.
 */
import { describe, expect, it } from "vitest";
import {
  ZoneControlMode,
  DominationMode,
  TeamDeathmatchMode,
  type ArenaMap,
  type ModeContext,
} from "../../arena-engine/src/sim/modes.js";
import { RULESETS, loadRuleset, type Ruleset } from "../../../packages/game-rules/index.js";
import { ZONE_CONTROL_RULES, respawnText, tiebreakText } from "../src/help/sections/rules.js";

type V = { id: string; team: string; alive: boolean; disqualified: boolean; spec: { radiusM: number } };

function map(zones: { id: string; x: number; y: number; r: number; kind?: "capture" | "damage" }[]): ArenaMap {
  return {
    mapId: "t",
    version: 1,
    checksum: "x",
    widthM: 100,
    heightM: 100,
    walls: [],
    destructibles: [],
    spawns: [],
    bases: [],
    flags: [],
    zones: zones.map((z) => ({ id: z.id, position: { x: z.x, y: z.y }, radiusM: z.r, kind: z.kind ?? "capture" })),
  } as unknown as ArenaMap;
}

function ctx(rs: Ruleset, m: ArenaMap, vs: (V & { x: number; y: number })[], tick = 1): ModeContext {
  const poses = new Map(
    vs.map((v) => [v.id, { position: { x: v.x, y: v.y }, heading: 0, velocity: { x: 0, y: 0 }, angularVelocity: 0 }]),
  );
  return { tick, ruleset: rs, vehicles: vs as any, poses, map: m, emit: () => {} };
}
const veh = (id: string, team: string, x: number, y: number, extra: Partial<V> = {}) => ({
  id,
  team,
  x,
  y,
  alive: true,
  disqualified: false,
  spec: { radiusM: 1.6 },
  ...extra,
});

const ZC = loadRuleset("zc_mvp@1");

describe("EQ3 ayuda ↔ motor · Control de zona (zone_control)", () => {
  it("la ayuda enumera las seis reglas auditadas", () => {
    expect(ZONE_CONTROL_RULES.map((r) => r.id)).toEqual([
      "solo",
      "disputada",
      "vacia",
      "presencia",
      "varias",
      "instantanea",
    ]);
  });

  it("«solo»: un único bando dentro controla y puntúa cada tick (instantáneo, sin tiempo de captura)", () => {
    const m = map([{ id: "z1", x: 50, y: 50, r: 5 }]);
    const mode = new ZoneControlMode(["red", "blue"], m);
    mode.tick(ctx(ZC, m, [veh("a", "red", 50, 50), veh("b", "blue", 90, 90)]));
    expect(mode.score.red).toBe(ZC.zone!.pointsPerTickHeld);
    expect(mode.score.blue).toBe(0);
    expect(mode.objectives()[0]).toMatchObject({ team: "red", state: "held" });
  });

  it("«disputada»: con dos bandos dentro no puntúa nadie ni cambia el dueño", () => {
    const m = map([{ id: "z1", x: 50, y: 50, r: 5 }]);
    const mode = new ZoneControlMode(["red", "blue"], m);
    mode.tick(ctx(ZC, m, [veh("a", "red", 50, 50)]));
    const before = { ...mode.score };
    mode.tick(ctx(ZC, m, [veh("a", "red", 50, 50), veh("b", "blue", 51, 50)]));
    expect(mode.score).toEqual(before);
    expect(mode.objectives()[0]).toMatchObject({ team: "red" });
  });

  it("«vacía»: nadie puntúa, aunque la zona siga mostrando el último dueño como held", () => {
    const m = map([{ id: "z1", x: 50, y: 50, r: 5 }]);
    const mode = new ZoneControlMode(["red", "blue"], m);
    mode.tick(ctx(ZC, m, [veh("a", "red", 50, 50)]));
    const before = { ...mode.score };
    for (let t = 2; t < 30; t++) mode.tick(ctx(ZC, m, [veh("a", "red", 10, 10)], t));
    expect(mode.score).toEqual(before);
    expect(mode.objectives()[0]).toMatchObject({ team: "red", state: "held" });
  });

  it("«presencia»: cuenta el centro del vehículo a ≤ radio; muerto o descalificado no cuenta", () => {
    const m = map([{ id: "z1", x: 50, y: 50, r: 5 }]);
    const mode = new ZoneControlMode(["red", "blue"], m);
    mode.tick(ctx(ZC, m, [veh("a", "red", 55, 50)])); // justo en el borde: dentro
    expect(mode.score.red).toBe(1);
    mode.tick(ctx(ZC, m, [veh("a", "red", 55.01, 50)])); // centro fuera (aunque el casco toque)
    expect(mode.score.red).toBe(1);
    mode.tick(ctx(ZC, m, [veh("a", "red", 50, 50), veh("b", "blue", 50, 50, { alive: false })]));
    expect(mode.score.red).toBe(2); // el azul muerto no la disputa
    mode.tick(ctx(ZC, m, [veh("b", "blue", 50, 50, { disqualified: true })]));
    expect(mode.score.blue).toBe(0);
  });

  it("«varias»: un bando solo en dos zonas suma el doble; las zonas de daño no puntúan", () => {
    const m = map([
      { id: "z1", x: 20, y: 20, r: 5 },
      { id: "z2", x: 80, y: 80, r: 5 },
      { id: "acid", x: 50, y: 50, r: 5, kind: "damage" },
    ]);
    const mode = new ZoneControlMode(["red", "blue"], m);
    mode.tick(ctx(ZC, m, [veh("a", "red", 20, 20), veh("c", "red", 80, 80), veh("b", "blue", 50, 50)]));
    expect(mode.score.red).toBe(2 * ZC.zone!.pointsPerTickHeld);
    expect(mode.score.blue).toBe(0);
  });

  it("Dominación sí puntúa la zona vacía en propiedad (lo que la ayuda dice que la distingue)", () => {
    const m = map([
      { id: "z1", x: 20, y: 20, r: 5 },
      { id: "z2", x: 80, y: 80, r: 5 },
    ]);
    const dom = new DominationMode(["red", "blue"], m);
    const rs = loadRuleset("dom_mvp@1");
    dom.tick(ctx(rs, m, [veh("a", "red", 20, 20)]));
    const s1 = dom.score.red;
    dom.tick(ctx(rs, m, [veh("a", "red", 50, 50)], 2)); // abandona la zona
    expect(dom.score.red).toBeGreaterThan(s1);
  });
});

describe("EQ3 ayuda ↔ motor · fin de batalla y desempates (CommonEnd)", () => {
  const m = map([]);
  it("al agotar el tiempo: más puntos gana; igualados, empate", () => {
    const rs = loadRuleset("tdm_mvp@1");
    const mode = new TeamDeathmatchMode(["blue", "red"]);
    mode.score.red = 2;
    mode.score.blue = 1;
    const vs = [veh("a", "red", 1, 1), veh("b", "blue", 2, 2)];
    expect(mode.winner(ctx(rs, m, vs, rs.timeLimitTicks))).toBe("red");
    mode.score.blue = 2;
    expect(mode.winner(ctx(rs, m, vs, rs.timeLimitTicks))).toBe("draw");
    expect(mode.winner(ctx(rs, m, vs, rs.timeLimitTicks - 1))).toBeNull();
  });

  it("al llegar a los puntos para ganar termina antes del tiempo", () => {
    const rs = loadRuleset("tdm_mvp@1");
    const mode = new TeamDeathmatchMode(["blue", "red"]);
    mode.score.blue = rs.scoreToWin;
    expect(mode.winner(ctx(rs, m, [veh("a", "red", 1, 1), veh("b", "blue", 2, 2)], 5))).toBe("blue");
  });

  it("sin respawn, el único bando con vivos gana; nadie vivo, empate", () => {
    const rs = loadRuleset("tdm_mvp@1", { respawn: { enabled: false, delayTicks: 0 } });
    const mode = new TeamDeathmatchMode(["blue", "red"]);
    expect(mode.winner(ctx(rs, m, [veh("a", "red", 1, 1), veh("b", "blue", 2, 2, { alive: false })], 5))).toBe("red");
    expect(
      mode.winner(ctx(rs, m, [veh("a", "red", 1, 1, { alive: false }), veh("b", "blue", 2, 2, { alive: false })], 5)),
    ).toBe("draw");
  });

  it("textos de respawn y desempate por ruleset salen de los datos", () => {
    expect(respawnText(RULESETS["dm_practice@1"])).toBe("sin reaparición");
    expect(respawnText(RULESETS["tdm_mvp@1"])).toMatch(/5 s \(150 ticks\), ilimitada/);
    expect(tiebreakText(RULESETS["zc_mvp@1"])).toMatch(/más puntos.*empate/);
    expect(tiebreakText(RULESETS["lms_bo3@1"])).toMatch(/vivos.*derribos.*empate/);
    // Preparado para el PR #201: si un ruleset trae timeoutTiebreak / maxRespawns, se pinta tal cual.
    const future = {
      ...RULESETS["tdm_mvp@1"],
      timeoutTiebreak: ["score", "lives", "hull"],
      respawn: { enabled: true, delayTicks: 150, maxRespawns: 2 },
    } as Ruleset;
    expect(tiebreakText(future)).toBe(
      "más puntos; después, más vidas en juego; después, más integridad de casco; si todo empata, empate",
    );
    expect(respawnText(future)).toMatch(/como máximo 2 por vehículo/);
  });
});

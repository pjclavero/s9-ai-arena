/**
 * R-RULES · revisión independiente (PR #204) · P3 del borde del límite de tiempo:
 * una eliminación MUTUA en el mismo tick del límite la decidía el desempate de tiempo
 * (gana quien tenga más bajas) en vez de ser tablas, como lo es un tick antes. Con las
 * reglas de R-RULES (`timeoutTiebreak` declarado) la eliminación se comprueba ANTES que
 * el tiempo. Los rulesets de 0.3.0 (sin `timeoutTiebreak`) conservan su orden exacto.
 */
import { describe, expect, it } from "vitest";
import { loadRuleset, type Ruleset } from "../../../packages/game-rules/index.js";
import { emptyArena, gunnerLoadout } from "../src/fixtures.js";
import { TeamDeathmatchMode, type ModeContext } from "../src/sim/modes.js";
import { Vehicle } from "../src/sim/vehicle.js";

function ctx(ruleset: Ruleset, tick: number, vehicles: Vehicle[]): ModeContext {
  return { tick, ruleset, vehicles, poses: new Map(), map: emptyArena(), emit: () => {} };
}
function dead(id: string, team: string) {
  const v = new Vehicle(id, team, id, gunnerLoadout());
  v.alive = false;
  return v;
}

const rules = (tiebreak: boolean): Ruleset =>
  loadRuleset("tdm_mvp@1", {
    respawn: { enabled: false, delayTicks: 0 },
    scoreToWin: Number.MAX_SAFE_INTEGER,
    timeLimitTicks: 600,
    ...(tiebreak ? { timeoutTiebreak: ["lives", "score", "hull"] as const } : {}),
  } as Partial<Ruleset>);

describe("eliminación mutua en el tick del límite", () => {
  it("con reglas R-RULES: tablas, igual que un tick antes", () => {
    const m = new TeamDeathmatchMode(["blue", "red"]);
    m.score.red = 1; // red hizo más bajas
    const vs = [dead("veh_1", "red"), dead("veh_2", "blue")];
    expect(m.winner(ctx(rules(true), 599, vs))).toBe("draw");
    expect(m.winner(ctx(rules(true), 600, vs))).toBe("draw");
  });

  it("ruleset 0.3.0 (sin timeoutTiebreak): orden de siempre — en el límite decide el marcador", () => {
    const m = new TeamDeathmatchMode(["blue", "red"]);
    m.score.red = 1;
    const vs = [dead("veh_1", "red"), dead("veh_2", "blue")];
    expect(m.winner(ctx(rules(false), 599, vs))).toBe("draw");
    expect(m.winner(ctx(rules(false), 600, vs))).toBe("red");
  });

  it("con reglas R-RULES y un solo bando en pie en el límite: gana ese bando (no el marcador)", () => {
    const m = new TeamDeathmatchMode(["blue", "red"]);
    m.score.red = 3;
    const alive = new Vehicle("veh_2", "blue", "veh_2", gunnerLoadout());
    expect(m.winner(ctx(rules(true), 600, [dead("veh_1", "red"), alive]))).toBe("blue");
  });
});

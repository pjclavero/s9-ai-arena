/**
 * B8 (hallazgo BLOQUEANTE del supervisor) · El marcador de `BaseMode` decide
 * QUIÉN GANA, y era un `Record<string, number> = {}` con NOMBRES DE EQUIPO como
 * clave — la misma trampa que `roundWins` en match.ts, un eslabón más arriba.
 *
 * El test es de COMPORTAMIENTO en el sentido que importa aquí: no comprueba que
 * la clave exista en el objeto, comprueba que **gana quien puntúa**. Esa es la
 * consecuencia que le duele a un usuario; un test que solo mirara
 * `hasOwnProperty` habría pasado incluso con un `winner()` roto.
 *
 * Alcance real: `createPracticeBattle` tiene `x-min-role: user` y acepta `team`
 * como string sin restricción, así que cualquier usuario autenticado podía
 * llegar aquí.
 */
import { describe, expect, it } from "vitest";
import {
  DeathmatchMode,
  TeamDeathmatchMode,
  LastManStandingMode,
  type ModeContext,
  type ArenaMap,
} from "../src/sim/modes.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";

/** Claves heredadas de Object.prototype: todas rompen un `{}` usado de diccionario. */
const POISONED = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"] as const;

const MAP: ArenaMap = {
  mapId: "test",
  version: 1,
  checksum: "x",
  widthM: 100,
  heightM: 100,
  walls: [],
  destructibles: [],
  spawns: [],
  bases: [],
  flags: [],
  zones: [],
};

function ctx(tick: number, vehicles: unknown[] = [], scoreToWin = 1000): ModeContext {
  return {
    tick,
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 100, scoreToWin }),
    vehicles: vehicles as ModeContext["vehicles"],
    poses: new Map(),
    map: MAP,
    emit: () => {},
  };
}

/** Vehículo mínimo: `onKill`/`winner` solo miran team/alive/disqualified. */
function veh(team: string, alive = true) {
  return { id: `v_${team}`, team, alive, disqualified: false } as never;
}

describe("B8 · un equipo con nombre envenenado PUNTÚA y GANA como cualquier otro", () => {
  for (const evil of POISONED) {
    it(`team_deathmatch · "${evil}" con 5 bajas gana a "blue" con 1`, () => {
      const mode = new TeamDeathmatchMode([evil, "blue"]);

      // El constructor debe haber creado la entrada a 0. Con `{}` ni eso pasaba.
      expect(mode.score[evil], "el constructor no creó la entrada del equipo").toBe(0);

      const c = ctx(0);
      for (let i = 0; i < 5; i++) mode.onKill(veh("blue"), evil, c);
      mode.onKill(veh(evil), "blue", c);

      // Lo que importa: el marcador REFLEJA lo ocurrido...
      expect(mode.score[evil]).toBe(5);
      expect(mode.score.blue).toBe(1);
      // ...y es VISIBLE: el marcador viaja al visor y al resultado por
      // `{ ...this.score }`, y con `{}` la clave envenenada desaparecía de esa
      // copia (el supervisor midió `score visible = {"blue":1}`).
      const visible = { ...mode.score };
      expect(Object.keys(visible).sort()).toEqual([evil, "blue"].sort());
      expect(visible[evil]).toBe(5);
      expect(visible.blue).toBe(1);

      // ...y GANA quien más ha puntuado al agotarse el tiempo. Antes del arreglo
      // esto devolvía "blue": el equipo con 1 punto ganaba al de 5.
      expect(mode.winner(ctx(100))).toBe(evil);
    });
  }

  it("deathmatch (cada vehículo su propio equipo) · el envenenado también puntúa", () => {
    const mode = new DeathmatchMode(
      [POISONED[0], "b"],
      [
        { id: "v1", team: POISONED[0] },
        { id: "v2", team: "b" },
      ],
    );
    const c = ctx(0);
    mode.onKill(veh("b"), POISONED[0], c);
    mode.onKill(veh("b"), POISONED[0], c);
    expect(mode.score[POISONED[0]]).toBe(2);
    expect(mode.winner(ctx(100))).toBe(POISONED[0]);
  });

  it("scoreToWin: el envenenado gana por puntos ANTES del límite de tiempo", () => {
    const mode = new TeamDeathmatchMode(["__proto__", "blue"]);
    const c = ctx(0, [], 3);
    for (let i = 0; i < 3; i++) mode.onKill(veh("blue"), "__proto__", c);
    // tick 0, muy lejos del timeLimit: solo puede ganar por scoreToWin.
    expect(mode.winner(ctx(0, [], 3))).toBe("__proto__");
  });

  it("last_man_standing · el comparador de desempate NO devuelve NaN", () => {
    const mode = new LastManStandingMode(["__proto__", "blue"]);
    const c = ctx(0);
    for (let i = 0; i < 4; i++) mode.onKill(veh("blue"), "__proto__", c);
    mode.onKill(veh("__proto__"), "blue", c);

    // Ambos siguen en pie ⇒ se resuelve por bajas. El supervisor midió `NaN` aquí.
    const diff = (mode.score["blue"] ?? 0) - (mode.score["__proto__"] ?? 0);
    expect(Number.isNaN(diff)).toBe(false);
    expect(diff).toBe(1 - 4);

    const vivos = [veh("__proto__"), veh("blue")];
    const w = mode.winner(ctx(100, vivos));
    expect(w).not.toBe("draw");
    expect(w).toBe("__proto__");
  });

  it("un empate real sigue siendo empate (el arreglo no inventa ganadores)", () => {
    const mode = new TeamDeathmatchMode(["__proto__", "blue"]);
    const c = ctx(0);
    mode.onKill(veh("blue"), "__proto__", c);
    mode.onKill(veh("__proto__"), "blue", c);
    expect(mode.winner(ctx(100))).toBe("draw");
  });

  it("los equipos normales siguen comportándose EXACTAMENTE igual", () => {
    const mode = new TeamDeathmatchMode(["red", "blue"]);
    const c = ctx(0);
    for (let i = 0; i < 3; i++) mode.onKill(veh("blue"), "red", c);
    mode.onKill(veh("red"), "blue", c);
    expect(mode.score).toEqual({ red: 3, blue: 1 });
    expect(mode.winner(ctx(100))).toBe("red");
  });
});

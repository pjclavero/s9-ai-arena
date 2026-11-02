/**
 * EQ6 · revisión independiente de #201 · prórroga de CTF (motor 0.4.0, decisión del operador).
 *
 * Decisión literal: «quitar el límite competitivo de 3 minutos de la prórroga CTF;
 * conservar únicamente la salvaguarda técnica global, diferenciándola claramente de un
 * resultado deportivo». Se exige:
 *  - empate al tiempo ⇒ la batalla NO termina y sigue con el mismo estado;
 *  - NO hay tope de 3 min: una captura MUCHO después de los 3 min de prórroga sigue ganando;
 *  - la salvaguarda técnica detiene en T + OVERTIME_TECHNICAL_LIMIT_TICKS SIN resultado
 *    deportivo: winner null (nunca "draw"), endReason technical_limit y evento propio.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { OVERTIME_TECHNICAL_LIMIT_TICKS, TICK_HZ, loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { ctfArena, sandbagLoadout, scoutLoadout } from "../src/fixtures.js";
import { FlagRunnerBot, IdleBot } from "../src/stubs.js";

beforeAll(async () => {
  await initPhysics();
});

/** Se queda quieto hasta `fromTick` y después corre a por la bandera. */
class LateRunner {
  private runner: FlagRunnerBot;
  constructor(
    readonly botId: string,
    private fromTick: number,
    flag: { x: number; y: number },
    base: { x: number; y: number },
  ) {
    this.runner = new FlagRunnerBot(botId, flag, base);
  }
  decide(obs: any) {
    return obs.tick < this.fromTick ? { forTick: obs.tick } : this.runner.decide(obs);
  }
}

function make(T: number, runnerFrom: number | null) {
  const map = ctfArena();
  const b = new Battle({
    battleId: `eq6-ot-${T}-${runnerFrom}`,
    seed: "eq6-ot",
    ruleset: loadRuleset("ctf_mvp@1", {
      timeLimitTicks: T,
      scoreToWin: 99,
      overtime: { kind: "next_score_wins" },
    } as any),
    map,
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
      { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
    ],
  });
  b.attachBot(
    "veh_1",
    runnerFrom === null
      ? new IdleBot("b1")
      : (new LateRunner(
          "b1",
          runnerFrom,
          map.flags.find((f) => f.team === "blue")!.position,
          map.bases.find((x) => x.team === "red")!.position,
        ) as any),
  );
  b.attachBot("veh_2", new IdleBot("b2"));
  return b;
}

const THREE_MIN = 3 * 60 * TICK_HZ;

describe("EQ6 · #201 · prórroga CTF sin tope competitivo", () => {
  it("una captura 4 min DESPUÉS de empezar la prórroga sigue ganando (no hay tope de 3 min)", () => {
    const T = 30;
    const start = T + THREE_MIN + 60 * TICK_HZ; // 4 min de prórroga antes de moverse
    const b = make(T, start);
    for (let t = 0; t < T + OVERTIME_TECHNICAL_LIMIT_TICKS + 5 && !b.isFinished(); t++) b.step();
    const r = b.getResult()!;
    expect(r.winner, `terminó en ${r.ticks} con ${String(r.winner)}`).toBe("red");
    expect(r.ticks).toBeGreaterThan(start);
    expect((r as any).endReason).toBeUndefined();
    expect(b.publicEvents.some((e: any) => e.kind === "overtime_started")).toBe(true);
    b.free();
  }, 300_000);

  it("sin captura: la salvaguarda técnica detiene en T + límite SIN resultado deportivo (nunca draw)", () => {
    const T = 30;
    const b = make(T, null);
    for (let t = 0; t < T + THREE_MIN + 10; t++) b.step();
    expect(b.isFinished(), "terminó a los 3 min de prórroga: el tope competitivo sigue ahí").toBe(false);
    for (let t = 0; t < OVERTIME_TECHNICAL_LIMIT_TICKS + 10 && !b.isFinished(); t++) b.step();
    const r = b.getResult()!;
    expect(r.ticks).toBe(T + OVERTIME_TECHNICAL_LIMIT_TICKS);
    expect(r.winner, "la salvaguarda técnica no puede dar un resultado deportivo").toBeNull();
    expect(r.winner).not.toBe("draw");
    expect((r as any).endReason).toBe("technical_limit");
    expect(b.publicEvents.some((e: any) => e.kind === "technical_limit")).toBe(true);
    b.free();
  }, 600_000);
});

/**
 * EQ6 · revisión independiente de #201 · prórroga de CTF (motor 0.4.0).
 *  - empate al tiempo ⇒ la batalla NO termina, el estado sigue (nadie vuelve a su spawn);
 *  - la siguiente captura gana;
 *  - sin captura, al agotar el límite de seguridad ⇒ draw exactamente en T + maxTicks.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { ctfArena, sandbagLoadout, scoutLoadout } from "../src/fixtures.js";
import { FlagRunnerBot, ForwardBot, IdleBot } from "../src/stubs.js";

beforeAll(async () => {
  await initPhysics();
});

function make(T: number, M: number, runner: boolean) {
  const map = ctfArena();
  const b = new Battle({
    battleId: `eq6-ot-${T}-${M}-${runner}`,
    seed: "eq6-ot",
    ruleset: loadRuleset("ctf_mvp@1", {
      timeLimitTicks: T,
      scoreToWin: 99,
      overtime: { kind: "next_score_wins", maxTicks: M },
    } as any),
    map,
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
      { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
    ],
  });
  b.attachBot(
    "veh_1",
    runner
      ? new FlagRunnerBot(
          "b1",
          map.flags.find((f) => f.team === "blue")!.position,
          map.bases.find((x) => x.team === "red")!.position,
        )
      : new ForwardBot("b1"),
  );
  b.attachBot("veh_2", new IdleBot("b2"));
  return b;
}

const pose = (b: Battle, id: string) => (b as any).snapshots.at(-1)?.vehicles?.find((v: any) => v.id === id)?.position;

describe("EQ6 · #201 · prórroga CTF", () => {
  it("sin captura: no termina en T, el estado sigue y termina en draw en T + maxTicks", () => {
    const T = 60;
    const M = 90;
    const b = make(T, M, false);
    for (let t = 0; t < T; t++) b.step();
    expect(b.isFinished(), "terminó al acabar el tiempo pese al empate").toBe(false);
    const before = JSON.stringify(pose(b, "veh_1"));
    b.step();
    const after = JSON.stringify(pose(b, "veh_1"));
    expect(after, "la prórroga reinició posiciones").not.toBe(JSON.stringify(ctfArena().spawns?.[0]?.position));
    expect(typeof before).toBe("string");
    for (let t = 0; t < M + 5 && !b.isFinished(); t++) b.step();
    const r = b.getResult()!;
    expect(r.winner).toBe("draw");
    expect(r.ticks).toBe(T + M);
    expect(b.publicEvents.some((e: any) => e.kind === "overtime_started")).toBe(true);
    b.free();
  }, 60_000);

  it("con un corredor: la primera captura en prórroga gana (sin esperar al límite)", () => {
    const T = 30; // demasiado corto para capturar en tiempo reglamentario
    const M = 20_000;
    const b = make(T, M, true);
    for (let t = 0; t < T + M + 5 && !b.isFinished(); t++) b.step();
    const r = b.getResult()!;
    expect(r.winner).toBe("red");
    expect(r.ticks).toBeGreaterThan(T);
    expect(r.ticks).toBeLessThan(T + M);
    expect((r.score as any).red).toBe(1);
    b.free();
  }, 120_000);
});

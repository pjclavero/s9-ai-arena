/**
 * T2.1 · DETERMINISMO. La propiedad de la que depende todo lo demás.
 *
 * Si esto falla, no hay replays verificables, ni torneos auditables, ni balance
 * reproducible. Es el test que más veces se va a ejecutar en la vida del proyecto.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { Battle, type BattleConfig } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { mvpArena, gunnerLoadout, scoutLoadout } from "../src/fixtures.js";
import { CircleBot, ForwardBot, HunterBot, IdleBot } from "../src/stubs.js";
import { Rng } from "../src/rng.js";

beforeAll(async () => {
  await initPhysics();
});

function makeConfig(seed: string): BattleConfig {
  return {
    battleId: "det_test",
    seed,
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 600, scoreToWin: 99 }),
    map: mvpArena(),
    participants: [
      { id: "veh_1", botId: "bot_a", team: "red", spec: gunnerLoadout() },
      { id: "veh_2", botId: "bot_b", team: "red", spec: scoutLoadout() },
      { id: "veh_3", botId: "bot_c", team: "blue", spec: gunnerLoadout() },
      { id: "veh_4", botId: "bot_d", team: "blue", spec: scoutLoadout() },
    ],
  };
}

/** Una batalla con bots que ejercitan movimiento, sensores, disparo y daño. */
function runBattle(seed: string) {
  const b = new Battle(makeConfig(seed));
  b.attachBot("veh_1", new HunterBot("bot_a"));
  b.attachBot("veh_2", new CircleBot("bot_b"));
  b.attachBot("veh_3", new HunterBot("bot_c"));
  b.attachBot("veh_4", new ForwardBot("bot_d"));
  const result = b.run(600);
  const hashes = [...b.stateHashes];
  b.free();
  return { result, hashes };
}

describe("determinismo del motor", () => {
  it("la misma semilla produce el mismo hash de estado final (100 ejecuciones)", () => {
    const reference = runBattle("seed-alpha");
    expect(reference.result.finalStateHash).toMatch(/^[0-9a-f]{64}$/);

    // 100 en cada PR. La CI nightly sube esto a 1000 (criterio de la DoD).
    const N = 100;
    for (let i = 0; i < N; i++) {
      const run = runBattle("seed-alpha");
      expect(run.result.finalStateHash, `divergencia en la ejecución ${i}`).toBe(
        reference.result.finalStateHash,
      );
      expect(run.result.ticks).toBe(reference.result.ticks);
      expect(run.result.score).toEqual(reference.result.score);
    }
  }, 120_000);

  it("los hashes intermedios coinciden tick a tick, no solo el final", () => {
    // Un final igual con caminos distintos sería un falso positivo peligroso.
    const a = runBattle("seed-beta");
    const b = runBattle("seed-beta");
    expect(a.hashes.length).toBeGreaterThan(5);
    expect(a.hashes).toEqual(b.hashes);
  });

  it("semillas distintas producen resultados distintos (la aleatoriedad SÍ actúa)", () => {
    // Si esto falla, el RNG no está afectando a nada y el test anterior no prueba nada.
    const hashes = new Set<string>();
    for (const seed of ["s1", "s2", "s3", "s4", "s5"]) {
      hashes.add(runBattle(seed).result.finalStateHash);
    }
    expect(hashes.size).toBeGreaterThan(1);
  }, 30_000);

  it("un bot que tarda en 'pensar' no cambia el resultado", () => {
    // El motor no puede depender del reloj de pared: un bot lento produce EXACTAMENTE
    // la misma batalla que uno rápido, mientras responda dentro del deadline.
    const fast = runBattle("seed-timing");

    const b = new Battle(makeConfig("seed-timing"));
    const slow = (inner: any) => ({
      botId: inner.botId,
      decide(obs: any) {
        // Quema tiempo real. Si el motor leyera el reloj, esto lo desincronizaría.
        const until = Date.now() + 2;
        while (Date.now() < until) {
          /* espera activa deliberada */
        }
        return inner.decide(obs);
      },
    });
    b.attachBot("veh_1", slow(new HunterBot("bot_a")));
    b.attachBot("veh_2", slow(new CircleBot("bot_b")));
    b.attachBot("veh_3", new HunterBot("bot_c"));
    b.attachBot("veh_4", new ForwardBot("bot_d"));
    const result = b.run(600);
    b.free();

    expect(result.finalStateHash).toBe(fast.result.finalStateHash);
  }, 30_000);

  it("la frecuencia de snapshot NO altera la simulación", () => {
    // Criterio explícito de la DoD de T2.6: el snapshot es observación, no simulación.
    const mk = (snapshotEveryNTicks: number) => {
      const b = new Battle({ ...makeConfig("seed-snap"), snapshotEveryNTicks });
      b.attachBot("veh_1", new HunterBot("bot_a"));
      b.attachBot("veh_2", new CircleBot("bot_b"));
      b.attachBot("veh_3", new HunterBot("bot_c"));
      b.attachBot("veh_4", new ForwardBot("bot_d"));
      const r = b.run(600);
      const snaps = b.snapshots.length;
      b.free();
      return { r, snaps };
    };

    const at30hz = mk(1);
    const at5hz = mk(6);

    expect(at30hz.r.finalStateHash).toBe(at5hz.r.finalStateHash);
    expect(at30hz.snaps).toBeGreaterThan(at5hz.snaps); // pero sí cambia cuánto se observa
  }, 30_000);

  it("el resultado registra las versiones exactas de motor, física y reglas (cap. 8)", () => {
    const { result } = runBattle("seed-versions");
    expect(result.versions.engine).toBeTruthy();
    expect(result.versions.physics).toContain("rapier");
    expect(result.versions.rules).toBe("tdm_mvp@1");
    expect(result.versions.protocol).toBe("arena/1");
  });
});

describe("PRNG", () => {
  it("misma semilla, misma secuencia", () => {
    const a = new Rng("x");
    const b = new Rng("x");
    for (let i = 0; i < 1000; i++) expect(a.nextUint32()).toBe(b.nextUint32());
  });

  it("semillas distintas divergen de inmediato", () => {
    expect(new Rng("x").nextUint32()).not.toBe(new Rng("y").nextUint32());
  });

  it("los valores están bien distribuidos en [0,1)", () => {
    const r = new Rng("dist");
    let sum = 0;
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / N).toBeCloseTo(0.5, 2);
  });

  it("el estado es serializable y restaura la secuencia exacta", () => {
    // Lo necesita el replay: reanudar desde un keyframe debe continuar idéntico.
    const a = new Rng("state");
    for (let i = 0; i < 50; i++) a.next();
    const st = a.getState();
    const expected = [a.next(), a.next(), a.next()];

    const b = new Rng("otra-cosa");
    b.setState(st);
    expect([b.next(), b.next(), b.next()]).toEqual(expected);
  });

  it("fork produce secuencias independientes y deterministas", () => {
    const mk = () => {
      const r = new Rng("parent");
      const child = r.fork("maps");
      return { parent: r.next(), child: child.next() };
    };
    expect(mk()).toEqual(mk());
    const one = mk();
    expect(one.parent).not.toBe(one.child);
  });
});

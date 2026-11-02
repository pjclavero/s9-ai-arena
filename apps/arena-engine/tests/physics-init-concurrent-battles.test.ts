/**
 * EQ1 · Robustez · `initPhysics()` concurrente A NIVEL DE BATALLA.
 *
 * Complementa a `physics-init-concurrent.test.ts` (que cuenta inicializaciones de Rapier)
 * reproduciendo lo que hace el tournament-worker: varias `Battle.create` arrancan a la
 * vez EN FRÍO (Rapier sin inicializar en este fichero: vitest aísla los módulos por
 * fichero, y aquí nadie llama a `initPhysics()` antes del primer test).
 *
 * Con el defecto, cada `Battle.create` ejecutaba su propio `RAPIER.init()`; la segunda
 * instancia del WASM sustituía al módulo bajo los mundos ya creados.
 *
 * Exige, con el fix:
 *   1. ninguna batalla cae ni queda a medias (todas terminan con resultado y hash);
 *   2. no hay contaminación cruzada: cada batalla, ejecutada INTERCALADA tick a tick con
 *      las demás, produce exactamente los mismos `stateHashes` y `finalStateHash` que la
 *      misma configuración ejecutada SOLA después;
 *   3. determinismo: dos batallas con la misma semilla arrancadas a la vez coinciden
 *      entre sí, y con la referencia secuencial.
 *
 * El tamaño de la tanda de estrés se puede subir con PHYSICS_CONCURRENCY_N (por defecto 12).
 */
import { describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle, type BattleConfig } from "../src/sim/battle.js";
import { ctfArena, emptyArena, gunnerLoadout, mvpArena, sandbagLoadout, scoutLoadout } from "../src/fixtures.js";
import { CircleBot, FlagRunnerBot, ForwardBot, HunterBot, IdleBot } from "../src/stubs.js";

type Scenario = { config: BattleConfig; attach: (b: Battle) => void };

/** Tres familias distintas (TDM 2v2, DM 1v1, CTF 1v1) para que una fuga entre mundos se note. */
function scenario(i: number): Scenario {
  const kind = i % 3;
  // Semillas repetidas a propósito (i y i+3 comparten familia; i y i+6 comparten semilla).
  const seed = `eq1-conc-${kind}-${Math.floor(i / 3) % 2}`;
  if (kind === 0) {
    return {
      config: {
        battleId: `conc_tdm_${i}`,
        seed,
        ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 300, scoreToWin: 99 }),
        map: mvpArena(),
        participants: [
          { id: "veh_1", botId: "bot_a", team: "red", spec: gunnerLoadout() },
          { id: "veh_2", botId: "bot_b", team: "red", spec: scoutLoadout() },
          { id: "veh_3", botId: "bot_c", team: "blue", spec: gunnerLoadout() },
          { id: "veh_4", botId: "bot_d", team: "blue", spec: scoutLoadout() },
        ],
      },
      attach: (b) => {
        b.attachBot("veh_1", new HunterBot("bot_a"));
        b.attachBot("veh_2", new CircleBot("bot_b"));
        b.attachBot("veh_3", new HunterBot("bot_c"));
        b.attachBot("veh_4", new ForwardBot("bot_d"));
      },
    };
  }
  if (kind === 1) {
    return {
      config: {
        battleId: `conc_dm_${i}`,
        seed,
        ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 300, scoreToWin: 999 }),
        map: emptyArena(80, 60),
        participants: [
          { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
          { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
        ],
      },
      attach: (b) => {
        b.attachBot("veh_1", new HunterBot("b1"));
        b.attachBot("veh_2", new CircleBot("b2"));
      },
    };
  }
  const map = ctfArena();
  return {
    config: {
      battleId: `conc_ctf_${i}`,
      seed,
      ruleset: loadRuleset("ctf_mvp@1", { scoreToWin: 1, timeLimitTicks: 600 }),
      map,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    },
    attach: (b) => {
      b.attachBot(
        "veh_1",
        new FlagRunnerBot(
          "b1",
          map.flags.find((f) => f.team === "blue")!.position,
          map.bases.find((x) => x.team === "red")!.position,
        ),
      );
      b.attachBot("veh_2", new IdleBot("b2"));
    },
  };
}

type Outcome = { finalStateHash: string; ticks: number; winner: string; stateHashes: string[] };

function outcome(b: Battle): Outcome {
  const r = b.getResult();
  if (!r) throw new Error("la batalla no terminó");
  return {
    finalStateHash: r.finalStateHash,
    ticks: r.ticks,
    winner: String(r.winner),
    stateHashes: b.stateHashes.map((h) => `${h.tick}:${h.hash}`),
  };
}

/** Ejecuta una batalla SOLA, de principio a fin: la referencia. */
async function runAlone(s: Scenario): Promise<Outcome> {
  const b = await Battle.create(s.config);
  try {
    s.attach(b);
    b.run(s.config.ruleset.timeLimitTicks + 10);
    return outcome(b);
  } finally {
    b.free();
  }
}

/**
 * Arranca TODAS las batallas a la vez (Promise.all sobre Battle.create, como el worker) y
 * las avanza intercaladas tick a tick, cediendo el bucle de eventos entre rondas para que
 * cualquier inicialización tardía tenga ocasión de colarse entre pasos.
 */
async function runInterleaved(scenarios: Scenario[]): Promise<Outcome[]> {
  const battles = await Promise.all(scenarios.map((s) => Battle.create(s.config)));
  try {
    battles.forEach((b, i) => scenarios[i]!.attach(b));
    const caps = scenarios.map((s) => s.config.ruleset.timeLimitTicks + 10);
    let guard = 0;
    while (battles.some((b) => !b.isFinished())) {
      battles.forEach((b, i) => {
        if (!b.isFinished() && b.tick < caps[i]!) b.step();
      });
      if (++guard % 25 === 0) await new Promise((r) => setImmediate(r));
      if (guard > 10_000) throw new Error("bucle intercalado sin terminar");
      // Una batalla que llega al tope sin terminar se cierra como lo haría run().
      battles.forEach((b, i) => {
        if (!b.isFinished() && b.tick >= caps[i]!) b.run(caps[i]!);
      });
    }
    return battles.map(outcome);
  } finally {
    for (const b of battles) b.free();
  }
}

describe("initPhysics concurrente · batallas arrancadas a la vez", () => {
  it("en frío, N Battle.create simultáneas terminan todas y coinciden con su ejecución en solitario", async () => {
    const N = Number(process.env.PHYSICS_CONCURRENCY_N ?? 12);
    const scenarios = Array.from({ length: N }, (_, i) => scenario(i));

    // Primero la tanda concurrente: es la que encuentra Rapier SIN inicializar.
    const concurrent = await runInterleaved(scenarios);
    // Después, la referencia: cada configuración, sola.
    const alone: Outcome[] = [];
    for (const s of scenarios) alone.push(await runAlone(s));

    for (let i = 0; i < N; i++) {
      const c = concurrent[i]!;
      expect(c.finalStateHash, `batalla ${i}`).toMatch(/^[0-9a-f]{64}$/);
      expect(c.stateHashes.length, `batalla ${i} sin hashes intermedios`).toBeGreaterThan(0);
      // Sin contaminación cruzada: idéntica a sí misma ejecutada sola.
      expect(c, `contaminación cruzada en la batalla ${i} (${scenarios[i]!.config.battleId})`).toEqual(alone[i]);
    }
    // Determinismo entre gemelas concurrentes: misma familia y misma semilla ⇒ mismo hash.
    for (let i = 0; i + 6 < N; i++) {
      expect(concurrent[i + 6]!.finalStateHash, `gemelas ${i} y ${i + 6}`).toBe(concurrent[i]!.finalStateHash);
    }
    // Y las familias distintas NO se confunden (si todas coincidieran, el test no probaría nada).
    expect(new Set(concurrent.map((c) => c.finalStateHash)).size).toBeGreaterThanOrEqual(Math.min(N, 6));
  }, 120_000);

  it("estrés: varias tandas concurrentes seguidas siguen siendo deterministas", async () => {
    const scenarios = Array.from({ length: 6 }, (_, i) => scenario(i));
    const reference = await runInterleaved(scenarios);
    for (let round = 0; round < 3; round++) {
      const again = await runInterleaved(scenarios);
      expect(again, `divergencia en la tanda ${round}`).toEqual(reference);
    }
  }, 120_000);
});

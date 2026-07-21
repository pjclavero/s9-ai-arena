/**
 * N2 · Latencia simulada (DETERMINISTA, off por defecto).
 *
 * La garantía crítica: con `simulatedLatency` ausente, la ejecución es byte-idéntica
 * a la de antes de N2 (test 1, comparado contra un hash capturado ANTES del cambio,
 * con el `battle.ts` de HEAD sin tocar). El resto de tests prueban que, cuando SÍ está
 * activada, es determinista, reproducible vía replay, y hace algo observable (no es
 * una feature vacua).
 */
import { describe, expect, it, beforeAll } from "vitest";
import { Battle, type BattleConfig, type BotAgent } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { DECISION_EVERY_N_TICKS, loadRuleset } from "../../../packages/game-rules/index.js";
import { mvpArena, gunnerLoadout, scoutLoadout } from "../src/fixtures.js";
import { CircleBot, ForwardBot, HunterBot } from "../src/stubs.js";
import { record, verify } from "../src/replay.js";

beforeAll(async () => {
  await initPhysics();
});

function makeConfig(seed: string, extra: Partial<BattleConfig> = {}): BattleConfig {
  return {
    battleId: "n2_safety",
    seed,
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 600, scoreToWin: 99 }),
    map: mvpArena(),
    participants: [
      { id: "veh_1", botId: "bot_a", team: "red", spec: gunnerLoadout() },
      { id: "veh_2", botId: "bot_b", team: "red", spec: scoutLoadout() },
      { id: "veh_3", botId: "bot_c", team: "blue", spec: gunnerLoadout() },
      { id: "veh_4", botId: "bot_d", team: "blue", spec: scoutLoadout() },
    ],
    ...extra,
  };
}

function runBattle(seed: string, extra: Partial<BattleConfig> = {}) {
  const b = new Battle(makeConfig(seed, extra));
  b.attachBot("veh_1", new HunterBot("bot_a"));
  b.attachBot("veh_2", new CircleBot("bot_b"));
  b.attachBot("veh_3", new HunterBot("bot_c"));
  b.attachBot("veh_4", new ForwardBot("bot_d"));
  const result = b.run(600);
  const hashes = [...b.stateHashes];
  b.free();
  return { result, hashes };
}

/**
 * GOLDEN capturado ANTES de N2: mismo config/seed, ejecutado con el `battle.ts` de
 * HEAD (git show HEAD:apps/arena-engine/src/sim/battle.ts), sin ningún cambio de N2
 * aplicado. Si este test falla, algo en el camino "latencia ausente" ha cambiado
 * comportamiento o ha tocado el RNG: regresión real, no un falso positivo.
 */
const PRE_N2_FINAL_HASH = "698a73c6215f2c1a553adbe065311660f43276fe6f4ce58a85632a00aac1c78f";
const PRE_N2_HASH_COUNT = 20;
const PRE_N2_FIRST_HASHES = [
  "2f1afefcdf3a485d93a5fd98fbb0f2209e1e17521ddf2c16a78349cc9b64a988",
  "cab1982f85df55519bd9fbade3d72cde37e1e662a418f34dfa1068277b0f8534",
  "42226433a2ddfb44ccff7d02b828e9e8aac9978f1c0f1e95f35382aad992043f",
];

describe("N2 · latencia simulada — garantía de cero regresión (latencia OFF)", () => {
  it("simulatedLatency ausente produce EXACTAMENTE el hash pre-N2 (final + intermedios)", () => {
    const { result, hashes } = runBattle("n2-safety-seed");
    expect(result.finalStateHash).toBe(PRE_N2_FINAL_HASH);
    expect(hashes.length).toBe(PRE_N2_HASH_COUNT);
    expect(hashes.slice(0, 3).map((h) => h.hash)).toEqual(PRE_N2_FIRST_HASHES);
  });

  it("simulatedLatency: undefined explícito da el mismo resultado que ausente", () => {
    const a = runBattle("n2-safety-seed");
    const b = runBattle("n2-safety-seed", { simulatedLatency: undefined });
    expect(b.result.finalStateHash).toBe(a.result.finalStateHash);
    expect(b.hashes).toEqual(a.hashes);
  });
});

describe("N2 · latencia simulada — determinismo con la feature activada", () => {
  it("misma seed + misma config de latencia ⇒ mismo hash (dos ejecuciones)", () => {
    const cfg = { simulatedLatency: { minCycles: 1, maxCycles: 4 } };
    const a = runBattle("n2-on-seed", cfg);
    const b = runBattle("n2-on-seed", cfg);
    expect(a.result.finalStateHash).toBe(b.result.finalStateHash);
    expect(a.hashes).toEqual(b.hashes);
  });

  it("un replay grabado con latencia activada se re-simula igual (verify() → matches: true)", async () => {
    const replay = await record(
      makeConfig("n2-replay-seed", { simulatedLatency: { minCycles: 1, maxCycles: 3 } }),
      (b) => {
        b.attachBot("veh_1", new HunterBot("bot_a"));
        b.attachBot("veh_2", new CircleBot("bot_b"));
        b.attachBot("veh_3", new HunterBot("bot_c"));
        b.attachBot("veh_4", new ForwardBot("bot_d"));
      },
    );
    expect(replay.commands.length).toBeGreaterThan(0);
    const v = await verify(replay);
    expect(v.divergedAtTick).toBeNull();
    expect(v.matches).toBe(true);
    expect(v.recomputedHash).toBe(v.officialHash);
  });
});

/**
 * Bot de control: obedece exactamente la orden de movimiento programada por tick de
 * decisión. Se usa para observar CUÁNDO surte efecto un comando bajo latencia.
 */
class ScriptedMoveBot implements BotAgent {
  constructor(
    readonly botId: string,
    private readonly moveAtDecisionIndex: number,
    private readonly move: { throttle: number; steer: number },
  ) {}
  private decisionIndex = -1;
  decide(obs: any) {
    this.decisionIndex++;
    const steer = this.decisionIndex >= this.moveAtDecisionIndex ? this.move.steer : 0;
    return { forTick: obs.tick, move: { throttle: this.move.throttle, steer } };
  }
}

describe("N2 · latencia simulada — comportamiento observable (no es vacua)", () => {
  it("con latencia fija (2 ciclos) el comando NO surte efecto hasta 2 ciclos de decisión después", async () => {
    const D = DECISION_EVERY_N_TICKS;
    // El bot cambia de steer 0→1 en su 3er ciclo de decisión (decisionIndex === 2).
    const switchDecisionIndex = 2;
    const switchTick = switchDecisionIndex * D;

    const cfg = makeConfig("n2-behavior-seed", { simulatedLatency: { minCycles: 2, maxCycles: 2 } });
    const b = await Battle.create(cfg);
    b.attachBot("veh_1", new ScriptedMoveBot("bot_a", switchDecisionIndex, { throttle: 1, steer: 1 }));
    for (const id of ["veh_2", "veh_3", "veh_4"]) {
      b.attachBot(id, new ScriptedMoveBot(`bot_${id}`, Number.POSITIVE_INFINITY, { throttle: 0, steer: 0 }));
    }

    // En el tick de decisión donde el bot manda el nuevo steer, el vehículo sigue en 0
    // (acción segura, exactamente como un timeout) porque el comando está en vuelo.
    while (b.tick < switchTick) b.step();
    b.step(); // ejecuta el tick de decisión `switchTick`: el bot entrega steer=1
    const v = b.getVehicle("veh_1")!;
    expect(v.lastMove.steer).toBe(0);

    // 2 ciclos de decisión (2*D ticks) después, el comando en vuelo se libera y aplica.
    const effectiveTick = switchTick + 2 * D;
    while (b.tick < effectiveTick) b.step();
    // Justo ANTES del tick efectivo (el ciclo de decisión inmediatamente anterior)
    // todavía no se ha aplicado.
    expect(v.lastMove.steer).toBe(0);
    b.step(); // tick de decisión donde se libera el comando en vuelo
    expect(v.lastMove.steer).toBe(1);
    b.free();
  });

  it("con latencia activada el finalStateHash DIFIERE del de latencia desactivada (misma seed)", () => {
    const off = runBattle("n2-differs-seed");
    const on = runBattle("n2-differs-seed", { simulatedLatency: { minCycles: 1, maxCycles: 5 } });
    expect(on.result.finalStateHash).not.toBe(off.result.finalStateHash);
  });

  it("el retardo se SORTEA en el rango con el RNG, no se fija a un extremo (rango ancho ≠ constante)", () => {
    // Un rango [1,5] real produce retardos VARIADOS sorteados con el RNG; un retardo
    // constante 5 no. Si el sorteo se sustituyera por `d = maxCycles` (o cualquier
    // constante), ambas configuraciones darían la MISMA ejecución y este test fallaría.
    // Así se prueba que el draw del RNG dentro del rango es necesario (no vacuo).
    const variable = runBattle("n2-range-seed", { simulatedLatency: { minCycles: 1, maxCycles: 5 } });
    const constanteMax = runBattle("n2-range-seed", { simulatedLatency: { minCycles: 5, maxCycles: 5 } });
    const constanteMin = runBattle("n2-range-seed", { simulatedLatency: { minCycles: 1, maxCycles: 1 } });
    expect(variable.result.finalStateHash).not.toBe(constanteMax.result.finalStateHash);
    expect(variable.result.finalStateHash).not.toBe(constanteMin.result.finalStateHash);
  });
});

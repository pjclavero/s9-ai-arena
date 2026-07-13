/**
 * Robustez del motor: un bot hostil, roto o lento NO puede tumbar la batalla.
 *
 * Cubre D2 (acción segura, timeouts, descalificación) y el presupuesto de tick del
 * capítulo 9.4. Es la parte del motor que E6 (seguridad) y E9 (torneos) dan por hecha:
 * si un bot puede colgar el motor, un torneo automático es imposible.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { DECISION_EVERY_N_TICKS, TICK_HZ, loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import {
  emptyArena, gunnerLoadout, minerLoadout, mvpArena, sandbagLoadout, scoutLoadout,
} from "../src/fixtures.js";
import { CircleBot, DeadBot, ForwardBot, HunterBot, IdleBot } from "../src/stubs.js";

beforeAll(async () => {
  await initPhysics();
});

describe("acción segura y timeouts (D2)", () => {
  it("un bot que NUNCA responde no cuelga la batalla: termina igual", () => {
    const b = new Battle({
      battleId: "dead",
      seed: "d",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 300, maxConsecutiveTimeouts: 20 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });
    b.attachBot("veh_1", new DeadBot("b1")); // no responde jamás
    b.attachBot("veh_2", new IdleBot("b2"));

    const result = b.run(1000);

    expect(result).toBeDefined();
    expect(result.ticks).toBeLessThanOrEqual(300);
    // Y el bot muerto acaba descalificado, no ignorado.
    expect(result.disqualified).toContain("veh_1");
    b.free();
  });

  it("la ACCIÓN SEGURA mantiene el movimiento y APAGA el disparo", () => {
    // Un bot que acelera y dispara, y de pronto deja de responder: debe seguir
    // rodando (inercia y última orden) pero NO seguir disparando indefinidamente.
    const b = new Battle({
      battleId: "safe",
      seed: "s",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 300, maxConsecutiveTimeouts: 999 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });

    let calls = 0;
    b.attachBot("veh_1", {
      botId: "b1",
      decide(obs: any) {
        calls++;
        // Responde 5 veces y luego enmudece para siempre.
        if (calls > 5) return null;
        return {
          forTick: obs.tick,
          move: { throttle: 1, steer: 0 },
          fire: ["turret_main"],
        };
      },
    });
    b.attachBot("veh_2", new IdleBot("b2"));

    for (let i = 0; i < 20; i++) b.step();
    const v = b.getVehicle("veh_1")!;
    const ammoAfterTalking = v.modules.get("ammo_main")!.ammo;
    const posBefore = b.getPhysics().pose("veh_1")!.position.x;

    for (let i = 0; i < 100; i++) b.step();
    const ammoAfterSilence = v.modules.get("ammo_main")!.ammo;
    const posAfter = b.getPhysics().pose("veh_1")!.position.x;

    // Sigue moviéndose: la última orden de movimiento se mantiene.
    expect(posAfter).toBeGreaterThan(posBefore);
    // Pero NO ha gastado ni una bala más: el disparo se apaga en la acción segura.
    expect(ammoAfterSilence).toBe(ammoAfterTalking);
    b.free();
  });

  it("descalifica tras maxConsecutiveTimeouts, ni antes ni después", () => {
    const MAX = 5;
    const b = new Battle({
      battleId: "dq",
      seed: "q",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 900, maxConsecutiveTimeouts: MAX }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });
    b.attachBot("veh_1", new DeadBot("b1"));
    b.attachBot("veh_2", new IdleBot("b2"));

    const v = b.getVehicle("veh_1")!;

    // Antes de agotar el margen, sigue en juego.
    for (let i = 0; i < (MAX - 1) * DECISION_EVERY_N_TICKS; i++) b.step();
    expect(v.disqualified).toBe(false);

    // Al alcanzarlo, fuera.
    for (let i = 0; i < 2 * DECISION_EVERY_N_TICKS; i++) b.step();
    expect(v.disqualified).toBe(true);
    b.free();
  });

  it("un bot que recupera el ritmo NO acumula timeouts antiguos", () => {
    // El contador es de timeouts CONSECUTIVOS: una respuesta válida lo reinicia.
    // Si no fuera así, un bot con un hipo puntual acabaría descalificado sin motivo.
    const b = new Battle({
      battleId: "recover",
      seed: "r",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 900, maxConsecutiveTimeouts: 5 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });

    let n = 0;
    b.attachBot("veh_1", {
      botId: "b1",
      // Falla 3 veces, responde 1, repite. Nunca llega a 5 seguidos.
      decide: (obs: any) => (++n % 4 === 0 ? { forTick: obs.tick } : null),
    });
    b.attachBot("veh_2", new IdleBot("b2"));

    b.run(900);
    expect(b.getVehicle("veh_1")!.disqualified).toBe(false);
    b.free();
  });
});

describe("un bot no puede corromper el motor", () => {
  it("comandos basura (tipos absurdos, NaN, infinitos) no rompen la simulación", () => {
    const garbage = [
      { forTick: 0, move: { throttle: NaN, steer: Infinity } },
      { forTick: 0, move: { throttle: 999, steer: -999 } },       // fuera de rango
      { forTick: 0, move: { throttle: "rápido", steer: null } },   // tipos absurdos
      { forTick: 0, fire: ["ranura_inexistente", "", "drive"] },   // ranuras inválidas
      { forTick: 0, turret: { targetPoint: { x: NaN, y: -Infinity } } },
      { forTick: 0, modules: [{ slot: "no_existe", enabled: true }] },
      { forTick: 0, deployMine: { slot: "tampoco_existe" } },
      { forTick: 0, radio: [{ slot: "drive", data: "no-es-base64!!!" }] },
      {},                                                          // vacío
      null,                                                        // silencio
    ];

    const b = new Battle({
      battleId: "garbage",
      seed: "g",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 600, maxConsecutiveTimeouts: 999 }),
      map: mvpArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: scoutLoadout() },
      ],
    });

    let i = 0;
    b.attachBot("veh_1", {
      botId: "b1",
      decide: (obs: any) => {
        const g: any = garbage[i++ % garbage.length];
        return g === null ? null : { ...g, forTick: obs.tick };
      },
    });
    b.attachBot("veh_2", new HunterBot("b2"));

    // Lo importante: NO LANZA. La batalla llega al final.
    const result = b.run(600);
    expect(result).toBeDefined();
    expect(result.finalStateHash).toMatch(/^[0-9a-f]{64}$/);

    // Y el estado sigue siendo sano: nada de NaN infiltrado en la física.
    const pose = b.getPhysics().pose("veh_1")!;
    expect(Number.isFinite(pose.position.x)).toBe(true);
    expect(Number.isFinite(pose.position.y)).toBe(true);
    expect(Number.isFinite(pose.heading)).toBe(true);
    b.free();
  }, 30_000);

  it("un bot basura NO desincroniza la simulación: sigue siendo determinista", () => {
    // Es lo que hace posible el sandbox de E6: el código hostil se contiene, no contagia.
    const run = () => {
      const b = new Battle({
        battleId: "garbage_det",
        seed: "gd",
        ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 300, maxConsecutiveTimeouts: 999 }),
        map: emptyArena(),
        participants: [
          { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
          { id: "veh_2", botId: "b2", team: "blue", spec: scoutLoadout() },
        ],
      });
      let i = 0;
      b.attachBot("veh_1", {
        botId: "b1",
        decide: (obs: any) =>
          (i++ % 3 === 0 ? null : { forTick: obs.tick, move: { throttle: NaN, steer: 1e9 } }),
      });
      b.attachBot("veh_2", new CircleBot("b2"));
      const r = b.run(300);
      b.free();
      return r.finalStateHash;
    };

    expect(run()).toBe(run());
  }, 30_000);

  it("un bot no puede disparar más rápido que su cadencia enviando 100 órdenes", () => {
    const b = new Battle({
      battleId: "spam",
      seed: "sp",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 300 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });

    // Spam: la misma arma repetida 100 veces en el array de fire.
    b.attachBot("veh_1", {
      botId: "b1",
      decide: (obs: any) => ({
        forTick: obs.tick,
        fire: Array(100).fill("turret_main"),
      }),
    });
    b.attachBot("veh_2", new IdleBot("b2"));

    const v = b.getVehicle("veh_1")!;
    const rounds0 = v.modules.get("ammo_main")!.ammo;
    const TICKS = 300;
    for (let i = 0; i < TICKS; i++) b.step();
    const spent = rounds0 - v.modules.get("ammo_main")!.ammo;

    // Cadencia del cañón: 30 ticks ⇒ como mucho 10 disparos en 300 ticks.
    const maxPossible = Math.ceil(TICKS / 30) + 1;
    expect(spent).toBeLessThanOrEqual(maxPossible);
    b.free();
  });
});

describe("presupuesto de tick (cap. 9.4)", () => {
  it("una batalla 4v4 completa cabe holgadamente en el presupuesto de 30 Hz", () => {
    // No mide "rápido" en abstracto: mide si el motor puede sostener TIEMPO REAL.
    // A 30 Hz hay 33,3 ms por tick. Si un tick medio se acerca a eso, no hay margen
    // para el protocolo, los bots ni el streaming, y el juego se cae en producción.
    const b = new Battle({
      battleId: "bench",
      seed: "bench",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 3000 }),
      map: mvpArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "red", spec: scoutLoadout() },
        { id: "veh_3", botId: "b3", team: "red", spec: minerLoadout() },
        { id: "veh_4", botId: "b4", team: "blue", spec: gunnerLoadout() },
        { id: "veh_5", botId: "b5", team: "blue", spec: scoutLoadout() },
        { id: "veh_6", botId: "b6", team: "blue", spec: minerLoadout() },
        { id: "veh_7", botId: "b7", team: "blue", spec: scoutLoadout() },
        { id: "veh_8", botId: "b8", team: "red", spec: scoutLoadout() },
      ],
    });
    for (const id of ["veh_1", "veh_3", "veh_4", "veh_6"]) b.attachBot(id, new HunterBot("b" + id));
    for (const id of ["veh_2", "veh_5", "veh_7", "veh_8"]) b.attachBot(id, new ForwardBot("b" + id));

    const TICKS = 1500;
    const t0 = performance.now();
    for (let i = 0; i < TICKS && !b.isFinished(); i++) b.step();
    const elapsed = performance.now() - t0;
    const done = b.tick;
    b.free();

    const msPerTick = elapsed / done;
    const budget = 1000 / TICK_HZ; // 33,3 ms
    const usage = (msPerTick / budget) * 100;

    console.log(
      `  8 vehículos · ${done} ticks en ${elapsed.toFixed(0)} ms → ` +
        `${msPerTick.toFixed(2)} ms/tick (${usage.toFixed(1)} % del presupuesto de ${budget.toFixed(1)} ms)`,
    );

    // Umbral: como mucho la mitad del presupuesto, para dejar sitio a todo lo demás.
    expect(msPerTick).toBeLessThan(budget * 0.5);
  }, 60_000);

  it("headless acelerado: una batalla de 3000 ticks corre en menos de 5 s (DoD T2.1)", () => {
    const b = new Battle({
      battleId: "fast",
      seed: "f",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 3000 }),
      map: mvpArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "red", spec: scoutLoadout() },
        { id: "veh_3", botId: "b3", team: "blue", spec: gunnerLoadout() },
        { id: "veh_4", botId: "b4", team: "blue", spec: scoutLoadout() },
      ],
    });
    b.attachBot("veh_1", new HunterBot("b1"));
    b.attachBot("veh_2", new CircleBot("b2"));
    b.attachBot("veh_3", new HunterBot("b3"));
    b.attachBot("veh_4", new ForwardBot("b4"));

    const t0 = performance.now();
    const r = b.run(3000);
    const elapsed = performance.now() - t0;
    b.free();

    const realTime = (r.ticks / TICK_HZ) * 1000;
    console.log(
      `  ${r.ticks} ticks (${(realTime / 1000).toFixed(1)} s de juego) simulados en ` +
        `${elapsed.toFixed(0)} ms → ${(realTime / elapsed).toFixed(0)}× tiempo real`,
    );
    expect(elapsed).toBeLessThan(5000);
  }, 30_000);
});

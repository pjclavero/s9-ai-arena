/**
 * R13.0 · REGRESSION LOCK — sensor acústico (no vacuo).
 *
 * El código del acústico está VIVO: `battle.ts` empuja sonidos reales (gunshot al disparar,
 * engine al moverse, explosion al impactar) a un búfer con doble-buffer determinista
 * (ERR-ENG-01), y `sensors.ts` los proyecta a `sensors.acoustic` como DIRECCIÓN (bearing),
 * nunca posición (cap. 11). El test previo era VACUO: `if (acoustic.sources.length > 0)` en una
 * arena sin sonidos ⇒ no afirmaba nada. Este candado provoca DISPAROS REALES y EXIGE detección
 * dentro de rango, silencio fuera de rango y ausencia de fugas de posición. Si se elimina la
 * escritura de sonido, el candado positivo falla.
 *
 * Los sonidos viven un solo ciclo de decisión, así que un oyente-grabador captura las fuentes
 * en CADA decisión durante toda la batalla (robusto frente al timing), en vez de mirar el final.
 *
 * Rápido, determinista, sin Docker/red/reloj.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Battle } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { MODULES, emptyArena, scoutLoadout, gunnerLoadout } from "../src/fixtures.js";
import type { BotAgent } from "../src/sim/battle.js";
import type { VehicleSpec } from "../src/sim/vehicle.js";

beforeAll(async () => {
  await initPhysics();
});

/** Dispara en cada decisión SALVO la del spawn (para no emitir sonido antes de fijar posiciones). */
class FireBot implements BotAgent {
  private d = 0;
  constructor(readonly botId: string) {}
  decide() {
    const first = this.d === 0;
    this.d++;
    return first ? { forTick: 0 } : { fire: ["turret_main"] };
  }
}

/** Oyente que registra TODAS las fuentes acústicas que observa a lo largo de la batalla. */
class ListenerBot implements BotAgent {
  samples: any[] = [];
  constructor(readonly botId: string) {}
  decide(obs: any) {
    const src = obs.sensors?.acoustic?.[0]?.sources ?? [];
    if (src.length) this.samples.push(...src);
    return { forTick: obs.tick };
  }
}

function listenerSpec(): VehicleSpec {
  const s = scoutLoadout();
  s.modules = [...s.modules, { ...MODULES.acoustic }];
  return s;
}

function pin(b: Battle) {
  const phys = b.getPhysics();
  phys.get("shooter")!.rb.setTranslation({ x: 30, y: 40 }, true);
  phys.get("near")!.rb.setTranslation({ x: 35, y: 40 }, true); // 5 m  (< rango 60)
  phys.get("far")!.rb.setTranslation({ x: 110, y: 40 }, true); // 80 m (> rango 60)
}

/** Corre el escenario y devuelve las muestras acústicas capturadas por cada oyente. */
function runScenario() {
  const near = new ListenerBot("b_n");
  const far = new ListenerBot("b_f");
  const b = new Battle({
    battleId: "acoustic",
    seed: "acoustic-seed",
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 3000, scoreToWin: 999 }),
    map: emptyArena(120, 80),
    participants: [
      { id: "shooter", botId: "b_s", team: "red", spec: gunnerLoadout() },
      { id: "near", botId: "b_n", team: "blue", spec: listenerSpec() },
      { id: "far", botId: "b_f", team: "blue", spec: listenerSpec() },
    ],
  });
  b.attachBot("shooter", new FireBot("b_s"));
  b.attachBot("near", near);
  b.attachBot("far", far);

  b.step(); // decisión de spawn: el tirador NO dispara aún
  // 72 ticks: el cañón (cooldown 30) dispara ya fijado en t=33 y t=63 → observado en t=36 y t=66.
  for (let i = 0; i < 72; i++) {
    pin(b);
    b.step();
  }
  b.free();
  return { near: near.samples, far: far.samples };
}

describe("R13.0 · sensor acústico (candado no vacuo)", () => {
  it("disparos REALES generan sonido que el oyente cercano DETECTA (no vacuo)", () => {
    const { near } = runScenario();
    expect(near.length).toBeGreaterThan(0); // falla si se elimina la escritura de world.sounds
    expect(near.some((s) => s.kind === "gunshot")).toBe(true);
  });

  it("cada fuente es DIRECCIÓN, nunca posición ni identidad (cap. 11)", () => {
    const { near } = runScenario();
    expect(near.length).toBeGreaterThan(0);
    for (const s of near) {
      expect(s).toHaveProperty("bearing");
      expect(typeof s.bearing).toBe("number");
      expect(s).not.toHaveProperty("position");
      expect(s).not.toHaveProperty("distanceM");
      expect(s).not.toHaveProperty("entityId");
    }
  });

  it("un oyente FUERA de rango no detecta los disparos", () => {
    const { far } = runScenario();
    expect(far).toHaveLength(0);
  });

  it("sin eventos sonoros no hay detecciones fantasma (silencio)", () => {
    const listener = new ListenerBot("b_b");
    const idle = new FireBot("b_a"); // FireBot que solo se usa como IdleBot: no lo attachamos a disparar
    const b = new Battle({
      battleId: "silence",
      seed: "silence-seed",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 3000, scoreToWin: 999 }),
      map: emptyArena(120, 80),
      participants: [
        { id: "a", botId: "b_a", team: "red", spec: gunnerLoadout() },
        { id: "b", botId: "b_b", team: "blue", spec: listenerSpec() },
      ],
    });
    // Ambos quietos y sin disparar: ListenerBot no dispara; al "a" le damos también un oyente pasivo.
    b.attachBot("a", new ListenerBot("b_a"));
    b.attachBot("b", listener);
    b.step();
    const phys = b.getPhysics();
    for (let i = 0; i < 24; i++) {
      phys.get("a")!.rb.setTranslation({ x: 40, y: 40 }, true);
      phys.get("b")!.rb.setTranslation({ x: 42, y: 40 }, true);
      b.step();
    }
    b.free();
    void idle;
    expect(listener.samples).toHaveLength(0);
  });

  it("la detección acústica es determinista (mismo escenario ⇒ mismas fuentes)", () => {
    const a = runScenario();
    const c = runScenario();
    expect(a.near).toEqual(c.near);
    expect(a.far).toEqual(c.far);
  });
});

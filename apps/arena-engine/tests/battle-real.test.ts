/**
 * UX-C · C7 · Una batalla demuestra EJECUCIÓN REAL de la estrategia de cada bot.
 *
 * BOT A avanza, apunta y dispara; BOT B se queda quieto. Sobre el mapa REAL del
 * catálogo (documento → toEngineMap, lo mismo que juega la API) se exige que el
 * replay y sus estadísticas (las de replay-service, calculadas DESDE EL ARCHIVO)
 * muestren movimiento, disparos, daño y un resultado coherente; y que al INVERTIR
 * las estrategias el resultado se invierta. Si el motor ignorara los comandos, o
 * los asignara al vehículo equivocado, las dos batallas darían lo mismo.
 *
 * La ruta con contenedores reales (código Python del usuario, build en sandbox,
 * worker) la cubre la spec de navegador golden-path (Artillero vs Pacifista); esta
 * prueba fija la mitad del motor sin Docker, en cada PR.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { BotAgent } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import type { ArenaMap } from "../src/sim/modes.js";
import { record, verify, type Replay } from "../src/replay.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { gunnerLoadout } from "../src/fixtures.js";
import { toEngineMap } from "../../map-service/src/to-engine-map.js";
import { computeBattleStats } from "../../replay-service/src/stats.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAP: ArenaMap = toEngineMap(JSON.parse(readFileSync(join(REPO, "maps", "mvp-arena-01.json"), "utf8")));

function norm(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Atacante: rodea el muro central por el pasillo norte (waypoints) hacia el spawn
 * enemigo (público: está en el mapa) y, en cuanto el radar ve un contacto, gira hacia
 * él, le apunta la torreta y dispara todo lo que tiene.
 */
class Attacker implements BotAgent {
  private wp = 0;
  constructor(
    readonly botId: string,
    private route: { x: number; y: number }[],
    private weapons: string[],
  ) {}
  decide(obs: any) {
    const me = obs.self;
    const contacts = (obs.sensors?.radar ?? []).flatMap((r: any) => r.contacts ?? []);
    const next = this.route[Math.min(this.wp, this.route.length - 1)];
    if (Math.hypot(next.x - me.position.x, next.y - me.position.y) < 4 && this.wp < this.route.length - 1) this.wp++;
    const target = contacts[0]?.position ?? this.route[Math.min(this.wp, this.route.length - 1)];
    const want = Math.atan2(target.y - me.position.y, target.x - me.position.x);
    const turn = norm(want - me.heading);
    const dist = Math.hypot(target.x - me.position.x, target.y - me.position.y);
    // Con un enemigo a la vista se planta a 12 m; si no, avanza (despacio en los giros).
    const throttle = contacts.length > 0 && dist < 12 ? 0 : Math.abs(turn) < 1 ? 0.8 : 0.3;
    return {
      forTick: obs.tick,
      move: { throttle, steer: Math.max(-1, Math.min(1, turn * 2)) },
      turret: { targetPoint: target },
      ...(contacts.length > 0 ? { fire: this.weapons } : {}),
    };
  }
}

/** Quieto: nunca se mueve ni dispara. */
class Still implements BotAgent {
  constructor(readonly botId: string) {}
  decide(obs: any) {
    return { forTick: obs.tick };
  }
}

const RED_SPAWN = MAP.spawns.find((s) => s.team === "red")!.position;
const BLUE_SPAWN = MAP.spawns.find((s) => s.team === "blue")!.position;
const WEAPONS = gunnerLoadout()
  .modules.filter((m) => m.category === "weapon")
  .map((m) => m.slot);

async function play(attacker: "red" | "blue"): Promise<Replay> {
  return record(
    {
      battleId: `c7-${attacker}`,
      seed: "c7-seed",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 5_400 }),
      map: MAP,
      participants: [
        { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
        { id: "v_blue", botId: "bot_blue", team: "blue", spec: gunnerLoadout() },
      ],
    },
    (b) => {
      // Pasillo norte: por encima del muro central (y ∈ [20, 60] en x = 60).
      const toBlue = [{ x: 30, y: 68 }, { x: 90, y: 68 }, BLUE_SPAWN];
      const toRed = [{ x: 90, y: 68 }, { x: 30, y: 68 }, RED_SPAWN];
      b.attachBot("v_red", attacker === "red" ? new Attacker("bot_red", toBlue, WEAPONS) : new Still("bot_red"));
      b.attachBot("v_blue", attacker === "blue" ? new Attacker("bot_blue", toRed, WEAPONS) : new Still("bot_blue"));
    },
  );
}

/** Distancia recorrida por un vehículo a lo largo de los snapshots del replay. */
function travelled(replay: Replay, vehicleId: string): number {
  let d = 0;
  let prev: { x: number; y: number } | null = null;
  for (const s of replay.snapshots) {
    const v = s.vehicles.find((x: any) => x.id === vehicleId);
    if (!v) continue;
    if (prev) d += Math.hypot(v.position.x - prev.x, v.position.y - prev.y);
    prev = v.position;
  }
  return d;
}

beforeAll(async () => {
  await initPhysics();
});

describe("C7 · batalla real: la estrategia de cada bot decide el resultado", () => {
  it("A (rojo) avanza+apunta+dispara vs B (azul) quieto → movimiento, disparos, daño y gana A; invertido, gana B", async () => {
    expect(WEAPONS.length).toBeGreaterThan(0);
    const results: Record<string, { winner: string; stats: Awaited<ReturnType<typeof computeBattleStats>> }> = {};

    for (const attacker of ["red", "blue"] as const) {
      const replay = await play(attacker);
      const idle = attacker === "red" ? "blue" : "red";
      const att = `v_${attacker}`;
      const still = `v_${idle}`;

      // El replay es auténtico: re-simularlo da el mismo hash.
      const ver = await verify(replay);
      expect(ver.matches, `replay ${attacker} verificable`).toBe(true);

      const stats = await computeBattleStats(replay);
      // Movimiento: el atacante recorre el mapa; el quieto no se mueve (salvo empujones).
      expect(travelled(replay, att)).toBeGreaterThan(20);
      expect(travelled(replay, still)).toBeLessThan(2);
      // Disparos y daño: sólo los del atacante.
      expect(stats.perBot[att].shotsFired).toBeGreaterThan(0);
      expect(stats.perBot[att].shotsHit).toBeGreaterThan(0);
      expect(stats.perBot[att].damageDealt).toBeGreaterThan(0);
      expect(stats.perBot[still].shotsFired).toBe(0);
      expect(stats.perBot[still].damageTaken).toBeGreaterThan(0);
      expect(stats.perBot[att].damageTaken).toBe(0);
      // Resultado: gana el atacante, y el replay/las stats lo dicen igual.
      expect(replay.result.winner).toBe(attacker);
      expect(stats.winner).toBe(attacker);
      expect(stats.perBot[still].died).toBe(true);
      results[attacker] = { winner: replay.result.winner, stats };
    }

    // Invertir estrategias invierte el resultado (no es un ganador fijo por lado o por id).
    expect(results.red.winner).not.toBe(results.blue.winner);
  }, 120_000);
});

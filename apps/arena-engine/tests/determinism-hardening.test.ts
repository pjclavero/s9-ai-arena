/**
 * R2.7 · Endurecimiento del determinismo (ERR-ENG-02/04/05/06/07).
 *
 * Cada bloque prueba una pieza de la DoD:
 *   - el lint invertido caza un Math.random() en rng.ts (antes pasaba en verde);
 *   - el hash de estado ve divergencias del SOLVER que antes eran invisibles;
 *   - hashEveryNTicks es parámetro del ruleset (auditoría con hash por tick);
 *   - deathmatch rechaza EN CONSTRUCCIÓN dos vehículos del mismo equipo;
 *   - el rate-limit de radio ya no acumula memoria durante la batalla.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle, type BotAgent } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import type { VehicleSpec } from "../src/sim/vehicle.js";
import { MODULES, emptyArena, gunnerLoadout, scoutLoadout } from "../src/fixtures.js";
import { IdleBot } from "../src/stubs.js";

const LINT = join(import.meta.dirname, "../scripts/lint-determinism.mjs");

beforeAll(async () => {
  await initPhysics();
});

/** Ejecuta el lint sobre un directorio y devuelve su código de salida. */
function runLint(dir?: string): { status: number; output: string } {
  const args = [LINT, ...(dir ? ["--dir", dir] : [])];
  try {
    const out = execFileSync(process.execPath, args, { encoding: "utf8" });
    return { status: 0, output: out };
  } catch (e: any) {
    return { status: e.status ?? -1, output: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

describe("lint de determinismo invertido (ERR-ENG-02)", () => {
  it("un Math.random() introducido en rng.ts hace FALLAR el lint", () => {
    // Exactamente el agujero de la auditoría: rng.ts estaba fuera de src/sim y un
    // Math.random() en el propio RNG pasaba la CI en verde.
    const dir = mkdtempSync(join(tmpdir(), "lint-det-"));
    try {
      writeFileSync(
        join(dir, "rng.ts"),
        `export function next(): number { return Math.random(); }\n`,
      );
      const r = runLint(dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain("Math.random()");
      expect(r.output).toContain("rng.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("un fichero NUEVO queda vigilado por defecto (carga invertida)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-det-"));
    try {
      writeFileSync(join(dir, "nuevo-subsistema.ts"), `export const t = Date.now();\n`);
      expect(runLint(dir).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("la lista de exclusión exime a protocol-server.ts y cli.ts (reloj real legítimo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-det-"));
    try {
      writeFileSync(join(dir, "protocol-server.ts"), `export const t = Date.now();\n`);
      writeFileSync(join(dir, "cli.ts"), `export const u = new Date();\n`);
      expect(runLint(dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("el src/ real del motor pasa el lint completo (rng.ts y replay.ts incluidos)", () => {
    const r = runLint();
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain("lint de determinismo OK");
  });
});

describe("huella del solver en el hash de estado (ERR-ENG-04)", () => {
  const mkBattle = () =>
    new Battle({
      battleId: "solver_hash",
      seed: "solver-hash",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 600 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: scoutLoadout() },
      ],
    });

  it("una divergencia del solver INVISIBLE en las poses cambia el hash", () => {
    // Escenario construido: dormimos un cuerpo a mano. La pose cuantizada no cambia
    // ni un bit — con el canónico anterior las dos situaciones tenían el MISMO hash —
    // pero el estado interno del solver ya no es el mismo, y eso es exactamente la
    // clase de divergencia sub-1e-5 que era invisible (ERR-ENG-04).
    const b = mkBattle();
    for (let i = 0; i < 10; i++) b.step();

    const poseBefore = b.getPhysics().pose("veh_1")!;
    const hashBefore = b.stateHash();

    b.getPhysics().get("veh_1")!.rb.sleep();

    const poseAfter = b.getPhysics().pose("veh_1")!;
    expect(poseAfter.position).toEqual(poseBefore.position);
    expect(poseAfter.heading).toBe(poseBefore.heading);

    expect(b.stateHash()).not.toBe(hashBefore);
    b.free();
  });

  it("la huella cuenta cuerpos despiertos y pares de contacto", () => {
    const b = mkBattle();
    b.step();
    const fp = b.getPhysics().solverFingerprint();
    // Dos vehículos dinámicos recién movidos: ambos despiertos.
    expect(fp.awakeBodies).toBe(2);
    expect(fp.contactPairs).toBeGreaterThanOrEqual(0);
    b.free();
  });

  it("hashEveryNTicks del RULESET manda: hash por tick para auditorías", () => {
    const b = new Battle({
      battleId: "hash_cadence",
      seed: "hash-cadence",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 60, hashEveryNTicks: 1 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: scoutLoadout() },
      ],
    });
    b.attachBot("veh_1", new IdleBot("b1"));
    b.attachBot("veh_2", new IdleBot("b2"));
    b.run(60);
    // Un hash POR TICK, no cada 30: divergedAtTick puede señalar el tick exacto.
    expect(b.stateHashes.length).toBeGreaterThanOrEqual(60);
    expect(b.stateHashes[1].tick - b.stateHashes[0].tick).toBe(1);
    b.free();
  });
});

describe("deathmatch valida su premisa en construcción (ERR-ENG-07)", () => {
  const cfg = (teams: [string, string]) => ({
    battleId: "dm_teams",
    seed: "dm-teams",
    ruleset: loadRuleset("dm_practice@1"),
    map: emptyArena(),
    participants: [
      { id: "veh_1", botId: "b1", team: teams[0], spec: gunnerLoadout() },
      { id: "veh_2", botId: "b2", team: teams[1], spec: scoutLoadout() },
    ],
  });

  it("dm_practice con dos vehículos del MISMO equipo se rechaza al construir", () => {
    // Antes: la batalla arrancaba, onKill filtraba killerTeam !== victim.team y nadie
    // podía puntuar jamás — 5 minutos condenados a tablas sin ningún error visible.
    expect(() => new Battle(cfg(["red", "red"]))).toThrow(/deathmatch.*equipo/);
  });

  it("con equipos distintos construye con normalidad", () => {
    const b = new Battle(cfg(["red", "blue"]));
    expect(b.getVehicles().length).toBe(2);
    b.free();
  });

  it("team_deathmatch SÍ admite equipos compartidos (la validación es del modo DM)", () => {
    const b = new Battle({ ...cfg(["red", "red"]), ruleset: loadRuleset("tdm_mvp@1") });
    expect(b.getVehicles().length).toBe(2);
    b.free();
  });
});

describe("radio sin fugas de memoria (ERR-ENG-06)", () => {
  /** Bot que satura la radio: envía un mensaje en CADA decisión (10/s, límite 2/s). */
  class RadioSpamBot implements BotAgent {
    delivered = 0;
    lastDeliveredTick = -1;
    constructor(readonly botId: string) {}
    decide(obs: any) {
      if (obs.radio?.length) {
        this.delivered += obs.radio.length;
        this.lastDeliveredTick = obs.tick;
      }
      return {
        move: { throttle: 0, steer: 0 },
        fire: [],
        radio: [{ slot: "radio_a", data: Buffer.from("ping").toString("base64") }],
      };
    }
  }

  const radioSpec = (): VehicleSpec => ({
    chassisId: "chassis.light@1",
    hullHp: 200,
    radiusM: 1.2,
    massKg: 900,
    modules: [MODULES.wheels, MODULES.battery, MODULES.radio],
  });

  it("una batalla de 5 minutos con spam de radio no acumula NINGUNA estructura", () => {
    const b = new Battle({
      battleId: "radio_leak",
      seed: "radio-leak",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 9000, scoreToWin: 999 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: radioSpec() },
        { id: "veh_2", botId: "b2", team: "red", spec: radioSpec() },
        { id: "veh_3", botId: "b3", team: "blue", spec: radioSpec() },
      ],
    });
    const bots = [new RadioSpamBot("b1"), new RadioSpamBot("b2"), new RadioSpamBot("b3")];
    b.attachBot("veh_1", bots[0]);
    b.attachBot("veh_2", bots[1]);
    b.attachBot("veh_3", bots[2]);

    // El Map `id:segundo` que crecía sin purga (ERR-ENG-06) YA NO EXISTE: con él, esta
    // batalla habría retenido ~900 entradas (3 vehículos × 300 segundos).
    expect((b as any).radioSentThisSecond).toBeUndefined();

    let maxQueue = 0;
    for (let t = 0; t < 9000 && !b.isFinished(); t++) {
      b.step();
      if (t % 30 === 0) {
        maxQueue = Math.max(maxQueue, (b as any).radioQueue.length);
      }
    }

    // La cola de radio se mantiene acotada por el retardo de entrega, no crece.
    // 3 vehículos × 2 msg/s con entrega en <1 s: unas pocas unidades, jamás cientos.
    expect(maxQueue).toBeLessThanOrEqual(12);

    // El contador por vehículo es un ESCALAR que se reinicia cada segundo: tras 5
    // minutos vale como mucho el límite por segundo, no la suma histórica.
    for (const v of b.getVehicles()) {
      expect(v.radioSentThisSecond).toBeLessThanOrEqual(2);
    }

    // Y el rate-limit sigue FUNCIONANDO en el último segundo de batalla: los mensajes
    // fluyen de principio a fin (el contador se reinicia, no se atasca).
    for (const bot of bots) {
      expect(bot.delivered).toBeGreaterThan(100);
      expect(bot.lastDeliveredTick).toBeGreaterThan(8900);
    }
    b.free();
  }, 120_000);
});

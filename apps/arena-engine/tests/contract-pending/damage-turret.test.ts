/**
 * OLA 2 · ME · CONTRATO PENDIENTE · Equipo MB (daño, HE, blindaje, torreta en montura,
 * hullLevel). Decisiones fijadas: D-B2 montura, D-B3 sin variación, D-B4 blindaje
 * cuantizado en lo público, D-B5 hullLevel N = 20, D-B6 HE sin doble daño.
 *
 * En ROJO sobre el BASE_SHA f07ff6f (`contractIt("MB", …)` = it.fails). D-B3 ya se cumple
 * en la base y por eso vive en baseline/damage-turret.test.ts (no aquí).
 * Interfaces: `PublicDamageState` (packages/projection/contracts.ts) para la forma
 * pública; `TurretMountDef` (packages/module-catalog/contracts/engine-v2.ts) para la
 * montura. Si MA retira el snapshot del motor como salida pública, MB/MA adaptan SÓLO
 * `publicVehicles()`.
 */
import { beforeAll, describe, expect } from "vitest";
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import { Battle } from "../../src/sim/battle.js";
import { initPhysics } from "../../src/sim/physics.js";
import { emptyArena, sandbagLoadout } from "../../src/fixtures.js";
import { IdleBot } from "../../src/stubs.js";
import { ScriptBot, catalog, contractIt, gunnerHe, loadout } from "../baseline/helpers.js";

beforeAll(async () => {
  await initPhysics();
});

const N = 20;

function duel(shooterSpec = gunnerHe(), dist = 15, ticks = 30) {
  const map = emptyArena(200, 80);
  map.spawns = [
    { team: "red", position: { x: 20, y: 40 }, heading: 0 },
    { team: "blue", position: { x: 20 + dist, y: 40 }, heading: Math.PI },
  ];
  const b = new Battle({
    battleId: "me_mb",
    seed: "me-mb",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 200 }),
    map,
    snapshotEveryNTicks: 1,
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: shooterSpec },
      { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
    ],
  });
  const taken: any[] = [];
  const target = new IdleBot("b2") as any;
  target.onEvent = (e: any) => taken.push(e);
  b.attachBot("veh_1", new ScriptBot("b1", (t) => (t === 0 ? { fire: ["turret_main"] } : undefined)));
  b.attachBot("veh_2", target);
  for (let t = 0; t < ticks; t++) b.step();
  const hp = b.getVehicle("veh_2")!.hullHp;
  const frames = b.snapshots;
  b.free();
  return { taken: taken.filter((e) => e.kind === "hit_taken"), hp, frames };
}

/** Vehículos del frame público (hoy: snapshot del motor que reenvía el gateway). */
const publicVehicles = (frame: any): any[] => frame.vehicles ?? [];

describe("MB · D-B6 HE sin doble daño accidental", () => {
  contractIt("MB", "un impacto directo HE produce UN único paquete de daño sobre el blanco", () => {
    const { taken } = duel();
    expect(taken).toHaveLength(1);
  });
});

describe("MB · D-B5 hullLevel N = 20 y D-B4 blindaje cuantizado en lo público", () => {
  contractIt("MB", "cada vehículo público lleva hullLevel entero en [0, 20] y NO hullHp ni hullHpMax", () => {
    const { frames } = duel();
    for (const f of frames) {
      for (const v of publicVehicles(f)) {
        expect(Number.isInteger(v.hullLevel)).toBe(true);
        expect(v.hullLevel).toBeGreaterThanOrEqual(0);
        expect(v.hullLevel).toBeLessThanOrEqual(N);
        expect(v).not.toHaveProperty("hullHp");
        expect(v).not.toHaveProperty("hullHpMax");
      }
    }
  });

  contractIt("MB", "hullLevel = ceil(N · hullHp / hullHpMax) del estado interno", () => {
    const { frames, hp } = duel();
    const last = publicVehicles(frames[frames.length - 1]).find(
      (v: any) => v.alive !== undefined && v.hullLevel !== undefined && v.hullLevel < N,
    );
    expect(last).toBeDefined();
    expect(last.hullLevel).toBe(Math.ceil((N * hp) / sandbagLoadout().hullHp));
  });

  contractIt(
    "MB",
    "estado público de daño ⊆ {alive, hullLevel, capabilities, armorBroken}; armorBroken sólo booleano",
    () => {
      const { frames } = duel();
      const allowed = new Set(["alive", "hullLevel", "capabilities", "armorBroken"]);
      const damageish = /hp|armor|damage|reduction|absorb/i;
      for (const f of frames) {
        for (const v of publicVehicles(f)) {
          const offending = Object.keys(v).filter((k) => damageish.test(k) && !allowed.has(k));
          expect(offending).toEqual([]);
          for (const val of Object.values(v.armorBroken ?? {})) expect(typeof val).toBe("boolean");
        }
      }
    },
  );
});

describe("MB · D-B2 propiedades de torreta en la MONTURA del chasis", () => {
  contractIt("MB", "ningún arma del catálogo declara turretRateRads ni turretArcRad (pasan a REMOVE)", () => {
    const offending = catalog()
      .filter((d) => d.category === "weapon")
      .filter((d: any) => d.turretRateRads !== undefined || d.turretArcRad !== undefined)
      .map((d) => `${d.id}@${d.version}`);
    expect(offending).toEqual([]);
  });

  contractIt(
    "MB",
    "toda ranura de chasis que admite armas declara una montura con turretRateRads y turretArcRad",
    () => {
      const missing: string[] = [];
      for (const ch of catalog().filter((d) => d.category === "chassis")) {
        for (const slot of (ch as any).slots ?? []) {
          if (!slot.accepts?.includes("weapon")) continue;
          const mount = Object.values(slot).find(
            (v: any) =>
              v && typeof v === "object" && typeof v.turretRateRads === "number" && typeof v.turretArcRad === "number",
          );
          if (!mount) missing.push(`${ch.id}@${ch.version}:${slot.id}`);
        }
      }
      expect(missing).toEqual([]);
    },
  );

  contractIt(
    "MB",
    "la cinemática pública de torreta depende sólo de la montura: cañón y ametralladora en el mismo chasis giran igual",
    () => {
      const track = (weapon: string, ammo: string) => {
        const spec = loadout("chassis.medium@1", [
          { slot: "drive", moduleId: "movement.tracks@1" },
          { slot: "power", moduleId: "power.generator@1" },
          { slot: "turret_main", moduleId: weapon, ammo },
        ]);
        const b = new Battle({
          battleId: "me_mount",
          seed: "me-mount",
          ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 200 }),
          map: emptyArena(200, 80),
          snapshotEveryNTicks: 1,
          participants: [
            { id: "veh_1", botId: "b1", team: "red", spec },
            { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
          ],
        });
        b.attachBot("veh_1", new ScriptBot("b1", () => ({ turret: { targetHeading: Math.PI / 2 } })));
        b.attachBot("veh_2", new IdleBot("b2"));
        for (let t = 0; t < 15; t++) b.step();
        const hs = b.snapshots.map((s: any) => publicVehicles(s)[0]?.turretHeading);
        b.free();
        return hs;
      };
      expect(track("weapon.cannon@1", "ammo.ap@1")).toEqual(track("weapon.mg@1", "ammo.standard@1"));
    },
  );
});

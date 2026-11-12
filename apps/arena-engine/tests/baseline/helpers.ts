/**
 * OLA 2 · Equipo ME · utilidades compartidas de la baseline de caracterización y de los
 * tests de contrato pendientes. NO es un fichero de test (no termina en `.test.ts`).
 *
 * Dos clases de test:
 *
 *  - BASELINE (`apps/arena-engine/tests/baseline/*.test.ts`): fija el comportamiento
 *    ACTUAL del BASE_SHA f07ff6f. Verde en la base. Los que describen un DEFECTO conocido
 *    llevan en el nombre `characterizes-defect: …`: el equipo que arregle el defecto lo
 *    INVIERTE en su PR (y activa el contrato correspondiente), nunca lo borra en silencio.
 *
 *  - CONTRATO PENDIENTE (`apps/arena-engine/tests/contract-pending/*.test.ts` y
 *    `apps/bot-manager/tests/contract-pending/*.test.ts`): describe lo que el equipo dueño
 *    tiene que conseguir. Se declaran con `contractIt(TEAM, …)`:
 *      · por defecto es «rojo esperado»: verde SÓLO si falla con una ASERCIÓN (un
 *        TypeError/ReferenceError es un error de infraestructura y rompe el test);
 *      · si el equipo lo implementa, pasa a «unexpected pass» y la CI se pone roja:
 *        así nadie arregla un contrato sin activarlo a propósito;
 *      · activación: el equipo dueño cambia su `contractIt("MX", …)` por `it(…)` en su PR
 *        (o, para verlo en rojo real antes de implementar, ejecuta con
 *        `S9_CONTRACT_ENFORCE=MX` —o `ALL`— y el test corre como `it` normal).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { loadCatalog } from "../../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../../packages/module-catalog/resolve/index.js";
import type { LoadoutInput, ModuleDefinition } from "../../../../packages/module-catalog/types.js";
import type { ArenaMap } from "../../src/sim/modes.js";
import type { VehicleSpec } from "../../src/sim/vehicle.js";
import { audienceKey, projectReplayStream } from "../../../../packages/projection/index.js";

// `contractIt` y su política viven en un helper compartido (también lo usa bot-manager).
export {
  contractIt,
  enforced,
  fixtureGuard,
  FixtureError,
  isAssertionError,
} from "../../../../packages/test-contracts/contract-it.js";
export type { OwnerTeam } from "../../../../packages/test-contracts/contract-it.js";

// ------------------------------------------------------------------ golden de baseline

const GOLDEN_DIR = join(import.meta.dirname, "golden");

/**
 * Compara con un golden de baseline. A diferencia de replay-golden.test.ts, un golden
 * AUSENTE es un FALLO (no se crea solo): sólo `UPDATE_BASELINE=1` lo escribe, y eso es
 * una decisión consciente que se justifica en la PR (el integrador M0 regenera).
 */
export function assertBaselineGolden(name: string, actual: unknown): void {
  const file = join(GOLDEN_DIR, `${name}.json`);
  const serialized = JSON.stringify(actual, null, 2) + "\n";
  if (process.env.UPDATE_BASELINE === "1") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serialized);
    return;
  }
  expect(existsSync(file), `falta el golden de baseline ${name}.json (UPDATE_BASELINE=1 para crearlo)`).toBe(true);
  expect(
    serialized,
    `La baseline "${name}" ha cambiado. Si el cambio de comportamiento es intencionado, ` +
      `inviértelo/regenéralo en la PR del equipo dueño (UPDATE_BASELINE=1) y justifícalo.`,
  ).toBe(readFileSync(file, "utf8"));
}

export function sha256(x: unknown): string {
  return createHash("sha256")
    .update(typeof x === "string" ? x : JSON.stringify(x))
    .digest("hex");
}

// ------------------------------------------------------------------ salida pública (OLA 2 · MA)

/**
 * Integración OLA 2 (M0): desde MA `battle.snapshots` son FRAMES INTERNOS (captureInternalFrame) y
 * `getPublicSnapshot()` ya no existe; lo que reciben espectador, broadcast y replay público es la
 * proyección de `packages/projection` (audiencia public_live). Este es el ÚNICO adaptador de la
 * baseline y de los contratos a esa frontera (antes leían el snapshot del motor tal cual).
 */
export function publicStream(b: {
  config: { battleId: string; participants: readonly { id: string; botId: string; team: string }[] };
  snapshots: readonly unknown[];
  publicEvents: readonly unknown[];
}) {
  return projectReplayStream({
    battleId: b.config.battleId,
    audience: audienceKey("public_live"),
    roster: b.config.participants.map((p) => ({ id: p.id, botId: p.botId, team: p.team })),
    snapshots: b.snapshots,
    events: b.publicEvents,
  });
}

// ------------------------------------------------------------------ catálogo y loadouts

let catalogCache: ModuleDefinition[] | null = null;
export function catalog(): ModuleDefinition[] {
  catalogCache ??= loadCatalog();
  return catalogCache;
}

/** Resuelve un loadout ad hoc contra el catálogo REAL (sin fixtures de producción nuevos). */
export function loadout(chassis: string, modules: LoadoutInput["modules"], id = "ldt_mebase01"): VehicleSpec {
  return resolveVehicle({ loadoutId: id, revision: 1, catalogVersion: "mvp@1", chassis, modules }, catalog());
}

/** Artillero con munición HE (para HE y doble daño). */
export function gunnerHe(): VehicleSpec {
  return loadout("chassis.medium@1", [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@1" },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.he@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ]);
}

// ------------------------------------------------------------------ mapas

/**
 * Mapa largo y vacío para medir alcances: el tirador (red) en (20, 20) mirando a +X y
 * el blanco (blue) en (20, 80), fuera de la línea de tiro. 1000 m de largo para que
 * ningún proyectil toque el perímetro antes de caducar.
 */
export function rangeArena(widthM = 1000, heightM = 100): ArenaMap {
  return {
    mapId: "me_range",
    version: 1,
    checksum: "sha256:" + "0".repeat(64),
    widthM,
    heightM,
    walls: [],
    destructibles: [],
    spawns: [
      { team: "red", position: { x: 20, y: 20 }, heading: 0 },
      { team: "blue", position: { x: 20, y: 80 }, heading: 0 },
    ],
    bases: [],
    flags: [],
    zones: [],
  };
}

/** Bot guionizado: devuelve `script(tick, obs)` o, si es undefined, una orden vacía. */
export class ScriptBot {
  constructor(
    readonly botId: string,
    private readonly script: (tick: number, obs: any) => Record<string, unknown> | undefined,
  ) {}
  decide(obs: any) {
    return { forTick: obs.tick, ...(this.script(obs.tick, obs) ?? {}) };
  }
}

/** Recorre recursivamente un valor y devuelve todas las cadenas (claves NO incluidas). */
export function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) allStrings(v, out);
  return out;
}

/** Recorre recursivamente un valor y devuelve todas las claves de objeto. */
export function allKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) allKeys(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

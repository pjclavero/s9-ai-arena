/**
 * UX-01 · G-A05 — vehículo del candidato en la partida de humo del build.
 *
 * Antes la partida de humo jugaba SIEMPRE el arquetipo fijo del chasis
 * (light→scout, heavy→heavy, resto→gunner), mientras que la batalla real
 * (engine-executor del tournament-worker) juega el loadout PERSISTIDO de la
 * versión. Un bot validado contra un vehículo distinto del que juega no está
 * validado de verdad. Ahora el humo usa el loadout real; el arquetipo queda de
 * RESERVA, y se dice en el log, sólo si el loadout no llega o no se puede
 * resolver con el catálogo del build (otra versión de catálogo).
 */
import { safeLookup } from "../../../packages/game-rules/index.js";
import { CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import type { ModuleDefinition } from "../../../packages/module-catalog/types.js";
import type { VehicleSpec } from "../../arena-engine/src/sim/vehicle.js";
import type { BotSubmission } from "./types.js";

export interface SmokeVehicle {
  spec: VehicleSpec;
  /** Qué se ha jugado, para el log de la etapa. */
  source: "loadout" | "archetype";
  note: string;
}

export function smokeVehicle(
  sub: Pick<BotSubmission, "archetype" | "loadout">,
  catalog: ModuleDefinition[],
): SmokeVehicle {
  let why = "la versión no trae loadout";
  if (sub.loadout) {
    if (sub.loadout.catalogVersion !== CATALOG_VERSION) {
      why = `el loadout es del catálogo ${sub.loadout.catalogVersion} y el build usa ${CATALOG_VERSION}`;
    } else {
      try {
        return {
          spec: resolveVehicle(sub.loadout, catalog),
          source: "loadout",
          note: `vehículo de la partida de humo: loadout rev ${sub.loadout.revision} de la versión (${sub.loadout.chassis}, ${sub.loadout.modules.length} módulos), el mismo que juega en batalla`,
        };
      } catch (e) {
        why = `el loadout no se pudo resolver (${(e as Error).message})`;
      }
    }
  }
  const fallback = safeLookup(ARCHETYPES, sub.archetype);
  if (!fallback) throw new Error(`arquetipo desconocido: ${String(sub.archetype)}`);
  return {
    spec: resolveVehicle(fallback, catalog),
    source: "archetype",
    note: `vehículo de la partida de humo: arquetipo ${sub.archetype} (${why})`,
  };
}

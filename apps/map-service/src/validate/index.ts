/**
 * validateMap · las SEIS comprobaciones del cap. 14.3 (E4/T4.2).
 *
 * Función PURA: mismo mapa de entrada -> mismo resultado, siempre. No mantiene estado
 * entre llamadas ni depende de nada externo (relojes, aleatoriedad, ficheros). El
 * servicio de publicación (T4.3) llama a `isPublishable` para decidir el 422.
 */
import type { InternalMap } from "../types.js";
import type { Check, ValidationResult } from "./result.js";
import { checkGeometry } from "./geometry.js";
import { checkNavigation } from "./navigation.js";
import { checkPlayability } from "./playability.js";
import { checkBalance } from "./balance.js";
import { checkMode } from "./mode.js";
import { checkDestruction } from "./destruction.js";

export type { Check, CheckId, Severity, ValidationResult } from "./result.js";
export {
  hasRoute,
  buildNavGrid,
  buildGrid,
  gridHasRoute,
  gridRouteDistance,
  requiredConnections,
  supportedChassis,
  clearanceFor,
  CHASSIS_COLLISION_RADIUS_M,
} from "./navigation.js";
export { MIN_CORRIDOR_WIDTH_M, MIN_SPAWN_OPEN_RADIUS_M } from "./playability.js";
export { BALANCE_DISTANCE_TOLERANCE, BALANCE_COVERAGE_TOLERANCE } from "./balance.js";

/**
 * Ejecuta las seis comprobaciones en orden fijo y concatena sus hallazgos. El orden es
 * determinista (geometry, navigation, playability, balance, mode, destruction) para que
 * la salida sea reproducible byte a byte.
 */
export function validateMap(map: InternalMap): ValidationResult {
  const checks: Check[] = [
    ...checkGeometry(map),
    ...checkNavigation(map),
    ...checkPlayability(map),
    ...checkBalance(map),
    ...checkMode(map),
    ...checkDestruction(map),
  ];
  return { checks };
}

/** Un mapa es publicable si ninguna comprobación produjo un hallazgo de severidad "error". */
export function isPublishable(result: ValidationResult): boolean {
  return !result.checks.some((c) => c.severity === "error");
}

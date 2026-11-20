/**
 * Comprobación de MODO (cap. 14.3).
 *
 * Para CADA modo declarado en `meta.supportedModes`, el mapa debe tener las entidades que
 * ese modo necesita. Si un mapa dice soportar un modo que no puede jugarse en él, es un
 * error: la publicación mentiría al organizador.
 *
 *   - capture_the_flag: base Y bandera de al menos 2 equipos.
 *   - zone_control:      al menos una zona de captura (zoneType "capture").
 *   - team_deathmatch:   spawns de al menos 2 equipos.
 *   - deathmatch:        al menos 2 spawns (aunque sean del mismo equipo / sin equipo).
 */
import type { InternalMap } from "../types.js";
import { CheckCollector, type Check } from "./result.js";
import { mapModeProblems } from "../../../../packages/game-rules/map-compat.js";

export function checkMode(map: InternalMap): Check[] {
  const col = new CheckCollector("mode");
  // ADR-022 · las reglas viven en packages/game-rules/map-compat.ts (las comparte la API
  // para explicar en «Nueva batalla» por qué un mapa no es compatible con un modo).
  for (const mode of map.meta.supportedModes) {
    for (const problem of mapModeProblems(map, mode)) col.error(`el modo ${mode} ${problem}`);
  }
  return col.checks;
}

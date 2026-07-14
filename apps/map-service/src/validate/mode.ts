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

export function checkMode(map: InternalMap): Check[] {
  const col = new CheckCollector("mode");
  const spawns = map.layers.spawns;
  const bases = map.layers.bases ?? [];
  const flags = map.layers.flags ?? [];
  const zones = map.layers.zones ?? [];

  const spawnTeams = new Set(spawns.map((s) => s.team));

  for (const mode of map.meta.supportedModes) {
    switch (mode) {
      case "capture_the_flag": {
        // Equipos que tienen a la vez base Y bandera.
        const baseTeams = new Set(bases.map((b) => b.team));
        const flagTeams = new Set(flags.map((f) => f.team));
        const ready = [...flagTeams].filter((t) => baseTeams.has(t));
        if (flags.length === 0) {
          col.error(`el modo capture_the_flag no tiene banderas`);
        } else if (ready.length < 2) {
          col.error(`el modo capture_the_flag exige base Y bandera de >= 2 equipos (solo ${ready.length} lo cumplen)`);
        }
        break;
      }
      case "zone_control": {
        const captureZones = zones.filter((z) => z.zoneType === "capture");
        if (captureZones.length === 0) {
          col.error(`el modo zone_control no tiene ninguna zona de captura`);
        }
        break;
      }
      case "team_deathmatch": {
        if (spawnTeams.size < 2) {
          col.error(`el modo team_deathmatch exige spawns de >= 2 equipos (hay ${spawnTeams.size})`);
        }
        break;
      }
      case "deathmatch": {
        if (spawns.length < 2) {
          col.error(`el modo deathmatch exige >= 2 spawns (hay ${spawns.length})`);
        }
        break;
      }
    }
  }

  return col.checks;
}

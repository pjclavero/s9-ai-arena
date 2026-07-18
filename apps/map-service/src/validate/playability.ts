/**
 * Comprobación de JUGABILIDAD (cap. 14.3).
 *
 * Anchos mínimos de pasillo y de zona abierta alrededor de los spawns. Todos los
 * umbrales se exportan como CONSTANTES parametrizadas (no cableadas dentro de la
 * función) para que E4/T4.4 (generador procedural) pueda reutilizarlas y ajustarlas.
 *
 * Se implementa reutilizando el grid de configuración: una "sonda" de radio
 * MIN_CORRIDOR_WIDTH_M/2 que debe poder recorrer las mismas conexiones exigidas. Como
 * la sonda de comodidad es MÁS ESTRECHA que el chasis pesado (2.0 m de radio), si el
 * mapa soporta chasis grandes y pasa navegación, jugabilidad no puede fallar por
 * pasillos: solo salta en mapas cuyo mayor chasis soportado es pequeño pero cuyos
 * pasillos siguen por debajo del mínimo cómodo. Esto la mantiene ORTOGONAL a navegación.
 */
import type { InternalMap, Vec2 } from "../types.js";
import { CheckCollector, type Check } from "./result.js";
import { buildGrid, buildNavGrid, gridHasRoute, requiredConnections, supportedChassis } from "./navigation.js";

/** Anchura mínima de pasillo para que la batalla sea jugable (no solo transitable). */
export const MIN_CORRIDOR_WIDTH_M = 4.0;
/** Radio de espacio libre exigido alrededor de cada spawn (que no aparezca en un rincón). */
export const MIN_SPAWN_OPEN_RADIUS_M = 2.0;

export function checkPlayability(map: InternalMap): Check[] {
  const col = new CheckCollector("playability");
  const conns = requiredConnections(map);

  // El chequeo de anchura de pasillo solo tiene sentido cuando la NAVEGACIÓN ya pasa para
  // todos los chasis soportados: si algún chasis no llega, es un problema de navegación
  // (lo reporta navigation.ts) y jugabilidad no debe doblar el diagnóstico. Comodidad es
  // una capa POR ENCIMA de la transitabilidad, no un sustituto.
  const sizes = supportedChassis(map);
  const navGrids = sizes.map((s) => buildNavGrid(map, s, { ignoreDestructibles: true }));
  const fullyNavigable = conns.every((conn) => navGrids.every((g) => gridHasRoute(g, conn.from, conn.to)));

  if (fullyNavigable) {
    // Sonda de comodidad para pasillos: un disco de MIN_CORRIDOR_WIDTH_M/2.
    const corridorProbe = buildGrid(map, MIN_CORRIDOR_WIDTH_M / 2, { ignoreDestructibles: true });
    for (const conn of conns) {
      if (!gridHasRoute(corridorProbe, conn.from, conn.to)) {
        col.error(
          `la conexión "${conn.label}" no admite un pasillo de ${MIN_CORRIDOR_WIDTH_M} m (demasiado estrecha para jugar con soltura)`,
        );
      }
    }
  }

  // Espacio abierto alrededor de cada spawn: la celda del spawn debe seguir libre con la
  // sonda de MIN_SPAWN_OPEN_RADIUS_M (si no, el robot nace pegado a un muro).
  const spawnProbe = buildGrid(map, MIN_SPAWN_OPEN_RADIUS_M, { ignoreDestructibles: true });
  const cell = spawnProbe.cell;
  for (const s of map.layers.spawns) {
    if (isBlockedAt(spawnProbe, s.position, cell)) {
      col.warning(`el spawn "${s.objectId}" tiene menos de ${MIN_SPAWN_OPEN_RADIUS_M} m de espacio abierto alrededor`);
    }
  }

  return col.checks;
}

/** ¿La celda que contiene el punto está bloqueada en este grid? */
function isBlockedAt(
  grid: { cols: number; rows: number; cell: number; blocked: Uint8Array },
  p: Vec2,
  cell: number,
): boolean {
  const c = Math.min(grid.cols - 1, Math.max(0, Math.floor(p.x / cell)));
  const r = Math.min(grid.rows - 1, Math.max(0, Math.floor(p.y / cell)));
  return grid.blocked[r * grid.cols + c] === 1;
}

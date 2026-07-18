/**
 * Comprobación de DESTRUCCIÓN (cap. 14.3).
 *
 * Recalcula la navegación DOS VECES sobre cada conexión exigida: con los destructibles
 * INTACTOS (bloquean) y con TODOS eliminados (no bloquean). La política del mapa decide
 * qué es aceptable:
 *   - `destructiblesMayBlockOnlyRoute` false o ausente: debe existir ruta a todo objetivo
 *     SIN destruir nada. Si la ÚNICA ruta pasa por un destructible (llega solo tras
 *     destruirlo), es ERROR: un equipo no debería depender de derribar cajas para moverse.
 *   - true: basta con que exista ruta TRAS destruir. Si ni destruyéndolo todo hay ruta,
 *     es ERROR (barrera de muro indestructible, no de destructibles).
 *
 * Reutiliza `hasRoute` de navigation.ts (misma construcción de grid y BFS) para que las
 * dos comprobaciones no puedan divergir en cómo miden la transitabilidad.
 */
import type { InternalMap } from "../types.js";
import { CheckCollector, type Check } from "./result.js";
import { buildNavGrid, gridHasRoute, requiredConnections, supportedChassis } from "./navigation.js";

export function checkDestruction(map: InternalMap): Check[] {
  const col = new CheckCollector("destruction");
  const mayBlock = map.meta.destructiblesMayBlockOnlyRoute ?? false;
  const conns = requiredConnections(map);
  const sizes = supportedChassis(map);

  for (const size of sizes) {
    // Dos grids por chasis: destructibles intactos vs. todos eliminados.
    const gridIntact = buildNavGrid(map, size, { ignoreDestructibles: false });
    const gridCleared = buildNavGrid(map, size, { ignoreDestructibles: true });

    for (const conn of conns) {
      const routeIntact = gridHasRoute(gridIntact, conn.from, conn.to);
      const routeCleared = gridHasRoute(gridCleared, conn.from, conn.to);

      if (!mayBlock) {
        // Solo culpo a la destrucción cuando destruir ABRE la ruta (routeCleared) pero
        // intacta NO existe: eso significa que un destructible es la única barrera. Si ni
        // destruyendo hay ruta, el problema es de muros (lo reporta navigation), no aquí.
        if (routeCleared && !routeIntact) {
          col.error(
            `la única ruta de "${conn.label}" (chasis "${size}") atraviesa un destructible, pero destructiblesMayBlockOnlyRoute es false`,
          );
        }
      } else {
        if (!routeCleared) {
          col.error(
            `no hay ruta en "${conn.label}" (chasis "${size}") ni siquiera destruyendo todos los destructibles`,
          );
        }
      }
    }
  }

  return col.checks;
}

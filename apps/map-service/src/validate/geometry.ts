/**
 * Comprobación de GEOMETRÍA (cap. 14.3).
 *
 * Reglas puramente estáticas sobre las formas, sin navegación:
 *   - `ground.data.length` debe ser `cols*rows` (el esquema de E1 delega esto en E4).
 *   - toda posición (formas, spawns, banderas) cae dentro de [0,widthM] x [0,heightM].
 *   - NINGÚN spawn ni bandera queda dentro de un obstáculo sólido (muro o destructible):
 *     un robot no puede aparecer empotrado ni una bandera ser inalcanzable por estar
 *     dentro de una caja.
 */
import type { InternalMap, Vec2 } from "../types.js";
import { CheckCollector, type Check } from "./result.js";
import { aabb, pointInShape } from "./shapes.js";

/** ¿El punto está dentro del rectángulo del mundo [0,widthM] x [0,heightM]? */
function inBounds(p: Vec2, map: InternalMap): boolean {
  return p.x >= 0 && p.x <= map.widthM && p.y >= 0 && p.y <= map.heightM;
}

export function checkGeometry(map: InternalMap): Check[] {
  const col = new CheckCollector("geometry");
  const { ground, walls, spawns } = map.layers;
  const destructibles = map.layers.destructibles ?? [];

  // 1) Coherencia del grid de terreno.
  const expected = ground.cols * ground.rows;
  if (ground.data.length !== expected) {
    col.error(
      `ground.data tiene ${ground.data.length} celdas pero cols*rows = ${ground.cols}*${ground.rows} = ${expected}`,
    );
  }

  // 2) Cota de destructibles (mejora E4.M: protege el presupuesto de tick del motor). Es
  //    una restricción estática de recuento, de ahí que viva en la comprobación geométrica.
  if (map.meta.maxDestructibles !== undefined && destructibles.length > map.meta.maxDestructibles) {
    col.error(
      `hay ${destructibles.length} destructibles, por encima de meta.maxDestructibles = ${map.meta.maxDestructibles}`,
    );
  }

  // 3) Todo dentro de los límites del mapa. Para muros/destructibles compruebo su caja.
  for (let i = 0; i < walls.length; i++) {
    const b = aabb(walls[i]);
    if (b.minX < 0 || b.minY < 0 || b.maxX > map.widthM || b.maxY > map.heightM) {
      col.error(
        `el muro #${i} se sale de los límites del mapa (${b.minX.toFixed(1)},${b.minY.toFixed(1)})-(${b.maxX.toFixed(1)},${b.maxY.toFixed(1)})`,
      );
    }
  }
  for (const d of destructibles) {
    const b = aabb(d);
    if (b.minX < 0 || b.minY < 0 || b.maxX > map.widthM || b.maxY > map.heightM) {
      col.error(`el destructible "${d.objectId}" se sale de los límites del mapa`);
    }
  }
  for (const s of spawns) {
    if (!inBounds(s.position, map)) col.error(`el spawn "${s.objectId}" está fuera de los límites del mapa`);
  }
  for (const f of map.layers.flags ?? []) {
    if (!inBounds(f.position, map)) col.error(`la bandera "${f.objectId}" está fuera de los límites del mapa`);
  }

  // 4) Solapes inválidos: spawns y banderas no pueden caer dentro de un sólido.
  for (const s of spawns) {
    for (let i = 0; i < walls.length; i++) {
      if (pointInShape(s.position, walls[i])) col.error(`el spawn "${s.objectId}" está dentro del muro #${i}`);
    }
    for (const d of destructibles) {
      if (pointInShape(s.position, d))
        col.error(`el spawn "${s.objectId}" está dentro del destructible "${d.objectId}"`);
    }
  }
  for (const f of map.layers.flags ?? []) {
    for (let i = 0; i < walls.length; i++) {
      if (pointInShape(f.position, walls[i]))
        col.error(`la bandera "${f.objectId}" está dentro del muro #${i} (sería inalcanzable)`);
    }
    for (const d of destructibles) {
      if (pointInShape(f.position, d))
        col.error(`la bandera "${f.objectId}" está dentro del destructible "${d.objectId}"`);
    }
  }

  return col.checks;
}

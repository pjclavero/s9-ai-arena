/**
 * toEngineMap(internal) -> ArenaMap: aplana el formato de almacenamiento de E1 (grid
 * de tiles + materiales + formas) a la forma runtime simplificada que el motor de E2
 * consume (rectángulos con posición y semiancho/semialto; bases y zonas con radio).
 * El motor NUNCA lee el formato de E1 directamente: pasa siempre por aquí.
 *
 * La interfaz ArenaMap objetivo está en apps/arena-engine/src/sim/modes.ts; se importa
 * de ahí (no se redefine) para que un cambio en el motor rompa la compilación aquí en
 * vez de divergir en silencio.
 */
import type { ArenaMap } from "../../arena-engine/src/sim/modes.js";
import type { BaseShape, DestructibleShape, InternalMap, Material, Shape, Vec2, ZoneShape } from "./types.js";

/** Caja delimitadora {position, halfW, halfH, rotation} de una forma cualquiera. */
function boundingBox(shape: Shape): { position: Vec2; halfW: number; halfH: number; rotation: number } {
  const rotation = shape.rotation ?? 0;
  if (shape.shape === "rect") {
    return {
      position: shape.position ?? { x: 0, y: 0 },
      halfW: (shape.widthM ?? 0) / 2,
      halfH: (shape.heightM ?? 0) / 2,
      rotation,
    };
  }
  if (shape.shape === "circle") {
    const r = shape.radiusM ?? 0;
    return { position: shape.position ?? { x: 0, y: 0 }, halfW: r, halfH: r, rotation: 0 };
  }
  // polygon: caja delimitadora axis-aligned de sus puntos (aproximación conservadora
  // para el motor, cuya física del MVP trabaja con rectángulos; el polígono exacto se
  // conserva en el formato interno para el validador y el visor).
  const pts = shape.points ?? [];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs);
  const minY = Math.min(...ys),
    maxY = Math.max(...ys);
  return {
    position: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    halfW: (maxX - minX) / 2,
    halfH: (maxY - minY) / 2,
    rotation: 0,
  };
}

/** Radio equivalente de una forma para bases/zonas (que en ArenaMap son círculos). */
function equivalentRadius(shape: Shape): number {
  if (shape.shape === "circle") return shape.radiusM ?? 0;
  const bb = boundingBox(shape);
  // min(semiancho, semialto): el círculo inscrito. Para una base, "estar dentro" no
  // debe ser más laxo que la forma real, así que se toma la dimensión menor.
  return Math.min(bb.halfW, bb.halfH);
}

export function toEngineMap(map: InternalMap): ArenaMap {
  const materialById = new Map<string, Material>(map.materials.map((m) => [m.id, m]));

  const walls: ArenaMap["walls"] = map.layers.walls.map((w, i) => {
    const bb = boundingBox(w);
    return { id: `wall_${i}`, position: bb.position, halfW: bb.halfW, halfH: bb.halfH, rotation: bb.rotation };
  });

  const destructibles: ArenaMap["destructibles"] = (map.layers.destructibles ?? []).map((d: DestructibleShape) => {
    const bb = boundingBox(d);
    const hp = materialById.get(d.material)?.hp ?? 100;
    return { id: d.objectId, position: bb.position, halfW: bb.halfW, halfH: bb.halfH, hp };
  });

  const spawns: ArenaMap["spawns"] = map.layers.spawns.map((s) => ({
    team: s.team,
    position: s.position,
    heading: s.heading,
  }));

  const bases: ArenaMap["bases"] = (map.layers.bases ?? []).map((b: BaseShape) => ({
    team: b.team,
    position: b.position ?? { x: 0, y: 0 },
    radiusM: equivalentRadius(b),
  }));

  const flags: ArenaMap["flags"] = (map.layers.flags ?? []).map((f) => ({ team: f.team, position: f.position }));

  // Solo las zonas de daño y captura llegan al runtime. no_entry/cover son
  // información de validación/navegación, no entidades que el motor simule.
  const zones: ArenaMap["zones"] = (map.layers.zones ?? [])
    .filter((z: ZoneShape) => z.zoneType === "damage" || z.zoneType === "capture")
    .map((z: ZoneShape) => ({
      id: z.objectId,
      position: z.position ?? { x: 0, y: 0 },
      radiusM: equivalentRadius(z),
      kind: z.zoneType as "damage" | "capture",
      ...(z.damagePerSecond !== undefined ? { damagePerSecond: z.damagePerSecond } : {}),
    }));

  return {
    mapId: map.mapId,
    version: map.version,
    checksum: map.checksum,
    widthM: map.widthM,
    heightM: map.heightM,
    walls,
    destructibles,
    spawns,
    bases,
    flags,
    zones,
  };
}

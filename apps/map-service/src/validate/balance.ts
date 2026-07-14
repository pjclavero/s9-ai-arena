/**
 * Comprobación de EQUILIBRIO (cap. 14.3, mejora E4.M: tolerancia por defecto <= 10 %).
 *
 * Dos señales de simetría entre lados:
 *   - Distancia de cada equipo desde su spawn hasta su objetivo (bandera/base enemiga, o
 *     el centro del mapa si no hay). Si un lado lo tiene mucho más cerca que el otro, la
 *     partida está sesgada: ERROR si la diferencia supera BALANCE_DISTANCE_TOLERANCE.
 *   - Cobertura aproximada: recuento de obstáculos por mitad del mapa. Es más difusa, así
 *     que solo AVISA (warning) y solo cuando hay obstáculos suficientes para juzgar.
 */
import type { InternalMap, Vec2 } from "../types.js";
import { CheckCollector, type Check } from "./result.js";
import { shapeCenter } from "./shapes.js";

/** Diferencia relativa máxima admisible en distancias spawn->objetivo entre lados. */
export const BALANCE_DISTANCE_TOLERANCE = 0.1;
/** Diferencia relativa admisible en el recuento de obstáculos por mitad. */
export const BALANCE_COVERAGE_TOLERANCE = 0.35;
/** No se juzga la simetría de cobertura por debajo de este número de obstáculos. */
export const BALANCE_COVERAGE_MIN_OBSTACLES = 6;

function centroid(pts: Vec2[]): Vec2 {
  const s = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: s.x / pts.length, y: s.y / pts.length };
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function checkBalance(map: InternalMap): Check[] {
  const col = new CheckCollector("balance");
  const spawns = map.layers.spawns;
  const teams = [...new Set(spawns.map((s) => s.team))];

  // --- Simetría de distancia spawn -> objetivo enemigo ---
  if (teams.length >= 2) {
    const center: Vec2 = { x: map.widthM / 2, y: map.heightM / 2 };
    const distByTeam = new Map<string, number>();
    for (const team of teams) {
      const spawnCentroid = centroid(spawns.filter((s) => s.team === team).map((s) => s.position));
      const enemyPts: Vec2[] = [];
      for (const b of map.layers.bases ?? []) if (b.team !== team && b.position) enemyPts.push(b.position);
      for (const f of map.layers.flags ?? []) if (f.team !== team) enemyPts.push(f.position);
      const objective = enemyPts.length > 0 ? centroid(enemyPts) : center;
      distByTeam.set(team, dist(spawnCentroid, objective));
    }
    const values = [...distByTeam.values()];
    const max = Math.max(...values);
    const min = Math.min(...values);
    if (max > 0) {
      const rel = (max - min) / max;
      if (rel > BALANCE_DISTANCE_TOLERANCE) {
        const detail = [...distByTeam.entries()].map(([t, d]) => `${t}=${d.toFixed(1)}m`).join(", ");
        col.error(`distancias spawn->objetivo desiguales entre lados (${(rel * 100).toFixed(0)}% > ${BALANCE_DISTANCE_TOLERANCE * 100}%): ${detail}`);
      }
    }
  }

  // --- Simetría de cobertura: obstáculos por mitad (izquierda/derecha) ---
  const obstacles = [...map.layers.walls, ...(map.layers.destructibles ?? [])];
  const mid = map.widthM / 2;
  const eps = (map.navCellSizeM ?? 0.5) * 2; // los obstáculos centrales no cuentan a ningún lado
  let left = 0;
  let right = 0;
  for (const o of obstacles) {
    const cx = shapeCenter(o).x;
    if (cx < mid - eps) left++;
    else if (cx > mid + eps) right++;
  }
  const total = left + right;
  if (total >= BALANCE_COVERAGE_MIN_OBSTACLES) {
    const maxHalf = Math.max(left, right);
    const rel = maxHalf > 0 ? (maxHalf - Math.min(left, right)) / maxHalf : 0;
    if (rel > BALANCE_COVERAGE_TOLERANCE) {
      col.warning(`cobertura asimétrica: ${left} obstáculos a la izquierda vs ${right} a la derecha`);
    }
  }

  return col.checks;
}

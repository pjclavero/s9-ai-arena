/**
 * Comprobación de NAVEGACIÓN (cap. 14.3, mejora E4.M).
 *
 * Construye un grid de configuración (config-space) con celda NAV_CELL_SIZE_M, marca
 * bloqueadas las celdas cubiertas por MUROS y luego INFLA el bloqueo por el "clearance"
 * del chasis (radio de colisión + margen). Sobre ese grid comprueba con BFS que existe
 * ruta entre los puntos que el juego exige conectar (spawns/bases/banderas del mismo
 * equipo y ambos lados) PARA CADA tamaño de chasis soportado.
 *
 * Decisión de diseño (PORQUÉ): la navegación trata los DESTRUCTIBLES como TRANSITABLES
 * (se pueden destruir). Así esta comprobación aísla la conectividad estructural por
 * MUROS indestructibles, y la política de "¿puede un destructible ser la única barrera?"
 * queda enteramente en destruction.ts. De lo contrario un mismo defecto dispararía dos
 * comprobaciones y sería imposible saber cuál es la causa raíz.
 */
import { NAV_CELL_SIZE_M, NAV_CLEARANCE_MARGIN_M } from "../../../../packages/game-rules/index.js";
import type { ChassisSize, InternalMap, Vec2 } from "../types.js";
import { CheckCollector, type Check } from "./result.js";
import { aabb, pointInShape } from "./shapes.js";

/**
 * Radio de colisión por chasis, en metros. Son los `radiusM` REALES del catálogo de E3
 * (packages/module-catalog/data/chassis.*@1.json): light 1.2, medium 1.6, heavy 2.0.
 * Se cablean aquí como constante documentada para no acoplar el validador al cargador
 * del catálogo; si el catálogo cambiara estos radios, este es el único punto a tocar.
 */
export const CHASSIS_COLLISION_RADIUS_M: Record<ChassisSize, number> = {
  light: 1.2,
  medium: 1.6,
  heavy: 2.0,
};

/** Clearance = radio del chasis + margen del ADR-000. Es el radio del disco a "barrer". */
export function clearanceFor(size: ChassisSize): number {
  return CHASSIS_COLLISION_RADIUS_M[size] + NAV_CLEARANCE_MARGIN_M;
}

/** Los tres tamaños son el valor por defecto cuando el mapa no restringe (schema: opcional). */
export const ALL_CHASSIS: ChassisSize[] = ["light", "medium", "heavy"];

/** Tamaños de chasis que el mapa declara soportar (o los tres si no declara ninguno). */
export function supportedChassis(map: InternalMap): ChassisSize[] {
  const declared = map.meta.supportedChassisSizes;
  return declared && declared.length > 0 ? declared : ALL_CHASSIS;
}

export interface NavGrid {
  cols: number;
  rows: number;
  cell: number;
  widthM: number;
  heightM: number;
  /** Fila a fila; 1 = no transitable por un disco del clearance dado. */
  blocked: Uint8Array;
}

export interface NavOptions {
  /** Si true, los destructibles NO bloquean (se asumen ya destruidos). */
  ignoreDestructibles?: boolean;
}

/** Índice lineal de la celda (c, r). */
function idx(grid: { cols: number }, c: number, r: number): number {
  return r * grid.cols + c;
}

/** Celda que contiene el punto (metros), recortada al grid. */
function cellOf(grid: NavGrid, p: Vec2): { c: number; r: number } {
  const c = Math.min(grid.cols - 1, Math.max(0, Math.floor(p.x / grid.cell)));
  const r = Math.min(grid.rows - 1, Math.max(0, Math.floor(p.y / grid.cell)));
  return { c, r };
}

/** Centro (metros) de la celda (c, r). */
function centerOf(grid: NavGrid, c: number, r: number): Vec2 {
  return { x: (c + 0.5) * grid.cell, y: (r + 0.5) * grid.cell };
}

/**
 * Construye el grid inflado para un `clearance` arbitrario. Lo usan tanto navigation
 * (clearance por chasis) como playability (un "sonda" de anchura cómoda), de ahí que
 * el radio sea un parámetro y no se derive del chasis aquí dentro.
 */
export function buildGrid(map: InternalMap, clearance: number, opts: NavOptions = {}): NavGrid {
  const cell = map.navCellSizeM ?? NAV_CELL_SIZE_M;
  const cols = Math.max(1, Math.ceil(map.widthM / cell));
  const rows = Math.max(1, Math.ceil(map.heightM / cell));
  const grid: NavGrid = {
    cols,
    rows,
    cell,
    widthM: map.widthM,
    heightM: map.heightM,
    blocked: new Uint8Array(cols * rows),
  };

  // 1) Bloqueo base: celdas cuyo CENTRO cae dentro de un obstáculo sólido. Solo recorro
  //    las celdas de la caja de cada forma (los obstáculos son escasos) en vez del grid
  //    entero por cada forma.
  const obstacles = [...map.layers.walls];
  if (!opts.ignoreDestructibles) obstacles.push(...(map.layers.destructibles ?? []));

  const base = new Uint8Array(cols * rows);
  for (const shape of obstacles) {
    const box = aabb(shape);
    const c0 = Math.max(0, Math.floor(box.minX / cell));
    const c1 = Math.min(cols - 1, Math.floor(box.maxX / cell));
    const r0 = Math.max(0, Math.floor(box.minY / cell));
    const r1 = Math.min(rows - 1, Math.floor(box.maxY / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (base[idx(grid, c, r)]) continue;
        if (pointInShape(centerOf(grid, c, r), shape)) base[idx(grid, c, r)] = 1;
      }
    }
  }

  // 2) Inflado: un disco de radio `clearance` no cabe si su centro está a <= clearance de
  //    un obstáculo. Dilato las celdas base con un kernel circular precalculado.
  const radiusCells = Math.ceil(clearance / cell);
  const offsets: Array<{ dc: number; dr: number }> = [];
  for (let dr = -radiusCells; dr <= radiusCells; dr++) {
    for (let dc = -radiusCells; dc <= radiusCells; dc++) {
      // Distancia real en metros entre centros de celda (evita inflar de más en diagonal).
      if (Math.hypot(dc * cell, dr * cell) <= clearance) offsets.push({ dc, dr });
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!base[idx(grid, c, r)]) continue;
      for (const o of offsets) {
        const nc = c + o.dc;
        const nr = r + o.dr;
        if (nc >= 0 && nc < cols && nr >= 0 && nr < rows) grid.blocked[idx(grid, nc, nr)] = 1;
      }
    }
  }

  // 3) Borde de la arena: el disco tampoco puede acercarse a menos de `clearance` del
  //    perímetro del mapa. Modela la pared exterior sin necesidad de muros explícitos.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = centerOf(grid, c, r);
      if (p.x < clearance || p.x > map.widthM - clearance || p.y < clearance || p.y > map.heightM - clearance) {
        grid.blocked[idx(grid, c, r)] = 1;
      }
    }
  }
  return grid;
}

/** Grid de navegación para un chasis concreto. */
export function buildNavGrid(map: InternalMap, size: ChassisSize, opts: NavOptions = {}): NavGrid {
  return buildGrid(map, clearanceFor(size), opts);
}

/**
 * Celda transitable más cercana a un punto (búsqueda en anillos crecientes). Un objetivo
 * (spawn, base, bandera) puede caer en una celda bloqueada —por el inflado del clearance
 * o por estar el propio punto dentro de un sólido— aun perteneciendo a una región jugable;
 * se "engancha" a la celda libre más próxima. La búsqueda NO está acotada por un radio
 * pequeño A PROPÓSITO: la navegación razona sobre CONECTIVIDAD DE REGIONES, no sobre la
 * colocación exacta del punto (de eso se ocupa geometry.ts). Así, un spawn empotrado en un
 * muro se engancha al borde libre del muro y esta comprobación no lo reporta como "sin
 * ruta" —sería un doble diagnóstico del mismo defecto—; solo reporta ausencia de ruta
 * cuando la región es realmente inalcanzable.
 */
function nearestFreeCell(grid: NavGrid, p: Vec2): { c: number; r: number } | null {
  const { c, r } = cellOf(grid, p);
  if (!grid.blocked[idx(grid, c, r)]) return { c, r };
  const maxRings = Math.max(grid.cols, grid.rows);
  for (let ring = 1; ring <= maxRings; ring++) {
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue; // solo el perímetro del anillo
        const nc = c + dc;
        const nr = r + dr;
        if (nc >= 0 && nc < grid.cols && nr >= 0 && nr < grid.rows && !grid.blocked[idx(grid, nc, nr)]) {
          return { c: nc, r: nr };
        }
      }
    }
  }
  return null;
}

/**
 * Distancia de la ruta (en pasos de celda) entre dos puntos, o null si no hay ruta.
 * BFS 4-conexo: conservador (no "corta esquinas" en diagonal por huecos de una celda).
 */
export function gridRouteDistance(grid: NavGrid, from: Vec2, to: Vec2): number | null {
  const a = nearestFreeCell(grid, from);
  const b = nearestFreeCell(grid, to);
  if (!a || !b) return null;

  const dist = new Int32Array(grid.cols * grid.rows).fill(-1);
  const startI = idx(grid, a.c, a.r);
  const goalI = idx(grid, b.c, b.r);
  dist[startI] = 0;
  const queue: number[] = [startI];
  let head = 0;
  const steps = [
    { dc: 1, dr: 0 },
    { dc: -1, dr: 0 },
    { dc: 0, dr: 1 },
    { dc: 0, dr: -1 },
  ];
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur === goalI) return dist[cur];
    const cc = cur % grid.cols;
    const cr = (cur - cc) / grid.cols;
    const d = dist[cur];
    for (const s of steps) {
      const nc = cc + s.dc;
      const nr = cr + s.dr;
      if (nc < 0 || nc >= grid.cols || nr < 0 || nr >= grid.rows) continue;
      const ni = idx(grid, nc, nr);
      if (grid.blocked[ni] || dist[ni] !== -1) continue;
      dist[ni] = d + 1;
      queue.push(ni);
    }
  }
  return dist[goalI] >= 0 ? dist[goalI] : null;
}

/** ¿Existe ruta entre dos puntos en este grid ya construido? */
export function gridHasRoute(grid: NavGrid, from: Vec2, to: Vec2): boolean {
  return gridRouteDistance(grid, from, to) !== null;
}

/**
 * Función REUTILIZABLE (la usa también destruction.ts): ¿puede un chasis `size` ir de
 * `from` a `to` en este mapa? Construye el grid internamente. Para muchas parejas sobre
 * el mismo grid, prefiérase buildNavGrid + gridHasRoute (evita reconstruirlo).
 */
export function hasRoute(map: InternalMap, size: ChassisSize, from: Vec2, to: Vec2, opts: NavOptions = {}): boolean {
  return gridHasRoute(buildNavGrid(map, size, opts), from, to);
}

export interface Connection {
  from: Vec2;
  to: Vec2;
  label: string;
}

/**
 * Parejas de puntos que el juego EXIGE conectar. Se comparten con playability y
 * destruction para que las tres comprobaciones razonen sobre la misma topología:
 *   - dentro de cada equipo: su primer spawn con cada uno de sus demás spawns, bases y
 *     banderas (conectividad transitiva de todos los objetivos del equipo);
 *   - entre lados: un spawn de cada equipo con un spawn del siguiente (el mapa no puede
 *     quedar partido en islas por equipo).
 */
export function requiredConnections(map: InternalMap): Connection[] {
  const conns: Connection[] = [];
  const spawns = map.layers.spawns;
  const teams = [...new Set(spawns.map((s) => s.team))];

  const anchors: Record<string, Vec2> = {};
  for (const team of teams) {
    const teamSpawns = spawns.filter((s) => s.team === team);
    const anchor = teamSpawns[0].position;
    anchors[team] = anchor;

    const targets: Array<{ p: Vec2; label: string }> = [];
    for (let i = 1; i < teamSpawns.length; i++)
      targets.push({ p: teamSpawns[i].position, label: `spawn ${teamSpawns[i].objectId}` });
    for (const b of map.layers.bases ?? [])
      if (b.team === team && b.position) targets.push({ p: b.position, label: `base ${b.objectId}` });
    for (const f of map.layers.flags ?? [])
      if (f.team === team) targets.push({ p: f.position, label: `bandera ${f.objectId}` });

    for (const t of targets) conns.push({ from: anchor, to: t.p, label: `equipo ${team}: spawn -> ${t.label}` });
  }

  // Conectividad entre lados: encadena los anclas de equipos consecutivos.
  for (let i = 1; i < teams.length; i++) {
    conns.push({
      from: anchors[teams[i - 1]],
      to: anchors[teams[i]],
      label: `entre lados: ${teams[i - 1]} <-> ${teams[i]}`,
    });
  }
  return conns;
}

/** Umbral: si un chasis mayor necesita un rodeo >50 % más largo que el menor, se avisa. */
export const NAV_DETOUR_WARN_RATIO = 1.5;

export function checkNavigation(map: InternalMap): Check[] {
  const col = new CheckCollector("navigation");
  const sizes = supportedChassis(map);
  const conns = requiredConnections(map);

  // Los destructibles se ignoran aquí (ver cabecera): esta comprobación mira solo muros.
  const grids = new Map<ChassisSize, NavGrid>();
  for (const size of sizes) grids.set(size, buildNavGrid(map, size, { ignoreDestructibles: true }));

  for (const conn of conns) {
    const distBySize = new Map<ChassisSize, number | null>();
    for (const size of sizes) distBySize.set(size, gridRouteDistance(grids.get(size)!, conn.from, conn.to));

    const reachable = sizes.filter((s) => distBySize.get(s) !== null);
    if (reachable.length === 0) {
      // Ni el chasis más pequeño llega: la conexión es imposible para todos.
      col.error(`sin ruta para NINGÚN chasis en la conexión "${conn.label}" (el mapa está partido por muros)`);
      continue;
    }
    // Cada chasis soportado que se queda sin ruta a un objetivo es un error (la regla del
    // cap. 14.3: dejar a un chasis soportado totalmente sin ruta a un objetivo).
    for (const size of sizes) {
      if (distBySize.get(size) === null) {
        col.error(
          `sin ruta para chasis "${size}" en la conexión "${conn.label}" (pasillo intransitable para su tamaño)`,
        );
      }
    }
    // Aviso (no error): un chasis mayor SÍ llega pero por un rodeo mucho más largo que el
    // menor. Indica un pasillo cómodo solo para los pequeños, sin dejar a nadie aislado.
    const smallestDist = distBySize.get(reachable[0]);
    if (smallestDist && smallestDist > 0) {
      for (const size of reachable.slice(1)) {
        const d = distBySize.get(size)!;
        if (d > smallestDist * NAV_DETOUR_WARN_RATIO) {
          col.warning(`chasis "${size}" necesita un rodeo largo en "${conn.label}" (pasillo estrecho para su tamaño)`);
        }
      }
    }
  }
  return col.checks;
}

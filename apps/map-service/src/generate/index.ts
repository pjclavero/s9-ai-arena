/**
 * T4.4 · Generador procedural de mapas con semilla.
 *
 * Determinismo estricto: mismos `params` + misma `seed` ⇒ mismo mapa BYTE A BYTE
 * (mismo checksum). Toda la aleatoriedad sale del `Rng` con semilla del motor
 * (xoshiro128**, apps/arena-engine/src/rng.ts), nunca `Math.random`. Los reintentos
 * usan `rng.fork("retry-"+intento)` — el fork produce una secuencia independiente y
 * determinista, así que "reintentar" no rompe la reproducibilidad.
 *
 * Topología: simetría ESPECULAR respecto al eje vertical central. Se genera la mitad
 * izquierda (equipo red) y se refleja a la derecha (blue): así el equilibrio
 * base→base es exacto (diferencia 0) por construcción, no por casualidad. El muro
 * central se deja con DOS corredores (arriba y abajo) para garantizar ruta.
 *
 * Cada mapa generado PASA por el validador completo de T4.2 antes de devolverse; si
 * no es publicable, se regenera con una semilla derivada, registrando los intentos.
 */
import { Rng } from "../../../arena-engine/src/rng.js";
import { withChecksum } from "../canonical.js";
import { validateMap, isPublishable } from "../validate/index.js";
import type { ChassisSize, GameModeId, InternalMap, Shape } from "../types.js";

export interface GenerateParams {
  widthM?: number;
  heightM?: number;
  mode?: GameModeId;
  /** 0..1: fracción del semiancho jugable que se rellena de coberturas. */
  wallDensity?: number;
  supportedChassisSizes?: ChassisSize[];
  maxAttempts?: number;
  mapId?: string;
}

export interface GenerateResult {
  map: InternalMap;
  attempts: number;
  seed: string;
}

const DEFAULTS = {
  widthM: 120,
  heightM: 80,
  mode: "capture_the_flag" as GameModeId,
  wallDensity: 0.5,
  supportedChassisSizes: ["light", "medium", "heavy"] as ChassisSize[],
  maxAttempts: 8,
};

/** Genera un mapa válido (o el último intento) de forma determinista por semilla. */
export function generateMap(params: GenerateParams, seed: string): GenerateResult {
  const p = { ...DEFAULTS, ...params };
  const baseRng = new Rng(`${seed}|${canonicalParams(p)}`);

  let lastMap: InternalMap | null = null;
  for (let attempt = 1; attempt <= p.maxAttempts; attempt++) {
    // Intento 1 usa la secuencia base; los siguientes, forks etiquetados y deterministas.
    const rng = attempt === 1 ? baseRng.fork("attempt-1") : baseRng.fork(`retry-${attempt}`);
    const map = buildSymmetricMap(p, rng, seed, attempt);
    lastMap = map;
    const validation = validateMap(map);
    if (isPublishable(validation)) {
      return { map, attempts: attempt, seed };
    }
  }
  // Agotados los intentos: se devuelve el último (el llamador decidirá; el servicio
  // NO lo publicará porque no pasa el validador — T4.3/T4.4 lo garantizan).
  return { map: lastMap!, attempts: p.maxAttempts, seed };
}

/**
 * Parámetros con los DEFAULTS aplicados: todo obligatorio salvo mapId, que no tiene
 * default (si falta se deriva de la semilla). Es exactamente el tipo del spread
 * `{ ...DEFAULTS, ...params }` — corrige 2 errores de tsc de H7 (issue #11) sin
 * cambiar lógica.
 */
type ResolvedParams = Required<Omit<GenerateParams, "mapId">> & Pick<GenerateParams, "mapId">;

function canonicalParams(p: ResolvedParams): string {
  return JSON.stringify(
    Object.keys(p)
      .sort()
      .map((k) => [k, (p as any)[k]]),
  );
}

function buildSymmetricMap(p: ResolvedParams, rng: Rng, seed: string, attempt: number): InternalMap {
  const { widthM, heightM } = p;
  const cx = widthM / 2;

  const wallsRng = rng.fork("walls");
  const destrRng = rng.fork("destructibles");

  const walls: Shape[] = [];
  const destructibles: InternalMap["layers"]["destructibles"] = [];

  // --- Muro central con dos corredores (arriba y abajo), simétrico por definición.
  const corridorGap = 16; // hueco de corredor, holgado para chasis pesado (clearance ~2.25 m)
  const wallThickness = 4;
  const armLen = (heightM - corridorGap) / 2 - corridorGap / 2;
  if (armLen > 4) {
    walls.push(rect(cx, heightM - armLen / 2, wallThickness, armLen)); // brazo superior
    walls.push(rect(cx, armLen / 2, wallThickness, armLen)); // brazo inferior
  }

  // --- Coberturas en la mitad IZQUIERDA, reflejadas a la derecha (simetría especular).
  const nCover = Math.max(1, Math.round(p.wallDensity * 4));
  const marginX = 18; // deja libre la zona de spawn/base a la izquierda
  const half = cx - 8; // no invadir el muro central
  for (let i = 0; i < nCover; i++) {
    const x = marginX + wallsRng.range(0, Math.max(1, half - marginX));
    const y = 12 + wallsRng.range(0, Math.max(1, heightM - 24));
    const w = 3 + wallsRng.range(0, 4);
    const h = 3 + wallsRng.range(0, 8);
    walls.push(rect(round1(x), round1(y), round1(w), round1(h)));
    walls.push(rect(round1(widthM - x), round1(y), round1(w), round1(h))); // reflejo
  }

  // --- Destructibles simétricos.
  const nDestr = Math.max(1, Math.round(p.wallDensity * 3));
  for (let i = 0; i < nDestr; i++) {
    const x = marginX + destrRng.range(0, Math.max(1, half - marginX));
    const y = 12 + destrRng.range(0, Math.max(1, heightM - 24));
    destructibles.push(box(`crate_l${i}`, round1(x), round1(y)));
    destructibles.push(box(`crate_r${i}`, round1(widthM - x), round1(y)));
  }

  // --- Spawns, bases y banderas simétricos (equilibrio base→base exacto = 0).
  const spawnX = 10;
  const baseX = 8;
  const midY = heightM / 2;
  const spawns: InternalMap["layers"]["spawns"] = [
    { objectId: "sp_red_1", team: "red", position: { x: spawnX, y: midY - 6 }, heading: 0 },
    { objectId: "sp_red_2", team: "red", position: { x: spawnX, y: midY + 6 }, heading: 0 },
    { objectId: "sp_blue_1", team: "blue", position: { x: widthM - spawnX, y: midY - 6 }, heading: Math.PI },
    { objectId: "sp_blue_2", team: "blue", position: { x: widthM - spawnX, y: midY + 6 }, heading: Math.PI },
  ];
  const bases: InternalMap["layers"]["bases"] = [
    { objectId: "base_red", team: "red", shape: "rect", position: { x: baseX, y: midY }, widthM: 8, heightM: 12 },
    {
      objectId: "base_blue",
      team: "blue",
      shape: "rect",
      position: { x: widthM - baseX, y: midY },
      widthM: 8,
      heightM: 12,
    },
  ];
  const flags: InternalMap["layers"]["flags"] = [
    { objectId: "flag_red", team: "red", position: { x: baseX, y: midY } },
    { objectId: "flag_blue", team: "blue", position: { x: widthM - baseX, y: midY } },
  ];

  const cols = Math.round(widthM / 2);
  const rows = Math.round(heightM / 2);

  const map = withChecksum({
    schemaVersion: 1,
    mapId: p.mapId ?? `proc-${seed}`,
    version: 1,
    widthM,
    heightM,
    navCellSizeM: 0.5,
    generation: {
      generator: "symmetric-cover@1",
      seed,
      params: p as unknown as Record<string, unknown>,
      attempts: attempt,
    },
    materials: [
      { id: "floor", name: "Suelo", blocksMovement: false, blocksVision: false },
      { id: "concrete", name: "Hormigón", blocksMovement: true, blocksVision: true },
      { id: "crate", name: "Caja", blocksMovement: true, blocksVision: true, hp: 120 },
    ],
    layers: {
      ground: { tileSizeM: 2, cols, rows, data: new Array(cols * rows).fill(0) },
      walls,
      destructibles,
      spawns,
      bases,
      flags,
    },
    meta: {
      name: `Procedural ${seed}`,
      author: "E4-generator",
      license: "CC-BY-4.0",
      supportedModes: [p.mode],
      supportedChassisSizes: p.supportedChassisSizes,
      maxDestructibles: 64,
      destructiblesMayBlockOnlyRoute: false,
    },
  });

  return map;
}

function rect(x: number, y: number, w: number, h: number): Shape {
  return { shape: "rect", position: { x, y }, widthM: w, heightM: h, rotation: 0 };
}

function box(objectId: string, x: number, y: number) {
  return { objectId, material: "crate", shape: "rect" as const, position: { x, y }, widthM: 2, heightM: 2 };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Tipos TS del FORMATO INTERNO de mapa (espejo de packages/map-schema/map.schema.json
 * de E1). E1 es la fuente de verdad: estos tipos son su proyección TypeScript, no un
 * esquema paralelo. El pipeline de E4 produce/consume objetos que validan contra ese
 * esquema JSON; estos tipos solo dan tipado estático al código.
 */

export type Vec2 = { x: number; y: number };

export type ChassisSize = "light" | "medium" | "heavy";
export type GameModeId = "deathmatch" | "team_deathmatch" | "capture_the_flag" | "zone_control";
export type ZoneType = "damage" | "capture" | "no_entry" | "cover";
export type ShapeKind = "rect" | "polygon" | "circle";

export interface Shape {
  shape: ShapeKind;
  position?: Vec2;
  widthM?: number;
  heightM?: number;
  radiusM?: number;
  rotation?: number;
  points?: Vec2[];
}

export interface Material {
  id: string;
  name?: string;
  blocksMovement: boolean;
  blocksVision: boolean;
  hp?: number;
  damagePerSecond?: number;
  speedFactor?: number;
}

export interface GroundLayer {
  tileSizeM: number;
  cols: number;
  rows: number;
  data: number[];
}

export interface DestructibleShape extends Shape {
  objectId: string;
  material: string;
}

export interface ZoneShape extends Shape {
  objectId: string;
  zoneType: ZoneType;
  team?: string;
  damagePerSecond?: number;
  captureTimeTicks?: number;
}

export interface Spawn {
  objectId: string;
  team: string;
  position: Vec2;
  heading: number;
  maxChassisSize?: ChassisSize;
}

export interface BaseShape extends Shape {
  objectId: string;
  team: string;
}

export interface Flag {
  objectId: string;
  team: string;
  position: Vec2;
}

export interface NavigationLayer {
  cellSizeM: number;
  cols: number;
  rows: number;
  blocked: string; // base64 bitset, fila a fila; 1 = no transitable por el chasis más pequeño
}

export interface MapLayers {
  ground: GroundLayer;
  walls: Shape[];
  destructibles?: DestructibleShape[];
  zones?: ZoneShape[];
  spawns: Spawn[];
  bases?: BaseShape[];
  flags?: Flag[];
  navigation?: NavigationLayer;
}

export interface MapMeta {
  name?: string;
  author: string;
  license: string;
  supportedModes: GameModeId[];
  supportedChassisSizes?: ChassisSize[];
  thumbnail?: string;
  maxDestructibles?: number;
  destructiblesMayBlockOnlyRoute?: boolean;
}

export interface MapGeneration {
  generator: string;
  seed: string;
  params: Record<string, unknown>;
  attempts?: number;
}

export interface InternalMap {
  schemaVersion: 1;
  mapId: string;
  version: number;
  checksum: string;
  widthM: number;
  heightM: number;
  navCellSizeM?: number;
  generation?: MapGeneration;
  materials: Material[];
  layers: MapLayers;
  meta: MapMeta;
}

/** Un mapa sin su campo checksum (para calcularlo o antes de asignarlo). */
export type MapWithoutChecksum = Omit<InternalMap, "checksum"> & { checksum?: string };

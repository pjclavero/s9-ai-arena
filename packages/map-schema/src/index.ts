export const MAP_SCHEMA_VERSION = 1 as const;

export type TeamId = "red" | "blue";

export interface RectShape {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

export interface MapWall extends RectShape {
  id: string;
  kind: "wall";
}

export interface DestructibleObstacle extends RectShape {
  id: string;
  kind: "destructible";
  health: number;
}

export interface SpawnPoint {
  id: string;
  team: TeamId;
  x: number;
  y: number;
  heading: number;
}

export interface ArenaMap {
  schemaVersion: typeof MAP_SCHEMA_VERSION;
  id: string;
  name: string;
  width: number;
  height: number;
  seed: number;
  walls: MapWall[];
  obstacles: DestructibleObstacle[];
  spawns: SpawnPoint[];
}

export function validateArenaMap(value: unknown): ArenaMap {
  if (!value || typeof value !== "object") throw new Error("Map must be an object");
  const map = value as Partial<ArenaMap>;
  if (map.schemaVersion !== MAP_SCHEMA_VERSION) throw new Error("Unsupported map schema version");
  if (!map.id || !map.name) throw new Error("Map id and name are required");
  if (
    !Number.isFinite(map.width) ||
    !Number.isFinite(map.height) ||
    Number(map.width) < 300 ||
    Number(map.height) < 300
  ) {
    throw new Error("Map dimensions are invalid");
  }
  if (!Array.isArray(map.walls) || !Array.isArray(map.obstacles) || !Array.isArray(map.spawns)) {
    throw new Error("walls, obstacles and spawns must be arrays");
  }
  for (const team of ["red", "blue"] as const) {
    if (!map.spawns.some((spawn) => spawn.team === team)) throw new Error(`Missing ${team} spawn`);
  }
  return map as ArenaMap;
}

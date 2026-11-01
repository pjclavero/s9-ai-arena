/**
 * Formato interno del editor (InternalMap en metros) y sus funciones puras: mapa
 * nuevo, redimensionar, modos, import (interno y autoría antigua en px), export y
 * validación mínima de autoría. Extraído TAL CUAL de pages/MapEditorPage.tsx
 * (R10 + FC-C), que lo reexporta: el comportamiento de import/export no cambia.
 */
export const PLATFORM_MODES = ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"] as const;

export interface Vec2 {
  x: number;
  y: number;
}
export interface RectShape {
  shape: "rect";
  position: Vec2;
  widthM: number;
  heightM: number;
  rotation?: number;
}
export interface EditorMap {
  schemaVersion: 1;
  mapId: string;
  version: number;
  checksum?: string;
  widthM: number;
  heightM: number;
  navCellSizeM?: number;
  materials: {
    id: string;
    name?: string;
    blocksMovement: boolean;
    blocksVision: boolean;
    hp?: number;
    damagePerSecond?: number;
  }[];
  layers: {
    ground: { tileSizeM: number; cols: number; rows: number; data: number[] };
    walls: RectShape[];
    destructibles?: (RectShape & { objectId: string; material: string })[];
    zones?: {
      shape: "circle";
      position: Vec2;
      radiusM: number;
      objectId: string;
      zoneType: "capture" | "damage";
      damagePerSecond?: number;
      team?: string;
    }[];
    spawns: { objectId: string; team: string; position: Vec2; heading: number }[];
    bases?: (RectShape & { objectId: string; team: string })[];
    flags?: { objectId: string; team: string; position: Vec2 }[];
    [k: string]: unknown;
  };
  meta: { name?: string; author: string; license: string; supportedModes: string[]; [k: string]: unknown };
  [k: string]: unknown;
}

export type ObjKind = "wall" | "destructible" | "spawn" | "base" | "flag" | "zone";
export interface ObjRef {
  kind: ObjKind;
  index: number;
}

const TILE = 2;
const DEFAULT_MATERIALS: EditorMap["materials"] = [
  { id: "floor", name: "Suelo", blocksMovement: false, blocksVision: false },
  { id: "concrete", name: "Muro de hormigón", blocksMovement: true, blocksVision: true },
  { id: "crate", name: "Caja destructible", blocksMovement: true, blocksVision: true, hp: 120 },
  { id: "acid", name: "Zona corrosiva", blocksMovement: false, blocksVision: false, damagePerSecond: 8 },
];

function ground(widthM: number, heightM: number) {
  const cols = Math.max(1, Math.ceil(widthM / TILE));
  const rows = Math.max(1, Math.ceil(heightM / TILE));
  return { tileSizeM: TILE, cols, rows, data: new Array(cols * rows).fill(0) };
}

/** Mapa nuevo: 120×80 m, dos spawns enfrentados, deathmatch + team_deathmatch. */
export function newMap(mapId = "mi-mapa", name = "Mi mapa"): EditorMap {
  const widthM = 120;
  const heightM = 80;
  return {
    schemaVersion: 1,
    mapId,
    version: 1,
    widthM,
    heightM,
    navCellSizeM: 0.5,
    materials: DEFAULT_MATERIALS.map((m) => ({ ...m })),
    layers: {
      ground: ground(widthM, heightM),
      walls: [],
      destructibles: [],
      zones: [],
      spawns: [
        { objectId: "sp_red_1", team: "red", position: { x: 10, y: 40 }, heading: 0 },
        { objectId: "sp_blue_1", team: "blue", position: { x: 110, y: 40 }, heading: Math.PI },
      ],
      bases: [],
      flags: [],
    },
    meta: { name, author: "editor", license: "CC-BY-4.0", supportedModes: ["deathmatch", "team_deathmatch"] },
  };
}

/** Cambia dimensiones regenerando la rejilla de suelo (cols*rows debe cuadrar, E4 geometry). */
export function resize(m: EditorMap, widthM: number, heightM: number): EditorMap {
  return { ...m, widthM, heightM, layers: { ...m.layers, ground: ground(widthM, heightM) } };
}

export function toggleMode(m: EditorMap, mode: string): EditorMap {
  const has = m.meta.supportedModes.includes(mode);
  const supportedModes = has ? m.meta.supportedModes.filter((x) => x !== mode) : [...m.meta.supportedModes, mode];
  return { ...m, meta: { ...m.meta, supportedModes } };
}

const PX_PER_M = 10;
/** Formato de autoría antiguo (slice 1, px) → InternalMap (m). */
export function fromLegacyAuthoring(raw: Record<string, unknown>): EditorMap {
  const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const str = (v: unknown, d: string) => (typeof v === "string" && v ? v : d);
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const widthM = Math.round(num(raw.width, 800) / PX_PER_M);
  const heightM = Math.round(num(raw.height, 600) / PX_PER_M);
  const slug =
    str(raw.id, "importado")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "importado";
  const m = newMap(slug.length >= 2 ? slug : `${slug}-mapa`, str(raw.name, "Mapa importado"));
  const rect = (r: Record<string, unknown>): RectShape => ({
    shape: "rect",
    position: { x: num(r.x) / PX_PER_M, y: num(r.y) / PX_PER_M },
    widthM: num(r.width, 10) / PX_PER_M,
    heightM: num(r.height, 10) / PX_PER_M,
  });
  return {
    ...resize(m, widthM, heightM),
    layers: {
      ...resize(m, widthM, heightM).layers,
      walls: arr(raw.walls).map(rect),
      destructibles: arr(raw.obstacles).map((r, i) => ({
        ...rect(r),
        objectId: str(r.id, `crate-${i}`),
        material: "crate",
      })),
      spawns: arr(raw.spawns).map((r, i) => ({
        objectId: str(r.id, `spawn-${i}`),
        team: str(r.team, "red"),
        position: { x: num(r.x) / PX_PER_M, y: num(r.y) / PX_PER_M },
        heading: num(r.heading),
      })),
    },
  };
}

/** Import del editor: InternalMap tal cual, o autoría antigua convertida. Lanza si no es ninguno. */
export function parseImport(text: string): EditorMap {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("El JSON no es un objeto de mapa");
  if (raw.layers && typeof raw.mapId === "string") {
    const m = raw as unknown as EditorMap;
    if (!m.layers.ground || !Array.isArray(m.layers.walls) || !Array.isArray(m.layers.spawns) || !m.meta) {
      throw new Error("Mapa interno incompleto (faltan layers.ground/walls/spawns o meta)");
    }
    return m;
  }
  if (typeof raw.id === "string" && typeof raw.width === "number") return fromLegacyAuthoring(raw);
  throw new Error("Formato no reconocido: se espera un mapa interno (mapId, layers) o el JSON de autoría antiguo");
}

/** Documento a enviar/exportar: sin version/checksum (los fija el servidor). */
export function toDocument(m: EditorMap): EditorMap {
  const { checksum: _c, ...rest } = m;
  return rest as EditorMap;
}

/** Validación de autoría en cliente (ayuda; la autoridad es E4 en la API). */
export function validateDraft(m: EditorMap): string[] {
  const errs: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(m.mapId)) errs.push("id de mapa: minúsculas, dígitos y guiones (2-63)");
  const inside = (p: Vec2, id: string) => {
    if (p.x < 0 || p.y < 0 || p.x > m.widthM || p.y > m.heightM) errs.push(`"${id}" está fuera de los límites`);
  };
  m.layers.spawns.forEach((s) => inside(s.position, s.objectId));
  m.layers.walls.forEach((w, i) => inside(w.position, `muro ${i + 1}`));
  if (m.layers.spawns.length === 0) errs.push("el mapa no tiene ningún spawn");
  if (m.meta.supportedModes.length === 0) errs.push("marca al menos un modo soportado");
  return errs;
}

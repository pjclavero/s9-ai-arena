/**
 * Importador de Tiled (E4/T4.1): traduce el JSON EXPORTADO por Tiled
 * (doc.mapeditor.org, "JSON Map Format") al formato interno de mapa de E1
 * (packages/map-schema/map.schema.json).
 *
 * Consumimos el export JSON de Tiled, NO el .tmx (XML). Es una decisión deliberada:
 * el JSON ya viene con los objetos resueltos (posiciones absolutas, propiedades
 * tipadas) y evita arrastrar un parser de XML. La CLI documenta que espera `.json`.
 *
 * CONVENCIÓN DE COORDENADAS (la parte no obvia, ver docs/mapas/formato-tmx.md):
 * Tiled trabaja en PÍXELES, con el origen ARRIBA-IZQUIERDA y el eje Y hacia ABAJO.
 * El formato interno trabaja en METROS, con Y hacia ARRIBA (ADR-000 D1: 1 unidad = 1 m).
 * Por eso, para cada punto:
 *     x_m = x_px * metrosPorPixel
 *     y_m = altoM - y_px * metrosPorPixel      (VOLTEO del eje Y)
 * La escala se declara como propiedad personalizada del MAPA en Tiled: `pixelsPerMeter`
 * (px/m). Elegimos px/m —en vez de m/px— porque el visor (E8) usa PIXELS_PER_METER=10,
 * así que el mismo número describe ambos lados del pipeline. `opts.pixelsPerMeter`
 * puede forzarla si el mapa no la trae.
 *
 * FILOSOFÍA DE ERRORES (DoD de T4.1):
 *  - Falta una capa OBLIGATORIA (ground, spawns) -> se LANZA un Error que NOMBRA la capa.
 *  - Propiedad personalizada DESCONOCIDA (o reconocida pero sin destino en el esquema)
 *    -> se acumula un WARNING en la lista devuelta. Nunca excepción, nunca fallo silencioso.
 */
import { withChecksum } from "./canonical.js";
import type {
  BaseShape,
  ChassisSize,
  DestructibleShape,
  Flag,
  GameModeId,
  InternalMap,
  Material,
  Shape,
  ShapeKind,
  Spawn,
  Vec2,
  ZoneShape,
  ZoneType,
} from "./types.js";

// ---------------------------------------------------------------- Tipos de Tiled
// Subconjunto del "JSON Map Format" de Tiled que este importador entiende. No es el
// esquema completo de Tiled: solo lo que necesitamos para el MVP.

/** Propiedad personalizada de Tiled: `{name, type, value}`. */
export interface TiledProperty {
  name: string;
  type?: string;
  value: unknown;
}

export interface TiledObject {
  id?: number;
  name?: string;
  /** `type` (Tiled <=1.8) o `class` (Tiled >=1.9): clase del objeto. */
  type?: string;
  class?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  point?: boolean;
  ellipse?: boolean;
  polygon?: Vec2[];
  properties?: TiledProperty[];
}

export interface TiledLayer {
  type: "tilelayer" | "objectgroup" | "imagelayer" | "group";
  name: string;
  data?: number[];
  objects?: TiledObject[];
  properties?: TiledProperty[];
}

export interface TiledTileset {
  firstgid: number;
  name?: string;
}

export interface TiledMap {
  width: number; // en tiles
  height: number; // en tiles
  tilewidth: number; // px por tile
  tileheight: number; // px por tile
  layers: TiledLayer[];
  tilesets?: TiledTileset[];
  properties?: TiledProperty[];
}

export interface ImportOptions {
  /** Fuerza la escala px/m si el mapa de Tiled no la declara como propiedad. */
  pixelsPerMeter?: number;
}

export interface ImportResult {
  map: InternalMap;
  warnings: string[];
}

// ---------------------------------------------------------------- Materiales base
/**
 * Conjunto FIJO de materiales base, espejo del ejemplo de E1
 * (packages/module-catalog/examples/map-mvp-arena-01.json). El índice en este array
 * es el valor que guarda `ground.data`; el `id` es lo que referencian los
 * destructibles por su propiedad `material`. Mantenerlo fijo hace el importador
 * determinista sin depender de que el mapa de Tiled traiga un tileset con metadatos.
 */
const BASE_MATERIALS: readonly Material[] = [
  { id: "floor", name: "Suelo", blocksMovement: false, blocksVision: false },
  { id: "concrete", name: "Muro de hormigón", blocksMovement: true, blocksVision: true },
  { id: "crate", name: "Caja destructible", blocksMovement: true, blocksVision: true, hp: 120 },
  { id: "acid", name: "Zona corrosiva", blocksMovement: false, blocksVision: false, damagePerSecond: 8 },
] as const;

// Nombres de object group de Tiled que sabemos mapear a capas del formato interno.
const KNOWN_OBJECT_GROUPS = new Set([
  "walls",
  "destructibles",
  "zones",
  "spawns",
  "bases",
  "flags",
]);

// ---------------------------------------------------------------- Utilidades de props
/** Convierte el array `properties[]` de Tiled en un mapa nombre -> valor. */
function propsToMap(props: TiledProperty[] | undefined): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const p of props ?? []) m.set(p.name, p.value);
  return m;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Empuja un warning por cada propiedad presente cuyo nombre NO esté en `recognized`.
 * Así ninguna propiedad se pierde en silencio: o la usamos, o queda constancia.
 */
function warnUnknownProps(
  props: Map<string, unknown>,
  recognized: Set<string>,
  context: string,
  warnings: string[],
): void {
  for (const key of props.keys()) {
    if (!recognized.has(key)) {
      warnings.push(`Propiedad personalizada desconocida '${key}' en ${context}: se ignora.`);
    }
  }
}

// ---------------------------------------------------------------- Conversión geométrica
/** Constructor de convertidores px(Y abajo) -> m(Y arriba) para un mapa de alto `heightM`. */
function makeGeometry(mpp: number, heightM: number) {
  const toMeters = (xPx: number, yPx: number): Vec2 => ({
    x: round(xPx * mpp),
    y: round(heightM - yPx * mpp),
  });
  return { toMeters };
}

/**
 * Redondeo suave a 6 decimales. La conversión px->m multiplica por `mpp`, que puede
 * introducir colas binarias (p. ej. 440*0.1 = 44.00000000000001). Redondear a 1e-6
 * las elimina de forma determinista sin perder precisión útil (1e-6 m = 1 micrómetro).
 * Es puramente aritmético: no usa `Intl` ni locale, así que no afecta al checksum canónico.
 */
function round(n: number): number {
  const r = Math.round(n * 1e6) / 1e6;
  // Evita el "-0" que ensuciaría el JSON canónico.
  return Object.is(r, -0) ? 0 : r;
}

/** Rotación de Tiled (grados, horaria, Y abajo) -> radianes antihorarios (D1). */
function convertRotation(deg: number | undefined): number | undefined {
  if (!deg) return undefined; // undefined o 0 -> no emitimos el campo
  // Voltear Y invierte el sentido de giro: horario-en-pantalla == antihorario-en-mundo.
  return round((-deg * Math.PI) / 180);
}

/**
 * Traduce un objeto de Tiled a una `Shape` del formato interno (rect / circle / polygon).
 * NOTA: en Tiled (x,y) de un rect/elipse es la esquina SUPERIOR-IZQUIERDA; el formato
 * interno guarda el CENTRO. Convertimos a centro y volteamos Y.
 */
function toShape(
  obj: TiledObject,
  mpp: number,
  heightM: number,
  warnings: string[],
  context: string,
): Shape {
  const { toMeters } = makeGeometry(mpp, heightM);

  if (obj.polygon && obj.polygon.length >= 3) {
    // Los puntos del polígono son relativos al origen (x,y) del objeto.
    const points = obj.polygon.map((p) => toMeters(obj.x + p.x, obj.y + p.y));
    const shape: Shape = { shape: "polygon" as ShapeKind, points };
    const rot = convertRotation(obj.rotation);
    if (rot !== undefined) shape.rotation = rot;
    return shape;
  }

  const w = obj.width ?? 0;
  const h = obj.height ?? 0;

  if (obj.ellipse) {
    if (Math.abs(w - h) > 1e-9) {
      warnings.push(
        `Elipse no circular en ${context} (${w}x${h}px): se aproxima con radio = ancho/2.`,
      );
    }
    const center = toMeters(obj.x + w / 2, obj.y + h / 2);
    return { shape: "circle" as ShapeKind, position: center, radiusM: round((w / 2) * mpp) };
  }

  // Rectángulo (caso por defecto). El punto (x,y) es la esquina superior-izquierda.
  const center = toMeters(obj.x + w / 2, obj.y + h / 2);
  const shape: Shape = {
    shape: "rect" as ShapeKind,
    position: center,
    widthM: round(w * mpp),
    heightM: round(h * mpp),
  };
  const rot = convertRotation(obj.rotation);
  if (rot !== undefined) shape.rotation = rot;
  return shape;
}

/** Punto representativo de un objeto (para spawns y flags): su centro, con Y volteada. */
function toPoint(obj: TiledObject, mpp: number, heightM: number): Vec2 {
  const { toMeters } = makeGeometry(mpp, heightM);
  const w = obj.width ?? 0;
  const h = obj.height ?? 0;
  // Un objeto `point` de Tiled no tiene tamaño: (x,y) ES el punto. Un rect usa su centro.
  return obj.point ? toMeters(obj.x, obj.y) : toMeters(obj.x + w / 2, obj.y + h / 2);
}

/** objectId estable a partir del nombre del objeto; si falta, se deriva del id de Tiled. */
function objectId(obj: TiledObject, fallbackPrefix: string): string {
  const name = (obj.name ?? "").trim();
  if (name && /^[a-z0-9_\-]{1,32}$/.test(name)) return name;
  return `${fallbackPrefix}_${obj.id ?? 0}`;
}

/** Lee la propiedad `team` (obligatoria en spawns/bases/flags) con aviso si falta. */
function readTeam(
  props: Map<string, unknown>,
  context: string,
  warnings: string[],
): string {
  const team = asString(props.get("team"));
  if (!team) {
    warnings.push(`Objeto en ${context} sin propiedad 'team': se asigna 'neutral'.`);
    return "neutral";
  }
  return team;
}

// ---------------------------------------------------------------- Importador principal
export function importTiled(tiled: TiledMap, opts: ImportOptions = {}): ImportResult {
  const warnings: string[] = [];

  // --- Escala px/m: de la propiedad `pixelsPerMeter` del mapa o de las opciones.
  const mapProps = propsToMap(tiled.properties);
  const ppm = asNumber(mapProps.get("pixelsPerMeter")) ?? opts.pixelsPerMeter;
  if (ppm === undefined || ppm <= 0) {
    throw new Error(
      "Escala ausente: declara la propiedad de mapa 'pixelsPerMeter' (px/m) en Tiled " +
        "o pásala en opts.pixelsPerMeter.",
    );
  }
  const mpp = 1 / ppm; // metros por píxel

  // --- Dimensiones del mundo en metros (tiles * px/tile * m/px).
  const widthM = round(tiled.width * tiled.tilewidth * mpp);
  const heightM = round(tiled.height * tiled.tileheight * mpp);

  // --- Localiza capas. La primera tilelayer es `ground`; el resto son object groups.
  const tileLayers = tiled.layers.filter((l) => l.type === "tilelayer");
  const objectGroups = tiled.layers.filter((l) => l.type === "objectgroup");

  // ===== ground (OBLIGATORIA) =====
  if (tileLayers.length === 0) {
    throw new Error("Falta la capa obligatoria 'ground': el mapa de Tiled no tiene ninguna tilelayer.");
  }
  if (tileLayers.length > 1) {
    warnings.push(
      `Hay ${tileLayers.length} tilelayers; solo la primera ('${tileLayers[0].name}') se usa como 'ground'.`,
    );
  }
  const groundLayer = tileLayers[0];
  const firstgid = tiled.tilesets?.[0]?.firstgid ?? 1;
  const materials = BASE_MATERIALS.map((m) => ({ ...m })); // copia mutable
  const ground = buildGround(groundLayer, tiled, firstgid, materials.length, warnings);

  // ===== object groups =====
  const walls: Shape[] = [];
  const destructibles: DestructibleShape[] = [];
  const zones: ZoneShape[] = [];
  const spawns: Spawn[] = [];
  const bases: BaseShape[] = [];
  const flags: Flag[] = [];

  for (const group of objectGroups) {
    const kind = group.name;
    if (!KNOWN_OBJECT_GROUPS.has(kind)) {
      warnings.push(`Object group '${kind}' no reconocido: se ignora (capas válidas: ${[...KNOWN_OBJECT_GROUPS].join(", ")}).`);
      continue;
    }
    for (const obj of group.objects ?? []) {
      const props = propsToMap(obj.properties);
      const ctx = `capa '${kind}'`;
      switch (kind) {
        case "walls": {
          warnUnknownProps(props, new Set(), ctx, warnings);
          walls.push(toShape(obj, mpp, heightM, warnings, ctx));
          break;
        }
        case "destructibles": {
          warnUnknownProps(props, new Set(["material", "hp"]), ctx, warnings);
          const material = asString(props.get("material")) ?? "crate";
          if (!materials.some((m) => m.id === material)) {
            warnings.push(`Destructible con material '${material}' inexistente en la tabla de materiales base.`);
          }
          // hp es un atributo del MATERIAL, no de la forma: si el objeto lo trae y no
          // coincide con el hp del material, dejamos constancia (no lo reescribimos).
          const hp = asNumber(props.get("hp"));
          const mat = materials.find((m) => m.id === material);
          if (hp !== undefined && mat && mat.hp !== undefined && mat.hp !== hp) {
            warnings.push(`Destructible '${objectId(obj, "crate")}' declara hp=${hp} pero el material '${material}' tiene hp=${mat.hp}: se usa el del material.`);
          }
          const shape = toShape(obj, mpp, heightM, warnings, ctx);
          destructibles.push({ ...shape, objectId: objectId(obj, "crate"), material });
          break;
        }
        case "zones": {
          warnUnknownProps(props, new Set(["zoneType", "team", "damagePerSecond", "captureTimeTicks"]), ctx, warnings);
          const zoneType = (asString(props.get("zoneType")) ?? "damage") as ZoneType;
          const shape = toShape(obj, mpp, heightM, warnings, ctx);
          const zone: ZoneShape = { ...shape, objectId: objectId(obj, "zone"), zoneType };
          const team = asString(props.get("team"));
          const dps = asNumber(props.get("damagePerSecond"));
          const ticks = asNumber(props.get("captureTimeTicks"));
          if (team !== undefined) zone.team = team;
          if (dps !== undefined) zone.damagePerSecond = dps;
          if (ticks !== undefined) zone.captureTimeTicks = ticks;
          zones.push(zone);
          break;
        }
        case "spawns": {
          warnUnknownProps(props, new Set(["team", "heading", "maxChassisSize"]), ctx, warnings);
          const spawn: Spawn = {
            objectId: objectId(obj, "spawn"),
            team: readTeam(props, ctx, warnings),
            position: toPoint(obj, mpp, heightM),
            heading: asNumber(props.get("heading")) ?? 0,
          };
          const maxChassis = asString(props.get("maxChassisSize")) as ChassisSize | undefined;
          if (maxChassis) spawn.maxChassisSize = maxChassis;
          spawns.push(spawn);
          break;
        }
        case "bases": {
          warnUnknownProps(props, new Set(["team"]), ctx, warnings);
          const shape = toShape(obj, mpp, heightM, warnings, ctx);
          bases.push({ ...shape, objectId: objectId(obj, "base"), team: readTeam(props, ctx, warnings) });
          break;
        }
        case "flags": {
          warnUnknownProps(props, new Set(["team"]), ctx, warnings);
          flags.push({
            objectId: objectId(obj, "flag"),
            team: readTeam(props, ctx, warnings),
            position: toPoint(obj, mpp, heightM),
          });
          break;
        }
      }
    }
  }

  // ===== spawns (OBLIGATORIA) =====
  if (spawns.length === 0) {
    throw new Error("Falta la capa obligatoria 'spawns': ningún object group 'spawns' con objetos. Un mapa sin spawns no es jugable.");
  }

  // --- Metadatos del mapa desde propiedades personalizadas del mapa.
  const RECOGNIZED_MAP_PROPS = new Set([
    "pixelsPerMeter",
    "mapId",
    "version",
    "name",
    "author",
    "license",
    "supportedModes",
    "supportedChassisSizes",
    "navCellSizeM",
    "maxDestructibles",
    "destructiblesMayBlockOnlyRoute",
  ]);
  warnUnknownProps(mapProps, RECOGNIZED_MAP_PROPS, "propiedades del mapa", warnings);

  const mapId = asString(mapProps.get("mapId")) ?? "tiled-map";
  const version = asNumber(mapProps.get("version")) ?? 1;
  const navCellSizeM = asNumber(mapProps.get("navCellSizeM"));

  // supportedModes / supportedChassisSizes vienen como CSV en una propiedad string de Tiled.
  const supportedModes = parseCsv(mapProps.get("supportedModes")) as GameModeId[];
  const supportedChassisSizes = parseCsv(mapProps.get("supportedChassisSizes")) as ChassisSize[];

  const map: Omit<InternalMap, "checksum"> = {
    schemaVersion: 1,
    mapId,
    version,
    widthM,
    heightM,
    ...(navCellSizeM !== undefined ? { navCellSizeM } : {}),
    materials,
    layers: {
      ground,
      walls,
      ...(destructibles.length ? { destructibles } : {}),
      ...(zones.length ? { zones } : {}),
      spawns,
      ...(bases.length ? { bases } : {}),
      ...(flags.length ? { flags } : {}),
    },
    meta: {
      ...(asString(mapProps.get("name")) ? { name: asString(mapProps.get("name")) } : {}),
      author: asString(mapProps.get("author")) ?? "desconocido",
      license: asString(mapProps.get("license")) ?? "CC-BY-4.0",
      supportedModes: supportedModes.length ? supportedModes : ["deathmatch"],
      ...(supportedChassisSizes.length ? { supportedChassisSizes } : {}),
      ...(asNumber(mapProps.get("maxDestructibles")) !== undefined
        ? { maxDestructibles: asNumber(mapProps.get("maxDestructibles")) }
        : {}),
      ...(asBool(mapProps.get("destructiblesMayBlockOnlyRoute")) !== undefined
        ? { destructiblesMayBlockOnlyRoute: asBool(mapProps.get("destructiblesMayBlockOnlyRoute")) }
        : {}),
    },
  };

  return { map: withChecksum(map), warnings };
}

// ---------------------------------------------------------------- ground
/**
 * Construye la capa `ground` a partir de la tilelayer de Tiled. Los GIDs de Tiled son
 * 1-based (0 = celda vacía). Los mapeamos a índices de material con `gid - firstgid`,
 * de modo que el tile n-ésimo del tileset corresponde al material n-ésimo de la tabla.
 * Un GID 0 (vacío) se interpreta como `floor` (índice 0).
 */
function buildGround(
  layer: TiledLayer,
  tiled: TiledMap,
  firstgid: number,
  materialCount: number,
  warnings: string[],
) {
  const cols = tiled.width;
  const rows = tiled.height;
  const raw = layer.data ?? [];
  if (raw.length !== cols * rows) {
    warnings.push(`ground.data tiene ${raw.length} celdas pero se esperaban ${cols * rows} (${cols}x${rows}).`);
  }
  let outOfRange = 0;
  const data = raw.map((gid) => {
    if (gid === 0) return 0; // celda vacía -> floor
    // Tiled empaqueta bits de volteo en los 3 bits altos del GID; los descartamos.
    const clean = gid & 0x1fffffff;
    let idx = clean - firstgid;
    if (idx < 0 || idx >= materialCount) {
      outOfRange++;
      idx = 0;
    }
    return idx;
  });
  if (outOfRange > 0) {
    warnings.push(`${outOfRange} tiles con GID fuera del rango de materiales: se mapean a 'floor' (0).`);
  }
  // tileSizeM: el tile de Tiled es cuadrado en el MVP; usamos su ancho en metros.
  return { tileSizeM: tileSizeMeters(tiled), cols, rows, data };
}

/** Tamaño de tile en metros = px por tile / (px por metro). */
function tileSizeMeters(tiled: TiledMap): number {
  const mapProps = propsToMap(tiled.properties);
  const ppm = asNumber(mapProps.get("pixelsPerMeter"));
  // Si no hubiera ppm ya habríamos lanzado antes; aquí siempre existe.
  return round(tiled.tilewidth / (ppm as number));
}

// ---------------------------------------------------------------- helpers varios
/** Divide una propiedad CSV ("a,b,c") en un array de strings recortados y no vacíos. */
function parseCsv(v: unknown): string[] {
  const s = asString(v);
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

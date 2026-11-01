/**
 * UX-EDITOR · Geometría PURA de los objetos del editor: enumerar, dibujar (caja
 * delimitadora), acertar con el puntero, mover, redimensionar con tiradores,
 * duplicar, borrar, crear desde la paleta y guías de alineación.
 *
 * Trabaja sobre el formato interno tal cual (metros, `position` = centro). Las
 * formas pueden ser rect, circle o polygon (el esquema admite las tres en cualquier
 * capa); el editor dibuja y mueve las tres, y redimensiona rect y circle.
 *
 * La rotación NO se edita: aunque la física del motor gira los muros, el visor de
 * batallas y la ruta de replays la descartan (replays.ts `box()`, `drawStatic`), así
 * que un giro hecho aquí no se vería al jugar. Si un mapa importado ya trae giro, se
 * conserva intacto al mover y se dibuja girado, pero no se ofrecen tiradores.
 */
import { aabb, pointInShape } from "../../../map-service/src/validate/shapes.js";
import type { Shape } from "../../../map-service/src/types.js";
import type { EditorMap, ObjKind, ObjRef, Vec2 } from "./model.js";

export type AnyObj = Record<string, unknown> & {
  shape?: "rect" | "circle" | "polygon";
  position?: Vec2;
  widthM?: number;
  heightM?: number;
  radiusM?: number;
  rotation?: number;
  points?: Vec2[];
  objectId?: string;
  team?: string;
  zoneType?: string;
  damagePerSecond?: number;
  heading?: number;
};

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Radios de dibujo/acierto de los objetos que son un punto (no tienen tamaño en el mapa). */
export const SPAWN_RADIUS_M = 1.6;
export const FLAG_RADIUS_M = 1.2;
/** Tamaño mínimo de un rectángulo o radio al redimensionar (el esquema exige > 0). */
export const MIN_SIZE_M = 0.5;

export const LAYER_KEY: Record<ObjKind, string> = {
  wall: "walls",
  destructible: "destructibles",
  spawn: "spawns",
  base: "bases",
  flag: "flags",
  zone: "zones",
};

/** Orden de dibujo (de abajo arriba). El acierto recorre al revés: gana lo de encima. */
export const DRAW_ORDER: ObjKind[] = ["zone", "base", "wall", "destructible", "flag", "spawn"];

export function isPointKind(kind: ObjKind): boolean {
  return kind === "spawn" || kind === "flag";
}

export function refKey(r: ObjRef): string {
  return `${r.kind}:${r.index}`;
}

export function layerOf(map: EditorMap, kind: ObjKind): AnyObj[] {
  const v = map.layers[LAYER_KEY[kind]];
  return Array.isArray(v) ? (v as AnyObj[]) : [];
}

export function getObj(map: EditorMap, ref: ObjRef | null | undefined): AnyObj | undefined {
  if (!ref) return undefined;
  return layerOf(map, ref.kind)[ref.index];
}

export function allRefs(map: EditorMap): ObjRef[] {
  return DRAW_ORDER.flatMap((kind) => layerOf(map, kind).map((_, index) => ({ kind, index })));
}

function withLayer(map: EditorMap, kind: ObjKind, arr: AnyObj[]): EditorMap {
  return { ...map, layers: { ...map.layers, [LAYER_KEY[kind]]: arr } };
}

export function replaceObj(map: EditorMap, ref: ObjRef, obj: AnyObj): EditorMap {
  const arr = [...layerOf(map, ref.kind)];
  if (ref.index < 0 || ref.index >= arr.length) return map;
  arr[ref.index] = obj;
  return withLayer(map, ref.kind, arr);
}

export function patchObj(map: EditorMap, ref: ObjRef, patch: Partial<AnyObj>): EditorMap {
  const o = getObj(map, ref);
  return o ? replaceObj(map, ref, { ...o, ...patch }) : map;
}

/** Forma geométrica de un objeto (los puntos se tratan como círculos pequeños). */
export function shapeOf(kind: ObjKind, o: AnyObj): Shape {
  if (kind === "spawn") return { shape: "circle", position: o.position, radiusM: SPAWN_RADIUS_M };
  if (kind === "flag") return { shape: "circle", position: o.position, radiusM: FLAG_RADIUS_M };
  return o as unknown as Shape;
}

export function centerOf(o: AnyObj): Vec2 {
  if (o.position) return o.position;
  const b = aabb(o as unknown as Shape);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

export function boundsOf(kind: ObjKind, o: AnyObj): Box {
  return aabb(shapeOf(kind, o));
}

export function isRotated(o: AnyObj): boolean {
  return typeof o.rotation === "number" && Math.abs(o.rotation) > 1e-9;
}

/** ¿Se puede redimensionar con tiradores? rect sin giro y círculos de tamaño propio. */
export function resizable(kind: ObjKind, o: AnyObj | undefined): "rect" | "circle" | null {
  if (!o || isPointKind(kind)) return null;
  if (o.shape === "rect" && !isRotated(o)) return "rect";
  if (o.shape === "circle") return "circle";
  return null;
}

/** Objeto de encima bajo un punto del mundo, con tolerancia (en metros). */
export function hitTest(map: EditorMap, p: Vec2, tolM = 0): ObjRef | null {
  for (let k = DRAW_ORDER.length - 1; k >= 0; k--) {
    const kind = DRAW_ORDER[k];
    const arr = layerOf(map, kind);
    for (let index = arr.length - 1; index >= 0; index--) {
      const s = shapeOf(kind, arr[index]);
      const grown =
        s.shape === "circle"
          ? { ...s, radiusM: (s.radiusM ?? 0) + tolM }
          : s.shape === "rect"
            ? { ...s, widthM: (s.widthM ?? 0) + 2 * tolM, heightM: (s.heightM ?? 0) + 2 * tolM }
            : s;
      if (pointInShape(p, grown as Shape)) return { kind, index };
    }
  }
  return null;
}

export function snapValue(v: number, step: number): number {
  if (!(step > 0)) return v;
  return Math.round(v / step) * step;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Traslada un objeto (posición y, si es polígono, sus vértices). */
export function translateObj(o: AnyObj, dx: number, dy: number): AnyObj {
  const out: AnyObj = { ...o };
  if (o.position) out.position = { x: round3(o.position.x + dx), y: round3(o.position.y + dy) };
  if (Array.isArray(o.points)) out.points = o.points.map((q) => ({ x: round3(q.x + dx), y: round3(q.y + dy) }));
  return out;
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const RECT_HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Posición de un tirador en el mundo para un objeto redimensionable. */
export function handlePosition(kind: ObjKind, o: AnyObj, h: Handle): Vec2 {
  const b = boundsOf(kind, o);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const x = h.includes("w") ? b.minX : h.includes("e") ? b.maxX : cx;
  const y = h.includes("n") ? b.minY : h.includes("s") ? b.maxY : cy;
  return { x, y };
}

/**
 * Redimensiona desde un tirador: el borde (o esquina) arrastrado sigue al puntero y
 * el opuesto queda fijo. Con `snap` > 0 el borde móvil cae en la rejilla. Nunca baja
 * de MIN_SIZE_M. Para círculos, el radio es la distancia al centro.
 */
export function resizeWithHandle(o: AnyObj, h: Handle, p: Vec2, snap = 0): AnyObj {
  const sp = { x: snap > 0 ? snapValue(p.x, snap) : p.x, y: snap > 0 ? snapValue(p.y, snap) : p.y };
  if (o.shape === "circle") {
    const c = o.position ?? { x: 0, y: 0 };
    let r = Math.hypot(sp.x - c.x, sp.y - c.y);
    if (h === "e" || h === "w") r = Math.abs(sp.x - c.x);
    if (h === "n" || h === "s") r = Math.abs(sp.y - c.y);
    return { ...o, radiusM: round3(Math.max(MIN_SIZE_M, r)) };
  }
  const c = o.position ?? { x: 0, y: 0 };
  const hw = (o.widthM ?? 0) / 2;
  const hh = (o.heightM ?? 0) / 2;
  let minX = c.x - hw,
    maxX = c.x + hw,
    minY = c.y - hh,
    maxY = c.y + hh;
  if (h.includes("w")) minX = Math.min(sp.x, maxX - MIN_SIZE_M);
  if (h.includes("e")) maxX = Math.max(sp.x, minX + MIN_SIZE_M);
  if (h.includes("n")) minY = Math.min(sp.y, maxY - MIN_SIZE_M);
  if (h.includes("s")) maxY = Math.max(sp.y, minY + MIN_SIZE_M);
  return {
    ...o,
    position: { x: round3((minX + maxX) / 2), y: round3((minY + maxY) / 2) },
    widthM: round3(maxX - minX),
    heightM: round3(maxY - minY),
  };
}

/** Todos los objectId del mapa, para generar uno nuevo sin colisión. */
function usedIds(map: EditorMap): Set<string> {
  const ids = new Set<string>();
  for (const kind of DRAW_ORDER)
    for (const o of layerOf(map, kind)) if (typeof o.objectId === "string") ids.add(o.objectId);
  return ids;
}

/** objectId nuevo y válido para el esquema (^[a-z0-9_-]{1,32}$). */
export function freshId(map: EditorMap, prefix: string): string {
  const base =
    prefix
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .slice(0, 24) || "obj";
  const ids = usedIds(map);
  for (let n = 1; ; n++) {
    const id = `${base}_${n}`;
    if (!ids.has(id)) return id;
  }
}

function idPrefix(kind: ObjKind, o: AnyObj): string {
  const team = typeof o.team === "string" ? `_${o.team}` : "";
  if (kind === "spawn") return `spawn${team}`;
  if (kind === "base") return `base${team}`;
  if (kind === "flag") return `flag${team}`;
  if (kind === "zone") return `zone_${o.zoneType ?? "x"}`;
  if (kind === "destructible") return "crate";
  return "wall";
}

/** Inserta una copia del objeto (id nuevo) desplazada `dx,dy`. Devuelve el mapa y su ref. */
export function insertCopy(
  map: EditorMap,
  kind: ObjKind,
  obj: AnyObj,
  dx: number,
  dy: number,
): { map: EditorMap; ref: ObjRef } {
  const copy = translateObj(structuredCloneSafe(obj), dx, dy);
  if (typeof obj.objectId === "string" || kind !== "wall") copy.objectId = freshId(map, idPrefix(kind, obj));
  const arr = [...layerOf(map, kind), copy];
  return { map: withLayer(map, kind, arr), ref: { kind, index: arr.length - 1 } };
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function duplicateObj(map: EditorMap, ref: ObjRef, offsetM = 2): { map: EditorMap; ref: ObjRef } | null {
  const o = getObj(map, ref);
  if (!o) return null;
  return insertCopy(map, ref.kind, o, offsetM, offsetM);
}

export function removeObj(map: EditorMap, ref: ObjRef): EditorMap {
  const arr = layerOf(map, ref.kind).filter((_, i) => i !== ref.index);
  return withLayer(map, ref.kind, arr);
}

/** Herramientas de la paleta (lo que el esquema y el motor soportan). */
export type Tool =
  | "wall"
  | "crate"
  | "damage-zone"
  | "capture-zone"
  | "spawn-red"
  | "spawn-blue"
  | "base-red"
  | "base-blue"
  | "flag-red"
  | "flag-blue";

export interface ToolInfo {
  tool: Tool;
  label: string;
  help: string;
  kind: ObjKind;
  team?: string;
}

export const TOOLS: ToolInfo[] = [
  { tool: "wall", label: "Muro", kind: "wall", help: "Obstáculo fijo: bloquea el paso y la visión." },
  { tool: "crate", label: "Caja", kind: "destructible", help: "Obstáculo destructible: se rompe a disparos." },
  {
    tool: "damage-zone",
    label: "Zona de daño",
    kind: "zone",
    help: "Círculo que quita vida cada segundo a quien esté dentro.",
  },
  {
    tool: "capture-zone",
    label: "Zona de captura",
    kind: "zone",
    help: "Círculo que hay que ocupar en el modo Control de zona.",
  },
  {
    tool: "spawn-red",
    label: "Punto de aparición rojo",
    kind: "spawn",
    team: "red",
    help: "Donde aparece un vehículo del equipo rojo.",
  },
  {
    tool: "spawn-blue",
    label: "Punto de aparición azul",
    kind: "spawn",
    team: "blue",
    help: "Donde aparece un vehículo del equipo azul.",
  },
  {
    tool: "base-red",
    label: "Base roja",
    kind: "base",
    team: "red",
    help: "Base del equipo rojo (Captura la bandera).",
  },
  {
    tool: "base-blue",
    label: "Base azul",
    kind: "base",
    team: "blue",
    help: "Base del equipo azul (Captura la bandera).",
  },
  { tool: "flag-red", label: "Bandera roja", kind: "flag", team: "red", help: "Bandera del equipo rojo." },
  { tool: "flag-blue", label: "Bandera azul", kind: "flag", team: "blue", help: "Bandera del equipo azul." },
];

export function toolInfo(tool: Tool): ToolInfo {
  return TOOLS.find((t) => t.tool === tool)!;
}

/** Crea el objeto de la herramienta centrado en `p` (ya ajustado a rejilla si procede). */
export function createAt(map: EditorMap, tool: Tool, p: Vec2): { map: EditorMap; ref: ObjRef } {
  const info = toolInfo(tool);
  const pos = { x: round3(p.x), y: round3(p.y) };
  const rect = (w: number, h: number) => ({ shape: "rect" as const, position: pos, widthM: w, heightM: h });
  let obj: AnyObj;
  switch (tool) {
    case "wall":
      obj = rect(4, 12);
      break;
    case "crate": {
      const mat = map.materials.find((m) => m.id === "crate") ?? map.materials.find((m) => m.hp !== undefined);
      obj = { ...rect(2, 2), material: mat?.id ?? "crate" };
      break;
    }
    case "damage-zone":
      obj = { shape: "circle", position: pos, radiusM: 6, zoneType: "damage", damagePerSecond: 8 };
      break;
    case "capture-zone":
      obj = { shape: "circle", position: pos, radiusM: 6, zoneType: "capture" };
      break;
    case "spawn-red":
    case "spawn-blue":
      // Mira hacia el centro del mapa: lo razonable para empezar.
      obj = {
        team: info.team,
        position: pos,
        heading: round3(Math.atan2(map.heightM / 2 - pos.y, map.widthM / 2 - pos.x)),
      };
      break;
    case "base-red":
    case "base-blue":
      obj = { ...rect(8, 8), team: info.team };
      break;
    case "flag-red":
    case "flag-blue":
      obj = { team: info.team, position: pos };
      break;
  }
  const withId: AnyObj = { ...obj, objectId: "" };
  if (info.kind === "wall") delete withId.objectId;
  else withId.objectId = freshId(map, idPrefix(info.kind, obj));
  // Si la caja usa un material que no existe, se añade el de serie (E4 lo exige).
  let next = map;
  if (tool === "crate" && !map.materials.some((m) => m.id === (withId.material as string))) {
    next = {
      ...map,
      materials: [
        ...map.materials,
        { id: "crate", name: "Caja destructible", blocksMovement: true, blocksVision: true, hp: 120 },
      ],
    };
  }
  const arr = [...layerOf(next, info.kind), withId];
  return { map: withLayer(next, info.kind, arr), ref: { kind: info.kind, index: arr.length - 1 } };
}

const TEAM_WORD: Record<string, [string, string]> = { red: ["rojo", "roja"], blue: ["azul", "azul"] };
export function teamWord(team: unknown, feminine = false): string {
  if (typeof team !== "string" || !team) return "sin equipo";
  const w = Object.prototype.hasOwnProperty.call(TEAM_WORD, team) ? TEAM_WORD[team] : undefined;
  return w ? w[feminine ? 1 : 0] : `equipo ${team}`;
}

export function kindName(kind: ObjKind, o?: AnyObj): string {
  switch (kind) {
    case "wall":
      return "Muro";
    case "destructible":
      return "Caja";
    case "spawn":
      return `Punto de aparición ${teamWord(o?.team)}`;
    case "base":
      return `Base ${teamWord(o?.team, true)}`;
    case "flag":
      return `Bandera ${teamWord(o?.team, true)}`;
    case "zone":
      return o?.zoneType === "damage"
        ? "Zona de daño"
        : o?.zoneType === "capture"
          ? "Zona de captura"
          : o?.zoneType === "no_entry"
            ? "Zona prohibida"
            : "Zona de cobertura";
  }
}

/** Nombre legible y estable: «Muro 2», «Punto de aparición rojo 1». Sin ids internos. */
export function objLabel(map: EditorMap, ref: ObjRef): string {
  const arr = layerOf(map, ref.kind);
  const o = arr[ref.index];
  const name = kindName(ref.kind, o);
  let n = 0;
  for (let i = 0; i <= ref.index && i < arr.length; i++) if (kindName(ref.kind, arr[i]) === name) n++;
  return `${name} ${n}`;
}

export interface Guides {
  x: number[];
  y: number[];
}

/**
 * Guías de alineación al mover: si un borde o el centro de la caja movida queda a
 * menos de `tolM` de un borde/centro de otro objeto (o del mapa), se ajusta a él y
 * se devuelve la línea guía. Devuelve el desplazamiento corrector.
 */
export function alignToOthers(
  map: EditorMap,
  moving: ObjRef,
  box: Box,
  tolM: number,
): { dx: number; dy: number; guides: Guides } {
  const xs: number[] = [0, map.widthM / 2, map.widthM];
  const ys: number[] = [0, map.heightM / 2, map.heightM];
  for (const r of allRefs(map)) {
    if (r.kind === moving.kind && r.index === moving.index) continue;
    const b = boundsOf(r.kind, layerOf(map, r.kind)[r.index]);
    xs.push(b.minX, (b.minX + b.maxX) / 2, b.maxX);
    ys.push(b.minY, (b.minY + b.maxY) / 2, b.maxY);
  }
  const best = (cands: number[], mine: number[]) => {
    let d = Infinity;
    let at = NaN;
    for (const m of mine)
      for (const c of cands) {
        const dd = c - m;
        if (Math.abs(dd) <= tolM && Math.abs(dd) < Math.abs(d)) {
          d = dd;
          at = c;
        }
      }
    return Number.isFinite(d) ? { d, at } : null;
  };
  const bx = best(xs, [box.minX, (box.minX + box.maxX) / 2, box.maxX]);
  const by = best(ys, [box.minY, (box.minY + box.maxY) / 2, box.maxY]);
  return { dx: bx?.d ?? 0, dy: by?.d ?? 0, guides: { x: bx ? [bx.at] : [], y: by ? [by.at] : [] } };
}

/** Radio con el que el MOTOR juega una base rectangular: el círculo inscrito (to-engine-map.ts). */
export function engineBaseRadius(o: AnyObj): number {
  if (o.shape === "circle") return o.radiusM ?? 0;
  if (o.shape === "rect") return Math.min(o.widthM ?? 0, o.heightM ?? 0) / 2;
  const b = aabb(o as unknown as Shape);
  return Math.min((b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2);
}

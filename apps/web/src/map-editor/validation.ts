/**
 * UX-EDITOR · Validación EN VIVO del editor, antes de guardar.
 *
 * Dos capas:
 *  1. `liveIssues`: avisos en lenguaje de usuario y ATADOS A OBJETOS (para
 *     resaltarlos en el lienzo): punto de aparición fuera del mapa o dentro de un
 *     muro, objetos fuera de los límites, bases inválidas, zonas superpuestas
 *     problemáticas, puntos de aparición insuficientes para cada modo y
 *     configuraciones imposibles (tamaños cero o no numéricos).
 *  2. `fullValidation`: el validador REAL del servidor (`validateMap` de
 *     apps/map-service, función pura importada sin modificarla). Corre en el
 *     navegador con el mismo código; aun así la autoridad sigue siendo la API al
 *     guardar y publicar.
 */
import { validateMap } from "../../../map-service/src/validate/index.js";
import type { Check } from "../../../map-service/src/validate/result.js";
import { pointInShape } from "../../../map-service/src/validate/shapes.js";
import type { InternalMap, Shape } from "../../../map-service/src/types.js";
import { modeName } from "../battle-result.js";
import type { EditorMap, ObjRef, Vec2 } from "./model.js";
import { boundsOf, engineBaseRadius, layerOf, objLabel, teamWord, type AnyObj } from "./objects.js";

export interface Issue {
  severity: "error" | "warning";
  code: string;
  message: string;
  refs: ObjRef[];
}

/** Radio mínimo de base que tiene sentido jugar (un vehículo mide ~1,5 m). */
export const MIN_BASE_RADIUS_M = 2;
/** Holgura alrededor de un punto de aparición: un vehículo pegado a un muro se atasca. */
export const SPAWN_CLEARANCE_M = 1.5;

const finitePos = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0;

function distPointToBox(p: Vec2, b: { minX: number; minY: number; maxX: number; maxY: number }): number {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  return Math.hypot(dx, dy);
}

export function liveIssues(map: EditorMap): Issue[] {
  const out: Issue[] = [];
  const add = (severity: Issue["severity"], code: string, message: string, refs: ObjRef[] = []) =>
    out.push({ severity, code, message, refs });

  // --- configuración imposible del propio mapa ------------------------------
  if (!finitePos(map.widthM) || !finitePos(map.heightM)) {
    add("error", "map-size", "La anchura y la altura del mapa tienen que ser números mayores que cero.");
    return out;
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(map.mapId))
    add(
      "error",
      "map-id",
      "El identificador del mapa sólo admite minúsculas, números y guiones (entre 2 y 63 caracteres).",
    );
  if (map.meta.supportedModes.length === 0) add("error", "no-modes", "Marca al menos un modo de juego.");

  const W = map.widthM;
  const H = map.heightM;
  const inside = (p: Vec2) => p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H;
  const solids: { ref: ObjRef; o: AnyObj }[] = [
    ...layerOf(map, "wall").map((o, index) => ({ ref: { kind: "wall" as const, index }, o })),
    ...layerOf(map, "destructible").map((o, index) => ({ ref: { kind: "destructible" as const, index }, o })),
  ];
  const zones = layerOf(map, "zone").map((o, index) => ({ ref: { kind: "zone" as const, index }, o }));
  const damageZones = zones.filter((z) => z.o.zoneType === "damage");

  // --- tamaños y límites de todo objeto con forma ---------------------------
  for (const kind of ["wall", "destructible", "zone", "base"] as const) {
    layerOf(map, kind).forEach((o, index) => {
      const ref = { kind, index };
      const label = objLabel(map, ref);
      const bad =
        (o.shape === "rect" && (!finitePos(o.widthM) || !finitePos(o.heightM))) ||
        (o.shape === "circle" && !finitePos(o.radiusM)) ||
        (o.shape === "polygon" && (!Array.isArray(o.points) || o.points.length < 3));
      if (bad) {
        add("error", "size", `${label} no tiene un tamaño válido (anchura, altura o radio mayor que cero).`, [ref]);
        return;
      }
      const b = boundsOf(kind, o);
      if (b.maxX < 0 || b.maxY < 0 || b.minX > W || b.minY > H)
        add("error", "out-of-bounds", `${label} está completamente fuera del mapa.`, [ref]);
      else if (b.minX < -1e-6 || b.minY < -1e-6 || b.maxX > W + 1e-6 || b.maxY > H + 1e-6)
        add("warning", "overflows", `${label} se sale por el borde del mapa (la parte de fuera no cuenta).`, [ref]);
    });
  }

  // --- puntos de aparición ---------------------------------------------------
  const spawns = layerOf(map, "spawn");
  spawns.forEach((s, index) => {
    const ref = { kind: "spawn" as const, index };
    const label = objLabel(map, ref);
    const p = s.position;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      add("error", "spawn-pos", `${label} no tiene una posición válida.`, [ref]);
      return;
    }
    if (!inside(p)) {
      add("error", "spawn-out", `${label} está fuera del mapa.`, [ref]);
      return;
    }
    const inSolid = solids.find((x) => pointInShape(p, x.o as unknown as Shape));
    if (inSolid) {
      add("error", "spawn-in-wall", `${label} está dentro de ${objLabel(map, inSolid.ref).toLowerCase()}.`, [
        ref,
        inSolid.ref,
      ]);
      return;
    }
    const near = solids.find((x) => distPointToBox(p, boundsOf(x.ref.kind, x.o)) < SPAWN_CLEARANCE_M);
    const edge = Math.min(p.x, p.y, W - p.x, H - p.y) < SPAWN_CLEARANCE_M;
    if (near || edge)
      add(
        "warning",
        "spawn-tight",
        `${label} está muy pegado a ${near ? objLabel(map, near.ref).toLowerCase() : "el borde"}: el vehículo puede quedarse atascado al aparecer.`,
        near ? [ref, near.ref] : [ref],
      );
    const dz = damageZones.find((z) => pointInShape(p, z.o as unknown as Shape));
    if (dz)
      add("warning", "spawn-in-damage", `${label} está dentro de ${objLabel(map, dz.ref).toLowerCase()}.`, [
        ref,
        dz.ref,
      ]);
  });

  // --- banderas ---------------------------------------------------------------
  layerOf(map, "flag").forEach((f, index) => {
    const ref = { kind: "flag" as const, index };
    const label = objLabel(map, ref);
    if (!f.position || !inside(f.position)) return add("error", "flag-out", `${label} está fuera del mapa.`, [ref]);
    const inSolid = solids.find((x) => pointInShape(f.position!, x.o as unknown as Shape));
    if (inSolid)
      add(
        "error",
        "flag-in-wall",
        `${label} está dentro de ${objLabel(map, inSolid.ref).toLowerCase()}: nadie podría cogerla.`,
        [ref, inSolid.ref],
      );
  });

  // --- bases ------------------------------------------------------------------
  const bases = layerOf(map, "base");
  const baseTeams = new Map<string, number>();
  bases.forEach((b, index) => {
    const ref = { kind: "base" as const, index };
    const label = objLabel(map, ref);
    if (typeof b.team !== "string" || !/^[a-z0-9_]{1,16}$/.test(b.team)) {
      add("error", "base-team", `${label} no tiene un equipo válido.`, [ref]);
      return;
    }
    baseTeams.set(b.team, (baseTeams.get(b.team) ?? 0) + 1);
    const r = engineBaseRadius(b);
    if (r < MIN_BASE_RADIUS_M)
      add(
        "warning",
        "base-small",
        `${label} es muy pequeña: en batalla cuenta como un círculo de ${r.toFixed(1)} m de radio.`,
        [ref],
      );
    if (b.position) {
      const inSolid = solids.find((x) => pointInShape(b.position!, x.o as unknown as Shape));
      if (inSolid)
        add(
          "error",
          "base-in-wall",
          `El centro de ${label.toLowerCase()} está dentro de ${objLabel(map, inSolid.ref).toLowerCase()}.`,
          [ref, inSolid.ref],
        );
    }
    if (!spawns.some((s) => s.team === b.team))
      add("warning", "base-no-spawn", `${label}: el equipo ${teamWord(b.team)} no tiene ningún punto de aparición.`, [
        ref,
      ]);
  });
  for (const [team, n] of baseTeams)
    if (n > 1)
      add(
        "warning",
        "base-dup",
        `El equipo ${teamWord(team)} tiene ${n} bases; normalmente cada equipo tiene una.`,
        bases
          .map((b, index) => ({ b, index }))
          .filter((x) => x.b.team === team)
          .map((x) => ({ kind: "base" as const, index: x.index })),
      );

  // --- zonas superpuestas problemáticas -------------------------------------
  const circle = (o: AnyObj) =>
    o.shape === "circle" && o.position && finitePos(o.radiusM) ? { c: o.position, r: o.radiusM! } : null;
  for (let i = 0; i < zones.length; i++)
    for (let j = i + 1; j < zones.length; j++) {
      const a = circle(zones[i].o);
      const b = circle(zones[j].o);
      if (!a || !b) continue;
      if (Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y) >= a.r + b.r) continue;
      const types = [zones[i].o.zoneType, zones[j].o.zoneType];
      if (types.includes("damage") && types.includes("capture"))
        add(
          "warning",
          "zone-overlap",
          `${objLabel(map, zones[i].ref)} y ${objLabel(map, zones[j].ref).toLowerCase()} se solapan: capturar obligaría a recibir daño.`,
          [zones[i].ref, zones[j].ref],
        );
      else if (types[0] === types[1])
        add(
          "warning",
          "zone-overlap",
          `${objLabel(map, zones[i].ref)} y ${objLabel(map, zones[j].ref).toLowerCase()} se solapan.`,
          [zones[i].ref, zones[j].ref],
        );
    }
  for (const z of damageZones) {
    bases.forEach((b, index) => {
      if (b.position && pointInShape(b.position, z.o as unknown as Shape))
        add(
          "warning",
          "base-in-damage",
          `${objLabel(map, { kind: "base", index })} está dentro de ${objLabel(map, z.ref).toLowerCase()}.`,
          [{ kind: "base", index }, z.ref],
        );
    });
  }

  // --- puntos de aparición suficientes para cada modo ------------------------
  const spawnTeams = new Set(spawns.map((s) => s.team));
  const flagTeams = new Set(layerOf(map, "flag").map((f) => f.team));
  for (const mode of map.meta.supportedModes) {
    const name = modeName(mode);
    if (mode === "deathmatch" && spawns.length < 2)
      add("error", "mode-spawns", `${name} necesita al menos 2 puntos de aparición (hay ${spawns.length}).`);
    if ((mode === "team_deathmatch" || mode === "capture_the_flag") && spawnTeams.size < 2)
      add(
        mode === "team_deathmatch" ? "error" : "warning",
        "mode-spawns",
        `${name} necesita puntos de aparición de los dos equipos (rojo y azul); ahora hay de ${spawnTeams.size}.`,
      );
    if (mode === "capture_the_flag") {
      const ready = [...flagTeams].filter((t) => baseTeams.has(t as string));
      if (ready.length < 2)
        add(
          "error",
          "mode-ctf",
          `${name} necesita una base y una bandera de cada equipo (ahora ${ready.length} de 2).`,
        );
    }
    if (mode === "zone_control" && !zones.some((z) => z.o.zoneType === "capture"))
      add("error", "mode-zone", `${name} necesita al menos una zona de captura.`);
  }
  return out;
}

/** Objetos señalados por algún aviso, con su peor gravedad (para pintarlos en el lienzo). */
export function issuesByObject(issues: Issue[]): Map<string, "error" | "warning"> {
  const m = new Map<string, "error" | "warning">();
  for (const i of issues)
    for (const r of i.refs) {
      const k = `${r.kind}:${r.index}`;
      if (i.severity === "error" || !m.has(k)) m.set(k, i.severity);
    }
  return m;
}

/** El validador real del servidor, en el navegador. Nunca lanza: un fallo es un hallazgo. */
export function fullValidation(map: EditorMap): Check[] {
  try {
    return validateMap(map as unknown as InternalMap).checks;
  } catch (e) {
    return [
      {
        check: "geometry",
        severity: "error",
        message: `el mapa no se puede comprobar: ${(e as Error).message}`,
      } as Check,
    ];
  }
}

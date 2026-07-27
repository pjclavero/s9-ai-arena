/**
 * B9 · Validación ESTRUCTURAL de un `ArenaMap` que llega DE FUERA del proceso.
 *
 * Hasta B9 el motor solo jugaba mapas-fixture ("empty"|"mvp"|"ctf", fixtures.ts):
 * la geometría venía de código propio, así que nadie tenía que validarla. B9
 * permite que la API envíe la geometría REAL de cualquier mapa publicado del
 * catálogo en el cuerpo de `POST /run`; a partir de ahí el mapa es ENTRADA
 * EXTERNA y se valida como tal, campo a campo, ANTES de llegar al motor.
 *
 * Por qué vive AQUÍ y no en apps/map-service (donde está el resto del pipeline
 * de mapas): la imagen de arena-engine (infrastructure/docker/arena-engine/
 * Dockerfile) copia SOLO `apps/arena-engine`, `apps/bot-manager`, `packages` y
 * `maps`. Un import a `apps/map-service` compilaría y pasaría los tests del
 * monorepo, y la imagen moriría con ERR_MODULE_NOT_FOUND en el primer arranque
 * ("funciona en el repo, falla en la imagen", lección del bloque de batallas
 * reales). La API sí puede importar este módulo: su imagen (node-service)
 * copia `apps` completo y ya importa `apps/arena-engine/src/replay.js`.
 *
 * Criterio: FALLA CERRADO. Cualquier campo con un tipo, un rango o una forma
 * que el motor no vaya a saber tratar hace que el mapa entero se rechace con
 * un motivo concreto — nunca se "arregla" un mapa a medias (rellenar un valor
 * por defecto sobre una geometría rota es jugar un mapa distinto al pedido,
 * exactamente lo que este bloque tiene prohibido).
 */
import type { ArenaMap } from "./sim/modes.js";

/** Tope de entidades geométricas (muros+destructibles+zonas+bases+banderas+spawns)
 *  de un mapa aceptado por el servicio. No es una regla de juego: es un límite de
 *  recursos (cada muro es un cuerpo rígido en el mundo de física). Los mapas reales
 *  del catálogo andan por debajo de 100. */
export const MAX_ARENA_MAP_ENTITIES = 4000;
/** Dimensión máxima admitida (m). Un mapa de 10 km de lado no es un mapa: es un
 *  intento de agotar memoria en el motor. */
export const MAX_ARENA_MAP_DIMENSION_M = 10_000;
/** Longitud máxima de identificadores de texto (mapId, ids de entidad, equipos). */
const MAX_ID_LENGTH = 128;

/**
 * Los campos "del otro caso" se declaran opcionales (`reason?: undefined` en el
 * caso bueno y viceversa) a propósito: el `tsconfig.json` del monorepo va con
 * `strict: false`, y sin `strictNullChecks` TypeScript NO estrecha uniones
 * discriminadas — `if (!v.ok) ... v.reason` no compilaría. Con esta forma, el
 * consumidor sigue leyendo el campo que le toca y el compilador no protesta.
 */
export type ArenaMapValidation =
  { ok: true; map: ArenaMap; reason?: undefined } | { ok: false; map?: undefined; reason: string };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown, maxLen = MAX_ID_LENGTH): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= maxLen;
}

/**
 * `true` si `name` NO es una propiedad heredada de `Object.prototype`
 * ("__proto__", "constructor", "toString", "hasOwnProperty"...). Misma clase de
 * fallo que cierra `safeLookup` (packages/game-rules/safe-lookup.ts): un
 * identificador que viene de fuera y termina usado como clave de un diccionario
 * (aquí o en cualquier consumidor futuro del mapa: cachés por mapId, índices de
 * entidades por id, agrupaciones por equipo) resolvería a algo truthy del
 * prototipo en vez de a `undefined`. Se rechaza en la frontera, una sola vez,
 * en lugar de confiar en que todos los consumidores usen `safeLookup`.
 */
export function isSafeExternalKey(name: string): boolean {
  return !Object.prototype.hasOwnProperty.call(Object.prototype, name);
}

function isVec2(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return isFiniteNumber(p.x) && isFiniteNumber(p.y);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function checkBox(e: Record<string, unknown>, what: string, i: number): string | null {
  if (!isNonEmptyString(e.id)) return `${what}[${i}].id debe ser una cadena no vacía`;
  if (!isSafeExternalKey(e.id as string)) return `${what}[${i}].id no puede ser una propiedad de Object.prototype`;
  if (!isVec2(e.position)) return `${what}[${i}].position debe ser {x,y} finitos`;
  if (!isFiniteNumber(e.halfW) || e.halfW < 0) return `${what}[${i}].halfW debe ser un número finito >= 0`;
  if (!isFiniteNumber(e.halfH) || e.halfH < 0) return `${what}[${i}].halfH debe ser un número finito >= 0`;
  if (e.rotation !== undefined && !isFiniteNumber(e.rotation)) return `${what}[${i}].rotation debe ser finito`;
  return null;
}

/**
 * Valida un valor arbitrario como `ArenaMap` jugable. Devuelve el mapa (mismo
 * objeto, sin copiar ni normalizar: si hiciera falta normalizar algo, es que el
 * mapa no era válido) o el motivo EXACTO del rechazo.
 */
export function validateArenaMap(value: unknown): ArenaMapValidation {
  if (!isPlainObject(value)) return { ok: false, reason: "el mapa debe ser un objeto" };
  const m = value;

  if (!isNonEmptyString(m.mapId)) return { ok: false, reason: "mapId debe ser una cadena no vacía" };
  if (!isSafeExternalKey(m.mapId)) {
    return { ok: false, reason: `mapId inválido: ${JSON.stringify(m.mapId)} es una propiedad de Object.prototype` };
  }
  if (typeof m.version !== "number" || !Number.isInteger(m.version) || m.version < 1) {
    return { ok: false, reason: "version debe ser un entero >= 1" };
  }
  if (typeof m.checksum !== "string" || !/^sha256:[0-9a-f]{64}$/.test(m.checksum)) {
    return { ok: false, reason: "checksum debe tener la forma sha256:<64 hex>" };
  }
  for (const dim of ["widthM", "heightM"] as const) {
    const v = m[dim];
    if (!isFiniteNumber(v) || v <= 0 || v > MAX_ARENA_MAP_DIMENSION_M) {
      return { ok: false, reason: `${dim} debe ser un número finito en (0, ${MAX_ARENA_MAP_DIMENSION_M}]` };
    }
  }

  for (const key of ["walls", "destructibles", "spawns", "bases", "flags", "zones"] as const) {
    if (!Array.isArray(m[key])) return { ok: false, reason: `${key} debe ser un array` };
  }
  const walls = m.walls as unknown[];
  const destructibles = m.destructibles as unknown[];
  const spawns = m.spawns as unknown[];
  const bases = m.bases as unknown[];
  const flags = m.flags as unknown[];
  const zones = m.zones as unknown[];

  const total = walls.length + destructibles.length + spawns.length + bases.length + flags.length + zones.length;
  if (total > MAX_ARENA_MAP_ENTITIES) {
    return { ok: false, reason: `el mapa declara ${total} entidades (máximo ${MAX_ARENA_MAP_ENTITIES})` };
  }

  for (let i = 0; i < walls.length; i++) {
    if (!isPlainObject(walls[i])) return { ok: false, reason: `walls[${i}] debe ser un objeto` };
    const err = checkBox(walls[i] as Record<string, unknown>, "walls", i);
    if (err) return { ok: false, reason: err };
  }
  for (let i = 0; i < destructibles.length; i++) {
    if (!isPlainObject(destructibles[i])) return { ok: false, reason: `destructibles[${i}] debe ser un objeto` };
    const d = destructibles[i] as Record<string, unknown>;
    const err = checkBox(d, "destructibles", i);
    if (err) return { ok: false, reason: err };
    if (!isFiniteNumber(d.hp) || d.hp <= 0) return { ok: false, reason: `destructibles[${i}].hp debe ser finito > 0` };
  }

  // Spawns: sin al menos un spawn por equipo real, `Battle` cae al pool completo
  // (battle.ts: `own.length > 0 ? own : this.config.map.spawns`) y los dos equipos
  // pueden aparecer superpuestos en el mismo punto. Eso NO es "el mapa pedido con
  // un detalle menor": es otra partida. Se exige lo mínimo jugable: >= 2 spawns y
  // >= 2 equipos distintos.
  if (spawns.length < 2) return { ok: false, reason: "el mapa necesita al menos 2 spawns" };
  const teams = new Set<string>();
  for (let i = 0; i < spawns.length; i++) {
    if (!isPlainObject(spawns[i])) return { ok: false, reason: `spawns[${i}] debe ser un objeto` };
    const s = spawns[i] as Record<string, unknown>;
    if (!isNonEmptyString(s.team)) return { ok: false, reason: `spawns[${i}].team debe ser una cadena no vacía` };
    if (!isSafeExternalKey(s.team)) {
      return { ok: false, reason: `spawns[${i}].team no puede ser una propiedad de Object.prototype` };
    }
    if (!isVec2(s.position)) return { ok: false, reason: `spawns[${i}].position debe ser {x,y} finitos` };
    if (!isFiniteNumber(s.heading)) return { ok: false, reason: `spawns[${i}].heading debe ser finito` };
    teams.add(s.team);
  }
  if (teams.size < 2) {
    return { ok: false, reason: `el mapa solo tiene spawns de un equipo (${[...teams].join(", ")})` };
  }

  for (let i = 0; i < bases.length; i++) {
    if (!isPlainObject(bases[i])) return { ok: false, reason: `bases[${i}] debe ser un objeto` };
    const b = bases[i] as Record<string, unknown>;
    if (!isNonEmptyString(b.team) || !isSafeExternalKey(b.team)) {
      return { ok: false, reason: `bases[${i}].team inválido` };
    }
    if (!isVec2(b.position)) return { ok: false, reason: `bases[${i}].position debe ser {x,y} finitos` };
    if (!isFiniteNumber(b.radiusM) || b.radiusM <= 0) {
      return { ok: false, reason: `bases[${i}].radiusM debe ser finito > 0` };
    }
  }
  for (let i = 0; i < flags.length; i++) {
    if (!isPlainObject(flags[i])) return { ok: false, reason: `flags[${i}] debe ser un objeto` };
    const f = flags[i] as Record<string, unknown>;
    if (!isNonEmptyString(f.team) || !isSafeExternalKey(f.team)) {
      return { ok: false, reason: `flags[${i}].team inválido` };
    }
    if (!isVec2(f.position)) return { ok: false, reason: `flags[${i}].position debe ser {x,y} finitos` };
  }
  for (let i = 0; i < zones.length; i++) {
    if (!isPlainObject(zones[i])) return { ok: false, reason: `zones[${i}] debe ser un objeto` };
    const z = zones[i] as Record<string, unknown>;
    if (!isNonEmptyString(z.id) || !isSafeExternalKey(z.id)) return { ok: false, reason: `zones[${i}].id inválido` };
    if (!isVec2(z.position)) return { ok: false, reason: `zones[${i}].position debe ser {x,y} finitos` };
    if (!isFiniteNumber(z.radiusM) || z.radiusM <= 0) {
      return { ok: false, reason: `zones[${i}].radiusM debe ser finito > 0` };
    }
    if (z.kind !== "damage" && z.kind !== "capture") {
      return { ok: false, reason: `zones[${i}].kind debe ser "damage" o "capture"` };
    }
    if (z.damagePerSecond !== undefined && !isFiniteNumber(z.damagePerSecond)) {
      return { ok: false, reason: `zones[${i}].damagePerSecond debe ser finito` };
    }
  }

  return { ok: true, map: m as unknown as ArenaMap };
}

/**
 * Etiqueta LEGIBLE de un mapa (`mapId@version#checksum`). Sirve para MENSAJES de
 * error, no para decidir si dos mapas son el mismo.
 *
 * NO USAR COMO COMPARACIÓN DE IDENTIDAD (hallazgo del supervisor de B9, demostrado
 * con una batalla real): el `checksum` de un `ArenaMap` no se deriva de su
 * geometría — se COPIA del documento origen en `toEngineMap()`. Quien construya la
 * cabecera de un replay puede poner el `mapId`/`version`/`checksum` que quiera
 * junto a una geometría cualquiera. El supervisor grabó una batalla REAL sobre
 * `proc-test-7` firmando la cabecera con la identidad de `mvp-arena-01` y la guarda
 * la dio por buena: `muros pedidos vs jugados: 3 vs 6`, resultado
 * `{"status":"completed","replay":{"ingested":true}}`. Justo el escenario (motor con
 * bug de caché o comprometido) que la guarda decía cubrir.
 */
export function arenaMapLabel(map: Pick<ArenaMap, "mapId" | "version" | "checksum">): string {
  return `${map.mapId}@${map.version}#${map.checksum}`;
}

/**
 * ¿Son EL MISMO mapa, geometría incluida? Igualdad estructural completa del
 * `ArenaMap`: identidad + dimensiones + muros + destructibles + spawns + bases +
 * banderas + zonas. Es lo único que de verdad demuestra que la batalla se jugó en
 * el mapa que se pidió.
 *
 * Sin falsos positivos: `Battle` NO muta `config.map` — el daño a los destructibles
 * vive en `this.destructibleHp` (`sim/battle.ts:122`, un `Map` aparte que se
 * inicializa desde el mapa pero nunca escribe en él). Comprobado con una batalla
 * real (corrección del supervisor a la justificación anterior de este fichero, que
 * afirmaba lo contrario y por eso comparaba solo tres campos).
 *
 * La comparación es sobre valores JSON (números, cadenas, arrays y objetos planos),
 * que es exactamente lo que hay dentro de un `ArenaMap` venido de la red.
 */
export function sameArenaMap(a: unknown, b: unknown): boolean {
  return deepEqualJson(a, b);
}

/** Igualdad estructural de valores JSON. El orden de los arrays SÍ importa (el de
 *  spawns/muros es significativo para el motor: ver `canonical.ts` de map-service). */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqualJson(v, b[i]));
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    // `Object.keys`: solo propiedades PROPIAS (nada heredado del prototipo, que es
    // por donde entra la clase de fallo que persigue todo este bloque).
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => deepEqualJson(ao[k], bo[k]));
  }
  // Números: `NaN !== NaN`, pero un mapa con NaN ya no pasa `validateArenaMap`.
  return false;
}

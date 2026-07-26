/**
 * B9 · Resolución REAL de un mapa del catálogo para una batalla.
 *
 * De `mapId` + `mapVersion` (lo que la batalla tiene guardado en BD) al `ArenaMap`
 * concreto que consume el motor de simulación. Sustituye a la allowlist rígida de
 * B2 (`FIXTURE_MAP_EQUIVALENTS`, que solo admitía `mvp-arena-01` v1 y lo traducía a
 * un mapa-fixture del motor): ahora se juega la GEOMETRÍA REAL del mapa publicado,
 * cualquiera que sea, y por eso hay que resolverlo de verdad.
 *
 * Cadena de formatos (ninguna es nueva; B9 solo las ata):
 *   map_versions.content (InternalMap, formato de almacenamiento de E1/E4)
 *     → toEngineMap()  (apps/map-service/src/to-engine-map.ts)
 *       → ArenaMap     (apps/arena-engine/src/sim/modes.ts, lo que come el motor)
 *
 * INVARIANTE INNEGOCIABLE (heredado de B2): jamás sustituir en silencio un mapa
 * por otro. Todas las comprobaciones son fail-closed y devuelven un CÓDIGO
 * distinguible; ninguna "arregla" el mapa ni cae a un mapa por defecto:
 *
 *   bad_request        · mapId/mapVersion no tienen ni la forma mínima.
 *   map_not_published  · no hay una fila `published` con ese mapId+versión EXACTOS
 *                        (nunca se coge "la última publicada" ni una versión vecina).
 *   map_content_mismatch · el documento guardado dice ser otro mapa u otra versión
 *                        que la fila que lo indexa (fila y contenido divergen).
 *   map_checksum_mismatch · el checksum canónico del documento no cuadra con su
 *                        propio contenido: alguien lo tocó después de publicarlo.
 *   map_invalid        · el documento no pasa el validador REAL de E4 (validateMap)
 *                        o no se puede aplanar a ArenaMap.
 *   map_unplayable     · aplana, pero el resultado no es un mapa jugable para el
 *                        motor (`validateArenaMap`, arena-engine/src/arena-map.ts).
 *
 * CHECKSUM — cuál se comprueba y por qué: se verifica el checksum CANÓNICO del
 * propio documento (`verifyChecksum`, map-service/canonical.ts: sha256 del JSON con
 * claves ordenadas, ignorando el campo `checksum`), NO la columna `map_versions.checksum`.
 * Esa columna la escriben hoy DOS productores con fórmulas distintas — el seed de
 * contenido (`db/seeds/dev.ts`: `sha256(JSON.stringify(doc))` en hex pelado) y la ruta
 * de import (`routes/maps.ts`: `map.checksum` canónico si existe) — así que compararla
 * con nada daría falsos positivos. El checksum canónico del documento sí es
 * verificable contra el contenido y es el que viaja al motor dentro del ArenaMap.
 */
import type { Db } from "../db/connection.js";
import { verifyChecksum } from "../../../map-service/src/canonical.js";
import { toEngineMap } from "../../../map-service/src/to-engine-map.js";
import { validateMap, isPublishable } from "../../../map-service/src/validate/index.js";
import type { InternalMap } from "../../../map-service/src/types.js";
import { validateArenaMap } from "../../../arena-engine/src/arena-map.js";
import type { ArenaMap } from "../../../arena-engine/src/sim/modes.js";

export type MapResolutionErrorCode =
  | "bad_request"
  | "map_not_published"
  | "map_content_mismatch"
  | "map_checksum_mismatch"
  | "map_invalid"
  | "map_unplayable";

/** Campos "del otro caso" opcionales: el monorepo compila con `strict: false` y sin
 *  `strictNullChecks` TypeScript no estrecha uniones discriminadas (mismo motivo
 *  documentado en `arena-engine/src/arena-map.ts`). */
export type MapResolution =
  | { ok: true; map: ArenaMap; code?: undefined; message?: undefined }
  | { ok: false; map?: undefined; code: MapResolutionErrorCode; message: string };

function fail(code: MapResolutionErrorCode, message: string): MapResolution {
  return { ok: false, code, message };
}

/**
 * Resuelve el mapa publicado `mapId` v`mapVersion` al `ArenaMap` que se enviará al
 * motor. NUNCA devuelve un mapa distinto al pedido: o es ese, o es un error.
 */
export async function resolveBattleMap(db: Db, mapId: unknown, mapVersion: unknown): Promise<MapResolution> {
  if (typeof mapId !== "string" || mapId.length === 0 || mapId.length > 128) {
    return fail("bad_request", `mapId inválido (cadena no vacía): ${JSON.stringify(mapId)}`);
  }
  if (typeof mapVersion !== "number" || !Number.isInteger(mapVersion) || mapVersion < 1) {
    return fail("bad_request", `mapVersion inválida (entero >= 1): ${JSON.stringify(mapVersion)}`);
  }

  // Consulta EXACTA por (map_id, version, state='published'). Sin `orderBy` ni
  // "la más reciente": pedir la v3 y jugar la v4 es sustituir el mapa en silencio.
  // El valor va parametrizado por knex (nunca interpolado), así que un mapId
  // "envenenado" ("__proto__", comillas, etc.) es un literal más: no encuentra
  // fila y se rechaza abajo.
  let row: Record<string, unknown> | undefined;
  try {
    row = await db("map_versions").where({ map_id: mapId, version: mapVersion, state: "published" }).first();
  } catch (err) {
    return fail("map_not_published", `no se pudo consultar el catálogo de mapas: ${errText(err)}`);
  }
  if (!row) {
    return fail(
      "map_not_published",
      `no existe una versión PUBLICADA del mapa ${mapId} v${mapVersion} en el catálogo: se rechaza la petición ` +
        `en vez de jugar un mapa distinto al pedido.`,
    );
  }

  // `content` es jsonb: knex/pg lo entrega ya parseado, pero un driver o una
  // columna text lo darían como cadena. Se acepta ambas formas; cualquier otra
  // cosa es contenido corrupto.
  let content: unknown = row.content;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch (err) {
      return fail("map_invalid", `el contenido del mapa ${mapId} v${mapVersion} no es JSON válido: ${errText(err)}`);
    }
  }
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return fail("map_invalid", `el contenido del mapa ${mapId} v${mapVersion} no es un documento de mapa`);
  }
  const doc = content as InternalMap;

  // Identidad: el documento debe declararse a sí mismo como el mapa+versión que
  // se pidió. Si la fila dice una cosa y el documento otra, no hay forma de saber
  // cuál es el mapa "de verdad" — se rechaza.
  if (doc.mapId !== mapId || doc.version !== mapVersion) {
    return fail(
      "map_content_mismatch",
      `el documento almacenado para ${mapId} v${mapVersion} dice ser ` +
        `${JSON.stringify(doc.mapId)} v${JSON.stringify(doc.version)}`,
    );
  }

  // Integridad: checksum canónico del propio documento (ver nota de cabecera).
  if (typeof doc.checksum !== "string" || !verifyChecksum(doc)) {
    return fail(
      "map_checksum_mismatch",
      `el checksum canónico de ${mapId} v${mapVersion} no coincide con su contenido: el documento se ha ` +
        `modificado después de publicarse (o nunca tuvo checksum). No se juega.`,
    );
  }

  // Validador REAL de E4 (las seis comprobaciones). Ya se pasó al publicar, pero
  // el contenido pudo publicarse con otra versión del validador o llegar por un
  // camino que no lo aplicó: se revalida aquí, y un mapa con errores NO se juega.
  // `validateMap` LANZA con documentos malformados (destructura map.layers), así
  // que el catch traduce a rechazo — no se traga el fallo, lo convierte en error.
  try {
    const validation = validateMap(doc);
    if (!isPublishable(validation)) {
      const errors = validation.checks
        .filter((c) => c.severity === "error")
        .map((c) => `${c.check}: ${c.message}`)
        .join("; ");
      return fail("map_invalid", `el mapa ${mapId} v${mapVersion} no pasa la validación de E4: ${errors}`);
    }
  } catch (err) {
    return fail("map_invalid", `el mapa ${mapId} v${mapVersion} no se pudo validar: ${errText(err)}`);
  }

  let engineMap: unknown;
  try {
    engineMap = toEngineMap(doc);
  } catch (err) {
    return fail(
      "map_invalid",
      `el mapa ${mapId} v${mapVersion} no se pudo convertir al formato del motor: ${errText(err)}`,
    );
  }

  // Última red: la forma EXACTA que va a recibir el motor, con el mismo validador
  // que aplicará arena-engine al otro lado (arena-engine/src/arena-map.ts). Si el
  // rechazo va a ocurrir, que ocurra aquí — antes de arrancar contenedores.
  const checked = validateArenaMap(engineMap);
  if (!checked.ok) {
    return fail("map_unplayable", `el mapa ${mapId} v${mapVersion} no es jugable: ${checked.reason}`);
  }
  return { ok: true, map: checked.map };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

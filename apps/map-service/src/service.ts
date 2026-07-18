/**
 * T4.3 · Servicio de mapas: import / publish / get / list, con VERSIÓN INMUTABLE.
 *
 * En esta entrega es una LIBRERÍA con almacenamiento EN MEMORIA (no hay servidor
 * HTTP ni base de datos: eso es de E7/E10). E7 llamará a estas funciones desde los
 * endpoints /maps de apps/api/openapi.yaml. La elección de "en memoria" (frente a
 * archivos JSON) es deliberada para esta fase: sin dependencias de disco, el servicio
 * es una función pura de su historial de llamadas y es trivial de testear; E10
 * decidirá el almacenamiento real (Postgres + volumen).
 *
 * Reglas duras (cap. 14.2/14.4):
 *  - Validar SIEMPRE antes de publicar: un mapa con `error` NUNCA alcanza "published".
 *  - Publicado = inmutable: reescribir una versión publicada se rechaza (equivale al
 *    409 de la API) y queda en un log auditable.
 *  - Idempotencia por checksum: publicar dos veces el MISMO contenido devuelve la
 *    MISMA versión, no crea una nueva.
 */
import { computeChecksum, withChecksum } from "./canonical.js";
import { validateMap, isPublishable, type ValidationResult } from "./validate/index.js";
import type { InternalMap, MapWithoutChecksum } from "./types.js";

export type MapStatus = "draft" | "published";

export interface StoredMapVersion {
  mapId: string;
  version: number;
  status: MapStatus;
  map: InternalMap;
  checksum: string;
  thumbnail: string; // SVG placeholder inline (data URI)
  validation: ValidationResult;
  publishedAtSeq: number | null;
}

export interface AuditEntry {
  seq: number;
  action: "import" | "publish" | "reject_publish_immutable" | "reject_invalid" | "publish_idempotent";
  mapId: string;
  version: number;
  detail: string;
}

export class MapServiceError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_map" | "immutable_version" | "not_found",
  ) {
    super(message);
  }
}

export class MapService {
  /** mapId -> version -> registro. */
  private readonly store = new Map<string, Map<number, StoredMapVersion>>();
  /** checksum -> {mapId, version} de una versión YA PUBLICADA (para idempotencia). */
  private readonly publishedByChecksum = new Map<string, { mapId: string; version: number }>();
  private readonly audit: AuditEntry[] = [];
  private seq = 0;

  private log(action: AuditEntry["action"], mapId: string, version: number, detail: string): void {
    this.audit.push({ seq: this.seq++, action, mapId, version, detail });
  }

  /**
   * Importa un mapa: lo valida (T4.2). Si tiene errores, lanza (no lo almacena). Si
   * solo tiene warnings o está limpio, lo deja en estado `draft`. Recalcula el
   * checksum canónico (no confía en el que traiga el documento).
   */
  importMap(source: MapWithoutChecksum): StoredMapVersion {
    const map = withChecksum(source);

    // Idempotencia por checksum: reimportar contenido EXACTAMENTE igual a algo ya
    // publicado no es una violación de inmutabilidad, es un no-op — se devuelve la
    // versión publicada. (Reimportar contenido DISTINTO sobre una versión publicada
    // sí es una violación: se rechaza más abajo.)
    const alreadyPublished = this.publishedByChecksum.get(map.checksum);
    if (alreadyPublished) {
      this.log("publish_idempotent", map.mapId, map.version, "reimport de contenido ya publicado");
      return this.store.get(alreadyPublished.mapId)!.get(alreadyPublished.version)!;
    }

    const validation = validateMap(map);

    if (!isPublishable(validation)) {
      const errors = validation.checks.filter((c) => c.severity === "error").map((c) => `${c.check}: ${c.message}`);
      this.log("reject_invalid", map.mapId, map.version, errors.join("; "));
      throw new MapServiceError(`Mapa inválido, no se importa: ${errors.join("; ")}`, "invalid_map");
    }

    const versions = this.store.get(map.mapId) ?? new Map<number, StoredMapVersion>();

    // No se puede reescribir una versión YA PUBLICADA (inmutabilidad).
    const existing = versions.get(map.version);
    if (existing && existing.status === "published") {
      this.log("reject_publish_immutable", map.mapId, map.version, "import sobre versión publicada");
      throw new MapServiceError(
        `La versión ${map.version} de ${map.mapId} ya está publicada y es inmutable`,
        "immutable_version",
      );
    }

    const record: StoredMapVersion = {
      mapId: map.mapId,
      version: map.version,
      status: "draft",
      map,
      checksum: map.checksum,
      thumbnail: "",
      validation,
      publishedAtSeq: null,
    };
    versions.set(map.version, record);
    this.store.set(map.mapId, versions);
    this.log(
      "import",
      map.mapId,
      map.version,
      `draft (warnings: ${validation.checks.filter((c) => c.severity === "warning").length})`,
    );
    return record;
  }

  /**
   * Publica una versión existente en draft: congela contenido+checksum, genera
   * miniatura y la marca `published` (inmutable a partir de aquí). Idempotente por
   * checksum: si ese contenido exacto ya estaba publicado (en cualquier versión),
   * devuelve esa versión sin crear nada.
   */
  publishMap(mapId: string, version: number): StoredMapVersion {
    const record = this.store.get(mapId)?.get(version);
    if (!record) throw new MapServiceError(`No existe ${mapId} v${version}`, "not_found");

    // Idempotencia por checksum: mismo contenido ya publicado → misma versión.
    const already = this.publishedByChecksum.get(record.checksum);
    if (already) {
      this.log("publish_idempotent", mapId, version, `contenido idéntico a ${already.mapId} v${already.version}`);
      return this.store.get(already.mapId)!.get(already.version)!;
    }

    if (record.status === "published") return record;

    // Revalidar antes de publicar: nunca se publica algo con errores (defensa en
    // profundidad; importMap ya lo garantiza, pero publishMap no debe confiar).
    const validation = validateMap(record.map);
    if (!isPublishable(validation)) {
      const errors = validation.checks.filter((c) => c.severity === "error").map((c) => `${c.check}: ${c.message}`);
      this.log("reject_invalid", mapId, version, errors.join("; "));
      throw new MapServiceError(`No se publica un mapa inválido: ${errors.join("; ")}`, "invalid_map");
    }

    record.status = "published";
    record.thumbnail = makeThumbnail(record.map);
    record.validation = validation;
    record.publishedAtSeq = this.seq;
    this.publishedByChecksum.set(record.checksum, { mapId, version });
    this.log("publish", mapId, version, `checksum ${record.checksum}`);
    return record;
  }

  getMap(mapId: string, version: number): StoredMapVersion {
    const record = this.store.get(mapId)?.get(version);
    if (!record) throw new MapServiceError(`No existe ${mapId} v${version}`, "not_found");
    return record;
  }

  listMaps(): { mapId: string; version: number; status: MapStatus; checksum: string }[] {
    const out: { mapId: string; version: number; status: MapStatus; checksum: string }[] = [];
    for (const versions of this.store.values()) {
      for (const r of versions.values()) {
        out.push({ mapId: r.mapId, version: r.version, status: r.status, checksum: r.checksum });
      }
    }
    return out.sort((a, b) => a.mapId.localeCompare(b.mapId) || a.version - b.version);
  }

  getAuditLog(): readonly AuditEntry[] {
    return this.audit;
  }
}

/**
 * Miniatura placeholder: un SVG simple con la silueta del mapa (borde + muros +
 * bases). No es un renderer real (eso es del visor, E8): solo prueba que "publicar"
 * produce un artefacto de miniatura reproducible. Se devuelve como data URI inline.
 */
export function makeThumbnail(map: InternalMap): string {
  const scale = 2; // px por metro
  const w = Math.round(map.widthM * scale);
  const h = Math.round(map.heightM * scale);
  const rects: string[] = [];
  for (const wall of map.layers.walls) {
    if (wall.shape !== "rect" || !wall.position) continue;
    const x = (wall.position.x - (wall.widthM ?? 0) / 2) * scale;
    // El SVG tiene Y hacia abajo; el mundo, hacia arriba (D1): se voltea.
    const y = (map.heightM - wall.position.y - (wall.heightM ?? 0) / 2) * scale;
    rects.push(
      `<rect x="${round(x)}" y="${round(y)}" width="${round((wall.widthM ?? 0) * scale)}" height="${round((wall.heightM ?? 0) * scale)}" fill="#555"/>`,
    );
  }
  for (const base of map.layers.bases ?? []) {
    if (!base.position) continue;
    const cx = base.position.x * scale;
    const cy = (map.heightM - base.position.y) * scale;
    rects.push(`<circle cx="${round(cx)}" cy="${round(cy)}" r="6" fill="${base.team === "red" ? "#c33" : "#36c"}"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#111"/>${rects.join("")}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export { computeChecksum };

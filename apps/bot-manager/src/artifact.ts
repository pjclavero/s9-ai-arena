/**
 * E6 · bot-manager — empaquetado reproducible y hash del artefacto (T6.1).
 *
 * DoD T6.1: "compilar dos veces el mismo commit produce artefactos con el mismo hash".
 * Sin Docker no podemos construir la imagen real, pero SÍ podemos hacer verificable la
 * propiedad que importa: el empaquetado es una función pura y determinista del código
 * fuente. Se serializa una manifest canónica (entradas ORDENADAS por ruta, sin fechas
 * ni metadatos de sistema de ficheros, longitudes explícitas para evitar ambigüedad de
 * separadores) y se hashea con SHA-256. Dos ejecuciones del mismo fuente → mismo hash;
 * un byte distinto en cualquier fichero → hash distinto.
 *
 * La imagen Docker real (runtimes/) debe montarse sobre este mismo artefacto empaquetado
 * de forma que el digest de la imagen dependa solo de (runtime pinneado por digest +
 * este artifactHash). Esa parte queda como artefacto Docker (verificación pendiente de
 * entorno con Docker); la reproducibilidad del EMPAQUETADO se prueba aquí de verdad.
 */
import { createHash } from "node:crypto";
import type { SourceFile } from "./types.js";

export interface Artifact {
  /** Bytes canónicos del paquete (determinista). */
  bytes: Buffer;
  /** sha256 hex de bytes. */
  hash: string;
}

/** Normaliza fin de línea para que CRLF/LF no cambien el hash del "mismo commit". */
function normalize(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

/**
 * Serialización canónica: para cada fichero (ordenado por ruta) escribe
 *   <len(path)>\n<path>\n<len(bytes)>\n<bytes>\n
 * Las longitudes explícitas hacen la codificación libre de ambigüedad (inyectar un
 * "\n" en un contenido no puede simular una entrada nueva).
 */
export function packArtifact(files: SourceFile[]): Artifact {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks: Buffer[] = [Buffer.from("arena-artifact/v1\n", "utf8")];
  for (const f of sorted) {
    const path = Buffer.from(f.path, "utf8");
    const body = Buffer.from(normalize(f.content), "utf8");
    chunks.push(Buffer.from(`${path.length}\n`, "utf8"), path, Buffer.from("\n", "utf8"));
    chunks.push(Buffer.from(`${body.length}\n`, "utf8"), body, Buffer.from("\n", "utf8"));
  }
  const bytes = Buffer.concat(chunks);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { bytes, hash };
}

/** Tamaño total del fuente en bytes (para el límite de estructura). */
export function sourceSize(files: SourceFile[]): number {
  return files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
}

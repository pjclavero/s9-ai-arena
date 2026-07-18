/**
 * R2.6 · ERR-SEC-10 — Decodificación ESTRICTA del paquete de código subido.
 *
 * El decodificador anterior aceptaba cualquier `path` (`../x`, absolutos,
 * caracteres de control): latente hoy porque el almacén es `bytea`, pero un
 * traversal de escritura en cuanto exista un resolver que materialice los
 * ficheros en disco (sandbox de ERR-SEC-03). Aquí el paquete se valida con
 * esquema ajv (ya usado en el motor) y toda ruta debe ser relativa,
 * normalizada y contenida bajo el directorio del paquete. Falla CERRADO:
 * cualquier violación lanza PackageValidationError y el build se rechaza.
 */
import Ajv2020 from "ajv/dist/2020.js";
import type { Runtime, SourceFile } from "../../../bot-manager/src/types.js";

/** Máximo de ficheros por paquete (alineado con maxFileCount de E6, config.ts). */
export const MAX_PACKAGE_FILES = 500;
/** Longitud máxima de una ruta dentro del paquete. */
export const MAX_PATH_LENGTH = 256;

export class PackageValidationError extends Error {
  constructor(public reason: string) {
    super(`paquete inválido: ${reason}`);
    this.name = "PackageValidationError";
  }
}

/**
 * Esquema estricto del paquete `{"files":[{"path","content"},…]}`:
 * sin propiedades extra, con límites de cardinalidad y longitud. Las reglas
 * de ruta (relativa/normalizada/contenida) van aparte en assertSafeRelativePath
 * porque un regex de JSON Schema no expresa la normalización con claridad.
 */
const PACKAGE_SCHEMA = {
  type: "object",
  required: ["files"],
  additionalProperties: false,
  properties: {
    files: {
      type: "array",
      minItems: 1,
      maxItems: MAX_PACKAGE_FILES,
      items: {
        type: "object",
        required: ["path", "content"],
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH },
          content: { type: "string" },
        },
      },
    },
  },
} as const;

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validatePackageShape = ajv.compile(PACKAGE_SCHEMA);

/** Caracteres de control (C0 + DEL) — jamás en una ruta legítima. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Letra de unidad Windows (`C:`) o esquema (`file:`) al principio. */
const DRIVE_OR_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Ruta relativa, normalizada y contenida bajo la raíz del paquete:
 *  - sin caracteres de control ni backslash (separador único: `/`)
 *  - sin absolutos (`/x`), letras de unidad (`C:`) ni esquemas (`file:`)
 *  - sin segmentos vacíos (`a//b`), `.` ni `..`
 *  - sin barra final
 * Lanza PackageValidationError con la ruta ofensiva; nunca "arregla" la ruta.
 */
export function assertSafeRelativePath(path: string): void {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw new PackageValidationError(`ruta vacía o demasiado larga (${path.length} > ${MAX_PATH_LENGTH})`);
  }
  if (CONTROL_CHARS.test(path)) throw new PackageValidationError("ruta con caracteres de control");
  if (path.includes("\\")) throw new PackageValidationError(`ruta con backslash: ${path}`);
  if (path.startsWith("/")) throw new PackageValidationError(`ruta absoluta: ${path}`);
  if (DRIVE_OR_SCHEME.test(path)) throw new PackageValidationError(`ruta con unidad o esquema: ${path}`);
  if (path.endsWith("/")) throw new PackageValidationError(`ruta de directorio (barra final): ${path}`);
  for (const segment of path.split("/")) {
    if (segment === "") throw new PackageValidationError(`ruta no normalizada (segmento vacío): ${path}`);
    if (segment === ".") throw new PackageValidationError(`ruta no normalizada (segmento "."): ${path}`);
    if (segment === "..") throw new PackageValidationError(`ruta fuera del paquete (".."): ${path}`);
  }
}

/** Manifiesto exigido en la RAÍZ exacta del paquete, por runtime (E6, pipeline.ts). */
export function rootManifestFor(runtime: Runtime): string {
  return runtime === "python" ? "requirements.txt" : "package.json";
}

/** Paquete estándar mínimo alrededor de código "pegado" (T7.4: archivo o pegado). */
export function wrapSingleFile(runtime: Runtime, content: string): SourceFile[] {
  if (runtime === "python") {
    return [
      { path: "manifest.json", content: JSON.stringify({ runtime: "python", entry: "src/bot.py" }, null, 2) },
      { path: "requirements.txt", content: "arena-sdk==1.0.0\n" },
      { path: "requirements.lock", content: "arena-sdk==1.0.0\n" },
      { path: "src/bot.py", content },
    ];
  }
  return [
    {
      path: "package.json",
      content: JSON.stringify({ name: "bot", version: "1.0.0", dependencies: { "@arena/sdk": "1.0.0" } }, null, 2),
    },
    { path: "package-lock.json", content: JSON.stringify({ lockfileVersion: 3, packages: {} }, null, 2) },
    { path: "src/bot.js", content },
  ];
}

/**
 * Decodifica el paquete subido: o bien un JSON `{"files":[…]}` (formato de
 * paquete de la plataforma), o bien un único archivo de código que se envuelve
 * en el esqueleto estándar del runtime.
 *
 * Si el subido ES un paquete (JSON con la clave `files`), se valida ESTRICTO y
 * cualquier violación lanza PackageValidationError — nunca se degrada en
 * silencio a "código pegado" ni se filtran entradas inválidas.
 */
export function decodePackage(source: Buffer, runtime: Runtime): SourceFile[] {
  const text = source.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return wrapSingleFile(runtime, text); // no era JSON: código pegado / archivo único
  }
  const isPackage = !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && "files" in (parsed as object);
  if (!isPackage) {
    // JSON válido pero no es el formato de paquete (p. ej. un .json pegado como código).
    return wrapSingleFile(runtime, text);
  }

  if (!validatePackageShape(parsed)) {
    const detail = (validatePackageShape.errors ?? [])
      .map((e) => `${e.instancePath || "(raíz)"} ${e.message}`)
      .join("; ");
    throw new PackageValidationError(`esquema: ${detail || "estructura inválida"}`);
  }
  const files = (parsed as { files: SourceFile[] }).files;

  const seen = new Set<string>();
  for (const f of files) {
    assertSafeRelativePath(f.path);
    if (seen.has(f.path)) throw new PackageValidationError(`ruta duplicada: ${f.path}`);
    seen.add(f.path);
  }

  const manifest = rootManifestFor(runtime);
  if (!seen.has(manifest)) {
    throw new PackageValidationError(`falta el manifiesto ${manifest} en la raíz exacta del paquete`);
  }
  return files;
}

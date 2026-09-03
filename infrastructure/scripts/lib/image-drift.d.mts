/**
 * Tipos del clasificador de drift de ADR-016. El módulo es `.mjs` porque lo
 * ejecutan también los scripts de operación con `node` a pelo, sin build; estos
 * tipos existen para que el código TypeScript (packages/readiness) consuma EL
 * MISMO clasificador en vez de mantener una segunda copia del modelo.
 */
export type EstadoDrift = "TAG_CONTENT_MISMATCH" | "IMAGE_MISSING" | "TAG_MOVED" | "RUNTIME_MATCH";

export const TAG_CONTENT_MISMATCH: "TAG_CONTENT_MISMATCH";
export const IMAGE_MISSING: "IMAGE_MISSING";
export const TAG_MOVED: "TAG_MOVED";
export const RUNTIME_MATCH: "RUNTIME_MATCH";
export const ESTADOS: readonly EstadoDrift[];
export const ESTADOS_DE_DRIFT: readonly EstadoDrift[];

export interface Observacion {
  nombre: string;
  runningImageId: string | null;
  referencia: string | null;
  imagenResoluble: boolean;
  idDeLaReferencia: string | null;
  digestEsperado?: string | null;
  envImagen?: Readonly<Record<string, string>>;
  labelsImagen?: Readonly<Record<string, string>>;
  reason?: string;
}

export interface Clasificacion {
  nombre: string;
  estado: EstadoDrift | null;
  runtimeImageExists: boolean;
  tagPointsToRuntime: boolean | null;
  pinMatchesRuntime: boolean | null;
  runningImageId: string | null;
  referencia: string | null;
  idDeLaReferencia: string | null;
  commitEtiqueta: string | null;
  commitEmbebido: string | null;
  procedencia: "verified" | "not_exercised";
  explicacion: string;
  reason?: string;
}

export function clasificarDrift(obs: Observacion): Clasificacion;
export function commitDeReferencia(referencia: string | null | undefined): string | null;
export function commitEmbebido(
  env: Readonly<Record<string, string>>,
  labels: Readonly<Record<string, string>>,
): string | null;
export function mismoCommit(a: string | null, b: string | null): boolean;
export function corto(s: string | null): string;
export function lineasInforme(c: Clasificacion): string[];

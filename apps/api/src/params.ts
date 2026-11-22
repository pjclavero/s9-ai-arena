import { badRequest } from "./errors.js";

/**
 * R2.1 (ERR-GES-03) · Normalización de parámetros de ruta.
 *
 * Express 5 tipa `req.params` como `string | string[]` porque los comodines
 * (`*splat`) producen arrays. Los parámetros CON NOMBRE del contrato de E1
 * (`:battleId`, `:botId`, …) son siempre un string en tiempo de ejecución;
 * este helper lo refleja en tipos sin cambiar comportamiento (si llegara un
 * array —imposible en rutas con nombre— se toma el primer segmento).
 */
export function pathParam(req: { params: Record<string, string | string[] | undefined> }, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: string): boolean => UUID_RE.test(v);

/**
 * V1-B (#305) · Parámetro de QUERY que debe ser un uuid. Ausente ⇒ undefined; con forma
 * inválida (o repetido) ⇒ 400 claro, nunca un 500 de PostgreSQL («invalid input syntax for
 * type uuid») ni, con cursor, un falso «cursor inválido».
 */
export function queryUuid(req: { query: Record<string, unknown> }, name: string): string | undefined {
  const v = req.query[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !isUuid(v)) throw badRequest(`${name} debe ser un uuid`);
  return v;
}

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

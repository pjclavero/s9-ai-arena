/**
 * STAT_SEASON — ÚNICA fuente de la temporada activa (TD-029).
 *
 * Antes había tres respuestas distintas a «¿qué temporada es?»:
 *  - la API (`GET /standings`) consultaba `season_id = 'current'` por defecto,
 *  - el worker (`ratings.ts`) escribía en `tournaments.season_id ?? 'season-1'`,
 *  - la migración 008 pone `tournaments.season_id DEFAULT 'season-1'`.
 * Ninguna fila tenía jamás `season_id = 'current'`, así que la clasificación
 * pública salía SIEMPRE vacía aunque hubiera torneos jugados.
 *
 * Contrato (lo consumen API, worker y, a través de la API, la web):
 *  - `ACTIVE_SEASON_ID` es la temporada activa. Coincide con el DEFAULT de la
 *    columna `tournaments.season_id` (migración 008): un torneo creado sin
 *    temporada explícita puntúa en la activa.
 *  - `"current"` (o ausencia del parámetro) es un ALIAS de la activa en la API;
 *    nunca se escribe en la BD.
 *  - Cualquier otro valor es un id de temporada literal (p. ej. histórico).
 *
 * Cambiar de temporada = cambiar esta constante Y el DEFAULT de la columna en
 * una migración nueva, en el mismo cambio (hay un test que las compara).
 */

/** Temporada activa. Debe coincidir con el DEFAULT de `tournaments.season_id`. */
export const ACTIVE_SEASON_ID = "season-1";

/** Alias público de la temporada activa (parámetro `seasonId` de la API). */
export const CURRENT_SEASON_ALIAS = "current";

/**
 * Traduce el `seasonId` recibido (query string, dato de BD) a un id real:
 * ausente, vacío o `"current"` ⇒ la temporada activa; si no, el valor tal cual.
 */
export function resolveSeasonId(raw: unknown): string {
  if (typeof raw !== "string") return ACTIVE_SEASON_ID;
  const v = raw.trim();
  if (v === "" || v === CURRENT_SEASON_ALIAS) return ACTIVE_SEASON_ID;
  return v;
}

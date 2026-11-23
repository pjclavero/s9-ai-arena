/**
 * B3 (V1, D-OP-9) · ÚNICA fuente de los modos de juego permitidos en TORNEOS.
 *
 * En V1 los torneos sólo se juegan en Deathmatch y Deathmatch por equipos. Captura la
 * bandera y Control de zona quedan FUERA (los bandos de torneo son A/B y los mapas de
 * bandera usan red/blue; ningún mapa de serie tiene zona de captura): un torneo así se
 * creaba y su batalla fallaba al arrancar. Lo importan la API (crear torneo) y el
 * scheduler del worker (guarda técnica); la web lo espeja con un test de deriva.
 *
 * Es una lista de PERMITIDOS: un modo nuevo del motor no entra en torneos por omisión.
 * Las batallas sueltas NO dependen de esta lista (las gobierna el bloqueo de práctica).
 */
export const TOURNAMENT_ALLOWED_MODES: readonly string[] = ["deathmatch", "team_deathmatch"];

export const TOURNAMENT_MODE_NOT_ALLOWED = "tournament_mode_not_allowed";

export function isTournamentModeAllowed(mode: unknown): boolean {
  return typeof mode === "string" && TOURNAMENT_ALLOWED_MODES.includes(mode);
}

/** Motivo legible y estable (sin topología interna) para API, worker y documentación. */
export function tournamentModeNotAllowedReason(mode: unknown): string {
  return (
    `El modo ${JSON.stringify(mode)} no está disponible en torneos en esta versión: ` +
    `los torneos admiten sólo ${TOURNAMENT_ALLOWED_MODES.join(" y ")}`
  );
}

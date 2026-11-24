/**
 * Motivos de cierre de una batalla que NO son un resultado deportivo (`winner: null`, outcome NULL):
 *  - `technical_limit` (ADR-022): la salvaguarda técnica de la prórroga del motor la detuvo.
 *  - `recording_limit` (V1 REPLAYS PR-5, D-3): la batalla superó su tope de bytes de grabación y el
 *    replay se cerró TRUNCADO. Es determinista (no se reintenta) y no tiene efectos deportivos.
 *
 * Fuente ÚNICA para los consumidores (ratings, clasificaciones, cierre de enfrentamientos): añadir un
 * motivo aquí lo excluye de TODOS a la vez, sin tocar cada lista.
 */
export const NO_SPORTING_RESULT_END_REASONS = ["technical_limit", "recording_limit"] as const;
export type NoSportingResultEndReason = (typeof NO_SPORTING_RESULT_END_REASONS)[number];

export function isNoSportingResultEndReason(x: unknown): x is NoSportingResultEndReason {
  return typeof x === "string" && (NO_SPORTING_RESULT_END_REASONS as readonly string[]).includes(x);
}

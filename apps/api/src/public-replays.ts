/**
 * R11 · Acceso público a replay y batalla finalizada — CAPABILITY apagada por defecto.
 *
 * `GET /public/replays`, `GET /public/replays/:battleId` y
 * `GET /public/replays/:battleId/download` exponen SOLO batallas `finished`,
 * con proyección de campos estrictamente pública (sin seed, sin datos de
 * propietario). Sigue el mismo patrón que public-spectate.ts (R11 slice
 * mínimo) y battle-run.ts (R6.2/R9-B): capability resuelta del entorno,
 * inyectable en tests, apagada salvo activación explícita.
 *
 * Deliberadamente NO usa la ruta `/public/battles/{battleId}` del espectador
 * en directo (ya ocupada por `getPublicLiveBattle`, gateada por
 * S9_PUBLIC_SPECTATE_ENABLED para batallas `running`): mismo método+path no
 * puede tener dos operationId en el contrato. El acceso a replay vive bajo
 * su propio namespace `/public/replays*` con su propia capability.
 */

/** S9_PUBLIC_REPLAYS_ENABLED === "1" | "true" (case-insensitive). Apagada por defecto. */
export function publicReplaysEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.S9_PUBLIC_REPLAYS_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

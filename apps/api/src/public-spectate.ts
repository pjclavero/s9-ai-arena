/**
 * R11 · Espectador público (slice mínimo) — CAPABILITY apagada por defecto.
 *
 * `GET /public/battles/live` expone SOLO campos públicos (id, estado, modo,
 * mapa, timestamps) de las batallas en directo, sin cuenta. Sigue el mismo
 * patrón que battle-run.ts (R6.2/R9-B): capability resuelta del entorno,
 * inyectable en tests, apagada salvo activación explícita.
 */

/** S9_PUBLIC_SPECTATE_ENABLED === "1" | "true" (case-insensitive). Apagada por defecto. */
export function publicSpectateEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.S9_PUBLIC_SPECTATE_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

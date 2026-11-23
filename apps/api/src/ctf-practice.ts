/**
 * V1 · BLOQUEO TEMPORAL de la creación de batallas de captura de bandera (CTF).
 *
 * Mientras CTF no esté corregido y validado, `POST /battles` rechaza el modo
 * `capture_the_flag` (reglas clásicas, preset o personalizado) y la web no lo ofrece.
 * No toca el motor ni las batallas ya existentes: se siguen listando y sus replays se
 * pueden consultar.
 *
 * Interruptor explícito, sin código: `S9_CTF_PRACTICE_ENABLED` = `1` | `true`
 * (case-insensitive) lo reactiva; cualquier otro valor, o ausente, lo deja BLOQUEADO
 * (por defecto en V1). Se lee del entorno en cada petición, así que basta con
 * reiniciar la API con el valor nuevo.
 */
export const CTF_MODE = "capture_the_flag";

export const CTF_DISABLED_CODE = "mode_disabled";
export const CTF_DISABLED_REASON =
  "El modo captura la bandera está deshabilitado temporalmente mientras se corrige y se valida. Usa deathmatch, deathmatch por equipos o control de zona.";

export function ctfPracticeEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.S9_CTF_PRACTICE_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/** Modos de plataforma cuya creación está bloqueada ahora, con su motivo. */
export function disabledModes(env: NodeJS.ProcessEnv = process.env): { mode: string; reason: string }[] {
  return ctfPracticeEnabledFromEnv(env) ? [] : [{ mode: CTF_MODE, reason: CTF_DISABLED_REASON }];
}

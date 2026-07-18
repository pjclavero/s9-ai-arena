/**
 * T11.1 · Configuración de la vista /broadcast (cap. 21).
 *
 * La vista se AUTOCONFIGURA por query string (?battle=id | ?tournament=id) y el
 * branding (logo, colores, nombre del evento) también viaja por parámetros:
 * cambiar el aspecto de una emisión NO exige redeploy (DoD T11.1), solo cambiar
 * la URL que captura el streamer.
 *
 * Todo lo que entra por URL se SANEA aquí (colores solo #hex, logo solo
 * http(s)/ruta relativa): la vista corre en un Chromium sin usuario delante y
 * no puede ser un vector de inyección CSS/HTML.
 */

export interface BroadcastBranding {
  /** Nombre del evento para la cabecera. */
  eventName: string;
  /** URL del logo (http(s) o ruta relativa) o null si no hay. */
  logoUrl: string | null;
  /** Color primario (#rgb/#rrggbb saneado). */
  primaryColor: string;
  /** Color de acento (#rgb/#rrggbb saneado). */
  accentColor: string;
}

export type BroadcastTarget = { kind: "battle"; battleId: string } | { kind: "tournament"; tournamentId: string };

export interface BroadcastConfig {
  target: BroadcastTarget | null;
  branding: BroadcastBranding;
  /** Cadencia de sondeo del estado del torneo (ms). */
  pollIntervalMs: number;
}

export const DEFAULT_BRANDING: BroadcastBranding = {
  eventName: "S9 AI Arena",
  logoUrl: null,
  primaryColor: "#10141f",
  accentColor: "#ffb300",
};

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Solo colores #hex: cualquier otra cosa cae al valor por defecto (anti-inyección CSS). */
export function sanitizeColor(raw: string | null, fallback: string): string {
  if (raw && HEX_COLOR.test(raw.trim())) return raw.trim().toLowerCase();
  return fallback;
}

/** Solo http(s) o rutas relativas del propio origen; nada de javascript:/data:. */
export function sanitizeLogoUrl(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("/") && !v.startsWith("//")) return v;
  return null;
}

/** IDs de batalla/torneo: uuid o slug conservador. */
const SAFE_ID = /^[0-9a-zA-Z_-]{1,64}$/;

export function parseBroadcastConfig(search: string): BroadcastConfig {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const battle = q.get("battle");
  const tournament = q.get("tournament");
  let target: BroadcastTarget | null = null;
  // ?battle manda si vienen los dos (una batalla concreta es más específica).
  if (battle && SAFE_ID.test(battle)) target = { kind: "battle", battleId: battle };
  else if (tournament && SAFE_ID.test(tournament)) target = { kind: "tournament", tournamentId: tournament };

  const branding: BroadcastBranding = {
    eventName: (q.get("event") ?? "").trim().slice(0, 80) || DEFAULT_BRANDING.eventName,
    logoUrl: sanitizeLogoUrl(q.get("logo")),
    primaryColor: sanitizeColor(q.get("primary"), DEFAULT_BRANDING.primaryColor),
    accentColor: sanitizeColor(q.get("accent"), DEFAULT_BRANDING.accentColor),
  };

  const poll = Number(q.get("poll") ?? "");
  const pollIntervalMs = Number.isFinite(poll) && poll >= 1000 && poll <= 60000 ? poll : 4000;

  return { target, branding, pollIntervalMs };
}

/**
 * Enrutado de /broadcast: acepta la ruta real (`/broadcast?battle=x`, la que
 * captura Chromium tras el fallback SPA del gateway/vite) y la variante hash
 * (`#/broadcast?battle=x`) coherente con el resto del panel de E7.
 */
export function matchBroadcastRoute(pathname: string, search: string, hash: string): BroadcastConfig | null {
  if (pathname === "/broadcast" || pathname === "/broadcast/") return parseBroadcastConfig(search);
  const m = /^#\/broadcast(?:\?(.*))?$/.exec(hash);
  if (m) return parseBroadcastConfig(m[1] ?? "");
  return null;
}

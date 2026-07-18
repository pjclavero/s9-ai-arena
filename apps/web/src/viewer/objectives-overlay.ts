/**
 * R3.5 · ERR-VIS-05 — Objetivos DIBUJADOS que hoy se ignoran pese a llegar.
 *
 * El snapshot público YA trae `objectives` (lo mantiene OverlayState): banderas
 * CTF con su estado, zonas de captura con dueño, y la marca de juggernaut. Las
 * BASES viajan en la cabecera del mundo (mapa). Las MINAS no son públicas: sólo
 * llegan por la capa de depuración del gateway y sólo a los tickets con permiso
 * (spectator.debug) — este módulo las incluye únicamente si ese permiso está.
 *
 * Aquí se DERIVA, de forma pura, la lista de objetos a pintar y su ESTADO; el
 * render (PhaserViewer) sólo coloca sprites. Sin Phaser: se prueba en Node.
 *
 * Regla honesta con los datos: una bandera sólo se dibuja donde su posición es
 * conocida públicamente — en base (la trae `objectives`) o llevada (sobre el
 * portador, cuya pose sí está en el snapshot). Caída en campo abierto sin
 * posición pública ⇒ no se inventa un punto.
 */

export type FlagDrawState = "at_base" | "carried" | "dropped" | "returning" | "captured";

export interface DrawableFlag {
  kind: "flag";
  team: string;
  state: FlagDrawState;
  /** Punto donde pintarla, o null si su posición no es pública (caída sin datos). */
  at: { x: number; y: number } | null;
  /** Id del portador cuando va `carried` (el render la sigue sobre su pose). */
  carrierId: string | null;
}

export interface DrawableBase {
  kind: "base";
  team: string;
  at: { x: number; y: number };
  radiusM: number;
}

export interface DrawableZone {
  kind: "zone";
  id: string;
  team: string;
  /** "neutral" | "held" | "contested"… tal cual lo publica el modo. */
  state: string;
  at: { x: number; y: number };
  radiusM: number;
}

export interface DrawableMine {
  kind: "mine";
  at: { x: number; y: number };
  team: string | null;
}

export interface ObjectivesLayer {
  flags: DrawableFlag[];
  bases: DrawableBase[];
  zones: DrawableZone[];
  mines: DrawableMine[];
}

export interface ObjectivesInput {
  /** `overlay.objectives`: array público de {kind, ...} (flag/zone/juggernaut). */
  objectives?: unknown;
  /** Bases del mapa (cabecera del mundo). Opcional: si no llega, no se pintan. */
  bases?: { team: string; position: { x: number; y: number }; radiusM?: number }[];
  /** team de bandera → id del portador (overlay.carriers), para banderas llevadas. */
  carriers?: Map<string, string>;
  /** Capa de depuración con minas (sólo llega con ticket debug). */
  mines?: { position?: { x: number; y: number }; x?: number; y?: number; team?: string }[];
  /** ¿El espectador tiene permiso para ver minas? (spectator.debug). */
  canSeeMines?: boolean;
}

const DEFAULT_BASE_RADIUS_M = 4;
const DEFAULT_ZONE_RADIUS_M = 6;

/** Extrae un punto {x,y} de varias formas toleradas; null si no es válido. */
function pointOf(p: any): { x: number; y: number } | null {
  const src = p?.position ?? p;
  if (src && Number.isFinite(src.x) && Number.isFinite(src.y)) return { x: src.x, y: src.y };
  return null;
}

/**
 * Construye la capa de objetivos a partir del estado público. Determinista y
 * tolerante a basura: entradas malformadas se descartan sin romper.
 */
export function buildObjectivesLayer(input: ObjectivesInput): ObjectivesLayer {
  const layer: ObjectivesLayer = { flags: [], bases: [], zones: [], mines: [] };
  const objectives = Array.isArray(input.objectives) ? input.objectives : [];
  const carriers = input.carriers ?? new Map<string, string>();

  for (const o of objectives) {
    if (!o || typeof o !== "object") continue;
    switch ((o as any).kind) {
      case "flag": {
        const team = String((o as any).team ?? "");
        if (!team) break;
        const state = ((o as any).state ?? "at_base") as FlagDrawState;
        const carrierId = state === "carried" ? (carriers.get(team) ?? null) : null;
        layer.flags.push({ kind: "flag", team, state, at: pointOf(o), carrierId });
        break;
      }
      case "zone": {
        const at = pointOf(o);
        if (!at) break;
        layer.zones.push({
          kind: "zone",
          id: String((o as any).id ?? ""),
          team: String((o as any).team ?? "neutral"),
          state: String((o as any).state ?? "neutral"),
          at,
          radiusM: Number.isFinite((o as any).radiusM) ? (o as any).radiusM : DEFAULT_ZONE_RADIUS_M,
        });
        break;
      }
      // juggernaut y otros objetivos SIN posición pública no se dibujan sobre el
      // mapa (van al HUD de R3.6); aquí se ignoran a propósito, sin inventar punto.
      default:
        break;
    }
  }

  for (const b of input.bases ?? []) {
    const at = pointOf(b);
    if (!at) continue;
    layer.bases.push({
      kind: "base",
      team: String(b.team ?? ""),
      at,
      radiusM: Number.isFinite(b.radiusM) ? (b.radiusM as number) : DEFAULT_BASE_RADIUS_M,
    });
  }

  // Minas: SÓLO si el espectador tiene permiso. Sin permiso, la lista queda vacía
  // aunque lleguen datos — es el control de visibilidad por permisos de la tarea.
  if (input.canSeeMines) {
    for (const m of input.mines ?? []) {
      const at = pointOf(m);
      if (!at) continue;
      layer.mines.push({ kind: "mine", at, team: typeof m.team === "string" ? m.team : null });
    }
  }

  return layer;
}

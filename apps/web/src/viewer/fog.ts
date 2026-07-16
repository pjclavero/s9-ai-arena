/**
 * T8.2 · Niebla de guerra OPCIONAL del espectador: ver la batalla "como la ve un
 * equipo". Solo se puede activar si el ruleset lo permite (init.spectator.allowFogView,
 * que el gateway toma del ruleset — ADR-000: todo configurable por ruleset).
 *
 * HONESTIDAD TÉCNICA: el canal de espectador transporta EXCLUSIVAMENTE el snapshot
 * público (D8) y NO incluye qué ve exactamente cada sensor (eso es privado del bot,
 * T2.4). Esta vista es por tanto una APROXIMACIÓN client-side por radio de visión
 * (configurable), no la niebla exacta del motor. Para la niebla exacta haría falta
 * que E2 publicara la visibilidad por equipo en el snapshot — anotado en la entrega
 * como pendiente de reconciliación con E2. Lo que NUNCA ocurre es lo contrario:
 * enseñar información que el stream no trae (las minas ocultas, p. ej., no llegan).
 */

export interface FogOptions {
  /** Lo que dijo el servidor en init: sin esto la vista ni se ofrece. */
  allowFogView: boolean;
  enabled: boolean;
  team: string;
  /** Radio de visión aproximado en metros (por defecto, alcance de radar MVP). */
  visionRadiusM?: number;
}

/**
 * Filtra un snapshot público a la perspectiva de un equipo. Devuelve el snapshot
 * intacto si la vista no está permitida o no está activada.
 */
export function applyFog(snapshot: any, opts: FogOptions): any {
  if (!snapshot || !opts.allowFogView || !opts.enabled) return snapshot;
  const radius = opts.visionRadiusM ?? 50;
  const own = (snapshot.vehicles ?? []).filter((v: any) => v.team === opts.team && v.alive && v.position);

  const visible = (pos: { x: number; y: number } | null): boolean => {
    if (!pos) return false;
    return own.some((v: any) => Math.hypot(v.position.x - pos.x, v.position.y - pos.y) <= radius);
  };

  return {
    ...snapshot,
    vehicles: (snapshot.vehicles ?? []).filter((v: any) => v.team === opts.team || visible(v.position)),
    projectiles: (snapshot.projectiles ?? []).filter((p: any) => visible(p.position)),
    // score y objectives son públicos por definición (marcador): no se ocultan.
  };
}

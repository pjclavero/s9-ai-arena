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

// ───────────────────────── R3.2 · niebla DESPUÉS de interpolar (ERR-VIS-07)

/**
 * Filtrar el snapshot ANTES del interpolador (lo que hacía T8.2 vía applyFog en
 * pushSnapshot) rompe la interpolación: un enemigo que entra en visión "no
 * existe" en el snapshot anterior y aparece de golpe (teletransporte), y uno que
 * sale parpadea en el borde del radio con cada oscilación de distancia.
 *
 * R3.2 lo invierte: el interpolador trabaja SIEMPRE con el snapshot íntegro y la
 * niebla se aplica al FRAME YA INTERPOLADO con:
 *  - histéresis: se hace visible al entrar en `visionRadiusM` y solo deja de
 *    serlo al superar `visionRadiusM + hysteresisM` — sin parpadeo en el borde;
 *  - fundido de alfa: la visibilidad objetivo (0|1) se persigue a velocidad
 *    `fadeMs`, así aparecer/desaparecer es un fundido, nunca un salto.
 *
 * Estado por entidad (alfas) persistente entre frames; puro respecto al reloj:
 * avanza con el dtMs que le pasa el llamante. Sin Phaser, probado con vitest.
 */

export interface FogFadeOptions extends FogOptions {
  /** Margen de histéresis en metros sobre el radio de visión. */
  hysteresisM?: number;
  /** Duración del fundido completo 0↔1 en ms. */
  fadeMs?: number;
}

export interface FadedVehicle {
  x: number;
  y: number;
  heading: number;
  turretHeading: number;
  alive: boolean;
  team?: string;
  /** 0 = invisible, 1 = plenamente visible. */
  alpha: number;
}

interface FrameLike {
  tick: number;
  vehicles: Map<
    string,
    { x: number; y: number; heading: number; turretHeading: number; alive: boolean; team?: string }
  >;
  projectiles: { id: string; x: number; y: number }[];
}

export class FogFader {
  /** id → alfa actual (persistente entre frames para poder fundir). */
  private alphas = new Map<string, number>();
  /** id → última decisión de visibilidad (para la histéresis). */
  private visibleNow = new Map<string, boolean>();

  /** Reset (reconexión/seek/cambio de equipo): sin fundidos a través del hueco. */
  reset(): void {
    this.alphas.clear();
    this.visibleNow.clear();
  }

  /**
   * Aplica niebla + fundido al frame interpolado. Devuelve vehículos con alfa y
   * proyectiles filtrados (estos sí a corte seco: un punto de 2 px no necesita
   * fundido y ocultarlo tarde filtraría información).
   */
  apply(
    frame: FrameLike,
    opts: FogFadeOptions,
    dtMs: number,
  ): { tick: number; vehicles: Map<string, FadedVehicle>; projectiles: { id: string; x: number; y: number }[] } {
    const active = opts.allowFogView && opts.enabled;
    const radius = opts.visionRadiusM ?? 50;
    const hysteresis = opts.hysteresisM ?? Math.max(2, radius * 0.1);
    const fadeMs = opts.fadeMs ?? 400;
    const step = fadeMs <= 0 ? 1 : Math.min(1, dtMs / fadeMs);

    const own = [...frame.vehicles.values()].filter((v) => v.team === opts.team && v.alive);
    const distToOwn = (x: number, y: number): number =>
      own.reduce((min, v) => Math.min(min, Math.hypot(v.x - x, v.y - y)), Infinity);

    const vehicles = new Map<string, FadedVehicle>();
    const seen = new Set<string>();
    for (const [id, v] of frame.vehicles) {
      seen.add(id);
      let target: boolean;
      if (!active || v.team === opts.team) {
        target = true;
      } else {
        const d = distToOwn(v.x, v.y);
        const wasVisible = this.visibleNow.get(id) ?? false;
        // Histéresis: entra en `radius`, sale en `radius + hysteresis`.
        target = wasVisible ? d <= radius + hysteresis : d <= radius;
      }
      this.visibleNow.set(id, target);
      const prev = this.alphas.get(id) ?? (target ? 1 : 0); // primera vez: sin fundido inicial
      const next = target ? Math.min(1, prev + step) : Math.max(0, prev - step);
      this.alphas.set(id, next);
      if (next > 0) vehicles.set(id, { ...v, alpha: next });
    }
    for (const id of [...this.alphas.keys()]) {
      if (!seen.has(id)) {
        this.alphas.delete(id);
        this.visibleNow.delete(id);
      }
    }

    const projectiles = active
      ? frame.projectiles.filter((p) => distToOwn(p.x, p.y) <= radius + hysteresis)
      : frame.projectiles;

    return { tick: frame.tick, vehicles, projectiles };
  }
}

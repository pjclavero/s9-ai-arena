/**
 * T8.2 · Interpolación en cliente: los snapshots llegan a 10 Hz y el render corre
 * a 60 fps; entre snapshot y snapshot las poses se interpolan linealmente (ángulos
 * por el arco corto). Sin esto el visor daría 10 "saltos" por segundo.
 *
 * R3.2 (ERR-VIS-06): la interpolación se hace sobre el DELTA DE TICKS — cada
 * snapshot se fecha en el eje de reproducción por su tick (tickToMs), nunca por
 * su instante de llegada — y con un buffer de varios snapshots, de modo que el
 * jitter de red no deforma el movimiento. El reloj de reproducción (DelayClock
 * en directo, playhead en replay) muestrea ese eje con ~2 intervalos de retardo.
 *
 * Puro y determinista: se prueba con números, sin Phaser ni navegador.
 */

export interface Pose {
  x: number;
  y: number;
  heading: number;
  turretHeading: number;
}

/** Interpolación de ángulo por el arco CORTO: de 350° a 10° se pasa por 0°, no por 180°. */
export function lerpAngle(a: number, b: number, t: number): number {
  const TAU = Math.PI * 2;
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface InterpolatedFrame {
  tick: number;
  /** id → pose interpolada. Los vehículos ausentes en alguno de los dos snapshots no saltan: se quedan en el que exista. */
  vehicles: Map<string, Pose & { alive: boolean; team?: string; alpha?: number }>;
  projectiles: { id: string; x: number; y: number }[];
}

/**
 * Mantiene los dos últimos snapshots y muestrea entre ellos por tiempo de llegada.
 * Renderiza "un snapshot por detrás" (técnica estándar de interpolación de estado):
 * a 10 Hz eso son 100 ms de latencia visual, imperceptible para un espectador.
 */
export class SnapshotInterpolator {
  private prev: { snapshot: any; at: number } | null = null;
  private next: { snapshot: any; at: number } | null = null;

  push(snapshot: any, receivedAtMs: number): void {
    if (this.next && snapshot.tick <= this.next.snapshot.tick) return; // duplicado o reordenado
    this.prev = this.next;
    this.next = { snapshot, at: receivedAtMs };
  }

  /** Reset total (reconexión con snapshot completo): no interpolar a través del hueco. */
  reset(snapshot: any, receivedAtMs: number): void {
    this.prev = null;
    this.next = { snapshot, at: receivedAtMs };
  }

  sampleAt(nowMs: number): InterpolatedFrame | null {
    if (!this.next) return null;
    if (!this.prev) return frameOf(this.next.snapshot, this.next.snapshot);

    // Render "un snapshot por detrás": en el instante de llegada de `next` se pinta
    // `prev` (t=0) y se avanza hacia `next` durante el intervalo siguiente.
    const span = this.next.at - this.prev.at;
    const t = span <= 0 ? 1 : clamp((nowMs - this.next.at) / span, 0, 1);
    return frameOf(this.prev.snapshot, this.next.snapshot, t);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function frameOf(a: any, b: any, t = 1): InterpolatedFrame {
  const vehicles = new Map<string, Pose & { alive: boolean; team?: string; alpha?: number }>();
  const aById = new Map<string, any>((a.vehicles ?? []).map((v: any) => [v.id, v]));
  for (const vb of b.vehicles ?? []) {
    const va = aById.get(vb.id);
    if (!va || !va.position || !vb.position) {
      if (vb.position) {
        vehicles.set(vb.id, {
          x: vb.position.x,
          y: vb.position.y,
          heading: vb.heading,
          turretHeading: vb.turretHeading,
          alive: vb.alive,
          team: vb.team,
        });
      }
      continue;
    }
    vehicles.set(vb.id, {
      x: lerp(va.position.x, vb.position.x, t),
      y: lerp(va.position.y, vb.position.y, t),
      heading: lerpAngle(va.heading, vb.heading, t),
      turretHeading: lerpAngle(va.turretHeading, vb.turretHeading, t),
      alive: vb.alive,
      team: vb.team,
    });
  }
  const aProj = new Map<string, any>((a.projectiles ?? []).map((p: any) => [p.id, p]));
  const projectiles = (b.projectiles ?? []).map((pb: any) => {
    const pa = aProj.get(pb.id);
    return pa
      ? { id: pb.id, x: lerp(pa.position.x, pb.position.x, t), y: lerp(pa.position.y, pb.position.y, t) }
      : { id: pb.id, x: pb.position.x, y: pb.position.y };
  });
  return { tick: b.tick, vehicles, projectiles };
}

// ─────────────────────────────────── R3.2 · buffer sobre delta de ticks (ERR-VIS-06)

/**
 * Buffer de interpolación de R3.2: guarda VARIOS snapshots ordenados por su
 * instante en el eje de reproducción (ms de partida derivados del tick, no
 * tiempo de llegada) y muestrea entre el par que encierra al reloj. Con el
 * reloj de reproducción retrasado ~2 intervalos (DelayClock / playhead), el
 * jitter de llegada deja de deformar el movimiento: el parámetro t es SIEMPRE
 * proporción del delta de ticks real entre snapshots.
 */
export class InterpolationBuffer {
  /** Ordenado por atMs ascendente. */
  private buf: { snapshot: any; atMs: number }[] = [];
  private readonly maxSnapshots: number;

  constructor(maxSnapshots = 32) {
    this.maxSnapshots = maxSnapshots;
  }

  push(snapshot: any, atMs: number): void {
    // Duplicados o reordenados por tick: se ignoran (el eje es monótono).
    if (this.buf.some((e) => e.snapshot.tick === snapshot.tick)) return;
    this.buf.push({ snapshot, atMs });
    this.buf.sort((a, b) => a.atMs - b.atMs);
    if (this.buf.length > this.maxSnapshots) this.buf.splice(0, this.buf.length - this.maxSnapshots);
  }

  /** Reset total (reconexión o seek): no interpolar a través del hueco. */
  reset(snapshot: any, atMs: number): void {
    this.buf = [{ snapshot, atMs }];
  }

  get latest(): { snapshot: any; atMs: number } | null {
    return this.buf.at(-1) ?? null;
  }

  get oldest(): { snapshot: any; atMs: number } | null {
    return this.buf[0] ?? null;
  }

  /** Intervalo entre los dos últimos snapshots en ms de reproducción (delta de ticks). */
  get intervalMs(): number | null {
    if (this.buf.length < 2) return null;
    return this.buf.at(-1)!.atMs - this.buf.at(-2)!.atMs;
  }

  /**
   * Muestrea el eje de reproducción en tMs. Entre dos snapshots interpola con
   * t = proporción del delta de ticks; antes del primero devuelve el primero;
   * después del último, se queda en el último (sin extrapolar vehículos — los
   * proyectiles rápidos los extrapola BallisticsTracker, no este buffer).
   */
  sampleAt(tMs: number): InterpolatedFrame | null {
    if (this.buf.length === 0) return null;
    if (tMs <= this.buf[0].atMs || this.buf.length === 1) return frameOf(this.buf[0].snapshot, this.buf[0].snapshot);
    for (let i = this.buf.length - 1; i >= 1; i--) {
      const a = this.buf[i - 1];
      const b = this.buf[i];
      if (tMs >= b.atMs && i === this.buf.length - 1) return frameOf(b.snapshot, b.snapshot);
      if (tMs >= a.atMs && tMs <= b.atMs) {
        const span = b.atMs - a.atMs;
        const t = span <= 0 ? 1 : (tMs - a.atMs) / span;
        return frameOf(a.snapshot, b.snapshot, t);
      }
    }
    return frameOf(this.buf[0].snapshot, this.buf[0].snapshot);
  }
}

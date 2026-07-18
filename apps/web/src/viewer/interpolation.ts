/**
 * T8.2 · Interpolación en cliente: los snapshots llegan a 10 Hz y el render corre
 * a 60 fps; entre snapshot y snapshot las poses se interpolan linealmente (ángulos
 * por el arco corto). Sin esto el visor daría 10 "saltos" por segundo.
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
  vehicles: Map<string, Pose & { alive: boolean }>;
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
  const vehicles = new Map<string, Pose & { alive: boolean }>();
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

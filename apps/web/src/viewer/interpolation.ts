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

type FramePose = Pose & { alive: boolean; team?: string; alpha?: number };

/**
 * R3.3 (ERR-VIS-09) — Cuaderno de trabajo REUTILIZABLE de la interpolación: el
 * frame, sus poses, los puntos de proyectil y los índices auxiliares se asignan
 * UNA vez y se rellenan en cada muestreo. A 60 fps, el `frameOf` original
 * asignaba dos Maps + un objeto por vehículo + un array y un objeto por
 * proyectil POR FRAME: miles de asignaciones/s solo para tirar a GC (pausas =
 * tirones). El frame devuelto por `fill` es válido hasta la siguiente llamada
 * al MISMO scratch.
 */
class FrameScratch {
  private readonly frame: InterpolatedFrame = { tick: 0, vehicles: new Map(), projectiles: [] };
  private readonly poseCache = new Map<string, FramePose>();
  private readonly dotCache: { id: string; x: number; y: number }[] = [];
  private readonly aVehicles = new Map<string, any>();
  private readonly aProjectiles = new Map<string, any>();

  fill(a: any, b: any, t = 1): InterpolatedFrame {
    const out = this.frame;
    out.tick = b.tick;
    out.vehicles.clear();
    this.aVehicles.clear();
    for (const v of a.vehicles ?? []) this.aVehicles.set(v.id, v);
    for (const vb of b.vehicles ?? []) {
      if (!vb.position) continue;
      const va = this.aVehicles.get(vb.id);
      const pose = this.pose(vb.id);
      if (!va || !va.position) {
        pose.x = vb.position.x;
        pose.y = vb.position.y;
        pose.heading = vb.heading;
        pose.turretHeading = vb.turretHeading;
      } else {
        pose.x = lerp(va.position.x, vb.position.x, t);
        pose.y = lerp(va.position.y, vb.position.y, t);
        pose.heading = lerpAngle(va.heading, vb.heading, t);
        pose.turretHeading = lerpAngle(va.turretHeading, vb.turretHeading, t);
      }
      pose.alive = vb.alive;
      pose.team = vb.team;
      out.vehicles.set(vb.id, pose);
    }

    this.aProjectiles.clear();
    for (const p of a.projectiles ?? []) this.aProjectiles.set(p.id, p);
    let n = 0;
    for (const pb of b.projectiles ?? []) {
      let dot = this.dotCache[n];
      if (!dot) {
        dot = { id: "", x: 0, y: 0 };
        this.dotCache[n] = dot;
      }
      const pa = this.aProjectiles.get(pb.id);
      dot.id = pb.id;
      if (pa) {
        dot.x = lerp(pa.position.x, pb.position.x, t);
        dot.y = lerp(pa.position.y, pb.position.y, t);
      } else {
        dot.x = pb.position.x;
        dot.y = pb.position.y;
      }
      if (out.projectiles[n] !== dot) out.projectiles[n] = dot;
      n++;
    }
    out.projectiles.length = n;
    return out;
  }

  private pose(id: string): FramePose {
    let p = this.poseCache.get(id);
    if (!p) {
      p = { x: 0, y: 0, heading: 0, turretHeading: 0, alive: true };
      this.poseCache.set(id, p);
    }
    return p;
  }
}

/** Variante ASIGNADORA (compatibilidad T8.2/tests): un frame nuevo por llamada. */
function frameOf(a: any, b: any, t = 1): InterpolatedFrame {
  return new FrameScratch().fill(a, b, t);
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
  /** R3.3: cuaderno reutilizado — cero asignaciones por frame en el camino caliente. */
  private readonly scratch = new FrameScratch();

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
   *
   * R3.3: el frame devuelto se REUTILIZA — es válido hasta el siguiente
   * sampleAt de este buffer (el consumidor es el bucle de render, que lo dibuja
   * y lo suelta; nadie retiene frames entre vueltas).
   */
  sampleAt(tMs: number): InterpolatedFrame | null {
    if (this.buf.length === 0) return null;
    const fill = (a: any, b: any, t?: number): InterpolatedFrame => this.scratch.fill(a, b, t);
    if (tMs <= this.buf[0].atMs || this.buf.length === 1) return fill(this.buf[0].snapshot, this.buf[0].snapshot);
    for (let i = this.buf.length - 1; i >= 1; i--) {
      const a = this.buf[i - 1];
      const b = this.buf[i];
      if (tMs >= b.atMs && i === this.buf.length - 1) return fill(b.snapshot, b.snapshot);
      if (tMs >= a.atMs && tMs <= b.atMs) {
        const span = b.atMs - a.atMs;
        const t = span <= 0 ? 1 : (tMs - a.atMs) / span;
        return fill(a.snapshot, b.snapshot, t);
      }
    }
    return fill(this.buf[0].snapshot, this.buf[0].snapshot);
  }
}

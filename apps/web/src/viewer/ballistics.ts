/**
 * R3.2 · ERR-VIS-06 — Simulación balística LOCAL de proyectiles entre snapshots.
 *
 * Un proyectil a 60–120 m/s recorre 6–12 m entre dos snapshots (10 Hz): con solo
 * interpolación de posiciones, un proyectil que nace y muere dentro de un mismo
 * intervalo se ve un único frame (parpadeo) o directamente no se ve. Este módulo
 * mantiene por proyectil su última posición observada y su velocidad — la que
 * traiga el snapshot si algún día la publica (campo opcional, compatible hacia
 * delante) o la estimada con el delta de posiciones / delta de ticks — y lo
 * INTEGRA localmente en cada frame de render: pos(t) = pos0 + v·(t − t0).
 *
 * Ciclo de vida honesto con los datos del stream:
 *  - visto en ≥1 snapshot → se dibuja desde su primera observación;
 *  - desaparecido del último snapshot → siguió volando hasta algún punto del
 *    intervalo: se extrapola con su velocidad hasta el instante del snapshot en
 *    el que ya no está (impacto/expiración) y ahí se retira — trayectoria
 *    completa, nunca un punto congelado.
 *
 * Puro y determinista: sin Phaser, sin reloj de pared. Se prueba con números.
 */

export interface ProjectileDot {
  id: string;
  x: number;
  y: number;
}

interface TrackedProjectile {
  id: string;
  /** Última posición observada en un snapshot y su instante (eje de reproducción). */
  x: number;
  y: number;
  atMs: number;
  /** m/ms. Null hasta la segunda observación (o si el snapshot no trae velocity). */
  vx: number | null;
  vy: number | null;
  /** Primer instante en el que se observó (no dibujar antes: aún no existía). */
  bornAtMs: number;
  /** Instante del snapshot en el que YA NO está (impacto). Null = sigue vivo. */
  deadAtMs: number | null;
}

export class BallisticsTracker {
  private tracked = new Map<string, TrackedProjectile>();
  private lastObservedAtMs: number | null = null;

  /** Alimenta el tracker con cada snapshot fechado en el eje de reproducción. */
  observe(snapshot: any, atMs: number): void {
    // Reordenados/duplicados: el eje es monótono, se ignoran.
    if (this.lastObservedAtMs !== null && atMs <= this.lastObservedAtMs) return;
    const seen = new Set<string>();
    for (const p of snapshot?.projectiles ?? []) {
      if (!p?.position) continue;
      seen.add(p.id);
      const prev = this.tracked.get(p.id);
      const fromSnapshot =
        p.velocity && Number.isFinite(p.velocity.x)
          ? { vx: p.velocity.x / 1000, vy: p.velocity.y / 1000 } // m/s → m/ms
          : null;
      if (!prev) {
        this.tracked.set(p.id, {
          id: p.id,
          x: p.position.x,
          y: p.position.y,
          atMs,
          vx: fromSnapshot?.vx ?? null,
          vy: fromSnapshot?.vy ?? null,
          bornAtMs: atMs,
          deadAtMs: null,
        });
        continue;
      }
      const dt = atMs - prev.atMs;
      const estimated = dt > 0 ? { vx: (p.position.x - prev.x) / dt, vy: (p.position.y - prev.y) / dt } : null;
      prev.x = p.position.x;
      prev.y = p.position.y;
      prev.atMs = atMs;
      const v = fromSnapshot ?? estimated;
      if (v) {
        prev.vx = v.vx;
        prev.vy = v.vy;
      }
      prev.deadAtMs = null;
    }
    // Ausentes en este snapshot: impactaron en algún punto del intervalo. Se les
    // deja volar (extrapolación) hasta el instante de ESTE snapshot y se retiran.
    for (const t of this.tracked.values()) {
      if (!seen.has(t.id) && t.deadAtMs === null) t.deadAtMs = atMs;
    }
    this.lastObservedAtMs = atMs;
    // Purga: muertos cuyos restos ya no pueden aparecer en ningún muestreo futuro.
    for (const [id, t] of this.tracked) {
      if (t.deadAtMs !== null && atMs - t.deadAtMs > 5000) this.tracked.delete(id);
    }
  }

  /** Reset total (reconexión o seek): no arrastrar trayectorias a través del hueco. */
  reset(snapshot: any, atMs: number): void {
    this.tracked.clear();
    this.lastObservedAtMs = null;
    this.observe(snapshot, atMs);
  }

  /**
   * Posiciones simuladas en el instante tMs del eje de reproducción.
   * Sin velocidad conocida el proyectil se dibuja donde se observó (mejor un
   * punto de verdad que una trayectoria inventada).
   */
  sampleAt(tMs: number): ProjectileDot[] {
    const out: ProjectileDot[] = [];
    for (const t of this.tracked.values()) {
      if (tMs < t.bornAtMs) continue; // aún no existía
      if (t.deadAtMs !== null && tMs > t.deadAtMs) continue; // ya impactó
      if (t.vx === null || t.vy === null) {
        out.push({ id: t.id, x: t.x, y: t.y });
        continue;
      }
      const dt = tMs - t.atMs;
      out.push({ id: t.id, x: t.x + t.vx * dt, y: t.y + t.vy * dt });
    }
    return out;
  }
}

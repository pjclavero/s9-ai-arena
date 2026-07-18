/**
 * R3.3 · ERR-VIS-11 — El tick del replay fuera de React.
 *
 * Antes, ReplayPage hacía `setTick(...)` en CADA vuelta del RAF: React
 * re-renderizaba la página entera a 60 fps para mover un número. R3.3 guarda el
 * tick en un ref y solo publica al estado de React a ~4 Hz (o al terminar el
 * replay). Este módulo es la política PURA de publicación — probada con vitest;
 * la página solo la cablea.
 */

export const UI_PUBLISH_INTERVAL_MS = 250; // ~4 Hz

/** Decide cuándo toca publicar al estado de React. Puro respecto al reloj. */
export class UiThrottle {
  private lastEmitMs: number | null = null;

  constructor(private readonly intervalMs = UI_PUBLISH_INTERVAL_MS) {}

  /** True como mucho una vez por intervalo (y siempre en la primera llamada). */
  shouldEmit(nowMs: number): boolean {
    if (this.lastEmitMs !== null && nowMs - this.lastEmitMs < this.intervalMs) return false;
    this.lastEmitMs = nowMs;
    return true;
  }

  /** Fuerza la próxima publicación (p. ej. tras un seek o al terminar). */
  reset(): void {
    this.lastEmitMs = null;
  }
}

/**
 * Publicador del tick del replay: recibe el tick de CADA frame del RAF y llama
 * a `emit` como mucho a `intervalMs` — salvo `finished`, que publica siempre
 * (el estado final nunca se queda a medio intervalo de distancia).
 */
export class ReplayTickPublisher {
  private readonly throttle: UiThrottle;

  constructor(
    private readonly emit: (tick: number) => void,
    intervalMs = UI_PUBLISH_INTERVAL_MS,
  ) {
    this.throttle = new UiThrottle(intervalMs);
  }

  onFrame(nowMs: number, tick: number, finished = false): void {
    if (finished) {
      this.throttle.reset();
      this.throttle.shouldEmit(nowMs);
      this.emit(tick);
      return;
    }
    if (this.throttle.shouldEmit(nowMs)) this.emit(tick);
  }

  /** Publicación inmediata (tras un seek: la UI aterriza donde el usuario soltó). */
  force(nowMs: number, tick: number): void {
    this.throttle.reset();
    this.throttle.shouldEmit(nowMs);
    this.emit(tick);
  }
}

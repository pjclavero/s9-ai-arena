/**
 * R3.1 · ERR-VIS-01 — El replay interpola como el directo.
 *
 * Antes, ReplayPage llamaba a `scene.resetTo(snapshot, performance.now())` en CADA
 * frame: el interpolador nunca tenía dos snapshots entre los que interpolar y el
 * replay se veía a ~10 saltos por segundo, mientras el directo (pushSnapshot por
 * snapshot recibido) se veía fluido.
 *
 * Este módulo es el cableado PURO entre ReplayPlayer y la escena, probado con
 * vitest sin Phaser ni navegador:
 *
 * - Fija el reloj de reproducción de la escena al playhead del reproductor
 *   (`player.playheadMs`), de modo que el interpolador se muestrea en el MISMO eje
 *   temporal en el que se fechan los snapshots (ms de partida, no reloj de pared).
 * - `pushSnapshot(snapshot, tickToMs(tick))` cada vez que el playhead cruza un
 *   snapshot NUEVO (no cada frame): igual que en directo, el interpolador conserva
 *   prev+next y rellena los 60 fps entre ambos.
 * - `resetTo` SOLO tras un seek (init incluido): reposiciona sin arrastrar
 *   interpolación del tramo anterior y admite saltos hacia atrás (que `push`
 *   descartaría como reordenados).
 */
import { ReplayPlayer, tickToMs, type AdvanceResult } from "./replay-player.js";

/** Lo mínimo que la ReplayFeed necesita de la escena (ViewerScene lo cumple). */
export interface PlaybackScene {
  setPlaybackClock(clock: () => number): void;
  pushSnapshot(snapshot: any, atMs?: number): void;
  resetTo(snapshot: any, atMs?: number): void;
  pushEvent(event: any): void;
}

export class ReplayFeed {
  private lastPushedTick = -1;
  /** El próximo snapshot entra con resetTo: al arrancar y tras cada seek. */
  private pendingReset = true;

  constructor(
    private readonly player: ReplayPlayer,
    private readonly scene: PlaybackScene,
  ) {
    scene.setPlaybackClock(() => player.playheadMs);
  }

  /**
   * Un frame del bucle de render: avanza el reproductor y alimenta la escena.
   * Devuelve el resultado del avance para que la página actualice su UI.
   */
  async frame(realDtMs: number): Promise<AdvanceResult> {
    const result = await this.player.advance(realDtMs);
    const s = result.snapshot;
    if (s && (this.pendingReset || s.tick !== this.lastPushedTick)) {
      // Fechado en ms de PARTIDA derivados del tick, nunca performance.now():
      // así el intervalo entre snapshots es su distancia real en juego y la
      // interpolación es idéntica a cualquier velocidad de reproducción.
      const atMs = tickToMs(s.tick);
      if (this.pendingReset) {
        this.scene.resetTo(s, atMs);
        this.pendingReset = false;
      } else {
        this.scene.pushSnapshot(s, atMs);
      }
      this.lastPushedTick = s.tick;
    }
    for (const e of result.events) this.scene.pushEvent(e);
    return result;
  }

  /**
   * Salto por barra temporal: reposiciona la escena AHORA, incluso en pausa. El
   * `signal` (R3.3) permite que un seek posterior aborte éste: si se abortó
   * durante la descarga, seekTick lanza AbortError y no tocamos la escena.
   */
  async seek(tick: number, signal?: AbortSignal): Promise<void> {
    await this.player.seekTick(tick, signal);
    this.pendingReset = true;
    this.lastPushedTick = -1;
    await this.frame(0);
  }
}

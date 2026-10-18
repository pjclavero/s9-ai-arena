/**
 * FC-D (D3, TD-009) · Espera REAL a que la escena del visor exista y haya
 * ejecutado su `create()`.
 *
 * Por qué: en Phaser 4 las escenas declaradas en la configuración del juego se
 * registran en `SceneManager.bootQueue`, que corre en el evento `READY` del juego
 * (asíncrono: lo emite el gestor de texturas al terminar). Hasta entonces
 * `game.scene.getScene("viewer")` devuelve `null`. Las páginas (ReplayPage,
 * ViewerPage, BroadcastPage) pedían la escena justo después de `new Phaser.Game`
 * y recibían `null` → `TypeError … setPlaybackClock`, lienzo vacío y «tick 0/N».
 *
 * Nada de `sleep`: se espera a las dos señales de Phaser, en orden:
 *  1. `READY` del juego (si aún no está en marcha: `game.isRunning === false`);
 *  2. `CREATE` de la escena (si su estado aún no ha llegado a RUNNING).
 *
 * El módulo es puro (no importa Phaser) para poder probarlo con un juego falso
 * que reproduce el orden de eventos de Phaser 4.2.1; `PhaserViewer.ts` lo cablea
 * con las constantes reales.
 */

export interface EmitterLike {
  once(event: string, fn: (...args: unknown[]) => void): unknown;
  off?(event: string, fn: (...args: unknown[]) => void): unknown;
}

export interface SceneLike {
  sys: { settings: { status: number } };
  events: EmitterLike;
}

export interface GameLike<S extends SceneLike> {
  isRunning: boolean;
  events: EmitterLike;
  scene: { getScene(key: string): S | null };
}

export interface SceneReadyConstants {
  /** `Phaser.Core.Events.READY` */
  gameReadyEvent: string;
  /** `Phaser.Core.Events.DESTROY` */
  gameDestroyEvent: string;
  /** `Phaser.Scenes.Events.CREATE` */
  sceneCreateEvent: string;
  /** `Phaser.Scenes.RUNNING` */
  runningStatus: number;
}

export class SceneNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneNotReadyError";
  }
}

/** Plazo por defecto: un navegador sin WebGL ni Canvas no debe dejar «cargando…» eterno. */
export const SCENE_READY_TIMEOUT_MS = 15_000;

export function waitForScene<S extends SceneLike>(
  game: GameLike<S>,
  key: string,
  k: SceneReadyConstants,
  timeoutMs = SCENE_READY_TIMEOUT_MS,
): Promise<S> {
  return new Promise<S>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, scene?: S) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      game.events.off?.(k.gameDestroyEvent, onDestroy);
      if (err) reject(err);
      else resolve(scene as S);
    };
    const onDestroy = () => finish(new SceneNotReadyError("el visor se cerró antes de inicializarse"));
    const timer = setTimeout(
      () => finish(new SceneNotReadyError(`el visor no se inicializó en ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    );
    game.events.once(k.gameDestroyEvent, onDestroy);

    const withScene = () => {
      const scene = game.scene.getScene(key);
      if (!scene) {
        finish(new SceneNotReadyError(`la escena "${key}" no existe tras el arranque de Phaser`));
        return;
      }
      if (scene.sys.settings.status >= k.runningStatus) finish(null, scene);
      else scene.events.once(k.sceneCreateEvent, () => finish(null, scene));
    };

    if (game.isRunning) withScene();
    else game.events.once(k.gameReadyEvent, withScene);
  });
}

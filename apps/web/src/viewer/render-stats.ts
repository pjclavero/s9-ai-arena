/**
 * R3.3 · ERR-VIS-11 — Medición de rendimiento del visor: FPS y draw calls.
 *
 * - FpsMeter: ventana deslizante de instantes de frame → fps medios y peor
 *   hueco entre frames. Puro (el reloj lo pasa el llamante), probado con vitest.
 * - DrawCallCounter + instrumentWebGL: envuelve drawElements/drawArrays del
 *   contexto WebGL y cuenta las llamadas REALES por frame — el número que el
 *   DoD exige bajar de ~35 a un puñado. Sin contexto WebGL no hay medida:
 *   `lastFrame` queda en null (fail-closed: nunca se inventa un cero optimista).
 * - attachRenderStats: cablea ambos al bucle de Phaser (PRE_RENDER/POST_RENDER)
 *   y publica el handle en `window.__s9perf` para la prueba de Playwright;
 *   opcionalmente pinta un overlay DOM actualizado a 4 Hz (fuera del RAF: el
 *   contador jamás debe costar frames).
 */
// Phaser sólo se usa por TIPOS aquí: importarlo como valor arrastraría todo el
// motor (y su acceso a `navigator`) al cargar el módulo, y con él las clases
// PURAS de medición (FpsMeter/DrawCallCounter) dejarían de ser testeables en
// Node sin navegador. Con `import type` este módulo no carga Phaser en runtime.
import type Phaser from "phaser";

/** Constantes de eventos del core de Phaser (valores estables de la API). */
const EV_PRE_RENDER = "prerender";
const EV_POST_RENDER = "postrender";
const EV_DESTROY = "destroy";

// ───────────────────────────────────────────────────────────── FPS

export class FpsMeter {
  private readonly windowMs: number;
  private times: number[] = [];

  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
  }

  /** Registra un frame en nowMs (mismo reloj monótono en todas las llamadas). */
  frame(nowMs: number): void {
    this.times.push(nowMs);
    // Purga por el frente: la ventana es corta (~120 frames), coste amortizado O(1).
    while (this.times.length > 1 && nowMs - this.times[0] > this.windowMs) this.times.shift();
  }

  /** FPS medios de la ventana. Null hasta tener al menos 2 frames (fail-closed). */
  get fps(): number | null {
    if (this.times.length < 2) return null;
    const span = this.times[this.times.length - 1] - this.times[0];
    if (span <= 0) return null;
    return ((this.times.length - 1) * 1000) / span;
  }

  /** Peor hueco entre frames consecutivos de la ventana (ms): delata los stalls. */
  get worstFrameMs(): number | null {
    if (this.times.length < 2) return null;
    let worst = 0;
    for (let i = 1; i < this.times.length; i++) worst = Math.max(worst, this.times[i] - this.times[i - 1]);
    return worst;
  }

  reset(): void {
    this.times = [];
  }
}

// ─────────────────────────────────────────────────────── draw calls

export class DrawCallCounter {
  private current = 0;
  /** Draw calls del último frame COMPLETO. Null hasta cerrar el primer frame. */
  lastFrame: number | null = null;

  beginFrame(): void {
    this.current = 0;
  }

  count(): void {
    this.current++;
  }

  endFrame(): void {
    this.lastFrame = this.current;
  }
}

/** Lo mínimo del contexto WebGL que se instrumenta (tipado estructural para tests). */
export interface GLLike {
  drawElements: (...args: any[]) => void;
  drawArrays: (...args: any[]) => void;
  drawElementsInstanced?: (...args: any[]) => void;
  drawArraysInstanced?: (...args: any[]) => void;
}

/**
 * Envuelve las llamadas de dibujo del contexto para contarlas. Devuelve la
 * función que restaura el contexto original.
 */
export function instrumentWebGL(gl: GLLike, counter: DrawCallCounter): () => void {
  const names = ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"] as const;
  const originals: Partial<Record<(typeof names)[number], (...args: any[]) => void>> = {};
  for (const name of names) {
    const fn = gl[name];
    if (typeof fn !== "function") continue;
    originals[name] = fn;
    gl[name] = function (this: unknown, ...args: any[]) {
      counter.count();
      return fn.apply(this === undefined ? gl : this, args);
    };
  }
  return () => {
    for (const name of names) {
      if (originals[name]) gl[name] = originals[name]!;
    }
  };
}

// ──────────────────────────────────────────── cableado a Phaser + overlay

export interface PerfHandle {
  /** FPS medios de la ventana (null hasta tener muestras). */
  fps(): number | null;
  /** Peor hueco entre frames de la ventana, en ms. */
  worstFrameMs(): number | null;
  /** Draw calls del último frame (null si no hay contexto WebGL instrumentable). */
  drawCalls(): number | null;
  dispose(): void;
}

export interface RenderStatsOptions {
  /** Si se da, se pinta un overlay DOM (esquina superior izquierda) a 4 Hz. */
  overlayParent?: HTMLElement;
  /** Reloj inyectable (tests). */
  now?: () => number;
}

const OVERLAY_INTERVAL_MS = 250; // 4 Hz: el overlay jamás compite con el render

export function attachRenderStats(game: Phaser.Game, opts: RenderStatsOptions = {}): PerfHandle {
  const now = opts.now ?? (() => performance.now());
  const meter = new FpsMeter();
  const counter = new DrawCallCounter();

  const gl: GLLike | null = (game.renderer as unknown as { gl?: GLLike })?.gl ?? null;
  const restoreGL = gl ? instrumentWebGL(gl, counter) : null;

  const onPre = (): void => counter.beginFrame();
  const onPost = (): void => {
    counter.endFrame();
    meter.frame(now());
  };
  game.events.on(EV_PRE_RENDER, onPre);
  game.events.on(EV_POST_RENDER, onPost);

  let overlay: HTMLElement | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (opts.overlayParent) {
    overlay = document.createElement("div");
    overlay.dataset.testid = "perf-overlay";
    overlay.style.cssText =
      "position:absolute;top:4px;left:4px;z-index:10;padding:2px 6px;" +
      "background:rgba(0,0,0,0.6);color:#7fe3a1;font:12px monospace;pointer-events:none;";
    const parent = opts.overlayParent;
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    parent.appendChild(overlay);
    timer = setInterval(() => {
      const fps = meter.fps;
      const dc = restoreGL ? counter.lastFrame : null;
      overlay!.textContent =
        `${fps === null ? "--" : fps.toFixed(1)} fps · ` +
        `${dc === null ? "sin WebGL" : `${dc} draw calls`} · ` +
        `peor ${meter.worstFrameMs === null ? "--" : meter.worstFrameMs.toFixed(1)} ms`;
    }, OVERLAY_INTERVAL_MS);
  }

  const handle: PerfHandle = {
    fps: () => meter.fps,
    worstFrameMs: () => meter.worstFrameMs,
    drawCalls: () => (restoreGL ? counter.lastFrame : null),
    dispose: () => {
      game.events.off(EV_PRE_RENDER, onPre);
      game.events.off(EV_POST_RENDER, onPost);
      restoreGL?.();
      if (timer) clearInterval(timer);
      overlay?.remove();
    },
  };
  game.events.once(EV_DESTROY, () => handle.dispose());
  return handle;
}

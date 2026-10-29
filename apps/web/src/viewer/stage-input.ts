/**
 * UX-VIEW · Cableado DOM de la entrada del escenario (rueda, punteros y teclado).
 *
 * Sustituye a la entrada de Phaser, que tenía tres defectos de UX:
 *  - el TECLADO escuchaba en `window`: pulsar 1–8 o G en cualquier campo de la
 *    página movía la cámara. Aquí sólo escucha el elemento del escenario, que es
 *    enfocable (tabIndex) y se enfoca al pulsarlo;
 *  - la RUEDA no se consumía y la página hacía scroll a la vez que el zoom: aquí
 *    el listener no es pasivo y hace preventDefault sobre el escenario;
 *  - un solo puntero, sin táctil ni pinch: aquí Pointer Events con captura y
 *    `touch-action: none` en el escenario (sólo en él: fuera, el scroll y los
 *    gestos del navegador siguen siendo los normales).
 *
 * La lógica de gestos es pura (stage-gestures.ts); aquí sólo se traducen eventos.
 */
import { GestureTracker, stageKeyCommand, type StageKeyCommand } from "./stage-gestures.js";
import { normalizeWheelDelta } from "./view-scale.js";

export interface StageInputTarget {
  /** Pan en píxeles de BÚFER (positivo = el mapa sigue al puntero). */
  pan(dx: number, dy: number): void;
  /** Zoom por un factor manteniendo fijo el punto (px de búfer) bajo el puntero. */
  zoomAt(factor: number, x: number, y: number): void;
  /** Toque/clic sin arrastre en (x, y) px de búfer. */
  tap(x: number, y: number): void;
  key(cmd: StageKeyCommand): void;
}

const WHEEL_STEP = 1.2; // mismo factor por muesca que CameraInteraction.onWheel

export function attachStageInput(
  el: HTMLElement,
  canvasOf: () => HTMLCanvasElement | null,
  target: StageInputTarget,
): () => void {
  const gestures = new GestureTracker();

  /** px CSS relativos al canvas y factor CSS→búfer. */
  const local = (ev: { clientX: number; clientY: number }) => {
    const c = canvasOf();
    const rect = (c ?? el).getBoundingClientRect();
    const k = c && rect.width > 0 ? c.width / rect.width : 1;
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top, k };
  };

  const onWheel = (ev: WheelEvent) => {
    // Sobre el escenario la rueda es zoom: la página NO hace scroll a la vez.
    ev.preventDefault();
    const d = normalizeWheelDelta(ev.deltaY, ev.deltaMode);
    if (d === 0) return;
    const p = local(ev);
    target.zoomAt(Math.pow(WHEEL_STEP, -d / 100), p.x * p.k, p.y * p.k);
  };

  const onDown = (ev: PointerEvent) => {
    if (ev.button !== undefined && ev.button > 0 && ev.pointerType === "mouse") return; // sólo botón principal
    el.focus({ preventScroll: true });
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      /* puntero sintético sin captura: se sigue igual */
    }
    const p = local(ev);
    gestures.down(ev.pointerId, { x: p.x, y: p.y }, ev.timeStamp || performance.now());
    ev.preventDefault(); // sin selección de texto ni arrastre de imagen al empezar
  };

  const onMove = (ev: PointerEvent) => {
    const p = local(ev);
    const a = gestures.move(ev.pointerId, { x: p.x, y: p.y });
    if (!a) return;
    if (a.kind === "pan") target.pan(a.dx * p.k, a.dy * p.k);
    else if (a.kind === "pinch") {
      target.zoomAt(a.factor, a.center.x * p.k, a.center.y * p.k);
      if (a.dx !== 0 || a.dy !== 0) target.pan(a.dx * p.k, a.dy * p.k);
    }
  };

  const onUp = (ev: PointerEvent) => {
    const p = local(ev);
    const a = gestures.up(ev.pointerId, { x: p.x, y: p.y }, ev.timeStamp || performance.now());
    if (a?.kind === "tap") target.tap(a.at.x * p.k, a.at.y * p.k);
  };

  const onCancel = (ev: PointerEvent) => gestures.cancel(ev.pointerId);

  const onKey = (ev: KeyboardEvent) => {
    const cmd = stageKeyCommand(ev);
    if (!cmd) return;
    ev.preventDefault(); // flechas/+/− no desplazan la página mientras el foco está en el escenario
    target.key(cmd);
  };

  const onDblClick = (ev: MouseEvent) => {
    const p = local(ev);
    target.zoomAt(WHEEL_STEP * WHEEL_STEP, p.x * p.k, p.y * p.k);
  };

  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancel);
  el.addEventListener("lostpointercapture", onCancel);
  el.addEventListener("keydown", onKey);
  el.addEventListener("dblclick", onDblClick);
  return () => {
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancel);
    el.removeEventListener("lostpointercapture", onCancel);
    el.removeEventListener("keydown", onKey);
    el.removeEventListener("dblclick", onDblClick);
  };
}

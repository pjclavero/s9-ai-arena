// @vitest-environment jsdom
/**
 * UX-VIEW · Bloque A3/D — pan con un dedo o arrastre, pinch, toque, rueda y
 * teclado del escenario.
 *
 *  - gestos puros (stage-gestures): umbral de toque, pan sin salto inicial,
 *    pinch con factor y punto medio, un dedo restante tras el pinch no salta;
 *  - cableado DOM (stage-input): la rueda hace preventDefault (la página no
 *    hace scroll), el teclado SÓLO escucha el escenario (antes `window`) y los
 *    atajos con Ctrl/Cmd siguen siendo del navegador.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GestureTracker, TAP_SLOP, stageKeyCommand } from "../src/viewer/stage-gestures.js";
import { attachStageInput } from "../src/viewer/stage-input.js";

describe("GestureTracker", () => {
  it("pulsar y soltar sin moverse = toque; moverse menos que el umbral también", () => {
    const g = new GestureTracker();
    g.down(1, { x: 10, y: 10 }, 0);
    expect(g.move(1, { x: 12, y: 11 })).toBeNull();
    expect(g.up(1, { x: 12, y: 11 }, 100)).toEqual({ kind: "tap", at: { x: 12, y: 11 } });
  });

  it("arrastre: el pan arranca desde el punto de inicio (sin perder ni saltar píxeles)", () => {
    const g = new GestureTracker();
    g.down(1, { x: 100, y: 100 }, 0);
    expect(g.move(1, { x: 100 + TAP_SLOP + 4, y: 100 })).toEqual({ kind: "pan", dx: TAP_SLOP + 4, dy: 0 });
    expect(g.move(1, { x: 130, y: 90 })).toEqual({ kind: "pan", dx: 130 - (100 + TAP_SLOP + 4), dy: -10 });
    // La suma de los pan = desplazamiento total del dedo: ni aceleración ni pérdida.
    expect(g.up(1, { x: 130, y: 90 }, 200)).toBeNull(); // no es toque
  });

  it("pinch: factor = distancia nueva / anterior, alrededor del punto medio", () => {
    const g = new GestureTracker();
    g.down(1, { x: 100, y: 100 }, 0);
    g.down(2, { x: 200, y: 100 }, 0);
    const a = g.move(2, { x: 300, y: 100 });
    expect(a).toMatchObject({ kind: "pinch", factor: 2, center: { x: 200, y: 100 } });
    // Al levantar un dedo, el otro no salta ni produce un toque.
    expect(g.up(2, { x: 300, y: 100 }, 50)).toBeNull();
    expect(g.move(1, { x: 140, y: 100 })).toBeNull();
    expect(g.up(1, { x: 140, y: 100 }, 60)).toBeNull();
    // Gesto siguiente: vuelve a funcionar el toque.
    g.down(3, { x: 5, y: 5 }, 100);
    expect(g.up(3, { x: 5, y: 5 }, 150)).toMatchObject({ kind: "tap" });
  });

  it("teclas: 1–8, G/0, +/−, F, C, N, flechas; con Ctrl/Cmd/Alt no son del visor", () => {
    expect(stageKeyCommand({ key: "3" })).toEqual({ kind: "follow-index", index: 2 });
    expect(stageKeyCommand({ key: "9" })).toBeNull();
    expect(stageKeyCommand({ key: "g" })).toEqual({ kind: "global" });
    expect(stageKeyCommand({ key: "+" })).toEqual({ kind: "zoom-in" });
    expect(stageKeyCommand({ key: "-" })).toEqual({ kind: "zoom-out" });
    expect(stageKeyCommand({ key: "f" })).toEqual({ kind: "fit" });
    expect(stageKeyCommand({ key: "c" })).toEqual({ kind: "center-selected" });
    expect(stageKeyCommand({ key: "ArrowLeft" })).toMatchObject({ kind: "pan", dy: 0 });
    expect(stageKeyCommand({ key: "+", ctrlKey: true })).toBeNull(); // zoom del navegador
    expect(stageKeyCommand({ key: "Tab" })).toBeNull();
  });
});

describe("attachStageInput (DOM)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function setup() {
    const el = document.createElement("div");
    el.tabIndex = 0;
    const canvas = document.createElement("canvas");
    canvas.width = 1920; // búfer = 2× CSS (dpr 2)
    canvas.height = 1280;
    el.appendChild(canvas);
    document.body.appendChild(el);
    canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 960, height: 640 }) as DOMRect;
    const target = { pan: vi.fn(), zoomAt: vi.fn(), tap: vi.fn(), key: vi.fn() };
    const detach = attachStageInput(el, () => canvas, target);
    return { el, canvas, target, detach };
  }

  function pointer(type: string, id: number, x: number, y: number): Event {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(ev, "pointerId", { value: id });
    Object.defineProperty(ev, "pointerType", { value: "touch" });
    return ev;
  }

  it("la rueda sobre el escenario hace zoom en el punto (px de búfer) y NO deja hacer scroll a la página", () => {
    const { el, target } = setup();
    const ev = new WheelEvent("wheel", { deltaY: -100, clientX: 110, clientY: 120, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(target.zoomAt).toHaveBeenCalledTimes(1);
    const [factor, x, y] = target.zoomAt.mock.calls[0];
    expect(factor).toBeCloseTo(1.2, 9);
    expect([x, y]).toEqual([200, 200]); // (110−10, 120−20) CSS × 2
  });

  it("el teclado sólo actúa con el foco en el escenario: en la página (window) no mueve la cámara", () => {
    const { el, target } = setup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
    expect(target.key).not.toHaveBeenCalled();
    const k = new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true });
    el.dispatchEvent(k);
    expect(target.key).toHaveBeenCalledWith({ kind: "follow-index", index: 1 });
    expect(k.defaultPrevented).toBe(true);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    el.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false); // Tab sigue saliendo del escenario
  });

  it("un dedo arrastra (pan en px de búfer) y un toque selecciona", () => {
    const { el, target } = setup();
    el.dispatchEvent(pointer("pointerdown", 7, 100, 100));
    el.dispatchEvent(pointer("pointermove", 7, 130, 100));
    expect(target.pan).toHaveBeenCalledWith(60, 0); // 30 px CSS × 2
    el.dispatchEvent(pointer("pointerup", 7, 130, 100));
    expect(target.tap).not.toHaveBeenCalled();
    el.dispatchEvent(pointer("pointerdown", 8, 50, 60));
    el.dispatchEvent(pointer("pointerup", 8, 50, 60));
    expect(target.tap).toHaveBeenCalledWith(80, 80);
  });

  it("pinch con dos dedos → zoomAt con el factor real", () => {
    const { el, target } = setup();
    el.dispatchEvent(pointer("pointerdown", 1, 110, 120));
    el.dispatchEvent(pointer("pointerdown", 2, 210, 120));
    el.dispatchEvent(pointer("pointermove", 2, 310, 120));
    expect(target.zoomAt).toHaveBeenCalledTimes(1);
    expect(target.zoomAt.mock.calls[0][0]).toBeCloseTo(2, 9);
  });

  it("al desmontar ya no escucha nada", () => {
    const { el, target, detach } = setup();
    detach();
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(target.zoomAt).not.toHaveBeenCalled();
    expect(target.key).not.toHaveBeenCalled();
  });
});

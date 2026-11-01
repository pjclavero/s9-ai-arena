/**
 * UX-EDITOR · shared/view-transform.ts: pantalla↔mundo, zoom en un punto, pan,
 * encajar, recorte y pellizco. Se comprueba además que la fórmula es LA MISMA que
 * la del visor (CameraInteraction.onWheel), que no se modifica.
 */
import { describe, expect, it } from "vitest";
import {
  clampCenter,
  clampZoom,
  fitView,
  panByPixels,
  pinchView,
  screenToWorld,
  wheelZoomFactor,
  worldToScreen,
  zoomAt,
  zoomTo,
} from "../src/shared/view-transform.js";
import { CameraInteraction } from "../src/viewer/camera-interaction.js";

const VP = { w: 800, h: 600 };
const LIM = { minZoom: 0.5, maxZoom: 40 };

describe("view-transform", () => {
  it("pantalla↔mundo son inversas y el centro de la vista cae en el centro del viewport", () => {
    const v = { centerX: 37, centerY: 12, zoom: 6.5 };
    expect(worldToScreen({ x: 37, y: 12 }, v, VP)).toEqual({ x: 400, y: 300 });
    for (const p of [
      { x: 0, y: 0 },
      { x: 123.4, y: -7 },
      { x: 799, y: 599 },
    ]) {
      const back = worldToScreen(screenToWorld(p, v, VP), v, VP);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it("zoomAt deja QUIETO el punto del mundo bajo el cursor y respeta los límites", () => {
    const v = { centerX: 60, centerY: 40, zoom: 5 };
    const cursor = { x: 130, y: 470 };
    const before = screenToWorld(cursor, v, VP);
    const z = zoomAt(v, 2.5, cursor, VP, LIM);
    expect(z.zoom).toBe(12.5);
    const after = screenToWorld(cursor, z, VP);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(zoomAt(v, 1000, cursor, VP, LIM).zoom).toBe(40);
    expect(zoomAt(v, 1e-6, cursor, VP, LIM).zoom).toBe(0.5);
    expect(clampZoom(Number.NaN, LIM)).toBe(0.5);
  });

  it("es la MISMA fórmula que el zoom de rueda del visor (camera-interaction.ts)", () => {
    // Mapa enorme: clampToMap del visor no interviene y se compara la fórmula pura.
    const cfg = { viewportW: VP.w, viewportH: VP.h, mapW: 10_000, mapH: 10_000, minZoom: 0.5, maxZoom: 40 };
    const current = { centerX: 5000, centerY: 5000, zoom: 8 };
    for (const [dy, px] of [
      [-100, { x: 100, y: 50 }],
      [250, { x: 700, y: 580 }],
      [-37, { x: 400, y: 300 }],
    ] as const) {
      const viewer = new CameraInteraction().onWheel(dy, px, { current, cfg });
      const ours = zoomAt(current, wheelZoomFactor(dy), px, VP, LIM);
      expect(viewer.kind).toBe("manual");
      if (viewer.kind !== "manual") continue;
      expect(ours.zoom).toBeCloseTo(viewer.zoom, 9);
      expect(ours.centerX).toBeCloseTo(viewer.centerX, 9);
      expect(ours.centerY).toBeCloseTo(viewer.centerY, 9);
    }
  });

  it("pan: el mundo sigue al puntero; recorte: el centro nunca sale del mapa", () => {
    const v = { centerX: 10, centerY: 10, zoom: 4 };
    const p = panByPixels(v, 40, -20);
    expect(p).toEqual({ centerX: 0, centerY: 15, zoom: 4 });
    expect(clampCenter({ centerX: -50, centerY: 900, zoom: 4 }, { w: 120, h: 80 })).toEqual({
      centerX: 0,
      centerY: 80,
      zoom: 4,
    });
  });

  it("encajar: el mapa entero cabe con margen y queda centrado; zoomTo ancla en el centro", () => {
    const f = fitView({ w: 120, h: 80 }, VP, 16);
    expect(f.centerX).toBe(60);
    expect(f.centerY).toBe(40);
    expect(120 * f.zoom).toBeLessThanOrEqual(VP.w - 32 + 1e-9);
    expect(80 * f.zoom).toBeLessThanOrEqual(VP.h - 32 + 1e-9);
    const t = zoomTo(f, 10, VP, LIM);
    expect(t).toEqual({ centerX: 60, centerY: 40, zoom: 10 });
  });

  it("pellizco: separar los dedos acerca; mover ambos desplaza", () => {
    const v = { centerX: 50, centerY: 50, zoom: 4 };
    const z = pinchView(
      v,
      [
        { x: 300, y: 300 },
        { x: 500, y: 300 },
      ],
      [
        { x: 250, y: 300 },
        { x: 550, y: 300 },
      ],
      VP,
      LIM,
    );
    expect(z.zoom).toBeCloseTo(6, 9);
    const moved = pinchView(
      v,
      [
        { x: 300, y: 300 },
        { x: 500, y: 300 },
      ],
      [
        { x: 340, y: 300 },
        { x: 540, y: 300 },
      ],
      VP,
      LIM,
    );
    expect(moved.zoom).toBeCloseTo(4, 9);
    expect(moved.centerX).toBeCloseTo(50 - 40 / 4, 9);
  });
});

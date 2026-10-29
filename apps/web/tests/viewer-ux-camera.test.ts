/**
 * UX-VIEW · Bloque A — zoom, pan y cámara del visor (lógica pura).
 *
 *  - «Encajar mapa» = vista completa; el mínimo es el menor entre encajar y
 *    100 %: alejado al máximo el mapa se ve entero y nunca se pierden vehículos;
 *  - «100 %» = escala nativa de la escena en px CSS, igual en HiDPI;
 *  - el zoom (rueda, pinch, botones) mantiene el punto bajo el cursor, está
 *    acotado y es uniforme (no deforma);
 *  - la manipulación directa salta al objetivo (sin muelle que vaya por detrás).
 */
import { describe, expect, it } from "vitest";
import { CameraInteraction } from "../src/viewer/camera-interaction.js";
import { SmoothCamera, clampToMap, computeCamera, fitZoom, type CameraConfig } from "../src/viewer/camera.js";
import {
  cameraConfigFor,
  computeViewScale,
  normalizeWheelDelta,
  zoomPercent,
  MAX_PERCENT,
} from "../src/viewer/view-scale.js";
import { stageHeightFor } from "../src/viewer/theater.js";

describe("layout teatro: alto del escenario ligado al viewport", () => {
  it("ocupa lo que queda de pantalla desde su borde superior, acotado", () => {
    expect(stageHeightFor(1080, 230)).toBe(1080 - 230 - 12);
    expect(stageHeightFor(768, 600)).toBe(360); // nunca diminuto
    expect(stageHeightFor(4000, 100)).toBe(1600); // ni gigantesco
  });
});

const BASE = { viewportW: 1500, viewportH: 860, mapW: 120, mapH: 80, dpr: 1, pxPerM: 8 };

describe("escala del visor: encajar, 100 % y límites", () => {
  it("encajar = vista global; el mínimo es el menor entre encajar y 100 % (los dos alcanzables)", () => {
    const s = computeViewScale(BASE);
    const cfg = cameraConfigFor(BASE);
    expect(s.fit).toBeCloseTo(fitZoom(cfg), 9);
    expect(computeCamera({ kind: "global" }, { vehicles: [] }, cfg).zoom).toBeCloseTo(s.fit, 9);
    // Escritorio grande: el encaje (≈122 %) pasa de 100 %; el mínimo es 100 %.
    expect(s.fit).toBeGreaterThan(s.native);
    expect(s.min).toBe(s.native);
    // Móvil: el encaje queda por debajo de 100 % y es el mínimo.
    const phone = computeViewScale({ ...BASE, viewportW: 341, viewportH: 496 });
    expect(phone.min).toBeCloseTo(phone.fit, 9);
  });

  it("100 % es la escala nativa (pxPerM px CSS por metro), también con dpr 2", () => {
    expect(computeViewScale(BASE).native).toBe(8);
    const hi = computeViewScale({ ...BASE, dpr: 2, viewportW: 3000, viewportH: 1720 });
    expect(hi.native).toBe(16); // px de búfer por metro
    expect(zoomPercent(16, hi)).toBe(100);
    expect(zoomPercent(8, computeViewScale(BASE))).toBe(100);
  });

  it("el máximo es MAX_PERCENT de la escala nativa; en móvil el encaje queda por debajo de 100 %", () => {
    const s = computeViewScale(BASE);
    expect(s.max).toBeCloseTo((8 * MAX_PERCENT) / 100, 9);
    const phone = computeViewScale({ ...BASE, viewportW: 341, viewportH: 496 });
    expect(zoomPercent(phone.fit, phone)).toBeLessThan(100);
    expect(phone.follow).toBeGreaterThanOrEqual(phone.fit);
  });

  it("la rueda se normaliza (líneas/páginas) y se acota por evento", () => {
    expect(normalizeWheelDelta(3, 1)).toBe(48);
    expect(normalizeWheelDelta(1, 2)).toBe(240);
    expect(normalizeWheelDelta(-10_000, 0)).toBe(-240);
    expect(normalizeWheelDelta(Number.NaN, 0)).toBe(0);
  });
});

describe("CameraInteraction: zoom al punto, botones, 100 %, centrar", () => {
  const cfg: CameraConfig = cameraConfigFor(BASE);
  const s = computeViewScale(BASE);
  const view = (current = { centerX: 60, centerY: 40, zoom: 20 }) => ({ current, cfg });
  const worldAt = (c: { centerX: number; centerY: number; zoom: number }, p: { x: number; y: number }) => ({
    x: c.centerX + (p.x - cfg.viewportW / 2) / c.zoom,
    y: c.centerY + (p.y - cfg.viewportH / 2) / c.zoom,
  });

  it("zoomAt mantiene fijo el punto del mundo bajo el cursor", () => {
    const i = new CameraInteraction();
    const p = { x: 1000, y: 300 };
    const before = view();
    const m = i.zoomAt(1.5, p, before);
    if (m.kind !== "manual") throw new Error("debe pasar a libre");
    expect(m.zoom).toBeCloseTo(30, 9);
    const a = worldAt(before.current, p);
    const b = worldAt(m, p);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
  });

  it("zoom acotado: nunca por debajo del mínimo ni por encima del máximo (y factor inválido = 1)", () => {
    const i = new CameraInteraction();
    const out = i.zoomAt(0.0001, { x: 0, y: 0 }, view());
    expect(out.kind === "manual" && out.zoom).toBeCloseTo(s.min, 9);
    const inn = i.zoomAt(10_000, { x: 0, y: 0 }, view());
    expect(inn.kind === "manual" && inn.zoom).toBeCloseTo(s.max, 9);
    const same = i.zoomAt(Number.NaN, { x: 750, y: 430 }, view());
    expect(same.kind === "manual" && same.zoom).toBe(20);
  });

  it("alejado al máximo el mapa entero se ve centrado: ningún vehículo queda fuera", () => {
    const i = new CameraInteraction();
    const m = i.zoomAt(0.0001, { x: 1400, y: 50 }, view({ centerX: 10, centerY: 10, zoom: 40 }));
    if (m.kind !== "manual") throw new Error();
    const halfW = cfg.viewportW / (2 * m.zoom);
    const halfH = cfg.viewportH / (2 * m.zoom);
    for (const [x, y] of [
      [0, 0],
      [120, 80],
      [0, 80],
      [120, 0],
    ]) {
      expect(Math.abs(x - m.centerX)).toBeLessThanOrEqual(halfW + 1e-9);
      expect(Math.abs(y - m.centerY)).toBeLessThanOrEqual(halfH + 1e-9);
    }
  });

  it("zoomBy (+/−) es simétrico alrededor del centro; zoomTo(nativo) da 100 %", () => {
    const i = new CameraInteraction();
    const a = i.zoomBy(1.25, view());
    if (a.kind !== "manual") throw new Error();
    const b = i.zoomBy(1 / 1.25, { current: a, cfg });
    if (b.kind !== "manual") throw new Error();
    expect(b.zoom).toBeCloseTo(20, 9);
    expect(b.centerX).toBeCloseTo(60, 6);
    const n = i.zoomTo(s.native, view());
    expect(n.kind === "manual" && zoomPercent(n.zoom, s)).toBe(100);
  });

  it("centerOn centra sin cambiar el zoom y respeta los límites del mapa", () => {
    const i = new CameraInteraction();
    const m = i.centerOn(1, 1, view());
    if (m.kind !== "manual") throw new Error();
    expect(m.zoom).toBe(20);
    expect(m).toEqual({ kind: "manual", ...clampToMap({ centerX: 1, centerY: 1, zoom: 20 }, cfg) });
  });
});

describe("SmoothCamera.jumpTo: el pan directo no va por detrás del dedo", () => {
  const cfg: CameraConfig = { viewportW: 960, viewportH: 640, mapW: 120, mapH: 80 };

  it("tras jumpTo, update con el mismo objetivo no se mueve (sin inercia ni rebote)", () => {
    const cam = new SmoothCamera();
    cam.update({ kind: "global" }, { centerX: 60, centerY: 40, zoom: 8 }, cfg, 16);
    const target = { centerX: 40, centerY: 30, zoom: 16 };
    const j = cam.jumpTo(target, cfg);
    expect(j).toEqual(clampToMap(target, cfg));
    for (let n = 0; n < 30; n++) {
      const c = cam.update({ kind: "manual", ...target }, target, cfg, 16);
      expect(c.centerX).toBeCloseTo(j.centerX, 9);
      expect(c.zoom).toBeCloseTo(j.zoom, 9);
    }
  });

  it("sin jumpTo el muelle iba por detrás (control: el primer frame NO llega)", () => {
    const cam = new SmoothCamera();
    cam.update({ kind: "global" }, { centerX: 60, centerY: 40, zoom: 8 }, cfg, 16);
    const c = cam.update(
      { kind: "manual", centerX: 40, centerY: 30, zoom: 16 },
      { centerX: 40, centerY: 30, zoom: 16 },
      cfg,
      16,
    );
    expect(Math.abs(c.zoom - 16)).toBeGreaterThan(0.5);
  });
});

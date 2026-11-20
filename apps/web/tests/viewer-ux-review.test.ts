/**
 * UX-VIEW · Correcciones de la revisión independiente de la integración UX
 * (PR #203, CON_RESERVAS): P2-a (HUD/borde tapan al seleccionado), P2-b (alto del
 * escenario en móvil) y P3 (zoom dentro del seguimiento, densidad, nombres en el feed).
 */
import { describe, expect, it } from "vitest";
import { clampToMap, computeCamera } from "../src/viewer/camera.js";
import { cameraConfigFor } from "../src/viewer/view-scale.js";
import { stageHeightBounds, stageHeightFor } from "../src/viewer/theater.js";
import { CROWD_PX, DEFAULT_TAG_PREFS, crowdedIds, planTag, type TagInput } from "../src/viewer/vehicle-tags.js";
import { feedItemText, targetLabel } from "../src/viewer/hud-model.js";
import { OverlayState } from "../src/viewer/overlay.js";

const BASE = { viewportW: 960, viewportH: 640, mapW: 120, mapH: 80, dpr: 1, pxPerM: 8 };

describe("P2-a: un bot en el borde no queda pegado al canto de la vista", () => {
  it("con zoom la cámara puede pasar 48 px del borde del mapa; sin zoom sigue centrada", () => {
    const cfg = cameraConfigFor(BASE);
    const halfH = 640 / (2 * 24);
    const c = clampToMap({ centerX: 60, centerY: 1, zoom: 24 }, cfg);
    // El bot (y = 1 m) queda ≥ 48 px por debajo del canto superior de la vista.
    expect((1 - (c.centerY - halfH)) * 24).toBeCloseTo(48 + 24, 9);
    // Sin margen (antes) quedaba a 24 px del canto.
    const old = clampToMap({ centerX: 60, centerY: 1, zoom: 24 }, { ...cfg, overscrollPx: 0 });
    expect((1 - (old.centerY - halfH)) * 24).toBeCloseTo(24, 9);
    // Mapa entero a la vista: centrado como siempre.
    expect(clampToMap({ centerX: 0, centerY: 0, zoom: 4 }, cfg)).toMatchObject({ centerX: 60, centerY: 40 });
  });
});

describe("P2-b: alto del escenario en móvil", () => {
  it("≤ 720 px: entre 240 px y 1,1 × ancho, y siempre cabe desde su borde superior", () => {
    expect(stageHeightBounds(360)).toEqual({ min: 240, max: 396 });
    expect(stageHeightBounds(1366)).toEqual({ min: 360, max: 1600 });
    const b = stageHeightBounds(360);
    expect(stageHeightFor(800, 380, b.min, b.max)).toBe(396); // 380 + 396 ≤ 800
    expect(stageHeightFor(800, 480, b.min, b.max)).toBe(308); // se encoge para caber entero
  });
});

describe("P3: zoom dentro del seguimiento", () => {
  it("follow con zoom propio; sin él, el de seguimiento", () => {
    const cfg = cameraConfigFor(BASE);
    const snap = { vehicles: [{ id: "v", position: { x: 10, y: 10 }, alive: true }] };
    expect(computeCamera({ kind: "follow", vehicleId: "v", zoom: 30 }, snap, cfg).zoom).toBe(30);
    expect(computeCamera({ kind: "follow", vehicleId: "v" }, snap, cfg).zoom).toBe(cfg.followZoom);
  });
});

describe("P3: densidad local al inicio del 4v4", () => {
  const bot = (over: Partial<TagInput> = {}): TagInput => ({
    id: "v1",
    label: "A-ATK-1",
    team: "red",
    teamIndex: 0,
    life: "alive",
    hpRatio: 1,
    selected: false,
    relation: "none",
    ...over,
  });
  const ctx = { prefs: DEFAULT_TAG_PREFS, cssPxPerM: 10, visibleCount: 8 };

  it("crowdedIds marca los pares a menos de CROWD_PX en pantalla", () => {
    const s = crowdedIds([
      { id: "a", x: 0, y: 0 },
      { id: "b", x: CROWD_PX - 1, y: 0 },
      { id: "c", x: 500, y: 500 },
    ]);
    expect([...s].sort()).toEqual(["a", "b"]);
  });

  it("amontonado ⇒ sin nombre en «auto» (salvo el seleccionado) y barra corta", () => {
    expect(planTag(bot({ crowded: true }), ctx).showName).toBe(false);
    expect(planTag(bot({ crowded: true, selected: true }), ctx).showName).toBe(true);
    expect(planTag(bot({ crowded: true }), ctx).barWidthPx).toBeLessThan(planTag(bot(), ctx).barWidthPx);
  });
});

describe("P3: nombres en el feed, no ids internos", () => {
  it("«A-ATK-3 destruido» y «caja 4 destruido» en vez de `veh_3` / `crate_04`", () => {
    const roster = new Map([["veh_3", { name: "A-ATK-3", team: "red" }]]);
    const o = new OverlayState();
    o.applyEvent({ kind: "vehicle_destroyed", targetId: "veh_3", tick: 5 });
    o.applyEvent({ kind: "vehicle_destroyed", targetId: "crate_04", tick: 6 });
    expect(o.feed.map((f) => feedItemText(f, roster))).toEqual(["A-ATK-3 destruido", "caja 4 destruido"]);
    expect(targetLabel(null, "veh_9")).toBe("veh_9");
  });
});

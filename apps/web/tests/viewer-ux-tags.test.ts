/**
 * UX-VIEW · Bloque B — vida y etiquetas que no tapan, y estados distinguibles
 * sin depender sólo del color (lógica pura de vehicle-tags.ts).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAG_PREFS,
  DENSE_COUNT,
  LOW_ZOOM_PX_PER_M,
  RESPAWN_MARK_MS,
  declutterLabels,
  lifeState,
  markerShape,
  planTag,
  relationTo,
  type TagInput,
} from "../src/viewer/vehicle-tags.js";

const bot = (over: Partial<TagInput> = {}): TagInput => ({
  id: "v1",
  label: "A-ATK-1",
  team: "red",
  teamIndex: 0,
  life: "alive",
  hpRatio: 0.62,
  selected: false,
  relation: "none",
  ...over,
});
const ctx = (over: Partial<{ cssPxPerM: number; visibleCount: number }> = {}) => ({
  prefs: DEFAULT_TAG_PREFS,
  cssPxPerM: 10,
  visibleCount: 8,
  ...over,
});

describe("vida: barra FINA por defecto y detalle sólo del seleccionado", () => {
  it("barra fina (3 px) sin texto para un bot normal; 4 px y porcentaje para el seleccionado", () => {
    const p = planTag(bot(), ctx());
    expect(p.showBar).toBe(true);
    expect(p.barHeightPx).toBeLessThanOrEqual(3);
    expect(p.showDetail).toBe(false);
    const s = planTag(bot({ selected: true }), ctx());
    expect(s.showDetail).toBe(true);
    expect(s.detailText).toBe("62%");
    expect(s.barHeightPx).toBe(4);
  });

  it("la barra queda ENCIMA del vehículo, no sobre él (offset ≥ radio de la marca en pantalla)", () => {
    for (const z of [2, 8, 30]) {
      const p = planTag(bot(), ctx({ cssPxPerM: z }));
      expect(p.offsetPx).toBeGreaterThanOrEqual(14);
      expect(p.offsetPx).toBeLessThanOrEqual(40);
    }
  });

  it("preferencia «sólo el seleccionado» y «oculta»", () => {
    const sel = { ...ctx(), prefs: { health: "selected" as const, names: "auto" as const } };
    expect(planTag(bot(), sel).showBar).toBe(false);
    expect(planTag(bot({ selected: true }), sel).showBar).toBe(true);
    const off = { ...ctx(), prefs: { health: "off" as const, names: "auto" as const } };
    expect(planTag(bot({ selected: true }), off).showBar).toBe(false);
  });

  it("sin dato de vida no se inventa barra; destruido no lleva barra", () => {
    expect(planTag(bot({ hpRatio: null }), ctx()).showBar).toBe(false);
    expect(planTag(bot({ life: "destroyed" }), ctx()).showBar).toBe(false);
  });
});

describe("nombres: simplificación con zoom bajo y densidad", () => {
  it("auto: con zoom normal todos llevan nombre", () => {
    expect(planTag(bot(), ctx()).showName).toBe(true);
  });

  it("auto: con zoom bajo o mucha densidad sólo el seleccionado lleva nombre; la barra se acorta", () => {
    const low = ctx({ cssPxPerM: LOW_ZOOM_PX_PER_M - 1 });
    expect(planTag(bot(), low).showName).toBe(false);
    expect(planTag(bot({ selected: true }), low).showName).toBe(true);
    expect(planTag(bot(), low).barWidthPx).toBeLessThan(planTag(bot(), ctx()).barWidthPx);
    expect(planTag(bot(), ctx({ visibleCount: DENSE_COUNT + 1 })).showName).toBe(false);
  });

  it("«todos», «sólo el seleccionado» y «ocultos»", () => {
    const p = (names: "all" | "selected" | "off", selected = false) =>
      planTag(bot({ selected }), { ...ctx({ cssPxPerM: 1 }), prefs: { health: "bar", names } }).showName;
    expect(p("all")).toBe(true);
    expect(p("selected")).toBe(false);
    expect(p("selected", true)).toBe(true);
    expect(p("off", true)).toBe(false);
  });

  it("despeje: de dos etiquetas solapadas queda la del seleccionado; separadas, las dos", () => {
    const a = { id: "a", x: 100, y: 100, w: 80, h: 13, priority: 1 };
    const b = { id: "b", x: 120, y: 104, w: 80, h: 13, priority: 2 };
    expect([...declutterLabels([a, b])]).toEqual(["b"]);
    expect(declutterLabels([a, { ...b, x: 300 }]).size).toBe(2);
    // Determinista entre iguales: por id.
    expect([
      ...declutterLabels([
        { ...a, id: "z" },
        { ...a, id: "m", x: 110 },
      ]),
    ]).toEqual(["m"]);
  });
});

describe("aliado/enemigo/seleccionado/destruido/reaparición sin depender sólo del color", () => {
  it("relación respecto de la perspectiva (bando del seleccionado o de la niebla)", () => {
    expect(relationTo("red", "red")).toBe("ally");
    expect(relationTo("blue", "red")).toBe("enemy");
    expect(relationTo("blue", null)).toBe("none");
  });

  it("FORMA: aliado círculo, enemigo rombo; sin perspectiva, una forma por bando", () => {
    expect(markerShape("ally", 1)).toBe("circle");
    expect(markerShape("enemy", 0)).toBe("diamond");
    expect(markerShape("none", 0)).not.toBe(markerShape("none", 1));
  });

  it("cada estado tiene una marca propia que no es un color", () => {
    const normal = planTag(bot(), ctx());
    const sel = planTag(bot({ selected: true }), ctx());
    const ko = planTag(bot({ life: "destroyed" }), ctx());
    const back = planTag(bot({ life: "respawning" }), ctx());
    expect([normal.selectedRing, normal.cross, normal.dashedRing]).toEqual([false, false, false]);
    expect(sel.selectedRing).toBe(true);
    expect(ko.cross).toBe(true);
    expect(ko.nameText).toBe("A-ATK-1 KO");
    expect(back.dashedRing).toBe(true);
    expect(back.nameText).toBe("A-ATK-1 REAPARECE");
  });

  it("reaparición: dura RESPAWN_MARK_MS desde que vuelve a estar vivo", () => {
    expect(lifeState(false, undefined, 0)).toBe("destroyed");
    expect(lifeState(true, 1000, 1000 + RESPAWN_MARK_MS - 1)).toBe("respawning");
    expect(lifeState(true, 1000, 1000 + RESPAWN_MARK_MS)).toBe("alive");
    expect(lifeState(true, undefined, 5)).toBe("alive");
  });
});

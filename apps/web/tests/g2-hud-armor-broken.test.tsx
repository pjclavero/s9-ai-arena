// @vitest-environment jsdom
/**
 * OLA 2 · G2 · D-B4 en el visor: el frame PÚBLICO trae `armorBroken` (sólo sectores rotos,
 * `true`); el HUD reactiva el icono de blindaje roto sin necesitar `modules` (EQUIPMENT_PRIVATE).
 * Mutantes: ignorar `armorBroken` en el overlay (icono muerto) o pintarlo sin dato (icono
 * fantasma) ⇒ rojo.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { OverlayState, armorBrokenSectorsOf } from "../src/viewer/overlay.js";
import { buildHudModel } from "../src/viewer/hud-model.js";
import { HudOverlay } from "../src/viewer/HudOverlay.js";

afterEach(cleanup);

function frame(armorBroken?: unknown) {
  return {
    tick: 10,
    score: { red: 0, blue: 0 },
    objectives: [],
    vehicles: [
      { id: "v_1", team: "red", alive: true, position: { x: 1, y: 2 }, heading: 0, turretHeading: 0, hullLevel: 10 },
      {
        id: "v_2",
        team: "blue",
        alive: true,
        position: { x: 3, y: 4 },
        heading: 0,
        turretHeading: 0,
        hullLevel: 20,
        ...(armorBroken !== undefined ? { armorBroken } : {}),
      },
    ],
    projectiles: [],
    deployables: [],
  };
}

const ICON = "🛡✖";

describe("G2 · HUD con armorBroken público (D-B4)", () => {
  it("un vehículo con el blindaje roto muestra el icono; el otro no", () => {
    const o = new OverlayState();
    o.applySnapshot(frame({ front: true }));
    const model = buildHudModel(o);
    const bots = model.teams.flatMap((t) => t.bots);
    expect(bots.find((b) => b.id === "v_2")!.armorBroken).toBe(true);
    expect(bots.find((b) => b.id === "v_1")!.armorBroken).toBe(false);
    const { container } = render(<HudOverlay model={model} />);
    const rows = [...container.querySelectorAll('[data-testid="hud-bot"]')];
    const withIcon = rows.filter((r) => (r.textContent ?? "").includes(ICON)).map((r) => r.getAttribute("data-bot"));
    expect(withIcon).toEqual(["v_2"]);
  });

  it("sin armorBroken en el frame no hay icono (sin icono fantasma)", () => {
    const o = new OverlayState();
    o.applySnapshot(frame());
    const { container } = render(<HudOverlay model={buildHudModel(o)} />);
    expect(container.textContent ?? "").not.toContain(ICON);
  });

  it("el icono desaparece de la vista si un frame posterior ya no trae la rotura (el estado sigue al frame)", () => {
    const o = new OverlayState();
    o.applySnapshot(frame({ front: true }));
    o.applySnapshot(frame());
    const bots = buildHudModel(o).teams.flatMap((t) => t.bots);
    expect(bots.every((b) => b.armorBroken === false)).toBe(true);
  });

  it("armorBrokenSectorsOf: sólo `true`, ordenado; entrada hostil ⇒ []", () => {
    expect(armorBrokenSectorsOf({ rear: true, front: true, left: false })).toEqual(["front", "rear"]);
    expect(armorBrokenSectorsOf({ front: "true", left: 1 })).toEqual([]);
    for (const bad of [null, undefined, 5, "x", [true]]) expect(armorBrokenSectorsOf(bad)).toEqual([]);
  });

  it("no pinta recuento de módulos ni nada de equipamiento con la rotura visible (EQUIPMENT_PRIVATE)", () => {
    const o = new OverlayState();
    o.applySnapshot(frame({ front: true, rear: true }));
    const { container } = render(<HudOverlay model={buildHudModel(o)} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/módulos/i);
    expect(text).not.toMatch(/front|rear|frontal|trasero/i);
  });
});

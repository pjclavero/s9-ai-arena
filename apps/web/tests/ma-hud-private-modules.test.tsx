/**
 * OLA 2 · MA · EQUIPMENT_PRIVATE en el HUD. El frame público no lleva `modules` ni
 * hullHpMax (sólo `hullLevel`): el HUD NO debe pintar «0/0 módulos» ni ningún recuento
 * de módulos (ni «módulos caídos»), ni cadenas vacías.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { OverlayState } from "../src/viewer/overlay.js";
import { buildHudModel } from "../src/viewer/hud-model.js";
import { HudOverlay } from "../src/viewer/HudOverlay.js";

afterEach(cleanup);

/** Forma exacta de un frame público R2 (packages/projection): ids v_N, hullLevel, sin modules. */
function publicFrame() {
  return {
    tick: 10,
    score: { red: 0, blue: 0 },
    objectives: [],
    vehicles: [
      { id: "v_1", team: "red", alive: true, position: { x: 1, y: 2 }, heading: 0, turretHeading: 0, hullLevel: 10 },
      { id: "v_2", team: "blue", alive: true, position: { x: 3, y: 4 }, heading: 0, turretHeading: 0, hullLevel: 20 },
    ],
    projectiles: [],
    deployables: [],
  };
}

describe("MA · HUD con frame público R2", () => {
  it("no pinta «0/0 módulos», ni recuentos de módulos, ni 'módulos caídos'", () => {
    const o = new OverlayState();
    o.applySnapshot(publicFrame());
    const model = buildHudModel(o);
    const { container } = render(<HudOverlay model={model} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/0\/0/);
    expect(text).not.toMatch(/\d+\s*\/\s*\d+\s*módulos/i);
    expect(text).not.toMatch(/módulos/i);
    expect(container.querySelector('[data-testid="hud-bot-modules"]')).toBeNull();
    expect(container.querySelector('[data-testid="hud-team-tactical-modules"]')).toBeNull();
    // lo que sí sale: vida cuantizada (10/20 = 50 %)
    const hp = container.querySelectorAll('[data-testid="hud-bot-hp"]');
    expect(hp.length).toBe(2);
    expect(container.textContent).toMatch(/50%/);
  });

  it("el modelo no expone campos de recuento de módulos", () => {
    const o = new OverlayState();
    o.applySnapshot(publicFrame());
    const model = buildHudModel(o);
    for (const t of model.teams) {
      expect(t.tactical).not.toHaveProperty("modulesOffline");
      for (const b of t.bots) {
        expect(b).not.toHaveProperty("modulesTotal");
        expect(b).not.toHaveProperty("modulesDown");
      }
    }
  });
});

// @vitest-environment jsdom
/**
 * T7.4 · DoD: el editor impide EN CLIENTE superar presupuesto/masa/energía
 * (usando el validador REAL de E3, el mismo que corre en servidor).
 * La re-verificación del servidor se prueba en apps/api (test de bypass).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

afterEach(cleanup);
import { LoadoutEditor, computeLive } from "../src/pages/LoadoutEditor.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";

const catalog = loadCatalog();
const BUDGET = 1000;

const OVERBUDGET = {
  chassis: "chassis.heavy@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@1" },
    { slot: "sensor_a", moduleId: "sensor.lidar360@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
    { slot: "armor_front", moduleId: "armor.composite_front@1" },
    { slot: "armor_left", moduleId: "armor.composite_left@1" },
    { slot: "armor_right", moduleId: "armor.composite_right@1" },
    { slot: "armor_rear", moduleId: "armor.composite_rear@1" },
  ],
};

describe("T7.4 editor de loadout (validador E3 en cliente)", () => {
  it("computeLive detecta presupuesto superado con el validador real de E3", () => {
    const live = computeLive({ catalogVersion: CATALOG_VERSION, ...OVERBUDGET }, catalog, BUDGET);
    expect(live.costCredits).toBeGreaterThan(BUDGET);
    expect(live.violations.map((v) => v.code)).toContain("budget_exceeded");
  });

  it("al superar el presupuesto muestra la violación y BLOQUEA el guardado", async () => {
    const onSave = vi.fn();
    render(<LoadoutEditor catalog={catalog} catalogVersion={CATALOG_VERSION} budgetCredits={BUDGET} onSave={onSave} />);

    // Monta el heavy sobrecargado usando la UI real
    fireEvent.change(screen.getByLabelText("chasis"), { target: { value: "chassis.heavy@1" } });
    for (const m of OVERBUDGET.modules) {
      fireEvent.change(screen.getByLabelText(`slot-${m.slot}`), { target: { value: m.moduleId } });
    }

    await waitFor(() => {
      expect(screen.getByTestId("live-cost").textContent).toContain("1275/1000");
    });
    const violations = screen.getByTestId("violations").textContent!;
    expect(violations).toContain("budget_exceeded");

    const save = screen.getByTestId("save-loadout") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("un déficit de energía se muestra en vivo y bloquea", async () => {
    const onSave = vi.fn();
    render(<LoadoutEditor catalog={catalog} catalogVersion={CATALOG_VERSION} budgetCredits={BUDGET} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("chasis"), { target: { value: "chassis.medium@1" } });
    // lidar (consume pasivo) sin ningún módulo de energía
    fireEvent.change(screen.getByLabelText("slot-sensor_a"), { target: { value: "sensor.lidar360@1" } });
    await waitFor(() => {
      expect(screen.getByTestId("violations").textContent).toContain("energy_deficit");
    });
    expect((screen.getByTestId("save-loadout") as HTMLButtonElement).disabled).toBe(true);
  });

  it("un loadout legal habilita el guardado y llama a onSave; el servidor decide", async () => {
    const onSave = vi.fn().mockResolvedValue(null);
    render(<LoadoutEditor catalog={catalog} catalogVersion={CATALOG_VERSION} budgetCredits={BUDGET} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("chasis"), { target: { value: "chassis.medium@1" } });
    for (const [slot, moduleId] of [
      ["drive", "movement.tracks@1"],
      ["power", "power.battery@1"],
      ["sensor_a", "sensor.lidar360@1"],
      ["turret_main", "weapon.cannon@1"],
      ["armor_front", "armor.steel_front@1"],
    ]) {
      fireEvent.change(screen.getByLabelText(`slot-${slot}`), { target: { value: moduleId } });
    }
    await waitFor(() => {
      expect(screen.queryByTestId("violations")).toBeNull();
    });
    const save = screen.getByTestId("save-loadout") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const draft = onSave.mock.calls[0][0];
    expect(draft.chassis).toBe("chassis.medium@1");
    expect(draft.modules.find((m: { slot: string }) => m.slot === "turret_main").ammo).toMatch(/^ammo\./);
    await waitFor(() => expect(screen.getByTestId("saved")).toBeTruthy());
  });

  it("si el servidor rechaza (bypass de otro cliente), las violaciones del servidor se muestran", async () => {
    const onSave = vi.fn().mockResolvedValue([{ code: "budget_exceeded", message: "supera el presupuesto" }]);
    render(<LoadoutEditor catalog={catalog} catalogVersion={CATALOG_VERSION} budgetCredits={BUDGET} onSave={onSave} />);
    // chasis solo, sin módulos: legal en cliente ⇒ guardado habilitado
    fireEvent.change(screen.getByLabelText("chasis"), { target: { value: "chassis.medium@1" } });
    await waitFor(() => expect((screen.getByTestId("save-loadout") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("save-loadout"));
    await waitFor(() => {
      expect(screen.getByTestId("server-violations").textContent).toContain("budget_exceeded");
    });
  });
});

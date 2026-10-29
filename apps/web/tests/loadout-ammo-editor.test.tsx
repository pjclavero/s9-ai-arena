// @vitest-environment jsdom
/**
 * Munición incompatible en el editor (bug de producción RC5.2): con el validador real,
 * un cañón con munición estándar en la bahía `ammo_main` se señala en vivo con el motivo y
 * qué munición usar, y no se puede guardar; con AP en la bahía se puede.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { LoadoutEditor } from "../src/pages/LoadoutEditor.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";

afterEach(cleanup);
const catalog = loadCatalog();

const DEFENDER: [string, string][] = [
  ["drive", "movement.tracks@1"],
  ["power", "power.generator@1"],
  ["sensor_a", "sensor.radar@1"],
  ["turret_main", "weapon.cannon@1"],
  ["radio_a", "radio.short@1"],
];

function mount() {
  const onSave = vi.fn().mockResolvedValue(null);
  render(<LoadoutEditor catalog={catalog} catalogVersion={CATALOG_VERSION} budgetCredits={1000} onSave={onSave} />);
  fireEvent.change(screen.getByLabelText("chasis"), { target: { value: "chassis.heavy@1" } });
  for (const [slot, id] of DEFENDER) fireEvent.change(screen.getByLabelText(`slot-${slot}`), { target: { value: id } });
  return onSave;
}

describe("editor de loadout · munición incompatible", () => {
  it("cañón + ammo.standard@1 en la bahía → incompatible_ammo con las municiones compatibles, y no deja guardar", async () => {
    const onSave = mount();
    fireEvent.change(screen.getByLabelText("slot-ammo_main"), { target: { value: "ammo.standard@1" } });
    await waitFor(() => expect(screen.getByTestId("violations").textContent).toContain("incompatible_ammo"));
    expect(screen.getByTestId("violations").textContent).toContain(
      "Ningún arma del vehículo admite ammo.standard@1 (weapon.cannon@1 admite ammo.ap, ammo.he).",
    );
    const save = screen.getByTestId("save-loadout") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("cambiando la bahía a ammo.ap@1 desaparece el error y se puede guardar", async () => {
    const onSave = mount();
    fireEvent.change(screen.getByLabelText("slot-ammo_main"), { target: { value: "ammo.standard@1" } });
    await waitFor(() => expect(screen.getByTestId("violations").textContent).toContain("incompatible_ammo"));
    fireEvent.change(screen.getByLabelText("slot-ammo_main"), { target: { value: "ammo.ap@1" } });
    await waitFor(() =>
      expect(screen.queryByTestId("violations")?.textContent ?? "").not.toContain("incompatible_ammo"),
    );
    const save = screen.getByTestId("save-loadout") as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });
});

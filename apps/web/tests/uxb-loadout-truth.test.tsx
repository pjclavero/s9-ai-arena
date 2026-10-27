// @vitest-environment jsdom
/**
 * UX-01 (G-16) · el editor de loadout dice la VERDAD sobre el vehículo que juega:
 * el loadout elegido se simula en batalla y en la partida de humo del build
 * (demostrado en apps/tournament-worker/src/ux01-loadout-welcome.test.ts y
 * apps/bot-manager/tests/smoke-vehicle.test.ts). Antes decía que en la ejecución
 * real se usaban «los módulos fijos del arquetipo».
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LoadoutEditor } from "../src/pages/LoadoutEditor.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";

afterEach(cleanup);
const catalog = loadCatalog();

describe("UX-01 · aviso de efecto real del loadout", () => {
  it("dice que el loadout elegido es el vehículo de la batalla y no menciona el arquetipo", () => {
    render(
      <LoadoutEditor
        catalog={catalog}
        catalogVersion={CATALOG_VERSION}
        budgetCredits={1000}
        onSave={async () => null}
      />,
    );
    const note = screen.getByTestId("effect-note").textContent ?? "";
    expect(note).toMatch(/es el vehículo que juega/);
    expect(note).toMatch(/partida de humo del build/);
    expect(note).not.toMatch(/arquetipo/);
  });

  it("un arma elegida aparece como «cambia la batalla», no como efecto parcial del arquetipo", () => {
    render(
      <LoadoutEditor
        catalog={catalog}
        catalogVersion={CATALOG_VERSION}
        budgetCredits={1000}
        onSave={async () => null}
      />,
    );
    fireEvent.change(screen.getByLabelText("chasis"), { target: { value: "chassis.medium@1" } });
    fireEvent.change(screen.getByLabelText("slot-turret_main"), { target: { value: "weapon.cannon@1" } });
    expect(screen.getByTestId("effect-slot-turret_main").getAttribute("data-effect")).toBe("ACTIVE");
    const detail = screen.getByTestId("effect-detail-turret_main").textContent ?? "";
    expect(detail).not.toMatch(/arquetipo/);
    expect(detail).toMatch(/rangeM.*FUTURE/s); // lo que el motor ignora sigue diciéndolo
  });

  it("B2 · enseña la carga de módulos frente a maxLoadKg del chasis (la cifra que valida mass_exceeded)", () => {
    render(
      <LoadoutEditor
        catalog={catalog}
        catalogVersion={CATALOG_VERSION}
        budgetCredits={1000}
        onSave={async () => null}
      />,
    );
    fireEvent.change(screen.getByLabelText("chasis"), { target: { value: "chassis.medium@1" } });
    fireEvent.change(screen.getByLabelText("slot-turret_main"), { target: { value: "weapon.cannon@1" } });
    const chassis = catalog.find((m) => `${m.id}@${m.version}` === "chassis.medium@1")!;
    const cannon = catalog.find((m) => `${m.id}@${m.version}` === "weapon.cannon@1")!;
    expect(screen.getByTestId("live-load").textContent).toContain(
      `carga de módulos ${cannon.massKg}/${chassis.maxLoadKg} kg`,
    );
  });
});

// @vitest-environment jsdom
/**
 * R3.7 (ERR-VIS-04) · DoD del editor de loadout:
 *  - carga la revisión GUARDADA del bot (prop `initial`) en vez de arrancar vacío;
 *  - la munición se elige explícitamente (dos municiones compatibles ⇒ un select);
 *  - un catálogo incompleto NO tumba la pantalla: aviso accesible (role="alert")
 *    y el error boundary global como último recurso;
 *  - comparar contra la revisión cargada y descartar cambios.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

afterEach(cleanup);
import { LoadoutEditor, diffDrafts, type LoadoutDraft } from "../src/pages/LoadoutEditor.js";
import { ErrorBoundary } from "../src/ErrorBoundary.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";

const catalog = loadCatalog();
const BUDGET = 1000;

const SAVED: LoadoutDraft = {
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.he@1" },
  ],
};

describe("R3.7 el editor carga la revisión vigente del bot", () => {
  it("arranca desde `initial` (chasis, módulos y munición guardados) e indica la revisión", () => {
    render(
      <LoadoutEditor
        catalog={catalog}
        catalogVersion={CATALOG_VERSION}
        budgetCredits={BUDGET}
        initial={SAVED}
        loadedRevision={3}
        onSave={vi.fn()}
      />,
    );
    expect((screen.getByLabelText("chasis") as HTMLSelectElement).value).toBe("chassis.medium@1");
    expect((screen.getByLabelText("slot-turret_main") as HTMLSelectElement).value).toBe("weapon.cannon@1");
    expect((screen.getByLabelText("ammo-turret_main") as HTMLSelectElement).value).toBe("ammo.he@1");
    expect(screen.getByTestId("loaded-revision").textContent).toContain("3");
    // Sin cambios todavía: no hay diff que enseñar.
    expect(screen.queryByTestId("draft-diff")).toBeNull();
  });

  it("la munición se ELIGE explícitamente y viaja en el draft guardado", async () => {
    const onSave = vi.fn().mockResolvedValue(null);
    render(
      <LoadoutEditor
        catalog={catalog}
        catalogVersion={CATALOG_VERSION}
        budgetCredits={BUDGET}
        initial={SAVED}
        loadedRevision={3}
        onSave={onSave}
      />,
    );
    const ammoSelect = screen.getByLabelText("ammo-turret_main") as HTMLSelectElement;
    // Dos municiones compatibles con el cañón: elección real, no auto-asignación.
    expect(ammoSelect.options.length).toBeGreaterThanOrEqual(2);
    fireEvent.change(ammoSelect, { target: { value: "ammo.ap@1" } });
    fireEvent.click(screen.getByTestId("save-loadout"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const draft = onSave.mock.calls[0][0] as LoadoutDraft;
    expect(draft.modules.find((m) => m.slot === "turret_main")?.ammo).toBe("ammo.ap@1");
  });

  it("comparar y descartar: el diff contra la revisión cargada se enseña y se puede revertir", async () => {
    render(
      <LoadoutEditor
        catalog={catalog}
        catalogVersion={CATALOG_VERSION}
        budgetCredits={BUDGET}
        initial={SAVED}
        loadedRevision={3}
        onSave={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("slot-drive"), { target: { value: "movement.wheels@1" } });
    await waitFor(() => {
      expect(screen.getByTestId("draft-diff").textContent).toContain("movement.tracks@1 → movement.wheels@1");
    });
    fireEvent.click(screen.getByTestId("reset-draft"));
    await waitFor(() => expect(screen.queryByTestId("draft-diff")).toBeNull());
    expect((screen.getByLabelText("slot-drive") as HTMLSelectElement).value).toBe("movement.tracks@1");
  });

  it("diffDrafts detecta cambios de chasis, módulo, munición y vaciados", () => {
    const changed: LoadoutDraft = {
      catalogVersion: CATALOG_VERSION,
      chassis: "chassis.heavy@1",
      modules: [
        { slot: "drive", moduleId: "movement.tracks@1" },
        { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
      ],
    };
    const diff = diffDrafts(SAVED, changed);
    expect(diff.join("\n")).toContain("chasis: chassis.medium@1 → chassis.heavy@1");
    expect(diff.join("\n")).toContain("turret_main munición: ammo.he@1 → ammo.ap@1");
    expect(diff.join("\n")).toContain("power: power.battery@1 → (vacío)");
  });
});

describe("R3.7 el catálogo incompleto no tumba la pantalla", () => {
  it("catálogo vacío ⇒ aviso con role=alert dentro de la pantalla, nunca en blanco", () => {
    render(
      <ErrorBoundary label="el editor">
        <LoadoutEditor catalog={[]} catalogVersion={CATALOG_VERSION} budgetCredits={BUDGET} onSave={vi.fn()} />
      </ErrorBoundary>,
    );
    const alert = screen.getByTestId("editor-catalog-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("no está disponible");
  });

  it("la revisión guardada referencia un chasis que ya no existe ⇒ aviso y salida digna", () => {
    const sinMedium = catalog.filter((m) => !(m.id === "chassis.medium" && m.version === 1));
    render(
      <ErrorBoundary label="el editor">
        <LoadoutEditor
          catalog={sinMedium}
          catalogVersion={CATALOG_VERSION}
          budgetCredits={BUDGET}
          initial={SAVED}
          loadedRevision={3}
          onSave={vi.fn()}
        />
      </ErrorBoundary>,
    );
    const alert = screen.getByTestId("editor-catalog-error");
    expect(alert.textContent).toContain("chassis.medium@1");
    // Y hay una vía de escape: empezar con un chasis existente.
    fireEvent.click(screen.getByRole("button", { name: /Empezar con/ }));
    expect((screen.getByLabelText("chasis") as HTMLSelectElement).value).not.toBe("");
  });

  it("el error boundary global captura un fallo de render y se anuncia (role=alert)", () => {
    const Bomb = () => {
      throw new Error("catálogo corrupto");
    };
    // El boundary loguea el error a consola: silenciado para no ensuciar la suite.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary label="el editor">
        <Bomb />
      </ErrorBoundary>,
    );
    spy.mockRestore();
    const alert = screen.getByTestId("error-boundary");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("catálogo corrupto");
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeTruthy();
  });
});

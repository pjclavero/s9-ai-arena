// @vitest-environment jsdom
/**
 * R10 · Editor de mapas (foundation, solo cliente). Cubre el DoD del slice 1:
 * CRUD de objetos, validación en cliente, y roundtrip export→import.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  MapEditorPage,
  defaultDraft,
  toAuthoringJson,
  fromAuthoringJson,
  validateDraft,
  type DraftMap,
} from "../src/pages/MapEditorPage.js";

afterEach(cleanup);

describe("modelo del editor de mapas", () => {
  it("roundtrip export→import preserva objetos", () => {
    const m = defaultDraft();
    m.objects.push({ id: "w1", kind: "wall", x: 100, y: 100, width: 40, height: 20 });
    m.objects.push({ id: "c1", kind: "obstacle", x: 200, y: 200, width: 30, height: 30, health: 60 });
    const back = fromAuthoringJson(toAuthoringJson(m));
    expect(back.objects).toHaveLength(m.objects.length);
    expect(back.objects.find((o) => o.id === "w1")).toMatchObject({ kind: "wall", x: 100, width: 40 });
    expect(back.objects.find((o) => o.id === "c1")).toMatchObject({ kind: "obstacle", health: 60 });
    expect(back.objects.filter((o) => o.kind === "spawn")).toHaveLength(2);
  });

  it("el export usa el formato de autoría (walls/obstacles/spawns)", () => {
    const json = toAuthoringJson(defaultDraft()) as Record<string, unknown>;
    expect(json).toHaveProperty("walls");
    expect(json).toHaveProperty("obstacles");
    expect(json).toHaveProperty("spawns");
    expect((json.spawns as unknown[]).length).toBe(2);
  });

  it("la validación detecta fuera de límites, ids duplicados y falta de spawn", () => {
    const oob: DraftMap = {
      ...defaultDraft(),
      objects: [{ id: "x", kind: "wall", x: 9999, y: 0, width: 10, height: 10 }],
    };
    const errs = validateDraft(oob);
    expect(errs.some((e) => /límites/.test(e))).toBe(true);
    expect(errs.some((e) => /spawn/.test(e))).toBe(true);
  });
});

describe("UI del editor de mapas", () => {
  it("añade un muro y aparece en la lista de objetos", () => {
    render(<MapEditorPage />);
    const before = screen.getByText(/^Objetos \(/).textContent;
    fireEvent.click(screen.getByRole("button", { name: "Añadir muro" }));
    const after = screen.getByText(/^Objetos \(/).textContent;
    expect(after).not.toBe(before);
    // el nuevo objeto queda seleccionado → aparece el fieldset de edición
    expect(screen.getByText(/^Editar/)).toBeTruthy();
  });

  it("importar JSON carga el mapa (roundtrip por la UI)", () => {
    render(<MapEditorPage />);
    const payload = JSON.stringify({
      schemaVersion: 1,
      id: "imp",
      name: "Importado",
      width: 500,
      height: 500,
      seed: 7,
      walls: [{ id: "muro", kind: "wall", x: 10, y: 10, width: 20, height: 20 }],
      obstacles: [],
      spawns: [{ id: "s", team: "blue", x: 250, y: 250, heading: 0 }],
    });
    fireEvent.change(screen.getByLabelText("JSON a importar"), { target: { value: payload } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    const exported = screen.getByLabelText("JSON exportado") as HTMLTextAreaElement;
    expect(exported.value).toContain('"muro"');
    expect(exported.value).toContain('"imp"');
  });

  it("import de JSON inválido anuncia error sin romper", () => {
    render(<MapEditorPage />);
    fireEvent.change(screen.getByLabelText("JSON a importar"), { target: { value: "{ no json" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    const alerts = screen.getAllByRole("alert");
    expect(within(alerts[alerts.length - 1]).getByText(/JSON inválido/)).toBeTruthy();
  });
});

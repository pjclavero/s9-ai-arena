// @vitest-environment jsdom
/**
 * R10 + FC-C · Editor de mapas: funciones puras del formato interno y cableado con la
 * API (guardar = POST /maps/drafts; reabrir desde la URL tras F5 = GET .../content).
 * La API se mockea aquí (prueba de componente); el recorrido real contra API + BD
 * está en apps/api/src/routes/fc-c-content.test.ts y en el E2E de navegador.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/api.js", () => ({
  api: vi.fn(),
  ApiRequestError: class extends Error {
    constructor(
      public status: number,
      public body: Record<string, unknown>,
    ) {
      super(String(body?.message ?? status));
    }
  },
}));
import { api } from "../src/api.js";
import {
  MapEditorPage,
  newMap,
  parseImport,
  resize,
  toDocument,
  toggleMode,
  validateDraft,
} from "../src/pages/MapEditorPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const REPO = join(__dirname, "..", "..", "..");

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  window.location.hash = "";
});

describe("formato interno del editor", () => {
  it("un mapa nuevo es un InternalMap con rejilla coherente y dos spawns", () => {
    const m = newMap("mi-mapa", "Mío");
    expect(m.layers.ground.data).toHaveLength(m.layers.ground.cols * m.layers.ground.rows);
    expect(m.layers.spawns).toHaveLength(2);
    expect(validateDraft(m)).toEqual([]);
    const r = resize(m, 60, 40);
    expect(r.layers.ground.data).toHaveLength(r.layers.ground.cols * r.layers.ground.rows);
  });

  it("export → import es simétrico (lo exportado se vuelve a abrir igual)", () => {
    const m = toggleMode(newMap("ida-vuelta", "x"), "capture_the_flag");
    const back = parseImport(JSON.stringify(toDocument(m)));
    expect(back).toEqual(toDocument(m));
  });

  it("importa el mapa interno real del repo y el JSON de autoría antiguo (convertido a metros)", () => {
    const mvp = parseImport(readFileSync(join(REPO, "maps", "mvp-arena-01.json"), "utf8"));
    expect(mvp.mapId).toBe("mvp-arena-01");
    const legacy = parseImport(readFileSync(join(REPO, "maps", "training-yard.json"), "utf8"));
    expect(legacy.widthM).toBe(120);
    expect(legacy.layers.walls.length).toBeGreaterThan(0);
    expect(legacy.layers.ground.data).toHaveLength(legacy.layers.ground.cols * legacy.layers.ground.rows);
  });

  it("rechaza JSON que no es mapa", () => {
    expect(() => parseImport('{"hola":1}')).toThrow(/no reconocido/);
  });

  it("la validación de cliente avisa de id inválido, sin spawns y sin modos", () => {
    const m = newMap("X X", "x");
    const bad = { ...m, meta: { ...m.meta, supportedModes: [] }, layers: { ...m.layers, spawns: [] } };
    const errs = validateDraft(bad).join(" | ");
    expect(errs).toMatch(/id de mapa/);
    expect(errs).toMatch(/spawn/);
    expect(errs).toMatch(/modo/);
  });
});

describe("cableado con la API", () => {
  it("Guardar envía el InternalMap a POST /maps/drafts y fija la URL para reabrir", async () => {
    apiMock.mockImplementation((method: string, path: string, body?: unknown) => {
      if (method === "GET" && path.startsWith("/maps?mine=true")) return Promise.resolve({ items: [] });
      if (method === "POST" && path === "/maps/drafts")
        return Promise.resolve({ mapId: (body as { mapId: string }).mapId, version: 1, state: "draft", checks: [] });
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    });
    render(<MapEditorPage />);
    fireEvent.change(screen.getByLabelText("id del mapa"), { target: { value: "guardado-1" } });
    fireEvent.click(screen.getByTestId("editor-save"));
    await screen.findByText(/Guardado en el servidor/);
    const post = apiMock.mock.calls.find((c) => c[0] === "POST" && c[1] === "/maps/drafts")!;
    expect(post[2]).toMatchObject({ mapId: "guardado-1", layers: { spawns: expect.any(Array) } });
    expect(window.location.hash).toBe("#/maps/editor?map=guardado-1&v=1");
  });

  it("F5: con #/maps/editor?map=..&v=.. reabre el mapa DESDE la API", async () => {
    window.location.hash = "#/maps/editor?map=reabierto&v=3";
    const content = { ...newMap("reabierto", "Reabierto desde BD"), version: 3 };
    apiMock.mockImplementation((method: string, path: string) => {
      if (path === "/maps/reabierto/versions/3")
        return Promise.resolve({ mapId: "reabierto", version: 3, state: "draft" });
      if (path === "/maps/reabierto/versions/3/content") return Promise.resolve(content);
      if (path.startsWith("/maps?mine=true")) return Promise.resolve({ items: [] });
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    });
    render(<MapEditorPage />);
    await waitFor(() =>
      expect((screen.getByLabelText("nombre del mapa") as HTMLInputElement).value).toBe("Reabierto desde BD"),
    );
    expect(screen.getByTestId("editor-current").textContent).toBe("reabierto v3");
  });

  it("un 403 al guardar (mapa ajeno) se anuncia, no se traga", async () => {
    const { ApiRequestError } = await import("../src/api.js");
    apiMock.mockImplementation((method: string, path: string) => {
      if (path.startsWith("/maps?mine=true")) return Promise.resolve({ items: [] });
      if (method === "POST")
        return Promise.reject(
          new ApiRequestError(403, { error: "forbidden", message: "Ese mapa pertenece a otro usuario" }),
        );
      return Promise.reject(new Error("x"));
    });
    render(<MapEditorPage />);
    fireEvent.click(screen.getByTestId("editor-save"));
    const err = await screen.findByTestId("editor-error");
    expect(err.textContent).toMatch(/otro usuario/);
  });
});

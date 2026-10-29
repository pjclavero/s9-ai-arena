// @vitest-environment jsdom
/**
 * UX-EDITOR · Editor visual como componente (jsdom, API mockeada): paleta + clic
 * para crear, seleccionar, arrastrar para mover, tiradores para redimensionar,
 * borrar, duplicar, copiar/pegar, deshacer/rehacer por teclado, zoom y pan,
 * validación visible, borrador local tras «recargar» y OLD_MAP_REGRESSION (abrir y
 * guardar un mapa real sin tocarlo envía exactamente el mismo documento).
 *
 * Sin ResizeObserver (jsdom) el lienzo mide 800×500; el mapa nuevo (120×80 m) se
 * encaja a 5,85 px/m con el centro (60,40) en el píxel (400,250).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { MapEditorPage, parseImport, toDocument } from "../src/pages/MapEditorPage.js";
import { DRAFT_KEY } from "../src/map-editor/draft-storage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const REPO = join(__dirname, "..", "..", "..");
const Z = 5.85; // px por metro del encaje inicial
const px = (x: number, y: number) => ({ clientX: 400 + (x - 60) * Z, clientY: 250 + (y - 40) * Z });

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
  apiMock.mockImplementation((method: string, path: string) => {
    if (method === "GET" && path.startsWith("/maps?mine=true")) return Promise.resolve({ items: [] });
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
});
afterEach(() => {
  cleanup();
  apiMock.mockReset();
  window.localStorage.clear();
  window.location.hash = "";
});

const canvas = () => screen.getByTestId("editor-canvas");
const num = (label: string) => Number((screen.getByLabelText(label) as HTMLInputElement).value);
const objs = (kind: string) =>
  screen.queryAllByTestId("editor-obj").filter((e) => e.getAttribute("data-kind") === kind);
function drag(from: { clientX: number; clientY: number }, to: { clientX: number; clientY: number }) {
  const c = canvas();
  fireEvent.pointerDown(c, { ...from, pointerId: 1, button: 0, pointerType: "mouse" });
  fireEvent.pointerMove(c, {
    clientX: (from.clientX + to.clientX) / 2,
    clientY: (from.clientY + to.clientY) / 2,
    pointerId: 1,
    pointerType: "mouse",
  });
  fireEvent.pointerMove(c, { ...to, pointerId: 1, pointerType: "mouse" });
  fireEvent.pointerUp(c, { ...to, pointerId: 1, pointerType: "mouse" });
}
const key = (k: string, opts: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(window, { key: k, ...opts });
const btn = (name: string) => screen.getByRole("button", { name, exact: true } as never);

async function placeWallAtCenter() {
  render(<MapEditorPage />);
  fireEvent.click(btn("Muro"));
  expect(btn("Muro").getAttribute("aria-pressed")).toBe("true");
  fireEvent.pointerDown(canvas(), { ...px(60, 40), pointerId: 1, button: 0, pointerType: "mouse" });
  fireEvent.pointerUp(canvas(), { ...px(60, 40), pointerId: 1, pointerType: "mouse" });
}

describe("editor visual", () => {
  it("CREATE + SELECT: paleta y clic en el mapa crea el muro allí y lo selecciona", async () => {
    await placeWallAtCenter();
    expect(objs("wall")).toHaveLength(1);
    expect(objs("wall")[0].getAttribute("data-selected")).toBe("true");
    expect(num("Posición X")).toBe(60);
    expect(num("Posición Y")).toBe(40);
    expect(num("Anchura")).toBe(4);
    expect(btn("Seleccionar").getAttribute("aria-pressed")).toBe("true"); // vuelve a seleccionar
    // Seleccionar otro objeto con un clic.
    fireEvent.pointerDown(canvas(), { ...px(10, 40), pointerId: 1, button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(canvas(), { ...px(10, 40), pointerId: 1, pointerType: "mouse" });
    expect(screen.getByTestId("editor-props").querySelector("legend")!.textContent).toBe("Punto de aparición rojo 1");
  });

  it("DRAG + UNDO/REDO: arrastrar mueve; Ctrl+Z, Ctrl+Shift+Z y Ctrl+Y", async () => {
    await placeWallAtCenter();
    drag(px(60, 40), px(70, 50));
    expect(num("Posición X")).toBe(70);
    expect(num("Posición Y")).toBe(50);
    key("z", { ctrlKey: true });
    expect(num("Posición X")).toBe(60);
    key("z", { ctrlKey: true, shiftKey: true });
    expect(num("Posición X")).toBe(70);
    key("z", { ctrlKey: true });
    key("y", { ctrlKey: true });
    expect(num("Posición Y")).toBe(50);
    // Deshacer también la creación: el muro desaparece; rehacer lo devuelve.
    key("z", { ctrlKey: true });
    key("z", { ctrlKey: true });
    expect(objs("wall")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("editor-redo"));
    expect(objs("wall")).toHaveLength(1);
  });

  it("RESIZE: el tirador este ensancha; el oeste queda fijo; con rejilla ajusta", async () => {
    await placeWallAtCenter();
    expect(screen.getByTestId("editor-handle-e")).toBeTruthy();
    drag(px(62, 40), px(65, 40));
    expect(num("Anchura")).toBe(7);
    expect(num("Posición X")).toBe(61.5); // borde oeste en 58
    fireEvent.click(screen.getByLabelText("Ajustar a la rejilla"));
    drag(px(65, 40), px(66.4, 40));
    expect(num("Anchura")).toBe(8);
    key("z", { ctrlKey: true });
    expect(num("Anchura")).toBe(7);
  });

  it("DELETE + DUPLICATE + copiar/pegar + propiedades", async () => {
    await placeWallAtCenter();
    fireEvent.click(btn("Duplicar objeto"));
    expect(objs("wall")).toHaveLength(2);
    expect(num("Posición X")).toBe(62);
    key("c", { ctrlKey: true });
    key("v", { ctrlKey: true });
    expect(objs("wall")).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Altura"), { target: { value: "20" } });
    expect(num("Altura")).toBe(20);
    key("Delete");
    expect(objs("wall")).toHaveLength(2);
    key("z", { ctrlKey: true });
    expect(objs("wall")).toHaveLength(3);
    key("z", { ctrlKey: true }); // altura
    fireEvent.click(screen.getByRole("button", { name: "Muro 3" }));
    expect(num("Altura")).toBe(12);
    fireEvent.click(btn("Eliminar objeto"));
    expect(objs("wall")).toHaveLength(2);
  });

  it("ZOOM + PAN: botones, rueda al cursor, encajar, 100 % y arrastre en vacío", async () => {
    render(<MapEditorPage />);
    const stage = screen.getByTestId("editor-stage");
    const zoom = () => Number(stage.getAttribute("data-zoom"));
    const z0 = zoom();
    expect(z0).toBeCloseTo(Z, 3);
    fireEvent.click(btn("Acercar"));
    expect(zoom()).toBeCloseTo(z0 * 1.25, 3);
    fireEvent.click(btn("Alejar"));
    expect(zoom()).toBeCloseTo(z0, 3);
    fireEvent.wheel(canvas(), { deltaY: -100, clientX: 100, clientY: 100 });
    expect(zoom()).toBeCloseTo(z0 * 1.2, 3);
    fireEvent.click(btn("100 %"));
    expect(zoom()).toBe(10);
    expect(screen.getByTestId("editor-zoom").textContent).toBe("100 %");
    fireEvent.click(btn("Encajar mapa"));
    expect(zoom()).toBeCloseTo(z0, 3);
    const c0 = stage.getAttribute("data-center")!.split(",").map(Number);
    drag(px(60, 20), { clientX: px(60, 20).clientX + 117, clientY: px(60, 20).clientY });
    const c1 = stage.getAttribute("data-center")!.split(",").map(Number);
    expect(c1[0]).toBeCloseTo(c0[0] - 117 / Z, 2);
    expect(screen.getByTestId("editor-cursor").textContent).toMatch(/Cursor: X/);
  });

  it("VALIDATION: un punto de aparición dentro de un muro se marca en vivo, antes de guardar", async () => {
    await placeWallAtCenter();
    expect(screen.getByTestId("editor-validation-ok")).toBeTruthy();
    fireEvent.click(btn("Punto de aparición azul"));
    fireEvent.pointerDown(canvas(), { ...px(60, 40), pointerId: 1, button: 0, pointerType: "mouse" });
    const issues = screen.getAllByTestId("editor-issue");
    expect(issues.map((i) => i.textContent).join(" ")).toMatch(/Punto de aparición azul 2 está dentro de muro 1/);
    expect(issues[0].getAttribute("data-severity")).toBe("error");
    expect(objs("spawn")[2].getAttribute("data-issue")).toBe("error");
    expect(apiMock.mock.calls.some((c) => c[0] === "POST")).toBe(false);
    // Sin JSON a la vista: import/export queda plegado en «Opciones avanzadas».
    const adv = screen.getByTestId("editor-advanced") as HTMLDetailsElement;
    expect(adv.open).toBe(false);
    expect(within(adv).getByLabelText("JSON a importar")).toBeTruthy();
  });

  it("borrador local: los cambios sin guardar sobreviven a recargar la página", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await placeWallAtCenter();
      drag(px(60, 40), px(80, 30));
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(window.localStorage.getItem(DRAFT_KEY)).toContain('"walls"');
      cleanup(); // «recargar»
      render(<MapEditorPage />);
      expect(screen.getByTestId("editor-restored")).toBeTruthy();
      expect(objs("wall")).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Muro 1" }));
      expect(num("Posición X")).toBe(80);
      fireEvent.click(btn("Descartar cambios locales"));
      expect(objs("wall")).toHaveLength(0);
      expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("OLD_MAP_REGRESSION: abrir mvp-arena-01 desde la API, mover y deshacer, guardar = mismo documento", async () => {
    const content = parseImport(readFileSync(join(REPO, "maps", "mvp-arena-01.json"), "utf8"));
    window.location.hash = "#/maps/editor?map=mvp-arena-01&v=1";
    apiMock.mockImplementation((method: string, path: string, body?: unknown) => {
      if (path === "/maps/mvp-arena-01/versions/1")
        return Promise.resolve({ mapId: "mvp-arena-01", version: 1, state: "published" });
      if (path === "/maps/mvp-arena-01/versions/1/content") return Promise.resolve(content);
      if (path.startsWith("/maps?mine=true")) return Promise.resolve({ items: [] });
      if (method === "POST" && path === "/maps/drafts")
        return Promise.resolve({ mapId: (body as { mapId: string }).mapId, version: 2, state: "draft", checks: [] });
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    });
    render(<MapEditorPage />);
    await waitFor(() => expect(screen.getByTestId("editor-current").textContent).toBe("mvp-arena-01 v1"));
    expect(objs("wall")).toHaveLength(3);
    expect(screen.getAllByTestId("editor-base-effective")).toHaveLength(2);
    // Muro central (60,40) de 4×40: arrastrar y deshacer.
    drag(px(60, 40), px(66, 40));
    key("z", { ctrlKey: true });
    fireEvent.click(screen.getByTestId("editor-save"));
    await screen.findByText(/Guardado en el servidor/);
    const post = apiMock.mock.calls.find((c) => c[0] === "POST")!;
    expect(JSON.stringify(post[2])).toBe(JSON.stringify(toDocument(content)));
  });
});

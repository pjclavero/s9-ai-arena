// @vitest-environment jsdom
/**
 * EQ1 · #/replays ante un cursor caducado o inválido (400 de la API).
 *
 * Tras un despliegue, o con un cursor forjado, `GET /replays?cursor=…` responde 400. La
 * página no debe quedarse en error con «Reintentar» (que repetiría el MISMO cursor):
 * vuelve a la primera página con los mismos filtros y lo dice. Un 400 en la primera
 * página (un filtro inválido) se sigue mostrando como error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ReplaysPage } from "../src/pages/ReplaysPage.js";

const item = (id: string) => ({
  battleId: id,
  ticks: 300,
  winner: "red",
  official: false,
  createdAt: "2026-07-19T00:00:00.000Z",
  sizeBytes: 100,
});

let urls: string[] = [];
function mockFetch(impl: (url: string) => [number, unknown]) {
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((u: string | URL) => {
      const url = String(u);
      urls.push(url);
      const [status, body] = impl(url);
      return Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
      );
    }) as unknown as typeof fetch,
  );
}
const params = (u: string) => new URL(u, "http://x").searchParams;

beforeEach(() => {
  window.history.replaceState(null, "", "#/replays?mode=deathmatch");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EQ1 · #/replays con cursor caducado", () => {
  it("un 400 en «Siguiente» vuelve a la primera página (mismos filtros) y lo avisa", async () => {
    mockFetch((u) =>
      params(u).get("cursor") === "caducado"
        ? [400, { error: "bad_request", message: "Cursor de paginación inválido o caducado" }]
        : [200, { items: [item("btl_a"), item("btl_b")], nextCursor: "caducado", total: 3 }],
    );
    render(<ReplaysPage />);
    expect(await screen.findAllByTestId("replay-row")).toHaveLength(2);
    const nav = screen.getByRole("navigation", { name: "Paginación de replays" });
    fireEvent.click(within(nav).getByTestId("replays-next"));

    await waitFor(() => expect(screen.getByTestId("replays-cursor-reset")).toBeTruthy());
    expect(screen.getAllByTestId("replay-row").map((r) => r.dataset.battleId)).toEqual(["btl_a", "btl_b"]);
    expect(screen.getByText("Página 1")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    // Se pidió el cursor caducado y después la primera página con los MISMOS filtros.
    const conCursor = urls.filter((u) => params(u).get("cursor") === "caducado");
    expect(conCursor).toHaveLength(1);
    const despues = urls.slice(urls.indexOf(conCursor[0]!) + 1);
    expect(despues.length).toBeGreaterThan(0);
    for (const u of despues) {
      expect(params(u).get("cursor")).toBeNull();
      expect(params(u).get("mode")).toBe("deathmatch");
    }
  });

  it("un 400 en la PRIMERA página (filtro inválido) sigue siendo un error visible", async () => {
    mockFetch(() => [400, { error: "bad_request", message: "«mode» inválido" }]);
    render(<ReplaysPage />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("replays-cursor-reset")).toBeNull();
  });

  it("un 500 con cursor NO se disfraza: se muestra el error con «Reintentar»", async () => {
    mockFetch((u) =>
      params(u).get("cursor") === "c2"
        ? [500, { error: "internal", message: "boom" }]
        : [200, { items: [item("btl_a")], nextCursor: "c2" }],
    );
    render(<ReplaysPage />);
    await screen.findAllByTestId("replay-row");
    fireEvent.click(screen.getByTestId("replays-next"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("replays-cursor-reset")).toBeNull();
  });
});

// @vitest-environment jsdom
/**
 * EQ4 · Filtros y paginación EN SERVIDOR de #/replays.
 *
 * Lo que se comprueba: los filtros viajan como parámetros de `GET /api/v1/replays`
 * (nunca se filtra en el cliente), el estado vive en el hash y se puede enlazar
 * (`#/replays?bot=<id>`, `#/replays?team=<id>`), sin filtros la petición es la
 * histórica, la paginación usa `nextCursor` y los estados vacío/error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  ReplaysPage,
  filtersFromHash,
  hashForFilters,
  replaysQueryPath,
  validateFilters,
  REPLAY_MODE_OPTIONS,
} from "../src/pages/ReplaysPage.js";

const item = (id: string) => ({
  battleId: id,
  ticks: 300,
  winner: "red",
  official: false,
  createdAt: "2026-07-19T00:00:00.000Z",
  sizeBytes: 100,
});

let urls: string[] = [];
function mockFetch(impl: (url: string) => unknown, status = 200) {
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((u: string | URL) => {
      const url = String(u);
      urls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify(impl(url)), { status, headers: { "content-type": "application/json" } }),
      );
    }) as unknown as typeof fetch,
  );
}
const params = (u: string) => new URL(u, "http://x").searchParams;

beforeEach(() => {
  window.history.replaceState(null, "", "#/replays");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EQ4 · helpers de filtros", () => {
  it("sin filtros la ruta es la histórica, sin includeTotal", () => {
    expect(replaysQueryPath(filtersFromHash("#/replays"))).toBe("/replays");
  });

  it("hash ⇄ filtros: ida y vuelta, y valores desconocidos se descartan", () => {
    const f = filtersFromHash("#/replays?mode=zone_control&bot=abc&result=draw&from=2026-01-02&x=1");
    expect(f.mode).toBe("zone_control");
    expect(f.bot).toBe("abc");
    expect(f.result).toBe("draw");
    expect(hashForFilters(f)).toBe("#/replays?from=2026-01-02&mode=zone_control&result=draw&bot=abc");
    const bad = filtersFromHash("#/replays?mode=royale&result=ganar&from=ayer");
    expect([bad.mode, bad.result, bad.from]).toEqual(["", "", ""]);
  });

  it("fechas locales → instantes ISO del inicio y del final del día", () => {
    const p = params(replaysQueryPath({ ...filtersFromHash("#/replays"), from: "2026-03-01", to: "2026-03-02" }));
    expect(new Date(p.get("from")!).getTime()).toBe(new Date(2026, 2, 1, 0, 0, 0, 0).getTime());
    expect(new Date(p.get("to")!).getTime()).toBe(new Date(2026, 2, 2, 23, 59, 59, 999).getTime());
    expect(p.get("includeTotal")).toBe("true");
  });

  it("validación de cliente: battleId sólo hex/guiones y desde ≤ hasta", () => {
    const base = filtersFromHash("#/replays");
    expect(validateFilters({ ...base, battleId: "1a2b-" })).toBeNull();
    expect(validateFilters({ ...base, battleId: "1a2b%" })).toMatch(/ID de batalla/);
    expect(validateFilters({ ...base, from: "2026-03-02", to: "2026-03-01" })).toMatch(/desde/);
  });

  it("los modos tienen nombre humano", () => {
    expect(REPLAY_MODE_OPTIONS.map(([, l]) => l)).toEqual([
      "Deathmatch",
      "Deathmatch por equipos",
      "Captura la bandera (CTF)",
      "Control de zona",
    ]);
  });
});

describe("EQ4 · #/replays con filtros en servidor", () => {
  it("sin filtros: misma petición de siempre y sin total", async () => {
    mockFetch(() => ({ items: [item("btl_a")] }));
    render(<ReplaysPage />);
    expect(await screen.findAllByTestId("replay-row")).toHaveLength(1);
    expect(urls).toEqual(["/api/v1/replays"]);
    expect(screen.queryByTestId("replays-total")).toBeNull();
    expect(screen.queryByTestId("replays-pagination")).toBeNull();
  });

  it("lee bot y team del hash (enlaces desde «Mis bots» y «Equipos») y los manda a la API", async () => {
    window.history.replaceState(null, "", "#/replays?bot=bot-1&team=team-9");
    mockFetch(() => ({ items: [item("btl_a")], total: 1 }));
    render(<ReplaysPage />);
    await screen.findAllByTestId("replay-row");
    const p = params(urls[0]);
    expect(p.get("bot")).toBe("bot-1");
    expect(p.get("team")).toBe("team-9");
    expect(p.get("includeTotal")).toBe("true");
    expect((screen.getByLabelText("Bot") as HTMLInputElement).value).toBe("bot-1");
    expect(screen.getByTestId("replays-total").textContent).toBe("1 replay encontrado");
  });

  it("el formulario aplica los filtros en servidor y los deja en el hash", async () => {
    mockFetch(() => ({ items: [item("btl_a")], total: 1 }));
    render(<ReplaysPage />);
    await screen.findAllByTestId("replay-row");
    fireEvent.change(screen.getByLabelText("Modo"), { target: { value: "capture_the_flag" } });
    fireEvent.change(screen.getByLabelText("Resultado"), { target: { value: "win" } });
    fireEvent.change(screen.getByLabelText("ID de batalla"), { target: { value: "ab12" } });
    fireEvent.click(screen.getByTestId("replays-filters-apply"));
    await waitFor(() => expect(urls.length).toBe(2));
    const p = params(urls[1]);
    expect(p.get("mode")).toBe("capture_the_flag");
    expect(p.get("result")).toBe("win");
    expect(p.get("battleId")).toBe("ab12");
    expect(window.location.hash).toBe("#/replays?battleId=ab12&mode=capture_the_flag&result=win");
  });

  it("un filtro inválido no llama a la API y avisa accesiblemente", async () => {
    mockFetch(() => ({ items: [] }));
    render(<ReplaysPage />);
    await screen.findByTestId("replays-empty");
    fireEvent.change(screen.getByLabelText("ID de batalla"), { target: { value: "xyz" } });
    fireEvent.click(screen.getByTestId("replays-filters-apply"));
    const alert = await screen.findByTestId("replays-filters-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(urls).toHaveLength(1);
  });

  it("paginación por cursor: Siguiente manda el cursor y Anterior vuelve a la primera página", async () => {
    mockFetch((u) =>
      params(u).get("cursor") === "c2"
        ? { items: [item("btl_c")] }
        : { items: [item("btl_a"), item("btl_b")], nextCursor: "c2" },
    );
    render(<ReplaysPage />);
    expect(await screen.findAllByTestId("replay-row")).toHaveLength(2);
    const nav = screen.getByRole("navigation", { name: "Paginación de replays" });
    expect((within(nav).getByTestId("replays-prev") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(nav).getByTestId("replays-next"));
    await waitFor(() => expect(screen.getAllByTestId("replay-row").map((r) => r.dataset.battleId)).toEqual(["btl_c"]));
    expect(params(urls[1]).get("cursor")).toBe("c2");
    expect(screen.getByText("Página 2")).toBeTruthy();
    expect((screen.getByTestId("replays-next") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("replays-prev"));
    await waitFor(() => expect(screen.getAllByTestId("replay-row")).toHaveLength(2));
    expect(params(urls[2]).get("cursor")).toBeNull();
  });

  it("vacío con filtros ofrece quitarlos (y no el texto de «no hay replays todavía»)", async () => {
    window.history.replaceState(null, "", "#/replays?mode=zone_control");
    mockFetch(() => ({ items: [], total: 0 }));
    render(<ReplaysPage />);
    const empty = await screen.findByTestId("replays-empty");
    expect(empty.textContent).toMatch(/Ningún replay casa con estos filtros/);
    fireEvent.click(within(empty).getByRole("button", { name: "Quitar filtros" }));
    await waitFor(() => expect(urls[urls.length - 1]).toBe("/api/v1/replays"));
    expect(window.location.hash).toBe("#/replays");
  });

  it("un enlace a #/replays?… con la página abierta cambia los filtros", async () => {
    mockFetch(() => ({ items: [item("btl_a")] }));
    render(<ReplaysPage />);
    await screen.findAllByTestId("replay-row");
    window.location.hash = "#/replays?team=team-7";
    await waitFor(() => expect(params(urls[urls.length - 1]).get("team")).toBe("team-7"));
  });

  it("un 400 de la API se muestra como error, no como lista vacía", async () => {
    mockFetch(() => ({ error: "bad_request", message: "«mode» inválido" }), 400);
    render(<ReplaysPage />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("replays-empty")).toBeNull();
  });

  it("la tabla conserva stack-table (móvil) y los testid de los specs", async () => {
    mockFetch(() => ({ items: [item("btl_a")] }));
    render(<ReplaysPage />);
    const row = (await screen.findAllByTestId("replay-row"))[0];
    expect(row.closest("table")!.classList.contains("stack-table")).toBe(true);
    expect(within(row).getByTestId("replay-open").getAttribute("href")).toBe("#/replay/btl_a?t=0");
    expect(screen.getByRole("search", { name: "Buscar y filtrar replays" })).toBeTruthy();
  });
});

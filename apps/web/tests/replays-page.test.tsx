// @vitest-environment jsdom
/**
 * R7-A · DoD del listado de replays (#/replays). Mockea `fetch` a `GET /replays`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ReplaysPage } from "../src/pages/ReplaysPage.js";

const ITEMS = [
  {
    battleId: "btl_a",
    ticks: 300,
    winner: "draw",
    official: false,
    createdAt: "2026-07-19T00:00:00.000Z",
    sizeBytes: 100,
  },
  {
    battleId: "btl_b",
    ticks: 120,
    winner: "red",
    official: true,
    createdAt: "2026-07-18T00:00:00.000Z",
    sizeBytes: 200,
  },
];

function mockFetch(impl: (url: string) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn((u: string | URL) => impl(String(u))) as unknown as typeof fetch);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("R7-A · #/replays", () => {
  it("renderiza la lista con enlaces a visor y reproductor", async () => {
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ items: ITEMS }), { status: 200 })));
    render(<ReplaysPage />);
    const rows = await screen.findAllByTestId("replay-row");
    expect(rows.length).toBe(2);
    const first = within(rows[0]);
    expect(first.getByText("btl_a")).toBeTruthy();
    expect((first.getByText("visor") as HTMLAnchorElement).getAttribute("href")).toBe("#/viewer/btl_a");
    expect((first.getByText("reproductor") as HTMLAnchorElement).getAttribute("href")).toBe("#/replay/btl_a");
  });

  it("estado vacío", async () => {
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 })));
    render(<ReplaysPage />);
    expect(await screen.findByText(/No hay replays todavía/i)).toBeTruthy();
  });

  it("error de servicio no disponible", async () => {
    mockFetch(() => Promise.resolve(new Response("boom", { status: 503 })));
    render(<ReplaysPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toMatch(/no disponible/i);
  });
});

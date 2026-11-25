// @vitest-environment jsdom
/**
 * V1 REPLAYS PR-5 (P2-3) · el listado NO ofrece «Ver replay» para un replay truncado (`recording_limit`): el visor lo
 * rechaza (404). Muestra «Truncado: sólo descarga», sin enlace. Control: un replay normal sigue con su enlace.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ReplaysPage } from "../src/pages/ReplaysPage.js";

const ITEMS = [
  {
    battleId: "btl_trunc",
    ticks: 300,
    winner: "none",
    endReason: "recording_limit",
    official: true,
    createdAt: "2026-07-19T00:00:00.000Z",
    sizeBytes: 100,
  },
  {
    battleId: "btl_ok",
    ticks: 120,
    winner: "red",
    official: true,
    createdAt: "2026-07-18T00:00:00.000Z",
    sizeBytes: 200,
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PR-5 · listado de replays con un truncado", () => {
  it("TL1 el truncado no tiene enlace al reproductor; el normal sí", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ items: ITEMS }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ) as unknown as typeof fetch,
    );
    render(<ReplaysPage />);
    const rows = await screen.findAllByTestId("replay-row");
    const trunc = within(rows[0]);
    expect(trunc.queryByText("Ver replay")).toBeNull();
    expect(trunc.getByTestId("replay-truncated").textContent).toMatch(/sólo descarga/);
    expect(trunc.getByText("detenida por límite de grabación")).toBeTruthy();
    expect(within(rows[1]).getByText("Ver replay").getAttribute("href")).toBe("#/replay/btl_ok?t=0");
  });
});

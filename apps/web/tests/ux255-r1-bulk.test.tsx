// @vitest-environment jsdom
/**
 * #255 · ronda 1 · TeamBulkPublic (REVIEWER-B P3-1, P3-2 y P3-3), desde la política:
 *  - P3-1 · la confirmación envía los bots previsualizados; si el servidor dice que el
 *    equipo cambió (409 team_bots_changed), la web NO da nada por hecho: lo avisa,
 *    vuelve a previsualizar y pide confirmar otra vez;
 *  - P3-2 · los bots retirados se ven aparte, distinguibles, y no cuentan como «se
 *    harán públicos»;
 *  - P3-3 · el botón dice lo que va a pasar: si sólo cambia el código, no «0 bots».
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../src/api.js", () => {
  class ApiRequestError extends Error {
    constructor(
      public status: number,
      public body: Record<string, unknown>,
    ) {
      super(String(body?.message ?? `HTTP ${status}`));
    }
  }
  return { api: vi.fn(), setToken: vi.fn(), getToken: vi.fn(() => "tok"), onSessionExpired: vi.fn(), ApiRequestError };
});

import { api, ApiRequestError } from "../src/api.js";
import { TeamBulkPublic, confirmLabel } from "../src/pages/TeamBulkPublic.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const TEAM = { id: "t1", name: "Rojos" };
type Body = { dryRun: boolean; includeCode: boolean; expectBotIds?: string[] };
type Row = { botId: string; name: string; outcome: string; code?: { version: number | null; outcome: string } };

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

function backend(rowsFor: (b: Body) => Row[], opts: { conflictOnce?: boolean } = {}) {
  const bodies: Body[] = [];
  let conflicts = opts.conflictOnce ? 1 : 0;
  apiMock.mockImplementation(async (_m: string, _p: string, body: Body) => {
    bodies.push(body);
    if (!body.dryRun && conflicts > 0) {
      conflicts--;
      throw new (ApiRequestError as unknown as new (s: number, b: Record<string, unknown>) => Error)(409, {
        error: "team_bots_changed",
        message: "cambió",
      });
    }
    const results = rowsFor(body);
    return {
      dryRun: body.dryRun,
      includeCode: body.includeCode,
      results,
      summary: {
        changed: results.filter((r) => /make_public/.test(r.outcome)).length,
        alreadyPublic: results.filter((r) => r.outcome === "already_public").length,
        notAuthorized: results.filter((r) => r.outcome === "not_authorized").length,
        retired: results.filter((r) => r.outcome === "retired").length,
      },
    };
  });
  return bodies;
}

describe("#255 R1 · TeamBulkPublic", () => {
  it("P3-1 · confirma con los ids previsualizados; con 409 avisa, NO aplica, re-previsualiza y deja confirmar la lista nueva", async () => {
    let round = 0;
    const bodies = backend(
      (b) => {
        if (b.dryRun) round++;
        const rows: Row[] = [{ botId: "a", name: "A", outcome: b.dryRun ? "would_make_public" : "made_public" }];
        if (round >= 2) rows.push({ botId: "n", name: "N", outcome: b.dryRun ? "would_make_public" : "made_public" });
        return rows;
      },
      { conflictOnce: true },
    );
    const changed = vi.fn();
    render(<TeamBulkPublic team={TEAM} onChanged={changed} />);
    await userEvent.click(screen.getByTestId("team-bulk-open"));
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findByTestId("bulk-will-A");
    await userEvent.click(within(dlg).getByTestId("team-bulk-confirm"));
    expect(bodies[1]).toEqual({ dryRun: false, includeCode: false, expectBotIds: ["a"] });
    // 409: el diálogo sigue abierto, lo dice, no hay resultado y se ve la lista NUEVA.
    expect((await within(dlg).findByTestId("team-bulk-stale")).textContent).toMatch(/no se ha cambiado nada/);
    await within(dlg).findByTestId("bulk-will-N");
    expect(screen.queryByTestId("team-bulk-result")).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    expect(bodies[2]).toMatchObject({ dryRun: true });
    await userEvent.click(within(dlg).getByTestId("team-bulk-confirm"));
    await screen.findByTestId("team-bulk-result");
    expect(bodies[3]).toEqual({ dryRun: false, includeCode: false, expectBotIds: ["a", "n"] });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("P3-2 · un bot retirado sale aparte, distinguible, y no cuenta en «Se harán públicos»", async () => {
    backend((b) => [
      { botId: "a", name: "A", outcome: b.dryRun ? "would_make_public" : "made_public" },
      { botId: "r", name: "R", outcome: "retired" },
    ]);
    render(<TeamBulkPublic team={TEAM} onChanged={() => {}} />);
    await userEvent.click(screen.getByTestId("team-bulk-open"));
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findByTestId("bulk-will-A");
    expect(within(dlg).getByTestId("team-bulk-will").textContent).toMatch(/Se harán públicos \(1\)/);
    expect(within(dlg).getByTestId("team-bulk-will").textContent).not.toMatch(/\bR\b/);
    expect(within(dlg).getByTestId("team-bulk-retired").textContent).toMatch(/retirados \(1\)/);
    expect(within(dlg).getByTestId("bulk-retired-R")).toBeTruthy();
    await userEvent.click(within(dlg).getByTestId("team-bulk-confirm"));
    const res = await screen.findByTestId("team-bulk-result");
    expect(within(res).getByTestId("bulk-result-R").getAttribute("data-outcome")).toBe("retired");
    expect(within(res).getByTestId("bulk-result-R").textContent).toMatch(/retirado, no se ha tocado/);
    expect(within(res).getByTestId("team-bulk-summary").textContent).toMatch(/1 retirado/);
  });

  it("P3-3 · si sólo cambia el código, el botón no dice «hacer públicos 0 bots»", async () => {
    backend((b) => [
      {
        botId: "a",
        name: "A",
        outcome: "already_public",
        ...(b.includeCode ? { code: { version: 3, outcome: b.dryRun ? "would_make_public" : "made_public" } } : {}),
      },
    ]);
    render(<TeamBulkPublic team={TEAM} onChanged={() => {}} />);
    await userEvent.click(screen.getByTestId("team-bulk-open"));
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findByTestId("team-bulk-nothing");
    await userEvent.click(within(dlg).getByTestId("team-bulk-include-code"));
    await waitFor(() =>
      expect((within(dlg).getByTestId("team-bulk-confirm") as HTMLButtonElement).disabled).toBe(false),
    );
    const label = within(dlg).getByTestId("team-bulk-confirm").textContent ?? "";
    expect(label).not.toMatch(/0 bots/);
    expect(label).toBe("Confirmar: hacer público el código de 1 versión");
  });

  it("P3-3 · confirmLabel: bots, código o ambos, con singular y plural", () => {
    expect(confirmLabel(2, 0)).toBe("Confirmar: hacer públicos 2 bots");
    expect(confirmLabel(1, 0)).toBe("Confirmar: hacer público 1 bot");
    expect(confirmLabel(0, 2)).toBe("Confirmar: hacer público el código de 2 versiones");
    expect(confirmLabel(2, 1)).toBe("Confirmar: hacer públicos 2 bots y el código de 1 versión");
  });
});

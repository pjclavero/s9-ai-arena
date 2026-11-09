// @vitest-environment jsdom
/**
 * #255 · unitarios (calibrables con mutantes) de:
 *  - B8-B10 · el bloque ÚNICO «Directo y retransmisión» de BattleDetailPage;
 *  - B5-B7 · «Hacer públicos los bots que administras» (TeamBulkPublic): la
 *    previsualización y el resultado SALEN DEL SERVIDOR; el código no cambia por
 *    defecto; la confirmación es obligatoria.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../src/api.js", () => ({
  api: vi.fn(),
  setToken: vi.fn(),
  getToken: vi.fn(() => "tok"),
  onSessionExpired: vi.fn(),
  bootstrapSession: vi.fn(),
  logout: vi.fn(),
  ApiRequestError: class extends Error {},
}));

import { api } from "../src/api.js";
import { BattleDetailPage, BROADCAST_BLOCKED_TEXT } from "../src/pages/BattleDetailPage.js";
import { TeamBulkPublic } from "../src/pages/TeamBulkPublic.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ID = "6953a070-0a7f-4b40-887b-ad2c1155acf1";
const ADMIN = { id: "a1", displayName: "Admin", email: "a@x.es", roles: ["admin"], twoFactorEnabled: false };
const USER = { id: "u1", displayName: "Ana", email: "u@x.es", roles: ["user"], twoFactorEnabled: false };
const BATTLE = (status: string, extra: Record<string, unknown> = {}) => ({
  id: ID,
  status,
  mode: "deathmatch",
  mapId: "m",
  mapName: "Arena",
  mapVersion: 1,
  participants: [
    { botId: "b1", botName: "Rojo", version: 1, team: "red" },
    { botId: "b2", botName: "Azul", version: 1, team: "blue" },
  ],
  replayAvailable: status === "finished",
  ...(status === "finished" ? { result: { winner: "red", ticks: 900 } } : {}),
  ...extra,
});

let calls: string[] = [];
function backend(
  battle: Record<string, unknown>,
  target?: { broadcastable: boolean; broadcastBlockedReason: string | null },
) {
  calls = [];
  apiMock.mockImplementation(async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    if (path === `/battles/${ID}`) return battle;
    if (path === `/battles/${ID}/stats`) return { battleId: ID, status: "unavailable", perBot: {}, diagnostics: {} };
    if (path === `/battles/${ID}/audit`) return {};
    if (path.startsWith("/admin/streaming/target")) {
      if (!target) throw Object.assign(new Error("caído"), { status: 502 });
      return { kind: "battle", id: ID, ...target };
    }
    throw new Error(`inesperado ${method} ${path}`);
  });
}

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("#255 · BATTLE_LIVE_AND_BROADCAST_GROUPED (unitario)", () => {
  it("en curso + admin: UN bloque con «Ver en directo» y «Retransmitir» (abre Streaming con la batalla) y su estado", async () => {
    backend(BATTLE("running"), { broadcastable: true, broadcastBlockedReason: null });
    render(<BattleDetailPage id={ID} me={ADMIN} />);
    const block = await screen.findByTestId("live-broadcast");
    expect(within(block).getByTestId("watch-live").getAttribute("href")).toBe(`#/viewer/${ID}`);
    await waitFor(() =>
      expect(within(block).getByTestId("broadcast-status").textContent).toMatch(/^Se puede retransmitir/),
    );
    expect(within(block).getByTestId("broadcast-battle").getAttribute("href")).toBe(`#/streaming?battle=${ID}`);
    // Nada fuera del bloque: ni otro «Retransmitir» ni «Ver en directo» dentro del estado.
    expect(screen.getAllByText("Retransmitir")).toHaveLength(1);
    expect(within(screen.getByTestId("battle-live-note")).queryByRole("link")).toBeNull();
    // Sólo LEE la retransmisibilidad: ninguna escritura.
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
  });

  it("en curso + admin + no retransmitible: botón deshabilitado y la explicación humana del motivo", async () => {
    backend(BATTLE("running"), { broadcastable: false, broadcastBlockedReason: "battle_not_public" });
    render(<BattleDetailPage id={ID} me={ADMIN} />);
    const status = await screen.findByTestId("broadcast-status");
    await waitFor(() => expect(status.textContent).toBe(BROADCAST_BLOCKED_TEXT.battle_not_public));
    expect((screen.getByTestId("broadcast-battle-blocked") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("broadcast-battle")).toBeNull();
  });

  it("en curso + usuario normal: «Ver en directo» sí; «Retransmitir» y su estado, no (ni se pregunta a la API de admin)", async () => {
    backend(BATTLE("running"));
    render(<BattleDetailPage id={ID} me={USER} />);
    expect(await screen.findByTestId("watch-live")).toBeTruthy();
    expect(screen.queryByTestId("broadcast-battle")).toBeNull();
    expect(screen.queryByTestId("broadcast-status")).toBeNull();
    expect(calls.some((c) => c.includes("/admin/streaming"))).toBe(false);
  });
});

describe("#255 · FINISHED_BATTLE_NO_FAKE_REPLAY (unitario)", () => {
  it("terminada + admin: «Ver resultado», «Replay: no disponible para retransmisión», replay normal; NUNCA retransmitir", async () => {
    backend(BATTLE("finished"), { broadcastable: true, broadcastBlockedReason: null });
    render(<BattleDetailPage id={ID} me={ADMIN} />);
    const block = await screen.findByTestId("live-broadcast");
    expect(within(block).getByTestId("replay-not-broadcastable").textContent).toContain(
      "Replay: no disponible para retransmisión",
    );
    expect(within(block).getByTestId("battle-replay-link").getAttribute("href")).toBe(`#/replay/${ID}?t=0`);
    expect(within(block).getByTestId("show-result")).toBeTruthy();
    expect(screen.queryByTestId("broadcast-battle")).toBeNull();
    expect(screen.queryByTestId("broadcast-battle-blocked")).toBeNull();
    expect(screen.queryByTestId("watch-live")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Retransmitir replay/i);
    expect(screen.queryByRole("link", { name: /Retransmitir/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Retransmitir/ })).toBeNull();
    expect(calls.some((c) => c.includes("/admin/streaming"))).toBe(false);
    // «Ver resultado» lleva el foco a las estadísticas.
    await userEvent.click(within(block).getByTestId("show-result"));
    expect(document.activeElement?.id).toBe("battle-stats-title");
  });
});

describe("#255 · TeamBulkPublic (unitario)", () => {
  const TEAM = { id: "t1", name: "Rojos" };
  type Body = { dryRun: boolean; includeCode: boolean };
  function bulkBackend() {
    const bodies: Body[] = [];
    apiMock.mockImplementation(async (method: string, path: string, body: Body) => {
      expect(method).toBe("POST");
      expect(path).toBe("/teams/t1/actions/publish-bots");
      bodies.push(body);
      const results = [
        {
          botId: "a",
          name: "A",
          outcome: body.dryRun ? "would_make_public" : "made_public",
          ...(body.includeCode
            ? { code: { version: 2, outcome: body.dryRun ? "would_make_public" : "made_public" } }
            : {}),
        },
        { botId: "m", name: "M", outcome: "not_authorized" },
      ];
      return {
        dryRun: body.dryRun,
        includeCode: body.includeCode,
        results,
        summary: { changed: 1, alreadyPublic: 0, notAuthorized: 1 },
      };
    });
    return bodies;
  }

  it("TEAM_BULK_PUBLIC · previsualiza (dryRun, sin código), confirma y enseña el resultado real", async () => {
    const bodies = bulkBackend();
    const changed = vi.fn();
    render(<TeamBulkPublic team={TEAM} onChanged={changed} />);
    await userEvent.click(screen.getByTestId("team-bulk-open"));
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findByTestId("bulk-will-A");
    expect(bodies).toEqual([{ dryRun: true, includeCode: false }]);
    expect(within(dlg).getByTestId("team-bulk-untouched").textContent).toContain(
      "el código fuente, las versiones ni el equipamiento",
    );
    expect((within(dlg).getByTestId("team-bulk-include-code") as HTMLInputElement).checked).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    await userEvent.click(within(dlg).getByTestId("team-bulk-confirm"));
    const res = await screen.findByTestId("team-bulk-result");
    expect(bodies[1]).toEqual({ dryRun: false, includeCode: false });
    expect(within(res).getByTestId("bulk-result-A").getAttribute("data-outcome")).toBe("made_public");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("TEAM_BULK_PARTIAL_RESULT · el no autorizado sale en la previsualización y en el resultado, sin ocultarlo", async () => {
    bulkBackend();
    render(<TeamBulkPublic team={TEAM} onChanged={() => {}} />);
    await userEvent.click(screen.getByTestId("team-bulk-open"));
    const dlg = await screen.findByRole("dialog");
    expect((await within(dlg).findByTestId("bulk-denied-M")).textContent).toBe("✗ M");
    await userEvent.click(within(dlg).getByTestId("team-bulk-confirm"));
    const res = await screen.findByTestId("team-bulk-result");
    expect(within(res).getByTestId("team-bulk-summary").textContent).toMatch(/1 sin autorización: no se han tocado/);
    expect(within(res).getByTestId("bulk-result-M").getAttribute("data-outcome")).toBe("not_authorized");
  });

  it("el código sólo con la casilla explícita: la previsualización y la confirmación lo llevan", async () => {
    const bodies = bulkBackend();
    render(<TeamBulkPublic team={TEAM} onChanged={() => {}} />);
    await userEvent.click(screen.getByTestId("team-bulk-open"));
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findByTestId("bulk-will-A");
    await userEvent.click(within(dlg).getByTestId("team-bulk-include-code"));
    await waitFor(() => expect(within(dlg).getByTestId("bulk-will-A").textContent).toContain("y el código de v2"));
    await userEvent.click(within(dlg).getByTestId("team-bulk-confirm"));
    await screen.findByTestId("team-bulk-result");
    expect(bodies.map((b) => b.includeCode)).toEqual([false, true, true]);
  });

  it("TEAM_BULK_PERMISSION_DENIED · sin bots propios: nada que confirmar; Cancelar no escribe y devuelve el foco", async () => {
    const bodies: Body[] = [];
    apiMock.mockImplementation(async (_m: string, _p: string, body: Body) => {
      bodies.push(body);
      return {
        dryRun: true,
        includeCode: false,
        results: [{ botId: "m", name: "M", outcome: "not_authorized" }],
        summary: { changed: 0, alreadyPublic: 0, notAuthorized: 1 },
      };
    });
    render(<TeamBulkPublic team={TEAM} onChanged={() => {}} />);
    await userEvent.click(screen.getByTestId("team-bulk-open"));
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findByTestId("team-bulk-nothing");
    expect((within(dlg).getByTestId("team-bulk-confirm") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(dlg).getByTestId("team-bulk-cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("team-bulk-open"));
    expect(bodies.every((b) => b.dryRun === true)).toBe(true);
  });
});

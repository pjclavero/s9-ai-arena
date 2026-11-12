// @vitest-environment jsdom
/**
 * FIX-BROADCAST · Administración → Streaming dice QUÉ se emite y POR QUÉ no se puede:
 *  - el destino en claro: «Torneo "prueba" (terminado, 0 en curso)» o «Batalla suelta A vs B
 *    (…; no pertenece a ningún torneo)» — el error operativo del incidente fue cambiar la sesión
 *    de una batalla suelta a un torneo creyendo que la batalla era de él;
 *  - el motivo en lenguaje humano (el código, plegado en detalles técnicos);
 *  - «INICIAR» deshabilitado con el motivo cuando `broadcastAvailable=false`, aunque el listado
 *    de destinos (más antiguo) dijera otra cosa: manda getStreamingTarget.
 * Cada garantía tiene su mutante en scripts/fix-broadcast-mutants.sh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
import {
  StreamingPage,
  humanReason,
  targetSummaryText,
  type Destination,
  type StreamingAdminState,
} from "../src/pages/StreamingPage.js";
import { BroadcastPage } from "../src/pages/BroadcastPage.js";
import { parseBroadcastConfig } from "../src/broadcast/config.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["admin"], twoFactorEnabled: false };
const T_ID = "55555555-5555-4555-8555-555555555555";
const B_ID = "66666666-6666-4666-8666-666666666666";

const T_PRUEBA: Destination = {
  kind: "tournament",
  id: T_ID,
  label: "prueba",
  status: "finished",
  mode: "deathmatch",
  tournamentName: "prueba",
  startedAt: null,
  finishedAt: null,
  createdAt: new Date().toISOString(),
  broadcastable: true,
  broadcastBlockedReason: null,
  tournamentBroadcast: false,
  // El listado (cacheado/antiguo) lo daba por emitible: manda getStreamingTarget.
  broadcastAvailable: true,
  reason: null,
};
const T_INFO = {
  kind: "tournament",
  id: T_ID,
  label: "prueba",
  status: "finished",
  broadcastable: true,
  broadcastBlockedReason: null,
  tournamentBroadcast: false,
  publicBroadcastable: false,
  broadcastAvailable: false,
  reason: "public_replays_disabled",
  publicSpectateEffective: true,
  publicReplaysEffective: false,
  targetType: "tournament",
  tournament: null,
  battleCounts: { scheduled: 0, running: 0, finished: 3, failed: 0 },
  broadcastPhase: "UNAVAILABLE",
  delaySeconds: 0,
  delaySource: "none",
};
const B_INFO = {
  kind: "battle",
  id: B_ID,
  label: "Alfa vs Beta",
  status: "running",
  broadcastable: true,
  broadcastBlockedReason: null,
  tournamentBroadcast: null,
  publicBroadcastable: true,
  broadcastAvailable: true,
  reason: null,
  publicSpectateEffective: true,
  publicReplaysEffective: false,
  targetType: "standalone_battle",
  tournament: null,
  battleCounts: null,
  broadcastPhase: "LIVE",
  delaySeconds: 0,
  delaySource: "none",
};

function baseState(over: Partial<StreamingAdminState> = {}): StreamingAdminState {
  return {
    settings: {
      enabled: true,
      mode: "record",
      platform: "youtube",
      ingestUrl: null,
      encoder: "x264",
      preset: "1080p",
      fps: 30,
      videoBitrateKbps: 4500,
      branding: { eventName: "Copa", logoUrl: null, primaryColor: "#10141f", accentColor: "#ffb300" },
      retention: { enabled: false, maxAgeDays: 14, maxTotalBytes: null },
      version: 3,
      updatedAt: "2026-11-12T10:00:00.000Z",
    },
    platforms: [{ id: "youtube", label: "YouTube", ingestUrl: "rtmps://a.rtmps.youtube.com/live2" }],
    ingests: [],
    credentials: [
      { platform: "youtube", configured: true, masked: "****ABCD", updatedAt: null, compatible: true, backup: "none" },
    ],
    capabilities: {
      sealedStore: true,
      streamerConfigured: true,
      streamerReachable: true,
      streamerError: null,
      nvenc: false,
    },
    streamer: { state: "idle", desired: false, lastError: null },
    session: null,
    pendingRestart: false,
    uxState: "ready",
    bitrate: { min: 3000, max: 6000, recommended: 4500 },
    changeClasses: {},
    ...over,
  } as StreamingAdminState;
}

let state: StreamingAdminState;
beforeEach(() => {
  state = baseState();
  apiMock.mockReset();
  apiMock.mockImplementation(async (_m: string, path: string) => {
    if (path === "/admin/streaming") return state;
    if (path.startsWith("/admin/streaming/destinations")) return { battles: [], tournaments: [T_PRUEBA] };
    if (path.startsWith(`/admin/streaming/target?kind=tournament&id=${T_ID}`)) return T_INFO;
    if (path.startsWith(`/admin/streaming/target?kind=battle&id=${B_ID}`)) return B_INFO;
    if (path.startsWith("/admin/streaming/audit")) return [];
    if (path === "/admin/streaming/recordings") return { dir: "x", count: 0, totalBytes: 0, disk: null, files: [] };
    return {};
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FIX-BROADCAST · texto del destino", () => {
  it("torneo: nombre, estado y batallas en curso; batalla suelta: dice que no pertenece a ningún torneo", () => {
    expect(targetSummaryText(T_INFO as never)).toBe('Torneo "prueba" (terminado, 0 en curso)');
    expect(
      targetSummaryText({ ...T_INFO, status: "running", battleCounts: { scheduled: 2, running: 1, finished: 0, failed: 0 } } as never),
    ).toBe('Torneo "prueba" (en curso, 1 en curso, 2 programadas)');
    expect(targetSummaryText(B_INFO as never)).toBe(
      "Batalla suelta Alfa vs Beta (en curso; no pertenece a ningún torneo)",
    );
    expect(
      targetSummaryText({
        ...B_INFO,
        targetType: "tournament_battle",
        tournament: { id: T_ID, name: "prueba", state: "running" },
      } as never),
    ).toBe('Batalla Alfa vs Beta (en curso; del torneo "prueba")');
  });

  it("los motivos de destino salen en lenguaje humano, nunca el código crudo", () => {
    for (const code of [
      "public_replays_disabled",
      "tournament_no_content",
      "tournament_not_started",
      "target_not_available",
      "battle_not_started",
      "battle_not_available",
      "target_not_found",
    ]) {
      const txt = humanReason(code, `HTTP 409 ${code}`);
      expect(txt, code).not.toContain(code);
      expect(txt, code).not.toMatch(/HTTP \d{3}/);
    }
  });
});

describe("FIX-BROADCAST · vista simple: destino y motivo, INICIAR deshabilitado", () => {
  it("torneo terminado sin replays públicos: muestra el destino, el motivo humano y bloquea INICIAR", async () => {
    render(<StreamingPage me={ME} route="#/streaming" />);
    fireEvent.change(await screen.findByTestId("simple-kind"), { target: { value: "tournament" } });
    const sel = (await screen.findByTestId("simple-destination")) as HTMLSelectElement;
    await waitFor(() => expect(sel.options.length).toBe(2));
    fireEvent.change(sel, { target: { value: `tournament:${T_ID}` } });

    expect((await screen.findByTestId("stream-target-summary-text")).textContent).toBe(
      'Torneo "prueba" (terminado, 0 en curso)',
    );
    const reason = screen.getByTestId("stream-target-summary-reason");
    expect(reason.textContent).toMatch(/replays públicos están desactivados/);
    expect(reason.textContent).not.toContain("public_replays_disabled");
    // El código sólo plegado, en «Ver detalles técnicos».
    expect(screen.getByTestId("stream-target-summary-tech").tagName).toBe("DETAILS");
    expect(screen.getByTestId("stream-target-summary-tech").textContent).toContain("public_replays_disabled");

    const start = screen.getByTestId("stream-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByTestId("start-blockers").textContent).toMatch(/replays públicos están desactivados/);
  });
});

describe("FIX-BROADCAST · en directo: qué se está emitiendo", () => {
  const live = (target: { kind: string; id: string }) =>
    baseState({
      uxState: "recording",
      session: { id: "s1", mode: "record", target, startedAt: new Date().toISOString() },
      streamer: { state: "recording", desired: true, lastError: null, restarts: 0 },
    });

  it("sesión sobre el torneo «prueba»: «Emitiendo: Torneo "prueba" (terminado, 0 en curso)» y el motivo", async () => {
    state = live({ kind: "tournament", id: T_ID });
    render(<StreamingPage me={ME} route="#/streaming" />);
    expect((await screen.findByTestId("live-target-text")).textContent).toBe(
      'Emitiendo: Torneo "prueba" (terminado, 0 en curso)',
    );
    expect(screen.getByTestId("live-destination").textContent).toBe('Torneo "prueba" (terminado, 0 en curso)');
    expect(screen.getByTestId("live-target-reason").textContent).toMatch(/replays públicos/);
  });

  it("sesión sobre una batalla suelta: lo dice (no pertenece a ningún torneo) y no muestra motivo", async () => {
    state = live({ kind: "battle", id: B_ID });
    render(<StreamingPage me={ME} route="#/streaming" />);
    expect((await screen.findByTestId("live-target-text")).textContent).toBe(
      "Emitiendo: Batalla suelta Alfa vs Beta (en curso; no pertenece a ningún torneo)",
    );
    expect(screen.queryByTestId("live-target-reason")).toBeNull();
  });
});

describe("FIX-BROADCAST · /broadcast pública: estado distinguible y reportable", () => {
  function stubFetch(handler: (url: string) => { ok: boolean; status: number; body: () => unknown }) {
    vi.stubGlobal("fetch", async (url: unknown) => {
      const r = handler(String(url));
      return { ok: r.ok, status: r.status, json: async () => r.body() } as Response;
    });
  }
  afterEach(() => vi.unstubAllGlobals());

  it("torneo terminado con la lista vacía ⇒ «Torneo terminado» y data-director-state=TARGET_FINISHED", async () => {
    stubFetch((url) =>
      url.startsWith("/api/v1/tournaments?")
        ? { ok: true, status: 200, body: () => ({ items: [{ id: "t1", state: "finished" }] }) }
        : { ok: true, status: 200, body: () => ({ items: [] }) },
    );
    render(<BroadcastPage config={parseBroadcastConfig("?tournament=t1")} />);
    await waitFor(() => expect(screen.getByTestId("broadcast-finished")).toBeTruthy());
    expect(screen.getByTestId("broadcast-finished").textContent).toMatch(/Torneo terminado/);
    expect(screen.getByTestId("broadcast-stage").getAttribute("data-director-state")).toBe("TARGET_FINISHED");
    expect(screen.queryByTestId("broadcast-waiting")).toBeNull();
  });

  it("torneo cancelado ⇒ pantalla de cancelado (TARGET_CANCELLED)", async () => {
    stubFetch((url) =>
      url.startsWith("/api/v1/tournaments?")
        ? { ok: true, status: 200, body: () => ({ items: [{ id: "t1", state: "cancelled" }] }) }
        : { ok: true, status: 200, body: () => ({ items: [] }) },
    );
    render(<BroadcastPage config={parseBroadcastConfig("?tournament=t1")} />);
    await waitFor(() => expect(screen.getByTestId("broadcast-cancelled")).toBeTruthy());
    expect(screen.getByTestId("broadcast-stage").getAttribute("data-director-state")).toBe("TARGET_CANCELLED");
  });

  it("la web devolviendo index.html ⇒ error visible (SOURCE_ERROR invalid_json), nunca «empieza en breve»", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubFetch(() => ({ ok: true, status: 200, body: () => JSON.parse("<!doctype html>") }));
    render(<BroadcastPage config={parseBroadcastConfig("?battle=b1")} />);
    await waitFor(() => expect(screen.getByTestId("broadcast-source-error")).toBeTruthy());
    const stage = screen.getByTestId("broadcast-stage");
    expect(stage.getAttribute("data-director-state")).toBe("SOURCE_ERROR");
    expect(stage.getAttribute("data-source-error")).toBe("invalid_json");
    expect(stage.textContent).not.toMatch(/empieza en breve/);
  });
});

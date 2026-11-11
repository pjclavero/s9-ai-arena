// @vitest-environment jsdom
/**
 * STREAMING-UX · pantalla de Streaming simplificada (API simulada).
 * Nombres del encargo: STREAMING_SIMPLE_VIEW, LEFT_ALIGNED_NAV, RECENT_BATTLE_SELECTOR,
 * TOURNAMENT_SELECTOR, UUID_NOT_REQUIRED_NORMAL_FLOW, BROADCASTABLE_DESTINATION_SELECTABLE,
 * BLOCKED_DESTINATION_EXPLAINS_REASON, CHANNEL_STATUS_VISIBLE, QUALITY_PRESETS,
 * START_VISIBLE_WHEN_READY, STOP_ALWAYS_VISIBLE_WHEN_LIVE, ADVANCED_SETTINGS_SEPARATED,
 * ACTIVE_INGEST_VISIBLE y los errores en lenguaje humano. La disposición real (menú a la
 * izquierda, móvil sin scroll lateral, STOP dentro del viewport) se mide con Playwright
 * en tests/browser/specs/streaming-ux.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
  destinationText,
  finishedBattleNotice,
  humanReason,
  liveBadgeText,
  QUALITY_PRESETS,
  relativeTime,
  StreamingPage,
  type Destination,
  type StreamingAdminState,
} from "../src/pages/StreamingPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["admin"], twoFactorEnabled: false };
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const B_RECENT: Destination = {
  kind: "battle",
  id: "11111111-1111-4111-8111-111111111111",
  label: "Team A vs Team B",
  status: "finished",
  mode: "deathmatch",
  tournamentName: null,
  startedAt: ago(30),
  finishedAt: ago(12),
  createdAt: ago(31),
  broadcastable: true,
  broadcastBlockedReason: null,
  tournamentBroadcast: null,
};
const B_LIVE: Destination = {
  ...B_RECENT,
  id: "22222222-2222-4222-8222-222222222222",
  label: "Rojo vs Azul",
  status: "running",
  finishedAt: null,
  startedAt: ago(3),
};
const B_BLOCKED: Destination = {
  ...B_RECENT,
  id: "33333333-3333-4333-8333-333333333333",
  label: "Privado vs Público",
  broadcastable: false,
  broadcastBlockedReason: "battle_not_public",
};
const T_CUP: Destination = {
  ...B_RECENT,
  kind: "tournament",
  id: "44444444-4444-4444-8444-444444444444",
  label: "Copa de otoño",
  status: "running",
  tournamentBroadcast: true,
};

function baseState(over: Partial<StreamingAdminState> = {}): StreamingAdminState {
  return {
    settings: {
      enabled: true,
      mode: "rtmps",
      platform: "youtube",
      ingestUrl: null,
      encoder: "x264",
      preset: "1080p",
      fps: 30,
      videoBitrateKbps: 4500,
      branding: { eventName: "Copa", logoUrl: null, primaryColor: "#10141f", accentColor: "#ffb300" },
      retention: { enabled: false, maxAgeDays: 14, maxTotalBytes: null },
      version: 3,
      updatedAt: "2026-11-02T10:00:00.000Z",
    },
    platforms: [
      { id: "youtube", label: "YouTube", ingestUrl: "rtmps://a.rtmps.youtube.com/live2" },
      { id: "custom", label: "RTMPS personalizado", ingestUrl: null },
    ],
    ingests: [
      {
        platform: "youtube",
        primaryIngestUrl: "rtmps://a.rtmps.youtube.com/live2",
        backupIngestUrl: "rtmps://b.rtmps.youtube.com/live2?backup=1",
        source: "default",
        backupQueryAllowed: true,
      },
      {
        platform: "custom",
        primaryIngestUrl: null,
        backupIngestUrl: null,
        source: "default",
        backupQueryAllowed: false,
      },
    ],
    credentials: [
      { platform: "youtube", configured: true, masked: "****ABCD", updatedAt: null, compatible: true, backup: "ready" },
      { platform: "custom", configured: false, masked: null, updatedAt: null, compatible: null, backup: "none" },
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
  };
}

let state: StreamingAdminState;
const calls: { method: string; path: string; body: unknown }[] = [];
let testResponse: unknown = {};
let startError: unknown = null;
function route(method: string, path: string, body?: unknown): unknown {
  calls.push({ method, path, body });
  if (method === "GET" && path === "/admin/streaming") return state;
  if (path.startsWith("/admin/streaming/destinations"))
    return { battles: [B_LIVE, B_BLOCKED, B_RECENT], tournaments: [T_CUP] };
  if (path.startsWith("/admin/streaming/target"))
    return {
      kind: "battle",
      id: B_LIVE.id,
      label: "Rojo vs Azul",
      status: "running",
      publicBroadcastable: true,
      delaySeconds: 0,
      delaySource: "none",
    };
  if (path === "/admin/streaming/start") {
    if (startError) throw startError;
    return { alreadyActive: false };
  }
  if (path === "/admin/streaming/test") return testResponse;
  if (path.startsWith("/admin/streaming/ingests/")) return { changed: true, warnings: [] };
  if (path === "/admin/streaming/settings")
    return { changed: ["preset"], impact: {}, warnings: [], pendingRestart: false, stopped: false };
  if (path.startsWith("/admin/streaming/audit")) return [];
  if (path === "/admin/streaming/recordings") return { dir: "x", count: 0, totalBytes: 0, disk: null, files: [] };
  return {};
}

beforeEach(() => {
  state = baseState();
  calls.length = 0;
  testResponse = {};
  startError = null;
  apiMock.mockReset();
  apiMock.mockImplementation(async (m: string, p: string, b?: unknown) => route(m, p, b));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function pick(value: string) {
  const sel = (await screen.findByTestId("simple-destination")) as HTMLSelectElement;
  await waitFor(() => expect(sel.options.length).toBeGreaterThan(1));
  fireEvent.change(sel, { target: { value } });
}

describe("#256 · batalla terminada (REPLAY_STREAMING_SUPPORTED = NO)", () => {
  it("avisa de que sólo se emitirá la pantalla final; nada para batallas en curso ni torneos", () => {
    expect(finishedBattleNotice({ kind: "battle", status: "finished" })).toMatch(/pantalla final.*no se retransmite/);
    expect(finishedBattleNotice({ kind: "battle", status: "running" })).toBeNull();
    expect(finishedBattleNotice({ kind: "tournament", status: "finished" })).toBeNull();
  });
});

describe("STREAMING-UX · vista simple", () => {
  it("STREAMING_SIMPLE_VIEW + LEFT_ALIGNED_NAV + ADVANCED_SETTINGS_SEPARATED · lo esencial delante; lo técnico, aparte", async () => {
    render(<StreamingPage me={ME} route="#/streaming" />);
    const nav = await screen.findByTestId("streaming-nav");
    expect(nav.className).toBe("streaming-nav");
    expect(
      within(nav)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Streaming", "Configuración avanzada", "Grabaciones", "Auditoría"]);
    expect(screen.getByTestId("streaming-page").className).toBe("streaming-layout");
    for (const id of [
      "simple-kind",
      "simple-destination",
      "simple-channel",
      "simple-quality",
      "stream-start",
      "simple-advanced-link",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    // Nada técnico en la vista normal: ni UUID, ni encoder, ni bitrate, ni clave, ni branding, ni grabaciones.
    for (const id of [
      "stream-target-id",
      "set-encoder",
      "set-bitrate",
      "credential-youtube-input",
      "br-name",
      "ret-age",
      "streaming-audit",
      "ing-primary",
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    fireEvent.click(screen.getByTestId("streaming-tab-advanced"));
    for (const id of [
      "stream-target-id",
      "set-encoder",
      "set-bitrate",
      "ing-primary",
      "ing-backup",
      "credential-youtube-input",
      "br-name",
      "streaming-monitor",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(screen.queryByTestId("stream-start")).toBeNull();
    fireEvent.click(screen.getByTestId("streaming-tab-recordings"));
    expect(await screen.findByTestId("streaming-recordings")).toBeTruthy();
    fireEvent.click(screen.getByTestId("streaming-tab-audit"));
    expect(await screen.findByTestId("streaming-audit")).toBeTruthy();
  });

  it("RECENT_BATTLE_SELECTOR · en curso primero, nombre legible, estado y antigüedad; sin UUID", async () => {
    render(<StreamingPage me={ME} route="#/streaming" />);
    const sel = (await screen.findByTestId("simple-destination")) as HTMLSelectElement;
    await waitFor(() => expect(sel.options.length).toBe(4));
    const texts = [...sel.options].slice(1).map((o) => o.textContent!);
    expect(texts[0]).toMatch(/^Rojo vs Azul · En curso · hace 3 min$/);
    expect(texts[2]).toBe("Team A vs Team B · Finalizada · hace 12 min");
    expect(texts[1]).toMatch(/No retransmisible$/);
    expect(texts.join(" ")).not.toMatch(UUID_RE);
  });

  it("TOURNAMENT_SELECTOR · «Torneo» lista torneos por nombre", async () => {
    render(<StreamingPage me={ME} route="#/streaming" />);
    fireEvent.change(await screen.findByTestId("simple-kind"), { target: { value: "tournament" } });
    const sel = (await screen.findByTestId("simple-destination")) as HTMLSelectElement;
    await waitFor(() => expect([...sel.options].map((o) => o.textContent)).toContain("Copa de otoño · En curso"));
    fireEvent.change(sel, { target: { value: `tournament:${T_CUP.id}` } });
    expect((await screen.findByTestId("simple-broadcastable")).textContent).toMatch(/torneo con retransmisión pública/);
  });

  it("UUID_NOT_REQUIRED_NORMAL_FLOW + BROADCASTABLE_DESTINATION_SELECTABLE + START_VISIBLE_WHEN_READY · elegir y emitir sin escribir nada", async () => {
    render(<StreamingPage me={ME} route="#/streaming" />);
    const start = (await screen.findByTestId("stream-start")) as HTMLButtonElement;
    expect(start.textContent).toBe("INICIAR EMISIÓN");
    expect(start.disabled).toBe(true);
    await pick(`battle:${B_RECENT.id}`);
    expect(screen.getByTestId("simple-broadcastable").textContent).toMatch(/^Retransmisible/);
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(calls.some((c) => c.path === "/admin/streaming/start")).toBe(true));
    expect(calls.find((c) => c.path === "/admin/streaming/start")!.body).toEqual({
      target: { kind: "battle", id: B_RECENT.id },
    });
    expect(document.querySelectorAll("input[type=text], input:not([type])").length).toBe(0); // ningún campo de texto en el flujo
  });

  it("BLOCKED_DESTINATION_EXPLAINS_REASON · explicación humana; el código, sólo en detalles técnicos", async () => {
    render(<StreamingPage me={ME} route="#/streaming" />);
    await pick(`battle:${B_BLOCKED.id}`);
    const msg = screen.getByTestId("stream-target-private");
    expect(msg.textContent).toBe(
      "No retransmisible: esta batalla no puede retransmitirse porque contiene bots privados y no pertenece a un torneo con retransmisión pública.",
    );
    expect(msg.textContent).not.toContain("battle_not_public");
    expect(screen.getByTestId("simple-target-tech").textContent).toContain("battle_not_public");
    expect((screen.getByTestId("stream-start") as HTMLButtonElement).disabled).toBe(true);
  });

  it("CHANNEL_STATUS_VISIBLE · canal con el estado de la clave (enmascarada) y aviso si falta", async () => {
    render(<StreamingPage me={ME} route="#/streaming" />);
    expect((await screen.findByTestId("channel-status")).textContent).toBe("Clave configurada · ****ABCD");
    cleanup();
    state = baseState({
      credentials: [{ platform: "youtube", configured: false, masked: null, updatedAt: null, compatible: null }],
    });
    render(<StreamingPage me={ME} route="#/streaming" />);
    expect((await screen.findByTestId("channel-status")).textContent).toMatch(/Sin clave de emisión/);
    await pick(`battle:${B_RECENT.id}`);
    expect(screen.getByTestId("start-blockers").textContent).toContain("No hay una clave de YouTube configurada.");
  });

  it("QUALITY_PRESETS · 1080p30, 720p30, 1080p60 y 720p60; sin bitrate manual; elige el bitrate recomendado", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StreamingPage me={ME} route="#/streaming" />);
    const q = (await screen.findByTestId("simple-quality")) as HTMLSelectElement;
    expect([...q.options].map((o) => o.textContent)).toEqual(QUALITY_PRESETS.map((p) => p.label));
    expect(QUALITY_PRESETS.map((p) => p.id)).toEqual(["1080p@30", "720p@30", "1080p@60", "720p@60"]);
    fireEvent.change(q, { target: { value: "720p@60" } });
    await waitFor(() => expect(calls.some((c) => c.path === "/admin/streaming/settings")).toBe(true));
    expect(calls.find((c) => c.path === "/admin/streaming/settings")!.body).toEqual({
      version: 3,
      preset: "720p",
      fps: 60,
      videoBitrateKbps: 4500,
      confirmHighFps: true,
    });
  });

  it("errores humanos: credential_missing al iniciar se dice en frase; el código, en detalles", async () => {
    startError = Object.assign(new Error("No hay clave de emisión configurada para esta plataforma"), {
      status: 409,
      body: { error: "credential_missing", message: "No hay clave de emisión configurada para esta plataforma" },
    });
    render(<StreamingPage me={ME} route="#/streaming" />);
    await pick(`battle:${B_RECENT.id}`);
    fireEvent.click(screen.getByTestId("stream-start"));
    const err = await screen.findByTestId("streaming-error");
    expect(err.querySelector("strong")!.textContent).toBe("No hay una clave de YouTube configurada.");
    expect(err.getAttribute("data-code")).toBe("credential_missing");
  });

  it("textos de error del encargo", () => {
    expect(humanReason("credential_missing", "", "YouTube")).toBe("No hay una clave de YouTube configurada.");
    expect(humanReason("streamer_unavailable", "x")).toBe("El servicio de streaming no está disponible.");
    expect(humanReason("streamer_unreachable", "x")).toBe("El servicio de streaming no está disponible.");
    expect(humanReason("battle_not_public", "x")).toBe("Esta batalla no puede retransmitirse públicamente.");
    expect(humanReason(null, "la ingesta no respondió a connect a tiempo", "YouTube")).toBe(
      "YouTube no respondió a la conexión.",
    );
    expect(relativeTime(ago(12), NOW)).toBe("hace 12 min");
    expect(destinationText(B_RECENT, NOW)).toBe("Team A vs Team B · Finalizada · hace 12 min");
  });
});

describe("STREAMING-UX · en directo", () => {
  const live = (over: Partial<StreamingAdminState> = {}) =>
    baseState({
      uxState: "live",
      session: { id: "s1", mode: "rtmps", target: { kind: "battle", id: B_LIVE.id }, startedAt: ago(5) },
      streamer: {
        state: "streaming",
        desired: true,
        lastError: null,
        restarts: 0,
        stats: { frames: 9000, fps: 30, bitrateKbps: 4480, droppedFrames: 2, outTimeSeconds: 300 },
        relay: {
          state: "publishing",
          bytesOut: 1,
          ingest: "primary",
          backupAvailable: true,
          failedOver: false,
          ingestErrors: { primary: null, backup: null },
        },
      },
      ...over,
    });

  it("STOP_ALWAYS_VISIBLE_WHEN_LIVE · «● EN DIRECTO», datos esenciales, DETENER arriba e INICIAR fuera", async () => {
    state = live();
    render(<StreamingPage me={ME} route="#/streaming" />);
    expect((await screen.findByTestId("live-badge")).textContent).toContain("EN DIRECTO");
    const bar = screen.getByTestId("live-badge").parentElement!;
    expect(bar.className).toBe("streaming-live-bar"); // barra fija arriba (sticky)
    expect(within(bar).getByTestId("stream-stop").textContent).toBe("DETENER EMISIÓN");
    expect(screen.queryByTestId("stream-start")).toBeNull();
    expect(screen.getByTestId("mon-rate").textContent).toBe("30 fps · 4480 kbit/s");
    expect(screen.getByTestId("live-dropped").textContent).toBe("2");
    expect(screen.getByTestId("live-channel").textContent).toBe("YouTube");
    expect(screen.getByTestId("live-duration").textContent).toMatch(/^5:0\d$/);
    expect(await screen.findByText("Rojo vs Azul")).toBeTruthy();
    // La tabla técnica, plegada.
    expect(screen.getByTestId("live-tech").tagName).toBe("DETAILS");
    expect(screen.getByTestId("live-tech").hasAttribute("open")).toBe(false);
  });

  it("ACTIVE_INGEST_VISIBLE · «Ingesta activa: Principal | Respaldo» y aviso de failover", async () => {
    state = live();
    render(<StreamingPage me={ME} route="#/streaming" />);
    expect((await screen.findByTestId("active-ingest")).textContent).toBe("Principal");
    expect(screen.queryByTestId("failover-notice")).toBeNull();
    cleanup();
    state = live({
      streamer: {
        ...live().streamer!,
        relay: {
          state: "publishing",
          bytesOut: 1,
          ingest: "backup",
          backupAvailable: true,
          failedOver: true,
          ingestErrors: { primary: "la ingesta no respondió a la conexión (IPv6: ETIMEDOUT)", backup: null },
        },
      },
    });
    render(<StreamingPage me={ME} route="#/streaming" />);
    expect((await screen.findByTestId("active-ingest")).textContent).toBe("Respaldo");
    expect(screen.getByTestId("failover-notice").textContent).toBe(
      "Principal no disponible · Usando servidor de respaldo",
    );
  });

  it("§24 · si fallan las dos: frase humana y «Principal: … / Respaldo: …»", async () => {
    state = live({
      uxState: "failed",
      streamer: {
        state: "failed",
        desired: true,
        lastError: { message: "la ingesta no respondió a la conexión (IPv4: ETIMEDOUT)", at: ago(1) },
        // cola del render (lo que vio QA: 30.07 fps · 65 kbit/s junto a «DETENIDA POR ERROR»)
        stats: { frames: 9000, fps: 30.07, bitrateKbps: 65, droppedFrames: 3, outTimeSeconds: 10 },
        relay: {
          state: null,
          bytesOut: 0,
          ingest: "backup",
          backupAvailable: true,
          failedOver: true,
          ingestErrors: {
            primary: "la ingesta no respondió a la conexión",
            backup: "la ingesta no respondió a la conexión",
          },
        },
      },
    });
    render(<StreamingPage me={ME} route="#/streaming" />);
    const f = await screen.findByTestId("live-failure");
    expect(f.querySelector("strong")!.textContent).toBe("YouTube no respondió a la conexión.");
    expect(screen.getByTestId("live-failure-ingests").textContent).toBe(
      "Principal: YouTube no respondió a la conexión. / Respaldo: YouTube no respondió a la conexión.",
    );
    expect((screen.getByTestId("stream-stop") as HTMLButtonElement).disabled).toBe(false);
    // Ronda 1 (P3) · parada por error: nada de fps ni frames rancios de la cola del render.
    expect(screen.getByTestId("mon-rate").textContent).toBe("—");
    expect(screen.getByTestId("live-dropped").textContent).toBe("—");
  });

  it("Ronda 1 (Q-H2) · en «Sólo grabar», «● GRABANDO» no tapa Reconectando ni Error", async () => {
    const rec = (uxState: StreamingAdminState["uxState"], streamerState: string) =>
      live({
        uxState,
        settings: { ...baseState().settings, mode: "record" },
        session: { id: "s1", mode: "record", target: { kind: "battle", id: B_LIVE.id }, startedAt: ago(5) },
        streamer: {
          state: streamerState,
          desired: true,
          restarts: 5,
          lastError: uxState === "failed" ? { message: "Cannot open display", at: ago(1) } : null,
          stats: { frames: 10, fps: 0, bitrateKbps: 0, droppedFrames: 0, outTimeSeconds: 0 },
        },
      });
    for (const [ux, ss, badge] of [
      ["retrying", "retrying", "RECONECTANDO"],
      ["failed", "failed", "DETENIDA POR ERROR"],
      ["recording", "streaming", "GRABANDO"],
    ] as const) {
      state = rec(ux, ss);
      render(<StreamingPage me={ME} route="#/streaming" />);
      expect((await screen.findByTestId("live-badge")).textContent, ux).toBe(`● ${badge}`);
      expect(screen.getByTestId("stream-stop").textContent).toBe("DETENER GRABACIÓN");
      if (ux === "retrying") {
        // y el texto de estado no habla de «conexión» en una grabación local
        expect(screen.getByTestId("streaming-state").textContent).toContain("La grabación se interrumpió");
      }
      cleanup();
    }
    // tabla completa (la prioridad: error > reintento > modo)
    expect(liveBadgeText("interrupted", true)).toBe("DETENIDA POR ERROR");
    expect(liveBadgeText("failed", false)).toBe("DETENIDA POR ERROR");
    expect(liveBadgeText("retrying", false)).toBe("RECONECTANDO");
    expect(liveBadgeText("live", false)).toBe("EN DIRECTO");
    expect(liveBadgeText("starting", false)).toBe("CONECTANDO…");
    expect(liveBadgeText("starting", true)).toBe("PREPARANDO GRABACIÓN…");
  });

  it("Ronda 2 (ERROR_STATE_CLEARS_START_NOTICE) · START → conectando → error: el aviso verde desaparece y manda el error", async () => {
    // Sólo se falsea el sondeo (setInterval); setTimeout sigue real para waitFor/findBy.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      render(<StreamingPage me={ME} route="#/streaming" />);
      await pick(`battle:${B_LIVE.id}`);
      // START: la API acepta y el siguiente estado es «conectando» (uxState=starting).
      const session = { id: "s1", mode: "rtmps", target: { kind: "battle", id: B_LIVE.id }, startedAt: ago(0) };
      apiMock.mockImplementation(async (m: string, p: string, b?: unknown) => {
        if (p === "/admin/streaming/start")
          state = live({
            uxState: "starting",
            session,
            streamer: { state: "starting", desired: true, lastError: null },
          });
        return route(m, p, b);
      });
      fireEvent.click(screen.getByTestId("stream-start"));
      const notice = await screen.findByTestId("streaming-notice");
      expect(notice.textContent).toBe("Emisión iniciada: conectando…");
      expect(notice.className).toBe("ok");
      expect((await screen.findByTestId("live-badge")).textContent).toBe("● CONECTANDO…");
      expect(screen.getByTestId("streaming-ux-state").textContent).toBe("Iniciando");

      // El streamer agota sus intentos: el SONDEO (no una acción del usuario) trae «failed».
      state = live({
        uxState: "failed",
        session,
        streamer: {
          state: "failed",
          desired: true,
          restarts: 5,
          lastError: { message: "la ingesta no respondió a la conexión (IPv4: ETIMEDOUT)", at: ago(0) },
          stats: { frames: 10, fps: 30, bitrateKbps: 65, droppedFrames: 0, outTimeSeconds: 1 },
          relay: {
            state: null,
            bytesOut: 0,
            ingest: "primary",
            backupAvailable: false,
            failedOver: false,
            ingestErrors: { primary: "la ingesta no respondió a la conexión", backup: null },
          },
        },
      });
      const polls = calls.filter((c) => c.method === "GET" && c.path === "/admin/streaming").length;
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await waitFor(() =>
        expect(calls.filter((c) => c.method === "GET" && c.path === "/admin/streaming").length).toBeGreaterThan(polls),
      );
      // Domina el error…
      await waitFor(() => expect(screen.getByTestId("streaming-ux-state").textContent).toBe("Error"));
      expect(screen.getByTestId("live-badge").textContent).toBe("● DETENIDA POR ERROR");
      expect(screen.getByTestId("live-failure").querySelector("strong")!.textContent).toBe(
        "YouTube no respondió a la conexión.",
      );
      // …y el aviso verde de inicio ya no está.
      expect(screen.queryByTestId("streaming-notice")).toBeNull();
      // Ningún mensaje contradictorio en toda la página.
      const text = document.body.textContent ?? "";
      for (const contradiction of [
        "Emisión iniciada",
        "conectando…",
        "Conectando",
        "CONECTANDO",
        "EN DIRECTO",
        "Todavía no está en directo",
        "Se está emitiendo",
      ]) {
        expect(text, contradiction).not.toContain(contradiction);
      }
      expect(document.querySelectorAll("[role=status].ok, p.ok[data-testid=streaming-notice]").length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Ronda 1 (P3) · Auditoría", () => {
  it("«Quién» muestra el nombre del usuario; el UUID, sólo en «Ver detalles técnicos»", async () => {
    const uuid = "55555555-5555-4555-8555-555555555555";
    apiMock.mockImplementation(async (m: string, p: string, b?: unknown) =>
      p.startsWith("/admin/streaming/audit")
        ? [
            { id: "1", actorId: uuid, actorName: "Ana", action: "streaming.start", target: "x", at: ago(1) },
            { id: "2", action: "streaming.session.recovered", target: "y", at: ago(2) },
          ]
        : route(m, p, b),
    );
    render(<StreamingPage me={ME} route="#/streaming?tab=audit" />);
    const card = await screen.findByTestId("streaming-audit");
    await waitFor(() => expect(within(card).getAllByRole("row").length).toBe(3));
    const cells = within(card)
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.querySelectorAll("td")[3]);
    expect(cells[0].firstChild!.textContent).toBe("Ana");
    expect(cells[0].querySelector("details")!.hasAttribute("open")).toBe(false);
    expect(cells[0].querySelector("details code")!.textContent).toBe(uuid);
    expect(cells[1].textContent).toBe("sistema");
  });
});

describe("STREAMING-UX · Avanzada → servidores", () => {
  it("principal y respaldo editables, guardados tal cual; «Probar ingesta» dice Principal y Respaldo por separado", async () => {
    testResponse = {
      ok: true,
      connectMs: 40,
      primary: { ok: true, connectMs: 40 },
      backup: { ok: false, error: "la ingesta no respondió a la conexión (IPv4: ETIMEDOUT)" },
    };
    render(<StreamingPage me={ME} route="#/streaming?tab=advanced" />);
    const p = (await screen.findByTestId("ing-primary")) as HTMLInputElement;
    const b = screen.getByTestId("ing-backup") as HTMLInputElement;
    expect(p.value).toBe("rtmps://a.rtmps.youtube.com/live2");
    expect(b.value).toBe("rtmps://b.rtmps.youtube.com/live2?backup=1");
    fireEvent.change(b, { target: { value: "rtmps://b.rtmps.youtube.com/live2?backup=1" } });
    fireEvent.click(screen.getByTestId("ing-save"));
    await waitFor(() => expect(calls.some((c) => c.path === "/admin/streaming/ingests/youtube")).toBe(true));
    expect(calls.find((c) => c.path === "/admin/streaming/ingests/youtube")!.body).toEqual({
      primaryIngestUrl: "rtmps://a.rtmps.youtube.com/live2",
      backupIngestUrl: "rtmps://b.rtmps.youtube.com/live2?backup=1",
    });
    fireEvent.click(screen.getByTestId("stream-test"));
    expect((await screen.findByTestId("ingest-test-primary")).textContent).toBe("Principal: OK (40 ms)");
    expect(screen.getByTestId("ingest-test-backup").textContent).toBe("Respaldo: YouTube no respondió a la conexión.");
    // Ronda 1 (P3) · respaldo caído ⇒ NO «Prueba correcta» en verde: aviso ámbar de estado mixto
    const n = await screen.findByTestId("streaming-notice");
    expect(n.className).toBe("warn");
    expect(n.textContent).toMatch(/^Prueba a medias: la principal conecta .* el respaldo NO/);
    expect(n.textContent).not.toContain("Prueba correcta");
  });

  it("Ronda 1 (P3) · las dos OK ⇒ «Prueba correcta» en verde", async () => {
    testResponse = {
      ok: true,
      connectMs: 40,
      primary: { ok: true, connectMs: 40 },
      backup: { ok: true, connectMs: 30 },
    };
    render(<StreamingPage me={ME} route="#/streaming?tab=advanced" />);
    fireEvent.click(await screen.findByTestId("stream-test"));
    const n = await screen.findByTestId("streaming-notice");
    expect(n.className).toBe("ok");
    expect(n.textContent).toMatch(/^Prueba correcta/);
  });

  it("Ronda 1 (P3) · la tarjeta de emisión muestra la ingesta CONFIGURADA, no la de fábrica", async () => {
    const configured = "rtmps://otra-ingesta.example.com/live2";
    state = baseState({
      ingests: baseState().ingests!.map((i) =>
        i.platform === "youtube" ? { ...i, primaryIngestUrl: configured, source: "configured" } : i,
      ),
    });
    render(<StreamingPage me={ME} route="#/streaming?tab=advanced" />);
    expect((await screen.findByTestId("set-platform-ingest")).textContent).toBe(`Ingesta: ${configured}`);
  });
});

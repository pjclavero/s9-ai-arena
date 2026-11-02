// @vitest-environment jsdom
/**
 * EQ5b · Administración → Streaming (pantalla). API simulada (vi.mock de api.js):
 *  - estados de UX con su mensaje (§17);
 *  - la clave: campo password, se envía y el estado se VACÍA; nunca en
 *    localStorage/sessionStorage; la pantalla sólo pinta «****ABCD»;
 *  - controles sin contradicciones (no se puede iniciar con emisión activa; sin
 *    destino comprobado tampoco) y «Retransmitir» preselecciona SIN arrancar;
 *  - 60 FPS y desactivar con emisión activa piden confirmación;
 *  - NVENC deshabilitado si el runtime no lo confirma;
 *  - branding hostil bloqueado y vista previa = /broadcast con los parámetros;
 *  - botón «Retransmitir» sólo para admin.
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
import { previewUrl, StreamingPage, UX_TEXT, validLogo, type StreamingAdminState } from "../src/pages/StreamingPage.js";
import { BroadcastButton } from "../src/broadcast/BroadcastButton.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["admin"], twoFactorEnabled: false };
const BATTLE = "11111111-2222-4333-8444-555555555555";
const KEY = "clave-super-secreta-ZZ99";

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
    credentials: [
      {
        platform: "youtube",
        configured: true,
        masked: "****ZZ99",
        updatedAt: "2026-11-02T10:00:00.000Z",
        compatible: true,
      },
      { platform: "custom", configured: false, masked: null, updatedAt: null, compatible: null },
    ],
    capabilities: {
      sealedStore: true,
      streamerConfigured: true,
      streamerReachable: true,
      streamerError: null,
      nvenc: false,
    },
    streamer: {
      state: "idle",
      desired: false,
      lastError: null,
      stats: { frames: 0, fps: 0, bitrateKbps: 0, droppedFrames: 0, outTimeSeconds: 0 },
    },
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
function route(method: string, path: string, body?: unknown): unknown {
  calls.push({ method, path, body });
  if (method === "GET" && path === "/admin/streaming") return state;
  if (path.startsWith("/admin/streaming/target")) {
    return {
      kind: "battle",
      id: BATTLE,
      label: "Batalla 11111111",
      status: "running",
      publicBroadcastable: true,
      delaySeconds: 30,
      delaySource: "snapshot",
    };
  }
  if (path === "/admin/streaming/recordings")
    return {
      dir: "arena_replays/video",
      count: 1,
      totalBytes: 2048,
      disk: { totalBytes: 1e10, freeBytes: 5e9 },
      files: [{ name: "broadcast-x.mp4", sizeBytes: 2048, modifiedAt: "", inProgress: false }],
    };
  if (path.startsWith("/admin/streaming/audit"))
    return [
      {
        id: "1",
        action: "streaming.credential.set",
        target: "streaming:credential:youtube",
        at: "2026-11-02T10:00:00.000Z",
      },
    ];
  if (path.startsWith("/admin/streaming/credentials/"))
    return { platform: "youtube", configured: true, masked: "****ZZ99", appliesOnNextStart: false };
  if (path === "/admin/streaming/settings")
    return { changed: ["fps"], impact: { fps: "restart" }, warnings: [], pendingRestart: true, stopped: false };
  if (path === "/admin/streaming/start") return { alreadyActive: false };
  return {};
}

beforeEach(() => {
  state = baseState();
  calls.length = 0;
  apiMock.mockReset();
  apiMock.mockImplementation(async (m: string, p: string, b?: unknown) => route(m, p, b));
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EQ5b · estados de la UX", () => {
  it.each(Object.keys(UX_TEXT) as (keyof typeof UX_TEXT)[])("estado %s: título y mensaje", async (ux) => {
    state = baseState({ uxState: ux });
    render(<StreamingPage me={ME} route="#/streaming" />);
    const badge = await screen.findByTestId("streaming-ux-state");
    expect(badge.textContent).toBe(UX_TEXT[ux].title);
    expect(screen.getByTestId("streaming-state").textContent).toContain(UX_TEXT[ux].text);
  });

  it("pendiente de reinicio y sin almacén seguro se avisan", async () => {
    state = baseState({ pendingRestart: true, capabilities: { ...baseState().capabilities, sealedStore: false } });
    render(<StreamingPage me={ME} route="#/streaming" />);
    expect(await screen.findByTestId("pending-restart")).toBeTruthy();
    expect(screen.getByTestId("sealed-store-missing")).toBeTruthy();
  });
});

describe("EQ5b · la clave en el navegador", () => {
  it("campo password; al guardar se vacía; nada en storage; sólo se pinta ****ABCD", async () => {
    render(<StreamingPage me={ME} route="#/streaming" />);
    const input = (await screen.findByTestId("credential-youtube-input")) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("new-password");
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.submit(screen.getByTestId("credential-youtube"));
    await waitFor(() => expect(calls.some((c) => c.path === "/admin/streaming/credentials/youtube")).toBe(true));
    expect(
      (calls.find((c) => c.path === "/admin/streaming/credentials/youtube")!.body as { streamKey: string }).streamKey,
    ).toBe(KEY);
    expect(input.value).toBe("");
    await screen.findByTestId("streaming-notice");
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(JSON.stringify({ ...localStorage })).not.toContain(KEY);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(KEY);
    expect(screen.getByTestId("credential-youtube-state").textContent).toContain("****ZZ99");
  });
});

describe("EQ5b · controles", () => {
  it("«Retransmitir» preselecciona y comprueba el destino SIN arrancar; muestra el retardo de las reglas", async () => {
    render(<StreamingPage me={ME} route={`#/streaming?battle=${BATTLE}`} />);
    expect(((await screen.findByTestId("stream-target-id")) as HTMLInputElement).value).toBe(BATTLE);
    expect((await screen.findByTestId("stream-delay")).textContent).toMatch(/30 s.*copia de reglas/);
    expect(calls.some((c) => c.path === "/admin/streaming/start")).toBe(false);
    const start = screen.getByTestId("stream-start") as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(calls.some((c) => c.path === "/admin/streaming/start")).toBe(true));
    expect(calls.find((c) => c.path === "/admin/streaming/start")!.body).toEqual({
      target: { kind: "battle", id: BATTLE },
    });
  });

  it("sin destino, con emisión activa o con el streaming desactivado, «Iniciar» está deshabilitado", async () => {
    render(<StreamingPage me={ME} route="#/streaming" />);
    expect(((await screen.findByTestId("stream-start")) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    state = baseState({
      uxState: "live",
      session: {
        id: "s1",
        mode: "rtmps",
        target: { kind: "battle", id: BATTLE },
        startedAt: "2026-11-02T10:00:00.000Z",
      },
    });
    render(<StreamingPage me={ME} route={`#/streaming?battle=${BATTLE}`} />);
    await screen.findByTestId("stream-delay");
    expect((screen.getByTestId("stream-start") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("stream-stop") as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    state = baseState({ uxState: "disabled", settings: { ...baseState().settings, enabled: false } });
    render(<StreamingPage me={ME} route={`#/streaming?battle=${BATTLE}`} />);
    await screen.findByTestId("stream-delay");
    expect((screen.getByTestId("stream-start") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("stream-stop") as HTMLButtonElement).disabled).toBe(true);
  });

  it("EQ5d · «Iniciando» (relé aún sin publicar): no dice «En directo», «Detener» disponible e «Iniciar» bloqueado", async () => {
    state = baseState({
      uxState: "starting",
      session: {
        id: "s1",
        mode: "rtmps",
        target: { kind: "battle", id: BATTLE },
        startedAt: "2026-11-02T10:00:00.000Z",
      },
    });
    render(<StreamingPage me={ME} route={`#/streaming?battle=${BATTLE}`} />);
    await screen.findByTestId("stream-delay");
    expect(screen.getByTestId("streaming-ux-state").textContent).toBe("Iniciando");
    expect(screen.getByTestId("streaming-state").textContent).not.toContain(UX_TEXT.live.title);
    expect((screen.getByTestId("stream-start") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("stream-stop") as HTMLButtonElement).disabled).toBe(false);
  });

  it("60 FPS pide confirmación; si se cancela no se guarda nada", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<StreamingPage me={ME} route="#/streaming" />);
    fireEvent.change(await screen.findByTestId("set-fps"), { target: { value: "60" } });
    fireEvent.click(screen.getByTestId("set-save"));
    expect(confirm).toHaveBeenCalled();
    expect(calls.some((c) => c.path === "/admin/streaming/settings")).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId("set-save"));
    await waitFor(() => expect(calls.some((c) => c.path === "/admin/streaming/settings")).toBe(true));
    expect(calls.find((c) => c.path === "/admin/streaming/settings")!.body).toMatchObject({
      version: 3,
      fps: 60,
      confirmHighFps: true,
    });
    expect((await screen.findByTestId("streaming-notice")).textContent).toContain(
      "se aplicará al reiniciar la emisión",
    );
  });

  it("desactivar con emisión activa pide confirmación y manda confirmStop", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    state = baseState({
      uxState: "live",
      session: { id: "s1", mode: "rtmps", target: null, startedAt: "2026-11-02T10:00:00.000Z" },
    });
    render(<StreamingPage me={ME} route="#/streaming" />);
    fireEvent.click(await screen.findByTestId("set-enabled"));
    fireEvent.click(screen.getByTestId("set-save"));
    await waitFor(() => expect(calls.some((c) => c.path === "/admin/streaming/settings")).toBe(true));
    expect(calls.find((c) => c.path === "/admin/streaming/settings")!.body).toMatchObject({
      enabled: false,
      confirmStop: true,
    });
  });

  it("NVENC deshabilitado si el runtime no lo confirma", async () => {
    render(<StreamingPage me={ME} route="#/streaming" />);
    const sel = (await screen.findByTestId("set-encoder")) as HTMLSelectElement;
    const nv = [...sel.options].find((o) => o.value === "nvenc")!;
    expect(nv.disabled).toBe(true);
    expect(nv.textContent).toMatch(/no disponible/);
  });
});

describe("EQ5b · branding", () => {
  it("logo/colores hostiles se bloquean; la vista previa es /broadcast con los parámetros", async () => {
    expect(validLogo("javascript:alert(1)")).toBe(false);
    expect(validLogo("//evil.example/x.png")).toBe(false);
    expect(validLogo("https://cdn.example/logo.png")).toBe(true);
    expect(validLogo("/logo.png")).toBe(true);
    render(<StreamingPage me={ME} route="#/streaming" />);
    const preview = (await screen.findByTestId("br-preview")) as HTMLIFrameElement;
    expect(preview.getAttribute("src")).toBe(previewUrl(state.settings.branding));
    expect(preview.getAttribute("src")).toMatch(/^\/broadcast\?event=Copa&primary=%2310141f&accent=%23ffb300$/);
    fireEvent.change(screen.getByTestId("br-logo"), { target: { value: "javascript:alert(1)" } });
    expect(screen.getByTestId("br-errors").textContent).toMatch(/logo/);
    expect((screen.getByTestId("br-save") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("br-preview")).toBeNull();
  });
});

describe("EQ5b · botón «Retransmitir»", () => {
  it("sólo admin; enlace a Streaming con el destino; no llama a la API", () => {
    const { rerender } = render(<BroadcastButton me={ME} kind="battle" id={BATTLE} />);
    expect(screen.getByTestId("broadcast-battle").getAttribute("href")).toBe(`#/streaming?battle=${BATTLE}`);
    rerender(<BroadcastButton me={{ ...ME, roles: ["moderator"] }} kind="battle" id={BATTLE} />);
    expect(screen.queryByTestId("broadcast-battle")).toBeNull();
    rerender(<BroadcastButton me={null} kind="tournament" id={BATTLE} />);
    expect(screen.queryByTestId("broadcast-tournament")).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });
});

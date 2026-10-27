// @vitest-environment jsdom
/**
 * FC-D (D1/D2/D3/D4/D8, TD-009/TD-022) · Garantías nuevas de la web, cada una con
 * un test capaz de ponerse ROJO:
 *  - plazo del cliente HTTP (timeout ⇒ error clasificado, no «Cargando…» eterno);
 *  - clasificación única de errores (403/404/500/502/timeout/red);
 *  - F5 con la API caída NO manda al login (TD-022);
 *  - rutas desconocidas ⇒ página 404 (TD-022);
 *  - espera de la escena de Phaser: no resuelve antes de READY + CREATE (TD-009);
 *  - SpectatorClient: rechazo terminal (44xx) sin bucle de reconexión; wsUrl relativo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { api, setToken, onSessionExpired, ApiRequestError } from "../src/api.js";
import { describeApiError } from "../src/errors.js";
import { App, matchStaticPanelRoute, matchPanelRoute } from "../src/App.js";
import { ErrorState, FormError } from "../src/ui/primitives.js";
import { waitForScene, SceneNotReadyError } from "../src/viewer/scene-ready.js";
import { SpectatorClient, isTerminalCloseCode, resolveWsUrl } from "../src/viewer/spectator-client.js";
import { summarizeBattle } from "../src/battle-result.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  setToken(null);
  onSessionExpired(null);
  window.location.hash = "";
});

function jsonRes(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === "content-type" && body !== undefined ? "application/json" : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("FC-D · plazo del cliente HTTP", () => {
  it("una API que no responde lanza ApiRequestError kind=timeout al vencer el plazo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_r, rej) =>
            init.signal?.addEventListener("abort", () => rej(new DOMException("abort", "AbortError"))),
          ),
      ),
    );
    const p = api("GET", "/bots", undefined, { timeoutMs: 30 });
    await expect(p).rejects.toMatchObject({ kind: "timeout", status: 0 });
    const d = describeApiError(await p.catch((e) => e));
    expect(d.kind).toBe("timeout");
    expect(d.retryable).toBe(true);
  });

  it("un fallo de red es kind=network (no un 'HTTP 0' ambiguo)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await expect(api("GET", "/bots")).rejects.toMatchObject({ kind: "network" });
  });

  it("un 502 con HTML del gateway conserva el estado y lo nombra", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, headers: { get: () => "text/html" }, json: async () => ({}) })),
    );
    const e = await api("GET", "/teams").catch((x) => x);
    expect(e).toBeInstanceOf(ApiRequestError);
    expect(describeApiError(e)).toMatchObject({ kind: "unavailable", title: "Servicio no disponible (502)" });
  });
});

describe("FC-D · clasificación de errores", () => {
  const mk = (s: number) => new ApiRequestError(s, { message: `m${s}` });
  it.each([
    [400, "validation", false],
    [403, "forbidden", false],
    [404, "notFound", false],
    [409, "conflict", false],
    [500, "server", true],
    [503, "unavailable", true],
  ])("HTTP %i ⇒ %s (reintentable=%s)", (s, kind, retry) => {
    expect(describeApiError(mk(s))).toMatchObject({ kind, retryable: retry, detail: `m${s}` });
  });

  it("ErrorState con error 403 dice «No tienes permiso» y mantiene el detalle real", () => {
    render(<ErrorState label="los equipos" error={mk(403)} onRetry={() => {}} />);
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-error-kind")).toBe("forbidden");
    expect(alert.textContent).toContain("No tienes permiso");
    expect(alert.textContent).toContain("No se pudo cargar los equipos: m403");
  });

  it("FormError pinta título, mensaje y detalles de validación; null no pinta nada", () => {
    const { container } = render(<FormError error={null} />);
    expect(container.textContent).toBe("");
    render(<FormError error={new ApiRequestError(400, { message: "nombre vacío", details: ["name: requerido"] })} />);
    const el = screen.getByTestId("form-error");
    expect(el.textContent).toContain("Datos no válidos");
    expect(el.textContent).toContain("nombre vacío");
    expect(el.textContent).toContain("name: requerido");
  });
});

describe("FC-D · arranque con la API caída (TD-022)", () => {
  it("F5 con refresh 502 muestra «No se puede contactar» con Reintentar, NO el login", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls++;
        if (String(url).endsWith("/auth/refresh")) return jsonRes(502);
        return jsonRes(404, { message: "?" });
      }),
    );
    render(<App />);
    const box = await screen.findByTestId("boot-error");
    expect(box.textContent).toContain("Servicio no disponible (502)");
    expect(screen.queryByLabelText("email")).toBeNull();
    const before = calls;
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await screen.findByTestId("boot-error");
    expect(calls).toBeGreaterThan(before);
  });

  it("refresh 401 (sin sesión) sí lleva al login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(401, { message: "no" })),
    );
    render(<App />);
    expect(await screen.findByLabelText("email")).toBeTruthy();
    expect(screen.queryByTestId("boot-error")).toBeNull();
  });
});

describe("FC-D · navegación (D8)", () => {
  it("rutas conocidas resuelven; las desconocidas no (⇒ 404)", () => {
    // UX-A · la raíz es «Inicio» (checklist de primeros pasos), no «Mis bots».
    expect(matchStaticPanelRoute("")).toBe("home");
    expect(matchStaticPanelRoute("#/")).toBe("home");
    expect(matchStaticPanelRoute("#/bots")).toBe("bots");
    expect(matchStaticPanelRoute("#/teams")).toBe("teams");
    expect(matchStaticPanelRoute("#/maps/editor")).toBe("mapEditor");
    expect(matchStaticPanelRoute("#/maps")).toBe("maps");
    expect(matchStaticPanelRoute("#/replays/")).toBe("replays");
    expect(matchStaticPanelRoute("#/no-existe")).toBeNull();
    expect(matchStaticPanelRoute("#/teamsX")).toBeNull();
    expect(matchPanelRoute("#/battles?bot=b1")).toEqual({ kind: "battles", botFilter: "b1" });
    expect(matchPanelRoute("#/battles/basura")).toBeNull();
  });

  it("con sesión, un hash desconocido pinta la página 404 (no «Mis bots»)", async () => {
    const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user"], twoFactorEnabled: false };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/auth/refresh")) return jsonRes(200, { accessToken: "t" });
        if (u.endsWith("/users/me")) return jsonRes(200, ME);
        if (u.endsWith("/catalog/versions")) return jsonRes(200, []);
        return jsonRes(200, { items: [] });
      }),
    );
    window.location.hash = "#/esto-no-existe";
    render(<App />);
    const nf = await screen.findByTestId("not-found");
    expect(nf.textContent).toContain("#/esto-no-existe");
  });
});

/** Juego falso con el MISMO orden de eventos que Phaser 4.2.1 (READY → bootQueue → CREATE). */
class FakeEmitter {
  private h = new Map<string, Set<(...a: unknown[]) => void>>();
  once(ev: string, fn: (...a: unknown[]) => void) {
    const wrap = (...a: unknown[]) => {
      this.off(ev, wrap);
      fn(...a);
    };
    if (!this.h.has(ev)) this.h.set(ev, new Set());
    this.h.get(ev)!.add(wrap);
  }
  off(ev: string, fn: (...a: unknown[]) => void) {
    this.h.get(ev)?.delete(fn);
  }
  emit(ev: string) {
    for (const f of [...(this.h.get(ev) ?? [])]) f();
  }
}
const K = { gameReadyEvent: "ready", gameDestroyEvent: "destroy", sceneCreateEvent: "create", runningStatus: 5 };
function fakeGame() {
  const scene = { sys: { settings: { status: 0 } }, events: new FakeEmitter() };
  let registered = false;
  const game = {
    isRunning: false,
    events: new FakeEmitter(),
    scene: { getScene: (_k: string) => (registered ? scene : null) },
  };
  return {
    game,
    scene,
    ready() {
      registered = true; // bootQueue registra la escena en READY
      game.events.emit("ready");
      game.isRunning = true;
    },
    create() {
      scene.sys.settings.status = 5;
      scene.events.emit("create");
    },
  };
}

describe("FC-D · espera de la escena de Phaser (TD-009)", () => {
  it("antes de READY getScene es null y la espera NO resuelve; resuelve tras READY + CREATE", async () => {
    const f = fakeGame();
    let got: unknown = null;
    const p = waitForScene(f.game, "viewer", K, 1000).then((s) => (got = s));
    expect(f.game.scene.getScene("viewer")).toBeNull(); // el bug original
    await Promise.resolve();
    expect(got).toBeNull();
    f.ready();
    await Promise.resolve();
    expect(got).toBeNull(); // existe pero aún sin create()
    f.create();
    await p;
    expect(got).toBe(f.scene);
  });

  it("si el juego ya está en marcha y la escena creada, resuelve sin esperar eventos", async () => {
    const f = fakeGame();
    f.ready();
    f.create();
    await expect(waitForScene(f.game, "viewer", K, 1000)).resolves.toBe(f.scene);
  });

  it("si Phaser nunca arranca, rechaza con SceneNotReadyError (no «cargando…» eterno)", async () => {
    const f = fakeGame();
    await expect(waitForScene(f.game, "viewer", K, 20)).rejects.toBeInstanceOf(SceneNotReadyError);
  });
});

describe("FC-D · SpectatorClient: rechazos terminales y wsUrl (D4)", () => {
  it("códigos terminales: 4400/4401/4403/4404 sí; 4429 y 1006 no", () => {
    for (const c of [4400, 4401, 4403, 4404]) expect(isTerminalCloseCode(c)).toBe(true);
    for (const c of [4429, 1000, 1006]) expect(isTerminalCloseCode(c)).toBe(false);
  });

  it("wsUrl relativo se ancla al origen con wss bajo https (nunca ws: bajo TLS)", () => {
    expect(resolveWsUrl("/ws/spectate/b1", { protocol: "https:", host: "arena.example.internal" })).toBe(
      "wss://arena.example.internal/ws/spectate/b1",
    );
    expect(resolveWsUrl("/ws/spectate/b1", { protocol: "http:", host: "192.0.2.10:8080" })).toBe(
      "ws://192.0.2.10:8080/ws/spectate/b1",
    );
    expect(resolveWsUrl("wss://x.example.internal/s", { protocol: "http:", host: "h" })).toBe(
      "wss://x.example.internal/s",
    );
  });

  it("un cierre 4404 tras abrir emite `rejected` UNA vez y no reconecta (no pide más tickets)", async () => {
    let tickets = 0;
    class WS {
      onopen: (() => void) | null = null;
      onclose: ((ev: { code: number; reason: string }) => void) | null = null;
      onmessage = null;
      onerror = null;
      constructor() {
        setTimeout(() => {
          this.onopen?.();
          setTimeout(() => this.onclose?.({ code: 4404, reason: "battle_not_live" }), 1);
        }, 1);
      }
      close() {}
    }
    const client = new SpectatorClient({
      getTicket: async () => {
        tickets++;
        return { ticket: "t", wsUrl: "ws://h/x", expiresAt: "" };
      },
      WebSocketImpl: WS as unknown as typeof WebSocket,
      reconnectDelayMs: 1,
      maxReconnectAttempts: 5,
    } as never);
    const rejected: any[] = [];
    client.on("rejected", (r) => rejected.push(r));
    await client.connect();
    await new Promise((r) => setTimeout(r, 60));
    expect(rejected).toHaveLength(1);
    expect(rejected[0].code).toBe(4404);
    expect(tickets).toBe(1);
  });

  it("un 404 al pedir el ticket es terminal (no 30 reintentos)", async () => {
    let tickets = 0;
    const client = new SpectatorClient({
      getTicket: async () => {
        tickets++;
        throw new ApiRequestError(404, { message: "not found" });
      },
      reconnectDelayMs: 1,
    } as never);
    const rejected: any[] = [];
    client.on("rejected", (r) => rejected.push(r));
    await client.connect();
    await new Promise((r) => setTimeout(r, 30));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ kind: "ticket", status: 404 });
    expect(tickets).toBe(1);
  });
});

describe("FC-D · resumen de resultado (D7)", () => {
  it("ganador, marcador, duración; failureKind none NO es fallo", () => {
    const v = summarizeBattle({
      id: "b",
      status: "finished",
      failureKind: "none",
      result: { winner: "red", ticks: 900, score: { red: 2, blue: 1 }, disqualified: [] },
    });
    expect(v).toMatchObject({
      outcome: "gana red",
      duration: "0:30",
      score: "red: 2 · blue: 1",
      failure: null,
      hasReplay: true,
    });
  });
  it("contrato battle-result/v1 de B: endReason, agents y replayAvailable", () => {
    const v = summarizeBattle({
      id: "b",
      status: "finished",
      replayAvailable: false,
      result: {
        schema: "battle-result/v1",
        winner: "blue",
        ticks: 60,
        score: {},
        disqualified: ["x"],
        endReason: "walkover",
        agents: "in_process_stub",
      },
    });
    expect(v).toMatchObject({
      outcome: "gana blue",
      endReason: "por incomparecencia",
      agentsNote: "bots simulados (stub)",
      hasReplay: false,
      disqualified: ["x"],
    });
    expect(
      summarizeBattle({
        id: "b",
        status: "finished",
        result: { winner: "red", endReason: "completed", agents: "container" },
      }),
    ).toMatchObject({
      endReason: null,
      agentsNote: null,
    });
  });
  it("empate, fallo real y sin replay", () => {
    expect(summarizeBattle({ id: "b", status: "finished", result: { winner: "draw" }, replayRef: null })).toMatchObject(
      {
        outcome: "empate",
        hasReplay: false,
      },
    );
    expect(summarizeBattle({ id: "b", status: "failed", failureKind: "bot_crash" }).failure).toBe("un bot se cayó");
  });
});

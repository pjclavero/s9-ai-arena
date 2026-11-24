// @vitest-environment jsdom
/**
 * V1 · TI-01 (D-OP-43) · listado y ficha de torneos PÚBLICOS en la web, en sólo lectura, para
 * cualquier visitante y para TODO torneo (abierto o por invitación): sin formulario de alta ni de
 * inscripción, sin acciones de gestión y sin pedir datos propios. El resto de pantallas del panel
 * siguen pidiendo sesión. App real (api.ts real) con `fetch` simulado.
 * Etiquetas `TIP_*`: las usa scripts/v1-tournament-invitation-mutants.py.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { setToken, onSessionExpired } from "../src/api.js";
import { App } from "../src/App.js";

const OPEN_ID = "1a1a1a1a-1111-4111-8111-111111111111";
const INV_ID = "2b2b2b2b-2222-4222-8222-222222222222";
const T = {
  [OPEN_ID]: { id: OPEN_ID, name: "Copa Abierta", enrollment: "open" },
  [INV_ID]: { id: INV_ID, name: "Copa Invitación", enrollment: "invitation" },
};
const base = { format: "round_robin", mode: "deathmatch", state: "open", entryCount: 2, viewerCanManage: false };

function jsonRes(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === "content-type" && body !== undefined ? "application/json" : null),
    },
    json: async () => body,
  };
}

let requests: { method: string; url: string; auth?: string }[];
beforeEach(() => {
  setToken(null);
  onSessionExpired(null);
  window.sessionStorage.clear();
  window.localStorage.clear(); // sin marca de sesión: visitante anónimo
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const u = String(url);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      requests.push({ method, url: u, auth });
      const path = u.replace(/^.*?\/api\/v1/, "");
      if (method === "POST" && path === "/auth/refresh") return jsonRes(401, {});
      if (method === "GET" && path === "/tournaments")
        return jsonRes(200, { items: Object.values(T).map((t) => ({ ...base, ...t })) });
      for (const id of [OPEN_ID, INV_ID]) {
        if (method === "GET" && path === `/tournaments/${id}`) return jsonRes(200, { ...base, ...T[id] });
        if (method === "GET" && path === `/tournaments/${id}/battles`)
          return jsonRes(200, {
            items: [
              {
                id: `bat-${id}`,
                status: "finished",
                round: 1,
                mode: "deathmatch",
                participants: [{ botName: "Público", version: 1 }],
              },
            ],
          });
      }
      throw new Error(`inesperado: ${method} ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const go = (hash: string) => window.history.replaceState(null, "", hash);
/** Ninguna petición de datos propios ni con credenciales. */
function assertAnonymousReadsOnly() {
  for (const r of requests) {
    expect(r.auth, `${r.method} ${r.url} con credenciales`).toBeUndefined();
    expect(r.url).not.toMatch(/\/bots\?ownerId=|\/invitation|\/teams/);
    if (!r.url.endsWith("/auth/refresh")) expect(r.method, r.url).toBe("GET");
  }
}

describe("V1 · TI-01 · torneos públicos en la web", () => {
  it("TIP_LIST_ANON un anónimo ve el listado con los torneos abiertos y por invitación, sin formulario de alta", async () => {
    go("#/tournaments");
    render(<App />);
    expect(await screen.findByText("Copa Abierta")).toBeTruthy();
    expect(screen.getByText("Copa Invitación")).toBeTruthy();
    expect(screen.getByText(/por invitación/)).toBeTruthy();
    expect(screen.queryByTestId("create-tournament")).toBeNull();
    expect(screen.queryByText("Crear torneo")).toBeNull();
    expect(screen.queryByTestId("login-required")).toBeNull();
    expect(screen.getByTestId("public-tournament-login-hint")).toBeTruthy();
    expect(screen.getByTestId("nav-tournaments").getAttribute("href")).toBe("#/tournaments");
    assertAnonymousReadsOnly();
  });

  it("TIP_DETAIL_OPEN_ANON un anónimo ve la ficha de un torneo ABIERTO sin inscribirse ni gestionar", async () => {
    go(`#/tournaments/${OPEN_ID}`);
    render(<App />);
    expect(await screen.findByText("Copa Abierta")).toBeTruthy();
    await screen.findByTestId("finished-battles"); // resultados públicos
    expect(screen.queryByRole("button", { name: "Inscribir" })).toBeNull();
    expect(screen.queryByTestId("entry-form")).toBeNull();
    expect(screen.queryByTestId("team-entry-form")).toBeNull();
    expect(screen.queryByTestId("invitation-panel")).toBeNull();
    expect(screen.queryByTestId("close-entries")).toBeNull();
    expect(screen.queryByTestId("cancel-tournament")).toBeNull();
    expect(screen.queryByTestId("login-required")).toBeNull();
    assertAnonymousReadsOnly();
  });

  it("TIP_DETAIL_INVITATION_ANON un anónimo ve la ficha de un torneo POR INVITACIÓN sin la opción de inscribirse", async () => {
    go(`#/tournaments/${INV_ID}`);
    render(<App />);
    expect(await screen.findByText("Copa Invitación")).toBeTruthy();
    expect(screen.getByTestId("tournament-invitation-badge")).toBeTruthy();
    expect(screen.getByTestId("entry-invitation-only")).toBeTruthy();
    await screen.findByTestId("finished-battles");
    expect(screen.queryByRole("button", { name: "Inscribir" })).toBeNull();
    expect(screen.queryByTestId("entry-form")).toBeNull();
    expect(screen.queryByTestId("invitation-panel")).toBeNull();
    assertAnonymousReadsOnly();
  });

  it("TIP_INVITE_ANON con enlace y sin sesión: la ficha y el aviso «inicia sesión o regístrate para inscribirte»", async () => {
    go(`#/tournaments/${INV_ID}/invitation/${"Q".repeat(43)}`);
    render(<App />);
    expect(await screen.findByText("Copa Invitación")).toBeTruthy();
    expect(screen.getByTestId("invitation-login-notice").textContent).toMatch(
      /inicia sesión o regístrate para inscribirte/,
    );
    expect(screen.queryByRole("button", { name: "Inscribir" })).toBeNull();
    await waitFor(() => expect(requests.some((r) => r.url.endsWith(`/tournaments/${INV_ID}/battles`))).toBe(true));
    assertAnonymousReadsOnly(); // sin sesión no se comprueba la invitación
  });

  it("TIP_OTHER_PANEL el resto de pantallas del panel sigue pidiendo sesión", async () => {
    go("#/bots");
    render(<App />);
    expect(await screen.findByTestId("login-required")).toBeTruthy();
    expect(screen.queryByTestId("public-tournament-access")).toBeNull();
  });
});

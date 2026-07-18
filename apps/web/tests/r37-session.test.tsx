// @vitest-environment jsdom
/**
 * R3.7 (ERR-VIS-03) · DoD de la sesión del panel:
 *  - recargar (F5) mantiene la sesión: bootstrapSession() la recupera desde la
 *    cookie httpOnly vía POST /auth/refresh (nada en localStorage);
 *  - interceptor ÚNICO de 401 en api.ts: refresh + reintento transparente;
 *  - si el refresh falla, la sesión se limpia y se vuelve al login con un
 *    mensaje anunciado (role="alert") — sin romper la pantalla en uso;
 *  - logout revoca en servidor y limpia el estado local.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

afterEach(cleanup);

import { api, setToken, onSessionExpired } from "../src/api.js";
import { App } from "../src/App.js";

const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user"], twoFactorEnabled: false };

/** Respuesta mínima compatible con lo que api.ts consume (ok/status/headers/json). */
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

type Handler = (method: string, url: string, init: RequestInit) => ReturnType<typeof jsonRes>;
let fetchSpy: ReturnType<typeof vi.fn>;
function installFetch(handler: Handler) {
  fetchSpy = vi.fn(async (url: string, init?: RequestInit) =>
    handler((init?.method ?? "GET").toUpperCase(), String(url), init ?? {}),
  );
  vi.stubGlobal("fetch", fetchSpy);
}

beforeEach(() => {
  setToken(null);
  onSessionExpired(null);
  window.location.hash = "";
});

describe("R3.7 interceptor único de 401 (api.ts)", () => {
  it("un 401 dispara UN refresh (cookie) y reintenta la petición con el token nuevo", async () => {
    setToken("caducado");
    let refreshed = false;
    installFetch((method, url, init) => {
      if (url.endsWith("/auth/refresh")) {
        refreshed = true;
        // La cookie httpOnly viaja sola: el cliente debe pedirlo con credentials.
        expect(init.credentials).toBe("include");
        return jsonRes(200, { accessToken: "nuevo" });
      }
      if (url.endsWith("/bots")) {
        const auth = (init.headers as Record<string, string>).Authorization;
        return auth === "Bearer nuevo" ? jsonRes(200, { items: ["ok"] }) : jsonRes(401, { message: "expirado" });
      }
      throw new Error(`inesperado: ${method} ${url}`);
    });

    const out = await api<{ items: string[] }>("GET", "/bots");
    expect(refreshed).toBe(true);
    expect(out.items).toEqual(["ok"]);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // original + refresh + reintento
  });

  it("N peticiones simultáneas con 401 ⇒ UN solo refresh (single-flight)", async () => {
    setToken("caducado");
    let refreshes = 0;
    installFetch((_m, url, init) => {
      if (url.endsWith("/auth/refresh")) {
        refreshes += 1;
        return jsonRes(200, { accessToken: "nuevo" });
      }
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === "Bearer nuevo" ? jsonRes(200, { ok: true }) : jsonRes(401, {});
    });
    await Promise.all([api("GET", "/bots"), api("GET", "/tournaments"), api("GET", "/battles")]);
    expect(refreshes).toBe(1);
  });

  it("si el refresh falla, se limpia la sesión y se avisa con el motivo", async () => {
    setToken("caducado");
    const expired = vi.fn();
    onSessionExpired(expired);
    installFetch((_m, url) =>
      url.endsWith("/auth/refresh") ? jsonRes(401, {}) : jsonRes(401, { message: "expirado" }),
    );
    await expect(api("GET", "/bots")).rejects.toThrow();
    expect(expired).toHaveBeenCalledWith(expect.stringContaining("sesión ha caducado"));
  });
});

describe("R3.7 la sesión sobrevive al F5 y muere con dignidad", () => {
  function loggedInRoutes(overrides: Partial<Record<string, () => ReturnType<typeof jsonRes>>> = {}): Handler {
    return (method, url) => {
      const path = url.replace(/^.*\/api\/v1/, "");
      const key = `${method} ${path}`;
      for (const [k, fn] of Object.entries(overrides)) if (key.startsWith(k)) return fn!();
      if (key === "POST /auth/refresh") return jsonRes(200, { accessToken: "tok" });
      if (key === "POST /auth/logout") return jsonRes(204);
      if (key === "GET /users/me") return jsonRes(200, ME);
      if (key === "GET /catalog/versions") return jsonRes(200, []);
      if (key.startsWith("GET /bots?ownerId=")) return jsonRes(200, { items: [] });
      if (key.startsWith("GET /battles")) return jsonRes(200, { items: [] });
      throw new Error(`inesperado: ${key}`);
    };
  }

  it("F5: el arranque recupera la sesión desde la cookie y entra directo al panel", async () => {
    installFetch(loggedInRoutes());
    render(<App />);
    expect(screen.getByRole("status").textContent).toContain("Recuperando sesión");
    await screen.findByText(/Ana/);
    // El panel completo, con las rutas nuevas de R3.7 enlazadas.
    expect(screen.getByText("Torneos").getAttribute("href")).toBe("#/tournaments");
    expect(screen.getByText("Batallas").getAttribute("href")).toBe("#/battles");
    expect(screen.getByTestId("logout")).toBeTruthy();
  });

  it("sin cookie válida el arranque cae al login sin romper nada", async () => {
    installFetch((_m, url) => (url.endsWith("/auth/refresh") ? jsonRes(401, {}) : jsonRes(401, {})));
    render(<App />);
    await screen.findByText("Iniciar sesión");
    expect(screen.queryByTestId("session-notice")).toBeNull(); // sin mensaje alarmista
  });

  it("una sesión que caduca EN USO vuelve al login con mensaje accesible (role=alert)", async () => {
    let sessionAlive = true;
    installFetch(
      loggedInRoutes({
        "POST /auth/refresh": () => (sessionAlive ? jsonRes(200, { accessToken: "tok" }) : jsonRes(401, {})),
        "GET /battles": () => jsonRes(401, { message: "expirado" }),
      }),
    );
    render(<App />);
    await screen.findByText(/Ana/);

    // El servidor revoca la sesión y el usuario navega a Batallas: 401 + refresh fallido.
    sessionAlive = false;
    await act(async () => {
      window.location.hash = "#/battles";
      fireEvent(window, new Event("hashchange"));
    });

    const notice = await screen.findByTestId("session-notice");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("sesión ha caducado");
    await screen.findByText("Iniciar sesión"); // la pantalla no se rompió: se redirigió
  });

  it("logout revoca en servidor (cookie) y deja el panel en el login", async () => {
    installFetch(loggedInRoutes());
    render(<App />);
    await screen.findByText(/Ana/);
    fireEvent.click(screen.getByTestId("logout"));
    await screen.findByText("Iniciar sesión");
    const logoutCall = fetchSpy.mock.calls.find(([u]) => String(u).endsWith("/auth/logout"));
    expect(logoutCall).toBeTruthy();
    expect((logoutCall![1] as RequestInit).credentials).toBe("include");
    expect(screen.getByTestId("session-notice").textContent).toContain("Sesión cerrada");
  });
});

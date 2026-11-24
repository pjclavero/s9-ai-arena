// @vitest-environment jsdom
/**
 * V1 · TORNEOS POR INVITACIÓN (D-OP-43) · recorrido completo en la App real (api.ts real, fetch
 * simulado): abrir el enlace SIN sesión → acceso (login o registro) → vuelta a la ficha con el
 * formulario → el invitado elige su bot y confirma. Comprueba además que el token NUNCA viaja en
 * una URL (sólo en el cuerpo de POST) y que el enlace no inscribe solo.
 * Etiquetas `TIW_LOGIN_*`: las usa scripts/v1-tournament-invitation-mutants.py.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken, onSessionExpired } from "../src/api.js";
import { App } from "../src/App.js";

const TID = "0b0e8c7e-6a8e-4f7e-9d61-3a1c2b3d4e5f";
const TOKEN = "Inv_".padEnd(43, "z");
const ME = { id: "u9", displayName: "Invitada", email: "inv@a.es", roles: ["user"], twoFactorEnabled: false };
const OK = { eligible: true, category: "VALID" };

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

let requests: { method: string; url: string; body?: unknown }[];

function installFetch() {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const u = String(url);
      requests.push({ method, url: u, body });
      const path = u.replace(/^.*?\/api\/v1/, "").replace(/^https?:\/\/[^/]+/, "");
      const key = `${method} ${path}`;
      if (key === "POST /auth/refresh") return jsonRes(401, {});
      if (key === "POST /auth/register") return jsonRes(201, { id: ME.id });
      if (key === "POST /auth/login") return jsonRes(200, { accessToken: "tok" });
      if (key === "GET /users/me") return jsonRes(200, ME);
      if (key === "GET /catalog/versions") return jsonRes(200, []);
      if (key === `GET /tournaments/${TID}`)
        return jsonRes(200, {
          id: TID,
          name: "Copa por invitación",
          format: "round_robin",
          mode: "deathmatch",
          state: "open",
          enrollment: "invitation",
          entryCount: 0,
        });
      if (key === `GET /tournaments/${TID}/battles`) return jsonRes(200, { items: [] });
      if (key.startsWith("GET /bots?ownerId="))
        return jsonRes(200, { items: [{ id: "b9", name: "Centella", latestPublishedVersion: 1 }] });
      if (key === "GET /bots/b9/versions")
        return jsonRes(200, [{ version: 1, state: "published", battleEligibility: OK }]);
      if (key === `POST /tournaments/${TID}/invitation/check`)
        return jsonRes(200, { enrollment: "invitation", valid: body?.invitationToken === TOKEN, entriesOpen: true });
      if (key === `POST /tournaments/${TID}/entries`) return jsonRes(201, { id: "e9", botId: "b9", version: 1 });
      throw new Error(`inesperado: ${key}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  setToken(null);
  onSessionExpired(null);
  window.sessionStorage.clear();
  window.localStorage.clear(); // sin marca de sesión: el arranque es anónimo
  // Como al ABRIR el enlace en una pestaña nueva: la dirección ya trae el fragmento y NO llega ningún
  // `hashchange` (asignar `location.hash` lo dispararía después del render y la App capturaría el
  // token por esa vía, ocultando que falte la captura inicial: mutante W14).
  window.history.replaceState(null, "", `#/tournaments/${TID}/invitation/${TOKEN}`);
  installFetch();
});

async function enterBotAndConfirm(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole("button", { name: "Inscribir" });
  expect(requests.filter((r) => r.method === "POST" && r.url.endsWith("/entries"))).toHaveLength(0);
  await user.selectOptions(screen.getByLabelText("bot a inscribir"), "b9");
  await screen.findByLabelText("versión a inscribir");
  await user.click(button);
  await waitFor(() =>
    expect(requests.filter((r) => r.method === "POST" && r.url.endsWith("/entries"))).toHaveLength(1),
  );
  const entry = requests.find((r) => r.method === "POST" && r.url.endsWith("/entries"))!;
  expect(entry.body).toEqual({ botId: "b9", version: 1, invitationToken: TOKEN });
  // El token sólo viajó en cuerpos de POST: ninguna URL lo lleva.
  for (const r of requests) expect(r.url, `${r.method} ${r.url}`).not.toContain(TOKEN);
}

describe("V1 · invitación: acceso y vuelta al formulario", () => {
  it("TIW_LOGIN_RETURN sin sesión: aviso, login y vuelta a la ficha con el formulario", async () => {
    render(<App />);
    const user = userEvent.setup();
    expect(await screen.findByTestId("invitation-login-notice")).toBeTruthy();
    expect(window.location.hash).toBe(`#/tournaments/${TID}`); // el token ya no está en la barra
    expect(window.location.href).not.toContain(TOKEN);
    await user.type(screen.getByLabelText("email"), ME.email);
    await user.type(screen.getByLabelText("contraseña"), "una-contraseña-larga");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    await screen.findByText("Copa por invitación");
    await enterBotAndConfirm(user);
  });

  it("TIW_LOGIN_REGISTER sin cuenta: registro y vuelta a la ficha con el formulario", async () => {
    render(<App />);
    const user = userEvent.setup();
    await screen.findByTestId("invitation-login-notice");
    await user.click(screen.getByRole("button", { name: "Crear cuenta" }));
    await user.type(screen.getByLabelText("nombre"), ME.displayName);
    await user.type(screen.getByLabelText("email"), ME.email);
    await user.type(screen.getByLabelText("contraseña"), "una-contraseña-larga");
    await user.click(screen.getByRole("button", { name: "Registrarse y entrar" }));
    await screen.findByText("Copa por invitación");
    expect(requests.some((r) => r.method === "POST" && r.url.endsWith("/auth/register"))).toBe(true);
    await enterBotAndConfirm(user);
  });
});

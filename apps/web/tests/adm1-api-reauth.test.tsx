// @vitest-environment jsdom
/**
 * ADM-1 · `api(..., { reauth: true })`: un 401 de credenciales NO es una sesión caducada, así que no
 * se refresca ni se reintenta (reintentar duplicaría el intento fallido de contraseña).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, setToken, onSessionExpired } from "../src/api.js";

function res(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === "content-type" && body !== undefined ? "application/json" : null),
    },
    json: async () => body,
  };
}

let calls: string[];
beforeEach(() => {
  setToken("tok");
  onSessionExpired(null);
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${String(url)}`);
      if (String(url).endsWith("/auth/refresh")) {
        return res(200, { accessToken: "nuevo", refreshToken: "r", expiresIn: 900 });
      }
      return res(401, { error: "unauthorized", message: "Reautenticación requerida: contraseña inválida" });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("ADM-1 · api() con reauth", () => {
  it("REAUTH_SIN_REFRESH: un 401 con {reauth:true} se lanza tal cual, con UNA sola petición y sin tocar /auth/refresh", async () => {
    await expect(
      api("POST", "/admin/operations/x/confirm", { password: "mala" }, { reauth: true }),
    ).rejects.toBeTruthy();
    expect(calls).toEqual(["POST /api/v1/admin/operations/x/confirm"]);
  });

  it("SIN_REAUTH_SIGUE_REFRESCANDO: un 401 normal sí intenta refrescar y reintenta (comportamiento previo intacto)", async () => {
    await expect(api("GET", "/admin/settings")).rejects.toBeTruthy();
    expect(calls.filter((c) => c.includes("/auth/refresh")).length).toBe(1);
    expect(calls.filter((c) => c.endsWith("/admin/settings")).length).toBe(2);
  });
});

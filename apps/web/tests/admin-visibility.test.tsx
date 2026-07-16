// @vitest-environment jsdom
/**
 * T7.4 · DoD: el panel de administración es inaccesible e invisible para roles
 * menores. La interfaz solo OCULTA; la autorización real (403) la prueba la
 * matriz rol×endpoint de apps/api (rbac-matrix.test.ts).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { AdminPage, isAdmin } from "../src/pages/AdminPage.js";
import type { Me } from "../src/api.js";

const asUser: Me = { id: "u1", displayName: "User", email: "u@x", roles: ["user", "developer"], twoFactorEnabled: false };
const asAdmin: Me = { id: "a1", displayName: "Admin", email: "a@x", roles: ["admin"], twoFactorEnabled: false };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("T7.4 visibilidad del panel de administración", () => {
  it("isAdmin refleja el rol (lo usa la navegación para OCULTAR el enlace)", () => {
    expect(isAdmin(asUser)).toBe(false);
    expect(isAdmin(asAdmin)).toBe(true);
    expect(isAdmin(null)).toBe(false);
  });

  it("para un rol menor el panel ni se monta ni dispara peticiones admin", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<AdminPage me={asUser} />);
    expect(screen.getByTestId("admin-denied")).toBeTruthy();
    expect(screen.queryByTestId("admin-panel")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("para un admin el panel se monta y consulta hallazgos y auditoría", async () => {
    const fetchSpy = vi.fn(async (url: string) => ({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () =>
        String(url).includes("security-findings")
          ? [{ id: "f1", kind: "secret_in_source", severity: "high", detail: "token AWS", detectedAt: "2026-07-16T00:00:00Z" }]
          : [],
    }));
    vi.stubGlobal("fetch", fetchSpy);
    render(<AdminPage me={asAdmin} />);
    expect(screen.getByTestId("admin-panel")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(/secret_in_source/)).toBeTruthy();
    });
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/admin/security-findings"))).toBe(true);
    expect(urls.some((u) => u.includes("/admin/audit-log"))).toBe(true);
  });
});

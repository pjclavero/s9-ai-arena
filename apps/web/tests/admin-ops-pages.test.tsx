// @vitest-environment jsdom
/**
 * R8.6/R8.7/R8.9 · Pantallas admin de ops (solo lectura):
 *  - System muestra conteos, invariantes de runtime y avisa cuando el runner real
 *    no está disponible ("Battle execution unavailable in this environment");
 *  - Audit lista eventos y NUNCA se pinta vacía ante un fallo (role=alert + reintento);
 *  - Roles muestra la matriz endpoint→rol y filtra.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

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
import { SystemPage } from "../src/pages/SystemPage.js";
import { AuditPage } from "../src/pages/AuditPage.js";
import { RolesPage } from "../src/pages/RolesPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["admin"], twoFactorEnabled: false };

const STATUS = {
  env: "test",
  commit: "abc123",
  databaseOk: true,
  realRunnerEnabled: false,
  smokeDigestConfigured: false,
  battlesByStatus: { scheduled: 2, finished: 5 },
  buildsByStatus: { passed: 3 },
  botVersionsByState: { published: 4, draft: 1 },
  readyBots: 4,
  publishedMaps: 2,
  runtimePolicy: {
    privileged: false,
    dockerSocketMounted: false,
    seccompEnforced: true,
    digestRequired: true,
    signatureRequired: true,
    networkMode: "arena",
  },
};

afterEach(cleanup);
beforeEach(() => apiMock.mockReset());

describe("R8.6 SystemPage", () => {
  it("muestra conteos e invariantes, y avisa si el runner real no está disponible", async () => {
    apiMock.mockResolvedValue(STATUS);
    render(<SystemPage me={ME} />);
    expect(await screen.findByTestId("execution-unavailable")).toBeTruthy();
    expect(screen.getByText("abc123")).toBeTruthy();
    expect(screen.getByText("scheduled: 2")).toBeTruthy();
    // readyBots
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
  });

  it("un fallo de carga se anuncia con role=alert y reintento", async () => {
    apiMock.mockRejectedValueOnce(new Error("api caída")).mockResolvedValueOnce(STATUS);
    render(<SystemPage me={ME} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No se pudo cargar el estado del sistema");
    fireEvent.click(within(alert).getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByText("abc123")).toBeTruthy();
  });
});

describe("R8.7 AuditPage", () => {
  it("lista eventos de auditoría", async () => {
    apiMock.mockResolvedValue([
      { id: "1", action: "map.published", target: "map:arena-01@1", at: "2026-07-18T10:00:00.000Z" },
    ]);
    render(<AuditPage me={ME} />);
    expect(await screen.findByText("map.published")).toBeTruthy();
    expect(screen.getByText("map:arena-01@1")).toBeTruthy();
  });

  it("un fallo NUNCA se pinta como lista vacía (role=alert + reintento)", async () => {
    apiMock.mockRejectedValueOnce(new Error("gateway")).mockResolvedValueOnce([]);
    render(<AuditPage me={ME} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No se pudo cargar la auditoría");
    expect(screen.queryByText("No hay eventos de auditoría todavía.")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Reintentar" }));
    await screen.findByText("No hay eventos de auditoría todavía.");
  });
});

describe("R8.9 RolesPage", () => {
  const MATRIX = {
    roles: [
      { name: "visitor", rank: 0 },
      { name: "admin", rank: 6 },
    ],
    endpoints: [
      { operationId: "listBots", method: "GET", path: "/bots", minRole: "visitor" },
      { operationId: "getSystemStatus", method: "GET", path: "/system/status", minRole: "admin" },
    ],
  };

  it("muestra roles y la matriz endpoint→rol, y filtra", async () => {
    apiMock.mockResolvedValue(MATRIX);
    render(<RolesPage me={ME} />);
    expect(await screen.findByText("/system/status")).toBeTruthy();
    expect(screen.getByText("/bots")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("filtrar-endpoints"), { target: { value: "system" } });
    expect(screen.getByText("/system/status")).toBeTruthy();
    expect(screen.queryByText("/bots")).toBeNull();
  });
});

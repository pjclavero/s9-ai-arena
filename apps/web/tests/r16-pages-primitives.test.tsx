// @vitest-environment jsdom
/**
 * R16 · Adopción de primitivas de UI en las 4 páginas de alcance:
 * AuditPage, MapsPage, TeamsPage, RankingPage.
 *
 * Cada suite verifica que la primitiva sustituta produce el mismo rol ARIA,
 * el mismo texto visible y el mismo comportamiento que la implementación
 * divergente anterior (audit §2). No hay tests que solo lean código fuente.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";

vi.mock("../src/api.js", () => ({
  api: vi.fn(),
  setToken: vi.fn(),
  getToken: vi.fn(() => "tok"),
  onSessionExpired: vi.fn(),
  bootstrapSession: vi.fn(),
  logout: vi.fn(),
  ApiRequestError: class extends Error {
    status: number;
    body: Record<string, unknown>;
    constructor(status: number, body: Record<string, unknown>) {
      super(String(body?.message ?? `HTTP ${status}`));
      this.status = status;
      this.body = body;
    }
  },
}));

import { api } from "../src/api.js";
import { AuditPage } from "../src/pages/AuditPage.js";
import { MapsPage } from "../src/pages/MapsPage.js";
import { TeamsPage } from "../src/pages/TeamsPage.js";
import { RankingPage } from "../src/pages/RankingPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["admin", "organizer"], twoFactorEnabled: false };

afterEach(cleanup);
beforeEach(() => apiMock.mockReset());

// ─── AuditPage ───────────────────────────────────────────────────────────────

describe("R16 AuditPage — primitivas", () => {
  it("LoadingState: role=status + aria-live=polite mientras carga (promesa pendiente)", async () => {
    // Promesa controlada: se resuelve al final para que cleanup no quede bloqueado
    let resolveLoad!: (v: unknown[]) => void;
    const deferred = new Promise<unknown[]>((r) => {
      resolveLoad = r;
    });
    apiMock.mockReturnValue(deferred);
    render(<AuditPage me={ME} />);
    const loading = screen.getByRole("status");
    expect(loading).toBeTruthy();
    expect(loading.getAttribute("aria-live")).toBe("polite");
    resolveLoad([]);
  });

  it("EmptyState: mensaje visible cuando la lista está vacía", async () => {
    apiMock.mockResolvedValue([]);
    render(<AuditPage me={ME} />);
    expect(await screen.findByText("No hay eventos de auditoría todavía.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ErrorState: role=alert con texto de error y botón Reintentar funcional", async () => {
    apiMock
      .mockRejectedValueOnce(new Error("gateway caído"))
      .mockResolvedValueOnce([{ id: "1", action: "map.published", target: "map:a@1", at: "2026-07-18T10:00:00.000Z" }]);
    render(<AuditPage me={ME} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No se pudo cargar la auditoría");
    expect(alert.textContent).toContain("gateway caído");
    // Reintentar recupera datos
    fireEvent.click(within(alert).getByRole("button", { name: "Reintentar" }));
    await screen.findByText("map.published");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Panel: el contenedor raíz tiene la clase .card (visual correcto)", async () => {
    apiMock.mockResolvedValue([]);
    render(<AuditPage me={ME} />);
    await screen.findByText("Auditoría");
    const card = document.querySelector(".card");
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain("Auditoría");
  });
});

// ─── MapsPage ────────────────────────────────────────────────────────────────

describe("R16 MapsPage — primitivas", () => {
  it("LoadingState: role=status + aria-live=polite en el panel de mapas mientras carga", async () => {
    let resolveLoad!: (v: { items: unknown[] }) => void;
    const deferred = new Promise<{ items: unknown[] }>((r) => {
      resolveLoad = r;
    });
    apiMock.mockReturnValue(deferred);
    render(<MapsPage me={ME} />);
    const loading = screen.getByRole("status");
    expect(loading).toBeTruthy();
    expect(loading.getAttribute("aria-live")).toBe("polite");
    resolveLoad({ items: [] });
  });

  it("EmptyState: mensaje visible cuando no hay mapas", async () => {
    apiMock.mockResolvedValue({ items: [] });
    render(<MapsPage me={ME} />);
    expect(await screen.findByText("No hay mapas todavía.")).toBeTruthy();
    // No debe aparecer tabla
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("ErrorState: role=alert con texto de error y botón Reintentar funcional", async () => {
    apiMock.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce({ items: [] });
    render(<MapsPage me={ME} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No se pudo cargar los mapas");
    expect(alert.textContent).toContain("timeout");
    fireEvent.click(within(alert).getByRole("button", { name: "Reintentar" }));
    await screen.findByText("No hay mapas todavía.");
  });

  it("StatusBadge: estado 'published' muestra span.ok con texto (no solo color)", async () => {
    apiMock.mockResolvedValue({
      items: [
        { mapId: "a01", version: 1, state: "published", supportedModes: ["deathmatch"] },
        { mapId: "a02", version: 1, state: "validated", supportedModes: ["deathmatch"] },
        { mapId: "a03", version: 1, state: "draft", supportedModes: [] },
      ],
    });
    render(<MapsPage me={ME} />);
    await screen.findByText("a01");

    // published → span con clase ok y texto "published"
    const publishedBadge = screen.getByText("published");
    expect(publishedBadge.tagName).toBe("SPAN");
    expect(publishedBadge.className).toBe("ok");

    // validated → span con clase warn
    const validatedBadge = screen.getByText("validated");
    expect(validatedBadge.tagName).toBe("SPAN");
    expect(validatedBadge.className).toBe("warn");

    // draft → span sin clase extra (variant neutral)
    const draftBadge = screen.getByText("draft");
    expect(draftBadge.tagName).toBe("SPAN");
    expect(draftBadge.className).toBe("");

    // "Disponible para batallas" sigue como StatusBadge.ok
    const disponible = screen.getByText("Disponible para batallas");
    expect(disponible.tagName).toBe("SPAN");
    expect(disponible.className).toBe("ok");
  });
});

// ─── TeamsPage ───────────────────────────────────────────────────────────────

describe("R16 TeamsPage — primitivas", () => {
  it("Panel: el contenedor tiene clase .card", async () => {
    apiMock.mockResolvedValue({ items: [] });
    render(<TeamsPage me={ME} />);
    await screen.findByText("Equipos");
    const card = document.querySelector(".card");
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain("Equipos");
  });

  it("Button: el botón 'Crear equipo' tiene type=button explícito", async () => {
    apiMock.mockResolvedValue({ items: [] });
    render(<TeamsPage me={ME} />);
    await screen.findByText("Equipos");
    const btn = screen.getByRole("button", { name: "Crear equipo" });
    expect(btn.getAttribute("type")).toBe("button");
  });

  it("Button: el botón 'Invitar' del capitán tiene type=button explícito", async () => {
    apiMock.mockResolvedValue({
      items: [{ id: "t1", name: "Equipo Alpha", captainId: "u1", memberIds: ["u1"] }],
    });
    render(<TeamsPage me={ME} />);
    await screen.findByText("Equipo Alpha");
    const btn = screen.getByRole("button", { name: "Invitar" });
    expect(btn.getAttribute("type")).toBe("button");
  });

  it("error inline se muestra con clase .error y texto visible", async () => {
    apiMock.mockResolvedValueOnce({ items: [] }).mockRejectedValueOnce(new Error("nombre ya en uso"));
    render(<TeamsPage me={ME} />);
    await screen.findByText("Equipos");
    // Escribir nombre y crear equipo que falla
    fireEvent.change(screen.getByLabelText("nuevo-equipo"), { target: { value: "Dup" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear equipo" }));
    const errP = await screen.findByText("nombre ya en uso");
    expect(errP.tagName).toBe("P");
    expect(errP.className).toBe("error");
  });
});

// ─── RankingPage ─────────────────────────────────────────────────────────────

describe("R16 RankingPage — primitivas", () => {
  it("EmptyState: data-testid=ranking-empty preservado, texto visible", async () => {
    apiMock.mockResolvedValue([]);
    render(<RankingPage />);
    const empty = await screen.findByTestId("ranking-empty");
    expect(empty).toBeTruthy();
    expect(empty.textContent).toContain("Todavía no hay clasificación para este modo.");
  });

  it("EmptyState no renderiza tabla cuando no hay datos", async () => {
    apiMock.mockResolvedValue([]);
    render(<RankingPage />);
    await screen.findByTestId("ranking-empty");
    expect(screen.queryByTestId("ranking-table")).toBeNull();
  });

  it("EmptyState: el texto es el canal de información, no solo color", async () => {
    apiMock.mockResolvedValue([]);
    render(<RankingPage />);
    const empty = await screen.findByTestId("ranking-empty");
    // El mensaje de texto debe estar presente sin necesidad de color
    const p = empty.querySelector("p");
    expect(p).toBeTruthy();
    expect(p!.textContent).toBe("Todavía no hay clasificación para este modo.");
  });

  it("con datos la tabla sigue renderizándose correctamente (sin regresión)", async () => {
    apiMock.mockResolvedValue([
      { rank: 1, botId: "b1", botName: "Vector", rating: 1500, wins: 5, losses: 1, draws: 0 },
    ]);
    render(<RankingPage />);
    await screen.findByTestId("ranking-table");
    expect(screen.queryByTestId("ranking-empty")).toBeNull();
    const rows = screen.getAllByTestId("ranking-row");
    expect(rows).toHaveLength(1);
    const cells = [...rows[0].querySelectorAll("td")].map((td) => td.textContent);
    expect(cells).toEqual(["1", "Vector", "1500", "5-1-0"]);
  });
});

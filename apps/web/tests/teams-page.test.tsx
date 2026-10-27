// @vitest-environment jsdom
/**
 * FC-C (TD-011) · TeamsPage: gestión completa desde la web (prueba de componente con
 * la API mockeada; el comportamiento real del servidor está en
 * apps/api/src/routes/fc-c-content.test.ts y en el E2E de navegador).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../src/api.js", () => ({ api: vi.fn() }));
import { api } from "../src/api.js";
import { TeamsPage } from "../src/pages/TeamsPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user"], twoFactorEnabled: false } as never;

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

const TEAM = {
  id: "t1",
  name: "Rojos",
  memberCount: 2,
  botCount: 1,
  isCaptain: true,
  isMember: true,
  members: [
    { userId: "u1", displayName: "Ana", role: "captain" },
    { userId: "u2", displayName: "Beto", role: "member" },
  ],
  bots: [{ id: "b1", name: "tanque", mine: true }],
};

function mock(extra?: (m: string, p: string, b?: unknown) => unknown) {
  apiMock.mockImplementation((m: string, p: string, b?: unknown) => {
    const r = extra?.(m, p, b);
    if (r !== undefined) return Promise.resolve(r);
    if (m === "GET" && p.startsWith("/teams"))
      return Promise.resolve({ items: [TEAM, { id: "t2", name: "Ajeno", memberCount: 3, botCount: 0 }] });
    if (m === "GET" && p.startsWith("/bots")) return Promise.resolve({ items: [{ id: "b9", name: "explorador" }] });
    return Promise.resolve({});
  });
}

describe("TeamsPage FC-C", () => {
  it("un fallo de carga NO se traga: alerta con reintento", async () => {
    apiMock.mockImplementation(() => Promise.reject(new Error("API caída")));
    render(<TeamsPage me={ME} />);
    const alert = await screen.findByTestId("teams-load-error");
    expect(alert.textContent).toContain("API caída");
  });

  it("muestra miembros y bots de mi equipo; los ajenos solo con recuentos", async () => {
    mock();
    render(<TeamsPage me={ME} />);
    await screen.findByText("Beto");
    expect(screen.getByText("tanque")).toBeTruthy();
    expect(screen.getByText(/3 miembros · 0 bots/)).toBeTruthy();
  });

  it("añadir miembro por email, quitar miembro, añadir y quitar bot, renombrar y borrar llaman a la API", async () => {
    mock();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<TeamsPage me={ME} />);
    await screen.findByText("Beto");
    fireEvent.change(screen.getByLabelText("invitar-Rojos"), { target: { value: "c@x.es" } });
    fireEvent.click(screen.getByRole("button", { name: "Añadir miembro" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("POST", "/teams/t1/members", { email: "c@x.es" }));
    fireEvent.click(screen.getByRole("button", { name: "quitar-miembro-Beto" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("DELETE", "/teams/t1/members/u2"));
    fireEvent.change(screen.getByLabelText("añadir-bot-Rojos"), { target: { value: "b9" } });
    fireEvent.click(screen.getByRole("button", { name: "Añadir bot" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("POST", "/teams/t1/bots", { botId: "b9" }));
    fireEvent.click(screen.getByRole("button", { name: "quitar-bot-tanque" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("DELETE", "/teams/t1/bots/b1"));
    fireEvent.change(screen.getByLabelText("renombrar-Rojos"), { target: { value: "Rojos 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Renombrar" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("PATCH", "/teams/t1", { name: "Rojos 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Borrar equipo" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("DELETE", "/teams/t1"));
  });

  it("un 403 del servidor se anuncia", async () => {
    apiMock.mockImplementation((m: string, p: string) => {
      if (m === "PATCH") return Promise.reject(new Error("Solo el capitán del equipo puede hacer esto"));
      if (p.startsWith("/teams")) return Promise.resolve({ items: [TEAM] });
      return Promise.resolve({ items: [] });
    });
    render(<TeamsPage me={ME} />);
    await screen.findByText("Beto");
    fireEvent.click(screen.getByRole("button", { name: "Renombrar" }));
    expect((await screen.findByTestId("teams-error")).textContent).toMatch(/capitán/);
  });
});

describe("UX-C · C1 conceptos de equipo", () => {
  it("explica que un equipo agrupa bots y que la batalla usa versiones en bandos, no equipos", async () => {
    mock();
    render(<TeamsPage me={ME} />);
    await screen.findByText("Rojos");
    const c = screen.getByTestId("teams-concepts").textContent ?? "";
    expect(c).toMatch(/agrupa personas y bots/);
    expect(c).toMatch(/versiones publicadas de bots/);
    expect(c).toMatch(/bando/);
    expect(c).toMatch(/mismo equipo pueden enfrentarse/);
  });

  it("sin equipos propios dice qué hacer, no deja la página vacía", async () => {
    mock((m, p) => (m === "GET" && p.startsWith("/teams") ? { items: [] } : undefined));
    render(<TeamsPage me={ME} />);
    expect((await screen.findByTestId("teams-empty")).textContent).toMatch(/Crea uno/);
  });
});

// @vitest-environment jsdom
/**
 * R8.2 · DoD de la gestión de mapas en el panel:
 *  - listar versiones con su estado y ofrecer publicar solo a las no publicadas;
 *  - importar un mapa inválido ⇒ los checks del validador REAL de E4 se ANUNCIAN
 *    (role="alert"), nunca se tragan;
 *  - publicar un mapa validado llama al endpoint real y refresca;
 *  - un fallo de carga NUNCA se pinta como lista vacía (role="alert" + reintento).
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

import { api, ApiRequestError } from "../src/api.js";
import { MapsPage } from "../src/pages/MapsPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user", "organizer"], twoFactorEnabled: false };

const MAPS = [
  {
    mapId: "arena-01",
    version: 1,
    state: "published",
    widthM: 40,
    heightM: 40,
    supportedModes: ["deathmatch"],
    thumbnailUrl: "data:image/svg+xml;base64,PHN2Zy8+",
  },
  { mapId: "arena-02", version: 1, state: "validated", widthM: 30, heightM: 30, supportedModes: ["deathmatch"] },
];

afterEach(cleanup);
beforeEach(() => apiMock.mockReset());

describe("R8.2 gestión de mapas", () => {
  it("lista versiones: publicado marcado como jugable, validado ofrece Publicar", async () => {
    apiMock.mockResolvedValue({ items: MAPS });
    render(<MapsPage me={ME} />);
    await screen.findByText("arena-01");
    expect(screen.getByText("Disponible para batallas")).toBeTruthy();
    expect(screen.getByLabelText("publicar-arena-02-v1")).toBeTruthy();
    // El publicado NO ofrece botón de publicar (es inmutable).
    expect(screen.queryByLabelText("publicar-arena-01-v1")).toBeNull();
  });

  it("importar un mapa inválido ANUNCIA los checks del validador (role=alert)", async () => {
    apiMock.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path === "/maps") return { items: [] };
      if (method === "POST" && path === "/maps") {
        throw new ApiRequestError(422, {
          error: "map_invalid",
          checks: [{ check: "spawns", severity: "error", message: "spawn fuera de límites" }],
        });
      }
      return { items: [] };
    });
    render(<MapsPage me={ME} />);
    await screen.findByText("No hay mapas todavía.");

    const input = screen.getByLabelText("archivo-mapa") as HTMLInputElement;
    const file = new File(["{}"], "malo.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Importar mapa" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No se pudo importar");
    expect(within(alert).getByTestId("validation-checks").textContent).toContain("spawn fuera de límites");
  });

  it("publicar un mapa validado llama al endpoint real y refresca", async () => {
    let published = false;
    apiMock.mockImplementation(async (method: string, path: string) => {
      if (method === "GET") return { items: published ? [{ ...MAPS[1], state: "published" }] : [MAPS[1]] };
      if (method === "POST" && path === "/maps/arena-02/versions/1/actions/publish") {
        published = true;
        return { ...MAPS[1], state: "published" };
      }
      return { items: [] };
    });
    render(<MapsPage me={ME} />);
    fireEvent.click(await screen.findByLabelText("publicar-arena-02-v1"));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("POST", "/maps/arena-02/versions/1/actions/publish"));
    await screen.findByText("Disponible para batallas");
  });

  it("un fallo de carga se dice con role=alert y reintento, no lista vacía", async () => {
    apiMock.mockRejectedValueOnce(new Error("gateway caído")).mockResolvedValueOnce({ items: MAPS });
    render(<MapsPage me={ME} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No se pudo cargar los mapas");
    expect(screen.queryByText("No hay mapas todavía.")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Reintentar" }));
    await screen.findByText("arena-01");
  });

  it("parámetros de generación no-JSON se rechazan antes de llamar a la API", async () => {
    apiMock.mockResolvedValue({ items: [] });
    render(<MapsPage me={ME} />);
    await screen.findByText("No hay mapas todavía.");
    fireEvent.change(screen.getByLabelText("semilla"), { target: { value: "s9-01" } });
    fireEvent.change(screen.getByLabelText("parámetros"), { target: { value: "no-es-json" } });
    fireEvent.click(screen.getByText("Generar mapa"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("JSON válido");
    expect(apiMock).not.toHaveBeenCalledWith("POST", "/maps/generate", expect.anything());
  });
});

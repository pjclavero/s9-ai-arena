// @vitest-environment jsdom
/**
 * EQ4 · carrera de selección en «Equipos» (flaky de CI: «Unable to find role="region" and
 * name "equipo Azules"»). El efecto que sincroniza `selectedId` con el primer equipo se
 * ejecutaba DESPUÉS del clic del usuario (efectos pasivos aplazados bajo carga) y lo pisaba
 * con el valor de la renderización anterior. Aquí se aplazan de forma determinista los
 * efectos pasivos de React (el scheduler usa `setImmediate`) para provocarlo siempre:
 * sin el arreglo de TeamsPage este fichero se pone rojo en cada ejecución.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Debe ejecutarse ANTES de que react-dom cargue el scheduler (captura setImmediate al importarse).
vi.hoisted(() => {
  const g = globalThis as unknown as { setImmediate: (f: (...a: unknown[]) => void, ...a: unknown[]) => unknown };
  g.setImmediate = (f, ...a) => setTimeout(() => f(...a), 40);
});

import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

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
import { TeamsPage } from "../src/pages/TeamsPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user"], twoFactorEnabled: false };
const mk = (id: string, name: string) => ({
  id,
  name,
  memberCount: 1,
  botCount: 0,
  isCaptain: true,
  isMember: true,
  members: [{ userId: "u1", displayName: "Ana", role: "captain" }],
  bots: [],
});

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("EQ4 · la selección del usuario no la pisa el efecto de selección inicial", () => {
  it("W_EQ4_SELECT_RACE · pulsar «Azules» nada más aparecer la lista deja «Azules» seleccionado", async () => {
    apiMock.mockImplementation((_m: string, p: string) =>
      Promise.resolve(p.startsWith("/teams") ? { items: [mk("t1", "Rojos"), mk("t2", "Azules")] } : { items: [] }),
    );
    render(<TeamsPage me={ME as never} />);
    const list = await screen.findByTestId("teams-list");
    expect(screen.getByRole("region", { name: "equipo Rojos" })).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Azules" }));
    expect(await screen.findByRole("region", { name: "equipo Azules" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "equipo Rojos" })).toBeNull();
  });
});

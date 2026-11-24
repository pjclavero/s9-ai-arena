// @vitest-environment jsdom
/**
 * ADM-1 · carrera de montaje en «Ajustes del sistema» (flaky de CI: «Unable to find an element
 * by: [data-testid="settings-error"]» en ERROR_DEL_SERVIDOR).
 * Causa: SettingRow resincronizaba el borrador con un efecto pasivo que corre también al montar.
 * Si ese efecto se ejecutaba DESPUÉS de que el usuario escribiera, devolvía el borrador al valor
 * del servidor: el botón «Guardar» volvía a estar deshabilitado, el clic no enviaba nada y no
 * había error que mostrar. Aquí los efectos pasivos de React se aplazan 150 ms (el scheduler usa
 * `setImmediate`) y la secuencia del test ocurre antes: el orden queda forzado por construcción.
 * Frágil por diseño: depende de que el scheduler capture `setImmediate` al importarse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const g = globalThis as unknown as { setImmediate: (f: (...a: unknown[]) => void, ...a: unknown[]) => unknown };
  g.setImmediate = (f, ...a) => setTimeout(() => f(...a), 150);
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
import { SettingsPage, type SystemSetting } from "../src/pages/admin/SettingsPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["admin"], twoFactorEnabled: false };
const HOT: SystemSetting = {
  key: "ops.probe_hot",
  type: "integer",
  min: 0,
  max: 100,
  options: null,
  default: 0,
  consumer: "api",
  apply: "hot",
  requiresRestart: false,
  description: "Sonda en caliente",
  envCeiling: 40,
  value: 5,
  source: "database",
  version: 3,
  updatedAt: "2026-11-20T10:00:00.000Z",
};

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("ADM-1 · el borrador del usuario no lo pisa el efecto de montaje", () => {
  it("W_ADM1_DRAFT_RACE · escribir antes de que corran los efectos aplazados no deshabilita «Guardar»", async () => {
    apiMock.mockResolvedValueOnce({ settings: [HOT] });
    render(<SettingsPage me={ME} />);
    await screen.findByTestId("settings-table");
    fireEvent.change(screen.getByTestId("setting-input-ops.probe_hot"), { target: { value: "99" } });
    apiMock.mockRejectedValueOnce(
      Object.assign(new Error("ops.probe_hot no puede superar el techo del entorno (40)"), { status: 400 }),
    );
    apiMock.mockResolvedValueOnce({ settings: [HOT] });
    const save = screen.getByTestId("setting-save-ops.probe_hot") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await screen.findByTestId("settings-error");
    expect(apiMock).toHaveBeenCalledWith("PATCH", "/admin/settings", {
      changes: [{ key: "ops.probe_hot", value: 99, expectedVersion: 3 }],
    });
  });
});

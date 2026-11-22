// @vitest-environment jsdom
/**
 * ADM-1 · «Ajustes del sistema» y componente de confirmación destructiva (API simulada).
 * Cada caso lleva su mutante en scripts/adm1-mutants.py.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
import { SettingsPage, parseDraft, rangeText, type SystemSetting } from "../src/pages/admin/SettingsPage.js";
import { ConfirmDestructive, phraseMatches } from "../src/pages/admin/ConfirmDestructive.js";

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
const COLD: SystemSetting = {
  ...HOT,
  key: "ops.probe_restart",
  type: "boolean",
  min: null,
  max: null,
  envCeiling: null,
  default: false,
  apply: "restart",
  requiresRestart: true,
  consumer: "replay-service",
  description: "Sonda con reinicio",
  value: false,
  source: "default",
  version: 0,
  updatedAt: null,
};

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(() => cleanup());

describe("ADM-1 · página Ajustes del sistema", () => {
  it("LISTA_CLAVES: pinta las claves del registro con consumidor, rango y techo del entorno", async () => {
    apiMock.mockResolvedValueOnce({ settings: [HOT, COLD] });
    render(<SettingsPage me={ME} />);
    await screen.findByTestId("settings-table");
    expect(apiMock).toHaveBeenCalledWith("GET", "/admin/settings");
    expect(screen.getByTestId("setting-row-ops.probe_hot")).toBeTruthy();
    expect(screen.getByTestId("setting-row-ops.probe_restart")).toBeTruthy();
    expect(screen.getByText(/0–100 · techo del entorno: 40/)).toBeTruthy();
    expect((screen.getByTestId("setting-input-ops.probe_hot") as HTMLInputElement).value).toBe("5");
  });

  it("AVISA_REINICIO: distingue «en caliente» de «requiere reiniciar» con texto (no sólo color)", async () => {
    apiMock.mockResolvedValueOnce({ settings: [HOT, COLD] });
    render(<SettingsPage me={ME} />);
    await screen.findByTestId("settings-table");
    expect(screen.getByTestId("setting-apply-ops.probe_hot").textContent).toMatch(/En caliente/);
    expect(screen.getByTestId("setting-apply-ops.probe_hot").getAttribute("data-apply")).toBe("hot");
    const cold = screen.getByTestId("setting-apply-ops.probe_restart");
    expect(cold.textContent).toMatch(/Requiere reiniciar «replay-service»/);
    expect(cold.getAttribute("data-apply")).toBe("restart");
  });

  it("GUARDA_CON_VERSION: PATCH con la versión que leyó y pinta lo que devuelve el servidor", async () => {
    apiMock.mockResolvedValueOnce({ settings: [HOT] });
    render(<SettingsPage me={ME} />);
    await screen.findByTestId("settings-table");
    const save = screen.getByTestId("setting-save-ops.probe_hot") as HTMLButtonElement;
    expect(save.disabled).toBe(true); // sin cambios no se guarda
    fireEvent.change(screen.getByTestId("setting-input-ops.probe_hot"), { target: { value: "12" } });
    expect(save.disabled).toBe(false);
    apiMock.mockResolvedValueOnce({
      settings: [{ ...HOT, value: 12, version: 4 }],
      changed: [{ key: "ops.probe_hot", requiresRestart: false }],
      pendingRestart: [],
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("PATCH", "/admin/settings", {
        changes: [{ key: "ops.probe_hot", value: 12, expectedVersion: 3 }],
      }),
    );
    await waitFor(() =>
      expect((screen.getByTestId("setting-input-ops.probe_hot") as HTMLInputElement).value).toBe("12"),
    );
    expect(screen.queryByTestId("settings-pending-restart")).toBeNull();
  });

  it("AVISO_PENDIENTE_REINICIO: tras guardar una clave de reinicio avisa y el aviso se conserva", async () => {
    apiMock.mockResolvedValueOnce({ settings: [HOT, COLD] });
    render(<SettingsPage me={ME} />);
    await screen.findByTestId("settings-table");
    fireEvent.click(screen.getByTestId("setting-input-ops.probe_restart"));
    apiMock.mockResolvedValueOnce({
      settings: [HOT, { ...COLD, value: true, version: 1, source: "database" }],
      changed: [{ key: "ops.probe_restart", requiresRestart: true }],
      pendingRestart: ["ops.probe_restart"],
    });
    fireEvent.click(screen.getByTestId("setting-save-ops.probe_restart"));
    const warn = await screen.findByTestId("settings-pending-restart");
    expect(warn.textContent).toMatch(/ops\.probe_restart/);
    expect(warn.getAttribute("role")).toBe("alert");
  });

  it("ERROR_DEL_SERVIDOR: un rechazo (400/409) se muestra y se recarga lo vigente", async () => {
    apiMock.mockResolvedValueOnce({ settings: [HOT] });
    render(<SettingsPage me={ME} />);
    await screen.findByTestId("settings-table");
    fireEvent.change(screen.getByTestId("setting-input-ops.probe_hot"), { target: { value: "99" } });
    apiMock.mockRejectedValueOnce(
      Object.assign(new Error("ops.probe_hot no puede superar el techo del entorno (40)"), { status: 400 }),
    );
    apiMock.mockResolvedValueOnce({ settings: [HOT] });
    fireEvent.click(screen.getByTestId("setting-save-ops.probe_hot"));
    await screen.findByTestId("settings-error");
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(3)); // GET, PATCH, GET de recarga
  });

  it("SIN_CLAVES: sin ajustes registrados lo dice en lugar de una tabla vacía", async () => {
    apiMock.mockResolvedValueOnce({ settings: [] });
    render(<SettingsPage me={ME} />);
    await screen.findByTestId("settings-empty");
    expect(screen.queryByTestId("settings-table")).toBeNull();
  });

  it("FALLO_DE_CARGA: no se queda en «Cargando…»", async () => {
    apiMock.mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 500 }));
    render(<SettingsPage me={ME} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });

  it("parseDraft/rangeText: convierten al tipo de la clave sin inventar valores", () => {
    expect(parseDraft(HOT, "12")).toBe(12);
    expect(parseDraft(HOT, "")).toBeUndefined();
    expect(parseDraft(HOT, "abc")).toBeUndefined();
    expect(parseDraft(COLD, true)).toBe(true);
    expect(rangeText(COLD)).toBe("sí / no");
  });
});

describe("ADM-1 · componente ConfirmDestructive", () => {
  const impact = { summary: "37 replays de práctica, 1,2 GiB", counts: { replays: 37 } };
  const PHRASE = "EJECUTAR system.noop destructive";

  function setup(extra: Partial<Parameters<typeof ConfirmDestructive>[0]> = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDestructive
        title="Limpiar"
        impact={impact}
        phrase={PHRASE}
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...extra}
      />,
    );
    return { onConfirm, onCancel };
  }
  const submit = () => screen.getByTestId("confirm-submit") as HTMLButtonElement;
  const type = (id: string, v: string) => fireEvent.change(screen.getByTestId(id), { target: { value: v } });

  it("MUESTRA_IMPACTO_DEL_SERVIDOR y la frase literal", () => {
    setup();
    expect(screen.getByTestId("confirm-impact-summary").textContent).toMatch(/37 replays de práctica/);
    expect(screen.getByTestId("confirm-impact-counts").textContent).toMatch(/replays: 37/);
    expect(screen.getByTestId("confirm-phrase").textContent).toBe(PHRASE);
  });

  it("FRASE_EXACTA_Y_CONTRASEÑA: Confirmar sólo se habilita con la frase literal y la contraseña", () => {
    const { onConfirm } = setup();
    expect(submit().disabled).toBe(true);
    type("confirm-phrase-input", PHRASE.toLowerCase());
    type("confirm-password-input", "secreta");
    expect(submit().disabled).toBe(true); // otra capitalización no vale
    type("confirm-phrase-input", PHRASE);
    expect(submit().disabled).toBe(false);
    type("confirm-password-input", "");
    expect(submit().disabled).toBe(true);
    type("confirm-password-input", "secreta");
    fireEvent.click(submit());
    expect(onConfirm).toHaveBeenCalledWith({ phrase: PHRASE, password: "secreta", totp: undefined });
  });

  it("TOTP: si la cuenta tiene 2FA exige el código; si no, no lo pide", () => {
    const { onConfirm } = setup({ needsTotp: true });
    type("confirm-phrase-input", PHRASE);
    type("confirm-password-input", "secreta");
    expect(submit().disabled).toBe(true);
    type("confirm-totp-input", "123456");
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    expect(onConfirm).toHaveBeenCalledWith({ phrase: PHRASE, password: "secreta", totp: "123456" });
  });

  it("SIN_TOTP_NO_LO_PIDE", () => {
    setup();
    expect(screen.queryByTestId("confirm-totp-input")).toBeNull();
  });

  it("SEGUNDO_ADMIN: avisa de que la confirma otro administrador sólo cuando procede", () => {
    cleanup();
    setup({ requiresSecondAdmin: true });
    expect(screen.getByTestId("confirm-second-admin").textContent).toMatch(/segundo administrador/);
    cleanup();
    setup();
    expect(screen.queryByTestId("confirm-second-admin")).toBeNull();
  });

  it("OCUPADO_Y_CANCELAR: con busy no se puede reenviar; Cancelar llama a onCancel; el error se pinta", () => {
    const { onCancel } = setup({ busy: true, error: Object.assign(new Error("Credenciales"), { status: 401 }) });
    type("confirm-phrase-input", PHRASE);
    type("confirm-password-input", "x");
    expect(submit().disabled).toBe(true);
    expect(screen.getByTestId("confirm-error")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("phraseMatches: exacta (sólo se recortan espacios de los extremos) y nunca con frase vacía", () => {
    expect(phraseMatches(` ${PHRASE} `, PHRASE)).toBe(true);
    expect(phraseMatches(PHRASE.toUpperCase(), PHRASE)).toBe(false);
    expect(phraseMatches("", "")).toBe(false);
  });
});

// @vitest-environment jsdom
/**
 * V1 ADM-SETUP (D-OP-44) · Asistente de primer arranque y kit de recuperación en la web (pruebas de
 * componente con la API mockeada; el comportamiento real está en apps/api/src/setup-web.test.ts y
 * apps/api/src/recovery-kit.test.ts). Los mutantes llevan el nombre del caso entre [].
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../src/api.js", () => ({ api: vi.fn(), setToken: vi.fn() }));
import { api, setToken } from "../src/api.js";
import { SetupPage, validateSetupForm } from "../src/pages/SetupPage.js";
import { AccessHelp, RecoveryKitAdminPage, RecoveryKitRedeemPage } from "../src/pages/RecoveryKitPages.js";
import { matchPublicRoute, matchStaticPanelRoute } from "../src/App.js";
import { ADMIN_SECTIONS } from "../src/admin-nav.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const setTokenMock = setToken as unknown as ReturnType<typeof vi.fn>;
const KIT = "S9RK-ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789";
const ME = {
  id: "u1",
  displayName: "Op",
  email: "op@ejemplo.test",
  roles: ["user", "developer", "admin"],
  twoFactorEnabled: false,
};

function httpError(status: number, body: Record<string, unknown> = {}) {
  return Object.assign(new Error(String(body.message ?? status)), { status, body, kind: "http" });
}

beforeEach(() => {
  window.location.hash = "#/setup";
});
afterEach(() => {
  cleanup();
  apiMock.mockReset();
  setTokenMock.mockReset();
});

function fillSetup(v: { token?: string; name?: string; email?: string; pw?: string; confirm?: string } = {}) {
  fireEvent.change(screen.getByLabelText("token de instalación"), { target: { value: v.token ?? "tok-123" } });
  fireEvent.change(screen.getByLabelText("nombre"), { target: { value: v.name ?? "Operadora" } });
  fireEvent.change(screen.getByLabelText("email"), { target: { value: v.email ?? "op@ejemplo.test" } });
  fireEvent.change(screen.getByLabelText("contraseña"), { target: { value: v.pw ?? "frase-de-paso-larga-1" } });
  fireEvent.change(screen.getByLabelText("repite la contraseña"), {
    target: { value: v.confirm ?? v.pw ?? "frase-de-paso-larga-1" },
  });
}

describe("V1 ADM-SETUP · rutas", () => {
  it("[W1-rutas] #/setup y #/recover-kit son públicas; #/recovery-kit es del panel (Administración)", () => {
    expect(matchPublicRoute("#/setup")?.kind).toBe("setup");
    expect(matchPublicRoute("#/setupX")).toBeNull();
    expect(matchPublicRoute("#/recover-kit")?.kind).toBe("recoverKit");
    expect(matchStaticPanelRoute("#/recovery-kit")).toBe("recoveryKit");
    const s = ADMIN_SECTIONS.find((x) => x.href === "#/recovery-kit");
    expect(s?.minRole).toBe("admin");
    expect(s?.operations).toEqual(["getRecoveryKitStatus", "regenerateRecoveryKit"]);
  });
});

describe("V1 ADM-SETUP · SetupPage", () => {
  it("validación local: token, nombre, email, 12-128 y confirmación", () => {
    const ok = { token: "t", displayName: "A", email: "a@b.cd", password: "x".repeat(12), confirm: "x".repeat(12) };
    expect(validateSetupForm(ok)).toBeNull();
    expect(validateSetupForm({ ...ok, token: " " })?.field).toBe("token");
    expect(validateSetupForm({ ...ok, password: "x".repeat(11), confirm: "x".repeat(11) })?.field).toBe("password");
    expect(validateSetupForm({ ...ok, password: "x".repeat(129), confirm: "x".repeat(129) })?.field).toBe("password");
    expect(validateSetupForm({ ...ok, confirm: "y".repeat(12) })?.field).toBe("confirm");
  });

  it("[W2-cerrado-redirige] con el asistente cerrado no hay formulario y se vuelve al inicio de sesión", async () => {
    apiMock.mockResolvedValueOnce({ open: false });
    render(<SetupPage onLogin={vi.fn()} />);
    await screen.findByTestId("setup-closed");
    expect(screen.queryByTestId("setup-form")).toBeNull();
    expect(window.location.hash).toBe("#/");
    expect(apiMock).toHaveBeenCalledWith("GET", "/setup/status", undefined, { reauth: true });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("[W3-recorrido-completo] abierto: crea el admin (reauth, sin refresco), muestra el kit UNA vez y entra al confirmar que lo guardó", async () => {
    apiMock.mockResolvedValueOnce({ open: true });
    apiMock.mockResolvedValueOnce({ accessToken: "acc", refreshToken: "ref", expiresIn: 900, recoveryKit: KIT });
    apiMock.mockResolvedValueOnce(ME);
    const onLogin = vi.fn();
    render(<SetupPage onLogin={onLogin} />);
    await screen.findByTestId("setup-form");
    fillSetup();
    fireEvent.click(screen.getByRole("button", { name: "Crear administrador" }));
    await screen.findByTestId("recovery-kit-reveal");
    expect(apiMock.mock.calls[1]).toEqual([
      "POST",
      "/setup/admin",
      { setupToken: "tok-123", email: "op@ejemplo.test", displayName: "Operadora", password: "frase-de-paso-larga-1" },
      { reauth: true },
    ]);
    expect(setTokenMock).toHaveBeenCalledWith("acc");
    expect(screen.getByTestId("recovery-kit-value").textContent).toBe(KIT);
    const done = screen.getByTestId("recovery-kit-done") as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("lo he guardado"));
    expect(done.disabled).toBe(false);
    fireEvent.click(done);
    expect(onLogin).toHaveBeenCalledWith(ME);
    expect(window.location.hash).toBe("#/");
  });

  it("token incorrecto (401) ⇒ mensaje claro y nada de sesión", async () => {
    apiMock.mockResolvedValueOnce({ open: true });
    apiMock.mockRejectedValueOnce(httpError(401, { error: "unauthorized" }));
    const onLogin = vi.fn();
    render(<SetupPage onLogin={onLogin} />);
    await screen.findByTestId("setup-form");
    fillSetup();
    fireEvent.click(screen.getByRole("button", { name: "Crear administrador" }));
    const err = await screen.findByTestId("setup-form-error");
    expect(err.textContent).toContain("token de instalación no es correcto");
    expect(setTokenMock).not.toHaveBeenCalled();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("contraseñas distintas ⇒ no se llama a POST /setup/admin", async () => {
    apiMock.mockResolvedValueOnce({ open: true });
    render(<SetupPage onLogin={vi.fn()} />);
    await screen.findByTestId("setup-form");
    fillSetup({ confirm: "otra-cosa-distinta-1" });
    fireEvent.click(screen.getByRole("button", { name: "Crear administrador" }));
    await screen.findByTestId("setup-form-error");
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});

describe("V1 ADM-SETUP · acceso y kit", () => {
  it("[W4-aviso-login] el acceso avisa del asistente sólo si está abierto", async () => {
    apiMock.mockResolvedValueOnce({ open: true });
    render(<AccessHelp />);
    await screen.findByTestId("setup-open-notice");
    // Sin sesión: la consulta va con reauth, así un 401 no se toma por sesión caducada (no echa al usuario).
    expect(apiMock).toHaveBeenCalledWith("GET", "/setup/status", undefined, { reauth: true });
    expect(screen.getByTestId("recover-kit-link")).toBeTruthy();
    cleanup();
    apiMock.mockResolvedValueOnce({ open: false });
    render(<AccessHelp />);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("setup-open-notice")).toBeNull();
  });

  it("[W5-canje-2fa] el canje pide el segundo factor cuando la API lo exige y termina consumiendo el kit", async () => {
    apiMock.mockRejectedValueOnce(httpError(401, { error: "totp_required" }));
    apiMock.mockResolvedValueOnce(undefined);
    render(<RecoveryKitRedeemPage />);
    fireEvent.change(screen.getByLabelText("email"), { target: { value: "op@ejemplo.test" } });
    fireEvent.change(screen.getByLabelText("kit de recuperación"), { target: { value: KIT } });
    fireEvent.change(screen.getByLabelText("contraseña nueva"), { target: { value: "nueva-frase-larga-22" } });
    fireEvent.change(screen.getByLabelText("repite la contraseña nueva"), {
      target: { value: "nueva-frase-larga-22" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cambiar la contraseña" }));
    await screen.findByLabelText("totp");
    fireEvent.change(screen.getByLabelText("totp"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Cambiar la contraseña" }));
    await screen.findByTestId("recover-kit-done");
    expect(apiMock.mock.calls[1]).toEqual([
      "POST",
      "/auth/recovery-kit/redeem",
      { email: "op@ejemplo.test", recoveryKit: KIT, newPassword: "nueva-frase-larga-22", totp: "123456" },
    ]);
  });

  it("[W6-regenerar] Administración → Kit: regenerar exige contraseña (reauth) y muestra el kit nuevo una vez", async () => {
    apiMock.mockResolvedValueOnce({ active: false, createdAt: null });
    apiMock.mockResolvedValueOnce({ recoveryKit: KIT, createdAt: "2026-11-24T00:00:00.000Z" });
    render(<RecoveryKitAdminPage me={ME} />);
    await screen.findByTestId("recovery-kit-status");
    fireEvent.click(screen.getByRole("button", { name: "Generar un kit nuevo" }));
    await screen.findByTestId("recovery-kit-error");
    expect(apiMock).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("contraseña actual"), { target: { value: "mi-contraseña-actual" } });
    fireEvent.click(screen.getByRole("button", { name: "Generar un kit nuevo" }));
    await screen.findByTestId("recovery-kit-reveal");
    expect(apiMock.mock.calls[1]).toEqual([
      "POST",
      "/auth/recovery-kit",
      { password: "mi-contraseña-actual" },
      { reauth: true },
    ]);
    expect(screen.getByTestId("recovery-kit-value").textContent).toBe(KIT);
  });
});

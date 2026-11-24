// @vitest-environment jsdom
/**
 * V1 ADM-3 · Página de usuarios (MODELO DE UN ADMINISTRADOR: ninguna acción pide a otro admin) y canje del token (API simulada).
 * Cada caso lleva su mutante en scripts/adm3-mutants.py.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../src/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api.js")>()),
  api: vi.fn(),
}));

import { api } from "../src/api.js";
import { UsersPage, type AdminUser } from "../src/pages/admin/UsersPage.js";
import { ResetPasswordPage, validateReset } from "../src/pages/ResetPasswordPage.js";
import { matchPublicRoute } from "../src/App.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "me-id", displayName: "Ana", email: "ana@x.es", roles: ["admin"], twoFactorEnabled: false };

const U1: AdminUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "bea@x.es",
  displayName: "Bea",
  roles: ["user", "developer"],
  status: "active",
  twoFactorEnabled: true,
  recoveryPending: false,
  createdAt: "2026-11-01T10:00:00.000Z",
  blockedAt: null,
};
const U2: AdminUser = {
  ...U1,
  id: "22222222-2222-4222-8222-222222222222",
  email: "blas@x.es",
  displayName: "Blas",
  status: "blocked",
  blockedAt: "2026-11-02T10:00:00.000Z",
  twoFactorEnabled: false,
};
const ADM: AdminUser = {
  ...U1,
  id: "33333333-3333-4333-8333-333333333333",
  email: "cris@x.es",
  displayName: "Cris",
  roles: ["user", "admin"],
};
const SELF: AdminUser = { ...U1, id: ME.id, email: ME.email, displayName: "Ana", roles: ["user", "admin"] };

/** Enruta la API simulada por método+ruta. */
function route(handlers: Record<string, (body?: unknown, opts?: unknown) => unknown>) {
  apiMock.mockImplementation(async (method: string, path: string, body?: unknown, opts?: unknown) => {
    const key = `${method} ${path.split("?")[0]}`;
    const h = handlers[key];
    if (!h) throw new Error(`sin simular: ${key}`);
    return h(body, opts);
  });
}
const page = (items: AdminUser[], nextCursor?: string) => ({ items, nextCursor });
const calls = (method: string, prefix: string) =>
  apiMock.mock.calls.filter((c) => c[0] === method && String(c[1]).startsWith(prefix));

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(() => cleanup());

/** Rellena la confirmación abierta (frase, contraseña y, si se pide, TOTP) y la envía. */
async function confirmWith(phrase: string, password: string, totp?: string) {
  await screen.findByTestId("confirm-destructive");
  fireEvent.change(screen.getByTestId("confirm-phrase-input"), { target: { value: phrase } });
  fireEvent.change(screen.getByTestId("confirm-password-input"), { target: { value: password } });
  if (totp) fireEvent.change(screen.getByTestId("confirm-totp-input"), { target: { value: totp } });
  fireEvent.click(screen.getByTestId("confirm-submit"));
}

describe("ADM-3 · página de usuarios", () => {
  it("USUARIOS_LISTA: pinta usuarios, roles, estado y 2FA, sin pedir un UUID a mano", async () => {
    route({ "GET /admin/users": () => page([U1, U2, SELF]) });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    expect(screen.getByTestId(`user-row-${U1.id}`).textContent).toMatch(/Bea.*bea@x\.es.*2FA/s);
    expect(screen.getByTestId(`user-row-${U2.id}`).textContent).toMatch(/bloqueada/);
    expect(screen.getByTestId(`user-row-${U1.id}`).textContent).toMatch(/user, developer/);
    expect(screen.queryByLabelText("rol-userid")).toBeNull();
    expect(calls("GET", "/admin/users")[0][1]).toBe("/admin/users?limit=20");
  });

  it("BUSCA: la búsqueda va al servidor con q y reemplaza el listado", async () => {
    route({ "GET /admin/users": () => page([U1]) });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.change(screen.getByTestId("users-search"), { target: { value: " bea " } });
    fireEvent.click(screen.getByTestId("users-search-submit"));
    await waitFor(() => expect(calls("GET", "/admin/users?limit=20&q=bea")).toHaveLength(1));
  });

  it("CARGAR_MAS: sigue el cursor y AÑADE la página siguiente", async () => {
    let n = 0;
    route({ "GET /admin/users": () => (n++ === 0 ? page([U1], "CUR1") : page([U2])) });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId("users-more"));
    await screen.findByTestId(`user-row-${U2.id}`);
    expect(screen.getByTestId(`user-row-${U1.id}`)).toBeTruthy();
    expect(calls("GET", "/admin/users?limit=20&cursor=CUR1")).toHaveLength(1);
    expect(screen.queryByTestId("users-more")).toBeNull();
  });

  it("PROPIA_FILA: sin token de recuperación para uno mismo, pero sí «Bloquear» (el servidor protege al último admin)", async () => {
    route({ "GET /admin/users": () => page([SELF, U1]) });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    expect(screen.queryByTestId(`recover-${SELF.id}`)).toBeNull();
    expect(screen.getByTestId(`status-${SELF.id}`)).toBeTruthy();
    expect(screen.getByTestId(`recover-${U1.id}`)).toBeTruthy();
  });

  it("BLOQUEAR_CONFIRMA: la acción destructiva pide frase LITERAL y contraseña, y envía la reautenticación", async () => {
    route({
      "GET /admin/users": () => page([U1]),
      "PUT /admin/users/11111111-1111-4111-8111-111111111111/status": () => ({ status: "blocked", changed: true }),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`status-${U1.id}`));
    await screen.findByTestId("confirm-destructive");
    expect(calls("PUT", "/admin/users")).toHaveLength(0);
    const submit = screen.getByTestId("confirm-submit") as HTMLButtonElement;
    expect(screen.getByTestId("confirm-phrase").textContent).toBe("BLOQUEAR bea@x.es");
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("confirm-phrase-input"), { target: { value: "bloquear bea@x.es" } });
    fireEvent.change(screen.getByTestId("confirm-password-input"), { target: { value: "mi-clave-larga-1" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("confirm-phrase-input"), { target: { value: "BLOQUEAR bea@x.es" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(calls("PUT", "/admin/users")).toHaveLength(1));
    const c = calls("PUT", "/admin/users")[0];
    expect(c[2]).toEqual({ status: "blocked", password: "mi-clave-larga-1" });
    expect(c[3]).toEqual({ reauth: true });
    await screen.findByTestId("users-notice");
  });

  it("BLOQUEAR_ADMIN_DIRECTO: bloquear a OTRO admin es una acción directa de un solo admin (sin órdenes ni aprobación)", async () => {
    route({
      "GET /admin/users": () => page([ADM]),
      "PUT /admin/users/33333333-3333-4333-8333-333333333333/status": () => ({ status: "blocked", changed: true }),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`status-${ADM.id}`));
    await confirmWith("BLOQUEAR cris@x.es", "mi-clave-larga-1");
    await waitFor(() => expect(calls("PUT", "/admin/users")).toHaveLength(1));
    expect(calls("PUT", "/admin/users")[0][2]).toEqual({ status: "blocked", password: "mi-clave-larga-1" });
    expect(calls("POST", "/admin/operations")).toHaveLength(0);
  });

  it("DESBLOQUEAR: una cuenta bloqueada ofrece «Desbloquear» con su propia frase y no ofrece token", async () => {
    route({
      "GET /admin/users": () => page([U2]),
      "PUT /admin/users/22222222-2222-4222-8222-222222222222/status": () => ({ status: "active", changed: true }),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    expect(screen.getByTestId(`status-${U2.id}`).textContent).toBe("Desbloquear");
    expect(screen.queryByTestId(`recover-${U2.id}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`status-${U2.id}`));
    await screen.findByTestId("confirm-destructive");
    expect(screen.getByTestId("confirm-phrase").textContent).toBe("DESBLOQUEAR blas@x.es");
    await confirmWith("DESBLOQUEAR blas@x.es", "mi-clave-larga-1");
    await waitFor(() => expect(calls("PUT", "/admin/users")).toHaveLength(1));
    expect(calls("PUT", "/admin/users")[0][2]).toEqual({ status: "active", password: "mi-clave-larga-1" });
  });

  it("ROLES_REALES_POR_ID: al abrir el editor pide los roles REALES de la cuenta y guarda sobre ellos (sin contraseña si no toca admin)", async () => {
    route({
      "GET /admin/users": () => page([U1]), // la página trae roles desfasados
      "GET /admin/users/11111111-1111-4111-8111-111111111111": () => ({
        ...U1,
        roles: ["user", "developer", "moderator"],
      }),
      "PUT /users/11111111-1111-4111-8111-111111111111/roles": () => ({}),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`roles-edit-${U1.id}`));
    await screen.findByTestId(`role-${U1.id}-moderator`);
    expect((screen.getByTestId(`role-${U1.id}-moderator`) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId(`role-${U1.id}-organizer`));
    fireEvent.click(screen.getByTestId(`roles-save-${U1.id}`));
    await screen.findByTestId("confirm-destructive");
    expect(screen.queryByTestId("confirm-password-input")).toBeNull();
    expect(screen.getByTestId("confirm-impact-summary").textContent).toMatch(/organizer/);
    fireEvent.change(screen.getByTestId("confirm-phrase-input"), { target: { value: "CAMBIAR ROLES bea@x.es" } });
    fireEvent.click(screen.getByTestId("confirm-submit"));
    await waitFor(() => expect(calls("PUT", "/users/")).toHaveLength(1));
    expect(calls("PUT", "/users/")[0][2]).toEqual({ roles: ["user", "developer", "moderator", "organizer"] });
  });

  it("CONCEDER_ADMIN_REAUTH: dar el rol admin pide contraseña, la envía y NO crea órdenes", async () => {
    route({
      "GET /admin/users": () => page([U1]),
      "GET /admin/users/11111111-1111-4111-8111-111111111111": () => U1,
      "PUT /users/11111111-1111-4111-8111-111111111111/roles": () => ({}),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`roles-edit-${U1.id}`));
    await screen.findByTestId(`role-${U1.id}-admin`);
    fireEvent.click(screen.getByTestId(`role-${U1.id}-admin`));
    fireEvent.click(screen.getByTestId(`roles-save-${U1.id}`));
    await confirmWith("CAMBIAR ROLES bea@x.es", "mi-clave-larga-1");
    await waitFor(() => expect(calls("PUT", "/users/")).toHaveLength(1));
    const c = calls("PUT", "/users/")[0];
    expect(c[2]).toEqual({ roles: ["user", "developer", "admin"], password: "mi-clave-larga-1" });
    expect(c[3]).toEqual({ reauth: true });
    expect(calls("POST", "/admin/operations")).toHaveLength(0);
  });

  it("QUITAR_ADMIN_A_OTRO_DIRECTO: quitar «admin» a otra cuenta es una acción directa, con contraseña", async () => {
    route({
      "GET /admin/users": () => page([ADM]),
      "GET /admin/users/33333333-3333-4333-8333-333333333333": () => ADM,
      "PUT /users/33333333-3333-4333-8333-333333333333/roles": () => ({}),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`roles-edit-${ADM.id}`));
    await screen.findByTestId(`role-${ADM.id}-admin`);
    fireEvent.click(screen.getByTestId(`role-${ADM.id}-admin`));
    fireEvent.click(screen.getByTestId(`roles-save-${ADM.id}`));
    await confirmWith("CAMBIAR ROLES cris@x.es", "mi-clave-larga-1");
    await waitFor(() => expect(calls("PUT", "/users/")).toHaveLength(1));
    expect(calls("PUT", "/users/")[0][2]).toEqual({ roles: ["user"], password: "mi-clave-larga-1" });
    expect(calls("POST", "/admin/operations")).toHaveLength(0);
  });

  it("TOKEN_UNA_VEZ: el token se muestra tras emitirlo, con caducidad, y desaparece al ocultarlo", async () => {
    route({
      "GET /admin/users": () => page([U1]),
      "POST /admin/users/11111111-1111-4111-8111-111111111111/recovery-token": () => ({
        token: "TOKEN-SECRETO-DE-PRUEBA",
        expiresAt: "2026-11-24T12:30:00.000Z",
        userId: U1.id,
      }),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`recover-${U1.id}`));
    await confirmWith("RECUPERAR bea@x.es", "mi-clave-larga-1");
    const card = await screen.findByTestId("recovery-token-card");
    expect(screen.getByTestId("recovery-token-value").textContent).toBe("TOKEN-SECRETO-DE-PRUEBA");
    expect(card.textContent).toMatch(/una sola vez/);
    const c = calls("POST", "/admin/users/")[0];
    expect(c[2]).toEqual({ password: "mi-clave-larga-1" });
    expect(c[3]).toEqual({ reauth: true });
    fireEvent.click(screen.getByTestId("recovery-token-close"));
    expect(screen.queryByTestId("recovery-token-card")).toBeNull();
    expect(document.body.textContent).not.toContain("TOKEN-SECRETO-DE-PRUEBA");
  });

  it("TOKEN_DE_ADMIN_DIRECTO: la cuenta de otro admin también se recupera con UN token emitido directamente", async () => {
    route({
      "GET /admin/users": () => page([ADM]),
      "POST /admin/users/33333333-3333-4333-8333-333333333333/recovery-token": () => ({
        token: "TOKEN-ADMIN",
        expiresAt: "2026-11-24T12:30:00.000Z",
        userId: ADM.id,
      }),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    expect(screen.getByTestId(`recover-${ADM.id}`).textContent).toBe("Token de recuperación");
    fireEvent.click(screen.getByTestId(`recover-${ADM.id}`));
    await confirmWith("RECUPERAR cris@x.es", "mi-clave-larga-1");
    await screen.findByTestId("recovery-token-card");
    expect(calls("POST", "/admin/users/")[0][2]).toEqual({ password: "mi-clave-larga-1" });
    expect(calls("POST", "/admin/operations")).toHaveLength(0);
  });

  it("NEEDS_TOTP: un admin con 2FA ve el campo TOTP y lo envía", async () => {
    route({
      "GET /admin/users": () => page([U1]),
      "PUT /admin/users/11111111-1111-4111-8111-111111111111/status": () => ({ status: "blocked", changed: true }),
    });
    render(<UsersPage me={{ ...ME, twoFactorEnabled: true }} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`status-${U1.id}`));
    await screen.findByTestId("confirm-destructive");
    expect(screen.getByTestId("confirm-totp-input")).toBeTruthy();
    const submit = screen.getByTestId("confirm-submit") as HTMLButtonElement;
    fireEvent.change(screen.getByTestId("confirm-phrase-input"), { target: { value: "BLOQUEAR bea@x.es" } });
    fireEvent.change(screen.getByTestId("confirm-password-input"), { target: { value: "mi-clave-larga-1" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("confirm-totp-input"), { target: { value: "123456" } });
    fireEvent.click(submit);
    await waitFor(() => expect(calls("PUT", "/admin/users")).toHaveLength(1));
    expect(calls("PUT", "/admin/users")[0][2]).toEqual({
      status: "blocked",
      password: "mi-clave-larga-1",
      totp: "123456",
    });
  });

  it("ERROR_DEL_SERVIDOR: un rechazo de la API (p. ej. 409 último admin) se muestra y la confirmación sigue abierta", async () => {
    route({
      "GET /admin/users": () => page([SELF, U1]),
      "PUT /admin/users/me-id/status": () => {
        throw Object.assign(new Error("No se puede bloquear al último administrador activo"), {
          status: 409,
          body: { error: "last_admin" },
        });
      },
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`status-${SELF.id}`));
    await confirmWith("BLOQUEAR ana@x.es", "mi-clave-larga-1");
    const err = await screen.findByTestId("users-error");
    expect(err.textContent).toMatch(/último administrador/);
    expect(screen.getByTestId("confirm-destructive")).toBeTruthy();
  });

  it("SIN_PEDIR_OTRO_ADMIN: la pantalla no habla de segundo admin ni de aprobaciones de otro administrador", async () => {
    route({ "GET /admin/users": () => page([ADM, U1, SELF]) });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`status-${ADM.id}`));
    await screen.findByTestId("confirm-destructive");
    expect(document.body.textContent).not.toMatch(/segundo admin|otro administrador|aprobaci/i);
    expect(screen.queryByTestId("recovery-ops")).toBeNull();
    expect(screen.queryByTestId("confirm-second-admin")).toBeNull();
  });
});

describe("ADM-3 · canje del token (#/reset)", () => {
  it("RESET_RUTA_PUBLICA: #/reset es una ruta pública (sin sesión)", () => {
    expect(matchPublicRoute("#/reset")).toEqual({ kind: "reset" });
    expect(matchPublicRoute("#/reset?x=1")).toEqual({ kind: "reset" });
    expect(matchPublicRoute("#/resetx")).toBeNull();
  });

  it("RESET_VALIDACION: token y contraseña (≥12, repetida) se validan antes de enviar", () => {
    expect(validateReset("", "contraseña-larga-1", "contraseña-larga-1")).toMatch(/token/);
    expect(validateReset("t", "corta", "corta")).toMatch(/al menos 12/);
    expect(validateReset("t", "contraseña-larga-1", "otra-distinta-123")).toMatch(/no coinciden/);
    expect(validateReset("t", "contraseña-larga-1", "contraseña-larga-1")).toBeNull();
  });

  it("RESET_ENVIA: canjea con token y contraseña nueva y avisa de que se cerraron las sesiones", async () => {
    apiMock.mockResolvedValue(undefined);
    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByTestId("reset-token"), { target: { value: "  TOKEN-123  " } });
    fireEvent.change(screen.getByTestId("reset-password"), { target: { value: "contraseña-larga-1" } });
    fireEvent.change(screen.getByTestId("reset-repeat"), { target: { value: "contraseña-larga-1" } });
    fireEvent.click(screen.getByTestId("reset-submit"));
    await screen.findByTestId("reset-done");
    expect(apiMock).toHaveBeenCalledWith("POST", "/auth/reset", {
      token: "TOKEN-123",
      newPassword: "contraseña-larga-1",
    });
    expect(screen.getByTestId("reset-done").textContent).toMatch(/sesiones anteriores/);
  });

  it("RESET_NO_ENVIA_SI_INVALIDO y RESET_ERROR: no llama a la API con datos inválidos y muestra el rechazo del servidor", async () => {
    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByTestId("reset-token"), { target: { value: "T" } });
    fireEvent.change(screen.getByTestId("reset-password"), { target: { value: "corta" } });
    fireEvent.change(screen.getByTestId("reset-repeat"), { target: { value: "corta" } });
    fireEvent.click(screen.getByTestId("reset-submit"));
    await screen.findByTestId("reset-local-error");
    expect(apiMock).not.toHaveBeenCalled();
    apiMock.mockRejectedValueOnce(
      Object.assign(new Error("Token de recuperación inválido o expirado"), { status: 401 }),
    );
    fireEvent.change(screen.getByTestId("reset-password"), { target: { value: "contraseña-larga-1" } });
    fireEvent.change(screen.getByTestId("reset-repeat"), { target: { value: "contraseña-larga-1" } });
    fireEvent.click(screen.getByTestId("reset-submit"));
    const err = await screen.findByTestId("reset-error");
    expect(err.textContent).toMatch(/inválido o expirado/);
    expect(screen.queryByTestId("reset-done")).toBeNull();
  });
});

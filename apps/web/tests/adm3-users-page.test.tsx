// @vitest-environment jsdom
/**
 * V1 ADM-3 · Página de usuarios del administrador y canje del token de recuperación (API simulada).
 * Cada caso lleva su mutante en scripts/adm3-mutants.py.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../src/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api.js")>()),
  api: vi.fn(),
}));

import { api } from "../src/api.js";
import { UsersPage, type AdminUser, type RecoveryOperation } from "../src/pages/admin/UsersPage.js";
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
    route({ "GET /admin/users": () => page([U1, U2, SELF]), "GET /admin/operations": () => [] });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    expect(screen.getByTestId(`user-row-${U1.id}`).textContent).toMatch(/Bea.*bea@x\.es.*2FA/s);
    expect(screen.getByTestId(`user-row-${U2.id}`).textContent).toMatch(/bloqueada/);
    expect(screen.getByTestId(`user-row-${U1.id}`).textContent).toMatch(/user, developer/);
    expect(screen.queryByLabelText("rol-userid")).toBeNull();
    expect(calls("GET", "/admin/users")[0][1]).toBe("/admin/users?limit=20");
  });

  it("BUSCA: la búsqueda va al servidor con q y reemplaza el listado", async () => {
    route({ "GET /admin/users": () => page([U1]), "GET /admin/operations": () => [] });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.change(screen.getByTestId("users-search"), { target: { value: " bea " } });
    fireEvent.click(screen.getByTestId("users-search-submit"));
    await waitFor(() => expect(calls("GET", "/admin/users?limit=20&q=bea")).toHaveLength(1));
  });

  it("CARGAR_MAS: sigue el cursor y AÑADE la página siguiente", async () => {
    let n = 0;
    route({
      "GET /admin/users": () => (n++ === 0 ? page([U1], "CUR1") : page([U2])),
      "GET /admin/operations": () => [],
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId("users-more"));
    await screen.findByTestId(`user-row-${U2.id}`);
    expect(screen.getByTestId(`user-row-${U1.id}`)).toBeTruthy();
    expect(calls("GET", "/admin/users?limit=20&cursor=CUR1")).toHaveLength(1);
    expect(screen.queryByTestId("users-more")).toBeNull(); // sin siguiente cursor
  });

  it("SIN_ACCIONES_SOBRE_UNO_MISMO: en la propia fila no hay bloquear ni token", async () => {
    route({ "GET /admin/users": () => page([SELF, U1]), "GET /admin/operations": () => [] });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    expect(screen.queryByTestId(`status-${SELF.id}`)).toBeNull();
    expect(screen.queryByTestId(`recover-${SELF.id}`)).toBeNull();
    expect(screen.getByTestId(`status-${U1.id}`)).toBeTruthy();
  });

  it("BLOQUEAR_CONFIRMA: la acción destructiva pide frase LITERAL y contraseña, y envía la reautenticación", async () => {
    route({
      "GET /admin/users": () => page([U1]),
      "GET /admin/operations": () => [],
      "PUT /admin/users/11111111-1111-4111-8111-111111111111/status": () => ({ status: "blocked", changed: true }),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`status-${U1.id}`));
    await screen.findByTestId("confirm-destructive");
    expect(calls("PUT", "/admin/users")).toHaveLength(0); // aún no
    const submit = screen.getByTestId("confirm-submit") as HTMLButtonElement;
    expect(screen.getByTestId("confirm-phrase").textContent).toBe("BLOQUEAR bea@x.es");
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("confirm-phrase-input"), { target: { value: "bloquear bea@x.es" } });
    fireEvent.change(screen.getByTestId("confirm-password-input"), { target: { value: "mi-clave-larga-1" } });
    expect(submit.disabled).toBe(true); // frase con otras mayúsculas: no vale
    fireEvent.change(screen.getByTestId("confirm-phrase-input"), { target: { value: "BLOQUEAR bea@x.es" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(calls("PUT", "/admin/users")).toHaveLength(1));
    const c = calls("PUT", "/admin/users")[0];
    expect(c[2]).toEqual({ status: "blocked", password: "mi-clave-larga-1" });
    expect(c[3]).toEqual({ reauth: true });
    await screen.findByTestId("users-notice");
  });

  it("DESBLOQUEAR: una cuenta bloqueada ofrece «Desbloquear» con su propia frase", async () => {
    route({ "GET /admin/users": () => page([U2]), "GET /admin/operations": () => [] });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    expect(screen.getByTestId(`status-${U2.id}`).textContent).toBe("Desbloquear");
    expect(screen.queryByTestId(`recover-${U2.id}`)).toBeNull(); // no se emite token a una cuenta bloqueada
    fireEvent.click(screen.getByTestId(`status-${U2.id}`));
    await screen.findByTestId("confirm-destructive");
    expect(screen.getByTestId("confirm-phrase").textContent).toBe("DESBLOQUEAR blas@x.es");
  });

  it("ROLES_SIN_CONTRASENA: cambiar roles pide la frase pero no una contraseña que el servidor no verifica", async () => {
    route({
      "GET /admin/users": () => page([U1]),
      "GET /admin/operations": () => [],
      "PUT /users/11111111-1111-4111-8111-111111111111/roles": () => ({}),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`roles-edit-${U1.id}`));
    fireEvent.click(screen.getByTestId(`role-${U1.id}-organizer`));
    fireEvent.click(screen.getByTestId(`roles-save-${U1.id}`));
    await screen.findByTestId("confirm-destructive");
    expect(screen.queryByTestId("confirm-password-input")).toBeNull();
    expect(screen.getByTestId("confirm-impact-summary").textContent).toMatch(/organizer/);
    fireEvent.change(screen.getByTestId("confirm-phrase-input"), { target: { value: "CAMBIAR ROLES bea@x.es" } });
    fireEvent.click(screen.getByTestId("confirm-submit"));
    await waitFor(() => expect(calls("PUT", "/users/")).toHaveLength(1));
    expect(calls("PUT", "/users/")[0][2]).toEqual({ roles: ["user", "developer", "organizer"] });
  });

  it("TOKEN_UNA_VEZ: el token se muestra tras emitirlo, con caducidad, y desaparece al ocultarlo", async () => {
    route({
      "GET /admin/users": () => page([U1]),
      "GET /admin/operations": () => [],
      "POST /admin/users/11111111-1111-4111-8111-111111111111/recovery-token": () => ({
        token: "TOKEN-SECRETO-DE-PRUEBA",
        expiresAt: "2026-11-24T12:30:00.000Z",
        userId: U1.id,
      }),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`recover-${U1.id}`));
    await screen.findByTestId("confirm-destructive");
    fireEvent.change(screen.getByTestId("confirm-phrase-input"), { target: { value: "RECUPERAR bea@x.es" } });
    fireEvent.change(screen.getByTestId("confirm-password-input"), { target: { value: "mi-clave-larga-1" } });
    fireEvent.click(screen.getByTestId("confirm-submit"));
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

  it("ADMIN_PIDE_SEGUNDO: para una cuenta admin NO emite token: solicita la aprobación de otro admin", async () => {
    route({
      "GET /admin/users": () => page([ADM]),
      "GET /admin/operations": () => [],
      "POST /admin/operations": () => ({ operation: { id: "op1" }, confirmToken: null }),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`recover-${ADM.id}`));
    await confirmWith("SOLICITAR RECUPERACION cris@x.es", "mi-clave-larga-1");
    await screen.findByTestId("users-notice");
    expect(calls("POST", "/admin/users/")).toHaveLength(0);
    const c = calls("POST", "/admin/operations")[0];
    // las órdenes user.* exigen reautenticación (revisión de #347)
    expect(c[2]).toEqual({ kind: "user.recovery_admin", params: { userId: ADM.id }, password: "mi-clave-larga-1" });
    expect(c[3]).toEqual({ reauth: true });
  });

  it("ADMIN_UNICO_CLI: con un solo administrador explica la vía local (no hay segundo admin)", async () => {
    route({
      "GET /admin/users": () => page([ADM]),
      "GET /admin/operations": () => [],
      "POST /admin/operations": () => {
        throw Object.assign(new Error("Esta acción irreversible exige un segundo administrador"), {
          status: 409,
          body: { error: "second_admin_unavailable" },
        });
      },
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`recover-${ADM.id}`));
    await confirmWith("SOLICITAR RECUPERACION cris@x.es", "mi-clave-larga-1");
    const n = await screen.findByTestId("users-notice");
    expect(n.textContent).toMatch(/reset-password/);
    expect(screen.queryByTestId("users-error")).toBeNull();
  });

  const OP = (over: Partial<RecoveryOperation>): RecoveryOperation => ({
    id: "op-1",
    kind: "user.recovery_admin",
    params: { userId: ADM.id },
    status: "awaiting_confirmation",
    confirmPhrase: "RECUPERAR ADMIN 33333333",
    requestedBy: "otro-admin",
    impact: { summary: "Emitir un token…", counts: { activeSessions: 2 } },
    ...over,
  });

  it("APROBAR: el otro administrador aprueba con la frase del SERVIDOR y su reautenticación; el solicitante no ve «Aprobar»", async () => {
    route({
      "GET /admin/users": () => page([ADM]),
      "GET /admin/operations": () => [OP({}), OP({ id: "op-2", requestedBy: ME.id })],
      "POST /admin/operations/op-1/confirm": () => ({}),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("recovery-ops");
    expect(screen.queryByTestId("approve-op-2")).toBeNull(); // la solicitud es mía
    fireEvent.click(screen.getByTestId("approve-op-1"));
    await screen.findByTestId("confirm-destructive");
    expect(screen.getByTestId("confirm-phrase").textContent).toBe("RECUPERAR ADMIN 33333333");
    expect(screen.getByTestId("confirm-second-admin")).toBeTruthy();
    fireEvent.change(screen.getByTestId("confirm-phrase-input"), { target: { value: "RECUPERAR ADMIN 33333333" } });
    fireEvent.change(screen.getByTestId("confirm-password-input"), { target: { value: "clave-del-otro-admin" } });
    fireEvent.click(screen.getByTestId("confirm-submit"));
    await waitFor(() => expect(calls("POST", "/admin/operations/op-1/confirm")).toHaveLength(1));
    const c = calls("POST", "/admin/operations/op-1/confirm")[0];
    expect(c[2]).toEqual({ phrase: "RECUPERAR ADMIN 33333333", password: "clave-del-otro-admin" });
    expect(c[3]).toEqual({ reauth: true });
  });

  it("EMITIR_ADMIN: tras la aprobación, quien la solicitó emite el token enviando el operationId", async () => {
    route({
      "GET /admin/users": () => page([ADM]),
      "GET /admin/operations": () => [OP({ status: "pending", requestedBy: ME.id })],
      "POST /admin/users/33333333-3333-4333-8333-333333333333/recovery-token": () => ({
        token: "TOKEN-ADMIN",
        expiresAt: "2026-11-24T12:30:00.000Z",
        userId: ADM.id,
      }),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("recovery-ops");
    expect(screen.queryByTestId("approve-op-1")).toBeNull();
    fireEvent.click(screen.getByTestId("issue-admin-op-1"));
    await screen.findByTestId("confirm-destructive");
    fireEvent.change(screen.getByTestId("confirm-phrase-input"), { target: { value: "EMITIR TOKEN 33333333" } });
    fireEvent.change(screen.getByTestId("confirm-password-input"), { target: { value: "mi-clave-larga-1" } });
    fireEvent.click(screen.getByTestId("confirm-submit"));
    await screen.findByTestId("recovery-token-card");
    expect(calls("POST", "/admin/users/")[0][2]).toEqual({ password: "mi-clave-larga-1", operationId: "op-1" });
  });

  it("ERROR_DEL_SERVIDOR: un rechazo de la API se muestra (no se traga) y la confirmación sigue abierta", async () => {
    route({
      "GET /admin/users": () => page([U1]),
      "GET /admin/operations": () => [],
      "PUT /admin/users/11111111-1111-4111-8111-111111111111/status": () => {
        throw Object.assign(new Error("Reautenticación requerida: contraseña inválida"), { status: 401 });
      },
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`status-${U1.id}`));
    await screen.findByTestId("confirm-destructive");
    fireEvent.change(screen.getByTestId("confirm-phrase-input"), { target: { value: "BLOQUEAR bea@x.es" } });
    fireEvent.change(screen.getByTestId("confirm-password-input"), { target: { value: "mala-contraseña-larga" } });
    fireEvent.click(screen.getByTestId("confirm-submit"));
    await screen.findByTestId("users-error");
    expect(screen.getByTestId("confirm-destructive")).toBeTruthy();
  });
});

describe("ADM-3 R1 · revisión de #347", () => {
  const ME2FA = { ...ME, twoFactorEnabled: true };

  it("NEEDS_TOTP: un admin con 2FA ve el campo TOTP y lo envía; sin 2FA no se pide", async () => {
    route({
      "GET /admin/users": () => page([U1]),
      "GET /admin/operations": () => [],
      "PUT /admin/users/11111111-1111-4111-8111-111111111111/status": () => ({ status: "blocked", changed: true }),
    });
    render(<UsersPage me={ME2FA} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`status-${U1.id}`));
    await screen.findByTestId("confirm-destructive");
    expect(screen.getByTestId("confirm-totp-input")).toBeTruthy();
    const submit = screen.getByTestId("confirm-submit") as HTMLButtonElement;
    fireEvent.change(screen.getByTestId("confirm-phrase-input"), { target: { value: "BLOQUEAR bea@x.es" } });
    fireEvent.change(screen.getByTestId("confirm-password-input"), { target: { value: "mi-clave-larga-1" } });
    expect(submit.disabled).toBe(true); // falta el código 2FA
    fireEvent.change(screen.getByTestId("confirm-totp-input"), { target: { value: "123456" } });
    fireEvent.click(submit);
    await waitFor(() => expect(calls("PUT", "/admin/users")).toHaveLength(1));
    expect(calls("PUT", "/admin/users")[0][2]).toEqual({
      status: "blocked",
      password: "mi-clave-larga-1",
      totp: "123456",
    });
  });

  it("CONCEDER_ADMIN_REAUTH: dar el rol admin pide contraseña y la envía", async () => {
    route({
      "GET /admin/users": () => page([U1]),
      "GET /admin/operations": () => [],
      "PUT /users/11111111-1111-4111-8111-111111111111/roles": () => ({}),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`roles-edit-${U1.id}`));
    fireEvent.click(screen.getByTestId(`role-${U1.id}-admin`));
    fireEvent.click(screen.getByTestId(`roles-save-${U1.id}`));
    await confirmWith("CAMBIAR ROLES bea@x.es", "mi-clave-larga-1");
    await waitFor(() => expect(calls("PUT", "/users/")).toHaveLength(1));
    const c = calls("PUT", "/users/")[0];
    expect(c[2]).toEqual({ roles: ["user", "developer", "admin"], password: "mi-clave-larga-1" });
    expect(c[3]).toEqual({ reauth: true });
  });

  it("QUITAR_ADMIN_A_OTRO_PIDE_APROBACION: quitar «admin» a otra cuenta NO hace el PUT: solicita la orden user.revoke_admin", async () => {
    route({
      "GET /admin/users": () => page([ADM]),
      "GET /admin/operations": () => [],
      "POST /admin/operations": () => ({ operation: { id: "op9" }, confirmToken: null }),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`roles-edit-${ADM.id}`));
    fireEvent.click(screen.getByTestId(`role-${ADM.id}-admin`));
    fireEvent.click(screen.getByTestId(`roles-save-${ADM.id}`));
    await confirmWith("SOLICITAR QUITAR ADMIN cris@x.es", "mi-clave-larga-1");
    await screen.findByTestId("users-notice");
    expect(calls("PUT", "/users/")).toHaveLength(0);
    expect(calls("POST", "/admin/operations")[0][2]).toEqual({
      kind: "user.revoke_admin",
      params: { userId: ADM.id },
      password: "mi-clave-larga-1",
    });
  });

  const pendingOp = (kind: string, id: string) => ({
    id,
    kind,
    params: { userId: ADM.id },
    status: "pending",
    confirmPhrase: null,
    requestedBy: ME.id,
    impact: { summary: "x", counts: {} },
  });

  it("APLICAR_QUITAR_ADMIN: usa los roles REALES del objetivo (pedidos por id, aunque no esté en la página) y envía el operationId", async () => {
    route({
      "GET /admin/users": () => page([U1]), // el objetivo NO está en la página cargada
      "GET /admin/operations": () => [pendingOp("user.revoke_admin", "op-rv")],
      "GET /admin/users/33333333-3333-4333-8333-333333333333": () => ({
        ...ADM,
        roles: ["developer", "organizer", "admin", "user"],
      }),
      "PUT /users/33333333-3333-4333-8333-333333333333/roles": () => ({}),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("recovery-ops");
    expect(screen.getByTestId("issue-admin-op-rv").textContent).toBe("Aplicar");
    fireEvent.click(screen.getByTestId("issue-admin-op-rv"));
    await confirmWith("QUITAR ADMIN 33333333", "mi-clave-larga-1");
    await waitFor(() => expect(calls("PUT", "/users/")).toHaveLength(1));
    expect(calls("PUT", "/users/")[0][2]).toEqual({
      roles: ["developer", "organizer", "user"],
      password: "mi-clave-larga-1",
      operationId: "op-rv",
    });
  });

  it("APLICAR_CONCEDER_ADMIN: añade «admin» a los roles reales y envía el operationId", async () => {
    const plain = { ...ADM, roles: ["user", "organizer"] };
    route({
      "GET /admin/users": () => page([U1]),
      "GET /admin/operations": () => [pendingOp("user.grant_admin", "op-gr")],
      "GET /admin/users/33333333-3333-4333-8333-333333333333": () => plain,
      "PUT /users/33333333-3333-4333-8333-333333333333/roles": () => ({}),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("recovery-ops");
    fireEvent.click(screen.getByTestId("issue-admin-op-gr"));
    await confirmWith("CONCEDER ADMIN 33333333", "mi-clave-larga-1");
    await waitFor(() => expect(calls("PUT", "/users/")).toHaveLength(1));
    expect(calls("PUT", "/users/")[0][2]).toEqual({
      roles: ["user", "organizer", "admin"],
      password: "mi-clave-larga-1",
      operationId: "op-gr",
    });
  });

  it("APLICAR_BLOQUEAR_ADMIN: bloquea con el operationId de la aprobación", async () => {
    route({
      "GET /admin/users": () => page([ADM]),
      "GET /admin/operations": () => [pendingOp("user.block_admin", "op-bl")],
      "PUT /admin/users/33333333-3333-4333-8333-333333333333/status": () => ({}),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("recovery-ops");
    fireEvent.click(screen.getByTestId("issue-admin-op-bl"));
    await confirmWith("BLOQUEAR ADMIN 33333333", "mi-clave-larga-1");
    await waitFor(() => expect(calls("PUT", "/admin/users/")).toHaveLength(1));
    expect(calls("PUT", "/admin/users/")[0][2]).toEqual({
      status: "blocked",
      password: "mi-clave-larga-1",
      operationId: "op-bl",
    });
  });

  it("CONCEDER_ADMIN_PIDE_APROBACION: si el servidor exige segundo admin al conceder, la web solicita user.grant_admin", async () => {
    route({
      "GET /admin/users": () => page([U1]),
      "GET /admin/operations": () => [],
      "PUT /users/11111111-1111-4111-8111-111111111111/roles": () => {
        throw Object.assign(new Error("hace falta segundo admin"), {
          status: 403,
          body: { error: "second_admin_required" },
        });
      },
      "POST /admin/operations": () => ({}),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`roles-edit-${U1.id}`));
    fireEvent.click(screen.getByTestId(`role-${U1.id}-admin`));
    fireEvent.click(screen.getByTestId(`roles-save-${U1.id}`));
    await confirmWith("CAMBIAR ROLES bea@x.es", "mi-clave-larga-1");
    await screen.findByTestId("users-notice");
    expect(calls("POST", "/admin/operations")[0][2]).toEqual({
      kind: "user.grant_admin",
      params: { userId: U1.id },
      password: "mi-clave-larga-1",
    });
    expect(screen.queryByTestId("users-error")).toBeNull();
  });

  it("BLOQUEAR_ADMIN_PIDE_APROBACION: si el servidor exige segundo admin al bloquear a un admin, la web solicita user.block_admin", async () => {
    route({
      "GET /admin/users": () => page([ADM]),
      "GET /admin/operations": () => [],
      "PUT /admin/users/33333333-3333-4333-8333-333333333333/status": () => {
        throw Object.assign(new Error("hace falta segundo admin"), {
          status: 403,
          body: { error: "second_admin_required" },
        });
      },
      "POST /admin/operations": () => ({}),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("users-table");
    fireEvent.click(screen.getByTestId(`status-${ADM.id}`));
    await confirmWith("BLOQUEAR cris@x.es", "mi-clave-larga-1");
    await screen.findByTestId("users-notice");
    expect(calls("POST", "/admin/operations")[0][2]).toEqual({
      kind: "user.block_admin",
      params: { userId: ADM.id },
      password: "mi-clave-larga-1",
    });
  });

  it("CANCELAR_CON_REAUTH: cancelar una solicitud pide confirmación y contraseña", async () => {
    route({
      "GET /admin/users": () => page([ADM]),
      "GET /admin/operations": () => [
        {
          id: "op-c",
          kind: "user.recovery_admin",
          params: { userId: ADM.id },
          status: "awaiting_confirmation",
          confirmPhrase: "RECUPERAR ADMIN 33333333",
          requestedBy: ME.id,
          impact: { summary: "x", counts: {} },
        },
      ],
      "POST /admin/operations/op-c/cancel": () => ({}),
    });
    render(<UsersPage me={ME} />);
    await screen.findByTestId("recovery-ops");
    fireEvent.click(screen.getByTestId("cancel-op-op-c"));
    expect(calls("POST", "/admin/operations/op-c/cancel")).toHaveLength(0);
    await confirmWith("CANCELAR 33333333", "mi-clave-larga-1");
    await waitFor(() => expect(calls("POST", "/admin/operations/op-c/cancel")).toHaveLength(1));
    const c = calls("POST", "/admin/operations/op-c/cancel")[0];
    expect(c[2]).toEqual({ password: "mi-clave-larga-1" });
    expect(c[3]).toEqual({ reauth: true });
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

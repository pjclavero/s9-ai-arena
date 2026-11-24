// @vitest-environment jsdom
/**
 * ACC-2FA · Pantalla «Verificación en dos pasos» de Mi cuenta y ayuda del login con código de recuperación
 * (prueba de componente con la API mockeada; el servidor real está en apps/api/src/acc-2fa.test.ts).
 * Cada test lleva una ETIQUETA en mayúsculas que usa scripts/acc-2fa-mutants.mjs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { encode } from "uqr";

vi.mock("../src/api.js", () => ({ api: vi.fn(), setToken: vi.fn() }));
import { api } from "../src/api.js";
import { TwoFactorSection, groupSecret, LOW_RECOVERY_CODES } from "../src/pages/TwoFactorSection.js";
import { LoginPage } from "../src/pages/LoginPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* jsdom sin storage */
  }
});

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const OTPAUTH = `otpauth://totp/S9%20AI%20Arena:yo%40test.local?secret=${SECRET}&issuer=S9%20AI%20Arena`;
const CODES = [
  "0a1b2c3d4e5f",
  "111111111111",
  "222222222222",
  "333333333333",
  "444444444444",
  "555555555555",
  "666666666666",
  "777777777777",
];

type Route = (method: string, path: string, body?: unknown) => unknown;

/** Mock de la API por (método, ruta); lo no previsto falla en voz alta. */
function routes(handlers: Record<string, Route>) {
  apiMock.mockImplementation(async (method: string, path: string, body?: unknown) => {
    const h = handlers[`${method} ${path}`];
    if (!h) throw new Error(`llamada no prevista: ${method} ${path}`);
    return h(method, path, body);
  });
}

const meOff = () => ({ id: "u", displayName: "Yo", email: "yo@test.local", roles: ["user"], twoFactorEnabled: false });
const meOn = (n: number) => () => ({ ...meOff(), twoFactorEnabled: true, recoveryCodesRemaining: n });
const calls = (method: string, path: string) => apiMock.mock.calls.filter((c) => c[0] === method && c[1] === path);

async function startEnrollment() {
  routes({
    "GET /users/me": meOff,
    "POST /auth/2fa/setup": () => ({ otpauthUrl: OTPAUTH, secret: SECRET, enrollmentToken: "tok-1", expiresIn: 600 }),
    "POST /auth/2fa/confirm": () => ({ recoveryCodes: CODES }),
  });
  render(<TwoFactorSection />);
  fireEvent.click(await screen.findByRole("button", { name: "Activar la verificación en dos pasos" }));
  await screen.findByTestId("totp-qr");
}

describe("ACC-2FA · estado", () => {
  it("W_ESTADO: desactivada ⇒ lo dice y ofrece activar; activada ⇒ dice cuántos códigos quedan", async () => {
    routes({ "GET /users/me": meOff });
    render(<TwoFactorSection />);
    expect((await screen.findByTestId("twofa-status")).textContent).toContain("desactivada");
    cleanup();
    routes({ "GET /users/me": meOn(6) });
    render(<TwoFactorSection />);
    const st = await screen.findByTestId("twofa-status");
    expect(st.textContent).toContain("activada");
    expect(st.textContent).toContain("6");
  });

  it("W_POCOS_CODIGOS: con menos de 3 códigos avisa; con 3 no", async () => {
    expect(LOW_RECOVERY_CODES).toBe(3);
    routes({ "GET /users/me": meOn(2) });
    render(<TwoFactorSection />);
    await screen.findByTestId("twofa-low-codes");
    cleanup();
    routes({ "GET /users/me": meOn(3) });
    render(<TwoFactorSection />);
    await screen.findByTestId("twofa-status");
    expect(screen.queryByTestId("twofa-low-codes")).toBeNull();
  });
});

describe("ACC-2FA · activar", () => {
  it("W_QR_Y_SECRETO: el QR codifica EXACTAMENTE el enlace otpauth y la clave se ve agrupada; aún sin confirmar", async () => {
    await startEnrollment();
    const qr = encode(OTPAUTH, { ecc: "M", border: 2 });
    const svg = screen.getByTestId("totp-qr");
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${qr.size} ${qr.size}`);
    const d = svg.querySelector("path")!.getAttribute("d")!;
    const expected: string[] = [];
    qr.data.forEach((row, y) => row.forEach((dark, x) => dark && expected.push(`M${x} ${y}h1v1h-1z`)));
    expect(d).toBe(expected.join(""));
    expect(screen.getByTestId("totp-secret").textContent).toBe(groupSecret(SECRET));
    expect(groupSecret("ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
    expect(calls("POST", "/auth/2fa/confirm")).toHaveLength(0);
  });

  it("W_CONFIRMA: envía el token y el código sin espacios; muestra los códigos UNA vez y exige «Los he guardado»", async () => {
    await startEnrollment();
    fireEvent.change(screen.getByLabelText("código de confirmación"), { target: { value: " 123 456 " } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await screen.findByTestId("recovery-codes");
    expect(calls("POST", "/auth/2fa/confirm")[0][2]).toEqual({ enrollmentToken: "tok-1", totp: "123456" });
    for (const c of CODES) expect(screen.getByText(c)).toBeTruthy();
    const done = screen.getByRole("button", { name: "Hecho" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Los he guardado"));
    expect(done.disabled).toBe(false);
    fireEvent.click(done);
    expect((await screen.findByTestId("twofa-status")).textContent).toContain("activada");
    expect(screen.queryByTestId("recovery-codes")).toBeNull();
    for (const c of CODES) expect(document.body.textContent).not.toContain(c);
  });

  it("W_NO_PERSISTE: ni el secreto ni los códigos van a localStorage, sessionStorage o la URL", async () => {
    await startEnrollment();
    fireEvent.change(screen.getByLabelText("código de confirmación"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await screen.findByTestId("recovery-codes");
    const dump = (st: Storage) =>
      Array.from({ length: st.length }, (_, i) => `${st.key(i)}=${st.getItem(st.key(i)!)}`).join("|");
    const all = `${dump(localStorage)}|${dump(sessionStorage)}|${window.location.href}`;
    expect(all).not.toContain(SECRET);
    for (const c of CODES) expect(all).not.toContain(c);
  });

  it("W_CODIGO_LOCAL: un código que no son 6 cifras no llega a la API", async () => {
    await startEnrollment();
    fireEvent.change(screen.getByLabelText("código de confirmación"), { target: { value: "12a" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect((await screen.findByTestId("twofa-error")).textContent).toContain("6 cifras");
    expect(calls("POST", "/auth/2fa/confirm")).toHaveLength(0);
  });

  it("W_CONFIRMA_ERRORES: 401 explica la hora; 429 el bloqueo; 400 (caducado) vuelve al inicio", async () => {
    await startEnrollment();
    const fail = (status: number) =>
      apiMock.mockImplementationOnce(async () => {
        throw Object.assign(new Error("x"), { status });
      });
    const send = () => {
      fireEvent.change(screen.getByLabelText("código de confirmación"), { target: { value: "123456" } });
      fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    };
    fail(401);
    send();
    await waitFor(() => expect(screen.getByTestId("twofa-error").textContent).toContain("hora del móvil"));
    fail(429);
    send();
    await waitFor(() => expect(screen.getByTestId("twofa-error").textContent).toContain("15 minutos"));
    fail(400);
    send();
    await waitFor(() => expect(screen.getByTestId("twofa-error").textContent).toContain("caducado"));
    expect(screen.getByRole("button", { name: "Activar la verificación en dos pasos" })).toBeTruthy();
  });

  it("W_CANCELAR: cancelar el alta no llama a nada más y la deja desactivada", async () => {
    await startEnrollment();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.getByTestId("twofa-status").textContent).toContain("desactivada");
    expect(screen.queryByTestId("totp-qr")).toBeNull();
    expect(calls("POST", "/auth/2fa/confirm")).toHaveLength(0);
  });
});

describe("ACC-2FA · regenerar y desactivar", () => {
  function fillReauth(password: string, code: string) {
    fireEvent.change(screen.getByLabelText("2fa contraseña"), { target: { value: password } });
    fireEvent.change(screen.getByLabelText("2fa código"), { target: { value: code } });
  }

  it("W_REGENERA: pide contraseña + código, llama a recovery-codes y muestra los nuevos una vez", async () => {
    routes({ "GET /users/me": meOn(1), "POST /auth/2fa/recovery-codes": () => ({ recoveryCodes: CODES }) });
    render(<TwoFactorSection />);
    await screen.findByTestId("twofa-status");
    fireEvent.click(screen.getByRole("button", { name: "Regenerar los códigos" }));
    expect((await screen.findByTestId("twofa-error")).textContent).toContain("contraseña");
    expect(calls("POST", "/auth/2fa/recovery-codes")).toHaveLength(0);
    fillReauth("mi-contraseña-larga", " 654321 ");
    fireEvent.click(screen.getByRole("button", { name: "Regenerar los códigos" }));
    await screen.findByTestId("recovery-codes");
    expect(calls("POST", "/auth/2fa/recovery-codes")[0][2]).toEqual({
      password: "mi-contraseña-larga",
      totp: "654321",
    });
    expect(screen.getByTestId("recovery-codes").textContent).toContain("anteriores ya no sirven");
    fireEvent.click(screen.getByLabelText("Los he guardado"));
    fireEvent.click(screen.getByRole("button", { name: "Hecho" }));
    expect((await screen.findByTestId("twofa-status")).textContent).toContain("8");
    expect(screen.queryByTestId("twofa-low-codes")).toBeNull();
  });

  it("W_DESACTIVA: DELETE /auth/2fa con contraseña + código; queda desactivada", async () => {
    routes({ "GET /users/me": meOn(8), "DELETE /auth/2fa": () => undefined });
    render(<TwoFactorSection />);
    await screen.findByTestId("twofa-status");
    fillReauth("mi-contraseña-larga", "0a1b2c3d4e5f");
    fireEvent.click(screen.getByRole("button", { name: "Desactivar la verificación en dos pasos" }));
    expect((await screen.findByTestId("twofa-done")).textContent).toContain("desactivada");
    expect(calls("DELETE", "/auth/2fa")[0][2]).toEqual({ password: "mi-contraseña-larga", totp: "0a1b2c3d4e5f" });
    expect(screen.getByTestId("twofa-status").textContent).toContain("desactivada");
  });

  it("W_REAUTH_401: credenciales malas ⇒ mensaje claro y el código se borra del campo", async () => {
    routes({
      "GET /users/me": meOn(8),
      "DELETE /auth/2fa": () => {
        throw Object.assign(new Error("Reautenticación requerida"), { status: 401 });
      },
    });
    render(<TwoFactorSection />);
    await screen.findByTestId("twofa-status");
    fillReauth("mala", "000000");
    fireEvent.click(screen.getByRole("button", { name: "Desactivar la verificación en dos pasos" }));
    expect((await screen.findByTestId("twofa-error")).textContent).toContain("no son correctos");
    expect((screen.getByLabelText("2fa código") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("twofa-status").textContent).toContain("activada");
  });
});

describe("ACC-2FA · ayuda y login con código de recuperación", () => {
  it("W_AYUDA: la sección explica cómo entrar con un código de recuperación", async () => {
    routes({ "GET /users/me": meOff });
    render(<TwoFactorSection />);
    const help = await screen.findByTestId("twofa-help");
    expect(help.textContent).toContain("códigos de recuperación");
    expect(help.textContent).toContain("Iniciar sesión");
  });

  it("W_LOGIN_RECUPERACION: el login acepta letras en el código y lo envía recortado como `totp`", async () => {
    let n = 0;
    apiMock.mockImplementation(async (_m: string, path: string, body?: { totp?: string }) => {
      if (path === "/auth/login") {
        n++;
        if (!body?.totp)
          throw Object.assign(new Error("Se requiere un código TOTP válido (2FA activo)"), { status: 401 });
        return { accessToken: "a" };
      }
      if (path === "/users/me") return meOn(7)();
      throw new Error(`llamada no prevista ${path}`);
    });
    const onLogin = vi.fn();
    render(<LoginPage onLogin={onLogin} />);
    fireEvent.change(screen.getByLabelText("email"), { target: { value: "yo@test.local" } });
    fireEvent.change(screen.getByLabelText("contraseña"), { target: { value: "mi-contraseña-larga" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    const field = (await screen.findByLabelText("totp")) as HTMLInputElement;
    // un código de recuperación lleva letras: el campo no puede forzar el teclado numérico
    expect(field.getAttribute("inputmode")).toBeNull();
    expect(document.getElementById("hint-totp")!.textContent).toContain("códigos de recuperación");
    fireEvent.change(field, { target: { value: "  0A1B-2C3D 4E5F " } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(onLogin).toHaveBeenCalled());
    const last = apiMock.mock.calls.filter((c) => c[1] === "/auth/login").at(-1)!;
    expect(last[2]).toMatchObject({ totp: "0A1B-2C3D 4E5F" });
    expect(n).toBe(2);
  });
});

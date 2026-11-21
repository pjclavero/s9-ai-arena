// @vitest-environment jsdom
/**
 * V1-B · Mi cuenta: cambio de contraseña (prueba de componente con la API mockeada; el
 * comportamiento real del servidor está en apps/api/src/v1b-password-change.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../src/api.js", () => ({ api: vi.fn() }));
import { api } from "../src/api.js";
import { AccountPage, validatePasswordChange } from "../src/pages/AccountPage.js";
import { matchStaticPanelRoute } from "../src/App.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

function fill(current: string, next: string, confirm: string, totp = "") {
  fireEvent.change(screen.getByLabelText("contraseña actual"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("contraseña nueva"), { target: { value: next } });
  fireEvent.change(screen.getByLabelText("repite la contraseña nueva"), { target: { value: confirm } });
  if (totp) fireEvent.change(screen.getByLabelText("totp"), { target: { value: totp } });
}
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Cambiar la contraseña" }));

describe("V1-B · AccountPage", () => {
  it("la ruta #/account está registrada", () => {
    expect(matchStaticPanelRoute("#/account")).toBe("account");
    expect(matchStaticPanelRoute("#/accountX")).toBeNull();
  });

  it("validación local: actual obligatoria, ≥12, distinta y confirmación igual", () => {
    expect(validatePasswordChange({ current: "", next: "x".repeat(12), confirm: "x".repeat(12) })?.field).toBe(
      "current",
    );
    expect(validatePasswordChange({ current: "a", next: "corta", confirm: "corta" })?.field).toBe("next");
    expect(
      validatePasswordChange({ current: "x".repeat(12), next: "x".repeat(12), confirm: "x".repeat(12) })?.field,
    ).toBe("next");
    expect(validatePasswordChange({ current: "a", next: "y".repeat(12), confirm: "z".repeat(12) })?.field).toBe(
      "confirm",
    );
    expect(validatePasswordChange({ current: "a", next: "y".repeat(12), confirm: "y".repeat(12) })).toBeNull();
  });

  it("con datos inválidos NO llama a la API y avisa", async () => {
    render(<AccountPage />);
    fill("vieja-contraseña-1", "corta", "corta");
    submit();
    const err = await screen.findByTestId("account-error");
    expect(err.textContent).toContain("al menos 12");
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("envía POST /auth/password (con TOTP si se escribe), confirma y limpia los campos", async () => {
    apiMock.mockResolvedValue(undefined);
    render(<AccountPage />);
    fill("vieja-contraseña-1", "nueva-contraseña-2", "nueva-contraseña-2", "123456");
    submit();
    await screen.findByTestId("account-done");
    expect(apiMock).toHaveBeenCalledWith("POST", "/auth/password", {
      currentPassword: "vieja-contraseña-1",
      newPassword: "nueva-contraseña-2",
      totp: "123456",
    });
    expect((screen.getByLabelText("contraseña actual") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("contraseña nueva") as HTMLInputElement).value).toBe("");
  });

  it("sin TOTP no manda el campo", async () => {
    apiMock.mockResolvedValue(undefined);
    render(<AccountPage />);
    fill("vieja-contraseña-1", "nueva-contraseña-2", "nueva-contraseña-2");
    submit();
    await screen.findByTestId("account-done");
    expect(apiMock.mock.calls[0][2]).toEqual({
      currentPassword: "vieja-contraseña-1",
      newPassword: "nueva-contraseña-2",
    });
  });

  it("un 401 del servidor (contraseña actual mala) se muestra y NO confirma el cambio", async () => {
    apiMock.mockRejectedValue(
      Object.assign(new Error("Reautenticación requerida: contraseña inválida"), { status: 401 }),
    );
    render(<AccountPage />);
    fill("incorrecta-contraseña", "nueva-contraseña-2", "nueva-contraseña-2");
    submit();
    const err = await screen.findByTestId("account-error");
    expect(err.textContent).toContain("contraseña inválida");
    expect(screen.queryByTestId("account-done")).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("contraseña actual").getAttribute("aria-invalid")).toBe("true"));
  });

  it("un 429 explica el bloqueo temporal", async () => {
    apiMock.mockRejectedValue(
      Object.assign(new Error("Demasiados intentos fallidos: bloqueo temporal"), { status: 429 }),
    );
    render(<AccountPage />);
    fill("incorrecta-contraseña", "nueva-contraseña-2", "nueva-contraseña-2");
    submit();
    const err = await screen.findByTestId("account-error");
    expect(err.textContent).toMatch(/espera unos minutos/);
  });
});

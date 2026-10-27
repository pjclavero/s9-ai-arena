// @vitest-environment jsdom
/**
 * UX-F (DEF-R11) · el visor en directo dice «no existe» SIN esperar a que arranque
 * Phaser. Antes el pase de espectador se pedía cuando la escena estaba lista (~5 s
 * en un navegador sin GPU) y la matriz de estados leía el error antes de que
 * apareciera. Aquí Phaser NO arranca nunca (la escena no llega): si el rechazo
 * depende de él, el visor se queda en «inicializando…» y el test se pone rojo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ApiRequestError } from "../src/errors.js";

const apiMock = vi.fn();
vi.mock("../src/api.js", () => ({ api: (...a: unknown[]) => apiMock(...a) }));
vi.mock("../src/viewer/PhaserViewer.js", () => ({
  createViewerGame: () => ({ destroy: () => undefined }),
  waitForViewerScene: () => new Promise(() => undefined), // nunca arranca
}));

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("DEF-R11 · rechazo del pase antes de que Phaser esté listo", () => {
  it("404 al pedir el pase ⇒ alerta «no existe» con enlace al replay, sin Phaser", async () => {
    apiMock.mockRejectedValue(new ApiRequestError(404, { message: "Batalla no encontrada" }));
    const { ViewerPage } = await import("../src/pages/ViewerPage.js");
    render(<ViewerPage battleId="00000000-0000-0000-0000-000000000000" />);
    const status = await screen.findByRole("alert", {}, { timeout: 1_000 });
    expect(status.getAttribute("data-state")).toBe("rejected");
    expect(status.textContent).toContain("no existe");
    expect(screen.getByTestId("viewer-replay-link")).toBeTruthy();
    // Una sola petición: el pase no se pide dos veces.
    expect(apiMock.mock.calls.filter((c) => c[0] === "POST")).toHaveLength(1);
  });

  it("un fallo pasajero (500) no se da por definitivo antes de tiempo", async () => {
    apiMock.mockRejectedValue(new ApiRequestError(500, { message: "Error interno" }));
    const { ViewerPage } = await import("../src/pages/ViewerPage.js");
    render(<ViewerPage battleId="btl_x" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("viewer-status").getAttribute("data-state")).toBe("init");
  });
});

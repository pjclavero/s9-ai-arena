/**
 * MG · «Acceso público / Broadcast» en Administración: la UI refleja el estado REAL que
 * devuelve la API (no el valor pedido), muestra el motivo cuando no se puede retransmitir
 * y cambia los ajustes con PATCH de booleanos.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../src/api.js", () => ({ api: vi.fn() }));

import { api } from "../src/api.js";
import { PublicAccessSettings, type PublicAccessSettingsView } from "../src/pages/PublicAccessSettings.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;

function view(spectate: boolean, replays: boolean, streamer = true): PublicAccessSettingsView {
  const reason = !spectate ? "public_spectate_disabled" : !streamer ? "streaming_not_configured" : null;
  return {
    publicSpectateEnabled: spectate,
    publicReplaysEnabled: replays,
    source: "database",
    updatedAt: "2026-11-11T10:00:00.000Z",
    updatedBy: null,
    propagationMaxMs: 5000,
    effective: { publicSpectate: spectate, publicReplays: replays, broadcastLiveAvailable: reason === null, reason },
  };
}

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

const box = (k: string) => screen.getByTestId(`toggle-${k}`) as HTMLInputElement;

describe("MG · PublicAccessSettings refleja el estado real", () => {
  it("espectador apagado: interruptores en su valor real, estado efectivo NO disponible y motivo", async () => {
    apiMock.mockResolvedValueOnce(view(false, true));
    render(<PublicAccessSettings />);
    const eff = await screen.findByTestId("public-access-effective");
    expect(apiMock).toHaveBeenCalledWith("GET", "/admin/settings/public-access");
    expect(box("publicSpectateEnabled").checked).toBe(false);
    expect(box("publicReplaysEnabled").checked).toBe(true);
    expect(eff.getAttribute("data-available")).toBe("0");
    expect(eff.getAttribute("data-reason")).toBe("public_spectate_disabled");
    expect(eff.textContent).toMatch(/espectador público está desactivado/);
    expect(screen.getByTestId("public-access-meta").textContent).toMatch(/≤ 5 s, sin reiniciar/);
  });

  it("activar el espectador envía PATCH con un booleano y pinta la RESPUESTA (disponible)", async () => {
    apiMock.mockResolvedValueOnce(view(false, false)).mockResolvedValueOnce(view(true, false));
    render(<PublicAccessSettings />);
    await screen.findByTestId("public-access-effective");
    fireEvent.click(box("publicSpectateEnabled"));
    await waitFor(() => expect(screen.getByTestId("public-access-effective").getAttribute("data-available")).toBe("1"));
    expect(apiMock).toHaveBeenLastCalledWith("PATCH", "/admin/settings/public-access", {
      publicSpectateEnabled: true,
    });
    expect(box("publicSpectateEnabled").checked).toBe(true);
    expect(screen.getByTestId("public-access-effective").textContent).toMatch(/puede retransmitir/);
  });

  it("si la API guarda otra cosa (o falla), la UI muestra lo GUARDADO, no lo pedido", async () => {
    // El servidor devuelve el espectador aún apagado (p. ej. otro admin lo cambió a la vez).
    apiMock.mockResolvedValueOnce(view(false, false)).mockResolvedValueOnce(view(false, false));
    render(<PublicAccessSettings />);
    await screen.findByTestId("public-access-effective");
    fireEvent.click(box("publicSpectateEnabled"));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(box("publicSpectateEnabled").checked).toBe(false));
    expect(screen.getByTestId("public-access-effective").getAttribute("data-available")).toBe("0");

    cleanup();
    apiMock.mockReset();
    apiMock
      .mockResolvedValueOnce(view(false, false))
      .mockRejectedValueOnce(Object.assign(new Error("Rol insuficiente"), { status: 403, body: {} }))
      .mockResolvedValueOnce(view(false, false));
    render(<PublicAccessSettings />);
    await screen.findByTestId("public-access-effective");
    fireEvent.click(box("publicSpectateEnabled"));
    expect(await screen.findByTestId("public-access-error")).toBeTruthy();
    await waitFor(() => expect(box("publicSpectateEnabled").checked).toBe(false));
  });

  it("espectador encendido sin streamer: no disponible con «streaming no configurado»", async () => {
    apiMock.mockResolvedValueOnce(view(true, false, false));
    render(<PublicAccessSettings />);
    const eff = await screen.findByTestId("public-access-effective");
    expect(eff.getAttribute("data-reason")).toBe("streaming_not_configured");
    expect(eff.textContent).toMatch(/No hay servicio de streaming configurado/);
  });
});

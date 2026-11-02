// @vitest-environment jsdom
/**
 * EQ6 · revisión independiente de #207 · el ⓘ dentro de un <label> no debe cambiar el control.
 *
 * InfoTip declara que se puede poner DENTRO de un <label>. El panel se monta dentro del
 * propio ⓘ, así que también queda dentro del <label>. En Chromium real (Playwright
 * 1.48.2, réplica exacta del DOM del ⓘ abierto) un clic en el TEXTO o en el TÍTULO del
 * panel activa el <label> y ALTERNA la casilla asociada: leer la ayuda cambia el
 * formulario. (El botón ⓘ y la X no: son contenido interactivo).
 *
 * jsdom no reproduce la activación del <label> en este caso, así que la prueba exige la
 * propiedad que la evita en cualquier navegador: o el panel NO está dentro del <label>
 * (p. ej. un portal), o el clic en su contenido no interactivo cancela la acción por
 * defecto (y entonces el enlace «Más en el Centro de Ayuda» debe seguir navegando).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InfoTip } from "../src/help/InfoTip.js";

afterEach(cleanup);

function setup() {
  render(
    <form>
      <label>
        <input type="checkbox" data-testid="ff" />
        Fuego amigo{" "}
        <InfoTip topic="Fuego amigo" testId="tip-ff" helpHref="#/help/modos/deathmatch">
          Si está activo, tus disparos también hieren a tu equipo.
        </InfoTip>
      </label>
    </form>,
  );
  fireEvent.click(screen.getByTestId("tip-ff-trigger"));
  return screen.getByTestId("tip-ff-panel");
}

describe("EQ6 · #207 · ⓘ dentro de un <label>", () => {
  it("un clic en el texto o el título del panel no puede llegar a activar el <label>", () => {
    const panel = setup();
    const insideLabel = panel.closest("label") !== null;
    for (const el of [
      screen.getByText("Si está activo, tus disparos también hieren a tu equipo."),
      panel.querySelector(".infotip-title")!,
    ]) {
      const notCancelled = fireEvent.click(el);
      expect(
        insideLabel && notCancelled,
        "el panel está dentro del <label> y el clic en su texto no se cancela: el navegador alterna la casilla",
      ).toBe(false);
    }
  });

  it("el enlace a la ayuda completa sigue navegando (no se cancela su clic)", () => {
    setup();
    const link = screen.getByRole("link", { name: "Más en el Centro de Ayuda" });
    expect(fireEvent.click(link)).toBe(true);
  });
});

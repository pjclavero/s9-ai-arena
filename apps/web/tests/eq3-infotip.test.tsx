// @vitest-environment jsdom
/**
 * EQ3 · Componente «ⓘ» (apps/web/src/help/InfoTip.tsx). Cada bloque se pone
 * ROJO si se rompe el requisito del encargo que lleva en el nombre:
 *  - abre un popover (role=dialog no modal) con nombre accesible;
 *  - se cierra con la X y con Escape y devuelve el foco al ⓘ;
 *  - no pierde el estado del formulario ni lo envía;
 *  - Escape no se propaga al contenedor (no cierra el diálogo/editor padre);
 *  - teclado (Tab fuera cierra) y clic fuera cierra sin bloquear la pantalla;
 *  - varios ⓘ en la misma pantalla tienen ids distintos.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { InfoTip, INFOTIP_CSS } from "../src/help/InfoTip.js";

afterEach(cleanup);

describe("EQ3 InfoTip · apertura y accesibilidad", () => {
  it("cerrado al montar: botón con nombre accesible, aria-expanded=false y sin panel", () => {
    render(<InfoTip topic="Torreta principal">Gira el arma con independencia del chasis.</InfoTip>);
    const btn = screen.getByRole("button", { name: "Ayuda: Torreta principal" });
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("al pulsar se abre un diálogo NO modal titulado con el tema y el foco pasa al panel", () => {
    render(<InfoTip topic="V-D-E">Victorias - Derrotas - Empates.</InfoTip>);
    const btn = screen.getByTestId("infotip-trigger");
    fireEvent.click(btn);
    const dlg = screen.getByRole("dialog", { name: "V-D-E" });
    expect(dlg.getAttribute("aria-modal")).toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.getAttribute("aria-controls")).toBe(dlg.id);
    expect(dlg.textContent).toContain("Victorias - Derrotas - Empates.");
    expect(document.activeElement).toBe(dlg);
  });

  it("enlace opcional a la sección del Centro de Ayuda (ruta local, no externa)", () => {
    render(
      <InfoTip topic="Control de zona" helpHref="#/help/modos/zone_control" defaultOpen>
        Sólo puntúa quien controla la zona en solitario.
      </InfoTip>,
    );
    const a = screen.getByRole("link", { name: "Más en el Centro de Ayuda" });
    expect(a.getAttribute("href")).toBe("#/help/modos/zone_control");
    expect(a.getAttribute("target")).toBeNull();
  });

  it("dos ⓘ en la misma pantalla: ids de panel distintos y sólo uno abierto a la vez", () => {
    render(
      <>
        <InfoTip topic="A" testId="a">
          a
        </InfoTip>
        <InfoTip topic="B" testId="b">
          b
        </InfoTip>
      </>,
    );
    const bTrigger = screen.getByTestId("b-trigger");
    fireEvent.click(screen.getByTestId("a-trigger"));
    const idA = screen.getByRole("dialog", { name: "A" }).id;
    // Abrir B (puntero + foco fuera de A) cierra A.
    fireEvent.pointerDown(bTrigger);
    fireEvent.click(bTrigger);
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs.map((d) => d.getAttribute("aria-labelledby") && d.textContent?.slice(0, 1))).toEqual(["B"]);
    expect(dialogs[0].id).not.toBe(idA);
  });

  it("los estilos se inyectan una sola vez y traen el objetivo táctil de 44 px y la hoja inferior en móvil", () => {
    render(
      <>
        <InfoTip topic="A">a</InfoTip>
        <InfoTip topic="B">b</InfoTip>
      </>,
    );
    expect(document.querySelectorAll("#s9-infotip-styles").length).toBe(1);
    expect(INFOTIP_CSS).toMatch(/min-width: 44px; min-height: 44px/);
    expect(INFOTIP_CSS).toMatch(/@media \(max-width: 720px\)[\s\S]*position: fixed/);
  });
});

describe("EQ3 InfoTip · cierre", () => {
  it("la X cierra y devuelve el foco al ⓘ", () => {
    render(<InfoTip topic="Respawns">Reapariciones.</InfoTip>);
    const btn = screen.getByTestId("infotip-trigger");
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar ayuda" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape cierra, devuelve el foco y NO se propaga al contenedor", () => {
    const parentEsc = vi.fn();
    render(
      <div
        onKeyDown={(e) => {
          if (e.key === "Escape") parentEsc();
        }}
      >
        <InfoTip topic="Rating">Elo.</InfoTip>
      </div>,
    );
    const btn = screen.getByTestId("infotip-trigger");
    fireEvent.click(btn);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(btn);
    expect(parentEsc).not.toHaveBeenCalled();
    // Con el ⓘ ya cerrado, Escape sí llega al contenedor (no se lo traga siempre).
    fireEvent.keyDown(btn, { key: "Escape" });
    expect(parentEsc).toHaveBeenCalledTimes(1);
  });

  it("pulsar de nuevo el ⓘ lo cierra (alterna)", () => {
    render(<InfoTip topic="Modo">m</InfoTip>);
    const btn = screen.getByTestId("infotip-trigger");
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pulsar fuera lo cierra y no hay fondo que bloquee la pantalla", () => {
    render(
      <>
        <button type="button">otra cosa</button>
        <InfoTip topic="Mapa">m</InfoTip>
      </>,
    );
    fireEvent.click(screen.getByTestId("infotip-trigger"));
    // Sin backdrop: nada fuera del ⓘ cubre la página.
    expect(document.querySelector(".infotip-backdrop, [aria-modal='true']")).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "otra cosa" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pulsar DENTRO del panel no lo cierra", () => {
    render(<InfoTip topic="Mapa">texto del panel</InfoTip>);
    fireEvent.click(screen.getByTestId("infotip-trigger"));
    fireEvent.pointerDown(screen.getByText("texto del panel"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("Tab fuera del ⓘ (foco a otro control) lo cierra", () => {
    render(
      <>
        <InfoTip topic="Slot">s</InfoTip>
        <input aria-label="siguiente" />
      </>,
    );
    fireEvent.click(screen.getByTestId("infotip-trigger"));
    const dlg = screen.getByRole("dialog");
    const next = screen.getByLabelText("siguiente");
    fireEvent.blur(dlg, { relatedTarget: next });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("EQ3 InfoTip · foco perdido (EQ6-P3)", () => {
  it("Tab desde la X siendo el último enfocable (foco a <body>, relatedTarget null) cierra el panel", async () => {
    render(<InfoTip topic="Último">u</InfoTip>);
    fireEvent.click(screen.getByTestId("infotip-trigger"));
    const close = screen.getByRole("button", { name: "Cerrar ayuda" });
    close.focus();
    close.blur(); // el foco cae en <body>
    fireEvent.blur(close, { relatedTarget: null });
    await new Promise((r) => setTimeout(r, 5));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("blur sin relatedTarget pero con el foco aún dentro (la ventana perdió el foco) NO cierra", async () => {
    render(<InfoTip topic="Ventana">v</InfoTip>);
    fireEvent.click(screen.getByTestId("infotip-trigger"));
    const dlg = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dlg);
    fireEvent.blur(dlg, { relatedTarget: null });
    await new Promise((r) => setTimeout(r, 5));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("Escape con el foco fuera del ⓘ (en <body>) también lo cierra", () => {
    render(<InfoTip topic="Esc">e</InfoTip>);
    fireEvent.click(screen.getByTestId("infotip-trigger"));
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("EQ3 InfoTip · formularios", () => {
  function Form(props: { onSubmit: () => void }) {
    const [name, setName] = useState("");
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit();
        }}
      >
        <label>
          Nombre del bot <InfoTip topic="Nombre">Visible para todos.</InfoTip>
          <input aria-label="nombre" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit">Guardar</button>
      </form>
    );
  }

  it("abrir/cerrar el ⓘ dentro de un <form> y de un <label> no envía el formulario ni borra lo escrito", () => {
    const onSubmit = vi.fn();
    render(<Form onSubmit={onSubmit} />);
    const input = screen.getByLabelText("nombre") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Tanque-1" } });
    const btn = screen.getByTestId("infotip-trigger");
    fireEvent.click(btn);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar ayuda" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect((screen.getByLabelText("nombre") as HTMLInputElement).value).toBe("Tanque-1");
    // Control: el envío real del formulario sí funciona (el test no es ciego).
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("dentro de un <p> o un <label> no anida bloques (todo el marcado es de frase)", () => {
    render(
      <p>
        Texto{" "}
        <InfoTip topic="X" defaultOpen>
          y
        </InfoTip>
      </p>,
    );
    const root = screen.getByTestId("infotip");
    expect(root.querySelectorAll("div, p, ul, ol, section, h1, h2, h3, h4").length).toBe(0);
  });
});

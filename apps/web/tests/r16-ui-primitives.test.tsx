// @vitest-environment jsdom
/**
 * R16 · Tests reales de las primitivas visuales (apps/web/src/ui/primitives.tsx),
 * probadas EN AISLAMIENTO. Su uso real dentro de las páginas se prueba aparte,
 * en r16-pages-primitives.test.tsx.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Panel, StatusBadge, LoadingState, ErrorState, EmptyState, Button } from "../src/ui/primitives.js";

afterEach(() => {
  cleanup();
});

describe("Panel", () => {
  it("envuelve el contenido en .card", () => {
    render(<Panel data-testid="p1">contenido</Panel>);
    const el = screen.getByTestId("p1");
    expect(el.className).toBe("card");
    expect(el.textContent).toBe("contenido");
  });
});

describe("StatusBadge", () => {
  it.each([
    ["ok", "ok"],
    ["warn", "warn"],
    ["error", "error"],
  ] as const)("variant=%s aplica la clase %s", (variant, cls) => {
    render(<StatusBadge variant={variant}>texto de estado</StatusBadge>);
    const el = screen.getByText("texto de estado");
    expect(el.className).toBe(cls);
  });

  it("variant=neutral no aplica ninguna clase de color", () => {
    render(<StatusBadge variant="neutral">sin color</StatusBadge>);
    const el = screen.getByText("sin color");
    expect(el.className).toBe("");
  });

  it("el texto es siempre visible (el color nunca es el único canal)", () => {
    render(<StatusBadge variant="error">fallo de validación</StatusBadge>);
    expect(screen.getByText("fallo de validación")).toBeTruthy();
  });
});

describe("LoadingState", () => {
  it("anuncia el estado con role=status y aria-live=polite", () => {
    render(<LoadingState label="los mapas" />);
    const el = screen.getByRole("status");
    expect(el.textContent).toContain("Cargando los mapas…");
    expect(el.getAttribute("aria-live")).toBe("polite");
  });
});

describe("ErrorState", () => {
  it("anuncia el fallo con role=alert y expone un botón Reintentar operable", () => {
    const onRetry = vi.fn();
    render(<ErrorState label="los mapas" message="500" onRetry={onRetry} />);
    const alertEl = screen.getByRole("alert");
    expect(alertEl.textContent).toContain("No se pudo cargar los mapas: 500");
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("genera el mismo patrón de data-testid que resource.tsx (label sin espacios)", () => {
    render(<ErrorState label="el catálogo" message="x" onRetry={() => {}} />);
    expect(screen.getByTestId("resource-error-el-catálogo")).toBeTruthy();
  });
});

describe("EmptyState", () => {
  it("muestra el mensaje y, si se pasa, la acción", () => {
    render(<EmptyState message="No hay mapas todavía." action={<button>Crear mapa</button>} data-testid="empty1" />);
    expect(screen.getByText("No hay mapas todavía.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Crear mapa" })).toBeTruthy();
  });

  it("funciona sin acción", () => {
    render(<EmptyState message="No hay eventos de auditoría todavía." />);
    expect(screen.getByText("No hay eventos de auditoría todavía.")).toBeTruthy();
  });
});

describe("Button", () => {
  it("por defecto es type=button (nunca submit implícito)", () => {
    render(<Button>Guardar</Button>);
    const el = screen.getByRole("button", { name: "Guardar" }) as HTMLButtonElement;
    expect(el.type).toBe("button");
  });

  it("dispara onClick y respeta disabled", () => {
    const onClick = vi.fn();
    render(
      <>
        <Button onClick={onClick} data-testid="btn-ok">
          Ok
        </Button>
        <Button disabled data-testid="btn-disabled">
          No
        </Button>
      </>,
    );
    fireEvent.click(screen.getByTestId("btn-ok"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId("btn-disabled") as HTMLButtonElement).disabled).toBe(true);
  });

  it("variant=link aplica la clase .link (index.html:83-91)", () => {
    render(<Button variant="link">enlace</Button>);
    expect(screen.getByRole("button", { name: "enlace" }).className).toBe("link");
  });
});

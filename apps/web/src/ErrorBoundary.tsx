/**
 * R3.7 (ERR-VIS-04) · Error boundary global del panel: un fallo de render en
 * una pantalla (p. ej. catálogo incompleto en el editor) NO tumba la app
 * entera ni deja la página en blanco. El fallo se anuncia (role="alert") y se
 * puede reintentar remontando el subárbol.
 *
 * UX-E · El mensaje técnico del fallo («Cannot read properties of undefined
 * (reading 'x')», «x is not a function»…) ya NO se pinta: no le dice nada al
 * usuario y mete «undefined» y nombres internos en la pantalla (sólo se enseña
 * un mensaje escrito para el usuario, ver `userFacingMessage`). Se explica qué
 * pasó y qué hacer (reintentar o volver al inicio); el detalle técnico queda en
 * la consola para quien depura. El foco va al aviso para que se anuncie.
 */
import { Component, createRef, type ReactNode } from "react";

/**
 * ¿El mensaje lo escribió una persona para el usuario? Los fallos del motor JS
 * (TypeError, ReferenceError…) o los que mencionan undefined/null/[object …] son
 * internos y no se pintan; un `throw new Error("catálogo corrupto")` sí.
 */
export function userFacingMessage(error: Error): string | null {
  if (error.name !== "Error") return null;
  const m = (error.message ?? "").trim();
  if (!m || m.length > 300) return null;
  if (/\bundefined\b|\bnull\b|\[object |is not a function|Cannot read|is not defined|Unexpected token/i.test(m))
    return null;
  return m;
}

interface Props {
  children: ReactNode;
  /** Nombre de la zona protegida, para el mensaje ("el editor", "el panel"…). */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private heading = createRef<HTMLHeadingElement>();

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // Visible en consola para diagnóstico; la UI ya muestra el fallo accesible.
    console.error("[panel] error de render capturado:", error);
  }

  componentDidMount(): void {
    if (this.state.error) this.heading.current?.focus();
  }

  componentDidUpdate(_prev: Props, prevState: State): void {
    if (this.state.error && !prevState.error) this.heading.current?.focus();
  }

  render(): ReactNode {
    if (this.state.error) {
      const detail = userFacingMessage(this.state.error);
      return (
        <div className="card" role="alert" data-testid="error-boundary">
          <h2 ref={this.heading} tabIndex={-1}>
            Algo ha fallado en {this.props.label ?? "esta pantalla"}
          </h2>
          <p className="error">
            La pantalla no se pudo mostrar por un fallo interno de la web; lo que ya estaba guardado en el servidor no
            se ha tocado. Pulsa «Reintentar» o vuelve al inicio. Si se repite, avisa al administrador.
          </p>
          {detail && <p data-testid="error-boundary-detail">Detalle: {detail}</p>}
          <p>
            <button type="button" onClick={() => this.setState({ error: null })}>
              Reintentar
            </button>{" "}
            <a href="#/bots">Volver al inicio</a>
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

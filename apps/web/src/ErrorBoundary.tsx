/**
 * R3.7 (ERR-VIS-04) · Error boundary global del panel: un fallo de render en
 * una pantalla (p. ej. catálogo incompleto en el editor) NO tumba la app
 * entera ni deja la página en blanco. El fallo se anuncia (role="alert") y se
 * puede reintentar remontando el subárbol.
 */
import { Component, type ReactNode } from "react";

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

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // Visible en consola para diagnóstico; la UI ya muestra el fallo accesible.
    console.error("[panel] error de render capturado:", error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="card" role="alert" data-testid="error-boundary">
          <h2>Algo ha fallado en {this.props.label ?? "esta pantalla"}</h2>
          <p className="error">{this.state.error.message}</p>
          <button type="button" onClick={() => this.setState({ error: null })}>
            Reintentar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * R3.7 (ERR-VIS-10) · Estado de carga/error POR RECURSO: ninguna pantalla
 * enseña una lista vacía cuando lo que ha pasado es que la carga falló.
 * useResource da { loading | error | ready } + reload; ResourceView pinta los
 * dos primeros de forma accesible y deja el "ready" al llamante.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";

export type Resource<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

export function useResource<T>(loader: () => Promise<T>, deps: unknown[]): [Resource<T>, () => void] {
  const [state, setState] = useState<Resource<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    loader().then(
      (data) => {
        if (alive) setState({ status: "ready", data });
      },
      (e: unknown) => {
        if (alive) setState({ status: "error", message: (e as Error).message ?? "error desconocido" });
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return [state, reload];
}

export function ResourceView<T>(props: {
  resource: Resource<T>;
  label: string;
  onRetry: () => void;
  children: (data: T) => ReactNode;
}) {
  const { resource, label, onRetry } = props;
  if (resource.status === "loading") {
    return (
      <p role="status" aria-live="polite">
        Cargando {label}…
      </p>
    );
  }
  if (resource.status === "error") {
    return (
      <div role="alert" data-testid={`resource-error-${label.replace(/\s+/g, "-")}`}>
        <p className="error">
          No se pudo cargar {label}: {resource.message}
        </p>
        <button type="button" onClick={onRetry}>
          Reintentar
        </button>
      </div>
    );
  }
  return <>{props.children(resource.data)}</>;
}

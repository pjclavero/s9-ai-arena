/**
 * R3.7 (ERR-VIS-10) · Estado de carga/error POR RECURSO: ninguna pantalla
 * enseña una lista vacía cuando lo que ha pasado es que la carga falló.
 * useResource da { loading | error | ready } + reload; ResourceView pinta los
 * dos primeros de forma accesible y deja el "ready" al llamante.
 *
 * B11 · REVALIDACIÓN SILENCIOSA (`reload({ silent: true })`). El reload normal
 * vuelve a `loading`, y `ResourceView` sustituye el subárbol entero por el
 * placeholder: al remontarse, TODO el estado local no guardado de los hijos se
 * pierde (el borrador del editor de loadout, el texto del área de código, el
 * foco). Eso es aceptable al cambiar de recurso, pero NO para un sondeo
 * periódico en segundo plano. Con `silent` se conservan los datos previos
 * mientras llega la respuesta: se actualizan los datos, no se desmonta nada.
 * Un fallo durante una revalidación silenciosa tampoco borra lo que ya había:
 * se mantiene lo último bueno Y se marca en `staleError`, para que conservar los
 * datos previos no se convierta en callar el fallo.
 *
 * B11 (N1) · `staleError` vive DENTRO del recurso a propósito. Antes el panel lo
 * llevaba en un estado propio que fijaba el loader, y eso es una carrera: el
 * `alive` de este hook protege sus `setState`, pero no puede proteger un efecto
 * secundario que el loader haga por su cuenta. Con dos lecturas solapadas que
 * resuelven fuera de orden (dos pulsaciones seguidas de «Actualizar estado»), la
 * vieja llegaba con éxito DESPUÉS de que la nueva fallara y borraba el aviso:
 * quedaban datos potencialmente desfasados con cara de sanos. Aquí solo la
 * lectura vigente puede poner o quitar la marca.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type Resource<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  /** `staleError`: la última revalidación falló; `data` es lo último bueno. */
  | { status: "ready"; data: T; staleError?: string };

export interface ReloadOptions {
  /** true = revalidar sin volver a "loading" (no desmonta el subárbol). */
  silent?: boolean;
}

export function useResource<T>(
  loader: () => Promise<T>,
  deps: unknown[],
): [Resource<T>, (opts?: ReloadOptions) => void] {
  const [state, setState] = useState<Resource<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  // El modo va indexado POR NONCE, no en un único booleano: dos reloads seguidos
  // antes de que React ejecute el efecto hacían que el segundo ciclo perdiera su
  // marca de "silencioso" y volviera a "loading" — justo el parpadeo que se
  // quería eliminar. Con el mapa, cada ciclo conserva el suyo.
  const nonceRef = useRef(0);
  const silentByNonce = useRef(new Map<number, boolean>());
  const reload = useCallback((opts?: ReloadOptions) => {
    // ojo: reload se usa como onClick, que pasa un evento — solo cuenta el flag.
    const next = nonceRef.current + 1;
    nonceRef.current = next;
    silentByNonce.current.set(next, opts?.silent === true);
    setNonce(next);
  }, []);

  useEffect(() => {
    let alive = true;
    const silent = silentByNonce.current.get(nonce) === true;
    for (const n of silentByNonce.current.keys()) if (n <= nonce) silentByNonce.current.delete(n);
    // Un cambio de dependencias (otro bot, otra versión) SÍ vuelve a "loading":
    // enseñar los datos del recurso anterior sería otra forma de mentir.
    if (!silent) setState({ status: "loading" });
    loader().then(
      (data) => {
        // `alive` es lo ÚNICO que decide: una lectura obsoleta no toca nada, ni
        // los datos ni la marca de desfase.
        if (alive) setState({ status: "ready", data });
      },
      (e: unknown) => {
        if (!alive) return;
        const message = (e as Error).message ?? "error desconocido";
        // En silencioso se conserva lo último bueno y se MARCA el desfase; solo
        // se degrada a "error" si no había nada que conservar.
        setState((prev) =>
          silent && prev.status === "ready"
            ? { status: "ready", data: prev.data, staleError: message }
            : { status: "error", message },
        );
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

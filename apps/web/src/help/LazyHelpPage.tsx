/**
 * EQ3 · Carga DIFERIDA del Centro de Ayuda (EQ6-P3): el contenido embebido (catálogo,
 * esquemas, ejemplos…) va en su propio chunk y sólo se descarga al abrir #/help. Sigue
 * siendo offline: el chunk es un fichero estático más de la misma web, sin red externa.
 * App.tsx importa ESTE módulo con el mismo nombre (`HelpPage`), así que el cambio allí
 * es una sola línea.
 */
import { lazy, Suspense } from "react";

const Page = lazy(() => import("../pages/HelpPage.js").then((m) => ({ default: m.HelpPage })));

export function HelpPage(props: { loggedIn: boolean }) {
  return (
    <Suspense
      fallback={
        <p role="status" aria-live="polite" data-testid="help-loading">
          Abriendo la ayuda…
        </p>
      }
    >
      <Page loggedIn={props.loggedIn} />
    </Suspense>
  );
}

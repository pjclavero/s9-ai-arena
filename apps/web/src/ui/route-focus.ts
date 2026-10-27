/**
 * UX-E · Gestión de FOCO tras navegar y enlace «Saltar al contenido».
 *
 * El panel navega por hash sin recargar: al pulsar un enlace de la barra el foco
 * se quedaba en ese enlace y un lector de pantalla no anunciaba la pantalla
 * nueva (el usuario de teclado tenía que recorrer toda la barra para llegar al
 * contenido). Tras cada `hashchange` se lleva el foco al primer encabezado del
 * `<main>` (o al propio `<main>` si la pantalla aún no tiene encabezado), sin
 * tocar el enlace de la URL ni el historial.
 *
 * Se instala UNA vez desde main.tsx: no depende de ninguna página concreta.
 */

/** Atributo que marca el elemento enfocado por la navegación (diagnóstico y tests). */
export const ROUTE_FOCUS_ATTR = "data-route-focus";

/**
 * Elemento al que va el foco tras navegar: el primer h2 del `<main>` (el título
 * de la PANTALLA; en las rutas públicas el h1 es el nombre del sitio, igual en
 * todas), si no el h1, y si no el propio `<main>`.
 */
export function routeFocusTarget(doc: Document): HTMLElement | null {
  const main = doc.querySelector("main");
  if (!main) return null;
  return (
    (main.querySelector("h2") as HTMLElement | null) ??
    (main.querySelector("h1") as HTMLElement | null) ??
    (main as HTMLElement)
  );
}

/** Enfoca el destino sin hacerlo tabulable (tabindex=-1) y lo marca. */
export function focusRouteTarget(doc: Document): HTMLElement | null {
  const target = routeFocusTarget(doc);
  if (!target) return null;
  // Si el foco ya está DENTRO del contenido (p. ej. la pantalla enfocó su propio
  // campo), no se le roba.
  const main = doc.querySelector("main");
  const active = doc.activeElement;
  if (main && active && active !== doc.body && main.contains(active)) return null;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  doc.querySelectorAll(`[${ROUTE_FOCUS_ATTR}]`).forEach((e) => e.removeAttribute(ROUTE_FOCUS_ATTR));
  target.setAttribute(ROUTE_FOCUS_ATTR, "");
  target.focus({ preventScroll: false });
  return target;
}

/**
 * Instala los manejadores. Devuelve la función de desinstalación (tests).
 * `schedule` permite a los tests sustituir el aplazamiento; por defecto, dos
 * frames: React pinta la pantalla nueva tras el `hashchange`.
 */
export function installRouteFocus(
  win: Window = window,
  schedule: (fn: () => void) => void = (fn) => win.requestAnimationFrame(() => win.requestAnimationFrame(fn)),
): () => void {
  const doc = win.document;
  const onHash = () => schedule(() => void focusRouteTarget(doc));
  // «Saltar al contenido» (index.html): NO puede ser un `href="#main"` porque
  // cambiaría la ruta del panel (hash) y pintaría la 404.
  const onClick = (e: Event) => {
    const el = (e.target as Element | null)?.closest?.("[data-skip-link]");
    if (!el) return;
    e.preventDefault();
    const main = doc.querySelector("main") as HTMLElement | null;
    if (!main) return;
    if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
    main.focus();
  };
  win.addEventListener("hashchange", onHash);
  doc.addEventListener("click", onClick);
  return () => {
    win.removeEventListener("hashchange", onHash);
    doc.removeEventListener("click", onClick);
  };
}

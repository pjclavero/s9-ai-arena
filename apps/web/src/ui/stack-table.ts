/**
 * UX-MOBILE · Tablas que en móvil se apilan como tarjetas (`<table className="stack-table">`).
 *
 * El CSS de `index.html` (media query ≤720 px) convierte cada fila en una
 * tarjeta y cada celda en una línea «Etiqueta: valor». La etiqueta sale de
 * `data-label`, que esta función copia del encabezado de su columna (`thead th`,
 * respetando `colSpan`) para que las páginas sólo tengan que poner la clase: el
 * marcado de datos no cambia y los `data-testid` de filas siguen en su `<tr>`.
 *
 * Un `data-label` escrito a mano en la celda manda (no se pisa). Las tablas sin
 * `thead` (listas clave/valor) se apilan sin etiqueta.
 */

export const STACK_TABLE_CLASS = "stack-table";

/** Marca lo que pone esta función, para no confundirlo con un `data-label` escrito a mano. */
const AUTO = "data-label-auto";

/** Textos de encabezado por índice de columna, expandiendo `colSpan`. */
function headerLabels(table: HTMLTableElement): string[] {
  const row = table.tHead?.rows[table.tHead.rows.length - 1];
  if (!row) return [];
  const labels: string[] = [];
  for (const cell of Array.from(row.cells)) {
    const text = (cell.textContent ?? "").replace(/\s+/g, " ").trim();
    const span = Math.max(1, cell.colSpan || 1);
    for (let i = 0; i < span; i++) labels.push(text);
  }
  return labels;
}

/** Pone `data-label` en las celdas de cuerpo de una tabla apilable. Idempotente. */
export function labelStackTable(table: HTMLTableElement): void {
  const labels = headerLabels(table);
  for (const body of Array.from(table.tBodies)) {
    for (const row of Array.from(body.rows)) {
      let col = 0;
      for (const cell of Array.from(row.cells)) {
        const label = labels[col] ?? "";
        col += Math.max(1, cell.colSpan || 1);
        const manual = cell.hasAttribute("data-label") && !cell.hasAttribute(AUTO);
        if (manual) continue;
        if (!label) {
          if (cell.hasAttribute(AUTO)) {
            cell.removeAttribute("data-label");
            cell.removeAttribute(AUTO);
          }
          continue;
        }
        if (cell.getAttribute("data-label") !== label) cell.setAttribute("data-label", label);
        if (!cell.hasAttribute(AUTO)) cell.setAttribute(AUTO, "");
      }
    }
  }
}

/** Etiqueta todas las tablas apilables bajo `root`. */
export function applyStackLabels(root: ParentNode): void {
  for (const t of Array.from(root.querySelectorAll<HTMLTableElement>(`table.${STACK_TABLE_CLASS}`))) {
    labelStackTable(t);
  }
}

/**
 * Mantiene etiquetadas las tablas apilables que React monte o repinte bajo
 * `root`. Devuelve la función que deja de observar.
 */
export function observeStackTables(root: HTMLElement): () => void {
  applyStackLabels(root);
  if (typeof MutationObserver === "undefined") return () => {};
  // Sólo childList/characterData: los atributos que pone labelStackTable no
  // vuelven a disparar el observador.
  const mo = new MutationObserver(() => applyStackLabels(root));
  mo.observe(root, { childList: true, subtree: true, characterData: true });
  return () => mo.disconnect();
}

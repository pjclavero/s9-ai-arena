/**
 * EQ3 · Estilos del Centro de Ayuda (se inyectan una vez; no se toca index.html).
 * Escritorio: índice lateral + contenido. ≤720 px: el índice se pliega tras el
 * botón «Índice de la ayuda» (objetivo táctil de 44 px) y el contenido ocupa todo.
 */
export const HELP_CSS = `
.help-layout { display: grid; grid-template-columns: minmax(12rem, 15rem) minmax(0, 1fr); gap: 1rem; align-items: start; }
.help-index { position: sticky; top: 0.5rem; max-height: calc(100vh - 1rem); overflow-y: auto; }
.help-index ul { list-style: none; padding-left: 0; margin: 0.2rem 0 0.6rem; }
.help-index li ul { padding-left: 0.8rem; }
.help-index a { display: block; padding: 0.15rem 0.3rem; border-radius: 4px; }
.help-index a[aria-current="page"] { background: #253041; font-weight: 600; }
.help-index .help-group-title { font-weight: 600; color: #c9d1db; margin-top: 0.4rem; }
.help-index-toggle { display: none; }
.help-search { display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: center; margin-bottom: 0.6rem; }
.help-search input { flex: 1 1 12rem; }
.help-article { min-width: 0; }
.help-article h3 { margin-top: 0; }
.help-breadcrumb { font-size: 0.9rem; color: #9aa4b2; margin: 0 0 0.4rem; }
.help-code { margin: 0.6rem 0; }
.help-code figcaption { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; font-size: 0.9rem; color: #c9d1db; }
.help-code pre { background: #0d1117; border: 1px solid #2a3340; border-radius: 4px; padding: 0.6rem; overflow-x: auto; }
.help-pending { border-left: 4px solid #ffd479; background: #241f12; padding: 0.5rem 0.75rem; margin: 0.6rem 0; border-radius: 4px; }
.help-note { color: #c9d1db; font-size: 0.92rem; }
.help-article blockquote { border-left: 3px solid #3a4658; margin: 0.5rem 0; padding: 0.2rem 0.8rem; }
@media (max-width: 720px) {
  .help-layout { grid-template-columns: minmax(0, 1fr); }
  .help-index { position: static; max-height: none; }
  .help-index-toggle { display: inline-flex; align-items: center; min-height: 44px; }
  .help-index[data-open="false"] .help-index-list { display: none; }
  .help-index a { min-height: 44px; display: flex; align-items: center; }
}
`;

const STYLE_ID = "s9-help-styles";
export function ensureHelpStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = HELP_CSS;
  document.head.appendChild(el);
}

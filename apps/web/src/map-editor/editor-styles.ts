/**
 * UX-EDITOR · Estilos del editor, acotados a `.s9-me` (no tocan index.html, que es
 * de UX-MOBILE). Oscuro y coherente con el visor. `main.page-wide` es la clase
 * acordada en SPEC.md para salir del `max-width:960px`; esta regla es el respaldo
 * por si index.html aún no la define (misma semántica: no hay conflicto).
 */
export const EDITOR_CSS = `
main.page-wide { max-width: min(1600px, 100%); }
.s9-me { --me-line: #2a3340; --me-panel: #161c24; --me-muted: #9aa4b1; min-width: 0; }
.s9-me * { box-sizing: border-box; }
.s9-me h1 { margin: 0.2rem 0 0.4rem; }
.s9-me h2 { font-size: 1.05rem; margin: 0.6rem 0 0.4rem; }
.s9-me button { min-height: 34px; }
@media (pointer: coarse) { .s9-me button, .s9-me select, .s9-me input { min-height: 44px; } }
.s9-me .s9-me-muted { color: var(--me-muted); font-size: 0.9rem; margin: 0.2rem 0; }
.s9-me .s9-me-note { font-size: 0.85rem; background: #1d2633; border-left: 3px solid #7fb4ff; padding: 0.3rem 0.5rem; margin: 0.4rem 0; }
.s9-me .s9-me-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 6px 0; }
.s9-me .s9-me-bar .s9-me-sep { width: 1px; align-self: stretch; background: var(--me-line); margin: 0 2px; }
.s9-me .s9-me-palette button[aria-pressed="true"] { outline: 2px solid #7fb4ff; background: #23406b; }
.s9-me .s9-me-swatch { display: inline-block; width: 0.8em; height: 0.8em; border-radius: 2px; margin-right: 0.35em; vertical-align: -0.05em; border: 1px solid #0006; }
.s9-me .s9-me-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 12px; align-items: start; }
.s9-me .s9-me-main { min-width: 0; }
.s9-me .s9-me-stage { position: relative; width: 100%; height: clamp(320px, 64vh, 780px); overflow: hidden; background: #0b0f0c; border: 1px solid var(--me-line); border-radius: 6px; }
.s9-me .s9-me-status { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 0.85rem; color: var(--me-muted); margin: 4px 0; font-variant-numeric: tabular-nums; }
.s9-me .s9-me-side { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.s9-me .s9-me-panel { background: var(--me-panel); border: 1px solid var(--me-line); border-radius: 6px; padding: 8px 10px; margin: 0; min-width: 0; }
.s9-me .s9-me-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0; }
.s9-me .s9-me-field { display: flex; flex-direction: column; gap: 2px; font-size: 0.85rem; flex: 1 1 120px; min-width: 0; }
.s9-me .s9-me-field input, .s9-me .s9-me-field select { width: 100%; }
.s9-me .s9-me-objlist { list-style: none; padding: 0; margin: 0; max-height: 220px; overflow-y: auto; }
.s9-me .s9-me-objlist button { width: 100%; text-align: left; background: transparent; border: 1px solid transparent; color: inherit; padding: 4px 6px; }
.s9-me .s9-me-objlist button[aria-pressed="true"] { border-color: #7fb4ff; background: #1d2a3d; }
.s9-me .s9-me-issues { list-style: none; padding: 0; margin: 0; font-size: 0.88rem; }
.s9-me .s9-me-issues li { padding: 3px 0 3px 8px; border-left: 3px solid #f5a623; margin: 3px 0; }
.s9-me .s9-me-issues li[data-severity="error"] { border-left-color: #ff4d4f; }
.s9-me .s9-me-issues button { background: none; border: none; color: #7fb4ff; padding: 0; min-height: 0; text-decoration: underline; cursor: pointer; text-align: left; }
.s9-me .s9-me-ok { color: #7bd88f; }
.s9-me .s9-me-fieldset { border: 1px solid var(--me-line); border-radius: 6px; padding: 8px 10px; margin: 8px 0; min-width: 0; }
.s9-me .s9-me-fieldset input:not([type="checkbox"]) { max-width: 100%; }
.s9-me .s9-me-modes { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.s9-me textarea { width: 100%; max-width: 100%; font-family: ui-monospace, monospace; font-size: 0.8rem; }
.s9-me details > summary { cursor: pointer; padding: 4px 0; }
.s9-me button.danger { border-color: #8a3b3b; }
@media (max-width: 980px) {
  .s9-me .s9-me-layout { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 600px) {
  .s9-me .s9-me-stage { height: 58vh; min-height: 280px; }
  .s9-me .s9-me-bar { gap: 4px; }
  .s9-me .s9-me-bar .s9-me-sep { display: none; }
}
`;

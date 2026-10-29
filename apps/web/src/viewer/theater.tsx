/**
 * UX-VIEW · Disposición «teatro» del visor y del replay, y sus controles.
 *
 *  - El ESCENARIO es el elemento principal: ancho completo de la página (sale de
 *    `main{max-width:960px}` con la clase `.page-wide`) y alto ligado al viewport,
 *    con una barra compacta de controles encima.
 *  - Panel lateral (escritorio) o inferior (tablet/móvil) con el minimapa, el
 *    selector de bots y el marcador: FUERA del área del mapa.
 *  - Barra de cámara: modo visible (libre / siguiendo / bando / vista completa),
 *    zoom −/+ con indicador, «Encajar mapa», «100 %» y «Centrar seleccionado».
 *
 * Todo el CSS va en una hoja propia (TheaterStyles) con clases `s9v-*`: no se toca
 * index.html (es de otro carril). La regla `main.page-wide` se repite aquí por si
 * el carril de móvil aún no la ha integrado; ambas dicen lo mismo.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { CameraMode } from "./camera.js";
import type { ViewStatus } from "./PhaserViewer.js";
import { rosterTeams, sideText, vehicleLabel, vehicleTeam, sortTeams, type ViewerRoster } from "./art-direction.js";
import type { HealthPref, NamePref, TagPrefs } from "./vehicle-tags.js";

export const THEATER_CSS = `
main.page-wide{max-width:none}
.s9v{display:flex;flex-direction:column;gap:.5rem;min-width:0}
.s9v-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:.15rem 1rem;min-width:0}
.s9v-head h2{margin:0;font-size:1.2rem;min-width:0}
.s9v-head p{margin:0}
.s9v-bar{display:flex;flex-wrap:wrap;gap:.35rem .5rem;align-items:center;min-width:0}
.s9v-group{display:flex;flex-wrap:wrap;gap:.25rem;align-items:center;min-width:0}
.s9v-group+.s9v-group{border-left:1px solid #2a3340;padding-left:.5rem}
.s9v-bar button,.s9v-side button{padding:.3rem .6rem;font-size:.9rem}
.s9v-bar button[aria-pressed="true"],.s9v-side button[aria-pressed="true"]{background:#7fb4ff;color:#10141a}
.s9v-badge{display:inline-flex;gap:.35rem;align-items:center;background:#171d26;border:1px solid #2a3340;border-radius:999px;padding:.2rem .6rem;font-size:.85rem;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.s9v-badge b{color:#ffe066}
.s9v-zoom{min-width:3.6em;text-align:center;font-variant-numeric:tabular-nums;font-size:.9rem}
.s9v-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:.75rem;align-items:start;min-width:0}
.s9v-stage{position:relative;width:100%;max-width:100%;height:clamp(300px,calc(100vh - var(--s9v-reserve,230px)),1600px);height:clamp(300px,calc(100dvh - var(--s9v-reserve,230px)),1600px);overflow:hidden;background:#101410;border-radius:6px;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;cursor:grab}
.s9v-stage:active{cursor:grabbing}
.s9v-stage:focus-visible{outline:2px solid #7fb4ff;outline-offset:2px}
.s9v-stage>canvas,.s9v-stage canvas{display:block}
.s9v-side{display:flex;flex-direction:column;gap:.75rem;min-width:0}
.s9v-card{background:#171d26;border:1px solid #2a3340;border-radius:6px;padding:.5rem .6rem;min-width:0}
.s9v-card h3{font-size:.95rem;margin:0 0 .35rem}
.s9v-card ul{margin:.25rem 0;padding-left:1.1rem}
.s9v-bots{display:flex;flex-direction:column;gap:.5rem}
.s9v-bots ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.25rem}
.s9v-bot{display:grid;grid-template-columns:minmax(0,1fr) 3.4em;gap:.4rem;align-items:center}
.s9v-bot button{text-align:left;overflow-wrap:anywhere;width:100%}
.s9v-hp{height:6px;background:rgba(255,255,255,.15);border-radius:3px;overflow:hidden}
.s9v-hp>i{display:block;height:100%}
.s9v-hptext{font-size:.75rem;opacity:.85;text-align:right;font-variant-numeric:tabular-nums}
.s9v-help{opacity:.75;font-size:.8rem;margin:0}
.s9v-transport input[type=range]{flex:1 1 220px;min-width:0}
@media (max-width:1100px){.s9v-grid{grid-template-columns:minmax(0,1fr)}.s9v-side{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));align-items:start}}
@media (max-width:720px){.s9v-stage{height:clamp(240px,min(62vh,110vw),720px);height:clamp(240px,min(62dvh,110vw),720px)}.s9v-side{grid-template-columns:minmax(0,1fr)}.s9v-group+.s9v-group{border-left:0;padding-left:0}.s9v-head h2{font-size:1.05rem}}
@media (min-width:721px){.s9v-stage[data-fit-h]{height:var(--s9v-fit-h)}}
@media (pointer:coarse){.s9v-bar button,.s9v-side button{min-height:44px;min-width:44px}}
`;

export function TheaterStyles() {
  return <style data-testid="s9v-styles">{THEATER_CSS}</style>;
}

/**
 * Ancho completo para el visor: añade `.page-wide` al <main> al montar y la quita
 * al desmontar (acuerdo con el carril de móvil, SPEC.md).
 */
export function useWideMain(): void {
  useEffect(() => {
    const main = typeof document !== "undefined" ? document.querySelector("main") : null;
    if (!main) return;
    const had = main.classList.contains("page-wide");
    main.classList.add("page-wide");
    return () => {
      if (!had) main.classList.remove("page-wide");
    };
  }, []);
}

/**
 * Alto del escenario en escritorio/tablet: lo que queda de viewport desde donde
 * EMPIEZA el escenario (la cabecera y las barras pueden partirse en varias
 * líneas), acotado. Así el escenario se ve entero sin hacer scroll.
 */
export function stageHeightFor(viewportH: number, stageTopDoc: number, min = 360, max = 1600, gap = 12): number {
  return Math.round(Math.max(min, Math.min(max, viewportH - stageTopDoc - gap)));
}

/** Aplica stageHeightFor al escenario y lo recalcula al redimensionar (y si la cabecera cambia de alto). */
export function useFitStageHeight(ref: { current: HTMLElement | null }): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    let last = -1;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const h = stageHeightFor(window.innerHeight, top);
      if (Math.abs(h - last) < 2) return;
      last = h;
      el.style.setProperty("--s9v-fit-h", `${h}px`);
      el.setAttribute("data-fit-h", String(h));
    };
    fit();
    window.addEventListener("resize", fit);
    const section = el.closest(".s9v");
    const ro = typeof ResizeObserver !== "undefined" && section ? new ResizeObserver(fit) : null;
    if (ro && section) ro.observe(section);
    return () => {
      window.removeEventListener("resize", fit);
      ro?.disconnect();
    };
  }, [ref]);
}

/** Texto del modo de cámara visible para el usuario. */
export function cameraModeText(mode: CameraMode | null | undefined, roster: ViewerRoster): string {
  if (!mode) return "vista completa";
  switch (mode.kind) {
    case "global":
      return "vista completa";
    case "follow":
      return `siguiendo a ${vehicleLabel(roster, mode.vehicleId)}`;
    case "team":
      return `bando ${sideText(mode.team)}`;
    case "manual":
      return "libre";
  }
}

export interface CameraBarProps {
  status: ViewStatus | null;
  roster: ViewerRoster;
  disabled?: boolean;
  onZoomIn(): void;
  onZoomOut(): void;
  onFit(): void;
  onNative(): void;
  onCenterSelected(): void;
}

/** Modo de cámara + zoom. El resto de botones de modo (Vista global, Bando …) los pone la página. */
export function CameraBar(p: CameraBarProps) {
  const mode = p.status?.mode ?? { kind: "global" as const };
  const pct = p.status?.zoomPercent ?? 0;
  return (
    <>
      <span className="s9v-group">
        <span className="s9v-badge" data-testid="camera-mode" data-mode={mode.kind} role="status" aria-live="polite">
          Cámara: <b>{cameraModeText(mode, p.roster)}</b>
        </span>
      </span>
      <span className="s9v-group" role="group" aria-label="Zoom del escenario">
        <button type="button" aria-label="Alejar" title="Alejar (−)" disabled={p.disabled} onClick={p.onZoomOut}>
          −
        </button>
        <span className="s9v-zoom" data-testid="zoom-level" data-percent={pct} title="Zoom (100 % = escala nativa)">
          {pct > 0 ? `${pct} %` : "—"}
        </span>
        <button type="button" aria-label="Acercar" title="Acercar (+)" disabled={p.disabled} onClick={p.onZoomIn}>
          +
        </button>
        <button
          type="button"
          title="Ver el mapa entero (F)"
          aria-pressed={mode.kind === "global"}
          disabled={p.disabled}
          onClick={p.onFit}
        >
          Encajar mapa
        </button>
        <button type="button" title="Escala nativa (N)" disabled={p.disabled} onClick={p.onNative}>
          100 %
        </button>
        <button
          type="button"
          title="Centrar la cámara en el bot seleccionado (C)"
          disabled={p.disabled || !p.status?.selectedId}
          onClick={p.onCenterSelected}
        >
          Centrar seleccionado
        </button>
      </span>
    </>
  );
}

/** Vida de un vehículo del overlay como fracción 0..1, o null si no la hay. */
export function hpRatioOf(v: { hullHp?: number; hullHpMax?: number } | undefined): number | null {
  if (!v || typeof v.hullHp !== "number" || typeof v.hullHpMax !== "number" || !(v.hullHpMax > 0)) return null;
  return Math.max(0, Math.min(1, v.hullHp / v.hullHpMax));
}

export interface BotSelectorProps {
  roster: ViewerRoster;
  /** Vehículos en orden estable (el del overlay: el mismo de las teclas 1–8). */
  vehicleIds: string[];
  vehicles?: Map<string, { team?: string; alive?: boolean; hullHp?: number; hullHpMax?: number }>;
  status: ViewStatus | null;
  onFollow(id: string): void;
}

/**
 * Selector de bots agrupado por bando: «Seguir <nombre>» (con su tecla 1–8), vida
 * y KO. Sustituye a la fila de 8 botones que había encima del escenario.
 */
export function BotSelector(p: BotSelectorProps) {
  if (p.vehicleIds.length === 0) return null;
  const teamOf = (id: string) => vehicleTeam(p.roster, id, p.vehicles?.get(id)?.team);
  const fromRoster = rosterTeams(p.roster);
  const teams =
    fromRoster.length > 0 ? fromRoster : sortTeams(p.vehicleIds.map(teamOf).filter((t): t is string => !!t));
  const groups: { team: string | null; ids: string[] }[] = teams.map((t) => ({
    team: t,
    ids: p.vehicleIds.filter((id) => teamOf(id) === t),
  }));
  const loose = p.vehicleIds.filter((id) => !teamOf(id) || !teams.includes(teamOf(id)!));
  if (loose.length > 0) groups.push({ team: null, ids: loose });
  const followed = p.status?.mode.kind === "follow" ? p.status.mode.vehicleId : null;
  return (
    <div className="s9v-bots" data-testid="bot-selector">
      {groups.map((g) => (
        <section key={g.team ?? "_"} aria-label={g.team ? `Bando ${sideText(g.team)}` : "Sin bando"}>
          <h3>{g.team ? `Bando ${sideText(g.team)}` : "Sin bando"}</h3>
          <ul>
            {g.ids.map((id) => {
              const v = p.vehicles?.get(id);
              const hp = hpRatioOf(v);
              const dead = v?.alive === false;
              const key = p.vehicleIds.indexOf(id) + 1;
              return (
                <li
                  key={id}
                  className="s9v-bot"
                  data-testid="bot-row"
                  data-vehicle-id={id}
                  data-selected={p.status?.selectedId === id ? "true" : undefined}
                >
                  <button
                    type="button"
                    aria-pressed={followed === id}
                    title={key <= 8 ? `Tecla ${key}` : undefined}
                    onClick={() => p.onFollow(id)}
                  >
                    Seguir {vehicleLabel(p.roster, id)}
                  </button>
                  <span className="s9v-hptext">
                    {dead ? "KO" : hp === null ? "" : `${Math.round(hp * 100)}%`}
                    {hp !== null && !dead && (
                      <span className="s9v-hp" aria-hidden="true">
                        <i
                          style={{
                            width: `${Math.round(hp * 100)}%`,
                            background: hp > 0.5 ? "#5fd35f" : hp > 0.25 ? "#e0c040" : "#e05a5a",
                          }}
                        />
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function TagPrefsControl({ prefs, onChange }: { prefs: TagPrefs; onChange(p: TagPrefs): void }) {
  return (
    <div className="s9v-group" role="group" aria-label="Etiquetas sobre los bots">
      <label>
        Vida{" "}
        <select
          aria-label="vida sobre los bots"
          value={prefs.health}
          onChange={(e) => onChange({ ...prefs, health: e.target.value as HealthPref })}
        >
          <option value="bar">barra fina</option>
          <option value="selected">sólo el seleccionado</option>
          <option value="off">oculta</option>
        </select>
      </label>
      <label>
        Nombres{" "}
        <select
          aria-label="nombres sobre los bots"
          value={prefs.names}
          onChange={(e) => onChange({ ...prefs, names: e.target.value as NamePref })}
        >
          <option value="auto">automático</option>
          <option value="all">todos</option>
          <option value="selected">sólo el seleccionado</option>
          <option value="off">ocultos</option>
        </select>
      </label>
    </div>
  );
}

/** Estado visible de la cámara de una escena (null hasta que la escena existe). */
export function useViewStatus(
  scene: { subscribeView?: (cb: (s: ViewStatus) => void) => (() => void) | void } | null,
): ViewStatus | null {
  const [status, setStatus] = useState<ViewStatus | null>(null);
  useEffect(() => {
    if (!scene || typeof scene.subscribeView !== "function") return;
    const off = scene.subscribeView((s) => setStatus(s));
    return () => {
      if (typeof off === "function") off();
    };
  }, [scene]);
  return status;
}

export function TheaterGrid({ stage, side }: { stage: ReactNode; side: ReactNode }) {
  return (
    <div className="s9v-grid">
      <div style={{ minWidth: 0 }}>{stage}</div>
      <aside className="s9v-side" aria-label="Minimapa, bots y marcador">
        {side}
      </aside>
    </div>
  );
}

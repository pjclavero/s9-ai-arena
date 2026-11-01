/**
 * R10 + FC-C (TD-010) + UX-EDITOR · Editor visual de mapas PERSISTENTE.
 *
 * Persistencia (sin cambios respecto a FC-C):
 *  - El editor trabaja directamente sobre el FORMATO INTERNO (InternalMap, metros):
 *    lo mismo que guarda la API (map_versions.content), lo que importa «Mapas» y lo
 *    que valida E4. Exportar = ese documento; por eso export ↔ import es simétrico.
 *  - Guardar = POST /maps/drafts: el borrador vive en el SERVIDOR (BD). La URL
 *    (#/maps/editor?map=<id>&v=<n>) identifica lo abierto; F5 lo reabre desde la API.
 *  - Importa también el JSON de autoría antiguo (px), convirtiéndolo (10 px = 1 m).
 *
 * UX-EDITOR (edición visual):
 *  - paleta (clic en el mapa para colocar), seleccionar, arrastrar para mover,
 *    tiradores para redimensionar, borrar, duplicar, copiar/pegar;
 *  - panel de propiedades sincronizado; rejilla y ajuste opcionales, coordenadas del
 *    cursor, guías de alineación; zoom (rueda, +/−, encajar, 100 %) y pan con el
 *    módulo común shared/view-transform.ts;
 *  - deshacer/rehacer (Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y);
 *  - validación en vivo antes de guardar (map-editor/validation.ts, que además corre
 *    el validador real del servidor en el navegador);
 *  - borrador local que sobrevive a recargar (además de guardar en el servidor).
 *
 * La autorización la hace la API (solo el dueño guarda/publica su mapa); la UI solo
 * informa. La validación del cliente es una ayuda; la autoridad es validateMap (E4)
 * en la API al guardar y publicar.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiRequestError } from "../api.js";
import { ErrorState, LoadingState } from "../ui/primitives.js";
import { modeName } from "../battle-result.js";
import {
  PLATFORM_MODES,
  newMap,
  parseImport,
  resize,
  toDocument,
  toggleMode,
  type EditorMap,
  type ObjKind,
  type ObjRef,
  type Vec2,
} from "../map-editor/model.js";
import {
  allRefs,
  createAt,
  duplicateObj,
  getObj,
  insertCopy,
  objLabel,
  patchObj,
  removeObj,
  refKey,
  translateObj,
  replaceObj,
  TOOLS,
  type AnyObj,
  type Tool,
} from "../map-editor/objects.js";
import {
  canRedo,
  canUndo,
  commit,
  commitFrom,
  createHistory,
  live,
  redo,
  undo,
  type History,
} from "../map-editor/history.js";
import { fullValidation, issuesByObject, liveIssues } from "../map-editor/validation.js";
import { clearDraft, readDraft, sameOrigin, writeDraft, type DraftOrigin } from "../map-editor/draft-storage.js";
import { EditorCanvas, PX_PER_M_100, teamColor, zoomLimits, type GridOpts } from "../map-editor/EditorCanvas.js";
import { PropertiesPanel, NumField } from "../map-editor/PropertiesPanel.js";
import { EDITOR_CSS } from "../map-editor/editor-styles.js";
import { clampCenter, fitView, zoomTo, type Size, type View } from "../shared/view-transform.js";
import type { Check } from "../../../map-service/src/validate/result.js";

// API pública histórica de este módulo (tests y otras páginas la importan de aquí).
export {
  PLATFORM_MODES,
  newMap,
  resize,
  toggleMode,
  fromLegacyAuthoring,
  parseImport,
  toDocument,
  validateDraft,
} from "../map-editor/model.js";
export type { Vec2, RectShape, EditorMap, ObjKind, ObjRef } from "../map-editor/model.js";

interface ServerCheck {
  check: string;
  severity: string;
  message: string;
}
interface SavedVersion {
  mapId: string;
  version: number;
  state: string;
  name?: string;
  checks?: ServerCheck[];
}

function readHash(): { map?: string; v?: number } {
  const q = window.location.hash.split("?")[1] ?? "";
  const sp = new URLSearchParams(q);
  const v = Number(sp.get("v"));
  return { map: sp.get("map") ?? undefined, v: Number.isInteger(v) && v > 0 ? v : undefined };
}
function writeHash(mapId: string, version: number) {
  const next = `#/maps/editor?map=${encodeURIComponent(mapId)}&v=${version}`;
  if (window.location.hash !== next) window.history.replaceState(null, "", next);
}

const STATE_NAME: Record<string, string> = { draft: "borrador", published: "publicado", archived: "archivado" };
const stateName = (s: string) => (Object.prototype.hasOwnProperty.call(STATE_NAME, s) ? STATE_NAME[s] : s);

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
}

const fmt = (v: number) => (Math.round(v * 10) / 10).toLocaleString("es-ES", { minimumFractionDigits: 1 });

export function MapEditorPage() {
  const [hist, setHist] = useState<History<EditorMap>>(() => createHistory(newMap()));
  const map = hist.present;
  const histRef = useRef(hist);
  histRef.current = hist;
  const [saved, setSaved] = useState<SavedVersion | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<ObjRef | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [vp, setVp] = useState<Size>({ w: 800, h: 500 });
  const [grid, setGrid] = useState<GridOpts>({ show: true, snap: false, step: 1 });
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [checks, setChecks] = useState<ServerCheck[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [restored, setRestored] = useState(false);
  const [mine, setMine] = useState<SavedVersion[] | null>(null);
  // UX-R · si «mis mapas» falla se dice (con reintento), no «Cargando…» eterno.
  const [mineError, setMineError] = useState<unknown>(null);
  const [importText, setImportText] = useState("");
  const [copyId, setCopyId] = useState("");
  const [gestureActive, setGestureActive] = useState(false);
  const gestureBefore = useRef<EditorMap | null>(null);
  const clipboard = useRef<{ kind: ObjKind; obj: AnyObj; pastes: number } | null>(null);
  const savedRef = useRef<SavedVersion | null>(null);
  savedRef.current = saved;

  const issues = useMemo(() => liveIssues(map), [map]);
  const flagged = useMemo(() => issuesByObject(issues), [issues]);
  const exportJson = useMemo(() => JSON.stringify(toDocument(map), null, 2), [map]);

  // Validador completo del servidor, en diferido y nunca durante un gesto.
  const [full, setFull] = useState<Check[] | null>(null);
  useEffect(() => {
    if (gestureActive) return;
    const t = setTimeout(() => setFull(fullValidation(map)), 350);
    return () => clearTimeout(t);
  }, [map, gestureActive]);

  // Salir del max-width de main (clase acordada con UX-MOBILE).
  useEffect(() => {
    const main = document.querySelector("main");
    main?.classList.add("page-wide");
    return () => main?.classList.remove("page-wide");
  }, []);

  /** Sustituye el mapa entero (abrir, importar, nuevo): historial y vista desde cero. */
  function resetTo(m: EditorMap) {
    setHist(createHistory(m));
    setSelected(null);
    setTool(null);
    setView(null);
  }

  function edit(fn: (m: EditorMap) => EditorMap, key?: string) {
    setHist((h) => commit(h, fn(h.present), key));
    setDirty(true);
  }

  async function open(mapId: string, version: number, localOverride?: EditorMap) {
    setError("");
    setBusy(true);
    try {
      const [meta, content] = await Promise.all([
        api<SavedVersion>("GET", `/maps/${encodeURIComponent(mapId)}/versions/${version}`),
        api<EditorMap>("GET", `/maps/${encodeURIComponent(mapId)}/versions/${version}/content`),
      ]);
      setSaved(meta);
      setChecks([]);
      writeHash(mapId, version);
      if (localOverride) {
        resetTo(localOverride);
        setDirty(true);
        setRestored(true);
        setNotice(`Abierto ${mapId} v${version} con los cambios sin guardar que quedaron en este navegador.`);
      } else {
        resetTo(content);
        setDirty(false);
        setRestored(false);
        setNotice(`Abierto ${mapId} v${version} (${stateName(meta.state)}).`);
      }
    } catch (e) {
      setError(`No se pudo abrir ${mapId} v${version}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadMine() {
    setMineError(null);
    try {
      const page = await api<{ items: SavedVersion[] }>("GET", "/maps?mine=true&limit=100");
      setMine(page.items);
    } catch (e) {
      setMineError(e);
    }
  }

  // F5 / volver al editor: la URL dice qué mapa está abierto; se reabre DESDE LA API.
  // Si este navegador guardó cambios sin guardar de ESE mismo origen, se recuperan.
  useEffect(() => {
    const h = readHash();
    const draft = readDraft();
    const target: DraftOrigin | null = h.map && h.v ? { mapId: h.map, version: h.v } : (draft?.origin ?? null);
    if (target) {
      void open(target.mapId, target.version, draft && sameOrigin(draft.origin, target) ? draft.map : undefined);
    } else if (draft) {
      resetTo(draft.map);
      setDirty(true);
      setRestored(true);
      setNotice("Se han recuperado los cambios sin guardar que quedaron en este navegador.");
    }
    void loadMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Borrador local: cada cambio sin guardar se escribe (en diferido) en este navegador.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      const s = savedRef.current;
      writeDraft({ origin: s ? { mapId: s.mapId, version: s.version } : null, map, savedAt: Date.now() });
    }, 250);
    return () => clearTimeout(t);
  }, [map, dirty]);

  // Una selección que ya no existe (deshacer, borrar) se suelta.
  useEffect(() => {
    if (selected && !getObj(map, selected)) setSelected(null);
  }, [map, selected]);

  async function save(doc: EditorMap = map) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const r = await api<SavedVersion>("POST", "/maps/drafts", toDocument(doc));
      setSaved(r);
      setChecks(r.checks ?? []);
      // El historial se conserva: guardar no es un cambio del mapa.
      setHist((h) => ({ ...h, present: { ...doc, version: r.version } }));
      setDirty(false);
      setRestored(false);
      clearDraft();
      writeHash(r.mapId, r.version);
      setNotice(`Guardado en el servidor: ${r.mapId} v${r.version} (borrador).`);
      await loadMine();
    } catch (e) {
      const body = e instanceof ApiRequestError ? e.body : {};
      setError(
        `No se pudo guardar: ${(e as Error).message}${body.error === "forbidden" ? " (el mapa es de otro usuario: duplícalo con otro id)" : ""}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!saved) return;
    setError("");
    setBusy(true);
    try {
      const r = await api<SavedVersion>(
        "POST",
        `/maps/${encodeURIComponent(saved.mapId)}/versions/${saved.version}/actions/publish`,
      );
      setSaved(r);
      setNotice(`Publicado ${r.mapId} v${r.version}: ya se puede usar en batallas.`);
      await loadMine();
    } catch (e) {
      const body = e instanceof ApiRequestError ? (e.body as { checks?: ServerCheck[] }) : {};
      if (Array.isArray(body.checks)) setChecks(body.checks);
      setError(`No se pudo publicar: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  // --- acciones de edición ----------------------------------------------------
  const doUndo = useCallback(() => {
    setHist((h) => undo(h));
    setDirty(true);
  }, []);
  const doRedo = useCallback(() => {
    setHist((h) => redo(h));
    setDirty(true);
  }, []);

  function place(t: Tool, p: Vec2) {
    const r = createAt(histRef.current.present, t, p);
    edit(() => r.map);
    setSelected(r.ref);
    setTool(null);
  }
  function deleteSelected() {
    const sel = selected;
    if (!sel || !getObj(map, sel)) return;
    edit((m) => removeObj(m, sel));
    setSelected(null);
  }
  function duplicateSelected() {
    const sel = selected;
    if (!sel) return;
    const r = duplicateObj(histRef.current.present, sel);
    if (!r) return;
    edit(() => r.map);
    setSelected(r.ref);
  }
  function copySelected() {
    const o = getObj(map, selected);
    if (!selected || !o) return;
    clipboard.current = { kind: selected.kind, obj: JSON.parse(JSON.stringify(o)) as AnyObj, pastes: 0 };
    setNotice(`Copiado: ${objLabel(map, selected)}.`);
  }
  function paste() {
    const c = clipboard.current;
    if (!c) return;
    c.pastes += 1;
    const off = 2 * c.pastes;
    const r = insertCopy(histRef.current.present, c.kind, c.obj, off, off);
    edit(() => r.map);
    setSelected(r.ref);
  }
  function nudge(dx: number, dy: number) {
    const sel = selected;
    const o = getObj(map, sel);
    if (!sel || !o) return;
    edit((m) => replaceObj(m, sel, translateObj(o, dx, dy)), `nudge:${refKey(sel)}`);
  }

  function zoomBy(f: number) {
    const v = view ?? fitView({ w: map.widthM, h: map.heightM }, vp);
    setView(clampCenter(zoomTo(v, v.zoom * f, vp, zoomLimits(map, vp)), { w: map.widthM, h: map.heightM }));
  }
  function zoom100() {
    const v = view ?? fitView({ w: map.widthM, h: map.heightM }, vp);
    setView(zoomTo(v, PX_PER_M_100, vp, zoomLimits(map, vp)));
  }

  // Teclado: atajos del editor fuera de los campos de texto.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "z" && !e.shiftKey) return (e.preventDefault(), doUndo());
    if ((mod && k === "z" && e.shiftKey) || (mod && k === "y")) return (e.preventDefault(), doRedo());
    if (mod && k === "c") return copySelected();
    if (mod && k === "v") return (e.preventDefault(), paste());
    if (mod && k === "d") return (e.preventDefault(), duplicateSelected());
    if (mod) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      if (selected) e.preventDefault();
      return deleteSelected();
    }
    if (e.key === "Escape") return (setTool(null), setSelected(null));
    const step = (grid.snap ? grid.step : 0.5) * (e.shiftKey ? 5 : 1);
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (selected && Object.prototype.hasOwnProperty.call(arrows, e.key)) {
      e.preventDefault();
      nudge(...arrows[e.key]);
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const refs = allRefs(map);
  const errorsN = issues.filter((i) => i.severity === "error").length;
  const warnsN = issues.length - errorsN;
  const fullErrors = (full ?? []).filter((c) => c.severity === "error");
  const fullWarns = (full ?? []).filter((c) => c.severity !== "error");
  const zoomPct = Math.round(((view ?? fitView({ w: map.widthM, h: map.heightM }, vp)).zoom / PX_PER_M_100) * 100);
  const cursorInside = cursor && cursor.x >= 0 && cursor.y >= 0 && cursor.x <= map.widthM && cursor.y <= map.heightM;

  return (
    <section aria-label="Editor de mapas" className="s9-me">
      <style>{EDITOR_CSS}</style>
      <h1>Editor de mapas</h1>
      <p role="note">
        Los mapas se guardan <strong>en el servidor</strong> como borrador; publícalo para poder usarlo en una batalla.
        {saved ? (
          <>
            {" "}
            Abierto:{" "}
            <code data-testid="editor-current">
              {saved.mapId} v{saved.version}
            </code>{" "}
            ({stateName(saved.state)}){dirty ? " · cambios sin guardar" : " · guardado"}
          </>
        ) : (
          <> Mapa nuevo, aún sin guardar{dirty ? " (los cambios se conservan en este navegador al recargar)" : ""}.</>
        )}
      </p>
      {error && (
        <p className="error" role="alert" data-testid="editor-error">
          {error}
        </p>
      )}
      {notice && (
        <p className="ok" role="status" data-testid="editor-notice">
          {notice}
        </p>
      )}
      {restored && (
        <p className="s9-me-note" data-testid="editor-restored">
          Estás viendo cambios que no se llegaron a guardar en el servidor.{" "}
          <button
            type="button"
            onClick={() => {
              clearDraft();
              setRestored(false);
              if (saved) void open(saved.mapId, saved.version);
              else {
                resetTo(newMap());
                setDirty(false);
              }
            }}
          >
            Descartar cambios locales
          </button>
        </p>
      )}

      <fieldset className="s9-me-fieldset">
        <legend>Mapa</legend>
        <div className="s9-me-row">
          <label className="s9-me-field">
            <span>Nombre</span>
            <input
              aria-label="nombre del mapa"
              value={map.meta.name ?? ""}
              onChange={(e) => edit((m) => ({ ...m, meta: { ...m.meta, name: e.target.value } }), "map-name")}
            />
          </label>
          <label className="s9-me-field">
            <span>Identificador (en la dirección del mapa)</span>
            <input
              aria-label="id del mapa"
              value={map.mapId}
              onChange={(e) => edit((m) => ({ ...m, mapId: e.target.value }), "map-id")}
            />
          </label>
          <NumField
            label="Anchura del mapa"
            unit="m"
            min={1}
            step={1}
            value={map.widthM}
            testId="map-width"
            onChange={(v) => v > 0 && edit((m) => resize(m, v, m.heightM), "map-size")}
          />
          <NumField
            label="Altura del mapa"
            unit="m"
            min={1}
            step={1}
            value={map.heightM}
            testId="map-height"
            onChange={(v) => v > 0 && edit((m) => resize(m, m.widthM, v), "map-size")}
          />
        </div>
        <div role="group" aria-label="modos soportados" className="s9-me-modes">
          <span>Modos de juego:</span>
          {PLATFORM_MODES.map((mode) => (
            <label key={mode}>
              <input
                type="checkbox"
                aria-label={`modo ${mode}`}
                checked={map.meta.supportedModes.includes(mode)}
                onChange={() => edit((m) => toggleMode(m, mode))}
              />{" "}
              {modeName(mode)}
            </label>
          ))}
        </div>
      </fieldset>
      <p data-testid="editor-perimeter-note" className="s9-me-muted">
        El borde del mapa es un muro: en batalla nadie sale del rectángulo de {map.widthM}×{map.heightM} m, así que no
        hace falta dibujar el perímetro. Los spawns y muros deben quedar dentro.
      </p>

      <div role="toolbar" aria-label="Herramientas" className="s9-me-bar">
        <button
          type="button"
          onClick={() => {
            clearDraft();
            resetTo(newMap());
            setSaved(null);
            setDirty(false);
            setRestored(false);
            setChecks([]);
            window.history.replaceState(null, "", "#/maps/editor");
          }}
        >
          Nuevo
        </button>
        <button type="button" disabled={busy} data-testid="editor-save" onClick={() => void save()}>
          Guardar en el servidor
        </button>
        <button
          type="button"
          disabled={busy || !saved || dirty || saved.state === "published"}
          data-testid="editor-publish"
          onClick={() => void publish()}
        >
          Publicar
        </button>
        <span className="s9-me-sep" aria-hidden="true" />
        <button type="button" disabled={!canUndo(hist)} onClick={doUndo} title="Ctrl+Z" data-testid="editor-undo">
          Deshacer
        </button>
        <button
          type="button"
          disabled={!canRedo(hist)}
          onClick={doRedo}
          title="Ctrl+Shift+Z o Ctrl+Y"
          data-testid="editor-redo"
        >
          Rehacer
        </button>
        <button type="button" disabled={!selected} onClick={copySelected} title="Ctrl+C">
          Copiar
        </button>
        <button type="button" disabled={!clipboard.current} onClick={paste} title="Ctrl+V">
          Pegar
        </button>
      </div>

      <div role="group" aria-label="Paleta de objetos" className="s9-me-bar s9-me-palette" data-testid="editor-palette">
        <button
          type="button"
          aria-pressed={tool === null}
          onClick={() => setTool(null)}
          title="Seleccionar y mover objetos (Esc)"
        >
          Seleccionar
        </button>
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            type="button"
            aria-pressed={tool === t.tool}
            data-tool={t.tool}
            title={`${t.help} Elige y haz clic en el mapa.`}
            onClick={() => setTool((cur) => (cur === t.tool ? null : t.tool))}
          >
            <span
              className="s9-me-swatch"
              aria-hidden="true"
              style={{
                background: t.team
                  ? teamColor(t.team)
                  : t.tool === "wall"
                    ? "#66736e"
                    : t.tool === "crate"
                      ? "#b09858"
                      : t.tool === "damage-zone"
                        ? "#e5534b"
                        : "#f1c40f",
                borderRadius: t.kind === "spawn" || t.kind === "zone" ? "50%" : 2,
              }}
            />
            {t.label}
          </button>
        ))}
      </div>

      <div className="s9-me-layout">
        <div className="s9-me-main">
          <div role="group" aria-label="Vista" className="s9-me-bar">
            <button
              type="button"
              aria-label="Alejar"
              title="Alejar (rueda hacia atrás)"
              onClick={() => zoomBy(1 / 1.25)}
            >
              −
            </button>
            <span data-testid="editor-zoom" aria-live="polite" title="100 % = 10 píxeles por metro">
              {zoomPct} %
            </span>
            <button
              type="button"
              aria-label="Acercar"
              title="Acercar (rueda hacia delante)"
              onClick={() => zoomBy(1.25)}
            >
              +
            </button>
            <button type="button" onClick={() => setView(null)}>
              Encajar mapa
            </button>
            <button type="button" onClick={zoom100}>
              100 %
            </button>
            <span className="s9-me-sep" aria-hidden="true" />
            <label>
              <input
                type="checkbox"
                checked={grid.show}
                onChange={(e) => setGrid({ ...grid, show: e.target.checked })}
              />{" "}
              Rejilla
            </label>
            <label>
              <input
                type="checkbox"
                aria-label="Ajustar a la rejilla"
                checked={grid.snap}
                onChange={(e) => setGrid({ ...grid, snap: e.target.checked })}
              />{" "}
              Ajustar
            </label>
            <label>
              <span className="visually-hidden">Paso de la rejilla</span>
              <select
                aria-label="Paso de la rejilla"
                value={grid.step}
                onChange={(e) => setGrid({ ...grid, step: Number(e.target.value) })}
              >
                {[0.5, 1, 2, 5].map((s) => (
                  <option key={s} value={s}>
                    {String(s).replace(".", ",")} m
                  </option>
                ))}
              </select>
            </label>
          </div>
          <EditorCanvas
            map={map}
            selected={selected}
            tool={tool}
            view={view}
            grid={grid}
            flagged={flagged}
            onView={setView}
            onViewport={setVp}
            onSelect={setSelected}
            onPlace={place}
            onGestureStart={() => {
              gestureBefore.current = histRef.current.present;
              setGestureActive(true);
            }}
            onGestureLive={(next) => setHist((h) => live(h, next))}
            onGestureEnd={() => {
              const before = gestureBefore.current;
              gestureBefore.current = null;
              setGestureActive(false);
              if (before) {
                setHist((h) => commitFrom(h, before));
                setDirty(true);
              }
            }}
            onCursor={setCursor}
          />
          <div className="s9-me-status">
            <span data-testid="editor-cursor">
              {cursor
                ? `Cursor: X ${fmt(cursor.x)} m · Y ${fmt(cursor.y)} m${cursorInside ? "" : " (fuera del mapa)"}`
                : "Cursor: fuera del lienzo"}
            </span>
            <span>
              Mapa: {map.widthM} × {map.heightM} m
            </span>
            {tool && (
              <span data-testid="editor-tool-hint">
                Haz clic en el mapa para colocar: {TOOLS.find((t) => t.tool === tool)?.label}
              </span>
            )}
          </div>
          <p className="s9-me-muted" data-testid="editor-help">
            Elige un objeto de la paleta y haz clic en el mapa para colocarlo. Arrastra un objeto para moverlo y sus
            cuadraditos para cambiar el tamaño. Arrastra en un hueco (o con el botón central) para desplazar la vista;
            la rueda o el pellizco hacen zoom. Ctrl+Z deshace, Ctrl+Shift+Z o Ctrl+Y rehace, Supr borra, Ctrl+D duplica,
            las flechas mueven con precisión. Las bases cuentan en batalla como su círculo relleno.
          </p>
        </div>

        <div className="s9-me-side">
          <PropertiesPanel
            map={map}
            selected={selected}
            onPatch={(ref, patch, field) => edit((m) => patchObj(m, ref, patch), `prop:${refKey(ref)}:${field}`)}
            onDuplicate={duplicateSelected}
            onDelete={deleteSelected}
          />

          <div className="s9-me-panel" data-testid="editor-validation" data-errors={errorsN} data-warnings={warnsN}>
            <h2>Comprobaciones</h2>
            {issues.length === 0 ? (
              <p className="s9-me-ok" data-testid="editor-validation-ok">
                Sin problemas a la vista.
              </p>
            ) : (
              <>
                <p className="s9-me-muted">
                  {errorsN} {errorsN === 1 ? "problema" : "problemas"} y {warnsN} {warnsN === 1 ? "aviso" : "avisos"}.
                  Se puede guardar igualmente; para publicar no debe quedar ningún problema.
                </p>
                <ul className="s9-me-issues">
                  {issues.map((i, k) => (
                    <li key={k} data-severity={i.severity} data-code={i.code} data-testid="editor-issue">
                      {i.severity === "error" ? "Problema: " : "Aviso: "}
                      {i.refs[0] ? (
                        <button type="button" onClick={() => setSelected(i.refs[0])}>
                          {i.message}
                        </button>
                      ) : (
                        i.message
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <details data-testid="editor-full-validation">
              <summary>
                Comprobación completa (la misma del servidor):{" "}
                {full === null ? "calculando…" : `${fullErrors.length} errores, ${fullWarns.length} avisos`}
              </summary>
              <ul className="s9-me-issues">
                {(full ?? []).map((c, k) => (
                  <li key={k} data-severity={c.severity}>
                    {c.message}
                  </li>
                ))}
              </ul>
            </details>
            {checks.length > 0 && (
              <div data-testid="editor-checks">
                <strong>Resultado del servidor al guardar:</strong>
                <ul className="s9-me-issues">
                  {checks.map((c, i) => (
                    <li
                      key={i}
                      data-severity={c.severity === "error" ? "error" : "warning"}
                      className={c.severity === "error" ? "error" : "warn"}
                    >
                      {c.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="s9-me-panel">
            <h2>Objetos ({refs.length})</h2>
            <ul className="s9-me-objlist" data-testid="editor-objects">
              {refs.map((r) => (
                <li key={refKey(r)}>
                  <button
                    type="button"
                    aria-pressed={selected?.kind === r.kind && selected.index === r.index}
                    onClick={() => setSelected(r)}
                  >
                    {objLabel(map, r)}
                    {flagged.get(refKey(r)) === "error"
                      ? " — con problema"
                      : flagged.get(refKey(r))
                        ? " — con aviso"
                        : ""}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <h2>Mis mapas</h2>
      {mineError !== null ? (
        <ErrorState label="tus mapas" error={mineError} onRetry={() => void loadMine()} />
      ) : mine === null ? (
        <LoadingState label="tus mapas" />
      ) : mine.length === 0 ? (
        <p>Aún no has guardado ningún mapa.</p>
      ) : (
        <ul data-testid="editor-mine">
          {mine.map((m) => (
            <li key={`${m.mapId}@${m.version}`}>
              <button
                type="button"
                aria-label={`abrir-${m.mapId}-v${m.version}`}
                onClick={() => void open(m.mapId, m.version)}
              >
                Abrir
              </button>{" "}
              {m.name ?? m.mapId} · v{m.version} ({stateName(m.state)})
            </li>
          ))}
        </ul>
      )}
      <h2>Guardar una copia</h2>
      <div className="s9-me-row">
        <input
          aria-label="id de la copia"
          placeholder="identificador-de-la-copia"
          value={copyId}
          onChange={(e) => setCopyId(e.target.value)}
        />
        <button
          type="button"
          disabled={busy || !copyId}
          onClick={() => void save({ ...map, mapId: copyId, version: 1 })}
        >
          Guardar como copia
        </button>
      </div>

      <details className="s9-me-fieldset" data-testid="editor-advanced">
        <summary>Opciones avanzadas: archivo JSON del mapa</summary>
        <p className="s9-me-muted">
          Para usuarios avanzados: el documento completo del mapa, el mismo que se puede subir en «Mapas».
        </p>
        <h3>Exportar</h3>
        <textarea aria-label="JSON exportado" readOnly rows={8} value={exportJson} />
        <div>
          <a
            download={`${map.mapId}.json`}
            href={`data:application/json;charset=utf-8,${encodeURIComponent(exportJson)}`}
            data-testid="editor-download"
          >
            Descargar {map.mapId}.json
          </a>{" "}
          <small>(se puede importar tal cual en «Mapas»)</small>
        </div>
        <h3>Importar</h3>
        <textarea
          aria-label="JSON a importar"
          rows={6}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
        />
        <div>
          <button
            type="button"
            onClick={() => {
              setError("");
              try {
                resetTo(parseImport(importText));
                setSaved(null);
                setDirty(true);
                setRestored(false);
              } catch (e) {
                setError(`No se pudo importar: ${(e as Error).message}`);
              }
            }}
          >
            Importar
          </button>
        </div>
      </details>
    </section>
  );
}

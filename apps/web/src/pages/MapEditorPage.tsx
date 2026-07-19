/**
 * R10 · Editor visual de mapas — FOUNDATION (slice 1, solo cliente).
 *
 * Alcance de este slice, honesto y acotado:
 *   - Modelo de mapa EN BORRADOR LOCAL (estado del componente), con el mismo formato
 *     de AUTORÍA que `maps/training-yard.json`: { schemaVersion, id, name, width,
 *     height, seed, walls[], obstacles[], spawns[] }. El export produce ese JSON tal
 *     cual, así que el roundtrip con un mapa real es significativo.
 *   - Lienzo SVG a escala, CRUD de objetos (añadir/seleccionar/editar/eliminar),
 *     export e import JSON, y validación de forma en cliente (límites, ids únicos,
 *     al menos un spawn).
 *
 * Lo que este slice NO hace (deliberadamente, para no tocar backend/seguridad):
 *   - NO persiste en el servidor: no hay endpoint para editar un draft (importMap
 *     crea desde fichero y replaceMapVersion es 409 inmutable). La persistencia
 *     (endpoint de draft + validación REAL de map-service) es un slice posterior,
 *     a revisar contra la matriz de ficheros antes de tocar OpenAPI.
 *   - NO dispara batallas ni ejecución real. NO expone secretos.
 *
 * La validación de este editor es una ayuda de autoría en cliente; la autoridad
 * sigue siendo el validador de E4/map-service cuando el mapa se importe/publique.
 */
import { useMemo, useState } from "react";

export type EditorKind = "wall" | "obstacle" | "spawn";

export interface RectObject {
  id: string;
  kind: "wall" | "obstacle";
  x: number;
  y: number;
  width: number;
  height: number;
  health?: number;
}

export interface SpawnObject {
  id: string;
  kind: "spawn";
  team: string;
  x: number;
  y: number;
  heading: number;
}

export type EditorObject = RectObject | SpawnObject;

export interface DraftMap {
  schemaVersion: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  seed: number;
  objects: EditorObject[];
}

/** Mapa de borrador por defecto: un recinto pequeño con dos spawns enfrentados. */
export function defaultDraft(): DraftMap {
  return {
    schemaVersion: 1,
    id: "nuevo-mapa",
    name: "Nuevo mapa",
    width: 800,
    height: 600,
    seed: 1,
    objects: [
      { id: "red-1", kind: "spawn", team: "red", x: 100, y: 300, heading: 0 },
      { id: "blue-1", kind: "spawn", team: "blue", x: 700, y: 300, heading: Math.PI },
    ],
  };
}

/** Proyecta el modelo interno al formato de autoría de `maps/*.json` (export). */
export function toAuthoringJson(m: DraftMap): unknown {
  const walls = m.objects
    .filter((o): o is RectObject => o.kind === "wall")
    .map(({ id, x, y, width, height }) => ({ id, kind: "wall", x, y, width, height }));
  const obstacles = m.objects
    .filter((o): o is RectObject => o.kind === "obstacle")
    .map(({ id, x, y, width, height, health }) => ({
      id,
      kind: "destructible",
      x,
      y,
      width,
      height,
      health: health ?? 60,
    }));
  const spawns = m.objects
    .filter((o): o is SpawnObject => o.kind === "spawn")
    .map(({ id, team, x, y, heading }) => ({ id, team, x, y, heading }));
  return {
    schemaVersion: m.schemaVersion,
    id: m.id,
    name: m.name,
    width: m.width,
    height: m.height,
    seed: m.seed,
    walls,
    obstacles,
    spawns,
  };
}

interface RawObj {
  id?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  health?: unknown;
  team?: unknown;
  heading?: unknown;
}

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

/** Lee el formato de autoría y reconstruye el modelo interno (import, roundtrip). */
export function fromAuthoringJson(raw: unknown): DraftMap {
  const o = (raw ?? {}) as Record<string, unknown>;
  const rects = (arr: unknown, kind: "wall" | "obstacle"): RectObject[] =>
    (Array.isArray(arr) ? arr : []).map((r: RawObj, i) => ({
      id: str(r.id, `${kind}-${i}`),
      kind,
      x: num(r.x),
      y: num(r.y),
      width: num(r.width, 10),
      height: num(r.height, 10),
      ...(kind === "obstacle" ? { health: num(r.health, 60) } : {}),
    }));
  const spawns: SpawnObject[] = (Array.isArray(o.spawns) ? o.spawns : []).map((r: RawObj, i) => ({
    id: str(r.id, `spawn-${i}`),
    kind: "spawn",
    team: str(r.team, "red"),
    x: num(r.x),
    y: num(r.y),
    heading: num(r.heading),
  }));
  return {
    schemaVersion: 1,
    id: str(o.id, "importado"),
    name: str(o.name, "Mapa importado"),
    width: num(o.width, 800),
    height: num(o.height, 600),
    seed: num(o.seed, 1),
    objects: [...rects(o.walls, "wall"), ...rects(o.obstacles, "obstacle"), ...spawns],
  };
}

/** Validación de autoría en cliente (no sustituye al validador real de E4). */
export function validateDraft(m: DraftMap): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const o of m.objects) {
    if (ids.has(o.id)) errs.push(`id duplicado: "${o.id}"`);
    ids.add(o.id);
    if (o.x < 0 || o.y < 0 || o.x > m.width || o.y > m.height) {
      errs.push(`"${o.id}" está fuera de los límites del mapa`);
    }
    if (o.kind !== "spawn") {
      if (o.width <= 0 || o.height <= 0) errs.push(`"${o.id}" tiene tamaño no positivo`);
    }
  }
  if (!m.objects.some((o) => o.kind === "spawn")) errs.push("el mapa no tiene ningún spawn");
  return errs;
}

let seq = 0;
function nextId(kind: EditorKind): string {
  seq += 1;
  return `${kind}-${seq}`;
}

const COLORS: Record<string, string> = { red: "#c0392b", blue: "#2471a3" };

export function MapEditorPage() {
  const [map, setMap] = useState<DraftMap>(defaultDraft);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");

  const selected = map.objects.find((o) => o.id === selectedId) ?? null;
  const errors = useMemo(() => validateDraft(map), [map]);
  const exportJson = useMemo(() => JSON.stringify(toAuthoringJson(map), null, 2), [map]);

  function addObject(kind: EditorKind) {
    const id = nextId(kind);
    const base = { id, x: Math.round(map.width / 2), y: Math.round(map.height / 2) };
    const obj: EditorObject =
      kind === "spawn"
        ? { ...base, kind: "spawn", team: "red", heading: 0 }
        : { ...base, kind, width: 60, height: 60, ...(kind === "obstacle" ? { health: 60 } : {}) };
    setMap((m) => ({ ...m, objects: [...m.objects, obj] }));
    setSelectedId(id);
  }

  function patchSelected(patch: Partial<Omit<RectObject, "kind">> | Partial<Omit<SpawnObject, "kind">>) {
    if (!selectedId) return;
    setMap((m) => ({
      ...m,
      objects: m.objects.map((o) => (o.id === selectedId ? ({ ...o, ...patch } as EditorObject) : o)),
    }));
  }

  function deleteSelected() {
    if (!selectedId) return;
    setMap((m) => ({ ...m, objects: m.objects.filter((o) => o.id !== selectedId) }));
    setSelectedId(null);
  }

  function doImport() {
    setImportError("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch {
      setImportError("JSON inválido");
      return;
    }
    setMap(fromAuthoringJson(parsed));
    setSelectedId(null);
  }

  // Lienzo: escala el mundo (width x height) a un máximo visible sin deformar.
  const maxPx = 640;
  const scale = Math.min(maxPx / map.width, maxPx / map.height);

  return (
    <section aria-label="Editor de mapas">
      <h1>Editor de mapas (borrador local)</h1>
      <p role="note">
        Slice de fundación: edición <strong>solo en cliente</strong>. Este editor no guarda en el servidor ni lanza
        batallas; usa <em>Exportar JSON</em> para llevar el borrador al pipeline de importación/validación real cuando
        exista el endpoint de draft.
      </p>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div role="toolbar" aria-label="Herramientas">
            <button type="button" onClick={() => addObject("wall")}>
              Añadir muro
            </button>
            <button type="button" onClick={() => addObject("obstacle")}>
              Añadir obstáculo
            </button>
            <button type="button" onClick={() => addObject("spawn")}>
              Añadir spawn
            </button>
          </div>
          <svg
            role="img"
            aria-label={`Lienzo del mapa ${map.name}`}
            width={map.width * scale}
            height={map.height * scale}
            viewBox={`0 0 ${map.width} ${map.height}`}
            style={{ border: "1px solid #888", background: "#f4f4f0" }}
          >
            {map.objects.map((o) =>
              o.kind === "spawn" ? (
                <circle
                  key={o.id}
                  cx={o.x}
                  cy={o.y}
                  r={16}
                  fill={COLORS[o.team] ?? "#555"}
                  stroke={o.id === selectedId ? "#111" : "none"}
                  strokeWidth={4}
                  onClick={() => setSelectedId(o.id)}
                  aria-label={`spawn ${o.id} (${o.team})`}
                />
              ) : (
                <rect
                  key={o.id}
                  x={o.x - o.width / 2}
                  y={o.y - o.height / 2}
                  width={o.width}
                  height={o.height}
                  fill={o.kind === "wall" ? "#666" : "#a0642d"}
                  stroke={o.id === selectedId ? "#111" : "none"}
                  strokeWidth={4}
                  onClick={() => setSelectedId(o.id)}
                  aria-label={`${o.kind} ${o.id}`}
                />
              ),
            )}
          </svg>
        </div>

        <div style={{ minWidth: 260 }}>
          <h2>Objetos ({map.objects.length})</h2>
          <ul>
            {map.objects.map((o) => (
              <li key={o.id}>
                <button type="button" aria-pressed={o.id === selectedId} onClick={() => setSelectedId(o.id)}>
                  {o.kind} · {o.id}
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <fieldset>
              <legend>Editar «{selected.id}»</legend>
              <label>
                x
                <input
                  type="number"
                  aria-label="x"
                  value={selected.x}
                  onChange={(e) => patchSelected({ x: Number(e.target.value) })}
                />
              </label>
              <label>
                y
                <input
                  type="number"
                  aria-label="y"
                  value={selected.y}
                  onChange={(e) => patchSelected({ y: Number(e.target.value) })}
                />
              </label>
              {selected.kind === "spawn" ? (
                <label>
                  equipo
                  <select
                    aria-label="equipo"
                    value={selected.team}
                    onChange={(e) => patchSelected({ team: e.target.value })}
                  >
                    <option value="red">red</option>
                    <option value="blue">blue</option>
                  </select>
                </label>
              ) : (
                <>
                  <label>
                    ancho
                    <input
                      type="number"
                      aria-label="ancho"
                      value={selected.width}
                      onChange={(e) => patchSelected({ width: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    alto
                    <input
                      type="number"
                      aria-label="alto"
                      value={selected.height}
                      onChange={(e) => patchSelected({ height: Number(e.target.value) })}
                    />
                  </label>
                </>
              )}
              <button type="button" onClick={deleteSelected}>
                Eliminar objeto
              </button>
            </fieldset>
          )}

          {errors.length > 0 && (
            <div role="alert">
              <strong>Avisos de validación (cliente):</strong>
              <ul>
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <h2>Exportar JSON</h2>
      <textarea aria-label="JSON exportado" readOnly rows={10} cols={60} value={exportJson} />

      <h2>Importar JSON</h2>
      <textarea
        aria-label="JSON a importar"
        rows={6}
        cols={60}
        value={importText}
        onChange={(e) => setImportText(e.target.value)}
      />
      <div>
        <button type="button" onClick={doImport}>
          Importar
        </button>
        {importError && <span role="alert"> {importError}</span>}
      </div>
    </section>
  );
}

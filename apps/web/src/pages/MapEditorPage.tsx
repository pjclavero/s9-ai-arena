/**
 * R10 + FC-C (TD-010) · Editor visual de mapas PERSISTENTE.
 *
 * Qué cambia respecto al slice 1 (que era solo cliente y exportaba un formato de
 * autoría que «Mapas» no sabía importar, 500):
 *  - El editor trabaja directamente sobre el FORMATO INTERNO (InternalMap, metros):
 *    lo mismo que guarda la API (map_versions.content), lo que importa «Mapas» y lo
 *    que valida E4. Exportar = ese documento; por eso export ↔ import es simétrico.
 *  - Guardar = POST /maps/drafts: el borrador vive en el SERVIDOR (BD). Mientras siga
 *    en `draft` se reescribe en sitio; tras publicarlo, guardar crea la versión
 *    siguiente. La URL (#/maps/editor?map=<id>&v=<n>) identifica lo abierto, así que
 *    F5 o cerrar y volver reabre el mapa desde la API, no desde memoria.
 *  - Abrir (mis mapas), duplicar (guardar como otro id), publicar, y la validación
 *    REAL de E4 que devuelve la API (checks) a la vista.
 *  - Importa también el JSON de autoría antiguo (px) convirtiéndolo (10 px = 1 m).
 *
 * La autorización la hace la API (solo el dueño guarda/publica su mapa); la UI solo
 * informa. La validación de cliente es una ayuda; la autoridad es validateMap (E4).
 */
import { useEffect, useMemo, useState } from "react";
import { api, ApiRequestError } from "../api.js";
import { safeLookup } from "../../../../packages/game-rules/safe-lookup.js";

export const PLATFORM_MODES = ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"] as const;

export interface Vec2 {
  x: number;
  y: number;
}
export interface RectShape {
  shape: "rect";
  position: Vec2;
  widthM: number;
  heightM: number;
  rotation?: number;
}
export interface EditorMap {
  schemaVersion: 1;
  mapId: string;
  version: number;
  checksum?: string;
  widthM: number;
  heightM: number;
  navCellSizeM?: number;
  materials: {
    id: string;
    name?: string;
    blocksMovement: boolean;
    blocksVision: boolean;
    hp?: number;
    damagePerSecond?: number;
  }[];
  layers: {
    ground: { tileSizeM: number; cols: number; rows: number; data: number[] };
    walls: RectShape[];
    destructibles?: (RectShape & { objectId: string; material: string })[];
    zones?: {
      shape: "circle";
      position: Vec2;
      radiusM: number;
      objectId: string;
      zoneType: "capture" | "damage";
      damagePerSecond?: number;
      team?: string;
    }[];
    spawns: { objectId: string; team: string; position: Vec2; heading: number }[];
    bases?: (RectShape & { objectId: string; team: string })[];
    flags?: { objectId: string; team: string; position: Vec2 }[];
    [k: string]: unknown;
  };
  meta: { name?: string; author: string; license: string; supportedModes: string[]; [k: string]: unknown };
  [k: string]: unknown;
}

export type ObjKind = "wall" | "destructible" | "spawn" | "base" | "flag" | "zone";
export interface ObjRef {
  kind: ObjKind;
  index: number;
}

const TILE = 2;
const DEFAULT_MATERIALS: EditorMap["materials"] = [
  { id: "floor", name: "Suelo", blocksMovement: false, blocksVision: false },
  { id: "concrete", name: "Muro de hormigón", blocksMovement: true, blocksVision: true },
  { id: "crate", name: "Caja destructible", blocksMovement: true, blocksVision: true, hp: 120 },
  { id: "acid", name: "Zona corrosiva", blocksMovement: false, blocksVision: false, damagePerSecond: 8 },
];

function ground(widthM: number, heightM: number) {
  const cols = Math.max(1, Math.ceil(widthM / TILE));
  const rows = Math.max(1, Math.ceil(heightM / TILE));
  return { tileSizeM: TILE, cols, rows, data: new Array(cols * rows).fill(0) };
}

/** Mapa nuevo: 120×80 m, dos spawns enfrentados, deathmatch + team_deathmatch. */
export function newMap(mapId = "mi-mapa", name = "Mi mapa"): EditorMap {
  const widthM = 120;
  const heightM = 80;
  return {
    schemaVersion: 1,
    mapId,
    version: 1,
    widthM,
    heightM,
    navCellSizeM: 0.5,
    materials: DEFAULT_MATERIALS.map((m) => ({ ...m })),
    layers: {
      ground: ground(widthM, heightM),
      walls: [],
      destructibles: [],
      zones: [],
      spawns: [
        { objectId: "sp_red_1", team: "red", position: { x: 10, y: 40 }, heading: 0 },
        { objectId: "sp_blue_1", team: "blue", position: { x: 110, y: 40 }, heading: Math.PI },
      ],
      bases: [],
      flags: [],
    },
    meta: { name, author: "editor", license: "CC-BY-4.0", supportedModes: ["deathmatch", "team_deathmatch"] },
  };
}

/** Cambia dimensiones regenerando la rejilla de suelo (cols*rows debe cuadrar, E4 geometry). */
export function resize(m: EditorMap, widthM: number, heightM: number): EditorMap {
  return { ...m, widthM, heightM, layers: { ...m.layers, ground: ground(widthM, heightM) } };
}

export function toggleMode(m: EditorMap, mode: string): EditorMap {
  const has = m.meta.supportedModes.includes(mode);
  const supportedModes = has ? m.meta.supportedModes.filter((x) => x !== mode) : [...m.meta.supportedModes, mode];
  return { ...m, meta: { ...m.meta, supportedModes } };
}

const PX_PER_M = 10;
/** Formato de autoría antiguo (slice 1, px) → InternalMap (m). */
export function fromLegacyAuthoring(raw: Record<string, unknown>): EditorMap {
  const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const str = (v: unknown, d: string) => (typeof v === "string" && v ? v : d);
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const widthM = Math.round(num(raw.width, 800) / PX_PER_M);
  const heightM = Math.round(num(raw.height, 600) / PX_PER_M);
  const slug =
    str(raw.id, "importado")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "importado";
  const m = newMap(slug.length >= 2 ? slug : `${slug}-mapa`, str(raw.name, "Mapa importado"));
  const rect = (r: Record<string, unknown>): RectShape => ({
    shape: "rect",
    position: { x: num(r.x) / PX_PER_M, y: num(r.y) / PX_PER_M },
    widthM: num(r.width, 10) / PX_PER_M,
    heightM: num(r.height, 10) / PX_PER_M,
  });
  return {
    ...resize(m, widthM, heightM),
    layers: {
      ...resize(m, widthM, heightM).layers,
      walls: arr(raw.walls).map(rect),
      destructibles: arr(raw.obstacles).map((r, i) => ({
        ...rect(r),
        objectId: str(r.id, `crate-${i}`),
        material: "crate",
      })),
      spawns: arr(raw.spawns).map((r, i) => ({
        objectId: str(r.id, `spawn-${i}`),
        team: str(r.team, "red"),
        position: { x: num(r.x) / PX_PER_M, y: num(r.y) / PX_PER_M },
        heading: num(r.heading),
      })),
    },
  };
}

/** Import del editor: InternalMap tal cual, o autoría antigua convertida. Lanza si no es ninguno. */
export function parseImport(text: string): EditorMap {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("El JSON no es un objeto de mapa");
  if (raw.layers && typeof raw.mapId === "string") {
    const m = raw as unknown as EditorMap;
    if (!m.layers.ground || !Array.isArray(m.layers.walls) || !Array.isArray(m.layers.spawns) || !m.meta) {
      throw new Error("Mapa interno incompleto (faltan layers.ground/walls/spawns o meta)");
    }
    return m;
  }
  if (typeof raw.id === "string" && typeof raw.width === "number") return fromLegacyAuthoring(raw);
  throw new Error("Formato no reconocido: se espera un mapa interno (mapId, layers) o el JSON de autoría antiguo");
}

/** Documento a enviar/exportar: sin version/checksum (los fija el servidor). */
export function toDocument(m: EditorMap): EditorMap {
  const { checksum: _c, ...rest } = m;
  return rest as EditorMap;
}

/** Validación de autoría en cliente (ayuda; la autoridad es E4 en la API). */
export function validateDraft(m: EditorMap): string[] {
  const errs: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(m.mapId)) errs.push("id de mapa: minúsculas, dígitos y guiones (2-63)");
  const inside = (p: Vec2, id: string) => {
    if (p.x < 0 || p.y < 0 || p.x > m.widthM || p.y > m.heightM) errs.push(`"${id}" está fuera de los límites`);
  };
  m.layers.spawns.forEach((s) => inside(s.position, s.objectId));
  m.layers.walls.forEach((w, i) => inside(w.position, `muro ${i + 1}`));
  if (m.layers.spawns.length === 0) errs.push("el mapa no tiene ningún spawn");
  if (m.meta.supportedModes.length === 0) errs.push("marca al menos un modo soportado");
  return errs;
}

interface Check {
  check: string;
  severity: string;
  message: string;
}
interface SavedVersion {
  mapId: string;
  version: number;
  state: string;
  name?: string;
  checks?: Check[];
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

const TEAM_COLORS: Record<string, string> = { red: "#c0392b", blue: "#2471a3" };
let seq = 0;

export function MapEditorPage() {
  const [map, setMap] = useState<EditorMap>(() => newMap());
  const [saved, setSaved] = useState<SavedVersion | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<ObjRef | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mine, setMine] = useState<SavedVersion[] | null>(null);
  const [importText, setImportText] = useState("");
  const [copyId, setCopyId] = useState("");

  const clientErrors = useMemo(() => validateDraft(map), [map]);
  const exportJson = useMemo(() => JSON.stringify(toDocument(map), null, 2), [map]);

  async function open(mapId: string, version: number) {
    setError("");
    setBusy(true);
    try {
      const [meta, content] = await Promise.all([
        api<SavedVersion>("GET", `/maps/${encodeURIComponent(mapId)}/versions/${version}`),
        api<EditorMap>("GET", `/maps/${encodeURIComponent(mapId)}/versions/${version}/content`),
      ]);
      setMap(content);
      setSaved(meta);
      setDirty(false);
      setSelected(null);
      setChecks([]);
      writeHash(mapId, version);
      setNotice(`Abierto ${mapId} v${version} (${meta.state}).`);
    } catch (e) {
      setError(`No se pudo abrir ${mapId} v${version}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadMine() {
    try {
      const page = await api<{ items: SavedVersion[] }>("GET", "/maps?mine=true&limit=100");
      setMine(page.items);
    } catch (e) {
      setError(`No se pudo cargar «mis mapas»: ${(e as Error).message}`);
    }
  }

  // F5 / volver al editor: la URL dice qué mapa está abierto; se reabre DESDE LA API.
  useEffect(() => {
    const h = readHash();
    if (h.map && h.v) void open(h.map, h.v);
    void loadMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function edit(fn: (m: EditorMap) => EditorMap) {
    setMap((m) => fn(m));
    setDirty(true);
  }

  async function save(doc: EditorMap = map) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const r = await api<SavedVersion>("POST", "/maps/drafts", toDocument(doc));
      setSaved(r);
      setChecks(r.checks ?? []);
      setMap({ ...doc, version: r.version });
      setDirty(false);
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
      const body = e instanceof ApiRequestError ? (e.body as { checks?: Check[] }) : {};
      if (Array.isArray(body.checks)) setChecks(body.checks);
      setError(`No se pudo publicar: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function addObject(kind: ObjKind) {
    seq += 1;
    const c = { x: Math.round(map.widthM / 2), y: Math.round(map.heightM / 2) };
    edit((m) => {
      const L = { ...m.layers };
      const rect = (w: number, h: number): RectShape => ({ shape: "rect", position: { ...c }, widthM: w, heightM: h });
      if (kind === "wall") L.walls = [...L.walls, rect(4, 12)];
      if (kind === "destructible")
        L.destructibles = [...(L.destructibles ?? []), { ...rect(2, 2), objectId: `crate-${seq}`, material: "crate" }];
      if (kind === "spawn")
        L.spawns = [...L.spawns, { objectId: `sp-${seq}`, team: "red", position: { ...c }, heading: 0 }];
      if (kind === "base") L.bases = [...(L.bases ?? []), { ...rect(8, 12), objectId: `base-${seq}`, team: "red" }];
      if (kind === "flag") L.flags = [...(L.flags ?? []), { objectId: `flag-${seq}`, team: "red", position: { ...c } }];
      if (kind === "zone")
        L.zones = [
          ...(L.zones ?? []),
          { shape: "circle", position: { ...c }, radiusM: 6, objectId: `zone-${seq}`, zoneType: "capture" },
        ];
      return { ...m, layers: L };
    });
  }

  const listOf = (kind: ObjKind): { position: Vec2; [k: string]: unknown }[] => {
    const L = map.layers;
    return (
      ((kind === "wall"
        ? L.walls
        : kind === "destructible"
          ? L.destructibles
          : kind === "spawn"
            ? L.spawns
            : kind === "base"
              ? L.bases
              : kind === "flag"
                ? L.flags
                : L.zones) as never) ?? []
    );
  };
  const layerKey: Record<ObjKind, string> = {
    wall: "walls",
    destructible: "destructibles",
    spawn: "spawns",
    base: "bases",
    flag: "flags",
    zone: "zones",
  };
  function patch(ref: ObjRef, fn: (o: Record<string, unknown>) => Record<string, unknown>) {
    edit((m) => {
      const key = layerKey[ref.kind];
      const arr = [...((m.layers[key] as Record<string, unknown>[]) ?? [])];
      arr[ref.index] = fn(arr[ref.index]);
      return { ...m, layers: { ...m.layers, [key]: arr } };
    });
  }
  function remove(ref: ObjRef) {
    edit((m) => {
      const key = layerKey[ref.kind];
      const arr = ((m.layers[key] as unknown[]) ?? []).filter((_, i) => i !== ref.index);
      return { ...m, layers: { ...m.layers, [key]: arr } };
    });
    setSelected(null);
  }

  const sel = selected ? (listOf(selected.kind)[selected.index] as Record<string, unknown> | undefined) : undefined;
  const scale = Math.min(640 / map.widthM, 480 / map.heightM);
  const allObjects: (ObjRef & { label: string })[] = (
    ["wall", "destructible", "spawn", "base", "flag", "zone"] as ObjKind[]
  ).flatMap((kind) =>
    listOf(kind).map((o, index) => ({ kind, index, label: `${kind} · ${(o.objectId as string) ?? index + 1}` })),
  );

  return (
    <section aria-label="Editor de mapas">
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
            ({saved.state}){dirty ? " · cambios sin guardar" : " · guardado"}
          </>
        ) : (
          " Mapa nuevo, aún sin guardar."
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
      <fieldset>
        <legend>Mapa</legend>
        <label>
          Id{" "}
          <input
            aria-label="id del mapa"
            value={map.mapId}
            onChange={(e) => edit((m) => ({ ...m, mapId: e.target.value }))}
          />
        </label>{" "}
        <label>
          Nombre{" "}
          <input
            aria-label="nombre del mapa"
            value={map.meta.name ?? ""}
            onChange={(e) => edit((m) => ({ ...m, meta: { ...m.meta, name: e.target.value } }))}
          />
        </label>{" "}
        <label>
          Ancho (m){" "}
          <input
            type="number"
            aria-label="ancho del mapa"
            value={map.widthM}
            onChange={(e) => edit((m) => resize(m, Number(e.target.value), m.heightM))}
          />
        </label>{" "}
        <label>
          Alto (m){" "}
          <input
            type="number"
            aria-label="alto del mapa"
            value={map.heightM}
            onChange={(e) => edit((m) => resize(m, m.widthM, Number(e.target.value)))}
          />
        </label>
        <div role="group" aria-label="modos soportados">
          Modos:{" "}
          {PLATFORM_MODES.map((mode) => (
            <label key={mode}>
              <input
                type="checkbox"
                aria-label={`modo ${mode}`}
                checked={map.meta.supportedModes.includes(mode)}
                onChange={() => edit((m) => toggleMode(m, mode))}
              />
              {mode}{" "}
            </label>
          ))}
        </div>
      </fieldset>
      <div role="toolbar" aria-label="Herramientas">
        <button
          type="button"
          onClick={() => {
            setMap(newMap());
            setSaved(null);
            setDirty(false);
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
        {" | "}
        {(["wall", "destructible", "spawn", "base", "flag", "zone"] as ObjKind[]).map((k) => (
          <button key={k} type="button" onClick={() => addObject(k)}>
            Añadir {k}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <svg
          role="img"
          aria-label={`Lienzo del mapa ${map.meta.name ?? map.mapId}`}
          width={map.widthM * scale}
          height={map.heightM * scale}
          viewBox={`0 0 ${map.widthM} ${map.heightM}`}
          style={{ border: "1px solid #888", background: "#f4f4f0" }}
        >
          {map.layers.walls.map((w, i) => (
            <rect
              key={`w${i}`}
              x={w.position.x - w.widthM / 2}
              y={w.position.y - w.heightM / 2}
              width={w.widthM}
              height={w.heightM}
              fill="#666"
              onClick={() => setSelected({ kind: "wall", index: i })}
            />
          ))}
          {(map.layers.destructibles ?? []).map((d, i) => (
            <rect
              key={`d${i}`}
              x={d.position.x - d.widthM / 2}
              y={d.position.y - d.heightM / 2}
              width={d.widthM}
              height={d.heightM}
              fill="#a0642d"
              onClick={() => setSelected({ kind: "destructible", index: i })}
            />
          ))}
          {(map.layers.zones ?? []).map((z, i) => (
            <circle
              key={`z${i}`}
              cx={z.position.x}
              cy={z.position.y}
              r={z.radiusM}
              fill={z.zoneType === "capture" ? "#f1c40f55" : "#27ae6055"}
              onClick={() => setSelected({ kind: "zone", index: i })}
            />
          ))}
          {(map.layers.bases ?? []).map((b, i) => (
            <rect
              key={`b${i}`}
              x={b.position.x - b.widthM / 2}
              y={b.position.y - b.heightM / 2}
              width={b.widthM}
              height={b.heightM}
              fill="none"
              stroke={safeLookup(TEAM_COLORS, b.team) ?? "#555"}
              strokeWidth={0.6}
              onClick={() => setSelected({ kind: "base", index: i })}
            />
          ))}
          {(map.layers.flags ?? []).map((f, i) => (
            <rect
              key={`f${i}`}
              x={f.position.x - 0.8}
              y={f.position.y - 0.8}
              width={1.6}
              height={1.6}
              fill={safeLookup(TEAM_COLORS, f.team) ?? "#555"}
              onClick={() => setSelected({ kind: "flag", index: i })}
            />
          ))}
          {map.layers.spawns.map((s, i) => (
            <circle
              key={`s${i}`}
              cx={s.position.x}
              cy={s.position.y}
              r={1.6}
              fill={safeLookup(TEAM_COLORS, s.team) ?? "#555"}
              onClick={() => setSelected({ kind: "spawn", index: i })}
              aria-label={`spawn ${s.objectId} (${s.team})`}
            />
          ))}
        </svg>

        <div style={{ minWidth: 260 }}>
          <h2>Objetos ({allObjects.length})</h2>
          <ul>
            {allObjects.map((o) => (
              <li key={`${o.kind}-${o.index}`}>
                <button
                  type="button"
                  aria-pressed={selected?.kind === o.kind && selected.index === o.index}
                  onClick={() => setSelected({ kind: o.kind, index: o.index })}
                >
                  {o.label}
                </button>
              </li>
            ))}
          </ul>
          {selected && sel && (
            <fieldset>
              <legend>Editar {selected.kind}</legend>
              <label>
                x{" "}
                <input
                  type="number"
                  aria-label="x"
                  value={(sel.position as Vec2).x}
                  onChange={(e) =>
                    patch(selected, (o) => ({ ...o, position: { ...(o.position as Vec2), x: Number(e.target.value) } }))
                  }
                />
              </label>
              <label>
                y{" "}
                <input
                  type="number"
                  aria-label="y"
                  value={(sel.position as Vec2).y}
                  onChange={(e) =>
                    patch(selected, (o) => ({ ...o, position: { ...(o.position as Vec2), y: Number(e.target.value) } }))
                  }
                />
              </label>
              {"widthM" in sel && (
                <>
                  <label>
                    ancho{" "}
                    <input
                      type="number"
                      aria-label="ancho"
                      value={sel.widthM as number}
                      onChange={(e) => patch(selected, (o) => ({ ...o, widthM: Number(e.target.value) }))}
                    />
                  </label>
                  <label>
                    alto{" "}
                    <input
                      type="number"
                      aria-label="alto"
                      value={sel.heightM as number}
                      onChange={(e) => patch(selected, (o) => ({ ...o, heightM: Number(e.target.value) }))}
                    />
                  </label>
                </>
              )}
              {"radiusM" in sel && (
                <label>
                  radio{" "}
                  <input
                    type="number"
                    aria-label="radio"
                    value={sel.radiusM as number}
                    onChange={(e) => patch(selected, (o) => ({ ...o, radiusM: Number(e.target.value) }))}
                  />
                </label>
              )}
              {"team" in sel && (
                <label>
                  equipo{" "}
                  <select
                    aria-label="equipo"
                    value={sel.team as string}
                    onChange={(e) => patch(selected, (o) => ({ ...o, team: e.target.value }))}
                  >
                    <option value="red">red</option>
                    <option value="blue">blue</option>
                  </select>
                </label>
              )}
              {"zoneType" in sel && (
                <label>
                  tipo{" "}
                  <select
                    aria-label="tipo de zona"
                    value={sel.zoneType as string}
                    onChange={(e) => patch(selected, (o) => ({ ...o, zoneType: e.target.value }))}
                  >
                    <option value="capture">captura</option>
                    <option value="damage">daño</option>
                  </select>
                </label>
              )}
              <button type="button" onClick={() => remove(selected)}>
                Eliminar objeto
              </button>
            </fieldset>
          )}
          {clientErrors.length > 0 && (
            <div role="alert" data-testid="editor-client-errors">
              <strong>Avisos (cliente):</strong>
              <ul>
                {clientErrors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {checks.length > 0 && (
            <div data-testid="editor-checks">
              <strong>Validación del servidor (E4):</strong>
              <ul>
                {checks.map((c, i) => (
                  <li key={i} className={c.severity === "error" ? "error" : "warn"}>
                    [{c.check}] {c.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      <h2>Mis mapas</h2>
      {mine === null ? (
        <p>Cargando…</p>
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
              {m.name ?? m.mapId} · {m.mapId} v{m.version} ({m.state})
            </li>
          ))}
        </ul>
      )}
      <h2>Duplicar</h2>
      <input
        aria-label="id de la copia"
        placeholder="nuevo-id"
        value={copyId}
        onChange={(e) => setCopyId(e.target.value)}
      />{" "}
      <button type="button" disabled={busy || !copyId} onClick={() => void save({ ...map, mapId: copyId, version: 1 })}>
        Guardar como copia
      </button>
      <h2>Exportar JSON (mapa interno)</h2>
      <textarea aria-label="JSON exportado" readOnly rows={8} cols={60} value={exportJson} />
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
      <h2>Importar JSON</h2>
      <textarea
        aria-label="JSON a importar"
        rows={6}
        cols={60}
        value={importText}
        onChange={(e) => setImportText(e.target.value)}
      />
      <div>
        <button
          type="button"
          onClick={() => {
            setError("");
            try {
              setMap(parseImport(importText));
              setSaved(null);
              setDirty(true);
              setSelected(null);
            } catch (e) {
              setError(`No se pudo importar: ${(e as Error).message}`);
            }
          }}
        >
          Importar
        </button>
      </div>
    </section>
  );
}

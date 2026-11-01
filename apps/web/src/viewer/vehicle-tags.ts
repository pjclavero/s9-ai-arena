/**
 * UX-VIEW · Vida, nombre y marcas sobre los vehículos — lógica PURA.
 *
 * Antes el nombre iba DENTRO del contenedor que rota con el casco (giraba con el
 * tanque y escalaba con el zoom) y no había vida en el canvas. Aquí se decide,
 * sin Phaser:
 *  - QUÉ se ve de cada vehículo (nombre, barra fina de vida, detalle) según la
 *    preferencia, el zoom y la densidad — el detalle sólo para el seleccionado;
 *  - CÓMO se distingue aliado/enemigo/seleccionado/destruido/reaparición SIN
 *    depender sólo del color: forma de la marca bajo el vehículo, anillo y
 *    esquinas de selección, aspa de destruido, anillo discontinuo de reaparición
 *    y texto (KO, REAPARECE);
 *  - el DESPEJE de etiquetas que se solaparían (densidad), conservando siempre la
 *    del seleccionado.
 * Tamaños en píxeles CSS de PANTALLA: la escena los convierte para que no
 * escalen con el zoom.
 */

export type HealthPref = "bar" | "selected" | "off";
export type NamePref = "auto" | "all" | "selected" | "off";

export interface TagPrefs {
  health: HealthPref;
  names: NamePref;
}

export const DEFAULT_TAG_PREFS: TagPrefs = { health: "bar", names: "auto" };

export type Relation = "ally" | "enemy" | "none";
export type MarkerShape = "circle" | "diamond" | "square" | "triangle";
export type LifeState = "alive" | "destroyed" | "respawning";

/** Tras volver a la vida (alive false→true), cuánto dura la marca de reaparición. */
export const RESPAWN_MARK_MS = 2500;
/** Por debajo de estos px CSS por metro el zoom es «bajo»: se simplifica. */
export const LOW_ZOOM_PX_PER_M = 5;
/** Con más vehículos visibles que esto, «auto» oculta los nombres salvo el del seleccionado. */
export const DENSE_COUNT = 10;

export interface TagInput {
  id: string;
  label: string;
  team?: string;
  /** Índice estable del bando (orden de la nómina): 0, 1, 2… o -1 sin bando. */
  teamIndex: number;
  life: LifeState;
  /** Vida del casco 0..1 (null si el snapshot no la trae). */
  hpRatio: number | null;
  selected: boolean;
  relation: Relation;
}

export interface TagContext {
  prefs: TagPrefs;
  /** Escala actual en px CSS por metro. */
  cssPxPerM: number;
  /** Vehículos dentro de la vista. */
  visibleCount: number;
}

export interface TagPlan {
  showName: boolean;
  /** Texto del nombre (con KO / REAPARECE cuando procede). */
  nameText: string;
  showBar: boolean;
  /** Detalle (porcentaje) junto a la barra: sólo el seleccionado. */
  showDetail: boolean;
  detailText: string;
  barWidthPx: number;
  barHeightPx: number;
  /** Separación vertical desde el centro del vehículo hasta la barra (px CSS). */
  offsetPx: number;
  shape: MarkerShape;
  /** Anillo grueso + esquinas de selección. */
  selectedRing: boolean;
  /** Anillo discontinuo de reaparición. */
  dashedRing: boolean;
  /** Aspa de destruido. */
  cross: boolean;
}

/** Forma de la marca: por relación si hay perspectiva; si no, por bando. */
export function markerShape(relation: Relation, teamIndex: number): MarkerShape {
  if (relation === "ally") return "circle";
  if (relation === "enemy") return "diamond";
  const shapes: MarkerShape[] = ["circle", "diamond", "square", "triangle"];
  return teamIndex >= 0 ? shapes[teamIndex % shapes.length] : "square";
}

export function relationTo(team: string | undefined, perspective: string | null | undefined): Relation {
  if (!perspective || !team) return "none";
  return team === perspective ? "ally" : "enemy";
}

/**
 * Estado de vida para el dibujo: destruido mientras `alive` es false; en
 * reaparición durante RESPAWN_MARK_MS tras volver a estar vivo.
 */
export function lifeState(alive: boolean, respawnedAtMs: number | undefined, nowMs: number): LifeState {
  if (!alive) return "destroyed";
  if (respawnedAtMs !== undefined && nowMs - respawnedAtMs >= 0 && nowMs - respawnedAtMs < RESPAWN_MARK_MS) {
    return "respawning";
  }
  return "alive";
}

export function planTag(t: TagInput, ctx: TagContext): TagPlan {
  const low = ctx.cssPxPerM < LOW_ZOOM_PX_PER_M;
  const dense = ctx.visibleCount > DENSE_COUNT;
  const names = ctx.prefs.names;
  let showName: boolean;
  if (names === "off") showName = false;
  else if (names === "selected") showName = t.selected;
  else if (names === "all") showName = true;
  else showName = t.selected || (!low && !dense);

  const health = ctx.prefs.health;
  const showBar =
    t.life !== "destroyed" && t.hpRatio !== null && (health === "bar" || (health === "selected" && t.selected));

  const suffix = t.life === "destroyed" ? " KO" : t.life === "respawning" ? " REAPARECE" : "";
  const hp = t.hpRatio === null ? null : Math.round(Math.max(0, Math.min(1, t.hpRatio)) * 100);
  return {
    showName,
    nameText: `${t.label}${suffix}`,
    showBar,
    showDetail: t.selected && hp !== null && t.life !== "destroyed",
    detailText: hp === null ? "" : `${hp}%`,
    // Barra FINA: 3 px (4 el seleccionado); más corta con zoom bajo para no tapar.
    barWidthPx: t.selected ? 34 : low ? 18 : 26,
    barHeightPx: t.selected ? 4 : 3,
    offsetPx: Math.max(14, Math.min(40, ctx.cssPxPerM * 2.2)),
    shape: markerShape(t.relation, t.teamIndex),
    selectedRing: t.selected,
    dashedRing: t.life === "respawning",
    cross: t.life === "destroyed",
  };
}

export interface LabelBox {
  id: string;
  /** Centro de la etiqueta en px de pantalla. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Mayor = más importante (el seleccionado gana siempre). */
  priority: number;
}

/**
 * Despeje por densidad: recorre las etiquetas de mayor a menor prioridad (y por
 * id, determinista) y oculta la que se solaparía con una ya colocada. Devuelve
 * los ids que se dibujan.
 */
export function declutterLabels(boxes: LabelBox[]): Set<string> {
  const order = [...boxes].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const placed: LabelBox[] = [];
  const shown = new Set<string>();
  for (const b of order) {
    const hit = placed.some((p) => Math.abs(p.x - b.x) * 2 < p.w + b.w && Math.abs(p.y - b.y) * 2 < p.h + b.h);
    if (hit) continue;
    placed.push(b);
    shown.add(b.id);
  }
  return shown;
}

/** Puntos (px, relativos al centro) del contorno de una marca de radio r. */
export function markerOutline(shape: MarkerShape, r: number): { x: number; y: number }[] {
  if (shape === "diamond") {
    return [
      { x: 0, y: -r },
      { x: r, y: 0 },
      { x: 0, y: r },
      { x: -r, y: 0 },
    ];
  }
  if (shape === "square") {
    const s = r * 0.8;
    return [
      { x: -s, y: -s },
      { x: s, y: -s },
      { x: s, y: s },
      { x: -s, y: s },
    ];
  }
  if (shape === "triangle") {
    return [
      { x: 0, y: -r },
      { x: r * 0.87, y: r * 0.5 },
      { x: -r * 0.87, y: r * 0.5 },
    ];
  }
  return []; // círculo: se dibuja con strokeCircle
}

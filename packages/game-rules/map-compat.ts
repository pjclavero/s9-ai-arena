/**
 * ADR-022 · Compatibilidad MAPA ↔ MODO en un solo sitio (puro, sin BD).
 *
 * Reglas (las mismas que la publicación de mapas, cap. 14.3, ahora compartidas):
 *  - capture_the_flag: base Y bandera de al menos 2 equipos;
 *  - zone_control:      al menos una zona de captura;
 *  - team_deathmatch:   spawns de al menos 2 equipos;
 *  - deathmatch:        al menos 2 spawns.
 * Lo usan: la validación de mapas (map-service), POST /battles y rules-check (defensa
 * para mapas antiguos) y GET /maps (`modeCompatibility`, para que la UI explique POR QUÉ
 * un mapa no sale para un modo).
 */

/** Forma mínima del documento de mapa interno (map-service `InternalMap`). */
export interface MapCompatInput {
  meta?: { supportedModes?: unknown };
  layers?: {
    spawns?: { team?: unknown }[];
    bases?: { team?: unknown }[];
    flags?: { team?: unknown }[];
    zones?: { zoneType?: unknown }[];
  };
}

export const MAP_COMPAT_MODES = ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"] as const;
export type MapCompatMode = (typeof MAP_COMPAT_MODES)[number];

const MODE_NAMES: Record<MapCompatMode, string> = {
  deathmatch: "Deathmatch",
  team_deathmatch: "Deathmatch por equipos",
  capture_the_flag: "Capturar la bandera",
  zone_control: "Control de zona",
};

const arr = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
const teamsOf = (xs: { team?: unknown }[]) =>
  new Set(xs.map((x) => x.team).filter((t): t is string => typeof t === "string"));

/** Equipos con base Y bandera (los que pueden jugar CTF). */
export function ctfTeams(map: MapCompatInput): string[] {
  const bases = teamsOf(arr(map.layers?.bases));
  return [...teamsOf(arr(map.layers?.flags))].filter((t) => bases.has(t)).sort();
}

/**
 * Problemas ESTRUCTURALES del mapa para un modo (lista vacía = el mapa tiene lo que el
 * modo necesita). Mensajes para personas: la UI los enseña tal cual.
 */
export function mapModeProblems(map: MapCompatInput, mode: string): string[] {
  const spawns = arr(map.layers?.spawns);
  const zones = arr(map.layers?.zones);
  switch (mode) {
    case "capture_the_flag": {
      const flags = arr(map.layers?.flags);
      if (flags.length === 0) return ["no tiene banderas (CTF necesita base y bandera de al menos 2 equipos)"];
      const ready = ctfTeams(map);
      if (ready.length < 2) {
        return [
          `CTF necesita base Y bandera de al menos 2 equipos; sólo ${ready.length} lo cumple${ready.length === 1 ? "" : "n"}${ready.length ? ` (${ready.join(", ")})` : ""}`,
        ];
      }
      return [];
    }
    case "zone_control":
      return zones.some((z) => z.zoneType === "capture")
        ? []
        : ["no tiene ninguna zona de captura (Control de zona necesita al menos una)"];
    case "team_deathmatch": {
      const n = teamsOf(spawns).size;
      return n >= 2 ? [] : [`necesita spawns de al menos 2 bandos (tiene ${n})`];
    }
    case "deathmatch":
      return spawns.length >= 2 ? [] : [`necesita al menos 2 spawns (tiene ${spawns.length})`];
    default:
      return [`modo desconocido: ${mode}`];
  }
}

export interface ModeCompatibility {
  /** ¿Se puede elegir el mapa para el modo? (declarado Y estructuralmente válido). */
  ok: boolean;
  /** ¿El autor declaró el modo en `meta.supportedModes`? */
  declared: boolean;
  /** Motivos legibles si no es compatible. */
  reasons: string[];
}

/** Compatibilidad con cada modo de plataforma, con el porqué (GET /maps). */
export function mapModeCompatibility(map: MapCompatInput): Record<MapCompatMode, ModeCompatibility> {
  const declaredList = Array.isArray(map.meta?.supportedModes) ? (map.meta!.supportedModes as unknown[]) : [];
  const out = {} as Record<MapCompatMode, ModeCompatibility>;
  for (const mode of MAP_COMPAT_MODES) {
    const declared = declaredList.includes(mode);
    const problems = mapModeProblems(map, mode);
    const reasons = [
      ...(declared ? [] : [`el autor del mapa no lo declaró compatible con ${MODE_NAMES[mode]}`]),
      ...problems,
    ];
    out[mode] = { ok: declared && problems.length === 0, declared, reasons };
  }
  return out;
}

/**
 * Etiquetas de bando de una batalla frente al mapa. En CTF cada bando debe tener SU base
 * y SU bandera en el mapa (el motor no inventa banderas): «red»/«blue» en los publicados.
 */
export function teamMapProblems(map: MapCompatInput, mode: string, teams: readonly string[]): string[] {
  if (mode !== "capture_the_flag") return [];
  const ready = new Set(ctfTeams(map));
  return [...new Set(teams)]
    .filter((t) => !ready.has(t))
    .map(
      (t) =>
        `el bando «${t}» no tiene base y bandera en el mapa (bandos válidos: ${[...ready].join(", ") || "ninguno"})`,
    );
}

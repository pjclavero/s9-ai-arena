/**
 * R3.4 · Dirección artística del VISOR (ERR-VIS-05) — lógica PURA y testeable.
 *
 * Construye la capa artística SOBRE la infraestructura batcheable de R3.3 (atlas
 * de una sola textura + setTint + BitmapText) sin romperla:
 *  - selección de SPRITE MODULAR por chasis del loadout (explorador/artillero/
 *    pesado se distinguen de un vistazo);
 *  - color por EQUIPO resuelto desde la capa de reglas (game-rules/art-direction),
 *    nunca con literales en el render (DoD: "sin colores hardcodeados");
 *  - NOMBRE del bot sobre el vehículo en vez del id crudo (UUID).
 *
 * No toca el DOM ni Phaser: se prueba con vitest en Node (apps/web/tests).
 */
import { resolveTeamColors, NEUTRAL_TEAM_COLOR } from "../../../../packages/game-rules/art-direction.js";

export { resolveTeamColors, NEUTRAL_TEAM_COLOR };

/**
 * Paleta de ENTORNO/EFECTOS del visor (no depende del equipo). Centralizarla aquí
 * fija la dirección artística única: el render referencia nombres, no literales.
 */
export const S9_ENV = {
  background: "#101410",
  ground: 0x18201a,
  wall: 0x3a4440,
  destructible: 0x6a5a30,
  /** Trazadora de proyectil (chispa cálida): efecto, no color de equipo. */
  tracer: 0xffe066,
  /** Tinte del nombre del bot sobre el vehículo. */
  label: 0xf2f5f0,
} as const;

/** Los tres arquetipos que un espectador debe distinguir de un vistazo. */
export type ChassisKind = "scout" | "gunner" | "heavy";

/**
 * Arquetipo a partir del id de chasis (mismo criterio que archetypeForChassis de
 * E6): light → explorador, heavy → pesado, el resto (medium…) → artillero.
 * Tolera ids versionados ("chassis.light@2") y ausencia de dato.
 */
export function chassisKind(chassisId?: string | null): ChassisKind {
  const base = (chassisId ?? "").split("@")[0];
  if (base === "chassis.light") return "scout";
  if (base === "chassis.heavy") return "heavy";
  return "gunner";
}

/** Frame del atlas para el CASCO según arquetipo (siluetas distintas en atlas.ts). */
export const BODY_FRAME: Record<ChassisKind, string> = {
  scout: "body-scout",
  gunner: "body-gunner",
  heavy: "body-heavy",
};

export function bodyFrameForChassis(chassisId?: string | null): string {
  return BODY_FRAME[chassisKind(chassisId)];
}

/**
 * R16.1 · Frame del atlas para la TORRETA según arquetipo (turret-scout /
 * turret-gunner / turret-heavy en atlas-geometry.ts). Sustituye al antiguo
 * frame único "turret": cada chasis luce una torreta distinta, igual que ya
 * ocurre con el casco (BODY_FRAME). Mismo criterio de fallback que
 * bodyFrameForChassis (chassisKind ya resuelve id ausente/desconocido a
 * "gunner").
 */
export const TURRET_FRAME: Record<ChassisKind, string> = {
  scout: "turret-scout",
  gunner: "turret-gunner",
  heavy: "turret-heavy",
};

export function turretFrameForChassis(chassisId?: string | null): string {
  return TURRET_FRAME[chassisKind(chassisId)];
}

/**
 * R16.1 · Frame de la secuencia de EXPLOSIÓN (explosion-0/1/2 en
 * atlas-geometry.ts) según la edad del efecto en ms desde su nacimiento.
 * Lógica de SELECCIÓN separada del pintado (que vive en drawExplosionFrame,
 * atlas-geometry.ts) y del sistema de partículas (effects.ts): puro y
 * testeable sin Phaser. Tramos: núcleo brillante (0-110ms) → estallido
 * dentado (110-220ms) → anillos difusos hasta el final del efecto (220ms+,
 * frame estable — el propio EffectSpec decide cuándo el efecto expira).
 */
export function explosionFrameForAge(ageMs: number): string {
  if (ageMs < 110) return "explosion-0";
  if (ageMs < 220) return "explosion-1";
  return "explosion-2";
}

/**
 * Longitud relativa del cañón (arma) por arquetipo: el pesado luce un cañón más
 * largo, el explorador uno corto. Diferenciación modular derivada del loadout.
 */
const BARREL_LENGTH: Record<ChassisKind, number> = { scout: 0.8, gunner: 1, heavy: 1.25 };

export function barrelLengthForChassis(chassisId?: string | null): number {
  return BARREL_LENGTH[chassisKind(chassisId)];
}

/** Una entrada de la NÓMINA pública: qué bot conduce cada vehículo del snapshot. */
export interface RosterEntry {
  name?: string;
  chassis?: string;
  team?: string;
  botId?: string;
}

/** id de vehículo del snapshot → datos del bot que lo conduce. */
export type ViewerRoster = Map<string, RosterEntry>;

/**
 * Convierte la nómina que llega en la CABECERA `init.meta` (o en el índice del
 * replay) — un array — al Map que consume el visor. Tolerante a basura: cualquier
 * entrada sin id se descarta, y sin nómina devuelve un Map vacío.
 */
export function rosterFromMeta(raw: unknown): ViewerRoster {
  const out: ViewerRoster = new Map();
  if (!Array.isArray(raw)) return out;
  for (const e of raw) {
    if (e && typeof e === "object" && typeof (e as any).id === "string") {
      const r = e as any;
      out.set(r.id, {
        name: typeof r.name === "string" ? r.name : undefined,
        chassis: typeof r.chassis === "string" ? r.chassis : undefined,
        team: typeof r.team === "string" ? r.team : undefined,
        botId: typeof r.botId === "string" ? r.botId : undefined,
      });
    }
  }
  return out;
}

/** Forma abreviada de un id crudo (nunca el UUID entero) cuando no hay nombre. */
export function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id;
}

/**
 * Etiqueta a pintar sobre el vehículo: el NOMBRE del bot si la nómina lo trae;
 * si no, una forma corta del id — JAMÁS el UUID completo (DoD ERR-VIS-05).
 */
export function vehicleLabel(roster: ViewerRoster | null | undefined, id: string): string {
  const name = roster?.get(id)?.name;
  if (name && name.trim().length > 0) return name.trim();
  return shortId(id);
}

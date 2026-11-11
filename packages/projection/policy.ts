/**
 * OLA 2 · MA · Política de divulgación por DEFECTO, como DATO (D-B1 = R2, EQUIPMENT_PRIVATE).
 *
 * Lista BLANCA: un campo sin entrada no sale (`fieldLevel` ⇒ PRIVATE). El proyector no
 * decide nada por su cuenta: pregunta aquí por cada campo. Cambiar el régimen es cambiar
 * este dato (y su versión, que entra en la clave de caché).
 *
 * R2: el equipamiento y el loadout completo son privados por defecto en WELCOME (para
 * terceros), getBattleStats, espectador, broadcast, replay público y API pública. Lo
 * físicamente observable (trayectoria, velocidad, cadencia, efectos visibles) se declara
 * ACCEPTED_RESIDUAL: está aquí para documentarlo, NO para dejar salir un campo. Un campo
 * residual nunca se emite como dato: se infiere, como mucho, de los PUBLIC a lo largo del
 * tiempo. Ver docs/technical/security.md («Equipamiento privado»).
 */
import type {
  AudienceClass,
  DisclosurePolicy,
  FieldVisibility,
  PolicyRef,
  ViewerRelation,
  VisibilityLevel,
} from "./contracts.js";

/** D-B5 · granularidad pública del casco: hullLevel ∈ 0..20 (0 sólo si está destruido). */
export const HULL_LEVEL_N = 20;

/** Versión del algoritmo de proyección (entra en `mappingId` y en la clave de caché). */
export const PROJECTION_VERSION = "2.0.0";

/** Marca de formato de los cuerpos proyectados. */
export const PUBLIC_FRAME_FORMAT = "s9.projection.public.v2";

/** Política de espectador vigente (retardo/niebla del ruleset): referencia para la clave. */
export const DEFAULT_SPECTATOR_POLICY: PolicyRef = "s9.spectator@1";

const PROJECTED: readonly Exclude<AudienceClass, "raw">[] = [
  "bot_team",
  "public_live",
  "broadcast",
  "public_replay",
  "owner",
  "team",
  "staff",
];

function all(v: FieldVisibility): Partial<Record<AudienceClass, FieldVisibility>> {
  const out: Partial<Record<AudienceClass, FieldVisibility>> = {};
  for (const a of PROJECTED) out[a] = v;
  return out;
}

/** Sólo el dueño (y staff, que audita) ven el campo; el resto, PRIVATE. */
function ownerOnly(): Partial<Record<AudienceClass, FieldVisibility>> {
  return { ...all("PRIVATE"), owner: "PUBLIC", staff: "PUBLIC" };
}

const PUBLIC = all("PUBLIC");
const PRIVATE = all("PRIVATE");
const RESIDUAL = all("ACCEPTED_RESIDUAL");

/**
 * Campos canónicos. Prefijos: `vehicle.*`, `projectile.*`, `roster.*`, `result.*`,
 * `stats.*` (getBattleStats, por bot), `welcome.*` (WELCOME del propio bot) y
 * `residual.*` (inferencia física aceptada, nunca emitida).
 */
export const DEFAULT_DISCLOSURE_POLICY: DisclosurePolicy = {
  id: "s9.disclosure",
  version: 1,
  regime: "R2",
  fields: {
    // ---------------------------------------------------------------- frame
    "vehicle.id": PUBLIC,
    "vehicle.team": PUBLIC,
    "vehicle.alive": PUBLIC,
    "vehicle.position": PUBLIC,
    "vehicle.heading": PUBLIC,
    // D-B2 · las propiedades de la torreta van en la MONTURA (pública): el ángulo no
    // revela el arma. Se publica cuantizado igual que el resto de poses (round6).
    "vehicle.turretHeading": PUBLIC,
    // D-B4/D-B5 · casco exacto en lo interno, cuantizado en lo público (hullLevel).
    "vehicle.hullHp": all("SANITIZED"),
    "vehicle.hullHpMax": PRIVATE, // revela el chasis
    "vehicle.modules": PRIVATE, // ranuras + estado = loadout
    "vehicle.carryingFlag": PUBLIC,
    "vehicle.juggernaut": PUBLIC,
    "vehicle.respawnsLeft": PUBLIC,
    "projectile.id": PUBLIC,
    "projectile.position": PUBLIC,
    "frame.score": PUBLIC,
    "frame.objectives": PUBLIC,
    "frame.overtime": PUBLIC,
    // --------------------------------------------------------------- nómina
    "roster.id": PUBLIC,
    "roster.botId": PUBLIC,
    "roster.team": PUBLIC,
    "roster.name": PUBLIC,
    "roster.chassis": PRIVATE, // equipamiento
    // ------------------------------------------------------------ resultado
    "result.winner": PUBLIC,
    "result.endReason": PUBLIC,
    "result.ticks": PUBLIC,
    "result.score": PUBLIC,
    "result.finalStateHash": PUBLIC,
    "result.disqualified": PUBLIC, // con ids PÚBLICOS
    "result.versions": PRIVATE, // ya están en la auditoría; no van en el stream
    // ------------------------------------------- estadísticas post-batalla
    "stats.botId": PUBLIC,
    "stats.team": PUBLIC,
    "stats.damageDealt": PUBLIC,
    "stats.damageTaken": PUBLIC,
    "stats.shotsFired": PUBLIC, // cadencia: residual físico (disparos visibles)
    "stats.shotsHit": PUBLIC,
    "stats.accuracy": PUBLIC,
    "stats.kills": PUBLIC,
    "stats.teamKills": PUBLIC,
    "stats.deaths": PUBLIC,
    "stats.respawns": PUBLIC,
    "stats.died": PUBLIC,
    "stats.aliveAtEnd": PUBLIC,
    "stats.survivedTicks": PUBLIC,
    "stats.flagCaptures": PUBLIC,
    "stats.flagsTaken": PUBLIC,
    "stats.distanceM": PUBLIC,
    "stats.disqualified": PUBLIC,
    "stats.lives": PUBLIC,
    "stats.respawnsRemaining": PUBLIC,
    "stats.eliminated": PUBLIC,
    "stats.battle": PUBLIC,
    // R2 · revelan el equipamiento (módulo por ranura, minas, radio):
    "stats.perModule": ownerOnly(),
    "stats.minesDeployed": ownerOnly(),
    "stats.minesTriggered": ownerOnly(),
    "stats.radio": ownerOnly(),
    // ------------------------------------------------------ inferencia física
    "residual.trajectory": RESIDUAL,
    "residual.speed": RESIDUAL,
    "residual.acceleration": RESIDUAL,
    "residual.turnRate": RESIDUAL,
    "residual.turretSlew": RESIDUAL,
    "residual.fireCadence": RESIDUAL,
    "residual.projectileSpeed": RESIDUAL,
    "residual.projectileRange": RESIDUAL,
    "residual.explosionRadius": RESIDUAL,
    "residual.impactsToKill": RESIDUAL,
    "residual.collisionRadius": RESIDUAL,
    "residual.mineTriggerPosition": RESIDUAL,
  },
};

export function policyRef(p: DisclosurePolicy): PolicyRef {
  return `${p.id}@${p.version}`;
}

/** Nivel de un campo para una audiencia. Lista blanca: sin entrada ⇒ PRIVATE. */
export function fieldLevel(policy: DisclosurePolicy, field: string, audience: AudienceClass): FieldVisibility {
  if (audience === "raw") return "PRIVATE"; // F5: raw no es una audiencia de proyección
  const row = Object.prototype.hasOwnProperty.call(policy.fields, field) ? policy.fields[field] : undefined;
  const lvl = row && Object.prototype.hasOwnProperty.call(row, audience) ? row[audience] : undefined;
  return lvl ?? "PRIVATE";
}

/** ¿Sale el campo como dato? Sólo PUBLIC y SANITIZED (este último, transformado). */
export function emits(policy: DisclosurePolicy, field: string, audience: AudienceClass): boolean {
  const l = fieldLevel(policy, field, audience);
  return l === "PUBLIC" || l === "SANITIZED";
}

/**
 * Visibilidad de un DEPLOYABLE según audiencia y relación con su dueño (T6 del contrato:
 * el dueño siempre lo ve; el resto, según la política). Por defecto: oculto para todo
 * público, revelado al dueño. `staff` no lo ve en el stream (lo ve en las capas de
 * depuración firmadas, que son otro canal).
 */
export function deployableVisibility(audience: AudienceClass, relation: ViewerRelation): VisibilityLevel {
  if (relation === "self" || relation === "owner") return "revealed";
  void audience;
  return "hidden";
}

/** Inferencia física aceptada, en una frase por campo (fuente de la documentación). */
export const ACCEPTED_RESIDUALS: Readonly<Record<string, string>> = {
  "residual.trajectory": "La trayectoria del vehículo (posiciones públicas a lo largo del tiempo).",
  "residual.speed": "La velocidad máxima alcanzada, derivable de posiciones consecutivas.",
  "residual.acceleration": "La aceleración y la frenada, derivables de la velocidad.",
  "residual.turnRate": "La velocidad de giro del casco, derivable del rumbo.",
  "residual.turretSlew": "La velocidad de giro de la torreta (propiedad de la montura, pública por D-B2).",
  "residual.fireCadence": "La cadencia de disparo: cada proyectil aparece en el frame público.",
  "residual.projectileSpeed": "La velocidad del proyectil, derivable de dos frames.",
  "residual.projectileRange": "El alcance efectivo, por la distancia a la que desaparece el proyectil.",
  "residual.explosionRadius": "El radio de una explosión visible, por sus efectos sobre el casco ajeno.",
  "residual.impactsToKill": "Cuántos impactos hacen falta para destruir un vehículo (con hullLevel cuantizado).",
  "residual.collisionRadius": "El tamaño del vehículo, por las distancias de contacto en las colisiones.",
  "residual.mineTriggerPosition": "La posición de una mina en el instante en que explota (evento público).",
};

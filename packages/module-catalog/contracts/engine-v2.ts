/**
 * Engine v2 · CONTRATO DECLARATIVO de las primitivas genéricas (Equipo 0).
 *
 * SÓLO TIPOS. Sin lógica, sin valores, sin importadores todavía. Define la forma de
 * los DATOS de catálogo (lo que escribe un JSON de módulo) y del ESTADO de simulación
 * que el motor mantiene para Effect, Deployable, Trigger, Interference, DamageType y
 * Guidance. Implementan: C (catálogo, efectos, deployables, interference, guidance,
 * sensores, utility), B (daño, penetración, blindaje), D (orden, RNG, hash, replay).
 * Contrato completo, invariantes y propiedad: docs/technical/engine-v2-contracts.md.
 *
 * Regla: el motor despacha por PRIMITIVA (registro tipado), jamás por moduleId,
 * nombre de arma o de munición.
 */
import type { InternalEntityId, VisibilityLevel } from "../../projection/contracts.js";

// ================================================================ estado de los campos

/**
 * Estado de cada campo de catálogo (sustituye a `EffectStatus` de effect-status.ts,
 * cuyo nombre choca con Effect). PARTIAL pasa a VALIDATION_ONLY.
 *  - ACTIVE: el motor lo lee y cambia la batalla.
 *  - VALIDATION_ONLY: sólo lo usa el validador (coste, masa, tamaño, límites).
 *  - FUTURE: declarado para una primitiva aún sin consumidor; el VALIDADOR LO RECHAZA
 *    si aparece en un módulo (no hay campos falsos silenciosos).
 *  - REMOVE: se elimina del esquema en la OLA 2.
 */
export type FieldStatus = "ACTIVE" | "VALIDATION_ONLY" | "FUTURE" | "REMOVE";

// ================================================================ comunes

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Relación con el ORIGEN del efecto, calculada desde el estado de batalla. */
export type TargetRelation = "self" | "ally" | "enemy" | "any";
export type TargetKind = "vehicle" | "module" | "deployable" | "projectile";

export interface TargetFilter {
  readonly relations: readonly TargetRelation[];
  readonly kinds: readonly TargetKind[];
  /** Por defecto true: un efecto de área no atraviesa muros. */
  readonly requiresLineOfSight?: boolean;
  /** El ruleset (friendlyFire) puede restringir más, nunca ampliar. */
}

/** Caída con la distancia dentro del radio. `linear` = la de explosionFalloff() actual. */
export type Falloff = "none" | "linear" | "step";

// ================================================================ DamageType y capa de daño (B)

/**
 * Tipo de daño: id de un REGISTRO DE DATOS (tabla de DamageTypeProfile en
 * packages/game-rules, propiedad de B). Ids iniciales: kinetic, explosive, thermal,
 * electronic y environmental. Añadir uno = una fila de datos + tests, no código.
 */
export type KnownDamageType = "kinetic" | "explosive" | "thermal" | "electronic" | "environmental";
export type DamageTypeId = KnownDamageType | (string & { readonly __damageTypeId?: never });
/** Alias usado por Effect. */
export type DamageType = DamageTypeId;

/** Perfil por tipo (dato). Con los valores por defecto reproduce la fórmula D6 actual. */
export interface DamageTypeProfile {
  readonly id: DamageTypeId;
  /** Reparto casco/módulo (hoy 0.7/0.3). */
  readonly hullShare: number;
  readonly moduleShare: number;
  /** Peso extra por categoría al elegir módulo impactado (p. ej. electronic → sensor). */
  readonly moduleTargetWeights?: Readonly<Partial<Record<string, number>>>;
  /** false = ignora el blindaje (zonas del mapa). */
  readonly armorApplies: boolean;
  /** Desgaste del blindaje por punto absorbido (hoy 1). */
  readonly armorWearFactor: number;
  /** Suelo de daño efectivo (hoy DMG_MIN_FRACTION = 0.1). */
  readonly minFraction: number;
  readonly usesSector: boolean;
}

/** Perfil de blindaje (bloque `armor` del módulo; esquema de C, semántica de B). */
export interface ArmorProfile {
  /** Resistencia por tipo; `default` = campo `reduction` actual. */
  readonly resist: Readonly<Partial<Record<DamageTypeId | "default", number>>>;
  /** binary = hoy (100 % hasta hp 0); linear = proporcional al hp restante (D-B4). */
  readonly degradation: "binary" | "linear";
}

export type DamageSourceKind = "projectile" | "explosion" | "deployable" | "zone" | "effect";

/** Paquete de daño INTERNO. Lo producen los handlers de Effect y las zonas; nada más. */
export interface DamagePacket {
  readonly amount: number;
  readonly type: DamageTypeId;
  /** Mismas unidades que la resistencia: reduction = clamp(resist − penetration, 0, R_MAX). */
  readonly penetration: number;
  readonly from: Vec2;
  /** null = ambiental (sin atacante, sin hit_dealt). */
  readonly owner: InternalEntityId | null;
  readonly ownerTeam: string | null;
  readonly sourceKind: DamageSourceKind;
  /** Orden estable dentro del tick (EffectOrderKey → seq). */
  readonly seq: number;
}

/** Registro EXACTO (INTERNAL_DAMAGE_STATE). Va al damageLog derivado, nunca a terceros. */
export interface DamageRecord {
  readonly tick: number;
  readonly target: InternalEntityId;
  readonly owner: InternalEntityId | null;
  readonly sourceKind: DamageSourceKind;
  readonly type: DamageTypeId;
  readonly base: number;
  readonly penetration: number;
  readonly sector: "front" | "left" | "right" | "rear" | null;
  readonly reduction: number;
  readonly absorbed: number;
  readonly effective: number;
  readonly hull: number;
  readonly moduleSlot: string | null;
  readonly moduleDamage: number;
  readonly moduleDestroyed: boolean;
  readonly armorBroken: boolean;
  readonly killed: boolean;
}

/**
 * Única puerta de daño de vehículo (sustituye a applyDamage y al camino aparte de las
 * zonas). Muerte y onKill en un solo sitio. RNG: flujo `combat`, un `weighted` sobre
 * candidatos ordenados por slot. Sin `if (type === …)`: sólo tablas con safeLookup.
 */
export type ResolveDamage = (
  packet: DamagePacket,
  target: InternalEntityId,
  profiles: Readonly<Record<DamageTypeId, DamageTypeProfile>>,
) => DamageRecord;

/**
 * Montura de torreta en la RANURA del chasis (opción M de D-B2, pendiente). Si se elige M,
 * weapon.turretRateRads/turretArcRad pasan a REMOVE; si se elige E, siguen en el arma y
 * la proyección publica una envolvente. La simulación limita el giro al arco (hoy sólo
 * se comprueba al disparar) y normaliza el ángulo a (−π, π].
 */
export interface TurretMountDef {
  readonly turretRateRads: number;
  readonly turretArcRad: number;
}

// ================================================================ Interference (C)

/**
 * Canal de percepción/comunicación. Un sensor declara su canal; la radio usa `radio`.
 * `optical` no tiene consumidor todavía: el validador lo rechaza hasta que exista
 * una primitiva de sensor óptico (FUTURE, no un campo falso).
 */
export type InterferenceChannel = "lidar" | "radar" | "proximity" | "acoustic" | "radio" | "optical";

export interface ChannelModifier {
  /** 0..1. Fracción de la señal que se pierde en el centro. */
  readonly strength: number;
  /** attenuate: reduce alcance/confianza; block: corta la lectura; noise: añade error. */
  readonly mode: "attenuate" | "block" | "noise";
  /** Error añadido (m o rad según el canal) si mode = noise. */
  readonly noise?: number;
}

/** Perfil de interferencia del catálogo (humo, jammer… son DATOS de este perfil). */
export interface InterferenceProfile {
  readonly channels: Readonly<Partial<Record<InterferenceChannel, ChannelModifier>>>;
}

/** Zona de interferencia viva (estado de simulación; entra en el hash). */
export interface InterferenceZoneState {
  readonly id: InternalEntityId;
  readonly source: InternalEntityId;
  readonly ownerVehicle: InternalEntityId;
  readonly team: string;
  readonly center: Vec2;
  readonly radiusM: number;
  readonly falloff: Falloff;
  readonly profile: InterferenceProfile;
  readonly startTick: number;
  readonly endTick: number;
}

/**
 * Consulta única para todos los consumidores (sensores, radio, guidance). Combinación
 * entre zonas: 1 − Π(1 − sᵢ·fᵢ), independiente del orden.
 */
export interface InterferenceQuery {
  readonly channel: InterferenceChannel;
  /** Segmento (rayo, enlace de radio, línea de lock) o punto si from = to. */
  readonly from: Vec2;
  readonly to: Vec2;
  readonly tick: number;
}
export interface InterferenceSample {
  readonly attenuation: number;
  readonly blocked: boolean;
  readonly noise: number;
}

// ================================================================ Effect (C, B para damage/penetration)

export type EffectPrimitive =
  | "damage"
  | "explosion"
  | "penetration"
  | "interference"
  | "repair"
  | "statusModifier"
  | "sensorModifier"
  | "communicationModifier";

/** Política de apilamiento entre efectos con la misma `stackKey`. */
export type Stacking = "none" | "replace" | "max" | "add";

interface EffectBase {
  readonly primitive: EffectPrimitive;
  /** Magnitud en la unidad de la primitiva (hp, fracción, m…). */
  readonly strength: number;
  /** 0/ausente = puntual (sólo el blanco directo). */
  readonly radiusM?: number;
  /** 0/ausente = instantáneo. >0 = efecto persistente con estado. */
  readonly durationTicks?: number;
  /** Obligatorio si radiusM > 0. */
  readonly falloff?: Falloff;
  readonly targets: TargetFilter;
  readonly stacking: Stacking;
  /** Por defecto `${primitive}:${channel|damageType}`. */
  readonly stackKey?: string;
  /** Tope con stacking = add. */
  readonly maxStacks?: number;
}

/**
 * Effect → DamagePacket: el handler de `damage` emite UN paquete al blanco directo; el de
 * `explosion` emite uno por vehículo en el radio (falloff y línea de visión), con
 * sourceKind "explosion". `strength` = amount del paquete (ya materializado por
 * resolveVehicle desde weapon.damage × ammo.damageMultiplier).
 */
export interface DamageEffectDef extends EffectBase {
  readonly primitive: "damage" | "explosion";
  readonly damageType: DamageType;
}
/**
 * `penetration` no daña por sí sola: suma `strength` a la penetración de los paquetes que
 * emiten los efectos de daño HERMANOS de la misma lista (misma acción/impacto).
 */
export interface PenetrationEffectDef extends EffectBase {
  readonly primitive: "penetration";
}
export interface InterferenceEffectDef extends EffectBase {
  readonly primitive: "interference";
  readonly profile: InterferenceProfile;
}
export interface RepairEffectDef extends EffectBase {
  readonly primitive: "repair";
  /** Qué repara: casco, módulos (por categoría) o blindaje. */
  readonly repairs: "hull" | "modules" | "armor";
}
export interface StatusModifierEffectDef extends EffectBase {
  readonly primitive: "statusModifier";
  /** Estadística modificada (vocabulario cerrado del motor, no del catálogo). */
  readonly stat: "maxSpeed" | "turnRate" | "turretRate" | "energyGeneration" | "cooldown";
  /** Multiplicador = 1 + strength (negativo = penalización). */
}
export interface SensorModifierEffectDef extends EffectBase {
  readonly primitive: "sensorModifier";
  readonly channels: readonly InterferenceChannel[];
  readonly stat: "range" | "error" | "refresh";
}
export interface CommunicationModifierEffectDef extends EffectBase {
  readonly primitive: "communicationModifier";
  readonly stat: "range" | "rate" | "delay" | "maxBytes";
}

/** Unión discriminada por `primitive`: el motor la despacha con un registro tipado. */
export type EffectDef =
  | DamageEffectDef
  | PenetrationEffectDef
  | InterferenceEffectDef
  | RepairEffectDef
  | StatusModifierEffectDef
  | SensorModifierEffectDef
  | CommunicationModifierEffectDef;

/** Efecto persistente vivo (durationTicks > 0). Estado de simulación; entra en el hash. */
export interface ActiveEffectState {
  readonly id: InternalEntityId;
  readonly def: EffectDef;
  readonly source: InternalEntityId;
  readonly ownerVehicle: InternalEntityId;
  readonly team: string;
  /** Blanco (vehículo/deployable) o centro de área. */
  readonly target?: InternalEntityId;
  readonly center?: Vec2;
  readonly appliedAtTick: number;
  readonly expiresAtTick: number;
  readonly stacks: number;
  /** Clave de orden total: (appliedAtTick, phase, sourceSeq, effectIndex). */
  readonly order: readonly [number, number, number, number];
}

// ================================================================ Trigger (C)

export type TriggerKind = "proximity" | "contact" | "timer" | "remote" | "event";

export type TriggerEventKind = "owner_destroyed" | "deployable_damaged" | "battle_phase";

export type TriggerDef =
  | { readonly kind: "proximity"; readonly radiusM: number; readonly targets: TargetFilter }
  | { readonly kind: "contact"; readonly targets: TargetFilter }
  /** Dispara `afterTicks` después de ARMARSE. */
  | { readonly kind: "timer"; readonly afterTicks: number }
  /** Sólo el vehículo dueño (del estado de batalla, nunca del comando) puede accionarlo. */
  | { readonly kind: "remote"; readonly requiresOwnerAlive: boolean }
  | { readonly kind: "event"; readonly event: TriggerEventKind };

// ================================================================ Deployable (C)

/** Firma por canal: cuánto se percibe la entidad por cada canal (0 = invisible). */
export type Signature = Readonly<Partial<Record<InterferenceChannel, number>>>;

export interface DeployableVisibilityDef {
  /** Siempre revealed para el dueño; aquí se fija aliados/enemigos/espectador. */
  readonly allies: VisibilityLevel;
  readonly enemies: VisibilityLevel;
  readonly spectator: VisibilityLevel;
  /** Sustituye a Mine.detectable = true: lo que un sensor del canal puede detectar. */
  readonly signature: Signature;
}

/** Bloque de catálogo de un módulo que despliega (mina hoy; baliza, humo… mañana). */
export interface DeployableDef {
  readonly lifetimeTicks: number;
  readonly armDelayTicks: number;
  /** Sustituye a MAX_MINES_PER_VEHICLE (battle.ts). */
  readonly maxActivePerOwner: number;
  readonly trigger: TriggerDef;
  /** Carga: uno o varios efectos, en este orden. */
  readonly effects: readonly EffectDef[];
  /** true = se consume al disparar (mina); false = emisor persistente (jammer, baliza). */
  readonly consumeOnTrigger: boolean;
  readonly visibility: DeployableVisibilityDef;
  /** Colocación permitida relativa al vehículo. */
  readonly placement: { readonly mode: "at_self" | "offset"; readonly maxOffsetM?: number };
  /**
   * Propiedad: el dueño es el vehículo que lo creó (estado de batalla, nunca el comando).
   * friendlyTrigger: inherit = ruleset.friendlyFire (hoy); always / never = dato.
   */
  readonly ownership: { readonly friendlyTrigger: "inherit" | "always" | "never" };
  /** hp > 0 = destructible (FUTURE hasta que exista su consumidor). */
  readonly hp?: number;
}

export type DeployableLifecycle = "arming" | "armed" | "triggered" | "expired" | "destroyed";

/** Deployable vivo (estado de simulación; TODOS sus campos entran en el hash). */
export interface DeployableState {
  readonly id: InternalEntityId;
  /** Id versionado del módulo que lo creó (trazabilidad; el motor NO ramifica por él). */
  readonly moduleRef: string;
  readonly def: DeployableDef;
  readonly ownerVehicle: InternalEntityId;
  readonly team: string;
  readonly position: Vec2;
  readonly deployedAtTick: number;
  readonly armedAtTick: number;
  readonly expiresAtTick: number;
  readonly lifecycle: DeployableLifecycle;
  /** Secuencia interna de creación: orden total de evaluación de triggers. */
  readonly seq: number;
}

// ================================================================ Guidance (C)

export interface LockRequirements {
  /** Canal con el que se adquiere/mantiene el lock (interferible). */
  readonly channel: InterferenceChannel;
  readonly requiresLineOfSight: boolean;
  /** Ticks de lock continuo antes de guiar. */
  readonly minLockTicks: number;
}

export type GuidanceDef =
  | { readonly mode: "none" }
  | {
      readonly mode: "target";
      readonly turnRateRads: number;
      readonly acquisitionRangeM: number;
      readonly lockRequirements: LockRequirements;
      /** Error angular máximo; se sortea del stream RNG `guidance`, nunca Math.random. */
      readonly trackingErrorRad: number;
      readonly onLockLost: "ballistic" | "expire";
    }
  | {
      readonly mode: "waypoint";
      readonly turnRateRads: number;
      readonly maxWaypoints: number;
      readonly trackingErrorRad: number;
    };

export interface GuidanceState {
  readonly mode: GuidanceDef["mode"];
  /** Blanco resuelto desde el BotEntityRef del tirador (espacio de simulación). */
  readonly target?: InternalEntityId;
  readonly waypoints?: readonly Vec2[];
  readonly lockedTicks: number;
  readonly locked: boolean;
}

// ================================================================ Projectile / Action (C, B)

/** Bloque de catálogo del proyectil de un arma (sustituye a ttlTicks = 90). */
export interface ProjectileDef {
  readonly speedMs: number;
  /** Vida máxima; el alcance efectivo = speedMs · lifetimeTicks · TICK_DT. */
  readonly lifetimeTicks: number;
  readonly spreadRad: number;
  readonly guidance: GuidanceDef;
  /** Efectos al impactar (daño cinético, explosión, interferencia…), en orden. */
  readonly onImpact: readonly EffectDef[];
}

/** Proyectil vivo v2 (sustituye a combat.ts Projectile; todos los campos al hash). */
export interface ProjectileState {
  readonly id: InternalEntityId;
  readonly moduleRef: string;
  readonly ownerVehicle: InternalEntityId;
  readonly team: string;
  readonly position: Vec2;
  readonly velocity: Vec2;
  readonly remainingTicks: number;
  readonly onImpact: readonly EffectDef[];
  readonly guidance: GuidanceState;
  readonly seq: number;
}

/**
 * Acción genérica de un módulo: lo que un comando del bot puede pedir. Arma = fire →
 * proyectil; mina = deploy → deployable; utility = activate → efectos/zona/deployable.
 */
export type ActionKind = "fire" | "deploy" | "activate" | "trigger";

export interface ActionDef {
  readonly kind: ActionKind;
  readonly cooldownTicks: number;
  readonly cost: { readonly energyEU: number; readonly charges?: number; readonly ammo?: number };
  /** Exactamente uno de los tres productos (o ninguno si sólo aplica `effects`). */
  readonly projectile?: ProjectileDef;
  readonly deployable?: DeployableDef;
  readonly effects?: readonly EffectDef[];
}

// ================================================================ Sensores (C)

/** Primitivas de sensor implementadas por el motor (una vez cada una). */
export type SensorPrimitiveKind = "lidar" | "radar" | "proximity" | "acoustic";

/** Variante de catálogo: SÓLO parámetros; el canal lo fija la primitiva. */
export interface SensorVariantDef {
  readonly primitive: SensorPrimitiveKind;
  readonly rangeM: number;
  readonly fovRad?: number;
  readonly rays?: number;
  readonly errorM?: number;
  readonly refreshEveryNDecisions?: number;
}

/** Lectura INTERNA de un sensor (ids internos); la observación es su proyección. */
export interface SensorContactInternal {
  readonly entity: InternalEntityId;
  readonly entityKind: "vehicle" | "deployable" | "projectile";
  readonly position: Vec2;
  readonly positionErrorM: number;
  readonly identified: boolean;
  readonly teamRevealed: boolean;
  readonly confidence: number;
}

// ================================================================ ModuleDefinition v2 (C)

/**
 * Bloques v2 que se AÑADEN a ModuleDefinition (types.ts). C decide la migración de los
 * campos planos actuales (que pasan a REMOVE cuando su bloque los sustituye).
 */
export interface ModuleDefinitionV2Blocks {
  readonly actions?: readonly ActionDef[];
  readonly sensor?: SensorVariantDef;
  readonly armor?: ArmorProfile;
  /** Firma del VEHÍCULO aportada por el módulo (p. ej. un motor ruidoso). */
  readonly signature?: Signature;
  /** Metadatos de visibilidad del propio módulo para terceros (qué se infiere de él). */
  readonly visibility?: { readonly publicClass: "mobility" | "weapons" | "sensors" | "utility" | "hidden" };
}

// ================================================================ esqueleto del tick (D implementa; A, B, C insertan)

/**
 * Fases FIJAS del paso de combate (hoy PASO 5: resolveFiring → resolveProjectiles →
 * resolveMines → resolveZoneDamage). Cada fase recorre sus entidades en orden de `seq`;
 * ninguna fase aplica efectos directamente: los ENCOLA y la fase 5e los drena.
 */
export type CombatPhase =
  | "5a_actions" // fire / deploy / activate / detonate (validación + spawn)
  | "5b_triggers" // armado y triggers de deployables
  | "5c_guidance" // giro de proyectiles guiados
  | "5d_projectiles" // avance, raycast e impacto
  | "5e_effects" // drenado de la cola de efectos, en orden de EffectOrderKey
  | "5f_expirations" // fin de vida por tick absoluto (deployables, zonas, efectos)
  | "5g_ambient"; // daño de zonas del mapa (también por applyDamage, con DamageType)

/** Orden total de aplicación de efectos encolados. */
export type EffectOrderKey = readonly [
  phase: number,
  createdTick: number,
  sourceSeq: number,
  effectIndex: number,
  targetSeq: number,
];

/** Topes de cascada (un efecto que crea deployables/efectos en el mismo tick). */
export interface CascadeLimits {
  readonly maxDepth: number;
  /** Rebasar = descartar y contar (comportamiento definido), nunca lanzar. */
  readonly maxEffectsPerTick: number;
}

/**
 * Productor ÚNICO de entidades: toda creación pasa por spawn(kind) y recibe `seq` de UN
 * contador de simulación que entra en el hash. El InternalEntityId se deriva de
 * (kind, seq); nunca de tiempo de pared, Map.size ni longitud de un array filtrado.
 */
export interface EntityAllocatorState {
  readonly nextSeq: number;
  /** Contadores por propietario del espacio BOT (`own`), también en el hash. */
  readonly ownCounters: Readonly<Record<string, number>>;
  /** Contadores por observador del espacio BOT (`contact`), también en el hash. */
  readonly contactCounters: Readonly<Record<string, number>>;
}

/** Flujos de RNG con nombre, derivados de la semilla SIN consumir del padre. */
export type RngStreamName = "combat" | "sensors" | "effects" | "guidance" | "latency";

/** Componentes del hash de estado v2: stateHash = sha256 de los hashes de componente. */
export type StateHashComponent =
  | "tick"
  | "rng"
  | "allocator"
  | "solver"
  | "vehicles"
  | "projectiles"
  | "deployables"
  | "effects"
  | "effectQueue"
  | "interference"
  | "destructibles"
  | "radioQueue"
  | "pendingCommands"
  | "botRefs"
  | "mode";

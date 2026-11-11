/**
 * Engine v2 · CONTRATO DECLARATIVO de la frontera de proyección (Equipo 0).
 *
 * SÓLO TIPOS. Sin lógica, sin valores, sin importadores todavía. `packages/projection/`
 * será el paquete ÚNICO de proyección (Equipo A): lo importan el motor (observación del
 * bot), el gateway de espectador (que corre en el worker), la API de replays, el
 * replay-service y el broadcast. B aporta proyectores puros de daño y torreta.
 * Contrato completo: docs/technical/engine-v2-contracts.md. Cambios: sólo Equipo 0.
 *
 *   SIMULATION STATE → INTERNAL EXACT STATE → PROJECTION → VIEWER-SPECIFIC SANITIZED STATE
 *
 * RESTRICCIÓN: la semilla de la batalla es PÚBLICA (commit-reveal y auditoría). Ningún id
 * público, mapping ni ruido de proyección puede derivar de la semilla ni del RNG.
 */

// ---------------------------------------------------------------- marcas de etapa

declare const internalBrand: unique symbol;
declare const publicBrand: unique symbol;
declare const sanitizedBrand: unique symbol;

/** Id de entidad del MOTOR, de spawn(kind). Nunca sale de la etapa INTERNAL. */
export type InternalEntityId = string & { readonly [internalBrand]: "InternalEntityId" };

/**
 * Id que ve UN público (o un bot). Cabe en `common.schema.json#/$defs/entityId`
 * (`^[a-z]+_[0-9a-zA-Z]{1,16}$`): `<prefijo>_<n>`.
 */
export type PublicEntityId = string & { readonly [publicBrand]: "PublicEntityId" };

/**
 * Prefijo = CLASE PÚBLICA, nunca un subtipo de catálogo (`mine_`, `emp_`, `smoke_`
 * prohibidos): v vehículo, p proyectil, d deployable, z zona/efecto visible,
 * c contacto de sensor sin identidad (sólo espacio del bot).
 */
export type PublicEntityPrefix = "v" | "p" | "d" | "z" | "c";

export type InternalEntityKind = "vehicle" | "projectile" | "deployable" | "effect_zone" | "destructible";

// ---------------------------------------------------------------- audiencia y relación

/**
 * Clase CERRADA de audiencia. `raw` no es una audiencia de proyección: el replay crudo es
 * la receta, restringido por autorización, y nunca la base de una respuesta pública.
 * `public_live` y `broadcast` se separan aunque hoy proyecten lo mismo.
 */
export type AudienceClass =
  | "bot_team" // canal del bot: un mapper por equipo
  | "public_live" // espectador en directo (niebla y retardo del ruleset)
  | "broadcast" // emisión; ticket propio
  | "public_replay" // reproductor y descarga públicos
  | "owner" // dueño humano de un bot de la batalla
  | "team" // miembro de un equipo
  | "staff" // moderador/admin con capas de depuración firmadas
  | "raw"; // SÓLO para distinguir en claves; nunca se proyecta

/**
 * Clave de audiencia, con el detalle mínimo: `public_live`, `broadcast`, `public_replay`,
 * `staff`, `owner:<userId>`, `team:<teamId>`, `bot_team:<team>`. Interna: no se envía al
 * cliente (contiene ids de usuario). La construye el backend desde auth + participants.
 */
export type AudienceKey = string & { readonly [internalBrand]: "AudienceKey" };

/** Relación visor ↔ entidad, recalculada en el backend en cada petición/conexión. */
export type ViewerRelation = "self" | "owner" | "team" | "enemy" | "none";

/**
 * Ticket de espectador v2: la audiencia va FIRMADA (`aud`); el gateway separa feeds,
 * mapper e historial por audiencia. Un ticket sin `aud` se rechaza.
 */
export interface SpectateTicketClaimsV2 {
  readonly battleId: string;
  readonly aud: "public_live" | "broadcast" | "staff";
  readonly jti: string;
  readonly exp: number;
}

// ---------------------------------------------------------------- visibilidad y epoch

/**
 *  - hidden:   no existe para esa audiencia (ni id, ni posición, ni huecos de numeración).
 *  - detected: existencia y posición aproximada, sin identidad.
 *  - revealed: identidad pública y campos permitidos por la política.
 */
export type VisibilityLevel = "hidden" | "detected" | "revealed";

/**
 * Epoch = número de EPISODIO de visibilidad de (entidad, audiencia): sube en cada
 * cambio de nivel y nunca baja. Forma canónica `hidden` | `visible#k`. Es función
 * determinista del stream de frames internos (recomputable), pero NO es simulación:
 * no entra en el hash ni consume RNG ni influye en el resultado.
 */
export type VisibilityEpoch = number & { readonly [internalBrand]: "VisibilityEpoch" };

export interface VisibilityState {
  readonly entity: InternalEntityId;
  readonly audience: AudienceKey;
  readonly level: VisibilityLevel;
  readonly epoch: VisibilityEpoch;
  readonly sinceTick: number;
  /**
   * Componentes revelados de un vehículo (p. ej. clase de arma tras disparar), en forma
   * canónica ordenada. Cambiarlo sube el epoch.
   */
  readonly revealedComponents?: readonly string[];
}

// ---------------------------------------------------------------- política (dato)

/** Nivel de exposición de un CAMPO para una audiencia. */
export type FieldVisibility = "PUBLIC" | "SANITIZED" | "PRIVATE" | "ACCEPTED_RESIDUAL";

/**
 * Régimen de divulgación (decisión del propietario D-B1, todavía abierta):
 *  - R1: ADR-000 D9 vigente: loadout público en competición; se protege sólo el estado
 *        dinámico exacto (hp, blindaje, torreta exacta).
 *  - R2: equipamiento privado: además se sanean loadout, nómina y estadísticas.
 * La implementación NO depende de la respuesta: el régimen es un dato.
 */
export type DisclosureRegime = "R1" | "R2";

/**
 * Política de divulgación como DATO, versionada. Lista blanca: un campo sin entrada no
 * sale. Un campo PRIVATE que cambie el flujo público es un error de la política (test
 * diferencial). La consultan A y B; la escriben A (estructura) y B (filas de daño/torreta).
 */
export interface DisclosurePolicy {
  readonly id: string;
  readonly version: number;
  readonly regime: DisclosureRegime;
  /** campo canónico (p. ej. `vehicle.hullHp`, `event.hit_dealt.impact`) → audiencia → nivel. */
  readonly fields: Readonly<Record<string, Readonly<Partial<Record<AudienceClass, FieldVisibility>>>>>;
  /** Continuidad de identidad entre episodios por prefijo; ausente = false (id nuevo). */
  readonly identityContinuity?: Readonly<Partial<Record<PublicEntityPrefix, boolean>>>;
}

export type PolicyRef = `${string}@${number}`;

// ---------------------------------------------------------------- clave de proyección (constructor ÚNICO)

/**
 * Clave de TODA caché proyectada (frames, nómina, composición, mapping, respuestas HTTP).
 * La construye UNA función, `buildProjectionKey()` en `packages/projection/` (A), que
 * también usa B. Quitar cualquier campo es un mutante (M2 epoch, M3 audiencia, M5
 * observedEntity, M6 relación). Regla: una proyección NO sobrevive a una transición que
 * cambie lo que la audiencia puede observar.
 */
export interface ProjectionKey {
  readonly battleId: string;
  readonly audience: AudienceKey;
  /** Entidad o bot observado (por proyección de entidad); `*` para frame completo. */
  readonly observed: InternalEntityId | "*";
  readonly relation: ViewerRelation;
  readonly resolvedProfile: string;
  readonly spectatorPolicy: PolicyRef;
  readonly disclosurePolicy: PolicyRef;
  /** Digest canónico de los epochs (y componentes revelados) del alcance de la clave. */
  readonly visibilityEpochDigest: string;
  readonly projectionVersion: string;
  readonly renderTarget: "ws" | "http" | "artifact";
}

export type BuildProjectionKey = (ctx: ProjectionContext, scope: InternalEntityId | "*") => ProjectionKey;

/**
 * Respuestas HTTP públicas proyectadas: SIN `immutable`; ETag (o URL) incluye
 * projectionVersion, spectatorPolicy y disclosurePolicy.
 */
export interface ProjectedHttpCachePolicy {
  readonly immutable: false;
  readonly etagIncludes: readonly ["projectionVersion", "spectatorPolicy", "disclosurePolicy"];
}

// ---------------------------------------------------------------- mapping de ids

/**
 * Una instancia por (battleId, AudienceKey); nunca compartida. Sin secreto y sin semilla.
 *  - Asignación DENSA por prefijo en orden de PRIMERA VISIBILIDAD para esa audiencia: lo
 *    que la audiencia nunca ve no consume número (no hay huecos).
 *  - Empates en un mismo frame: por clave PÚBLICA (prefijo, x, y cuantizadas, id público
 *    del dueño si es público), nunca por orden interno.
 *  - Vehículos: `v_1..v_n` por orden PÚBLICO de la nómina, no por id interno.
 *  - Ids de mapa (muros, destructibles, bases, zonas del mapa): pasan por lista blanca.
 *  - Nuevo episodio ⇒ id nuevo salvo `identityContinuity`.
 *  - Replay público: mapping calculado una vez sobre todo el stream desde el tick 0;
 *    cualquier segmento usa los mismos ids.
 */
export interface PublicIdMapper {
  readonly mappingId: string; // opaco: hash(battleId, audienceKey, projectionVersion)
  toPublic(entity: InternalEntityId): PublicEntityId | undefined;
  /** Inversa acotada a ESTA audiencia; ajeno/caducado/inventado ⇒ undefined. */
  fromPublic(id: PublicEntityId): InternalEntityId | undefined;
}

// ---------------------------------------------------------------- espacio del BOT (arena/2)

/**
 * Los comandos del bot referencian entidades (radio.to, detonate, guidance) y el replay
 * los graba tal cual: la resolución id-del-bot → interno es función determinista del
 * ESTADO DE SIMULACIÓN y va al hash. Espacio propio, separado del de proyección:
 *  - own:     entidades propias `<prefijo>_<n>`, contador por propietario.
 *  - roster:  vehículos, por el mapper `bot_team:<team>` (estable toda la batalla).
 *  - contact: terceros percibidos sin identidad `c_<n>`, contador por observador, nuevo en
 *             cada adquisición, con caducidad.
 * Un id de proyección (espectador/broadcast/replay) nunca es válido en un comando.
 */
export type BotEntityRefKind = "own" | "roster" | "contact";

export interface BotEntityRef {
  readonly kind: BotEntityRefKind;
  readonly observer: InternalEntityId;
  readonly entity: InternalEntityId;
  readonly botId: PublicEntityId;
  readonly validUntilTick: number;
}

// ---------------------------------------------------------------- etapas

export interface InternalFrameHeader {
  readonly stage: "internal";
  readonly battleId: string;
  readonly tick: number;
}

/** Salida saneada para UNA audiencia: lo único que acepta un consumidor externo. */
export interface SanitizedFrame<Body = unknown> {
  readonly [sanitizedBrand]: true;
  readonly stage: "sanitized";
  /** p. ej. `s9.projection.public.v2`. */
  readonly format: string;
  readonly mappingId: string;
  readonly tick: number;
  readonly body: Body;
}

/** Contexto que A construye y pasa a todos los proyectores (incluidos los de B). */
export interface ProjectionContext {
  readonly battleId: string;
  readonly audience: AudienceKey;
  readonly audienceClass: AudienceClass;
  readonly relationOf: (entity: InternalEntityId) => ViewerRelation;
  readonly visibilityOf: (entity: InternalEntityId) => VisibilityState;
  readonly ids: PublicIdMapper;
  readonly policy: DisclosurePolicy;
  readonly spectatorPolicy: PolicyRef;
  readonly projectionVersion: string;
}

/** LA frontera: pura, determinista, sin E/S, sin RNG. Implementación: Equipo A. */
export type ProjectFrame<Internal extends InternalFrameHeader, Body> = (
  frame: Internal,
  ctx: ProjectionContext,
) => SanitizedFrame<Body>;

// ---------------------------------------------------------------- proyectores puros de B

/** Vista de SÓLO LECTURA del estado interno de daño de un vehículo (nunca `Vehicle`). */
export interface InternalDamageView {
  readonly hullHp: number;
  readonly hullHpMax: number;
  readonly alive: boolean;
  readonly armor: Readonly<Partial<Record<"front" | "left" | "right" | "rear", { hp: number; hpMax: number }>>>;
  readonly modules: readonly { readonly slot: string; readonly category: string; readonly state: string }[];
}

/** PUBLIC_DAMAGE_STATE por visor. Granularidad (N de hullLevel) = decisión D-B5. */
export interface PublicDamageState {
  readonly alive: boolean;
  /** ceil(N·hullHp/hullHpMax); nunca hp absoluto ni hpMax. */
  readonly hullLevel: number;
  readonly capabilities?: Readonly<Partial<Record<"mobility" | "weapons" | "sensors", "ok" | "degraded" | "lost">>>;
  /** Sólo si D-B4 = visual pública. */
  readonly armorBroken?: Readonly<Partial<Record<"front" | "left" | "right" | "rear", boolean>>>;
}

/** Pista pública de torreta calculada por el motor (derivada, fuera del hash). */
export interface PublicTurretTrack {
  readonly heading: number;
}
export interface PublicTurretState {
  readonly heading: number;
}

/** Clase de impacto que sustituye a `hit_dealt.damage` exacto (arena/2). */
export type ImpactClass = "hit" | "critical" | "kill";

export type ProjectDamageForViewer = (view: InternalDamageView, ctx: ProjectionContext) => PublicDamageState;
export type ProjectTurret = (track: PublicTurretTrack, ctx: ProjectionContext) => PublicTurretState;

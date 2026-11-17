/**
 * OLA 2 · MC · CONTRATO DE CAMPOS DEL CATÁLOGO (P-2: «catálogo veraz»).
 *
 * Cada campo que module.schema.json declara tiene aquí su estado (`FieldStatus` del
 * contrato, contracts/engine-v2.ts) y, si cuenta, la MUTACIÓN con la que el gate
 * CATALOG_CONTRACT (catalog-contract.test.ts) demuestra que tiene consumidor:
 *
 *   ACTIVE          · mutar el valor en el catálogo cambia, en una batalla corta
 *                     determinista que pasa por resolveVehicle() (la frontera catálogo →
 *                     simulación), la MAGNITUD DE EFECTO OBSERVABLE que la entrada declara en
 *                     `observes` (canales de catalog-probe.ts: daño aplicado, cinemática,
 *                     proyectiles, minas, eventos, radio recibida…). G1: ya NO basta con
 *                     que cambie el hash de estado: un campo sólo copiado al estado vivo,
 *                     sin efecto, no cuenta como usado.
 *                     Ronda 4 (P2-1c, CLASE «estado sin consumidor»): además, la mutación
 *                     tiene que cambiar al menos uno de los canales que el campo GOBIERNA
 *                     (`governs`): aquellos en los que se nota su efecto sobre el
 *                     COMPORTAMIENTO (qué se mueve, qué se dispara, qué se siembra, qué se
 *                     detecta, qué daño recibe otro, qué llega por radio, quién muere). Un
 *                     campo cuya mutación sólo cambia su propio estado (la energía que nadie
 *                     consulta, el estado de un módulo que nada lee, el evento que declara un
 *                     rechazo que no ocurrió) pone el gate en rojo. Y el gate ANULA en el
 *                     test el consumidor de cada campo (bloque D4, ablación): con el
 *                     consumidor anulado, algún canal gobernado tiene que cambiar; así la
 *                     declaración `governs` no puede quedarse vacía.
 *   VALIDATION_ONLY · mutarlo cambia el veredicto de validateLoadout() y NO la batalla.
 *   FUTURE          · sin consumidor: el esquema NO lo admite (no hay ninguno hoy).
 *   REMOVE          · eliminado del esquema; el gate comprueba que un módulo que lo traiga
 *                     se rechaza.
 *
 * Un campo declarado sin entrada, una entrada ACTIVE cuya mutación no cambia la batalla o
 * una VALIDATION_ONLY que sí la cambia ponen el gate en rojo. Esta tabla NO afirma: la
 * afirmación la comprueba el gate. La tabla de la UI (effect-status.ts) debe coincidir.
 *
 * Rutas: "power.passiveEUs" (objeto anidado) y "slots[].id" (elementos de lista).
 */
import type { FieldStatus } from "./contracts/engine-v2.js";
import type { ModuleCategory, ModuleDefinition } from "./types.js";

/** Nuevo valor del campo a partir del actual (`undefined` = el módulo no lo declaraba). */
export type Perturb = (value: unknown, def: ModuleDefinition) => unknown;

/**
 * G1 · Canales de efecto observable de la sonda (catalog-probe.ts los define y los mide).
 * Cada entrada ACTIVE declara cuáles DEBEN cambiar al mutarla (todos los declarados).
 */
export const PROBE_CHANNELS = [
  "kinematics",
  "turret",
  "hull",
  "modules",
  "energy",
  "projectiles",
  "mines",
  "damage",
  "events",
  "sensors",
  "radio",
  "score",
] as const;
export type ProbeChannel = (typeof PROBE_CHANNELS)[number];

/**
 * Ronda 4 · Canales que NUNCA cuentan como efecto gobernado: son CONTABILIDAD o DECLARACIÓN,
 * no comportamiento. `energy` es el libro de la energía (E1: se gasta y se recarga aunque no
 * limite nada); `modules` es el hp y el estado de cada módulo (un estado que ningún consumidor
 * lee); `events` son los eventos que el motor DICE (E3: emite `out_of_arc` y dispara igual).
 * Un campo puede declararlos en `observes`, nunca en `governs`.
 */
export const LEDGER_CHANNELS: readonly ProbeChannel[] = ["energy", "modules", "events"];
/** Canales en los que se ve el comportamiento: los únicos admitidos en `governs`. */
export const BEHAVIOR_CHANNELS: readonly ProbeChannel[] = PROBE_CHANNELS.filter((c) => !LEDGER_CHANNELS.includes(c));

/**
 * Ronda 4 · Canales donde se registra el ESTADO PROPIO del campo (además de LEDGER_CHANNELS):
 * un campo no puede gobernarlos, porque cambiarían aunque nada leyera ese estado.
 *   - el hp de un módulo (y todo el blindaje) se registra como hp perdido en `damage`;
 *   - el casco del chasis, en `hull` y en `damage`.
 */
export function ownStateChannels(category: ModuleCategory, field: string): readonly ProbeChannel[] {
  if (field === "hp" || category === "armor") return ["damage"];
  if (category === "chassis" && field === "hullHp") return ["hull", "damage"];
  return [];
}

export interface FieldContract {
  readonly status: FieldStatus;
  /** ACTIVE: magnitudes de efecto observable que la mutación DEBE cambiar (G1). */
  readonly observes?: readonly ProbeChannel[];
  /**
   * ACTIVE (ronda 4): canales de COMPORTAMIENTO que el campo gobierna (sólo BEHAVIOR_CHANNELS
   * y nunca su estado propio). La mutación tiene que cambiar AL MENOS UNO, y la ablación de su
   * consumidor también (catalog-contract.test.ts, D1 y D4).
   */
  readonly governs?: readonly ProbeChannel[];
  /**
   * La sonda monta el loadout BASE (construido con el catálogo sin mutar) y no el derivado del
   * catálogo mutado. Para una clave de unión (el id de ranura): con un loadout que sigue al
   * renombrado, el cambio es la identidad; el consumidor real es la búsqueda por esa clave.
   */
  readonly baseLoadout?: boolean;
  /**
   * Portador del campo en el D1 (`id@versión`) cuando el primero del catálogo no deja ver el
   * consumidor en la sonda (p. ej. una batería de 500 EU no se agota en 15 s: su generación
   * nunca limita nada). El portador tiene que declarar el campo.
   */
  readonly carrier?: string;
  /** Consumidor real (ACTIVE) o regla del validador (VALIDATION_ONLY). */
  readonly consumer: string;
  /** Mutación del gate (obligatoria en ACTIVE y VALIDATION_ONLY). */
  readonly perturb?: Perturb;
  /** Valor que el gate inyecta si ningún módulo real declara el campo. */
  readonly sample?: unknown;
  readonly reason?: string;
}

const n = (v: unknown): number => v as number;
const scale =
  (k: number, add = 0): Perturb =>
  (v) =>
    n(v) * k + add;
const intScale =
  (k: number, min = 1): Perturb =>
  (v) =>
    Math.max(min, Math.round(n(v) * k));
const set =
  (x: unknown): Perturb =>
  () =>
    x;
const rotate =
  (cycle: readonly string[]): Perturb =>
  (v) =>
    cycle[(cycle.indexOf(v as string) + 1) % cycle.length];

const A = (
  consumer: string,
  perturb: Perturb,
  observes: readonly ProbeChannel[],
  governs: readonly ProbeChannel[],
  extra: Partial<FieldContract> = {},
): FieldContract => ({
  status: "ACTIVE",
  consumer,
  perturb,
  observes,
  governs,
  ...extra,
});
/** Lo que la energía limita: aceptar o rechazar (no_energy) el disparo y la siembra. */
const ENERGY_LIMITED: readonly ProbeChannel[] = ["projectiles", "mines"];
/**
 * hp de un módulo, por categoría (ronda 4): su consumidor es `Vehicle.stateOf` (hp/hpMáx), y
 * el estado sólo cuenta por lo que hace el MÓDULO con él. En la batalla de durabilidad el
 * blanco USA su módulo (catalog-probe.ts, Operator): conduce, gira la torreta, dispara,
 * siembra, emite por radio y observa.
 */
const hp = (consumer: string, governs: readonly ProbeChannel[], extra: Partial<FieldContract> = {}): FieldContract =>
  A(`Vehicle.stateOf (hp/hpMáx) → ${consumer}`, scale(0.25), ["modules"], governs, extra);
const V = (consumer: string, perturb: Perturb, sample?: unknown): FieldContract => ({
  status: "VALIDATION_ONLY",
  consumer,
  perturb,
  ...(sample !== undefined ? { sample } : {}),
});

/** Identidad y metadatos: no son datos de juego. El gate exige que no cambien la batalla. */
export const IDENTITY_FIELDS: readonly string[] = ["id", "version", "category", "name", "description", "tags"];

/** Campos comunes a todo módulo (propiedades raíz del esquema). */
export const COMMON_FIELDS: Readonly<Record<string, FieldContract>> = {
  massKg: A(
    "resolve/index.ts → VehicleSpec.massKg → vehicle.ts movementCaps (massFactor, D7) + physics.addVehicle",
    scale(4, 50),
    ["kinematics"],
    ["kinematics"],
  ),
  costCredits: V("validator: budget_exceeded / module_cost_cap_exceeded", scale(50, 1000)),
  size: V("validator: slot_size_exceeded (SIZE_RANK de la ranura)", (v) => (v === "XL" ? "S" : "XL")),
  // Cada categoría declara el suyo (CATEGORY_FIELDS: el estado sólo cuenta por lo que hace el
  // módulo); esta entrada es la de reserva y no la usa hoy ninguna categoría.
  hp: hp("performanceOf / moduleActs / activeModulesOf", BEHAVIOR_CHANNELS),
  "power.passiveEUs": {
    ...A(
      "vehicle.ts passiveDrain → tickEnergy → combat.ts canFire / canDeployMine (no_energy)",
      // Ronda 4: el consumo tiene que llegar a agotar la reserva de la sonda (×6+1 no la agotaba
      // en 15 s: la energía cambiaba, el disparo no).
      scale(40, 20),
      ["energy"],
      ENERGY_LIMITED,
    ),
    sample: 2,
  },
  "power.perActionEU": A(
    "combat.ts canFire / canDeployMine (no_energy) + fire / deployMine (gasto)",
    scale(8, 5),
    ["energy"],
    ENERGY_LIMITED,
  ),
  // El gate lo prueba con DOS copias del módulo (ver catalog-contract.test.ts).
  maxPerVehicle: V("validator: duplicate_limit_exceeded (maxPerVehicle)", (v) => (v === 1 ? 3 : 1), 3),
  requiresChassis: V("validator: incompatible_chassis (requiresChassis)", set(["chassis.nonexistent"]), [
    "chassis.nonexistent",
  ]),
};

const SENSOR_TYPES = ["lidar", "radar", "proximity", "acoustic"] as const;
const SECTORS = ["front", "right", "rear", "left"] as const;

export const CATEGORY_FIELDS: Readonly<Record<ModuleCategory, Readonly<Record<string, FieldContract>>>> = {
  chassis: {
    hullHp: A(
      "resolve → VehicleSpec.hullHp → Vehicle.hullHp → damage.ts resolveDamage (killed) → battle.ts onKill (marcador)",
      scale(0.5),
      ["hull"],
      ["score"],
    ),
    radiusM: A(
      "resolve → VehicleSpec.radiusM → physics.addVehicle (colisionador) + boca del arma y perímetro (battle.ts)",
      scale(1.4),
      ["kinematics"],
      ["kinematics", "projectiles"],
    ),
    maxLoadKg: V("validator: mass_exceeded", scale(0.1)),
    // Integración OLA2 (MB+MC): con D-B2 la ranura es la CLAVE de la montura de torreta
    // (resolve → VehicleSpec.turretMounts[slot.id]); el id de ranura ya no es sólo de validación.
    // Ronda 4: con el loadout BASE (el de la ranura original), como en producción un loadout
    // guardado contra un chasis cuyo id de ranura cambia: la montura ya no se encuentra.
    "slots[].id": A(
      "resolve → VehicleSpec.turretMounts[slot.id] → vehicle.ts mountOf(slot) (montura D-B2) + validator unknown_slot",
      (v) => `${String(v)}_x`,
      ["turret"],
      ["turret", "projectiles"],
      { baseLoadout: true },
    ),
    "slots[].accepts": V("validator: slot_type_mismatch", set(["utility"])),
    "slots[].maxSize": V("validator: slot_size_exceeded", set("S")),
    "slots[].sector": V("validator: slot_type_mismatch (sector de blindaje de la ranura)", rotate(SECTORS)),
    // D-B2 (MB): la cinemática de torreta es de la MONTURA de la ranura del chasis, no del arma.
    "slots[].mount.turretRateRads": A(
      "resolve → VehicleSpec.turretMounts → vehicle.ts turretRate → stepTurret (giro)",
      scale(0.2),
      ["turret"],
      ["turret"],
    ),
    // Ronda 4 (E3): el evento out_of_arc es una DECLARACIÓN; lo gobernado es el giro limitado
    // (stepTurret) y el disparo que no sale (canFire).
    "slots[].mount.turretArcRad": A(
      "resolve → VehicleSpec.turretMounts → vehicle.ts turretArc → stepTurret (límite del giro) + mountArcOf → combat.ts canFire (out_of_arc)",
      set(0.5),
      ["events"],
      ["turret", "projectiles"],
    ),
  },
  movement: {
    hp: hp("vehicle.ts movementCaps (activeModulesOf + performanceOf)", ["kinematics"]),
    maxSpeedMs: A("vehicle.ts movementCaps → physics.driveVehicle", scale(0.3), ["kinematics"], ["kinematics"]),
    accelerationMs2: A("vehicle.ts movementCaps → physics.driveVehicle", scale(0.2), ["kinematics"], ["kinematics"]),
    turnRateRads: A("vehicle.ts movementCaps → physics.driveVehicle", scale(0.2), ["kinematics"], ["kinematics"]),
    ratedLoadKg: A("vehicle.ts movementCaps (massFactor, D7)", scale(0.1), ["kinematics"], ["kinematics"]),
  },
  power: {
    // El generador: una batería de 500 EU no se agota en la sonda y su estado no limitaría nada.
    hp: hp("vehicle.ts energyGeneration (performanceOf) / passiveDrain → canFire / canDeployMine", ENERGY_LIMITED, {
      carrier: "power.generator@1",
    }),
    capacityEU: A(
      "vehicle.ts energyCapacity → tickEnergy (tope) → combat.ts canFire / canDeployMine (no_energy)",
      scale(0.05),
      ["energy"],
      ENERGY_LIMITED,
    ),
    generationEUs: A(
      "vehicle.ts energyGeneration → tickEnergy → combat.ts canFire / canDeployMine (no_energy)",
      scale(0.1),
      ["energy"],
      ENERGY_LIMITED,
      { carrier: "power.generator@1" },
    ),
  },
  sensor: {
    hp: hp("sensors.ts buildObservation (activeModulesOf, moduleActs, performanceOf)", ["sensors"]),
    sensorType: A("sensors.ts buildObservation (primitiva por tipo)", rotate(SENSOR_TYPES), ["sensors"], ["sensors"]),
    rangeM: A("sensors.ts buildObservation (rangeM · rendimiento)", scale(0.3), ["sensors"], ["sensors"]),
    fovRad: A(
      "sensors.ts buildObservation, lidar (sólo lidar: esquema condicional)",
      scale(0.3),
      ["sensors"],
      ["sensors"],
    ),
    rays: A(
      "sensors.ts buildObservation, lidar (sólo lidar: esquema condicional)",
      intScale(0.25),
      ["sensors"],
      ["sensors"],
    ),
    errorM: A(
      "sensors.ts buildObservation, radar (sólo radar: esquema condicional)",
      scale(5, 3),
      ["sensors"],
      ["sensors"],
    ),
  },
  weapon: {
    hp: hp("combat.ts canFire (module_destroyed / critical_failure) + fire (performanceOf) + vehicle.ts turretRate", [
      "projectiles",
      "turret",
    ]),
    damage: A("combat.ts fire (Projectile.damage) → battle.ts damageVehicle", scale(3), ["damage"], ["damage"]),
    cooldownTicks: A(
      "combat.ts fire (cooldownUntilTick) → canFire (cooldown)",
      intScale(3),
      ["projectiles"],
      ["projectiles"],
    ),
    projectileSpeedMs: A(
      "combat.ts fire (velocidad) + resolve/projectile.ts (vida)",
      scale(0.5),
      ["projectiles"],
      ["projectiles"],
    ),
    rangeM: A(
      "resolve/projectile.ts → combat.ts projectileLifetimeOf → Projectile.ttlTicks → battle.ts resolveProjectiles (P-2)",
      scale(0.1),
      ["projectiles"],
      ["projectiles"],
    ),
    spreadRad: A("combat.ts fire (dispersión con el RNG del motor)", scale(10, 0.05), ["projectiles"], ["projectiles"]),
    // Ronda 4: con el loadout BASE (la munición montada), el consumidor es ammoFor, que deja de
    // aceptarla; con el derivado del catálogo mutado el arma ni siquiera llevaría munición.
    acceptsAmmo: A(
      "combat.ts ammoFor → canFire (no_ammo) / fire + validator incompatible_ammo",
      set(["ammo.none_x"]),
      ["projectiles"],
      ["projectiles"],
      { baseLoadout: true },
    ),
  },
  ammo: {
    // La munición no tiene acción propia: su estado no lo lee nadie (ammoFor no lo mira). Su hp
    // cuenta porque una munición DESTRUIDA deja de absorber daño de módulo (damage.ts: sólo
    // son candidatos los módulos con hp > 0), que pasa al arma.
    // La de la ametralladora: su cadencia (cooldown/rendimiento) deja ver CUÁNDO se degrada el
    // arma; con el cañón (un disparo cada 30 ticks) el adelanto no cambiaba ningún disparo.
    hp: A(
      "damage.ts resolveDamage (candidatos con hp > 0: absorbe daño de módulo mientras vive) → arma",
      scale(0.25),
      ["modules"],
      ["projectiles"],
      { carrier: "ammo.standard@1" },
    ),
    rounds: A("vehicle.ts ModuleRuntime.ammo → combat.ts canFire (no_ammo)", set(2), ["projectiles"], ["projectiles"]),
    damageMultiplier: A(
      "combat.ts fire (Projectile.damage) → battle.ts damageVehicle",
      scale(3),
      ["damage"],
      ["damage"],
    ),
    explosionRadiusM: A("combat.ts fire → battle.ts explode", (v) => (n(v ?? 0) > 0 ? 0 : 6), ["damage"], ["damage"]),
  },
  mine: {
    hp: hp("combat.ts canDeployMine (module_destroyed)", ["mines"]),
    charges: A(
      "vehicle.ts ModuleRuntime.charges → canDeployMine (no_charges)",
      (v) => (n(v) > 1 ? 1 : 3),
      ["mines"],
      ["mines"],
    ),
    damage: A("combat.ts deployMine → battle.ts resolveMines → explode", scale(3), ["damage"], ["damage"]),
    triggerRadiusM: A("combat.ts deployMine → battle.ts resolveMines (detonación)", scale(5), ["mines"], ["mines"]),
    explosionRadiusM: A("combat.ts deployMine → battle.ts explode", scale(3), ["damage"], ["damage"]),
    armDelayTicks: A("combat.ts deployMine (armedAtTick) → battle.ts resolveMines", set(400), ["mines"], ["mines"]),
    cooldownTicks: A(
      "combat.ts deployMine (cooldownUntilTick) → canDeployMine (cooldown)",
      intScale(4),
      ["mines"],
      ["mines"],
    ),
    lifetimeTicks: A("combat.ts deployMine (expiresAtTick) → battle.ts resolveMines", set(45), ["mines"], ["mines"]),
  },
  // Ronda 4: el desgaste del blindaje (hp que pierde) es su estado propio y va en `damage`; lo
  // gobernado es el casco que protege.
  armor: {
    hp: hp("damage.ts resolveDamage (armorActive: el blindaje protege mientras hp > 0)", ["hull"]),
    sector: A(
      "vehicle.ts armor[sector] → damage.ts resolveDamage (+ validator)",
      rotate(SECTORS),
      ["damage"],
      ["hull"],
    ),
    reduction: A("vehicle.ts armor.profile → damage.ts resolveDamage (efectivo)", scale(0.2), ["damage"], ["hull"]),
  },
  radio: {
    hp: hp("sensors.ts validateRadio (no_radio) + radioRangeOf (performanceOf)", ["radio"]),
    rangeM: A("sensors.ts radioRangeOf → radioDeliverableTo (P-2: alcance real)", scale(0.1), ["radio"], ["radio"]),
    maxMessageBytes: A("sensors.ts validateRadio (too_large)", set(4), ["radio"], ["radio"]),
    maxMessagesPerSecond: A("sensors.ts validateRadio (rate_limited)", set(0.5), ["radio"], ["radio"]),
  },
  // Sin campos propios (P-2). Declarará `actions` (contracts/engine-v2.ts) con su consumidor.
  // Su hp, como el de la munición: mientras vive absorbe daño de módulo que si no va a otro.
  utility: {
    hp: A(
      "damage.ts resolveDamage (candidatos con hp > 0: absorbe daño de módulo mientras vive) → arma del mismo vehículo",
      scale(0.25),
      ["modules"],
      ["projectiles"],
    ),
  },
};

/** Campos ELIMINADOS en la OLA 2 (P-2), con la categoría que los declaraba y el criterio. */
export const REMOVED_FIELDS: Readonly<Record<string, { category: ModuleCategory; reason: string }>> = {
  "movement.terrain": {
    category: "movement",
    reason: "Decisión fijada P-2: REMOVE. El mapa no tiene tipos de terreno; ningún código lo leía.",
  },
  "power.peakEUs": {
    category: "power",
    reason: "Sin modelo de potencia de pico en el motor ni en los contratos: implementarlo es diseño nuevo.",
  },
  "sensor.refreshEveryNDecisions": {
    category: "sensor",
    reason:
      "Exige observación en caché por sensor dentro del hash y semántica de decisiones sin refresco (MD/MA); no está en los contratos.",
  },
  "radio.encrypted": {
    category: "radio",
    reason: "Sólo tendría sentido con escucha enemiga, que el motor no modela (RADIO_SCOPE=TEAM).",
  },
  "mine.detectable": {
    category: "mine",
    reason:
      "Nunca se copiaba (Mine.detectable fijo a true). Lo sustituye DeployableVisibilityDef.signature del contrato, con su consumidor.",
  },
  "utility.effect": {
    category: "utility",
    reason: "Enum de nombres de producto sin consumidor; el contrato lo sustituye por `actions` (ActionDef).",
  },
  "utility.magnitude": { category: "utility", reason: "Absorbido por EffectDef.strength (contrato §8)." },
  "utility.durationTicks": { category: "utility", reason: "Absorbido por EffectDef.durationTicks (contrato §8)." },
  "utility.charges": {
    category: "utility",
    reason: "Sin consumidor (el comando utility se ignora); pasa a ActionDef.cost.charges.",
  },
  "utility.cooldownTicks": {
    category: "utility",
    reason: "Sin consumidor (el comando utility se ignora); pasa a ActionDef.cooldownTicks.",
  },
  "chassis.slots[].offsetM": {
    category: "chassis",
    reason: "Declarado sin datos ni consumidor (ni simulación ni visor): campo falso.",
  },
};

/** Contrato de un campo en una categoría (específico o común). `undefined` = sin clasificar. */
export function fieldContract(category: ModuleCategory, field: string): FieldContract | undefined {
  const own = CATEGORY_FIELDS[category];
  if (own && Object.prototype.hasOwnProperty.call(own, field)) return own[field];
  if (Object.prototype.hasOwnProperty.call(COMMON_FIELDS, field)) return COMMON_FIELDS[field];
  return undefined;
}

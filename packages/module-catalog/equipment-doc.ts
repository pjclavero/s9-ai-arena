/**
 * DOC-A · EQUIPMENT_DOCS_CURRENT · Guía de equipamiento GENERADA desde el catálogo real.
 *
 * Produce `docs/user/equipment-catalog.md`: las tablas de chasis y módulos con sus cifras
 * (coste, masa, vida, consumo, prestaciones) y la lista de datos del catálogo que NO
 * cambian la batalla. Nada se copia a mano:
 *   - las cifras salen de `packages/module-catalog/data/*.json` (loadCatalog);
 *   - los nombres de ranuras, categorías y propiedades, de `apps/web/src/help/names.ts`
 *     (los mismos que enseña el editor de loadout y el Centro de Ayuda);
 *   - qué propiedades cambian la batalla, de `effect-status.ts`.
 * `scripts/generate-equipment-doc.ts` lo escribe; `equipment-doc.test.ts` falla si el
 * fichero del repo no coincide con lo que genera el catálogo.
 */
import { loadCatalog } from "./loadCatalog.js";
import { PROPERTY_EFFECTS, NON_GAMEPLAY_KEYS, effectOf } from "./effect-status.js";
import type { ModuleCategory, ModuleDefinition } from "./types.js";
import {
  BUDGET_CREDITS_MVP,
  DMG_MIN_FRACTION,
  MASS_SPEED_FLOOR,
  MAX_MODULE_COST_FRACTION,
  TICK_HZ,
} from "../game-rules/constants.js";
import {
  CATEGORY_NAME,
  SECTOR_NAME,
  SENSOR_TYPE_NAME,
  propLabel,
  propUnit,
  slotName,
  SIZE_NAME,
} from "../../apps/web/src/help/names.js";

const TICKS_PER_SECOND = TICK_HZ;
const pct = (f: number): string => `${Math.round(f * 100)} %`;

/** Nombre para el jugador: «(v2, balance)» del catálogo pasa a «(versión 2)». */
export function playerName(m: ModuleDefinition): string {
  return m.name.replace(/\s*\(v(\d+), balance\)/, " (versión $1)");
}

/** Nombre inequívoco: si el módulo tiene varias versiones, la primera también lo dice. */
function displayName(m: ModuleDefinition, all: ModuleDefinition[]): string {
  const sameId = all.filter((x) => x.id === m.id);
  const n = playerName(m);
  if (sameId.length > 1 && !/\(versión \d+\)/.test(n)) return `${n} (versión ${m.version})`;
  return n;
}

const num = (v: number): string => String(Math.round(v * 1000) / 1000).replace(".", ",");
const deg = (rad: number): string => `${Math.round((rad * 180) / Math.PI)}°`;

function cell(m: ModuleDefinition, key: string): string {
  const get = (k: string): unknown => {
    if (k === "power.passiveEUs") return m.power?.passiveEUs;
    if (k === "power.perActionEU") return m.power?.perActionEU;
    return (m as unknown as Record<string, unknown>)[k];
  };
  const v = get(key);
  if (v === undefined || v === null) return "—";
  if (key === "size") return SIZE_NAME[v as string] ?? String(v);
  if (key === "fovRad") return `${deg(v as number)} (${num(v as number)} rad)`;
  if (key === "cooldownTicks") return `${v} ticks (${num((v as number) / TICKS_PER_SECOND)} s)`;
  if (key === "armDelayTicks") return `${v} ticks (${num((v as number) / TICKS_PER_SECOND)} s)`;
  if (key === "lifetimeTicks") return `${v} ticks (${num((v as number) / TICKS_PER_SECOND)} s)`;
  if (key === "sensorType") return SENSOR_TYPE_NAME[v as string] ?? String(v);
  if (key === "sector") return SECTOR_NAME[v as string] ?? String(v);
  if (key === "reduction") return `${num((v as number) * 100)} %`;
  if (key === "acceptsAmmo")
    return (v as string[])
      .map((id) => {
        const am = ALL.find((x) => x.id === id);
        return am ? playerName(am) : id;
      })
      .join(", ");
  if (typeof v === "number") return num(v);
  return String(v);
}

function header(key: string): string {
  if (key === "fovRad") return propLabel(key); // la celda ya lleva grados y radianes
  const unit = propUnit(key);
  const label = propLabel(key);
  return unit ? `${label} (${unit})` : label;
}

let ALL: ModuleDefinition[] = [];

/** Columnas de cada categoría: SOLO propiedades que cambian la batalla o que el jugador necesita para elegir. */
const COLUMNS: Record<ModuleCategory, string[]> = {
  chassis: ["hullHp", "radiusM", "massKg", "maxLoadKg", "costCredits"],
  movement: [
    "maxSpeedMs",
    "accelerationMs2",
    "turnRateRads",
    "ratedLoadKg",
    "massKg",
    "costCredits",
    "power.passiveEUs",
    "size",
  ],
  power: ["capacityEU", "generationEUs", "massKg", "costCredits", "size"],
  sensor: ["sensorType", "rangeM", "fovRad", "rays", "errorM", "massKg", "costCredits", "power.passiveEUs", "size"],
  weapon: [
    "damage",
    "cooldownTicks",
    "projectileSpeedMs",
    "spreadRad",
    "power.perActionEU",
    "massKg",
    "costCredits",
    "size",
    "acceptsAmmo",
  ],
  ammo: ["rounds", "damageMultiplier", "explosionRadiusM", "massKg", "costCredits", "size"],
  armor: ["sector", "reduction", "hp", "massKg", "costCredits", "size"],
  radio: ["maxMessageBytes", "maxMessagesPerSecond", "massKg", "costCredits", "power.passiveEUs", "size"],
  mine: [
    "charges",
    "damage",
    "triggerRadiusM",
    "explosionRadiusM",
    "armDelayTicks",
    "cooldownTicks",
    "lifetimeTicks",
    "power.perActionEU",
    "massKg",
    "costCredits",
    "size",
  ],
  utility: [],
};

const ORDER: ModuleCategory[] = ["chassis", "movement", "power", "sensor", "weapon", "ammo", "armor", "radio", "mine"];

const INTRO: Record<ModuleCategory, string> = {
  chassis:
    "El chasis es la base del vehículo: fija su vida, su tamaño, el peso que puede cargar y qué ranuras tiene (y de qué tamaño máximo).",
  movement: `Decide la velocidad y el giro. Si el vehículo pesa más que la **carga nominal**, se frena (hasta un mínimo del ${pct(MASS_SPEED_FLOOR)}). Con varios módulos de movimiento manda el mejor; no se suman.`,
  power:
    "Todo consume energía (EU). La reserva se carga con la generación menos el consumo; disparar y soltar minas gasta además un poco por acción. Sin energía, la acción se rechaza.",
  sensor:
    "Son los únicos ojos de tu bot: sin un sensor operativo, la observación no trae esa información. Cada tipo ve distinto (ver la [guía de sensores](bots/sensores.md)).",
  weapon: `El arma dispara la munición que le montes (columna «Munición compatible»). La recarga se cuenta en ticks (${TICKS_PER_SECOND} por segundo).`,
  ammo: "La munición se monta con el arma. Cada tipo cambia el daño y el número de disparos.",
  armor: `Cada pieza protege un sector (frontal, izquierdo, derecho o trasero). Reduce el daño que entra por ese lado, nunca por debajo del ${pct(DMG_MIN_FRACTION)} del daño original, y se desgasta con lo que absorbe.`,
  radio:
    "Permite enviar mensajes cortos (ver la [guía de radio](bots/radio.md)). La radio permite compartir información con los bots de tu propio equipo. Los bots rivales no reciben estos mensajes.",
  mine: "La mina se suelta con el comando `deployMine` y sólo cabe en la bahía de minas de los chasis medio y pesado.",
  utility: "",
};

function table(rows: ModuleDefinition[], cat: ModuleCategory): string {
  const cols = COLUMNS[cat];
  const head = ["Nombre", ...cols.map(header)];
  const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const m of rows) lines.push(`| ${[displayName(m, ALL), ...cols.map((c) => cell(m, c))].join(" | ")} |`);
  return lines.join("\n");
}

function slotsTable(chassis: ModuleDefinition[]): string {
  const lines = [
    "| Chasis | Ranuras (entre paréntesis, el tamaño máximo de pieza: S pequeño, M mediano, L grande, XL muy grande) |",
    "|---|---|",
  ];
  for (const c of chassis) {
    // D-B2 · la torreta gira según la MONTURA de la ranura del chasis, no según el arma.
    const slots = (c.slots ?? [])
      .map((s) => `${slotName(s.id)} (${s.maxSize}${s.mount ? `, torreta ${num(s.mount.turretRateRads)} rad/s` : ""})`)
      .join(" · ");
    lines.push(`| ${displayName(c, ALL)} | ${slots} |`);
  }
  return lines.join("\n");
}

/** Qué decir al jugador de cada dato sin efecto (el texto técnico de effect-status.ts no es para jugadores). */
const FUTURE_NOTE: Record<string, string> = {
  "weapon.rangeM": "el alcance real lo marca cuánto tiempo vive el proyectil en vuelo, no este dato.",
  "radio.rangeM": "la radio no tiene alcance: llega a cualquier distancia.",
  "movement.terrain": "el terreno no influye en la velocidad.",
};

/** Propiedades del catálogo que ningún código de simulación lee: no te fíes de ellas. */
function noEffectList(): string {
  const out: string[] = [];
  for (const cat of Object.keys(PROPERTY_EFFECTS) as ModuleCategory[]) {
    for (const [prop, eff] of Object.entries(PROPERTY_EFFECTS[cat])) {
      if (eff.status !== "FUTURE" || cat === "utility") continue;
      const note = FUTURE_NOTE[`${cat}.${prop}`] ?? "todavía no tiene ningún efecto en la batalla.";
      out.push(`- **${CATEGORY_NAME[cat] ?? cat} · ${propLabel(prop)}**: ${note}`);
    }
  }
  out.push(
    "- **Utilidades**: el catálogo no trae ninguna pieza de utilidad y el comando `utility` todavía no hace nada.",
  );
  return out.join("\n");
}

function validationOnlyList(): string {
  const props = new Set<string>();
  for (const cat of Object.keys(PROPERTY_EFFECTS) as ModuleCategory[]) {
    for (const [prop, eff] of Object.entries(PROPERTY_EFFECTS[cat])) if (eff.status === "PARTIAL") props.add(prop);
  }
  for (const key of ["costCredits", "size", "maxPerVehicle"])
    if (effectOf("weapon", key)?.status === "PARTIAL") props.add(key);
  return [...props].map((p) => `- ${propLabel(p)}`).join("\n");
}

export function equipmentDocMarkdown(catalog: ModuleDefinition[] = loadCatalog()): string {
  ALL = catalog;
  const by = (cat: ModuleCategory) => catalog.filter((m) => m.category === cat);
  const parts: string[] = [];
  parts.push(`# Catálogo de equipamiento

> GENERADO desde el catálogo de módulos (\`packages/module-catalog/data\`) con \`npx tsx scripts/generate-equipment-doc.ts\`. No editar a mano: \`packages/module-catalog/equipment-doc.test.ts\` falla si este fichero no coincide con el catálogo. Cómo se usa el equipamiento, en [Equipamiento](equipment.md).

Estas son **todas las piezas** que puedes montar hoy (catálogo \`mvp@1\`, ${catalog.length} piezas). Las cifras son las que usa el simulador. Unidades: metros (m), kilos (kg), créditos (cr), energía (EU, y EU/s por segundo), radianes (rad) y ticks (el juego va a ${TICKS_PER_SECOND} ticks por segundo).

Un loadout no puede pasar de **${BUDGET_CREDITS_MVP} créditos** en una batalla de práctica (los torneos y las reglas personalizadas pueden fijar otro presupuesto), ninguna pieza puede costar más del ${pct(MAX_MODULE_COST_FRACTION)} del presupuesto, y el peso de las piezas no puede superar la **carga máxima** del chasis.
`);
  for (const cat of ORDER) {
    const rows = by(cat);
    if (rows.length === 0) continue;
    parts.push(`## ${CATEGORY_NAME[cat] ?? cat}\n\n${INTRO[cat]}\n\n${table(rows, cat)}\n`);
    if (cat === "chassis") parts.push(`### Ranuras de cada chasis\n\n${slotsTable(rows)}\n`);
  }
  parts.push(`## Datos que no cambian la batalla

Algunos datos del catálogo existen pero **ningún código de la simulación los lee todavía**. No cuentes con ellos:

${noEffectList()}

Estos otros sólo cuentan para **validar** el loadout (no cambian lo que pasa en la batalla):

${validationOnlyList()}
`);
  return parts.join("\n");
}

/** Claves que no son datos de juego (para el test de cobertura). */
export const NON_GAMEPLAY = NON_GAMEPLAY_KEYS;

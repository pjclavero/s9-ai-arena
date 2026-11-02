/**
 * EQ3 · Ayuda de EQUIPAMIENTO, generada desde el catálogo (packages/module-catalog/
 * data/*.json) y desde la tabla de efectos reales (effect-status.ts). Ninguna cifra
 * se escribe a mano: si el catálogo cambia, estas tablas cambian.
 */
import type { ModuleDefinition, ModuleCategory } from "../../../../../packages/module-catalog/types.js";
import { effectOf } from "../../../../../packages/module-catalog/effect-status.js";
import { NON_GAMEPLAY_KEYS } from "../../../../../packages/module-catalog/effect-status.js";
import { CATALOG, CATALOG_VERSION, RULE_CONSTANTS as C } from "../sources.js";
import {
  CATEGORY_NAME,
  EFFECT_STATUS_NAME,
  SECTOR_NAME,
  SENSOR_TYPE_NAME,
  SIZE_NAME,
  humanize,
  propLabel,
  propUnit,
  slotName,
} from "../names.js";
import { InfoTip } from "../InfoTip.js";
import { Note } from "../blocks.js";
import { helpHref } from "../tree.js";

/** Introducción por categoría: qué hace en la batalla (texto), las cifras salen del catálogo. */
const INTRO: Record<string, string> = {
  chassis:
    'La base del vehículo: fija el casco (sus puntos de vida), el tamaño de colisión, la carga que admite y QUÉ ranuras tiene. El nombre de cada ranura es el que usas en el código del bot (por ejemplo «fire»: ["turret_main"]).',
  movement:
    "Convierte la orden «move» (throttle/steer) en velocidad. La masa total por encima de la carga nominal frena el vehículo (nunca por debajo del suelo de velocidad).",
  power:
    "Genera y almacena energía (EU). Los módulos consumen de forma pasiva y algunos por acción (disparar, desplegar una mina). Sin energía, las acciones se rechazan con «no_energy».",
  sensor:
    "Lo único que tu bot «ve». Un vehículo sin sensores operativos está ciego: la observación sólo trae lo que perciben los sensores montados (niebla de guerra).",
  weapon:
    'Va en una ranura de torreta. Se dispara con «fire»: ["<ranura>"] y se apunta con «turret». Cada arma admite sólo ciertas municiones.',
  ammo: "Va en la ranura de munición. Fija cuántos disparos tienes y multiplica el daño del arma; algunas explotan en área.",
  armor:
    "Cada placa protege UN sector (frontal, izquierdo, derecho, trasero) y reduce el daño que entra por él. El blindaje nunca reduce el daño por debajo del mínimo fijado por las reglas.",
  radio:
    "Permite enviar mensajes cortos a tu equipo con «radio». Los límites de tamaño y frecuencia son los del módulo.",
  mine: "Se monta en el compartimento de minas y se despliega con «deployMine». Arma tras un retardo y explota al pasar un vehículo.",
  utility: "Humo, reparación, inhibidor o dron. Hoy ningún módulo de utilidad del catálogo tiene efecto en la batalla.",
};

function fmt(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  if (typeof v === "boolean") return v ? "sí" : "no";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

/** Propiedades de juego de un módulo, con su valor humano, unidad y efecto real. */
export function moduleStats(m: ModuleDefinition) {
  const rows: { key: string; label: string; value: string; status?: string; note?: string }[] = [];
  const add = (key: string, value: unknown) => {
    const e = effectOf(m.category, key);
    let shown = fmt(value);
    if (key === "size") shown = humanize(SIZE_NAME, String(value));
    if (key === "sector") shown = humanize(SECTOR_NAME, String(value));
    if (key === "sensorType") shown = humanize(SENSOR_TYPE_NAME, String(value));
    const unit = propUnit(key);
    rows.push({
      key,
      label: propLabel(key),
      value: unit ? `${shown} ${unit}` : shown,
      status: e?.status,
      note: e?.note,
    });
  };
  for (const [k, v] of Object.entries(m)) {
    if (NON_GAMEPLAY_KEYS.has(k) || k === "slots") continue;
    add(k, v);
  }
  if (m.power) for (const [k, v] of Object.entries(m.power)) add(`power.${k}`, v);
  return rows;
}

function ModuleCard(props: { m: ModuleDefinition }) {
  const { m } = props;
  const vid = `${m.id}@${m.version}`;
  return (
    <section className="card" aria-labelledby={`mod-${vid}`} data-testid={`help-module-${vid}`}>
      <h4 id={`mod-${vid}`}>
        {m.name} <code>{vid}</code>
      </h4>
      {m.description && <p>{m.description}</p>}
      <table className="stack-table">
        <caption className="visually-hidden">Propiedades de {m.name}</caption>
        <thead>
          <tr>
            <th scope="col">Propiedad</th>
            <th scope="col">Valor</th>
            <th scope="col">Efecto real</th>
          </tr>
        </thead>
        <tbody>
          {moduleStats(m).map((r) => (
            <tr key={r.key}>
              <td data-label="Propiedad">
                {r.label} <code>{r.key}</code>
              </td>
              <td data-label="Valor">{r.value}</td>
              <td data-label="Efecto real">
                {r.status ? humanize(EFFECT_STATUS_NAME, r.status) : "—"}
                {r.note && r.status !== "ACTIVE" ? <> — {r.note}</> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {m.slots && (
        <table className="stack-table" data-testid={`help-slots-${vid}`}>
          <caption>Ranuras de {m.name}</caption>
          <thead>
            <tr>
              <th scope="col">Ranura</th>
              <th scope="col">Acepta</th>
              <th scope="col">Tamaño máximo</th>
            </tr>
          </thead>
          <tbody>
            {m.slots.map((s) => (
              <tr key={s.id}>
                <td data-label="Ranura">
                  {slotName(s.id)} <code>{s.id}</code>
                </td>
                <td data-label="Acepta">
                  {s.accepts.map((c) => humanize(CATEGORY_NAME, c)).join(" / ")}
                  {s.sector ? ` (sector ${humanize(SECTOR_NAME, s.sector)})` : ""}
                </td>
                <td data-label="Tamaño máximo">{humanize(SIZE_NAME, s.maxSize)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function modulesOf(categories: ModuleCategory[]): ModuleDefinition[] {
  return CATALOG.filter((m) => categories.includes(m.category));
}

export function EquipmentCategory(props: { categories: ModuleCategory[] }) {
  const mods = modulesOf(props.categories);
  return (
    <div data-testid={`help-equipment-${props.categories.join("-")}`}>
      {props.categories.map((c) => (
        <p key={c}>
          <strong>{humanize(CATEGORY_NAME, c)}.</strong> {INTRO[c]}
        </p>
      ))}
      <Note>
        Datos del catálogo <code>{CATALOG_VERSION}</code> que viaja con esta versión de la web (
        {mods.length === 1 ? "1 módulo" : `${mods.length} módulos`}, todas sus versiones). «Efecto real» dice si la
        propiedad cambia de verdad la batalla o sólo cuenta para validar el loadout.
      </Note>
      {mods.length === 0 ? (
        <p data-testid="help-equipment-empty">El catálogo actual no tiene módulos de esta categoría.</p>
      ) : (
        mods.map((m) => <ModuleCard key={`${m.id}@${m.version}`} m={m} />)
      )}
    </div>
  );
}

export function LoadoutBasics() {
  return (
    <div data-testid="help-loadout">
      <p>
        El <strong>loadout</strong> es el vehículo de una versión de tu bot: un chasis y un módulo por ranura. Al
        guardarlo se valida con las mismas reglas que aplica la plataforma al crear la batalla:
      </p>
      <ul>
        <li>
          <strong>Presupuesto</strong>: chasis + módulos no pueden pasar de los créditos del ruleset (por defecto{" "}
          {C.BUDGET_CREDITS_MVP}; un ruleset puede fijar entre {C.BUDGET_CREDITS_MIN} y {C.BUDGET_CREDITS_MAX}).{" "}
          <InfoTip topic="Presupuesto de créditos" testId="tip-budget">
            Ninguna pieza (ni el chasis) puede costar más del {C.MAX_MODULE_COST_FRACTION * 100} % del presupuesto
            efectivo de la batalla.
          </InfoTip>
        </li>
        <li>
          <strong>Ranuras</strong>: cada módulo debe ir en una ranura que acepte su categoría y su tamaño; las placas de
          blindaje, en la ranura de su sector.
        </li>
        <li>
          <strong>Masa</strong>: la masa de los módulos no puede superar la carga máxima del chasis. Además, por encima
          de la carga nominal del módulo de movimiento el vehículo va más lento (hasta el {C.MASS_SPEED_FLOOR * 100} %
          de su velocidad, nunca menos).
        </li>
        <li>
          <strong>Energía</strong>: la generación tiene que cubrir el consumo pasivo de todos los módulos.
        </li>
        <li>
          <strong>Munición</strong>: el arma sólo admite las municiones de su lista; el editor te lo dice al elegir.
        </li>
      </ul>
      <h4>Daño y estados de los módulos</h4>
      <p>
        De cada impacto, el {C.CHASSIS_DAMAGE_SHARE * 100} % va al casco y el {C.MODULE_DAMAGE_SHARE * 100} % a los
        módulos. El blindaje del sector golpeado reduce el daño, pero nunca por debajo del {C.DMG_MIN_FRACTION * 100} %.
        Un módulo dañado rinde menos:
      </p>
      <table className="stack-table" data-testid="help-module-states">
        <caption>Estados de un módulo según su vida</caption>
        <thead>
          <tr>
            <th scope="col">Estado</th>
            <th scope="col">Rendimiento</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(C.MODULE_STATE_PERFORMANCE).map(([s, perf]) => (
            <tr key={s}>
              <td data-label="Estado">
                <code>{s}</code>
              </td>
              <td data-label="Rendimiento">{Math.round(perf * 100)} %</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Umbrales: <code>damaged</code> por debajo del {C.MODULE_STATE_THRESHOLDS.damaged * 100} % de vida,{" "}
        <code>critical</code> por debajo del {C.MODULE_STATE_THRESHOLDS.critical * 100} % (y además falla a ratos),{" "}
        <code>destroyed</code> a 0. <code>offline</code> es un módulo que tu bot ha apagado con «modules»; reactivarlo
        tarda {C.MODULE_REACTIVATION_TICKS} ticks.
      </p>
      <p>
        Fichas de cada pieza: <a href={helpHref("equipamiento", "chassis")}>chasis</a>,{" "}
        <a href={helpHref("referencia", "catalogo")}>catálogo completo</a>.
      </p>
    </div>
  );
}

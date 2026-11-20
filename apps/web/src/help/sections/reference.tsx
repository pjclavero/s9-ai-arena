/**
 * EQ3 · REFERENCIA: catálogo completo, protocolo arena/1 y versiones. Todo
 * generado desde las fuentes embebidas en build (help/sources.ts).
 */
import { CATALOG, CATALOG_VERSION, SCHEMAS, VERSIONS } from "../sources.js";
import { CATEGORY_NAME, humanize } from "../names.js";
import { SchemaFields, SourceText } from "../blocks.js";
import { sdkVersionMismatch } from "./bots.js";
import { helpHref } from "../tree.js";

const DEFS = (SCHEMAS.common as any).$defs ?? {};
const CAT_LEAF: Record<string, string> = {
  chassis: "chassis",
  movement: "movement",
  power: "power",
  sensor: "sensor",
  weapon: "weapon",
  ammo: "ammo",
  armor: "armor",
  radio: "radio",
  mine: "otros",
  utility: "otros",
};

export function CatalogReference() {
  return (
    <div data-testid="help-catalog-reference">
      <p>
        Catálogo <code>{CATALOG_VERSION}</code>: {CATALOG.length} definiciones (cada versión de un módulo es una
        definición distinta e inmutable; un loadout guarda la versión exacta).
      </p>
      <table className="stack-table" data-testid="help-catalog-table">
        <caption>Todos los módulos</caption>
        <thead>
          <tr>
            <th scope="col">Módulo</th>
            <th scope="col">Categoría</th>
            <th scope="col">Coste</th>
            <th scope="col">Masa</th>
          </tr>
        </thead>
        <tbody>
          {CATALOG.map((m) => (
            <tr key={`${m.id}@${m.version}`} data-testid={`help-catalog-row-${m.id}@${m.version}`}>
              <td data-label="Módulo">
                <a href={helpHref("equipamiento", CAT_LEAF[m.category] ?? "otros")}>{m.name}</a>{" "}
                <code>{`${m.id}@${m.version}`}</code>
              </td>
              <td data-label="Categoría">{humanize(CATEGORY_NAME, m.category)}</td>
              <td data-label="Coste">{m.costCredits} créditos</td>
              <td data-label="Masa">{m.massKg} kg</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const MESSAGES: { key: keyof typeof SCHEMAS; name: string; dir: string }[] = [
  { key: "hello", name: "HELLO", dir: "bot → motor" },
  { key: "welcome", name: "WELCOME", dir: "motor → bot" },
  { key: "observation", name: "OBSERVATION", dir: "motor → bot" },
  { key: "command", name: "COMMAND", dir: "bot → motor" },
  { key: "event", name: "EVENT", dir: "motor → bot" },
  { key: "shutdown", name: "SHUTDOWN", dir: "motor → bot" },
];

export function ProtocolReference() {
  return (
    <div data-testid="help-protocol-reference">
      <p>
        Protocolo <code>{VERSIONS.protocol}</code>. Todo mensaje viaja en un sobre (envelope); los SDK lo gestionan por
        ti. Reglas: el motor es autoritativo, la observación sólo trae lo percibido, un COMMAND por ciclo, un mensaje
        inválido se trata como ausente y los campos desconocidos se ignoran (por eso un bot antiguo sigue funcionando
        tras una versión menor).
      </p>
      <ul>
        {MESSAGES.map((m) => (
          <li key={m.key}>
            <strong>{m.name}</strong> ({m.dir}): <SourceText text={(SCHEMAS[m.key] as any).description} />
          </li>
        ))}
      </ul>
      <SchemaFields
        schema={SCHEMAS.envelope}
        defs={DEFS}
        caption="Sobre (envelope.schema.json)"
        testId="help-schema-envelope"
      />
      <SchemaFields schema={SCHEMAS.hello} defs={DEFS} caption="HELLO (hello.schema.json)" testId="help-schema-hello" />
      <SchemaFields
        schema={SCHEMAS.welcome}
        defs={DEFS}
        caption="WELCOME (welcome.schema.json)"
        testId="help-schema-welcome"
      />
      <SchemaFields
        schema={SCHEMAS.shutdown}
        defs={DEFS}
        caption="SHUTDOWN (shutdown.schema.json)"
        testId="help-schema-shutdown"
      />
      <p>
        OBSERVATION, COMMAND y EVENT: <a href={helpHref("bots", "observaciones")}>Observaciones</a>,{" "}
        <a href={helpHref("bots", "comandos")}>Comandos</a>, <a href={helpHref("bots", "eventos")}>Eventos</a>.
      </p>
    </div>
  );
}

export function VersionsReference() {
  const mismatch = sdkVersionMismatch();
  const rows: [string, string][] = [
    ["Motor de simulación", VERSIONS.engine],
    ["Física", VERSIONS.physics],
    ["Protocolo", VERSIONS.protocol],
    ["Catálogo de módulos", VERSIONS.catalog],
    ["SDK Python (arena_sdk)", VERSIONS.sdkPython],
    ["SDK JavaScript (@arena/sdk)", VERSIONS.sdkJs],
    ["SDK que instala la plataforma", VERSIONS.sdkPlatform],
  ];
  return (
    <div data-testid="help-versions">
      <table className="stack-table" data-testid="help-versions-table">
        <caption>Versiones que describe esta ayuda (las de esta versión de la web)</caption>
        <thead>
          <tr>
            <th scope="col">Pieza</th>
            <th scope="col">Versión</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td data-label="Pieza">{k}</td>
              <td data-label="Versión">
                <code>{v}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {mismatch ? (
        <p className="warn" role="alert">
          {mismatch}
        </p>
      ) : (
        <p data-testid="help-versions-consistent">Los SDK y la versión que instala la plataforma coinciden.</p>
      )}
      <p>
        Cada batalla guarda las versiones exactas con las que se jugó (las ves en su detalle y en el WELCOME que recibe
        tu bot, campo <code>versions</code>). El replay de una batalla conserva esas versiones.
      </p>
    </div>
  );
}

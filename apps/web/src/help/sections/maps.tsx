/**
 * EQ3 · Ayuda del EDITOR DE MAPAS. Las herramientas y sus textos salen de la paleta
 * real del editor (map-editor/objects.ts TOOLS); los campos, del esquema de mapas
 * (packages/map-schema/map.schema.json); los requisitos por modo, del registro de
 * modos del motor. Cómo llega cada objeto a la batalla está auditado en
 * apps/map-service/src/to-engine-map.ts.
 */
import { TOOLS } from "../../map-editor/objects.js";
import { SCHEMAS, MODES } from "../sources.js";
import { SchemaFields, Note } from "../blocks.js";
import { anyModeName } from "./rules.js";
import { helpHref } from "../tree.js";

const DEFS = ((SCHEMAS.map as any).$defs ?? {}) as Record<string, unknown>;
const LAYERS = (SCHEMAS.map as any).properties.layers;

function toolsOf(kind: string) {
  return TOOLS.filter((t) => t.kind === kind);
}

function Tools(props: { kind: string }) {
  const list = toolsOf(props.kind);
  return (
    <ul data-testid={`help-map-tools-${props.kind}`}>
      {list.map((t) => (
        <li key={t.tool}>
          <strong>{t.label}</strong>: {t.help}
        </li>
      ))}
    </ul>
  );
}

function LayerFields(props: { layer: string; caption: string }) {
  const node = LAYERS.properties[props.layer];
  const items = node?.items ?? node;
  // Las capas con forma heredan los campos de `shape` ($defs.shape) vía allOf.
  const merged = {
    ...items,
    properties: {
      ...((items?.allOf?.[0]?.$ref ? (DEFS as any).shape?.properties : undefined) ?? {}),
      ...(items?.properties ?? {}),
    },
    required: [...((DEFS as any).shape && items?.allOf ? ["shape"] : []), ...(items?.required ?? [])],
  };
  return <SchemaFields schema={merged} defs={DEFS} caption={props.caption} testId={`help-map-schema-${props.layer}`} />;
}

export function MapEditorHelp() {
  return (
    <div data-testid="help-map-editor">
      <p>
        «Mapas» → editor. Eliges una herramienta de la paleta y pulsas en el lienzo para colocar el objeto; luego lo
        mueves, lo redimensionas con sus tiradores o editas sus propiedades en el panel lateral. Los cambios se guardan
        como borrador; al publicar, el mapa queda inmutable (cualquier cambio crea una versión nueva).
      </p>
      <h4>Paleta</h4>
      <ul data-testid="help-map-palette">
        {TOOLS.map((t) => (
          <li key={t.tool}>
            <strong>{t.label}</strong>: {t.help}
          </li>
        ))}
      </ul>
      <p>
        Todo mapa tiene un perímetro en su borde: los vehículos no salen y los proyectiles chocan con él, aunque no
        dibujes muros. El giro de los objetos no se edita (la batalla y el visor no lo mostrarían).
      </p>
      <p>
        Modos que puede declarar un mapa:{" "}
        {((SCHEMAS.map as any).properties.meta.properties.supportedModes.items.enum as string[])
          .map(anyModeName)
          .join(", ")}
        .
      </p>
    </div>
  );
}

export function MapSpawns() {
  return (
    <div data-testid="help-map-spawns">
      <Tools kind="spawn" />
      <p>
        Cada punto tiene equipo, posición y orientación inicial (<code>heading</code>, en radianes). Si un bando tiene
        más vehículos que puntos, el motor coloca los demás alrededor de los del mapa, nunca más cerca del rival y lejos
        de muros y zonas de daño.
      </p>
      <LayerFields layer="spawns" caption="Campos de un punto de aparición (map.schema.json)" />
    </div>
  );
}

export function MapBases() {
  return (
    <div data-testid="help-map-bases">
      <Tools kind="base" />
      <p>
        Para Captura la bandera cada equipo necesita una base y una bandera. En la batalla una base cuenta como un
        círculo: si la dibujas rectangular, el del círculo inscrito (la dimensión menor manda).
      </p>
      <LayerFields layer="bases" caption="Campos de una base (map.schema.json)" />
    </div>
  );
}

export function MapFlags() {
  return (
    <div data-testid="help-map-flags">
      <Tools kind="flag" />
      <p>
        Una bandera es un punto con equipo. Se recoge acercándose a 2 m. Ver{" "}
        <a href={helpHref("modos", "capture_the_flag")}>Captura la bandera</a>.
      </p>
      <LayerFields layer="flags" caption="Campos de una bandera (map.schema.json)" />
    </div>
  );
}

export function MapZones() {
  const types = LAYERS.properties.zones.items.properties.zoneType.enum as string[];
  return (
    <div data-testid="help-map-zones">
      <Tools kind="zone" />
      <ul>
        <li>
          <strong>Zona de captura</strong>: la que puntúa en{" "}
          <a href={helpHref("modos", "zone_control")}>Control de zona</a>. Cuenta como un círculo (el inscrito, si no es
          circular). El motor no usa <code>captureTimeTicks</code> ni el equipo de la zona.
        </li>
        <li>
          <strong>Zona de daño</strong>: quita <code>damagePerSecond</code> de vida por segundo a quien está dentro.
        </li>
        <li>
          Tipos del esquema:{" "}
          {types.map((t) => (
            <code key={t}>{t} </code>
          ))}
          . Las de tipo <code>no_entry</code> y <code>cover</code> sólo cuentan para validar el mapa: no llegan a la
          batalla.
        </li>
      </ul>
      <LayerFields layer="zones" caption="Campos de una zona (map.schema.json)" />
    </div>
  );
}

export function MapWalls() {
  return (
    <div data-testid="help-map-walls">
      <Tools kind="wall" />
      <LayerFields layer="walls" caption="Campos de un muro (forma, map.schema.json)" />
    </div>
  );
}

export function MapCrates() {
  return (
    <div data-testid="help-map-crates">
      <Tools kind="destructible" />
      <p>
        Una caja es un obstáculo destructible: su vida sale de su material (100 si el material no la declara). Un mapa
        no debe depender de romper cajas para llegar a los objetivos, salvo que lo declare.
      </p>
      <LayerFields layer="destructibles" caption="Campos de una caja (map.schema.json)" />
    </div>
  );
}

export function MapValidation() {
  return (
    <div data-testid="help-map-validation">
      <p>
        El editor revisa el mapa mientras dibujas (errores en rojo, avisos en amarillo) y la plataforma lo valida entero
        al publicar. Lo que más se comprueba:
      </p>
      <ul>
        <li>tamaño del mapa válido y al menos un modo marcado;</li>
        <li>objetos con tamaño válido y dentro del mapa;</li>
        <li>puntos de aparición dentro del mapa y fuera de muros y cajas (avisa si están en una zona de daño);</li>
        <li>banderas y bases con equipo válido, fuera de muros, y cada equipo con su punto de aparición;</li>
        <li>zonas de captura y de daño que se solapan (capturar obligaría a recibir daño);</li>
        <li>lo que exige cada modo declarado (abajo).</li>
      </ul>
      <table className="stack-table" data-testid="help-map-mode-reqs">
        <caption>Lo que necesita el mapa para cada modo (registro de modos del motor)</caption>
        <thead>
          <tr>
            <th scope="col">Modo</th>
            <th scope="col">Necesita</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(MODES).map(([id, m]) => (
            <tr key={id}>
              <td data-label="Modo">{anyModeName(id)}</td>
              <td data-label="Necesita">
                {[
                  m.requires.flagsAndBases ? "una bandera y una base por equipo" : null,
                  m.requires.captureZones ? `${m.requires.captureZones} zona(s) de captura como mínimo` : null,
                ]
                  .filter(Boolean)
                  .join(" y ") || "puntos de aparición"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Note>
        El editor además pide al menos 2 puntos de aparición para Deathmatch y de los dos equipos para los modos por
        equipos.
      </Note>
    </div>
  );
}

/**
 * EQ3 · Ayuda de BOTS y SDK. Las versiones salen de los propios SDK, los campos de
 * los mensajes de packages/protocol/schemas/*.json y los ejemplos son los ficheros
 * testeados del repo (bot tutorial, plantillas del editor, example-bots).
 */
import { useState } from "react";
import { CodeBlock, Note, SchemaFields, SourceText } from "../blocks.js";
import { EXAMPLES, RULE_CONSTANTS as C, SCHEMAS, VERSIONS } from "../sources.js";
import { HOOK_HELP } from "../../bot-templates.js";
import { GLOSSARY } from "../content.js";
import { helpHref } from "../tree.js";
import { InfoTip } from "../InfoTip.js";
import { modulesOf } from "./equipment.js";
import { SENSOR_TYPE_NAME, humanize } from "../names.js";

const DEFS = (SCHEMAS.common as any).$defs ?? {};

/** Aviso si los tres orígenes de versión del SDK no coinciden (no se muestra doc de otra versión sin decirlo). */
export function sdkVersionMismatch(): string | null {
  const v = new Set([VERSIONS.sdkPython, VERSIONS.sdkPythonPyproject, VERSIONS.sdkJs, VERSIONS.sdkPlatform]);
  if (v.size === 1) return null;
  return (
    `Las versiones no coinciden: Python ${VERSIONS.sdkPython} (pyproject ${VERSIONS.sdkPythonPyproject}), ` +
    `JavaScript ${VERSIONS.sdkJs} y la que instala la plataforma ${VERSIONS.sdkPlatform}. ` +
    "Esta ayuda describe la que viaja con esta versión de la web; comprueba la de tu bot."
  );
}

function VersionBanner(props: { sdk: string; version: string }) {
  const mismatch = sdkVersionMismatch();
  return (
    <div className="card" data-testid="help-sdk-version">
      <p>
        Documentación del SDK de {props.sdk} <strong>{props.version}</strong>, protocolo{" "}
        <code>{VERSIONS.protocol}</code>. Es la versión que la plataforma instala al construir tu bot (
        <code>{VERSIONS.sdkPlatform}</code>): los ejemplos de esta página son compatibles con ella.
      </p>
      {mismatch && (
        <p className="warn" role="alert" data-testid="help-sdk-mismatch">
          {mismatch}
        </p>
      )}
    </div>
  );
}

const glossary = (id: string) => GLOSSARY.find((g) => g.id === id)?.definition ?? "";

export function BotConcepts() {
  const decisionMs = Math.round(1000 / C.DECISION_HZ);
  return (
    <div data-testid="help-bots-concepts">
      <dl>
        <dt>Bot</dt>
        <dd>{glossary("bot")}</dd>
        <dt>Versión</dt>
        <dd>{glossary("version")}</dd>
        <dt>Estados de una versión</dt>
        <dd>{glossary("estados")}</dd>
        <dt>Runtime</dt>
        <dd>
          {glossary("runtime")}
          <ul>
            <li>Python: {HOOK_HELP.python}</li>
            <li>JavaScript: {HOOK_HELP.node}</li>
          </ul>
        </dd>
        <dt>Build y validación</dt>
        <dd>{glossary("build")}</dd>
      </dl>
      <h4>El ciclo de una batalla</h4>
      <p>
        El motor simula a {C.TICK_HZ} ticks por segundo y le pide una decisión a tu bot cada {C.DECISION_EVERY_N_TICKS}{" "}
        ticks ({C.DECISION_HZ} veces por segundo, una cada {decisionMs} ms). Tu bot tiene {C.DECISION_DEADLINE_MS} ms
        para contestar.{" "}
        <InfoTip topic="Turno sin respuesta" testId="tip-timeout">
          Si no llega un COMMAND válido a tiempo se aplica la acción segura (mantener movimiento y torreta, no disparar)
          y se cuenta un turno perdido. Con {C.MAX_CONSECUTIVE_TIMEOUTS} seguidos (2 s) el bot queda descalificado.
        </InfoTip>
      </p>
      <ol>
        <li>
          <strong>HELLO</strong> (bot → motor): tu SDK se presenta. Lo hace el SDK por ti.
        </li>
        <li>
          <strong>WELCOME</strong> (motor → bot): reglas, tiempos, TU vehículo (ranuras y módulos) y el mapa.
        </li>
        <li>
          <strong>OBSERVATION</strong> → <strong>COMMAND</strong>, en bucle: lo que perciben tus sensores y tu orden
          para el siguiente ciclo.
        </li>
        <li>
          <strong>EVENT</strong> en cualquier momento (impactos, capturas, acciones rechazadas) y{" "}
          <strong>SHUTDOWN</strong> al final.
        </li>
      </ol>
      <p>
        El motor es la autoridad: un COMMAND es una intención y se puede rechazar (sin energía, sin munición, en
        recarga…). Ver <a href={helpHref("bots", "comandos")}>Comandos</a> y{" "}
        <a href={helpHref("referencia", "protocolo")}>Protocolo</a>.
      </p>
    </div>
  );
}

const PY_LIFECYCLE = `from arena_sdk import ArenaBot


class MiBot(ArenaBot):
    def on_welcome(self, welcome):
        # Una vez, al empezar: welcome["vehicle"]["modules"] es TU loadout,
        # welcome["timing"] y welcome["rules"] los valores REALES de esta batalla.
        pass

    def on_observation(self, observation):
        # OBLIGATORIO. Cada ciclo de decisión. Devuelve la orden; {} = sin cambios.
        return {}

    def on_event(self, event):
        # Impactos, capturas, rejected_action... sólo lo que tu bot pudo percibir.
        pass

    def on_shutdown(self, shutdown):
        # Último mensaje: shutdown["result"] si la batalla terminó.
        pass
`;

const JS_LIFECYCLE = `import { ArenaBot } from "@arena/sdk";

export default class MiBot extends ArenaBot {
  onWelcome(welcome) {
    // Una vez, al empezar: welcome.vehicle.modules es TU loadout,
    // welcome.timing y welcome.rules los valores REALES de esta batalla.
  }

  onObservation(observation) {
    // OBLIGATORIO. Cada ciclo de decisión. Devuelve la orden; {} = sin cambios.
    return {};
  }

  onEvent(event) {
    // Impactos, capturas, rejected_action... sólo lo que tu bot pudo percibir.
  }

  onShutdown(shutdown) {
    // Último mensaje: shutdown.result si la batalla terminó.
  }
}
`;

export function SdkPython() {
  const tutorial = EXAMPLES.find((e) => e.id === "py-tutorial")!;
  return (
    <div data-testid="help-sdk-python">
      <VersionBanner sdk="Python" version={VERSIONS.sdkPython} />
      <p>{HOOK_HELP.python}</p>
      <p>
        Al pegar un fichero en la web, la plataforma lo coloca en <code>src/bot.py</code> y añade{" "}
        <code>requirements.txt</code> con <code>arena-sdk=={VERSIONS.sdkPlatform}</code>. No hace falta instalar nada
        para jugar en la plataforma.
      </p>
      <h4>Ciclo de vida</h4>
      <CodeBlock code={PY_LIFECYCLE} lang="python" label="Esqueleto de un bot en Python" testId="help-code-py-life" />
      <h4>Funciones de geometría</h4>
      <ul>
        <li>
          <code>distance(a, b)</code>: metros entre dos puntos <code>{"{x, y}"}</code>.
        </li>
        <li>
          <code>angle_to(origen, destino)</code>: ángulo absoluto en radianes (0 = eje x, antihorario positivo).
        </li>
        <li>
          <code>angle_diff(desde, hasta)</code>: cuánto girar, en [-π, π].
        </li>
      </ul>
      <h4>Tu primer bot</h4>
      <CodeBlock code={tutorial.code} lang="python" label={tutorial.title} testId="help-code-py-tutorial" />
      <Note>{tutorial.origin}</Note>
      <h4>Probarlo en tu ordenador (opcional)</h4>
      <p>
        Con el repositorio del proyecto: <code>pip install -e "sdks/python[dev]"</code> y{" "}
        <code>arena-sim mi_bot.py --archetype gunner --opponent idle --ticks 1800</code>. El simulador usa el motor real
        (necesita Node.js 22). Para jugar en la plataforma no hace falta.
      </p>
      <p>
        Más: <a href={helpHref("bots", "observaciones")}>Observaciones</a>,{" "}
        <a href={helpHref("bots", "comandos")}>Comandos</a>, <a href={helpHref("bots", "ejemplos")}>Ejemplos</a>.
      </p>
    </div>
  );
}

export function SdkJavascript() {
  const tutorial = EXAMPLES.find((e) => e.id === "js-tutorial")!;
  return (
    <div data-testid="help-sdk-javascript">
      <VersionBanner sdk="JavaScript" version={VERSIONS.sdkJs} />
      <p>{HOOK_HELP.node}</p>
      <p>
        Al pegar un fichero en la web, la plataforma lo coloca en <code>src/bot.js</code> dentro de un paquete con{" "}
        <code>"type": "module"</code> y <code>@arena/sdk {VERSIONS.sdkPlatform}</code>. Sube JavaScript, no TypeScript:
        los tipos del SDK son para tu editor.
      </p>
      <h4>Ciclo de vida</h4>
      <CodeBlock
        code={JS_LIFECYCLE}
        lang="javascript"
        label="Esqueleto de un bot en JavaScript"
        testId="help-code-js-life"
      />
      <h4>Funciones de geometría</h4>
      <ul>
        <li>
          <code>distance(a, b)</code>, <code>angleTo(origen, destino)</code> y <code>angleDiff(desde, hasta)</code>: las
          mismas que en Python.
        </li>
      </ul>
      <h4>Tu primer bot</h4>
      <CodeBlock code={tutorial.code} lang="javascript" label={tutorial.title} testId="help-code-js-tutorial" />
      <Note>{tutorial.origin}</Note>
      <h4>Probarlo en tu ordenador (opcional)</h4>
      <p>
        Con el repositorio del proyecto: <code>npm install</code> y{" "}
        <code>npx arena-sim mi_bot.js --archetype gunner --opponent idle --ticks 1800</code>.
      </p>
    </div>
  );
}

export function Observations() {
  return (
    <div data-testid="help-observations">
      <p>
        <SourceText text={(SCHEMAS.observation as any).description} />
      </p>
      <SchemaFields
        schema={SCHEMAS.observation}
        defs={DEFS}
        caption="Campos de OBSERVATION (generado desde observation.schema.json)"
        testId="help-schema-observation"
      />
    </div>
  );
}

export function Commands() {
  const reason = (SCHEMAS.event as any).properties.reason.description as string;
  return (
    <div data-testid="help-commands">
      <p>
        <SourceText text={(SCHEMAS.command as any).description} />
      </p>
      <p>
        El SDK rellena <code>forTick</code> por ti: tu método sólo devuelve el resto.
      </p>
      <SchemaFields
        schema={SCHEMAS.command}
        defs={DEFS}
        caption="Campos de COMMAND (generado desde command.schema.json)"
        testId="help-schema-command"
      />
      <h4>Cuando una acción se rechaza</h4>
      <p>
        Recibes un EVENT <code>rejected_action</code> con un motivo. <SourceText text={reason} />
      </p>
    </div>
  );
}

export function Events() {
  return (
    <div data-testid="help-events">
      <p>
        <SourceText text={(SCHEMAS.event as any).description} />
      </p>
      <SchemaFields
        schema={SCHEMAS.event}
        defs={DEFS}
        caption="Campos de EVENT (generado desde event.schema.json)"
        testId="help-schema-event"
      />
    </div>
  );
}

export function Sensors() {
  const sensors = modulesOf(["sensor"]);
  return (
    <div data-testid="help-sensors">
      <p>
        Tu bot sólo recibe lo que perciben sus sensores <strong>montados y operativos</strong> (niebla de guerra): no
        hay ningún campo «oculto pero presente». Cada sensor aparece en <code>observation.sensors</code> con la ranura
        donde está montado.
      </p>
      <table className="stack-table" data-testid="help-sensor-modules">
        <caption>Sensores del catálogo</caption>
        <thead>
          <tr>
            <th scope="col">Módulo</th>
            <th scope="col">Tipo</th>
            <th scope="col">Alcance</th>
          </tr>
        </thead>
        <tbody>
          {sensors.map((m) => (
            <tr key={`${m.id}@${m.version}`}>
              <td data-label="Módulo">
                {m.name} <code>{`${m.id}@${m.version}`}</code>
              </td>
              <td data-label="Tipo">{humanize(SENSOR_TYPE_NAME, m.sensorType ?? "")}</td>
              <td data-label="Alcance">{m.rangeM !== undefined ? `${m.rangeM} m` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <SchemaFields
        schema={SCHEMAS.observation}
        defs={DEFS}
        rootPath="sensors"
        caption="Lo que llega en observation.sensors (generado desde observation.schema.json)"
        testId="help-schema-sensors"
      />
      <p>
        Estadísticas completas: <a href={helpHref("equipamiento", "sensor")}>Equipamiento → Sensores</a>.
      </p>
    </div>
  );
}

export function Radio() {
  return (
    <div data-testid="help-radio">
      <p>
        Con un módulo de radio montado, tu bot puede enviar hasta {C.RADIO_MAX_MESSAGES_PER_SECOND} mensajes por segundo
        de {C.RADIO_MAX_MESSAGE_BYTES} bytes como máximo (en base64 en el campo <code>data</code>). Se entregan al
        equipo con {C.RADIO_DELIVERY_DELAY_DECISIONS} ciclo de decisión de retraso y llegan en{" "}
        <code>observation.radio</code>. Pasarse de tamaño o frecuencia descarta el mensaje con un evento{" "}
        <code>radio_dropped</code>.
      </p>
      <Note>
        Hoy la radio no tiene alcance: el valor «Alcance» del módulo de radio no lo usa el motor (ver «Efecto real» en{" "}
        <a href={helpHref("equipamiento", "radio")}>Equipamiento → Radio</a>).
      </Note>
      <SchemaFields
        schema={SCHEMAS.command}
        defs={DEFS}
        rootPath="radio"
        caption="Enviar: COMMAND.radio"
        testId="help-schema-radio-send"
      />
      <SchemaFields
        schema={SCHEMAS.observation}
        defs={DEFS}
        rootPath="radio"
        caption="Recibir: OBSERVATION.radio"
        testId="help-schema-radio-recv"
      />
    </div>
  );
}

export function Examples() {
  const [wrap, setWrap] = useState(false);
  return (
    <div data-testid="help-examples">
      <p>
        <label data-testid="help-wrap-label">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} data-testid="help-wrap" />{" "}
          Ajustar líneas largas{" "}
          <InfoTip topic="Ajustar líneas largas" testId="tip-wrap">
            Parte las líneas largas de los ejemplos para leerlas sin desplazarte. No cambia el código que copias.
          </InfoTip>
        </label>
      </p>
      <p>
        Todos estos bots son ficheros del proyecto que se ejecutan en sus tests con el motor real y la versión{" "}
        {VERSIONS.sdkPlatform} del SDK. Cópialos tal cual en «Subir código (pegado)» eligiendo su runtime.
      </p>
      {EXAMPLES.map((e) => (
        <section key={e.id} aria-labelledby={`ex-${e.id}`}>
          <h4 id={`ex-${e.id}`}>{e.title}</h4>
          <Note>{e.origin}</Note>
          <CodeBlock code={e.code} lang={e.lang} label={e.title} testId={`help-example-${e.id}`} wrap={wrap} />
        </section>
      ))}
      <Note>
        Los ejemplos de example-bots usan un loadout de referencia (arquetipo); en la plataforma juega el loadout de tu
        versión, así que revisa las ranuras que usan (<code>fire</code>, <code>deployMine</code>).
      </Note>
    </div>
  );
}

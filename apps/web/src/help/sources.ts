/**
 * EQ3 · FUENTES DE VERDAD del Centro de Ayuda, embebidas EN BUILD.
 *
 * El Centro de Ayuda viaja con la web: no consulta GitHub ni Internet. Todo lo que
 * enseña sobre el juego sale de aquí, que importa (Vite lo resuelve al compilar)
 * los MISMOS ficheros que usan el motor, la API, los SDK y los tests:
 *
 *   packages/module-catalog/data/*.json      → ayuda de equipamiento
 *   packages/module-catalog/effect-status.ts → qué propiedades cambian la batalla
 *   packages/game-rules (RULESETS, constantes) → reglas, rulesets y tiempos
 *   apps/arena-engine/src/sim/modes.ts        → registro de modos (requisitos, desempate)
 *   packages/map-schema/map.schema.json       → ayuda del editor de mapas
 *   apps/web/src/map-editor/objects.ts (TOOLS) → paleta real del editor
 *   packages/protocol/schemas/*.json          → referencia de mensajes del SDK
 *   sdks/{python,javascript} (versión + bots tutoriales testeados) → ayuda del SDK
 *
 * Si una de esas fuentes cambia, la ayuda cambia con el siguiente build; los tests
 * (apps/web/tests/eq3-help-*.test.tsx) comparan lo que se pinta con la fuente.
 */
import type { ModuleDefinition } from "../../../../packages/module-catalog/types.js";
import { RULESETS, type Ruleset } from "../../../../packages/game-rules/index.js";
import * as RULE_CONSTANTS from "../../../../packages/game-rules/constants.js";
import { MODE_REGISTRY, type ModeMetadata } from "../../../arena-engine/src/sim/modes.js";
import engineDeps from "../../../arena-engine/src/engine-deps.json";
import mapSchema from "../../../../packages/map-schema/map.schema.json";
import helloSchema from "../../../../packages/protocol/schemas/hello.schema.json";
import welcomeSchema from "../../../../packages/protocol/schemas/welcome.schema.json";
import observationSchema from "../../../../packages/protocol/schemas/observation.schema.json";
import commandSchema from "../../../../packages/protocol/schemas/command.schema.json";
import eventSchema from "../../../../packages/protocol/schemas/event.schema.json";
import shutdownSchema from "../../../../packages/protocol/schemas/shutdown.schema.json";
import envelopeSchema from "../../../../packages/protocol/schemas/envelope.schema.json";
import commonSchema from "../../../../packages/protocol/schemas/common.schema.json";
import jsSdkPackage from "../../../../sdks/javascript/package.json";
import pyInitRaw from "../../../../sdks/python/arena_sdk/__init__.py?raw";
import pyProjectRaw from "../../../../sdks/python/pyproject.toml?raw";
// Versión del SDK que lleva DE VERDAD la imagen de runtime de bots (wheel fijado por hash).
// El test eq3-help-sources exige que coincida con SDK_VERSION de la API (lo que fija
// requirements.txt al empaquetar el código pegado) y con @arena/sdk.
import sdkWheelLockRaw from "../../../../runtimes/python/sdk-wheel.lock?raw";
import pyTutorialRaw from "../../../../sdks/python/tests/_tutorial_bot.py?raw";
import jsTutorialRaw from "../../../../sdks/javascript/tests/tutorial-bot.js?raw";
import exGunnerJs from "../../../../example-bots/javascript/gunner.js?raw";
import exMinerJs from "../../../../example-bots/javascript/miner.js?raw";
import exExplorerPy from "../../../../example-bots/python/explorer.py?raw";
import exDefenderPy from "../../../../example-bots/python/defender.py?raw";
import { JAVASCRIPT_TEMPLATE, PYTHON_TEMPLATE } from "../bot-templates.js";

export { RULE_CONSTANTS };

// ------------------------------------------------------------------ catálogo
const catalogFiles = import.meta.glob<ModuleDefinition>("../../../../packages/module-catalog/data/*.json", {
  eager: true,
  import: "default",
});

/** Catálogo completo (todas las versiones), en el orden estable de loadCatalog(). */
export const CATALOG: ModuleDefinition[] = Object.values(catalogFiles).sort((a, b) =>
  `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`),
);
/**
 * Temporada de catálogo que siembra la plataforma: copia literal de CATALOG_VERSION
 * (packages/module-catalog/loadCatalog.ts, que usa node:fs y no entra en el
 * navegador). El test eq3-help-sources compara ambas.
 */
export const CATALOG_VERSION = "mvp@1";

// --------------------------------------------------------- reglas y modos
export const ENGINE_RULESETS: Record<string, Ruleset> = RULESETS;
export const MODES: Record<string, ModeMetadata> = MODE_REGISTRY;

/**
 * Modos que la PLATAFORMA acepta al crear batallas (POST /battles y GET /rulesets).
 * Copia literal de PLATFORM_MODES (apps/api/src/routes/catalog.ts), que no se puede
 * importar en el navegador (arrastra Express); el test eq3-help-sources lo compara
 * con el original para que no diverjan.
 */
export const PLATFORM_MODES = ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"] as const;

// ------------------------------------------------------------- versiones
function grab(raw: string, re: RegExp, what: string): string {
  const m = raw.match(re);
  if (!m) throw new Error(`Centro de Ayuda: no encuentro ${what} en su fuente`);
  return m[1];
}

export const VERSIONS = {
  engine: engineDeps.engine.version as string,
  physics: `${engineDeps.physics.package} ${engineDeps.physics.version}`,
  protocol: engineDeps.protocol as string,
  sdkPython: grab(pyInitRaw, /__version__\s*=\s*"([^"]+)"/, "__version__ del SDK de Python"),
  sdkPythonPyproject: grab(pyProjectRaw, /^version\s*=\s*"([^"]+)"/m, "version de pyproject.toml"),
  sdkJs: jsSdkPackage.version as string,
  /** Versión del SDK que la PLATAFORMA instala al empaquetar el código pegado en la web. */
  sdkPlatform: grab(
    sdkWheelLockRaw,
    /^arena_sdk-([^-\s]+)-py3-none-any\.whl/m,
    "wheel del SDK en runtimes/python/sdk-wheel.lock",
  ),
  catalog: CATALOG_VERSION,
} as const;

// -------------------------------------------------------------- esquemas
export const SCHEMAS = {
  hello: helloSchema,
  welcome: welcomeSchema,
  observation: observationSchema,
  command: commandSchema,
  event: eventSchema,
  shutdown: shutdownSchema,
  envelope: envelopeSchema,
  common: commonSchema,
  map: mapSchema,
} as const;

// -------------------------------------------------------------- ejemplos
export interface CodeExample {
  id: string;
  title: string;
  lang: "python" | "javascript";
  /** De dónde sale y qué lo prueba (para que nadie lo tome por un ejemplo sin probar). */
  origin: string;
  code: string;
}

export const EXAMPLES: CodeExample[] = [
  {
    id: "py-tutorial",
    title: "Bot tutorial (Python)",
    lang: "python",
    origin:
      "sdks/python/tests/_tutorial_bot.py — test_contract.py lo enfrenta a un bot inmóvil con el motor real en cada pytest.",
    code: pyTutorialRaw,
  },
  {
    id: "js-tutorial",
    title: "Bot tutorial (JavaScript)",
    lang: "javascript",
    origin:
      "sdks/javascript/tests/tutorial-bot.js — contract.test.ts lo juega contra el motor real y readme-js.test.ts pasa el análisis estático del build.",
    code: jsTutorialRaw,
  },
  {
    id: "py-template",
    title: "Plantilla del editor (Python)",
    lang: "python",
    origin: "La plantilla con la que empieza el editor de código de la web (apps/web/src/bot-templates.ts).",
    code: PYTHON_TEMPLATE,
  },
  {
    id: "js-template",
    title: "Plantilla del editor (JavaScript)",
    lang: "javascript",
    origin: "La plantilla con la que empieza el editor de código de la web (apps/web/src/bot-templates.ts).",
    code: JAVASCRIPT_TEMPLATE,
  },
  {
    id: "py-explorer",
    title: "Explorador con lidar y radio (Python)",
    lang: "python",
    origin: "example-bots/python/explorer.py — lo ejecuta example-bots/python/test_bots.py.",
    code: exExplorerPy,
  },
  {
    id: "py-defender",
    title: "Defensor (Python)",
    lang: "python",
    origin: "example-bots/python/defender.py — lo ejecuta example-bots/python/test_bots.py.",
    code: exDefenderPy,
  },
  {
    id: "js-gunner",
    title: "Artillero (JavaScript)",
    lang: "javascript",
    origin: "example-bots/javascript/gunner.js — lo ejecuta example-bots/javascript/gunner.test.ts.",
    code: exGunnerJs,
  },
  {
    id: "js-miner",
    title: "Minador (JavaScript)",
    lang: "javascript",
    origin: "example-bots/javascript/miner.js — lo ejecuta example-bots/javascript/miner.test.ts.",
    code: exMinerJs,
  },
];

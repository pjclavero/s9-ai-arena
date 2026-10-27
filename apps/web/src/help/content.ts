/**
 * UX-A · Contenido de la guía integrada (landing, #/help y checklist de
 * primeros pasos). Vive en UN sitio para que la landing, la ayuda y la home
 * autenticada cuenten el MISMO recorrido con las MISMAS palabras.
 *
 * Reglas del contenido:
 *  - los nombres de botón y de pantalla son los REALES de la web (si cambia un
 *    botón, cambia aquí);
 *  - nada de topología ni de detalles internos del sandbox: es un repo público;
 *  - los términos técnicos que la web enseña tal cual (`draft`, `validated`,
 *    runtime, loadout…) se explican en el glosario en vez de esconderlos.
 */

/** Repositorio público: la documentación de usuario y los SDK viven aquí. */
export const REPO_URL = "https://github.com/pjclavero/s9-ai-arena";
const BLOB = `${REPO_URL}/blob/main`;

export const DOC_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "Guía de usuario (índice)", href: `${BLOB}/docs/user/index.md` },
  { label: "Bots: código, versiones y validación", href: `${BLOB}/docs/user/bots.md` },
  { label: "Equipamiento (loadout): chasis y módulos", href: `${BLOB}/docs/user/equipment.md` },
  { label: "Modos de juego y rulesets", href: `${BLOB}/docs/user/game-modes.md` },
  { label: "SDK de Python", href: `${BLOB}/sdks/python/README.md` },
  { label: "SDK de JavaScript", href: `${BLOB}/sdks/javascript/README.md` },
  { label: "Bots de ejemplo", href: `${REPO_URL}/tree/main/example-bots` },
];

/** Qué es S9, en dos frases, para quien no sabe nada. */
export const WHAT_IS_S9 =
  "S9 AI Arena es una arena de programación: escribes el código de un bot (en Python o JavaScript) que " +
  "conduce un vehículo en un mapa 2D, eliges su equipamiento y lo enfrentas a otros bots en batallas y torneos.";
export const HOW_IT_PLAYS =
  "Durante la batalla tu código recibe, varias veces por segundo, lo que perciben los sensores del vehículo y " +
  "responde con órdenes: moverse, girar, apuntar, disparar. Tú no controlas nada en directo: gana el mejor programa.";

export interface JourneyStep {
  /** Clave estable (la usa la checklist de primeros pasos). */
  id: string;
  title: string;
  /** Qué hacer, con los nombres reales de pantalla y botón. */
  how: string;
  /** Pantalla donde se hace. */
  href: string;
  linkLabel: string;
}

/**
 * El recorrido de un usuario nuevo, de la cuenta a la primera batalla. El orden
 * es el del ciclo real: una batalla necesita DOS bots con versión publicada, y
 * una versión sólo se publica si ha superado la validación.
 */
export const JOURNEY: ReadonlyArray<JourneyStep> = [
  {
    id: "account",
    title: "Crea tu cuenta",
    how: "Email, contraseña de al menos 12 caracteres y un nombre visible (el que verán los demás). Entras directamente.",
    href: "#/",
    linkLabel: "Ir al registro",
  },
  {
    id: "bot",
    title: "Crea tu primer bot",
    how: "En «Mis bots», escribe un nombre y pulsa «Crear bot». Un bot es la ficha; el código y el equipamiento vienen después.",
    href: "#/bots",
    linkLabel: "Ir a Mis bots",
  },
  {
    id: "loadout",
    title: "Configura su equipamiento (loadout)",
    how: "Selecciona el bot y, en el editor de loadout, elige un chasis, llena sus ranuras con módulos sin pasarte del presupuesto de créditos y pulsa «Guardar revisión».",
    href: "#/bots",
    linkLabel: "Abrir el editor de loadout",
  },
  {
    id: "code",
    title: "Programa el bot",
    how: "En «Subir código (pegado)» elige el runtime (Python o Node) y pega tu código; pulsa «Subir como versión nueva». Se crea una versión en estado draft.",
    href: "#/bots",
    linkLabel: "Subir código",
  },
  {
    id: "validated",
    title: "Valida la versión",
    how: "Pulsa «Enviar a validación vN». La plataforma construye tu código y lo prueba en una partida de humo. Si queda rejected, el motivo te dice qué corregir; sube una versión nueva.",
    href: "#/bots",
    linkLabel: "Ver mis versiones",
  },
  {
    id: "published",
    title: "Publica la versión",
    how: "Cuando la versión esté validated, pulsa «Publicar vN». Sólo las versiones publicadas pueden combatir.",
    href: "#/bots",
    linkLabel: "Publicar",
  },
  {
    id: "secondBot",
    title: "Crea y publica un segundo bot",
    how: "Una batalla necesita al menos dos bots con versión publicada. Repite los pasos con otro bot (puede ser una variante del primero).",
    href: "#/bots",
    linkLabel: "Crear otro bot",
  },
  {
    id: "team",
    title: "Crea un equipo (opcional para practicar)",
    how: "En «Equipos», pulsa «Crear equipo» y añade tus bots. Un equipo agrupa personas y bots; no es lo mismo que el bando de una batalla.",
    href: "#/teams",
    linkLabel: "Ir a Equipos",
  },
  {
    id: "battle",
    title: "Lanza tu primera batalla",
    how: "En «Batallas» → «+ Nueva batalla de práctica», elige modo, ruleset, mapa y un bot para cada bando, y pulsa «Crear batalla». Después puedes verla en directo o en replay.",
    href: "#/battles/new",
    linkLabel: "Nueva batalla de práctica",
  },
];

export interface GlossaryEntry {
  term: string;
  /** id de ancla dentro de #/help (sin espacios). */
  id: string;
  definition: string;
}

export const GLOSSARY: ReadonlyArray<GlossaryEntry> = [
  {
    term: "Bot",
    id: "bot",
    definition:
      "La ficha de tu jugador: un nombre con sus versiones de código y sus revisiones de loadout. Un bot no combate por sí mismo; combate una de sus versiones publicadas.",
  },
  {
    term: "Versión (de bot)",
    id: "version",
    definition:
      "Cada subida de código crea una versión nueva (v1, v2…), ligada a una revisión de loadout. Las versiones no se editan: para cambiar algo se sube otra.",
  },
  {
    term: "Estados de una versión",
    id: "estados",
    definition:
      "draft (subida, sin enviar) → validating (en validación) → validated (aprobada) o rejected (rechazada, con motivo) → published (puede combatir). " +
      "Una versión publicada antigua sigue pudiendo combatir aunque la última esté rechazada.",
  },
  {
    term: "Runtime",
    id: "runtime",
    definition:
      "El lenguaje y entorno en que se ejecuta tu código: python (Python 3) o node (JavaScript). Se elige al subir cada versión; el código debe estar escrito en ese lenguaje.",
  },
  {
    term: "Loadout",
    id: "loadout",
    definition:
      "El equipamiento del vehículo: un chasis más los módulos que pones en sus ranuras. Cada módulo cuesta créditos y consume energía; el total no puede pasar del presupuesto. Cada vez que lo guardas se crea una revisión nueva.",
  },
  {
    term: "Chasis y módulos",
    id: "chasis",
    definition:
      "El chasis es la base del vehículo y decide cuántas ranuras hay y de qué tipo. Los módulos (movilidad, energía, sensores, arma, blindaje…) llenan esas ranuras.",
  },
  {
    term: "Build y validación",
    id: "build",
    definition:
      "Al enviar una versión a validación, la plataforma construye tu código (build) y lo ejecuta en una partida de humo contra un rival de prueba. Si todo va bien la versión queda validated; si no, rejected con el fichero y el motivo.",
  },
  {
    term: "Artifact",
    id: "artifact",
    definition:
      "El paquete resultante del build de una versión, identificado por un hash. Es exactamente lo que se ejecuta en las batallas, de modo que lo validado y lo que combate son lo mismo.",
  },
  {
    term: "Modo",
    id: "modo",
    definition:
      "Las reglas de victoria de una batalla: deathmatch (todos contra todos), team_deathmatch (por bandos), capture_the_flag (capturar la bandera) y zone_control (controlar zonas).",
  },
  {
    term: "Ruleset",
    id: "ruleset",
    definition:
      "La configuración concreta de un modo: duración, presupuesto de créditos, puntuación… Al crear una batalla eliges un modo y uno de sus rulesets.",
  },
  {
    term: "Equipo vs bando",
    id: "equipo",
    definition:
      "Un equipo (pantalla «Equipos») es un grupo permanente de personas y bots. Un bando (rojo, azul…) es el lado que ocupa un bot en UNA batalla concreta. Para practicar no necesitas equipo.",
  },
  {
    term: "Batalla de práctica, torneo y replay",
    id: "batalla",
    definition:
      "Una batalla de práctica no cuenta para el ranking y la lanzas tú. Un torneo enfrenta a muchos bots en rondas. El replay es la grabación de una batalla terminada, para volver a verla.",
  },
];

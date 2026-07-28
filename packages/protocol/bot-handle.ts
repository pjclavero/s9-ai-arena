/**
 * Identificador de bot EN EL CABLE (issue #92).
 *
 * El protocolo publicado exige, en `hello.schema.json`:
 *
 *     "botId": { "pattern": "^bot_[0-9a-zA-Z]{1,24}$" }
 *
 * pero el identificador que maneja el resto del sistema (`participants.bot_id`)
 * es un uuid: 36 caracteres y con guiones. Un uuid NO casa con ese patrón, así
 * que el HELLO del bot fallaba la validación del envelope y se DESCARTABA en
 * silencio (regla 4 del protocolo: forma inválida → se ignora). El handshake
 * expiraba y la batalla no llegaba a arrancar nunca. Efecto real: ninguna
 * batalla lanzada desde la web podía completarse.
 *
 * Se corrige derivando un ASA (handle) conforme al contrato en lugar de
 * ensanchar el patrón. El esquema es un contrato ya publicado: relajarlo
 * afectaría a todos los bots firmados y a cualquier implementación externa del
 * SDK, y además dejaría entrar por el cable identificadores de forma libre.
 *
 * El asa vive SOLO en el cable (variable `BOT_ID` del contenedor + `expected`
 * del ProtocolServer). Todo lo interno —participantes, replay, resultados,
 * `cpu_ms`— sigue usando el identificador real del llamador, así que nada
 * aguas abajo cambia de clave.
 *
 * La correlación no depende de que el asa sea secreta: el ProtocolServer indexa
 * por `${botId}:${battleToken}` y el `battleToken` es un uuid aleatorio POR
 * PARTICIPANTE. Adivinar `bot_p2` no sirve de nada sin su token.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * El patrón se LEE del esquema publicado; no se copia aquí.
 *
 * Una copia sería una segunda fuente de verdad que puede desincronizarse en
 * silencio del contrato — exactamente la forma de fallo que este fichero
 * existe para evitar. Si el esquema cambia, esto cambia con él.
 */
function patronDelEsquema(): RegExp {
  const ruta = join(dirname(fileURLToPath(import.meta.url)), "schemas", "hello.schema.json");
  const esquema = JSON.parse(readFileSync(ruta, "utf8"));
  const patron = esquema?.properties?.botId?.pattern;
  if (typeof patron !== "string") {
    throw new Error("hello.schema.json ya no declara properties.botId.pattern: el asa no se puede derivar a ciegas");
  }
  return new RegExp(patron);
}

const PATRON_HELLO = patronDelEsquema();

/**
 * Falla si `botId` no puede viajar por el cable. La usa el ProtocolServer con
 * TODO lo que entra en `expected`, venga de donde venga (issue #92, obs. 2 del
 * supervisor): sin esto, un `expected` no conforme —`local-sim.ts`, el
 * simulador del SDK— reproduce el mismo fallo SILENCIOSO, porque el motor
 * descarta el HELLO sin decir nada y solo se ve un timeout de conexión.
 */
export function assertBotIdDelCable(botId: string, procedencia: string): void {
  if (!PATRON_HELLO.test(botId)) {
    throw new Error(
      `${procedencia}: el botId "${botId}" no cumple el patrón del HELLO (${PATRON_HELLO.source}). ` +
        `El motor descartaría su HELLO en silencio y el handshake expiraría. ` +
        `Deriva el asa con protocolBotHandle() en vez de pasar el identificador interno.`,
    );
  }
}

/**
 * Asa de protocolo para el participante en la posición `indice` (0-based).
 *
 * Determinista y estable dentro de una batalla, que es todo lo que hace falta:
 * `expected[i]` y el `BOT_ID` del contenedor `i` se derivan de la MISMA llamada.
 */
export function protocolBotHandle(indice: number): string {
  if (!Number.isInteger(indice) || indice < 0) {
    throw new Error(`protocolBotHandle: índice de participante inválido: ${String(indice)}`);
  }
  const asa = `bot_p${indice + 1}`;
  // Cinturón: si alguien cambia el formato de arriba por algo que el esquema no
  // acepta, se entera AQUÍ y no con un handshake que expira en producción.
  if (!PATRON_HELLO.test(asa)) {
    throw new Error(`protocolBotHandle: el asa generada "${asa}" no cumple el patrón del HELLO`);
  }
  return asa;
}

/**
 * B8 · Autenticación interna del replay-service (ESCRITURA).
 *
 * MISMO patrón, deliberadamente, que `apps/arena-engine/src/service.ts` (B2):
 * secreto compartido por fichero (`*_FILE`, patrón Docker secrets) o por
 * variable, comparación en TIEMPO CONSTANTE y comportamiento FAIL-CLOSED —
 * sin secreto configurado no se acepta NINGUNA escritura, nunca se degrada a
 * "abierto por defecto". No se inventa un mecanismo nuevo: el operador ya sabe
 * cómo se configura este tipo de frontera en este proyecto.
 *
 * ¿Por qué hacía falta? Hasta B8 `POST /replays/:battleId` (ingesta) y
 * `POST /retention/sweep` (borrado por retención) se servían SIN ninguna
 * credencial. La suposición de que "está en la red interna" es falsa además
 * de insuficiente: `infrastructure/gateway/nginx.conf` publica
 * `location /replays/ { proxy_pass http://replay-service:8083; }` SIN
 * restricción de método, así que cualquiera en Internet podía hacer
 * `POST /replays/<id>` contra el gateway e inyectar un replay falso que el
 * visor luego presenta como partida auténtica.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

/** Cabecera con la credencial interna de escritura (gemela de `x-arena-engine-auth`). */
export const REPLAY_INGEST_AUTH_HEADER = "x-replay-ingest-auth";

/**
 * Compara dos secretos en tiempo constante.
 *
 * - `undefined`/vacío en cualquiera de los dos lados SIEMPRE es inválido
 *   (fail-closed: sin `configured` no se acepta nada).
 * - Longitudes distintas NO lanzan: `timingSafeEqual` exige buffers del mismo
 *   tamaño, así que se hace una comparación señuelo del secreto contra sí mismo
 *   y se devuelve `false`. Así no se filtra por timing (ni por excepción) si el
 *   valor proporcionado es más corto o más largo que el configurado.
 */
export function isValidInternalSecret(configured: string | undefined, provided: string | undefined): boolean {
  if (!configured || !provided) return false;
  const a = Buffer.from(configured, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Resuelve el secreto de ingesta del entorno. El fichero
 * (`REPLAY_INGEST_SECRET_FILE`, patrón Docker secrets) tiene PRECEDENCIA sobre
 * la variable en claro (`REPLAY_INGEST_SECRET`). Fichero declarado pero
 * ilegible o vacío ⇒ SIN secreto (fail-closed: la escritura queda cerrada, NO
 * se cae a la variable en claro ni a "sin autenticación").
 *
 * Nunca se registra ni se devuelve el valor.
 */
export function resolveIngestSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.REPLAY_INGEST_SECRET_FILE;
  if (file) {
    try {
      const raw = readFileSync(file, "utf8").trim();
      return raw || undefined;
    } catch {
      return undefined;
    }
  }
  const plain = env.REPLAY_INGEST_SECRET;
  return plain && plain.length > 0 ? plain : undefined;
}

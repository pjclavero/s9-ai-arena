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
 * credencial.
 *
 * ALCANCE, MEDIDO (correcciones del supervisor y del coordinador de B8; la
 * primera versión de esta nota exageraba y se deja aquí la buena):
 *
 *  - La INGESTA sí estaba expuesta más allá del propio contenedor:
 *    `infrastructure/gateway/nginx.conf` publica
 *    `location /replays/ { proxy_pass http://replay-service:8083; }` SIN
 *    restricción de método, así que un `POST /replays/<id>` contra el gateway
 *    llegaba a la ingesta. Pero el alcance real HOY es la RED LOCAL, no
 *    Internet: el dominio público no responde y el reenvío del router está
 *    pendiente. Sigue siendo un control que falta, no una emergencia remota.
 *  - `POST /retention/sweep` NUNCA fue alcanzable por el gateway: no hay
 *    ningún `location /retention/` en los ocho bloques del vhost. Se autentica
 *    igualmente porque borra replays y estaba abierta a todo el que alcanzase
 *    el puerto interno, pero no era una vía de entrada desde fuera.
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
/*
 * DEUDA ANOTADA (idea del supervisor de B8, aceptada): ningún test puede
 * distinguir `timingSafeEqual` de `===` — un canal lateral de tiempo no es
 * observable funcionalmente y un micro-benchmark sería flaky en CI. La red de
 * seguridad que sí funcionaría es ESTÁTICA: una regla de lint que prohíba `===`
 * / `!==` sobre el secreto dentro de los módulos de autenticación, al estilo del
 * `apps/arena-engine/scripts/lint-determinism.mjs` que ya existe en el repo y ya
 * corre en CI (`npm run lint`). Fuera del alcance de B8; queda escrito aquí para
 * que no se pierda.
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

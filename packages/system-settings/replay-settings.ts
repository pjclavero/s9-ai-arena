/**
 * V1 REPLAYS · PR-5 · Claves `replays.*` de `system_settings` que gobiernan el ALMACENAMIENTO del
 * grabador (worker): cuota lógica del volumen, reserva mínima de espacio libre y tope por batalla.
 *
 * Mismo marco que ADM-1 (`registry.ts`): defecto EN CÓDIGO (prudente y valor fail-closed), rango
 * validado en servidor, TECHO por entorno (la variable acota lo que la web puede configurar y vale
 * cuando no hay fila) y `apply: "hot"` (el worker las relee por sondeo, ≈ 5 s, sin reiniciar).
 *
 * Qué NO entra: la ruta del volumen (`REPLAYS_DIR`) ni nada de retención/janitor (PR-6).
 *
 * Nota sobre el techo por entorno en `replays.quota.min_free_bytes`: el entorno es un TECHO (no un
 * suelo), así que acota lo MÁXIMO que se puede exigir de reserva desde la web. Sin fila, vale el
 * valor de la variable si existe y, si no, el defecto del código.
 */
import type { SettingDef } from "./registry.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const TiB = 1024 * GiB;

export const REPLAYS_QUOTA_MAX_BYTES = "replays.quota.max_bytes";
export const REPLAYS_QUOTA_MIN_FREE_BYTES = "replays.quota.min_free_bytes";
export const REPLAYS_LIMIT_MAX_BYTES_PER_BATTLE = "replays.limits.max_bytes_per_battle";

export const REPLAY_SETTING_DEFS: readonly SettingDef[] = [
  {
    key: REPLAYS_QUOTA_MAX_BYTES,
    type: "integer",
    min: 1 * GiB,
    max: 16 * TiB,
    default: 20 * GiB,
    consumer: "tournament-worker",
    apply: "hot",
    env: "REPLAYS_QUOTA_MAX_BYTES",
    description:
      "Cuota lógica máxima del volumen de replays (bytes publicados + papelera + parciales vivos). " +
      "El grabador la comprueba antes de cada fragmento; superada, la batalla se reintenta como fallo técnico.",
  },
  {
    key: REPLAYS_QUOTA_MIN_FREE_BYTES,
    type: "integer",
    min: 512 * MiB,
    max: 1 * TiB,
    default: 5 * GiB,
    consumer: "tournament-worker",
    apply: "hot",
    env: "REPLAYS_MIN_FREE_BYTES",
    description:
      "Reserva mínima de espacio FÍSICO libre en el volumen de replays. Si escribir un fragmento la dejaría " +
      "por debajo, la batalla se reintenta como fallo técnico; sin hueco mínimo no se arranca ninguna batalla.",
  },
  {
    key: REPLAYS_LIMIT_MAX_BYTES_PER_BATTLE,
    type: "integer",
    min: 4 * MiB,
    max: 1 * GiB,
    default: 64 * MiB,
    consumer: "tournament-worker",
    apply: "hot",
    env: "REPLAYS_MAX_BYTES_PER_BATTLE",
    description:
      "Tope de bytes de UN intento de batalla (receta + vista, ya comprimidos). Superado, la batalla termina " +
      "sin resultado deportivo (`recording_limit`) con el replay truncado y NO se reintenta. Un intento en " +
      "curso conserva el valor con el que empezó.",
  },
];

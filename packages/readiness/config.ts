/**
 * R17 · Modelo de configuración de la instalación.
 *
 * Qué resuelve: hoy la configuración vive repartida entre `process.env`, el
 * compose y la memoria del operador. Nadie puede responder "¿qué tengo que
 * configurar y qué pasa si no lo hago?" sin leer el código. Este módulo lo
 * declara en un solo sitio y, sobre todo, clasifica cada clave por PELIGRO:
 *
 *   - `required`      sin ella el sistema no debe arrancar.
 *   - `safeDefault`   tiene defecto y el defecto es seguro (se puede omitir).
 *   - `gate`          puerta de ejecución: APAGADA por defecto, encenderla es
 *                     un acto explícito del operador y puede estar BLOQUEADA.
 *   - `secret`        no se imprime nunca y no debe viajar en la línea de
 *                     comandos; se prefiere fichero montado (`*_FILE`).
 *
 * Lo que este módulo demuestra: que la configuración DECLARADA es coherente.
 * Lo que NO demuestra: que el sistema funcione. Una configuración válida no es
 * readiness — para eso está `engine.ts`. Esa distinción es todo R17.
 */

export type ConfigKind = "required" | "safeDefault" | "gate";

export interface ConfigEntry {
  key: string;
  kind: ConfigKind;
  /** Descripción corta, en español, orientada a quien instala. */
  purpose: string;
  /** Valor por defecto cuando `kind === "safeDefault"` o `kind === "gate"`. */
  default?: string;
  /** El valor es un secreto: nunca se imprime ni se pasa por argv. */
  secret?: boolean;
  /** Variante `*_FILE` admitida (secreto montado, p. ej. /run/secrets/<secret-name>). */
  fileVariant?: boolean;
  /**
   * La clave ES la `*_FILE`: su valor es una RUTA a un secreto montado, no el
   * secreto. La ruta se puede imprimir; el contenido no se lee aquí (que el
   * proceso lo tenga montado y legible es trabajo del motor de readiness:
   * SECRET EXISTS != SECRET MOUNTED).
   */
  pathToSecret?: boolean;
  /** Valores que jamás deben aceptarse en una instalación real. */
  forbiddenValues?: string[];
  /**
   * Puertas: el operador de ESTE despliegue las ha bloqueado. Encenderlas no es
   * un aviso, es un fallo de configuración.
   */
  blockedByOperator?: boolean;
}

/** Interpretación única de los booleanos de entorno del proyecto. */
export function isEnabled(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * El modelo describe el DESPLIEGUE REAL, no un contrato imaginado.
 *
 * La primera versión exigía `S9_DATA_DIR`, `S9_DB_URL`, `S9_JWT_SECRET` y
 * `S9_BACKUP_TARGET`. Ninguna de las cuatro existe: no aparecen en el compose,
 * no las lee ningún servicio y no están en el entorno de ningún contenedor —
 * sólo aparecían dentro de este mismo paquete. Producían cuatro "bloqueantes"
 * permanentes que no se podían arreglar configurando nada, y cuatro
 * bloqueantes de mentira esconden los de verdad. Se sustituyen por las claves
 * MEDIDAS en la instalación (compose renderizado + entorno de los
 * contenedores):
 *
 *   S9_DATA_DIR      → REPLAYS_DIR (volumen de replays montado en el servicio)
 *   S9_DB_URL        → PGHOST/PGUSER/PGDATABASE + PGPASSWORD_FILE (o DATABASE_URL)
 *   S9_JWT_SECRET    → JWT_SECRET_FILE (secreto montado, no valor en entorno)
 *   S9_BACKUP_TARGET → RESTIC_REPOSITORY + RESTIC_PASSWORD_FILE + RESTIC_SSH_KEY_FILE
 *
 * Las DOS claves `S9_*` que sí forman parte del contrato se conservan y aquí
 * queda por qué: `S9_DOMAIN` está declarada en el `.env` de la instalación y la
 * consume el gateway, y las dos puertas (`S9_ENABLE_REAL_BATTLE_RUNS`,
 * `S9_PUBLIC_SPECTATE_ENABLED`) las lee `apps/api` en el código. Que una puerta
 * no esté puesta en el entorno no la saca del contrato: su ausencia ES su
 * estado apagado, y readiness tiene que poder afirmarlo.
 *
 * Convenio de secretos: la clave que se declara es la `*_FILE`, cuyo VALOR es
 * una ruta (imprimible); el secreto en sí no pasa nunca por el entorno. Eso es
 * `pathToSecret`, distinto de `fileVariant` (clave que ADEMÁS admite una
 * variante `_FILE`).
 */
export const CONFIG_MODEL: readonly ConfigEntry[] = [
  {
    key: "REPLAYS_DIR",
    kind: "required",
    purpose: "Directorio de replays dentro del servicio (volumen persistente montado, no /tmp).",
    forbiddenValues: ["/tmp", "/tmp/", "/var/tmp"],
  },
  {
    key: "PGHOST",
    kind: "required",
    purpose: "Host de PostgreSQL en la red interna (nombre de servicio, nunca una IP en el repo).",
  },
  {
    key: "PGUSER",
    kind: "required",
    purpose: "Usuario de PostgreSQL con el que se conectan los servicios.",
  },
  {
    key: "PGDATABASE",
    kind: "required",
    purpose: "Base de datos de la arena.",
  },
  {
    key: "PGPASSWORD_FILE",
    kind: "required",
    secret: true,
    pathToSecret: true,
    purpose: "Ruta al secreto montado con la contraseña de PostgreSQL (/run/secrets/<secret-name>).",
  },
  {
    key: "DATABASE_URL",
    kind: "safeDefault",
    default: "",
    secret: true,
    purpose:
      "DSN completo alternativo (perfil de BD externa). Vacío = el servicio construye el DSN con PGHOST/PGUSER/PGPASSWORD_FILE, que es lo preferido.",
  },
  {
    key: "JWT_SECRET_FILE",
    kind: "required",
    secret: true,
    pathToSecret: true,
    purpose: "Ruta al secreto montado de firma de sesiones (/run/secrets/<secret-name>).",
  },
  {
    key: "ARENA_ENGINE_SHARED_SECRET_FILE",
    kind: "required",
    secret: true,
    pathToSecret: true,
    purpose: "Ruta al secreto compartido con el motor de arena, montado como fichero.",
  },
  {
    key: "REPLAY_INGEST_SECRET_FILE",
    kind: "required",
    secret: true,
    pathToSecret: true,
    purpose: "Ruta al secreto de ingesta de replays, montado como fichero.",
  },
  {
    key: "ARENA_ENGINE_INTERNAL_SECRET_FILE",
    kind: "safeDefault",
    default: "",
    secret: true,
    pathToSecret: true,
    purpose:
      "Cara del motor de arena del mismo secreto compartido (el motor lo lee con este nombre y la API con ARENA_ENGINE_SHARED_SECRET_FILE).",
  },
  {
    key: "ARENA_ENGINE_HOST",
    kind: "safeDefault",
    default: "arena-engine",
    purpose: "Nombre del motor de arena en la red interna.",
  },
  {
    key: "ARENA_NETWORK",
    kind: "safeDefault",
    default: "arena",
    purpose: "Red interna (sin salida a Internet) en la que corren las partidas.",
  },
  {
    key: "ARENA_ENGINE_URL",
    kind: "safeDefault",
    default: "",
    purpose: "URL interna del motor de arena. Vacío = la API no tiene runner cableado y responde 503.",
  },
  {
    key: "ARENA_DATA_DIRS",
    kind: "safeDefault",
    default: "",
    purpose: "Directorios de datos que el arranque del servicio comprueba escribibles.",
  },
  {
    key: "REPLAY_SERVICE_URL",
    kind: "safeDefault",
    default: "",
    purpose: "URL interna del servicio de replays.",
  },
  {
    key: "REPLAY_INGEST_REQUIRED",
    kind: "safeDefault",
    default: "",
    purpose: "Vacío = ingesta best-effort. Exigirla es un endurecimiento, no el defecto.",
  },
  {
    key: "REPLAY_RETENTION_DAYS",
    kind: "safeDefault",
    default: "180",
    purpose: "Días que la copia conserva replays antes de podarlos.",
  },
  {
    key: "RESTIC_REPOSITORY",
    kind: "required",
    purpose: "Repositorio de copias (p. ej. sftp:<usuario>@<backup-host>:/<repo>). Sin él no hay bloque de copias.",
  },
  {
    key: "RESTIC_PASSWORD_FILE",
    kind: "required",
    secret: true,
    pathToSecret: true,
    purpose: "Ruta al secreto montado con la clave del repositorio de copias.",
  },
  {
    key: "RESTIC_SSH_KEY_FILE",
    kind: "required",
    secret: true,
    pathToSecret: true,
    purpose: "Ruta a la llave SSH montada para llegar al repositorio remoto.",
  },
  {
    key: "RESTIC_SSH_KNOWN_HOSTS_FILE",
    kind: "required",
    pathToSecret: true,
    purpose:
      "Ruta al known_hosts montado: sin él la copia aceptaría cualquier host remoto que responda en esa dirección.",
  },
  {
    key: "RESTIC_HOSTNAME",
    kind: "safeDefault",
    default: "",
    purpose:
      "Nombre de host con el que se etiquetan los snapshots. Vacío = restic usa el hostname del contenedor, que CAMBIA en cada recreación: entonces no se puede acotar por host y hay que acotar por etiqueta.",
  },
  {
    key: "BACKUP_CRON",
    kind: "safeDefault",
    default: "15 4 * * *",
    purpose: "Planificación de la copia dentro del servicio de copias.",
  },
  {
    key: "METRICS_DIR",
    kind: "safeDefault",
    default: "/textfile",
    purpose: "Directorio donde la copia deja sus métricas: es la única evidencia legible de la última ejecución.",
  },
  {
    key: "S9_DOMAIN",
    kind: "required",
    purpose: "Dominio público que sirve el gateway. Declarado en el .env de la instalación.",
  },
  {
    key: "S9_READINESS_CONTAINER",
    kind: "safeDefault",
    default: "",
    purpose:
      "Contenedor al que la sonda de readiness pregunta la versión desplegada (solo lectura). Vacío = esa comprobación queda NO EJERCIDA.",
  },
  {
    key: "S9_READINESS_BACKUP_CONTAINER",
    kind: "safeDefault",
    default: "",
    purpose:
      "Servicio de copias al que las sondas preguntan en SOLO LECTURA (estado, métricas y snapshots). Vacío = esas comprobaciones quedan NO EJERCIDAS.",
  },
  {
    // La verbosidad real del despliegue se controla con LOG_FORMAT (json), no
    // con S9_LOG_LEVEL, que no la lee nadie. S9_PUBLIC_BASE_URL tampoco existe:
    // el enlace público sale de S9_DOMAIN. Ambas se han retirado del modelo.
    key: "LOG_FORMAT",
    kind: "safeDefault",
    default: "json",
    purpose: "Formato de log de los servicios. `json` es el contrato de observabilidad del proyecto.",
  },
  {
    key: "S9_ENABLE_REAL_BATTLE_RUNS",
    kind: "gate",
    default: "0",
    blockedByOperator: true,
    purpose: "Puerta de EJECUCIÓN: lanza contenedores de bots reales. Apagada por defecto.",
  },
  {
    key: "S9_PUBLIC_SPECTATE_ENABLED",
    kind: "gate",
    default: "0",
    blockedByOperator: true,
    purpose: "Puerta de SPECTATOR/REPLAY público: expone partidas sin autenticar. Apagada por defecto.",
  },
];

export type ConfigProblemCode =
  "missing_required" | "forbidden_value" | "secret_inline" | "gate_enabled" | "gate_blocked" | "unknown_key";

export interface ConfigProblem {
  code: ConfigProblemCode;
  key: string;
  /** Mensaje accionable. NUNCA contiene el valor cuando la clave es secreta. */
  message: string;
  severity: "error" | "warning";
}

export interface ConfigResolution {
  /** Valores efectivos (secretos redactados). */
  effective: Record<string, string>;
  problems: ConfigProblem[];
  /** Puertas encendidas de verdad, tras aplicar defectos. */
  gatesOn: string[];
  ok: boolean;
}

/**
 * Resuelve la configuración contra el modelo.
 *
 * `*_FILE` indica que el secreto llega montado como fichero
 * (`S9_JWT_SECRET_FILE=/run/secrets/<secret-name>`); su contenido no se lee
 * aquí: comprobar que el proceso lo tiene MONTADO y legible es trabajo del
 * motor de readiness (SECRET EXISTS != SECRET MOUNTED).
 */
export function resolveConfig(
  env: Record<string, string | undefined>,
  model: readonly ConfigEntry[] = CONFIG_MODEL,
): ConfigResolution {
  const problems: ConfigProblem[] = [];
  const effective: Record<string, string> = {};
  const gatesOn: string[] = [];

  for (const entry of model) {
    const fromFile = Boolean(entry.fileVariant) && (env[`${entry.key}_FILE`] ?? "").trim() !== "";
    const raw = (env[entry.key] ?? "").trim();
    const value = raw !== "" ? raw : (entry.default ?? "");

    if (entry.secret && !entry.pathToSecret && raw !== "") {
      problems.push({
        code: "secret_inline",
        key: entry.key,
        severity: "warning",
        message: `${entry.key} llega por entorno en claro; se prefiere ${entry.key}_FILE apuntando a /run/secrets/<secret-name>.`,
      });
    }

    if (value === "" && !fromFile) {
      if (entry.kind === "required") {
        problems.push({
          code: "missing_required",
          key: entry.key,
          severity: "error",
          message: `Falta ${entry.key}: ${entry.purpose}`,
        });
      }
      continue;
    }

    // La RUTA de un secreto montado sí se imprime (es lo que hay que revisar);
    // el valor de un secreto en claro, jamás.
    effective[entry.key] = entry.pathToSecret
      ? value
      : entry.secret
        ? fromFile
          ? "<montado desde fichero>"
          : "<redactado>"
        : value;

    if (entry.pathToSecret && !value.startsWith("/")) {
      problems.push({
        code: "forbidden_value",
        key: entry.key,
        severity: "error",
        message: `${entry.key} debe ser una RUTA a un secreto montado (/run/secrets/<secret-name>), no el secreto en sí.`,
      });
    }

    if (entry.forbiddenValues?.some((f) => f.toLowerCase() === value.toLowerCase())) {
      problems.push({
        code: "forbidden_value",
        key: entry.key,
        severity: "error",
        message: entry.secret
          ? `${entry.key} usa un valor de ejemplo/débil conocido. Genera uno nuevo y móntalo como fichero.`
          : `${entry.key} tiene un valor prohibido (${value}): ${entry.purpose}`,
      });
    }

    if (entry.kind === "gate" && isEnabled(value)) {
      gatesOn.push(entry.key);
      problems.push(
        entry.blockedByOperator
          ? {
              code: "gate_blocked",
              key: entry.key,
              severity: "error",
              message: `${entry.key} está ENCENDIDA pero el operador la mantiene BLOQUEADA en este despliegue.`,
            }
          : {
              code: "gate_enabled",
              key: entry.key,
              severity: "warning",
              message: `${entry.key} encendida: acto explícito, revisa que sea intencionado.`,
            },
      );
    }
  }

  // Configuración fantasma: sólo se barren los prefijos que este proyecto se ha
  // reservado. Antes se miraba únicamente `S9_`, y como el contrato real vive
  // sobre todo en `RESTIC_*`, `REPLAY_*` y `ARENA_*`, una clave inventada en
  // esas familias pasaba desapercibida.
  const PREFIJOS_DEL_PROYECTO = ["S9_", "RESTIC_", "REPLAY_", "REPLAYS_", "ARENA_", "BACKUP_"];
  const known = new Set(model.map((e) => e.key));
  for (const key of Object.keys(env)) {
    if (!PREFIJOS_DEL_PROYECTO.some((p) => key.startsWith(p))) continue;
    if (known.has(key) || known.has(key.replace(/_FILE$/, ""))) continue;
    problems.push({
      code: "unknown_key",
      key,
      severity: "warning",
      message: `${key} no está en el modelo de configuración: o se documenta o se borra (config fantasma).`,
    });
  }

  return { effective, problems, gatesOn, ok: !problems.some((p) => p.severity === "error") };
}

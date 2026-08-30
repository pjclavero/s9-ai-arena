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

export const CONFIG_MODEL: readonly ConfigEntry[] = [
  {
    key: "S9_DATA_DIR",
    kind: "required",
    purpose: "Directorio de datos persistente (replays). Debe ser un volumen, no /tmp.",
    forbiddenValues: ["/tmp", "/tmp/", "/var/tmp"],
  },
  {
    key: "S9_DB_URL",
    kind: "required",
    secret: true,
    fileVariant: true,
    purpose: "Cadena de conexión a PostgreSQL (usar <internal-db-host>, nunca una IP en el repo).",
  },
  {
    key: "S9_JWT_SECRET",
    kind: "required",
    secret: true,
    fileVariant: true,
    purpose: "Secreto de firma de sesiones. Debe venir de /run/secrets/<secret-name>.",
    forbiddenValues: ["changeme", "secret", "dev", "development", "s9-dev-secret", "test"],
  },
  {
    key: "S9_BACKUP_TARGET",
    kind: "required",
    purpose: "Destino de copias (p. ej. sftp://<backup-host>/<repo>). Sin él no hay bloque de copias.",
  },
  {
    key: "S9_LOG_LEVEL",
    kind: "safeDefault",
    default: "info",
    purpose: "Verbosidad de log. El defecto no filtra cuerpos de petición.",
  },
  {
    key: "S9_PUBLIC_BASE_URL",
    kind: "safeDefault",
    default: "http://localhost:8080",
    purpose: "URL pública para enlaces. El defecto es local: no expone nada.",
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

    if (entry.secret && raw !== "") {
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

    effective[entry.key] = entry.secret ? (fromFile ? "<montado desde fichero>" : "<redactado>") : value;

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

  const known = new Set(model.map((e) => e.key));
  for (const key of Object.keys(env)) {
    if (!key.startsWith("S9_")) continue;
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

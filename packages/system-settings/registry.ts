/**
 * ADM-1 · REGISTRO de ajustes del sistema (`system_settings`), en código y sin BD.
 *
 * Es la ÚNICA fuente de qué claves existen, de qué tipo y rango son, cuál es su valor
 * por defecto, qué servicio las lee y si el cambio se aplica en caliente o exige
 * reinicio del consumidor. El servidor rechaza cualquier clave o valor que no cumpla
 * este registro (no hay claves «libres»), y los lectores de los servicios descartan
 * lo que no valida (fail-closed hacia el valor por defecto).
 *
 * El ENTORNO sigue siendo el TECHO DURO: una clave numérica con `env` no puede superar
 * el valor de esa variable de entorno (si es válida). El valor de la BD sólo puede
 * bajar o igualar el techo, nunca subirlo; y sin fila en BD vale el techo/entorno si
 * existe y, si no, el valor por defecto.
 *
 * Qué NO entra aquí: secretos y credenciales (viven en sus almacenes sellados), URLs y
 * puertos, imágenes y límites de contenedor. Esas claves quedan sólo en entorno/compose.
 */

export type SettingType = "integer" | "number" | "boolean" | "enum";
/** `hot`: el consumidor lo aplica al sondear (≈5 s). `restart`: sólo tras reiniciar el consumidor. */
export type ApplyClass = "hot" | "restart";
export type SettingValue = number | boolean | string;

export interface SettingDef {
  /** `dominio.nombre` en minúsculas: `worker.concurrency`. */
  key: string;
  type: SettingType;
  /** Rango inclusivo (sólo integer/number). */
  min?: number;
  max?: number;
  /** Valores admitidos (sólo enum). */
  options?: readonly string[];
  /** Valor por defecto del código (y valor FAIL-CLOSED: conservador). */
  default: SettingValue;
  /** Servicio que consume la clave (documentación y pantalla). */
  consumer: string;
  apply: ApplyClass;
  /**
   * Variable de entorno que actúa de TECHO DURO (integer/number) y de valor cuando no hay
   * fila en BD. Debe estar dentro del rango y ser válida; si no, se ignora.
   */
  env?: string;
  description: string;
}

export const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export type Validation =
  { ok: true; value: SettingValue; error?: undefined } | { ok: false; error: string; value?: undefined };

/** Validación ESTRICTA de tipo y rango (sin coerción: "5" no es 5, 1 no es true). */
function validateRaw(d: SettingDef, v: unknown): Validation {
  switch (d.type) {
    case "boolean":
      return typeof v === "boolean" ? { ok: true, value: v } : { ok: false, error: `${d.key} debe ser booleano` };
    case "enum":
      return typeof v === "string" && d.options!.includes(v)
        ? { ok: true, value: v }
        : { ok: false, error: `${d.key} debe ser uno de: ${d.options!.join(", ")}` };
    case "integer":
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, error: `${d.key} debe ser un número` };
      if (d.type === "integer" && !Number.isInteger(v)) return { ok: false, error: `${d.key} debe ser un entero` };
      if (v < d.min! || v > d.max!) return { ok: false, error: `${d.key} debe estar entre ${d.min} y ${d.max}` };
      return { ok: true, value: v };
    }
  }
}

/** Comprueba la coherencia de una definición. Lanza al construir el registro (arranque). */
function assertDef(d: SettingDef): void {
  if (!KEY_PATTERN.test(d.key)) throw new Error(`clave de ajuste inválida: ${JSON.stringify(d.key)}`);
  if (
    (d.type === "integer" || d.type === "number") &&
    (typeof d.min !== "number" || typeof d.max !== "number" || d.min > d.max)
  ) {
    throw new Error(`${d.key}: las claves numéricas exigen min y max coherentes`);
  }
  if (d.type === "enum" && (!d.options || d.options.length === 0)) throw new Error(`${d.key}: enum sin opciones`);
  const r = validateRaw(d, d.default);
  if (!r.ok) throw new Error(`${d.key}: el valor por defecto no valida (${r.error})`);
}

export interface SettingsRegistry {
  readonly defs: readonly SettingDef[];
  get(key: string): SettingDef | undefined;
}

export function createSettingsRegistry(defs: readonly SettingDef[]): SettingsRegistry {
  const map = new Map<string, SettingDef>();
  for (const d of defs) {
    assertDef(d);
    if (map.has(d.key)) throw new Error(`clave de ajuste duplicada: ${d.key}`);
    map.set(d.key, Object.freeze({ ...d }));
  }
  return { defs: [...map.values()], get: (k) => map.get(k) };
}

export type CeilingState =
  | { state: "none" }
  | { state: "ok"; value: number }
  /** Variable definida pero ilegible o fuera de [min,max]: la clave se trata como BLOQUEADA (fail-closed). */
  | { state: "invalid" };

const loggedInvalid = new Set<string>();

/**
 * Estado del techo del entorno. Una variable ausente o vacía = sin techo; definida y MAL FORMADA (no
 * numérica, no entera, fuera de rango) = `invalid`: no se ignora en silencio (se registra una vez en el
 * log) y el llamador falla cerrado.
 */
export function envCeilingState(d: SettingDef, env: NodeJS.ProcessEnv = process.env): CeilingState {
  if ((d.type !== "integer" && d.type !== "number") || !d.env) return { state: "none" };
  const raw = env[d.env];
  if (raw === undefined || raw.trim() === "") return { state: "none" };
  const n = Number(raw);
  if (!Number.isFinite(n) || (d.type === "integer" && !Number.isInteger(n)) || n < d.min! || n > d.max!) {
    if (!loggedInvalid.has(`${d.env}=${raw}`)) {
      loggedInvalid.add(`${d.env}=${raw}`);
      console.error(
        JSON.stringify({
          level: "error",
          msg: "ajuste: variable de entorno de techo inválida; la clave queda bloqueada y vale su defecto",
          key: d.key,
          env: d.env,
        }),
      );
    }
    return { state: "invalid" };
  }
  return { state: "ok", value: n };
}

/** Techo del entorno vigente y VÁLIDO (null si no hay o la variable es inválida: ver `envCeilingState`). */
export function envCeiling(d: SettingDef, env: NodeJS.ProcessEnv = process.env): number | null {
  const c = envCeilingState(d, env);
  return c.state === "ok" ? c.value : null;
}

/** Valida un valor a ESCRIBIR: tipo, rango del registro y techo del entorno (inválido ⇒ clave bloqueada). */
export function validateSettingValue(d: SettingDef, v: unknown, env: NodeJS.ProcessEnv = process.env): Validation {
  const r = validateRaw(d, v);
  if (!r.ok) return r;
  const c = envCeilingState(d, env);
  if (c.state === "invalid") {
    return {
      ok: false,
      error: `${d.key} está bloqueada: la variable de entorno ${d.env} está mal formada (corrígela y reinicia)`,
    };
  }
  if (c.state === "ok" && typeof r.value === "number" && r.value > c.value) {
    return { ok: false, error: `${d.key} no puede superar el techo del entorno (${c.value})` };
  }
  return r;
}

/**
 * Valor EFECTIVO de una clave dada la fila de BD (o undefined). Sin fila: techo/entorno y, si no hay,
 * el defecto. Fila inválida (o ilegible): se IGNORA y se cae al mismo valor. Fila válida por encima del
 * techo actual del entorno: se recorta al techo. Techo del entorno MAL FORMADO: fail-closed, vale el
 * defecto del registro (nunca el valor de la BD) y se marca como inválido.
 */
export function effectiveValue(
  d: SettingDef,
  dbValue: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { value: SettingValue; source: "database" | "environment" | "default"; invalid: boolean } {
  const cs = envCeilingState(d, env);
  if (cs.state === "invalid") return { value: d.default, source: "default", invalid: true };
  const ceil = cs.state === "ok" ? cs.value : null;
  const fallback = (): { value: SettingValue; source: "environment" | "default" } =>
    ceil !== null ? { value: ceil, source: "environment" } : { value: d.default, source: "default" };
  if (dbValue === undefined) return { ...fallback(), invalid: false };
  const r = validateRaw(d, dbValue);
  if (!r.ok) return { ...fallback(), invalid: true };
  if (ceil !== null && typeof r.value === "number" && r.value > ceil) {
    return { value: ceil, source: "environment", invalid: false };
  }
  return { value: r.value, source: "database", invalid: false };
}

/**
 * Claves registradas de fábrica. Vacío a propósito: ADM-1 sólo trae el marco. ADM-2 (worker) y el
 * PR de replays añaden AQUÍ sus claves reales, con su consumidor, sin tocar nada más. Los tests
 * registran sus propias claves de prueba con `createSettingsRegistry`.
 */
export const SYSTEM_SETTINGS_REGISTRY: SettingsRegistry = createSettingsRegistry([]);

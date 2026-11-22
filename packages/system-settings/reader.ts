/**
 * ADM-1 · LECTOR reutilizable de `system_settings` para los servicios (api, worker,
 * replay-service…). Mismo patrón que `RuntimeSettingsStore` (migración 021), del que
 * REUTILIZA el reloj (`refreshMsFromEnv`, 5 s) y la ventana de staleness (3 × refresh):
 *
 *  - copia EN MEMORIA que se refresca por sondeo; `get(key)` es SÍNCRONO;
 *  - valida cada fila contra el registro: una fila inválida o de una clave desconocida
 *    se IGNORA (cuenta en `invalidCount` para la métrica/alerta) y vale el entorno/defecto;
 *  - el entorno es TECHO DURO (ver `effectiveValue`);
 *  - FAIL-CLOSED: sin una lectura válida reciente (arranque sin BD, BD caída más de
 *    `staleMs`, tabla sin migrar) TODAS las claves valen su valor por defecto del código
 *    (conservador), recortado al techo del entorno, nunca el último valor viejo
 *    indefinidamente.
 *
 * No escribe nada: la escritura (validada, versionada y auditada) es de la API.
 */
import type { Db } from "../../apps/api/src/db/connection.js";
import { DEFAULT_STALE_FACTOR, refreshMsFromEnv } from "../../apps/api/src/runtime-settings.js";
import { effectiveValue, envCeiling, type SettingValue, type SettingsRegistry } from "./registry.js";

export const SYSTEM_SETTINGS_TABLE = "system_settings";

export interface ReaderOptions {
  refreshMs?: number;
  /** Ventana (ms) en la que se conserva el último valor si la BD falla. Por defecto 3 × refreshMs. */
  staleMs?: number;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export type SettingSource = "database" | "environment" | "default" | "fail_closed";

export class SystemSettingsReader {
  private values = new Map<string, { value: SettingValue; source: SettingSource }>();
  private lastGoodAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  readonly refreshMs: number;
  readonly staleMs: number;
  /** Filas inválidas o de claves desconocidas en la ÚLTIMA lectura (gauge para la alerta). */
  invalidCount = 0;

  constructor(
    private readonly db: Db,
    readonly registry: SettingsRegistry,
    opts: ReaderOptions = {},
  ) {
    this.refreshMs = opts.refreshMs ?? refreshMsFromEnv();
    this.staleMs = opts.staleMs ?? this.refreshMs * DEFAULT_STALE_FACTOR;
    this.now = opts.now ?? Date.now;
    this.env = opts.env ?? process.env;
  }

  isFresh(): boolean {
    return this.lastGoodAt !== null && this.now() - this.lastGoodAt <= this.staleMs;
  }

  private failClosed(key: string): { value: SettingValue; source: SettingSource } {
    const d = this.registry.get(key);
    if (!d) throw new Error(`ajuste no registrado: ${key}`);
    const ceil = envCeiling(d, this.env);
    const value = ceil !== null && typeof d.default === "number" && d.default > ceil ? ceil : d.default;
    return { value, source: "fail_closed" };
  }

  /** Valor vigente de una clave REGISTRADA (síncrono). Una clave no registrada lanza. */
  get(key: string): SettingValue {
    return this.entry(key).value;
  }

  entry(key: string): { value: SettingValue; source: SettingSource } {
    if (!this.registry.get(key)) throw new Error(`ajuste no registrado: ${key}`);
    if (!this.isFresh()) return this.failClosed(key);
    return this.values.get(key) ?? this.failClosed(key);
  }

  /** Relee todas las filas. Un error NO renueva la lectura: al vencer `staleMs` se cierra. */
  async refresh(): Promise<void> {
    let rows: { key: string; value: unknown }[];
    try {
      rows = await this.db(SYSTEM_SETTINGS_TABLE).select("key", "value");
    } catch {
      return;
    }
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const next = new Map<string, { value: SettingValue; source: SettingSource }>();
    let invalid = 0;
    for (const k of byKey.keys()) if (!this.registry.get(k)) invalid++;
    for (const d of this.registry.defs) {
      const e = effectiveValue(d, byKey.get(d.key), this.env);
      if (e.invalid) invalid++;
      next.set(d.key, { value: e.value, source: e.source });
    }
    this.invalidCount = invalid;
    this.values = next;
    this.lastGoodAt = this.now();
  }

  start(): this {
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), this.refreshMs);
      this.timer.unref?.();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

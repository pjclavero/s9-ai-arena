/**
 * MG · Ajustes de RUNTIME persistidos (acceso público / broadcast).
 *
 * Antes `S9_PUBLIC_SPECTATE_ENABLED` y `S9_PUBLIC_REPLAYS_ENABLED` sólo se leían del
 * entorno al arrancar: cambiarlos exigía editar `.env` y recrear `api` y
 * `tournament-worker`. Ahora:
 *
 *  - la FUENTE ÚNICA es la fila `app_runtime_settings` (migración 021, sin secretos);
 *  - el entorno es el valor por defecto, el BOOTSTRAP y el FALLBACK: la primera API que
 *    arranca sobre una BD sin fila la crea con los valores de SU entorno (INSERT … ON
 *    CONFLICT DO NOTHING), así un despliegue no cambia el comportamiento;
 *  - después manda lo persistido (el entorno ya no se mira mientras la fila exista);
 *  - cada proceso (api, tournament-worker) mantiene una copia EN MEMORIA que se
 *    refresca cada `refreshMs` (por defecto 5 s, `S9_RUNTIME_SETTINGS_REFRESH_MS`).
 *    El proceso que guarda un cambio lo aplica en el acto; los demás, como mucho
 *    `refreshMs` (+ la duración de una consulta) después. Ésa es la LATENCIA MÁXIMA
 *    de un cambio en caliente, sin recrear contenedores;
 *  - el getter `publicVisibility()` es SÍNCRONO (lo usan el gateway WebSocket y las
 *    políticas de acceso por petición) y es la única lectura de los flags: nadie
 *    más consulta `process.env.S9_PUBLIC_*`.
 *
 * FAIL-CLOSED (revisión MG): los flags públicos sólo valen TRUE mientras haya una
 * lectura válida de la BD reciente.
 *  - Si la lectura falla se conserva el último valor sólo durante una ventana de
 *    staleness acotada: `staleMs` (por defecto 3 × refreshMs, `DEFAULT_STALE_FACTOR`).
 *    Pasada la ventana sin una lectura válida, AMBOS flags valen FALSE hasta que la BD
 *    vuelva a responder: una revocación (PATCH a false) no puede quedar sin efecto
 *    indefinidamente por una BD caída.
 *  - En el ARRANQUE sin lectura válida (BD caída, sin migrar o, en el worker, sin fila
 *    todavía) los flags valen FALSE, nunca el entorno. El entorno sólo se usa como
 *    valor del INSERT de bootstrap cuando la BD responde y no hay fila (sólo la API).
 */
import type { Db } from "./db/connection.js";
import { audit } from "./audit.js";
import { publicSpectateEnabledFromEnv } from "./public-spectate.js";
import { publicReplaysEnabledFromEnv } from "./public-replays.js";

/** Los dos flags públicos. Misma forma que `BattleVisibility` (battle-access.ts). */
export interface PublicVisibility {
  publicSpectate: boolean;
  publicReplays: boolean;
}

/** Getter síncrono de la visibilidad pública vigente. */
export type PublicVisibilitySource = () => PublicVisibility;

export const RUNTIME_SETTINGS_TABLE = "app_runtime_settings";
export const DEFAULT_REFRESH_MS = 5_000;
/** Ventana de staleness por defecto = este factor × refreshMs. */
export const DEFAULT_STALE_FACTOR = 3;
export const CLOSED: PublicVisibility = Object.freeze({ publicSpectate: false, publicReplays: false });
/** Acción de auditoría de un cambio de los ajustes públicos. */
export const AUDIT_ACTION = "settings.public_access.update";
export const AUDIT_TARGET = "settings:public_access";

export function publicVisibilityFromEnv(env: NodeJS.ProcessEnv = process.env): PublicVisibility {
  return { publicSpectate: publicSpectateEnabledFromEnv(env), publicReplays: publicReplaysEnabledFromEnv(env) };
}

export function refreshMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.S9_RUNTIME_SETTINGS_REFRESH_MS);
  return Number.isInteger(n) && n >= 500 && n <= 60_000 ? n : DEFAULT_REFRESH_MS;
}

/** `unavailable`: sin lectura válida reciente de la BD (los flags valen FALSE). */
export type SettingsSource = "database" | "environment" | "unavailable";

export interface PublicAccessSnapshot extends PublicVisibility {
  /** De dónde sale el valor vigente en ESTE proceso. */
  source: SettingsSource;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Latencia máxima de propagación a los demás procesos (ms). */
  refreshMs: number;
}

/** Patch estricto: sólo booleanos y sólo estas dos claves. */
export interface PublicAccessPatch {
  publicSpectateEnabled?: boolean;
  publicReplaysEnabled?: boolean;
}

/** Valida el cuerpo del PATCH: devuelve el patch o la lista de errores. */
export function parsePublicAccessPatch(body: unknown): { patch: PublicAccessPatch; errors: string[] } {
  const errors: string[] = [];
  const patch: PublicAccessPatch = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { patch, errors: ["el cuerpo debe ser un objeto JSON"] };
  }
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k !== "publicSpectateEnabled" && k !== "publicReplaysEnabled") {
      errors.push(`campo no admitido: ${k}`);
      continue;
    }
    // Booleanos ESTRICTOS: ni "true", ni 1, ni null.
    if (typeof o[k] !== "boolean") errors.push(`${k} debe ser booleano (true o false)`);
    else patch[k] = o[k] as boolean;
  }
  if (errors.length === 0 && Object.keys(patch).length === 0) {
    errors.push("nada que cambiar: envía publicSpectateEnabled y/o publicReplaysEnabled");
  }
  return { patch, errors };
}

interface Row {
  public_spectate_enabled: boolean;
  public_replays_enabled: boolean;
  updated_at: Date | string;
  updated_by: string | null;
}

export interface RuntimeSettingsOptions {
  /** Valor por defecto: SÓLO el INSERT de bootstrap (API) cuando la BD responde y no hay fila. Por defecto, el entorno. */
  defaults?: PublicVisibility;
  /** Cada cuánto se relee la fila (ms). */
  refreshMs?: number;
  /**
   * Si este proceso CREA la fila cuando falta (con `defaults`). Sólo la API: el
   * tournament-worker no recibe `S9_PUBLIC_REPLAYS_ENABLED` y no debe fijarlo.
   */
  bootstrap?: boolean;
  /** Ventana (ms) durante la que se conserva el último valor si la BD falla. Por defecto 3 × refreshMs. */
  staleMs?: number;
  /** Reloj inyectable (tests). */
  now?: () => number;
  /**
   * SÓLO montajes sin BD de ajustes (tests de `createApp` con flags explícitos): los
   * `defaults` valen como lectura válida permanente. Producción nunca lo activa.
   */
  fixed?: boolean;
}

export class RuntimeSettingsStore {
  private current: PublicVisibility;
  /** Instante (ms) de la última lectura/escritura VÁLIDA de la BD; null = nunca. */
  private lastGoodAt: number | null = null;
  private readonly fixed: boolean;
  readonly staleMs: number;
  private readonly now: () => number;
  private source: SettingsSource = "environment";
  private updatedAt: string | null = null;
  private updatedBy: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly defaults: PublicVisibility;
  readonly refreshMs: number;
  private readonly bootstrap: boolean;

  constructor(
    private readonly db: Db,
    opts: RuntimeSettingsOptions = {},
  ) {
    this.defaults = { ...(opts.defaults ?? publicVisibilityFromEnv()) };
    this.current = { ...this.defaults };
    this.refreshMs = opts.refreshMs ?? refreshMsFromEnv();
    this.bootstrap = opts.bootstrap ?? false;
    this.now = opts.now ?? Date.now;
    this.fixed = opts.fixed ?? false;
    this.staleMs = opts.staleMs ?? this.refreshMs * DEFAULT_STALE_FACTOR;
  }

  /** ¿El valor en memoria procede de una lectura válida y reciente de la BD? */
  isFresh(): boolean {
    if (this.fixed) return true;
    return this.lastGoodAt !== null && this.now() - this.lastGoodAt <= this.staleMs;
  }

  /** Getter ÚNICO y síncrono de la visibilidad pública vigente (FAIL-CLOSED). */
  publicVisibility(): PublicVisibility {
    return this.isFresh() ? { ...this.current } : { ...CLOSED };
  }

  /** Lo mismo como función suelta (para inyectar en rutas y gateway). */
  readonly getter: PublicVisibilitySource = () => this.publicVisibility();

  snapshot(): PublicAccessSnapshot {
    return {
      ...this.publicVisibility(),
      source: this.isFresh() ? this.source : "unavailable",
      updatedAt: this.updatedAt,
      updatedBy: this.updatedBy,
      refreshMs: this.refreshMs,
    };
  }

  private apply(row: Row): void {
    this.current = { publicSpectate: row.public_spectate_enabled, publicReplays: row.public_replays_enabled };
    this.source = "database";
    this.lastGoodAt = this.now();
    this.updatedAt = new Date(row.updated_at).toISOString();
    this.updatedBy = row.updated_by ?? null;
  }

  private async readRow(q: Db = this.db): Promise<Row | undefined> {
    return q(RUNTIME_SETTINGS_TABLE).where({ id: 1 }).first();
  }

  private async insertDefaults(q: Db = this.db): Promise<void> {
    await q(RUNTIME_SETTINGS_TABLE)
      .insert({
        id: 1,
        public_spectate_enabled: this.defaults.publicSpectate,
        public_replays_enabled: this.defaults.publicReplays,
      })
      .onConflict("id")
      .ignore();
  }

  /**
   * Relee la fila. Sin fila: la API la crea con los valores por defecto (bootstrap);
   * el worker no tiene valor válido (FALSE) hasta que exista. Un error conserva el
   * último valor sólo durante `staleMs` (ver cabecera).
   */
  async refresh(): Promise<void> {
    try {
      let row = await this.readRow();
      if (!row && this.bootstrap) {
        await this.insertDefaults();
        row = await this.readRow();
      }
      if (row) this.apply(row);
    } catch {
      /* BD caída o sin migrar: no se renueva la lectura; `publicVisibility()` cierra al vencer `staleMs`. */
    }
  }

  /** Empieza a refrescar periódicamente (no retiene el proceso vivo). */
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

  /**
   * Cambia los ajustes en UNA transacción (fila bloqueada) y deja el cambio en
   * `audit_log` con el valor anterior y el nuevo. Se aplica en este proceso al
   * instante; en los demás, en ≤ `refreshMs`.
   */
  async update(
    patch: PublicAccessPatch,
    ctx: { actorId: string | null; correlationId?: string },
  ): Promise<{ before: PublicVisibility; after: PublicVisibility; changed: boolean }> {
    const result = await this.db.transaction(async (trx) => {
      await this.insertDefaults(trx as unknown as Db);
      const row = (await trx(RUNTIME_SETTINGS_TABLE).where({ id: 1 }).forUpdate().first()) as Row;
      const before: PublicVisibility = {
        publicSpectate: row.public_spectate_enabled,
        publicReplays: row.public_replays_enabled,
      };
      const after: PublicVisibility = {
        publicSpectate: patch.publicSpectateEnabled ?? before.publicSpectate,
        publicReplays: patch.publicReplaysEnabled ?? before.publicReplays,
      };
      const changed = after.publicSpectate !== before.publicSpectate || after.publicReplays !== before.publicReplays;
      if (changed) {
        await trx(RUNTIME_SETTINGS_TABLE).where({ id: 1 }).update({
          public_spectate_enabled: after.publicSpectate,
          public_replays_enabled: after.publicReplays,
          updated_at: trx.fn.now(),
          updated_by: ctx.actorId,
        });
        await audit(trx as unknown as Db, {
          actorId: ctx.actorId,
          action: AUDIT_ACTION,
          target: AUDIT_TARGET,
          detail: { before, after },
          correlationId: ctx.correlationId,
        });
      }
      const fresh = (await trx(RUNTIME_SETTINGS_TABLE).where({ id: 1 }).first()) as Row;
      return { before, after, changed, fresh };
    });
    this.apply(result.fresh);
    return { before: result.before, after: result.after, changed: result.changed };
  }
}

/**
 * Normaliza lo que reciben las rutas: un booleano fijo (tests y compatibilidad) o un
 * getter (producción, `RuntimeSettingsStore.getter`).
 */
export function flagSource(
  v: boolean | (() => boolean) | undefined,
  fallback: () => boolean = () => false,
): () => boolean {
  if (typeof v === "function") return v;
  if (typeof v === "boolean") return () => v;
  return fallback;
}

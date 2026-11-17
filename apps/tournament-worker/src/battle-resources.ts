/**
 * OLA2-MF · Recursos temporales de una batalla y su TEARDOWN único.
 *
 * Una batalla no está operacionalmente cerrada hasta que sus recursos temporales
 * han desaparecido. Cada pieza que CREA algo de una batalla (contenedor, host del
 * artefacto, ProtocolServer, temporizador, feed del espectador…) lo REGISTRA aquí
 * con su battleId en el mismo instante en que existe, y la orquestación
 * (battle-runner.ts) llama a `cleanupBattleResources(battleId, reason)` en un
 * `finally`, sea cual sea el final: FINISHED, FAILED, TIMEOUT, CANCELLED,
 * BOT_CRASH, ENGINE_ERROR, WORKER_ERROR, EXCEPTION o MANUAL_ABORT.
 *
 * Propiedades (las fija battle-resources.test.ts, cada una con su mutante):
 *  - ORDEN fijo por fases (PHASES): detener la generación → cancelar trabajos →
 *    TERM a runners y procesos (KILL sólo a quien no responde) → contenedores →
 *    mounts → redes → cgroups → streaming → motor → reap → verificación.
 *  - IDEMPOTENTE: cada recurso se libera una sola vez; una segunda llamada (o una
 *    concurrente) no repite nada ni falla. Un recurso cuya liberación FALLÓ se
 *    conserva y se reintenta en la siguiente llamada (o en el reaper).
 *  - AISLADO: sólo toca lo registrado bajo ESE battleId. Nunca un servicio base
 *    ni otra batalla (no hay operaciones «globales» aquí).
 *  - NUNCA LANZA: devuelve un informe; un fallo de una liberación no impide las
 *    demás (un teardown que se rinde a la primera deja huérfanos).
 *  - ACOTADO (G2 · MF_STOP_BOUNDED_TEARDOWN): ninguna liberación puede colgar el
 *    teardown. Cada una corre con un plazo (`deadlineMs` del recurso o
 *    `releaseDeadlineMs` del registro); si vence, el recurso queda `failed` (se
 *    reintenta) y el teardown sigue. Un `release` colgado jamás bloquea el resto.
 *  - DESPRENDIDO (G2 · MF_LAUNCH_TIMEOUT_CLEANUP): un recurso que todavía NO
 *    existe (un lanzamiento en vuelo sin respuesta) no se marca `failed` sin
 *    fin: su `release` devuelve `"detached"`, el registro lo suelta (paso
 *    `detached`, `stats.detached`) y el informe NO es «limpio». Quien lo
 *    desprende se compromete a limpiar el recurso si llega a existir.
 *
 * `scope` permite a una capa interna (containerAgents, el ejecutor) limpiar SÓLO
 * lo suyo con la MISMA función, sin tocar lo que registró la orquestación (el
 * lease vivo hasta finishBattle). La llamada SIN scope lo limpia todo.
 *
 * Drenaje: el feed del espectador, en un final FINISHED, debe seguir vivo el
 * retardo anti-coaching para entregar el resultado. Se registra con `drainMs`: en
 * FINISHED su liberación se PROGRAMA (temporizador seguido, también un recurso) y
 * el informe lo cuenta como `draining`; en cualquier otro final se libera ya.
 */

export const BATTLE_END_REASONS = [
  "FINISHED",
  "FAILED",
  "TIMEOUT",
  "CANCELLED",
  "BOT_CRASH",
  "ENGINE_ERROR",
  "WORKER_ERROR",
  "EXCEPTION",
  "MANUAL_ABORT",
] as const;
export type BattleEndReason = (typeof BATTLE_END_REASONS)[number];

/** Fases del teardown, en el orden en que se ejecutan. */
export const PHASES = [
  "stop_generation",
  "cancel_jobs",
  "terminate",
  "containers",
  "mounts",
  "networks",
  "cgroups",
  "streaming",
  "engine",
  "reap",
] as const;
export type ResourcePhase = (typeof PHASES)[number];

export interface ResourceSpec {
  /** Tipo legible (`container`, `sandbox_host`, `timer:cpu_sampler`…). Se informa. */
  kind: string;
  phase: ResourcePhase;
  /**
   * Libera el recurso. Debe tolerar que ya no exista. Devuelve `"detached"` si el
   * recurso aún no existe y su dueño se encarga de él si llega (ver «DESPRENDIDO»).
   */
  release: () => Promise<void | "detached"> | void | "detached";
  /** Plazo de ESTA liberación (ms). Def. `releaseDeadlineMs` del registro. */
  deadlineMs?: number;
  /** Capa que lo registró (`agents`, `executor`, `runner`). */
  scope?: string;
  /** Sólo en FINISHED: se libera pasado este plazo (ver «Drenaje»). */
  drainMs?: number;
}

interface Entry extends ResourceSpec {
  id: number;
  battleId: string;
  state: "live" | "releasing" | "draining" | "failed";
  drainTimer?: ReturnType<typeof setTimeout>;
  lastError?: string;
}

export interface CleanupStep {
  id: number;
  kind: string;
  phase: ResourcePhase;
  outcome: "released" | "failed" | "draining" | "detached";
  error?: string;
}

export interface CleanupReport {
  battleId: string;
  reason: BattleEndReason;
  scope: string | null;
  steps: CleanupStep[];
  /** Recursos que siguen registrados tras el teardown (excluidos los drenando). */
  remaining: { kind: string; phase: ResourcePhase; state: string }[];
  draining: number;
  /** Recursos desprendidos en ESTE teardown (lanzamientos sin respuesta): no es «limpio». */
  detached: number;
  /** Lo que devolvió la verificación externa (p. ej. contenedores que aún lista el proxy). */
  externalLeftovers: string[];
  /** true ⇔ no queda NADA de esa batalla (ni registrado, ni desprendido, ni fuera), salvo drenajes. */
  clean: boolean;
}

export interface CleanupOptions {
  scope?: string;
  /** Libera YA también lo que está drenando (p. ej. antes de reintentar la batalla). */
  flushDrains?: boolean;
}

/** Verificación externa: ids de lo que AÚN existe de esa batalla fuera del proceso. */
export type ExternalVerifier = (battleId: string) => Promise<string[]>;

export class BattleAbort extends Error {
  constructor(
    readonly reason: Extract<BattleEndReason, "MANUAL_ABORT" | "WORKER_ERROR" | "CANCELLED">,
    detail = "",
  ) {
    super(`[battle_aborted:${reason}] ${detail}`.trim());
    this.name = "BattleAbort";
  }
}

/** Plazo por defecto de UNA liberación (ms): un `release` colgado nunca cuelga el teardown. */
export const DEFAULT_RELEASE_DEADLINE_MS = 60_000;

/**
 * Plazo de la verificación externa del teardown completo (ms). En producción es
 * `runner.list()` contra el docker-proxy: si el proxy cuelga, también cuelga la lista, y
 * sin plazo colgaba el trabajo de la batalla, el siguiente teardown de esa batalla
 * (serializado por battleId) y el reaper (en serie). G2 · ronda 2 · P2-1.
 */
export const DEFAULT_VERIFY_DEADLINE_MS = 10_000;

export interface RegistryOptions {
  /** Plazo por defecto de cada liberación (ms). Def. DEFAULT_RELEASE_DEADLINE_MS. */
  releaseDeadlineMs?: number;
  /** Plazo de la verificación externa (ms). Def. DEFAULT_VERIFY_DEADLINE_MS. */
  verifyDeadlineMs?: number;
}

export class BattleResourceRegistry {
  private seq = 0;
  private readonly releaseDeadlineMs: number;
  private readonly verifyDeadlineMs: number;
  private readonly entries = new Map<string, Map<number, Entry>>();
  private readonly aborters = new Map<string, Set<AbortController>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private verifier: ExternalVerifier | undefined;
  /** Desprendimientos de una batalla aún no informados en un teardown COMPLETO (sin scope). */
  private readonly detachedOf = new Map<string, number>();
  /**
   * Batallas cuyo último teardown COMPLETO no pudo verificarse fuera del proceso (el
   * verificador venció su plazo o lanzó). El reaper las repasa (`retryIds()`) hasta que
   * una verificación conteste.
   */
  private readonly unverified = new Set<string>();
  /** Cuántas veces se ha ejecutado una liberación (observabilidad y tests). */
  readonly stats = {
    releases: 0,
    failures: 0,
    cleanups: 0,
    detached: 0,
    deadlineExpired: 0,
    verifyExpired: 0,
  };

  constructor(opts: RegistryOptions = {}) {
    this.releaseDeadlineMs = opts.releaseDeadlineMs ?? DEFAULT_RELEASE_DEADLINE_MS;
    this.verifyDeadlineMs = opts.verifyDeadlineMs ?? DEFAULT_VERIFY_DEADLINE_MS;
  }

  /** Fija la verificación externa (contenedores que aún existen para ese battleId). */
  setVerifier(v: ExternalVerifier | undefined): void {
    this.verifier = v;
  }

  /** Registra un recurso. Devuelve `forget()`: lo da por liberado por su dueño (sin ejecutar release). */
  register(battleId: string, spec: ResourceSpec): () => void {
    const id = ++this.seq;
    let bucket = this.entries.get(battleId);
    if (!bucket) this.entries.set(battleId, (bucket = new Map()));
    bucket.set(id, { ...spec, id, battleId, state: "live" });
    return () => {
      const b = this.entries.get(battleId);
      const e = b?.get(id);
      if (!e) return;
      if (e.drainTimer) clearTimeout(e.drainTimer);
      b!.delete(id);
      if (b!.size === 0) this.entries.delete(battleId);
    };
  }

  /** Temporizador de la batalla, registrado: `cancel_jobs` lo cancela si su dueño no lo hizo. */
  registerTimer(battleId: string, kind: string, handle: ReturnType<typeof setTimeout>, scope?: string): () => void {
    return this.register(battleId, {
      kind: `timer:${kind}`,
      phase: "stop_generation",
      scope,
      release: () => {
        clearTimeout(handle);
        clearInterval(handle);
      },
    });
  }

  /** Controlador de aborto de la batalla en curso (para MANUAL_ABORT / WORKER_ERROR). */
  registerAborter(battleId: string, c: AbortController): () => void {
    let set = this.aborters.get(battleId);
    if (!set) this.aborters.set(battleId, (set = new Set()));
    set.add(c);
    return () => {
      const s = this.aborters.get(battleId);
      s?.delete(c);
      if (s && s.size === 0) this.aborters.delete(battleId);
    };
  }

  /** ¿Hay una ejecución viva de esa batalla en este proceso? */
  isActive(battleId: string): boolean {
    return (this.aborters.get(battleId)?.size ?? 0) > 0;
  }

  /** Aborta la ejecución viva de UNA batalla. Devuelve false si no había ninguna. */
  abortBattle(battleId: string, reason: BattleAbort["reason"], detail = ""): boolean {
    const set = this.aborters.get(battleId);
    if (!set || set.size === 0) return false;
    for (const c of set) if (!c.signal.aborted) c.abort(new BattleAbort(reason, detail));
    return true;
  }

  /** Aborta TODAS las batallas vivas de este proceso (parada del worker). */
  abortAll(reason: BattleAbort["reason"], detail = ""): string[] {
    const ids = [...this.aborters.keys()];
    for (const id of ids) this.abortBattle(id, reason, detail);
    return ids;
  }

  /** battleIds con algo registrado (vivo, drenando o fallido). */
  battleIds(): string[] {
    return [...this.entries.keys()];
  }

  /** battleIds que el reaper debe repasar: con algo registrado o sin verificación externa. */
  retryIds(): string[] {
    return [...new Set([...this.entries.keys(), ...this.unverified])];
  }

  /** ¿El último teardown completo de esa batalla quedó sin verificar fuera del proceso? */
  isUnverified(battleId: string): boolean {
    return this.unverified.has(battleId);
  }

  /** Lo registrado de una batalla (para diagnóstico, tests y gates). */
  pending(
    battleId: string,
  ): { kind: string; phase: ResourcePhase; state: string; scope?: string; deadlineMs: number }[] {
    return [...(this.entries.get(battleId)?.values() ?? [])].map((e) => ({
      kind: e.kind,
      phase: e.phase,
      state: e.state,
      scope: e.scope,
      // Plazo EFECTIVO de su liberación (el del recurso o el del registro).
      deadlineMs: e.deadlineMs ?? this.releaseDeadlineMs,
    }));
  }

  /** Total de recursos registrados en el proceso (gate ORPHAN_*: 0 en idle). */
  totalPending(opts: { includeDraining?: boolean } = {}): number {
    let n = 0;
    for (const b of this.entries.values())
      for (const e of b.values()) if (opts.includeDraining || e.state !== "draining") n++;
    return n;
  }

  /** Libera YA lo que esté drenando de esa batalla (antes de un nuevo intento). */
  async flushDraining(battleId: string): Promise<void> {
    const b = this.entries.get(battleId);
    if (!b) return;
    const draining = [...b.values()].filter((e) => e.state === "draining");
    for (const e of draining) {
      if (e.drainTimer) clearTimeout(e.drainTimer);
      e.drainTimer = undefined;
      await this.releaseEntry(e);
    }
  }

  /**
   * EL teardown. Idempotente y serializado por battleId: una llamada concurrente
   * espera a la que está en curso y después repasa lo que quede.
   */
  async cleanupBattleResources(
    battleId: string,
    reason: BattleEndReason,
    opts: CleanupOptions = {},
  ): Promise<CleanupReport> {
    const prev = this.inflight.get(battleId);
    const run = (async () => {
      if (prev) await prev.catch(() => undefined);
      return this.doCleanup(battleId, reason, opts);
    })();
    this.inflight.set(battleId, run);
    try {
      return await run;
    } finally {
      if (this.inflight.get(battleId) === run) this.inflight.delete(battleId);
    }
  }

  private async releaseEntry(e: Entry): Promise<CleanupStep> {
    e.state = "releasing";
    this.stats.releases++;
    const deadlineMs = e.deadlineMs ?? this.releaseDeadlineMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // G2 · acotado: la liberación compite con su plazo; si vence, `failed` y se sigue.
      const out = await Promise.race([
        Promise.resolve().then(() => e.release()),
        new Promise<never>((_r, rej) => {
          timer = setTimeout(() => {
            this.stats.deadlineExpired++;
            rej(new Error(`liberación sin respuesta en ${deadlineMs} ms`));
          }, deadlineMs);
          timer.unref?.();
        }),
      ]);
      const b = this.entries.get(e.battleId);
      b?.delete(e.id);
      if (b && b.size === 0) this.entries.delete(e.battleId);
      if (out === "detached") {
        this.stats.detached++;
        this.detachedOf.set(e.battleId, (this.detachedOf.get(e.battleId) ?? 0) + 1);
        return { id: e.id, kind: e.kind, phase: e.phase, outcome: "detached" };
      }
      return { id: e.id, kind: e.kind, phase: e.phase, outcome: "released" };
    } catch (err) {
      this.stats.failures++;
      e.state = "failed";
      e.lastError = err instanceof Error ? err.message : String(err);
      return { id: e.id, kind: e.kind, phase: e.phase, outcome: "failed", error: e.lastError };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async doCleanup(battleId: string, reason: BattleEndReason, opts: CleanupOptions): Promise<CleanupReport> {
    this.stats.cleanups++;
    const scope = opts.scope ?? null;
    const steps: CleanupStep[] = [];
    const inScope = (e: Entry) => scope === null || e.scope === scope;

    for (const phase of PHASES) {
      const bucket = this.entries.get(battleId);
      if (!bucket) break;
      const due = [...bucket.values()].filter(
        (e) => e.phase === phase && inScope(e) && (e.state === "live" || e.state === "failed"),
      );
      const now: Entry[] = [];
      for (const e of due) {
        if (e.drainMs && e.drainMs > 0 && reason === "FINISHED" && !opts.flushDrains) {
          e.state = "draining";
          e.drainTimer = setTimeout(() => {
            e.drainTimer = undefined;
            void this.releaseEntry(e);
          }, e.drainMs);
          e.drainTimer.unref?.();
          steps.push({ id: e.id, kind: e.kind, phase, outcome: "draining" });
        } else {
          now.push(e);
        }
      }
      // Dentro de una fase, en paralelo (contenedores distintos no se esperan entre sí).
      steps.push(...(await Promise.all(now.map((e) => this.releaseEntry(e)))));
    }
    if (opts.flushDrains) {
      const b = this.entries.get(battleId);
      for (const e of [...(b?.values() ?? [])].filter((x) => x.state === "draining" && inScope(x))) {
        if (e.drainTimer) clearTimeout(e.drainTimer);
        e.drainTimer = undefined;
        steps.push(await this.releaseEntry(e));
      }
    }

    // Verificación: nada registrado (salvo drenajes) y nada fuera del proceso.
    const left = [...(this.entries.get(battleId)?.values() ?? [])].filter(inScope);
    const remaining = left
      .filter((e) => e.state !== "draining")
      .map((e) => ({ kind: e.kind, phase: e.phase, state: e.state }));
    const draining = left.filter((e) => e.state === "draining").length;
    // Un teardown COMPLETO (sin scope) informa también lo desprendido por una capa interna
    // (containerAgents) de ESA batalla: la orquestación no puede llamar «limpio» a eso.
    let detached = steps.filter((x) => x.outcome === "detached").length;
    if (scope === null) {
      detached = Math.max(detached, this.detachedOf.get(battleId) ?? 0);
      this.detachedOf.delete(battleId);
    }
    let externalLeftovers: string[] = [];
    if (scope === null && this.verifier) {
      const verifier = this.verifier;
      try {
        // G2 · ronda 2 (P2-1): la verificación externa también compite con su plazo. Si vence
        // o lanza, el teardown NO es limpio y la batalla queda marcada para que el reaper
        // la vuelva a verificar; nunca se espera sin cota.
        externalLeftovers = await withinDeadline(
          Promise.resolve().then(() => verifier(battleId)),
          this.verifyDeadlineMs,
          "verificación externa",
        );
        this.unverified.delete(battleId);
      } catch (err) {
        this.unverified.add(battleId);
        if (err instanceof StopUnresponsiveError) {
          this.stats.verifyExpired++;
          externalLeftovers = [`verificación externa sin respuesta en ${this.verifyDeadlineMs} ms`];
        } else {
          externalLeftovers = [
            `verificación externa no disponible: ${err instanceof Error ? err.message : String(err)}`,
          ];
        }
      }
    }
    return {
      battleId,
      reason,
      scope,
      steps,
      remaining,
      draining,
      detached,
      externalLeftovers,
      clean: remaining.length === 0 && detached === 0 && externalLeftovers.length === 0,
    };
  }
}

/** Registro del proceso (producción). Los tests crean el suyo. */
export const defaultBattleResources = new BattleResourceRegistry();

/** El runner no contestó a la parada de un contenedor en su plazo (G2 · teardown acotado). */
export class StopUnresponsiveError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} sin respuesta del runner en ${ms} ms`);
    this.name = "StopUnresponsiveError";
  }
}

/** `p` o rechazo con StopUnresponsiveError al vencer `ms` (el temporizador nunca retiene el proceso). */
export async function withinDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_r, rej) => {
        timer = setTimeout(() => rej(new StopUnresponsiveError(what, ms)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Parada en dos tiempos de UN contenedor: TERM con gracia corta (la Engine manda
 * KILL al vencer `termGraceS`); si tras eso sigue vivo —o el stop no contesta en
 * `stopDeadlineMs`—, KILL inmediato (`t=0`). Nunca KILL de entrada.
 *
 * G2 · MF_STOP_BOUNDED_TEARDOWN: TODA espera está acotada. El TERM por
 * `stopDeadlineMs`, la consulta de estado por `stateDeadlineMs` (sin respuesta =
 * estado desconocido) y el KILL por `killDeadlineMs`: si el KILL tampoco contesta
 * se RECHAZA con `StopUnresponsiveError` (el recurso queda `failed` y el borrado
 * forzado o el reaper lo terminan). Cota total: stop + estado + kill.
 */
export async function terminateContainer(
  h: {
    stop(o?: { timeoutSeconds?: number }): Promise<void>;
    state?(): Promise<{ running: boolean; gone: boolean } | null>;
  },
  opts: { termGraceS?: number; stopDeadlineMs?: number; killDeadlineMs?: number; stateDeadlineMs?: number } = {},
): Promise<"terminated" | "killed"> {
  const grace = opts.termGraceS ?? 5;
  const deadline = opts.stopDeadlineMs ?? (grace + 5) * 1000;
  const killDeadline = opts.killDeadlineMs ?? DEFAULT_KILL_DEADLINE_MS;
  const stateDeadline = opts.stateDeadlineMs ?? DEFAULT_STATE_DEADLINE_MS;
  const timedOut = await withinDeadline(
    h.stop({ timeoutSeconds: grace }).then(
      () => false,
      () => false,
    ),
    deadline,
    "stop(TERM)",
  ).catch(() => true);
  let alive = timedOut;
  if (!alive && h.state) {
    const st = await withinDeadline(h.state(), stateDeadline, "state()").catch(() => null);
    alive = !!st && st.running && !st.gone;
  }
  if (!alive) return "terminated";
  await withinDeadline(h.stop({ timeoutSeconds: 0 }), killDeadline, "stop(KILL)");
  return "killed";
}

/** Plazo del KILL (`stop` con t=0) en el teardown. */
export const DEFAULT_KILL_DEADLINE_MS = 5_000;
/** Plazo de una consulta de estado del contenedor en el teardown. */
export const DEFAULT_STATE_DEADLINE_MS = 2_000;

/** Clasifica el final de una batalla a partir de lo que pasó en la orquestación. */
export function classifyEnd(input: { ok: boolean; error?: unknown; abortReason?: unknown }): BattleEndReason {
  if (input.abortReason instanceof BattleAbort) return input.abortReason.reason;
  if (input.abortReason !== undefined && input.abortReason !== null) return "CANCELLED";
  if (input.ok) return "FINISHED";
  const err = input.error as { name?: string; code?: string; message?: string } | undefined;
  if (err?.name === "BattleAbort") return (err as BattleAbort).reason;
  if (err?.name === "SportingFailure") return err.code === "bot_timeout" ? "TIMEOUT" : "BOT_CRASH";
  if (err?.name === "InfrastructureFailure") {
    if (err.code === "battle_busy") return "CANCELLED";
    if (err.code === "battle_aborted") return "MANUAL_ABORT";
    if (/timeout global/.test(String(err.message))) return "TIMEOUT";
    if (err.code === "engine_start_failure") return "ENGINE_ERROR";
    return "FAILED";
  }
  if (err?.name === "LostBattleClaim") return "CANCELLED";
  return "EXCEPTION";
}

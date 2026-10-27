/**
 * PRC · TD-034 — dos relojes para arrancar un bot en el sandbox.
 *
 * Antes, el arranque del bot se juzgaba con UN solo reloj de pared desde
 * `State.StartedAt` hasta el HELLO (≤ maxStartupMs = 5000 ms). Ese tramo incluye
 * trabajo de la PLATAFORMA (arranque del intérprete, descarga y verificación del
 * artefacto, carga del SDK) que bajo carga del host o con Docker lento se come el
 * presupuesto del bot: un bot válido quedaba `rejected` según la carga (TD-034).
 *
 * Ahora hay dos relojes, separados por una señal REAL del bootstrap (`ready`,
 * POST al SandboxHost justo antes de importar el código del usuario):
 *
 *   SANDBOX_STARTUP_TIMEOUT_MS (def. 30000) — reloj de PLATAFORMA.
 *     Desde la petición de lanzamiento del contenedor hasta `ready`: create,
 *     start, init del runtime, descarga + sha256 + materialización del artefacto
 *     y carga del SDK. Excederlo es INFRAESTRUCTURA (nunca culpa del bot).
 *
 *   BOT_EXECUTION_TIMEOUT_MS (def. 5000) — reloj del BOT.
 *     Empieza en `ready` (nunca antes) y cubre lo que ejecuta el código del
 *     usuario hasta estar en juego: import de su módulo, constructor, conexión
 *     WebSocket y HELLO. Excederlo es culpa del BOT. Tras el HELLO las decisiones
 *     siguen bajo sus límites de siempre (deadline del protocolo y maxDecisionMs).
 *
 * Clasificación (SAN-9): un fallo ANTES de `ready` (contenedor que no arranca,
 * runtime/SDK ausente, artefacto no descargable o corrupto, Docker lento) es de
 * la plataforma; uno DESPUÉS (excepción al importar, salida del proceso, cuelgue)
 * es del bot. Los informes del bootstrap con `kind` conocido mandan sobre la fase.
 */
import type { ContainerHandle, ContainerRunState, ContainerRunner, SandboxSpec } from "./container-runner.js";

export interface StartupTimeouts {
  /** Plazo de PLATAFORMA: lanzamiento → señal `ready` del bootstrap. */
  sandboxStartupMs: number;
  /** Plazo del BOT: señal `ready` → HELLO. */
  botExecutionMs: number;
}

export const DEFAULT_STARTUP_TIMEOUTS: Readonly<StartupTimeouts> = Object.freeze({
  sandboxStartupMs: 30_000,
  botExecutionMs: 5_000,
});

/** Techo de cordura de ambos plazos (10 min): un valor mayor es un error de configuración. */
export const MAX_STARTUP_TIMEOUT_MS = 600_000;

function parseTimeoutMs(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) throw new Error(`${name} debe ser un entero de milisegundos (recibido ${JSON.stringify(raw)})`);
  const n = Number(s);
  if (n <= 0 || n > MAX_STARTUP_TIMEOUT_MS) {
    throw new Error(`${name} fuera de rango: ${n} (1..${MAX_STARTUP_TIMEOUT_MS} ms)`);
  }
  return n;
}

/**
 * Parser ÚNICO de los dos plazos (build y batalla). Vacío o ausente = defecto;
 * cualquier otra cosa que no sea un entero en rango hace fallar el arranque del
 * servicio (ruidoso): un plazo mal escrito no se sustituye en silencio.
 */
export function startupTimeoutsFromEnv(env: NodeJS.ProcessEnv = process.env): StartupTimeouts {
  return {
    sandboxStartupMs: parseTimeoutMs(
      env.SANDBOX_STARTUP_TIMEOUT_MS,
      "SANDBOX_STARTUP_TIMEOUT_MS",
      DEFAULT_STARTUP_TIMEOUTS.sandboxStartupMs,
    ),
    botExecutionMs: parseTimeoutMs(
      env.BOT_EXECUTION_TIMEOUT_MS,
      "BOT_EXECUTION_TIMEOUT_MS",
      DEFAULT_STARTUP_TIMEOUTS.botExecutionMs,
    ),
  };
}

/** Informes del bootstrap que son de la PLATAFORMA (ver sandbox-bootstrap/). */
export const PLATFORM_REPORT_KINDS: ReadonlySet<string> = new Set([
  "config",
  "fetch",
  "integrity",
  "materialize",
  "sdk",
]);
/** Informes del bootstrap que son del BOT (su paquete o su código). */
export const BOT_REPORT_KINDS: ReadonlySet<string> = new Set(["manifest", "entry", "import", "runtime", "hook"]);
/**
 * UX-F (DEF-R4) · AVISOS del bootstrap: el bot sigue arrancando. `hook_missing` =
 * versión ya publicada que no implementa el hook, lanzada en batalla con
 * `S9_HOOK_POLICY=warn`. Nunca son un fallo de arranque.
 */
export const WARNING_REPORT_KINDS: ReadonlySet<string> = new Set(["hook_missing"]);

export type StartupFault = "infrastructure" | "bot";
export type StartupFailureReason =
  /** la plataforma no llegó a `ready` en SANDBOX_STARTUP_TIMEOUT_MS */
  | "sandbox_start_timeout"
  /** la plataforma falló antes de `ready` (bootstrap/runtime/contenedor) */
  | "sandbox_start_failed"
  /** el código del bot no llegó al HELLO en BOT_EXECUTION_TIMEOUT_MS desde `ready` */
  | "bot_execution_timeout"
  /** el código del bot falló (excepción al importar, salida del proceso) */
  | "bot_crash";

/** Instantes observados por el anfitrión (performance.now() del proceso del motor). */
export interface StartupTimeline {
  launchRequestedAt: number;
  launchedAt?: number;
  artifactFetchedAt?: number;
  readyAt?: number;
  helloAt?: number;
}

export type StartupResult =
  | { ok: true; timeline: StartupTimeline & { readyAt: number; helloAt: number }; readyLost: boolean }
  | {
      ok: false;
      fault: StartupFault;
      reason: StartupFailureReason;
      detail: string;
      timeline: StartupTimeline;
      state: ContainerRunState | null;
      report?: { kind: string; detail: string };
    };

/** Señales del bootstrap de UNA sesión (las expone ArtifactOffer). */
export interface BootstrapSignals {
  fetchedAt(): number | null;
  readyAt(): number | null;
  failure(): { kind: string; detail: string } | null;
  /** UX-F (DEF-R4) · avisos (WARNING_REPORT_KINDS) que no paran el arranque. */
  warnings?(): readonly { kind: string; detail: string }[];
  /** Avisa ante cualquier señal nueva; devuelve la función para desuscribirse. */
  onChange(cb: () => void): () => void;
}

export interface AwaitAgentReadyInput {
  timeouts: StartupTimeouts;
  /** Instante (perf) en que se PIDIÓ el contenedor: arranca el reloj de plataforma. */
  launchRequestedAt: number;
  launchedAt?: number;
  signals: BootstrapSignals;
  /** HELLO aceptado por el ProtocolServer para este bot (perf), o null. */
  helloAt(): number | null;
  /** Suscripción a HELLOs (para no esperar al siguiente sondeo). */
  onHello(cb: () => void): () => void;
  /** Estado real del contenedor (inspect); opcional. */
  containerState?: () => Promise<ContainerRunState | null>;
  /** Cada cuánto se consulta el estado del contenedor. Def. 250 ms. */
  pollMs?: number;
  /** Margen para que llegue el informe del bootstrap tras ver el contenedor muerto. Def. 300 ms. */
  reportGraceMs?: number;
  now?: () => number;
}

/**
 * ¿De quién es un informe del bootstrap? Tras `ready` ya corre código del
 * usuario, que ve ARTIFACT_URL/ARTIFACT_TOKEN en su entorno y podría FALSEAR un
 * informe de plataforma (p. ej. `fetch`) para convertir su fallo en
 * «infraestructura» (reintentos, batalla que nunca se juega). Por eso, tras
 * `ready`, todo informe es del bot; antes, manda el `kind`.
 */
export function classifyReport(kind: string, afterReady: boolean): StartupFault {
  if (afterReady) return "bot";
  if (BOT_REPORT_KINDS.has(kind)) return "bot";
  return "infrastructure";
}

/**
 * Espera a que el agente esté en juego (HELLO) aplicando los DOS relojes. Nunca
 * duerme a ciegas: despierta con cada señal (ready, informe, HELLO) y sondea el
 * estado real del contenedor para detectar una salida temprana.
 */
export async function awaitAgentReady(i: AwaitAgentReadyInput): Promise<StartupResult> {
  const now = i.now ?? (() => performance.now());
  const pollMs = i.pollMs ?? 250;
  const timeline: StartupTimeline = { launchRequestedAt: i.launchRequestedAt, launchedAt: i.launchedAt };
  let wake: (() => void) | null = null;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const unsubs = [i.signals.onChange(poke), i.onHello(poke)];
  let lastState: ContainerRunState | null = null;
  let nextPoll = now();
  const fill = () => {
    const f = i.signals.fetchedAt();
    if (f !== null) timeline.artifactFetchedAt = f;
    const r = i.signals.readyAt();
    if (r !== null) timeline.readyAt = r;
    const h = i.helloAt();
    if (h !== null) timeline.helloAt = h;
  };
  const fail = (
    fault: StartupFault,
    reason: StartupFailureReason,
    detail: string,
    report?: { kind: string; detail: string },
  ): StartupResult => ({ ok: false, fault, reason, detail, timeline, state: lastState, ...(report ? { report } : {}) });

  try {
    for (;;) {
      fill();
      if (timeline.helloAt !== undefined) {
        // `ready` perdido (el POST del bootstrap no llegó): el HELLO prueba que
        // el agente estaba listo; el reloj del bot no se puede medir aparte.
        const readyLost = timeline.readyAt === undefined;
        const readyAt = timeline.readyAt ?? timeline.helloAt;
        return { ok: true, timeline: { ...timeline, readyAt, helloAt: timeline.helloAt }, readyLost };
      }
      const afterReady = timeline.readyAt !== undefined;
      const report = i.signals.failure();
      if (report) {
        const fault = classifyReport(report.kind, afterReady);
        return fail(
          fault,
          fault === "bot" ? "bot_crash" : "sandbox_start_failed",
          `${report.kind}: ${report.detail.trim().split("\n").slice(-3).join(" | ")}`,
          report,
        );
      }
      const t = now();
      if (i.containerState && t >= nextPoll) {
        nextPoll = t + pollMs;
        const st = await i.containerState().catch(() => null);
        if (st) lastState = st;
        if (st && !st.running) {
          // El bootstrap informa ANTES de salir; se le da un instante por si el
          // POST aún viaja, y se reevalúa (el informe manda sobre la fase).
          await new Promise((r) => setTimeout(r, i.reportGraceMs ?? 300));
          fill();
          const late = i.signals.failure();
          if (late) continue;
          if (timeline.helloAt !== undefined) continue;
          const exit = `${st.gone ? "el contenedor terminó" : `el proceso salió con código ${st.exitCode}`}${st.oomKilled ? " (OOM)" : ""}`;
          return timeline.readyAt !== undefined
            ? fail("bot", "bot_crash", `${exit} después de que el agente estuviera listo`)
            : fail("infrastructure", "sandbox_start_failed", `${exit} antes de que el agente estuviera listo`);
        }
      }
      const t2 = now();
      let deadline: number;
      if (timeline.readyAt === undefined) {
        deadline = i.launchRequestedAt + i.timeouts.sandboxStartupMs;
        if (t2 >= deadline) {
          return fail(
            "infrastructure",
            "sandbox_start_timeout",
            `la plataforma no dejó listo el agente en ${i.timeouts.sandboxStartupMs} ms (SANDBOX_STARTUP_TIMEOUT_MS)`,
          );
        }
      } else {
        deadline = timeline.readyAt + i.timeouts.botExecutionMs;
        if (t2 >= deadline) {
          return fail(
            "bot",
            "bot_execution_timeout",
            `el código del bot no completó el HELLO en ${i.timeouts.botExecutionMs} ms desde que el agente estuvo listo (BOT_EXECUTION_TIMEOUT_MS)`,
          );
        }
      }
      const waitMs = Math.max(1, Math.min(deadline - t2, i.containerState ? nextPoll - t2 : deadline - t2));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, waitMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    for (const u of unsubs) u();
  }
}

/** Métricas del arranque (ms) para builds.stages[].metrics y los mensajes. */
export function startupMetrics(tl: StartupTimeline, timeouts: StartupTimeouts): Record<string, number> {
  const m: Record<string, number> = {
    sandboxStartupTimeoutMs: timeouts.sandboxStartupMs,
    botExecutionTimeoutMs: timeouts.botExecutionMs,
  };
  if (tl.launchedAt !== undefined) m.launchMs = tl.launchedAt - tl.launchRequestedAt;
  if (tl.artifactFetchedAt !== undefined) m.artifactFetchMs = tl.artifactFetchedAt - tl.launchRequestedAt;
  if (tl.readyAt !== undefined) m.startupMs = tl.readyAt - tl.launchRequestedAt;
  if (tl.readyAt !== undefined && tl.helloAt !== undefined) m.botReadyToHelloMs = tl.helloAt - tl.readyAt;
  return m;
}

/** El lanzamiento (create+start en la Engine) no terminó o falló: siempre plataforma. */
export class SandboxLaunchError extends Error {
  constructor(
    readonly reason: "sandbox_start_timeout" | "sandbox_start_failed",
    message: string,
  ) {
    super(message);
    this.name = "SandboxLaunchError";
  }
}

/**
 * Lanza el contenedor DENTRO del reloj de plataforma: si la Engine no lo crea y
 * arranca antes de `launchRequestedAt + sandboxStartupMs`, se abandona la espera
 * (SandboxLaunchError `sandbox_start_timeout`) y, si el contenedor aparece tarde,
 * se para en cuanto llega para no dejar restos.
 */
export async function launchWithinStartup(
  runner: ContainerRunner,
  spec: SandboxSpec,
  timeouts: StartupTimeouts,
  launchRequestedAt: number,
  now: () => number = () => performance.now(),
): Promise<ContainerHandle> {
  const budget = Math.max(0, launchRequestedAt + timeouts.sandboxStartupMs - now());
  const launching = runner.launch(spec);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    launching.then(
      (h) => ({ kind: "ok" as const, h }),
      (e: unknown) => ({ kind: "error" as const, e }),
    ),
    new Promise<{ kind: "timeout" }>((r) => {
      timer = setTimeout(() => r({ kind: "timeout" }), budget);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome.kind === "ok") return outcome.h;
  if (outcome.kind === "timeout") {
    launching.then((h) => h.stop()).catch(() => undefined);
    throw new SandboxLaunchError(
      "sandbox_start_timeout",
      `Docker no creó/arrancó el contenedor en ${timeouts.sandboxStartupMs} ms (SANDBOX_STARTUP_TIMEOUT_MS)`,
    );
  }
  throw new SandboxLaunchError(
    "sandbox_start_failed",
    outcome.e instanceof Error ? outcome.e.message : String(outcome.e),
  );
}

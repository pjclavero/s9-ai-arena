/**
 * E6 · bot-manager — límites y allowlists configurables (E6.M).
 *
 * El dosier (E6.M) fija como valores iniciales 10 MB de fuente y 200 MB de artefacto,
 * y deja explícito que son CONFIGURABLES. Nada aquí es una constante escondida: todo
 * el pipeline recibe un PipelineConfig y estos son solo los valores por defecto.
 *
 * Las allowlists de paquetes por runtime son la contrapartida del "proxy de
 * dependencias con allowlist" del cap. 18.2 (concretado en E6.M). Añadir un paquete
 * es un cambio de código revisado (issue + revisión de seguridad, ver runtimes/).
 */
import type { Runtime } from "./types.js";

export interface ResourceLimits {
  /** Milisegundos de CPU por decisión permitidos antes de marcar exceso. */
  maxDecisionMs: number;
  /** Bytes de RAM incrementales permitidos durante la partida de humo. */
  maxHeapBytes: number;
  /** Milisegundos de arranque permitidos (deadline de arranque). */
  maxStartupMs: number;
}

/**
 * Política ante builtins peligrosos de la stdlib (H1, issue #5).
 *
 * "block" (por defecto): un import de estos módulos RECHAZA el bot en
 * static_analysis, además de registrar el hallazgo de auditoría. El sandbox
 * (T6.2, tabla 18.2) sigue siendo la defensa principal; esto es defensa en
 * profundidad para que un bot hostil de solo-stdlib no llegue a `validated`
 * mientras el sandbox no esté verificado en vivo.
 * "audit": comportamiento anterior — solo hallazgo, sin bloquear.
 */
export interface DangerousBuiltinsPolicy {
  /** Módulos de stdlib/builtin peligrosos por runtime (red, procesos, FS crudo…). */
  modules: Record<Runtime, Set<string>>;
  mode: "block" | "audit";
}

export interface PipelineConfig {
  /** Tamaño máximo del código fuente subido, en bytes. */
  maxSourceBytes: number;
  /** Tamaño máximo del artefacto empaquetado, en bytes. */
  maxArtifactBytes: number;
  /** Número máximo de ficheros en el paquete. */
  maxFileCount: number;
  /** Paquetes permitidos por runtime (allowlist explícita). */
  allowedPackages: Record<Runtime, Set<string>>;
  /** Nombres de fichero de lockfile aceptados por runtime (obligatorio). */
  lockfileNames: Record<Runtime, string[]>;
  /** Builtins peligrosos y política aplicada (H1: bloqueante por defecto). */
  dangerousBuiltins: DangerousBuiltinsPolicy;
  limits: ResourceLimits;
  /** Ticks de la partida de humo. */
  smokeBattleTicks: number;
}

/** Allowlist Python del MVP (ver runtimes/python/ALLOWED-PACKAGES.md). */
export const DEFAULT_PYTHON_ALLOWLIST = new Set([
  "arena-sdk",
  "numpy",
  // R6.1: es "websocket-client", NO "websockets" (son paquetes DISTINTOS). El SDK
  // (sdks/python/arena_sdk/bot.py) hace `import websocket`, que lo aporta
  // websocket-client; el pyproject del SDK declara websocket-client>=1.7,<2. La
  // allowlist pedia "websockets", que ni el SDK usa ni el runtime instala.
  "websocket-client",
]);

/** Allowlist Node del MVP (ver runtimes/node/ALLOWED-PACKAGES.md). */
export const DEFAULT_NODE_ALLOWLIST = new Set([
  "@arena/sdk",
  "ws",
]);

/** Builtins peligrosos de la stdlib de Python: red, procesos, FFI (H1, issue #5). */
export const DEFAULT_PYTHON_DANGEROUS = new Set([
  "socket", "subprocess", "ctypes", "multiprocessing", "asyncio",
]);

/** Builtins peligrosos de Node: red, procesos, FS crudo (H1, issue #5). */
export const DEFAULT_NODE_DANGEROUS = new Set([
  "child_process", "net", "http", "https", "dgram", "cluster",
  "worker_threads", "fs", "dns", "tls", "vm", "os", "crypto",
]);

export const DEFAULT_CONFIG: PipelineConfig = {
  maxSourceBytes: 10 * 1024 * 1024, // 10 MB (E6.M)
  maxArtifactBytes: 200 * 1024 * 1024, // 200 MB (E6.M)
  maxFileCount: 500,
  allowedPackages: {
    python: DEFAULT_PYTHON_ALLOWLIST,
    node: DEFAULT_NODE_ALLOWLIST,
  },
  lockfileNames: {
    python: ["requirements.lock", "poetry.lock"],
    node: ["package-lock.json", "pnpm-lock.yaml"],
  },
  dangerousBuiltins: {
    modules: {
      python: DEFAULT_PYTHON_DANGEROUS,
      node: DEFAULT_NODE_DANGEROUS,
    },
    mode: "block", // H1 (issue #5): bloqueante por defecto; "audit" = solo hallazgo
  },
  limits: {
    maxDecisionMs: 100, // ventana de decisión del protocolo arena/1
    maxHeapBytes: 256 * 1024 * 1024,
    maxStartupMs: 5000,
  },
  smokeBattleTicks: 600,
};

export function withConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

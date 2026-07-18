/**
 * E6 · bot-manager — tipos del pipeline de build/publicación (cap. 18.1).
 *
 * Los estados y nombres de etapa NO se inventan: son los del contrato OpenAPI de E1
 * (apps/api/openapi.yaml, schema Build y BotVersion). Ver:
 *   Build.status:        queued | running | passed | failed
 *   Build.stages[].name: structure | static_analysis | dependencies | build |
 *                        protocol_test | smoke_battle | resource_limits |
 *                        secret_scan | sign | publish
 *   Build.stages[].status: pending | running | passed | failed | skipped
 *   BotVersion state:    draft | validating | rejected | validated | published |
 *                        frozen | suspended | retired
 */

/** Estados de un Build (OpenAPI Build.status). */
export type BuildStatus = "queued" | "running" | "passed" | "failed";

/** Nombres de etapa del pipeline en orden (OpenAPI Build.stages[].name). */
export const STAGE_ORDER = [
  "structure",
  "static_analysis",
  "dependencies",
  "build",
  "protocol_test",
  "smoke_battle",
  "resource_limits",
  "secret_scan",
  "sign",
  "publish",
] as const;

export type StageName = (typeof STAGE_ORDER)[number];

export type StageStatus = "pending" | "running" | "passed" | "failed" | "skipped";

/** Estado de una versión de bot (OpenAPI BotVersion.state / cap. 17.1). */
export type BotVersionState =
  "draft" | "validating" | "rejected" | "validated" | "published" | "frozen" | "suspended" | "retired";

export interface StageResult {
  name: StageName;
  status: StageStatus;
  /** Motivo legible (por qué pasó/falló). */
  message?: string;
  /** Logs de la etapa: solo visibles por el dueño / moderador / admin. */
  logs: string[];
  startedAt?: string;
  finishedAt?: string;
  /** Métricas opcionales (p. ej. resource_limits). */
  metrics?: Record<string, number>;
}

export interface Build {
  id: string;
  botId: string;
  version: number;
  /** Dueño del bot (para RBAC de logs). */
  ownerUserId: string;
  status: BuildStatus;
  /** Estado resultante de la versión del bot tras el pipeline. */
  botVersionState: BotVersionState;
  stages: StageResult[];
  /** Hash del artefacto reproducible (sha256), presente si llegó a build. */
  artifactHash?: string;
  /**
   * Bytes canónicos del artefacto empaquetado (R2.5 · ERR-SEC-15): se persisten
   * junto a hash+firma para poder VERIFICAR la firma antes de cada lanzamiento.
   */
  artifactBytes?: Buffer;
  /** Firma del servicio sobre artifactHash (hex), presente si llegó a sign. */
  signature?: string;
  /** Motivo de rechazo si botVersionState === "rejected". */
  rejectionReason?: string;
  correlationId: string;
  createdAt: string;
  finishedAt?: string;
}

/** Un fichero del código fuente subido por el usuario. */
export interface SourceFile {
  /** Ruta relativa POSIX dentro del paquete (p. ej. "src/bot.py"). */
  path: string;
  /** Contenido en texto (los bots MVP son texto: Python/JS). */
  content: string;
}

export type Runtime = "python" | "node";

/** El paquete subido: manifiesto declarado + ficheros. */
export interface BotSubmission {
  botId: string;
  version: number;
  ownerUserId: string;
  /** Runtime declarado en el manifiesto; debe existir en runtimes/. */
  runtime: Runtime;
  /** Arquetipo/loadout con el que correr la partida de humo (ARCHETYPES de E3). */
  archetype: "scout" | "gunner" | "miner" | "heavy";
  files: SourceFile[];
}

/** Interfaz mínima que produce el agente en-proceso para las pruebas de protocolo
 *  y la partida de humo. En producción esto lo sustituye el contenedor conectándose
 *  por WebSocket; aquí lo resuelve un módulo cargable en-proceso (ver reference-bots).*/
export interface CandidateAgentFactory {
  /** Crea un BotAgent para un botId/vehicleId. */
  create(botId: string): { botId: string; decide(observation: unknown): unknown };
}

/**
 * R6.2/R9-B · Ejecución containerizada de batallas — CONTRATO seguro y GATEADO.
 *
 * La API NO habla con Docker ni monta el socket: expone un endpoint que, SOLO si el
 * entorno lo habilita, delega en un `BattleRunLauncher` INYECTADO. El launcher real
 * (fuera de la API: bot-manager → s9-docker-proxy → red arena → replay-service) es el
 * mismo pipeline seguro validado por el arnés. En tests se inyecta un launcher fake;
 * NUNCA se llama a Docker real desde la API.
 *
 * Apagado por defecto: sin `S9_ENABLE_REAL_BATTLE_RUNS=1` el endpoint responde 503.
 */

export interface BattleRunParticipant {
  botId: string;
  version: number;
  team: string;
  /** Digest/firma del artefacto del bot (bot_versions.artifact_hash). */
  artifactHash: string;
}

export interface BattleRunInput {
  battleId: string;
  mode: string;
  mapId: string;
  mapVersion: number;
  seed: string | null;
  participants: BattleRunParticipant[];
}

export interface BattleRunResult {
  status: "running" | "completed" | "failed";
  runner: string;
  replay?: { ingested: boolean; battleId: string; verify_matches?: boolean } | null;
  error?: string;
}

/** El launcher real vive FUERA de la API (no llama a Docker directamente). */
export interface BattleRunLauncher {
  launch(input: BattleRunInput): Promise<BattleRunResult>;
}

export interface BattleRunConfig {
  /** S9_ENABLE_REAL_BATTLE_RUNS === "1". Si false → 503 (disabled). */
  enabled: boolean;
  /** Launcher inyectado. Si ausente (aún no cableado) → 503 (runner_unavailable). */
  runner?: BattleRunLauncher;
  /** Si true, la ingesta del replay es obligatoria para considerar la batalla válida. */
  replayServiceRequired?: boolean;
}

/** Construye la config desde el entorno (apagado por defecto). El runner se inyecta aparte. */
export function battleRunConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BattleRunConfig {
  return {
    enabled: env.S9_ENABLE_REAL_BATTLE_RUNS === "1",
    replayServiceRequired: env.REPLAY_INGEST_REQUIRED === "1",
  };
}

/** Capacidad que la UI consulta (nunca secretos): ¿puede el usuario lanzar una batalla real? */
export function realBattleRunsCapability(cfg: BattleRunConfig | undefined): {
  enabled: boolean;
  available: boolean;
} {
  const enabled = !!cfg?.enabled;
  return { enabled, available: enabled && !!cfg?.runner };
}

/** true si un artifact_hash es un digest firmado real (no vacío ni placeholder de ceros). */
export function isSignedDigest(hash: unknown): boolean {
  if (typeof hash !== "string" || hash.length === 0) return false;
  const hex = hash.replace(/^sha256:/, "");
  return !/^0+$/.test(hex);
}

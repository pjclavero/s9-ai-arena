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
  /**
   * B9 · Ruleset de la BD de la batalla (`battles.ruleset_id`, puede ser null).
   * NO es el ruleset del motor: son catálogos distintos. El launcher lo traduce
   * (`services/battle-ruleset-resolver.ts`) y rechaza si no hay traducción.
   */
  rulesetId?: string | null;
  seed: string | null;
  participants: BattleRunParticipant[];
}

export interface BattleRunResult {
  status: "running" | "completed" | "failed";
  runner: string;
  replay?: { ingested: boolean; battleId: string; verify_matches?: boolean } | null;
  error?: string;
  /**
   * B9 · Código estable del motivo de fallo, para poder distinguirlos sin
   * depender del texto del mensaje (`map_not_published`, `map_checksum_mismatch`,
   * `map_identity_mismatch`, `ruleset_mode_mismatch`...). Ausente si no aplica.
   */
  errorCode?: string;
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
  /**
   * CARRIL I · Techo de batallas REALES simultáneas (filas `battles` en
   * `running`). Límite de recursos del host: cada batalla ocupa contenedores,
   * CPU y RAM durante minutos. Ausente ⇒ el default conservador de la ruta (1).
   */
  maxConcurrentRuns?: number;
}

/**
 * CARRIL I · Lee el techo de concurrencia del entorno. Solo un ENTERO >= 1 vale:
 * un valor basura ("dos", "0", "-3", "1e9999") se trata como AUSENTE y manda el
 * default conservador de la ruta — nunca como "sin límite", que es justo lo que
 * un typo produciría si se hiciera `Number(x) || Infinity`.
 */
export function parseMaxConcurrentRuns(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

/** Construye la config desde el entorno (apagado por defecto). El runner se inyecta aparte. */
export function battleRunConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BattleRunConfig {
  const maxConcurrentRuns = parseMaxConcurrentRuns(env.S9_MAX_CONCURRENT_REAL_BATTLE_RUNS);
  return {
    enabled: env.S9_ENABLE_REAL_BATTLE_RUNS === "1",
    replayServiceRequired: env.REPLAY_INGEST_REQUIRED === "1",
    ...(maxConcurrentRuns !== undefined ? { maxConcurrentRuns } : {}),
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

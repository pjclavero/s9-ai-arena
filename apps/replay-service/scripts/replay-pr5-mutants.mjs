#!/usr/bin/env node
/**
 * V1 REPLAYS PR-5 · calibración por mutantes de los límites de almacenamiento y el fallo seguro:
 * tope por batalla (clase A, truncado, sin reintento), reserva/cuota del volumen (clase B, reintento),
 * compuerta previa, cambio en caliente, métricas, claves `replays.*` y ausencia de efectos deportivos.
 * Mismo procedimiento que replay-pr4b-mutants.mjs: línea base en VERDE, mutante en ROJO, restaurar.
 *
 * Uso: node apps/replay-service/scripts/replay-pr5-mutants.mjs [--check] [id...]   (serie, nunca en paralelo)
 *   --check  sólo la precomprobación (cada patrón se aplica con UNA aparición); no ejecuta ningún test.
 * Commitea antes: el script reescribe ficheros del árbol y los restaura al terminar cada mutante.
 * Cada mutante nombra el test que lo mata (`test` + `t`, filtro `-t` de vitest).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BUDGET = "apps/replay-service/src/s9r/recording-budget.ts";
const RECORDER = "apps/replay-service/src/s9r/recorder.ts";
const WRITER = "apps/replay-service/src/s9r/writer.ts";
const ARTIFACTS = "apps/replay-service/src/artifacts.ts";
const EXEC = "apps/tournament-worker/src/engine-executor.ts";
const RUNNER = "apps/tournament-worker/src/battle-runner.ts";
const LIMITS = "apps/tournament-worker/src/replay-limits.ts";
const MAIN = "apps/tournament-worker/src/main.ts";
const ENDR = "apps/tournament-worker/src/battle-end-reasons.ts";
const SETTINGS = "packages/system-settings/replay-settings.ts";
const BATTLES_ROUTE = "apps/api/src/routes/battles.ts";
const REPLAYS_ROUTE = "apps/api/src/routes/replays.ts";

const U = "apps/replay-service/tests/s9r/recording-budget.test.ts";
const P = "apps/tournament-worker/src/v1-replay-pr5-limits.test.ts";
const M = "apps/tournament-worker/src/v1-replay-pr5-metrics.test.ts";

export const MUTANTS = [
  // ---- presupuesto (unit, sin BD) ------------------------------------------------------------
  {
    id: "M-A-battle-limit-ignored",
    why: "el presupuesto no aplica el tope de la propia batalla (clase A)",
    test: U,
    t: "B4 el CIERRE",
    edits: [
      { file: BUDGET, find: "if (own + frameBytes > this.maxBytesPerBattle) {", replace: "if (false as boolean) {" },
    ],
  },
  {
    id: "M-A-battle-limit-not-fixed",
    why: "el tope por batalla se relee en cada fragmento (un intento en curso no conserva su valor)",
    test: U,
    t: "B3 EN CALIENTE",
    edits: [
      {
        file: BUDGET,
        find: "if (own + frameBytes > this.maxBytesPerBattle) {",
        replace: "if (own + frameBytes > this.o.limits().maxBytesPerBattle) {",
      },
    ],
  },
  {
    id: "M-B-quota-ignored",
    why: "la cuota del volumen no se comprueba",
    test: U,
    t: "B2 cuota del volumen",
    edits: [
      { file: BUDGET, find: "if (used + own + frameBytes > l.quotaMaxBytes) {", replace: "if (false as boolean) {" },
    ],
  },
  {
    id: "M-B-quota-own-not-counted",
    why: "la cuota no cuenta lo ya escrito por el propio intento",
    test: U,
    t: "B2 cuota del volumen",
    edits: [
      {
        file: BUDGET,
        find: "if (used + own + frameBytes > l.quotaMaxBytes) {",
        replace: "if (used + frameBytes > l.quotaMaxBytes) {",
      },
    ],
  },
  {
    id: "M-B-reserve-ignored",
    why: "la reserva de espacio libre no se comprueba",
    test: U,
    t: "B1 reserva de espacio libre",
    edits: [{ file: BUDGET, find: "if (free - frameBytes < l.minFreeBytes) {", replace: "if (false as boolean) {" }],
  },
  {
    id: "M-B-limits-snapshot",
    why: "cuota y reserva se fijan una vez (no se releen en caliente por fragmento)",
    test: U,
    t: "B3 EN CALIENTE",
    edits: [
      {
        file: BUDGET,
        find: "  readonly maxBytesPerBattle: number;\n",
        replace: "  readonly maxBytesPerBattle: number;\n  private readonly snap = this.o.limits();\n",
      },
      {
        file: BUDGET,
        find: "const l = this.o.limits(); // EN CALIENTE: cuota y reserva del momento",
        replace: "const l = this.snap;",
      },
    ],
  },
  {
    id: "M-B-closing-applies-volume",
    why: "el cierre también aplica reserva y cuota (no puede cerrar con el volumen justo)",
    test: U,
    t: "B4 el CIERRE",
    edits: [{ file: BUDGET, find: "if (!ctx.closing && this.o.probe) {", replace: "if (this.o.probe) {" }],
  },
  {
    id: "M-PRE-check-weakened",
    why: "la compuerta previa no exige la reserva junto a una batalla máxima",
    test: U,
    t: "B5 compuerta previa",
    edits: [
      {
        file: BUDGET,
        find: "if (free - limits.maxBytesPerBattle < limits.minFreeBytes) {",
        replace: "if (free < limits.minFreeBytes) {",
      },
    ],
  },
  // ---- escritor y grabador (unit) --------------------------------------------------------------
  {
    id: "M-WRITER-closing-flag",
    why: "el último fragmento no se marca como cierre",
    test: U,
    t: "W1 `admit`",
    edits: [
      {
        file: WRITER,
        find: "      this.assertNotLimited();\n      await this.flushInner(true);",
        replace: "      this.assertNotLimited();\n      await this.flushInner(false);",
      },
    ],
  },
  {
    id: "M-WRITER-B-not-poisoning",
    why: "un rechazo de clase B no envenena al escritor",
    test: U,
    t: "W2 clase B envenena",
    edits: [
      {
        file: WRITER,
        find: '        const err = toStorageError(e, "admit");\n        this.state = "failed";',
        replace: '        const err = toStorageError(e, "admit");\n        this.state = "open";',
      },
    ],
  },
  {
    id: "M-RECORDER-limit-not-truncated",
    why: "un fallo de clase A descarta la grabación en vez de sellarla truncada",
    test: U,
    t: "A1 tope por batalla",
    edits: [{ file: RECORDER, find: "this.finished = true;\n    if (this.fault && !this.limitFault) {", replace: "this.finished = true;\n    if (this.fault) {" }],
  },
  {
    id: "M-RECORDER-limit-not-classified",
    why: "el primer fallo de clase A no se registra como tal",
    test: U,
    t: "A1 tope por batalla",
    edits: [{ file: RECORDER, find: "if (e instanceof ReplayLimitExceededError) this.limitFault = e;", replace: "" }],
  },
  {
    id: "M-RECORDER-queued-limit",
    why: "el tope superado con appends encolados al cerrar se trata como fallo del cierre",
    test: U,
    t: "A3 el tope se supera",
    edits: [
      {
        file: RECORDER,
        find: 'const queuedLimit = e instanceof WriterStateError && e.code === "limit_hit";',
        replace: "const queuedLimit = false;",
      },
    ],
  },
  // ---- integración con PG real ------------------------------------------------------------------
  {
    id: "M-EXEC-preflight-removed",
    why: "se quita la compuerta previa: la batalla arranca sin hueco mínimo",
    test: P,
    t: "L3 sin hueco",
    edits: [
      { file: EXEC, find: "          await preflightCheck({ limits: l, probe: limitsCfg.probe });\n", replace: "" },
    ],
  },
  {
    id: "M-EXEC-preflight-metric",
    why: "la compuerta previa no cuenta sus rechazos",
    test: P,
    t: "L3 sin hueco",
    edits: [{ file: EXEC, find: '          workerMetrics.inc("replay_preflight_rejected_total");\n', replace: "" }],
  },
  {
    id: "M-EXEC-limit-as-infrastructure",
    why: "el tope de la batalla (clase A) se trata como fallo del entorno y se reintenta",
    test: P,
    t: "L1 tope alcanzado",
    edits: [
      {
        file: EXEC,
        find: "if (engine.recordingFault && !recorder?.battleLimit) {",
        replace: "if (engine.recordingFault) {",
      },
    ],
  },
  {
    id: "M-EXEC-limit-draw",
    why: "el tope de la batalla termina en empate en vez de sin ganador",
    test: P,
    t: "L1 tope alcanzado",
    edits: [
      {
        file: EXEC,
        find: "winner: recordingLimit ? null : result.winner,",
        replace: 'winner: recordingLimit ? "draw" : result.winner,',
      },
    ],
  },
  {
    id: "M-EXEC-limit-reason-missing",
    why: "el tope de la batalla no deja `endReason: recording_limit`",
    test: P,
    t: "L1 tope alcanzado",
    edits: [{ file: EXEC, find: '? { endReason: "recording_limit" as const }', replace: "? {}" }],
  },
  {
    id: "M-EXEC-limit-metric",
    why: "el tope de la batalla no se cuenta",
    test: P,
    t: "L1 tope alcanzado",
    edits: [
      { file: EXEC, find: 'if (recordingLimit) workerMetrics.inc("replay_aborts_battle_limit_total");', replace: "" },
    ],
  },
  {
    id: "M-EXEC-storage-metric",
    why: "el aborto por el entorno no se cuenta",
    test: P,
    t: "L2a espacio agotado",
    edits: [
      {
        file: EXEC,
        find: '        const f = engine.recordingFault;\n        workerMetrics.inc("replay_aborts_storage_total");\n',
        replace: "        const f = engine.recordingFault;\n",
      },
    ],
  },
  {
    id: "M-RUNNER-truncated-not-publishable",
    why: "el replay truncado no se publica bajo recording_limit",
    test: P,
    t: "L1 tope alcanzado",
    edits: [
      { file: RUNNER, find: 'allowTruncated: endReason === "recording_limit",', replace: "allowTruncated: false," },
    ],
  },
  {
    id: "M-ARTIFACTS-stats-state",
    why: "el replay truncado queda con estadísticas pendientes",
    test: P,
    t: "L1 tope alcanzado",
    edits: [{ file: ARTIFACTS, find: '...(truncated ? { stats_state: "not_applicable" } : {}),', replace: "" }],
  },
  {
    id: "M-ENDREASON-elo",
    why: "recording_limit deja de ser un final sin resultado deportivo (puntuaría Elo)",
    test: P,
    t: "L7 recording_limit",
    edits: [
      { file: ENDR, find: '["technical_limit", "recording_limit"] as const', replace: '["technical_limit"] as const' },
    ],
  },
  {
    id: "M-API-stats-pending",
    why: "las estadísticas de un replay truncado quedan «pending» para siempre",
    test: P,
    t: "L1 tope alcanzado",
    edits: [
      {
        file: BATTLES_ROUTE,
        find: 'status = endReason === "recording_limit" ? "unavailable" : "pending";',
        replace: 'status = "pending";',
      },
    ],
  },
  {
    id: "M-API-list-winner",
    why: "el listado de replays enseña un ganador inventado en recording_limit",
    test: P,
    t: "L1 tope alcanzado",
    edits: [{ file: REPLAYS_ROUTE, find: ' || result.endReason === "recording_limit";', replace: ";" }],
  },
  {
    id: "M-HOT-quota-fixed",
    why: "la cuota no se lee del lector de system_settings (no hay cambio en caliente)",
    test: P,
    t: "L4 la API valida",
    edits: [
      {
        file: LIMITS,
        find: "quotaMaxBytes: Number(reader.get(REPLAYS_QUOTA_MAX_BYTES)),",
        replace: "quotaMaxBytes: defaultReplayLimits().quotaMaxBytes,",
      },
    ],
  },
  {
    id: "M-FAILCLOSED-default-open",
    why: "el defecto de la cuota deja de ser el del registro (sin lectura válida no hay límite)",
    test: P,
    t: "L5 FAIL-CLOSED",
    edits: [
      {
        file: LIMITS,
        find: "quotaMaxBytes: d(REPLAYS_QUOTA_MAX_BYTES),",
        replace: "quotaMaxBytes: Number.MAX_SAFE_INTEGER,",
      },
    ],
  },
  {
    id: "M-WIRE-limits-not-passed",
    why: "main.ts no pasa los límites al ejecutor",
    test: P,
    t: "L6 main.ts cablea",
    edits: [
      {
        file: MAIN,
        find: "      replayLimits,\n      agents: containerAgents({",
        replace: "      agents: containerAgents({",
      },
    ],
  },
  {
    id: "M-WIRE-reader-not-built",
    why: "main.ts no construye el lector de system_settings",
    test: P,
    t: "L6 main.ts cablea",
    edits: [
      {
        file: MAIN,
        find: "const { config: replayLimits } = await buildReplayLimits(db, replaysDir);",
        replace: "const replayLimits = undefined;",
      },
    ],
  },
  {
    id: "M-SETTINGS-range-widened",
    why: "el tope por batalla admite hasta 16 GiB (fuera del rango del diseño)",
    test: P,
    t: "L4 la API valida",
    edits: [
      {
        file: SETTINGS,
        find: "    max: 1 * GiB,\n    default: 64 * MiB,",
        replace: "    max: 16 * GiB,\n    default: 64 * MiB,",
      },
    ],
  },
  {
    id: "M-WEB-recording-limit-outcome",
    why: "la web enseña recording_limit como un resultado cualquiera (sin su texto)",
    test: "apps/web/tests/pr5-recording-limit-ui.test.ts",
    t: "RL1 resumen",
    edits: [
      { file: "apps/web/src/battle-result.ts", find: 'r.endReason === "recording_limit") {', replace: "false) {" },
    ],
  },
  {
    id: "M-SERIES-single-elim",
    why: "una final recording_limit se resuelve por seed y corona campeón",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S1 eliminatoria simple: la final",
    edits: [
      {
        file: "apps/tournament-worker/src/results.ts",
        find: 'if (games.every((g) => g.status === "failed" || (g.status === "finished" && isTechnicalLimit(g.result)))) {',
        replace: 'if (games.every((g) => g.status === "failed")) {',
      },
    ],
  },
  {
    id: "M-SERIES-single-elim-4",
    why: "la eliminatoria de 4 avanza por seed con juegos sin resultado",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S1b eliminatoria simple de 4",
    edits: [
      {
        file: "apps/tournament-worker/src/results.ts",
        find: 'if (games.every((g) => g.status === "failed" || (g.status === "finished" && isTechnicalLimit(g.result)))) {',
        replace: 'if (games.every((g) => g.status === "failed")) {',
      },
    ],
  },
  {
    id: "M-SERIES-double-elim",
    why: "la doble eliminación avanza/baja por seed con juegos sin resultado",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S2 doble eliminación",
    edits: [
      {
        file: "apps/tournament-worker/src/results.ts",
        find: 'if (games.every((g) => g.status === "failed" || (g.status === "finished" && isTechnicalLimit(g.result)))) {',
        replace: 'if (games.every((g) => g.status === "failed")) {',
      },
    ],
  },
  {
    id: "M-SERIES-swiss",
    why: "el suizo da un punto de empate a una serie sin resultado",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S3 suizo",
    edits: [
      {
        file: "apps/tournament-worker/src/results.ts",
        find: 'if (games.every((g) => g.status === "failed" || (g.status === "finished" && isTechnicalLimit(g.result)))) {',
        replace: 'if (games.every((g) => g.status === "failed")) {',
      },
    ],
  },
  {
    id: "M-SERIES-league",
    why: "la liga cuenta un empate en una serie sin resultado",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S4 league",
    edits: [
      {
        file: "apps/tournament-worker/src/results.ts",
        find: 'if (games.every((g) => g.status === "failed" || (g.status === "finished" && isTechnicalLimit(g.result)))) {',
        replace: 'if (games.every((g) => g.status === "failed")) {',
      },
    ],
  },
  {
    id: "M-SERIES-round-robin",
    why: "el round robin cuenta un empate en una serie sin resultado",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S4 round_robin",
    edits: [
      {
        file: "apps/tournament-worker/src/results.ts",
        find: 'if (games.every((g) => g.status === "failed" || (g.status === "finished" && isTechnicalLimit(g.result)))) {',
        replace: 'if (games.every((g) => g.status === "failed")) {',
      },
    ],
  },
  {
    id: "M-SERIES-mixed-failed",
    why: "una serie failed + recording_limit se resuelve por seed",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S5 mezcla",
    edits: [
      {
        file: "apps/tournament-worker/src/results.ts",
        find: 'if (games.every((g) => g.status === "failed" || (g.status === "finished" && isTechnicalLimit(g.result)))) {',
        replace: 'if (games.every((g) => g.status === "failed")) {',
      },
    ],
  },
  {
    id: "M-SERIES-score-diff-partial",
    why: "la puntuación parcial de un juego truncado entra en el desempate",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S7 serie mixta",
    edits: [
      {
        file: "apps/tournament-worker/src/results.ts",
        find: '      if (isTechnicalLimit(result)) continue;\n      const homeTeam = b.game_index % 2 === 1 ? "A" : "B";\n      const awayTeam = b.game_index % 2 === 1 ? "B" : "A";\n      home.scoreDiff',
        replace:
          '      const homeTeam = b.game_index % 2 === 1 ? "A" : "B";\n      const awayTeam = b.game_index % 2 === 1 ? "B" : "A";\n      home.scoreDiff',
      },
    ],
  },
  {
    id: "M-RETRY-storage-policy-removed",
    why: "storage_unavailable vuelve a la política por defecto (2 s, 4 s)",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S8 5 fallos",
    edits: [
      {
        file: "apps/tournament-worker/src/errors.ts",
        find: "  storage_unavailable: {\n    maxFailures: 5,",
        replace: "  storage_unavailable_x: {\n    maxFailures: 5,",
      },
    ],
  },
  {
    id: "M-RETRY-storage-backoff",
    why: "el backoff de storage_unavailable pasa de minutos a segundos",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S8 5 fallos",
    edits: [
      {
        file: "apps/tournament-worker/src/errors.ts",
        find: "[60_000, 120_000, 300_000, 600_000]",
        replace: "[2_000, 4_000, 8_000, 16_000]",
      },
    ],
  },
  {
    id: "M-CROSS-patch-unchecked",
    why: "el PATCH no valida la coherencia entre claves replays.*",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S9 el PATCH rechaza",
    edits: [
      {
        file: "apps/api/src/settings/system-settings.ts",
        find: 'if (errs.length) throw badRequest(errs.join("; "));',
        replace: "",
      },
    ],
  },
  {
    id: "M-CROSS-reserve-vs-quota",
    why: "se permite una reserva mayor o igual que la cuota",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S9b la regla",
    edits: [
      {
        file: "packages/system-settings/replay-settings.ts",
        find: "if (!(v.minFreeBytes < v.quotaMaxBytes)) {",
        replace: "if (false as boolean) {",
      },
    ],
  },
  {
    id: "M-CROSS-battle-vs-quota",
    why: "se permite un tope por batalla mayor que la cuota",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S9b la regla",
    edits: [
      {
        file: "packages/system-settings/replay-settings.ts",
        find: "if (!(v.maxBytesPerBattle <= v.quotaMaxBytes / 4)) {",
        replace: "if (false as boolean) {",
      },
    ],
  },
  {
    id: "M-TRUNC-replay-available",
    why: "un replay truncado se anuncia como reproducible (replayAvailable)",
    test: "apps/tournament-worker/src/v1-replay-pr5-limits.test.ts",
    t: "L1 tope alcanzado",
    edits: [
      {
        file: "apps/api/src/replay-s9r.ts",
        find: "return isS9rReplayRef(battle.replay_ref) && !isTruncatedBattle(battle);",
        replace: "return isS9rReplayRef(battle.replay_ref);",
      },
    ],
  },
  {
    id: "M-TRUNC-download-header",
    why: "la descarga del crudo de un truncado no lo marca",
    test: "apps/tournament-worker/src/v1-replay-pr5-limits.test.ts",
    t: "L1 tope alcanzado",
    edits: [
      {
        file: "apps/api/src/replay-s9r.ts",
        find: 'if (isTruncatedBattle(battle)) res.setHeader("X-Replay-Truncated", "true");',
        replace: "",
      },
    ],
  },
  {
    id: "M-TRUNC-verify-corrupt",
    why: "verify llama corrupt_file a un truncado legítimo",
    test: "apps/tournament-worker/src/v1-replay-pr5-limits.test.ts",
    t: "L1 tope alcanzado",
    edits: [
      {
        file: "apps/api/src/replay-s9r.ts",
        find: '          : code === "truncated"\n            ? // Íntegro pero incompleto (recording_limit): no es un fichero corrupto.\n              "truncated"\n            : `corrupt_file: ${code}`,',
        replace: "          : `corrupt_file: ${code}`,",
      },
    ],
  },
  {
    id: "M-WEB-list-link",
    why: "el listado ofrece «Ver replay» para un truncado",
    test: "apps/web/tests/pr5-replays-truncated-link.test.tsx",
    t: "TL1",
    edits: [
      {
        file: "apps/web/src/pages/ReplaysPage.tsx",
        find: '{r.endReason === "recording_limit" ? (\n                          <span data-testid="replay-truncated">',
        replace: '{false ? (\n                          <span data-testid="replay-truncated">',
      },
    ],
  },
  {
    id: "M-SERIES-bracket-reset-failed-winner",
    why: "la final de reinicio se da por resuelta con el ganador administrativo de un match failed",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S10d final W sin resultado",
    edits: [
      {
        file: "apps/tournament-worker/src/results.ts",
        find: 'cond && cond.state === "finished" ? (isTeams',
        replace: "cond ? (isTeams",
      },
    ],
  },
  {
    id: "M-SERIES-gf2-formality",
    why: "GF2 se cierra como formalidad con el ganador administrativo de una GF sin resultado (corona campeón)",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S10 P-D",
    edits: [
      {
        file: "apps/tournament-worker/src/results.ts",
        find: 'if (gf && gf.state !== "finished") {',
        replace: "if (false as boolean) {",
      },
    ],
  },
  {
    id: "M-INVARIANT-winner-without-battles",
    why: "un match finished con ganador y 0 batallas con resultado (GF2 tras una final W failed)",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S10d final W sin resultado",
    edits: [
      {
        file: "apps/tournament-worker/src/results.ts",
        find: 'cond && cond.state === "finished" ? (isTeams',
        replace: "cond ? (isTeams",
      },
    ],
  },
  {
    id: "M-CROSS-quarter",
    why: "el tope por batalla sólo se compara con la cuota entera (no con un cuarto)",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S9b la regla",
    edits: [
      {
        file: "packages/system-settings/replay-settings.ts",
        find: "v.maxBytesPerBattle <= v.quotaMaxBytes / 4",
        replace: "v.maxBytesPerBattle <= v.quotaMaxBytes",
      },
    ],
  },
  {
    id: "M-CROSS-no-lock",
    why: "la comprobación cruzada del PATCH no se serializa (write skew entre PATCH concurrentes)",
    test: "apps/tournament-worker/src/v1-replay-pr5-series.test.ts",
    t: "S9c dos PATCH concurrentes",
    edits: [
      {
        file: "apps/api/src/settings/system-settings.ts",
        find: 'await t.raw("SELECT pg_advisory_xact_lock(hashtext(?))", ["system_settings:replays.cross"]);',
        replace: "",
      },
    ],
  },
  {
    id: "M-RACE-no-preflush",
    why: "finish() cierra receta y vista sin volcar antes los dos búferes: la receta sale completa en una batalla truncada",
    test: "apps/tournament-worker/src/v1-replay-pr5-limits.test.ts",
    t: "L1b el motor termina",
    edits: [
      {
        file: "apps/replay-service/src/s9r/recorder.ts",
        find: "const flushed = await Promise.allSettled([this.recipe.writer.flushFragment(), this.view.writer.flushFragment()]);",
        replace: "const flushed: PromiseSettledResult<void>[] = [];",
      },
    ],
  },
  {
    id: "M-RACE-recipe-winner",
    why: "la receta de una batalla recording_limit lleva el ganador del motor",
    test: "apps/tournament-worker/src/v1-replay-pr5-limits.test.ts",
    t: "L1b el motor termina",
    edits: [
      {
        file: "apps/replay-service/src/s9r/recorder.ts",
        find: "closeOne(this.recipe, result, truncatedResult ?? result),",
        replace: "closeOne(this.recipe, result, result),",
      },
    ],
  },
  {
    id: "M-RACE-verify-by-battle",
    why: "verify no rechaza por la batalla truncada y re-simula la receta",
    test: "apps/tournament-worker/src/v1-replay-pr5-limits.test.ts",
    t: "L1b el motor termina",
    edits: [
      {
        file: "apps/api/src/replay-s9r.ts",
        find: "if (isTruncatedBattle(battle)) {\n    return {",
        replace: "if (false as boolean) {\n    return {",
      },
    ],
  },
  // ---- métricas, claves y sonda (PG ligera) ----------------------------------------------------------
  {
    id: "M-SETTINGS-env-ceiling-removed",
    why: "la cuota pierde su techo por entorno",
    test: M,
    t: "M3 defecto dentro del rango",
    edits: [{ file: SETTINGS, find: '    env: "REPLAYS_QUOTA_MAX_BYTES",\n', replace: "" }],
  },
  {
    id: "M-PROBE-own-counted",
    why: "la sonda cuenta los parciales del propio intento como ajenos",
    test: M,
    t: "M4 libre",
    edits: [{ file: LIMITS, find: "      if (skip.has(p)) continue;\n", replace: "" }],
  },
  {
    id: "M-PROBE-cache-forever",
    why: "la suma de artefactos se cachea sin caducidad",
    test: M,
    t: "M4 libre",
    edits: [
      {
        file: LIMITS,
        find: "if (cached && now() - cached.at < cacheMs) return cached.bytes;",
        replace: "if (cached) return cached.bytes;",
      },
    ],
  },
  {
    id: "M-PROBE-purged-counted",
    why: "la sonda cuenta los replays purgados como ocupados",
    test: M,
    t: "M4 libre",
    edits: [
      {
        file: LIMITS,
        find: '.whereIn("state", ["published", "trashed"])',
        replace: '.whereIn("state", ["published", "trashed", "purged"])',
      },
    ],
  },
];

function run(test, t) {
  const r = spawnSync("nice", ["-n", "19", "npx", "vitest", "run", test, "-t", t, "--maxWorkers=1"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  return r.status;
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const only = new Set(args.filter((a) => !a.startsWith("--")));

// Precomprobación: TODOS los mutantes seleccionados se aplican (cada patrón con UNA aparición) sobre el árbol
// limpio. Un mutante que no se aplica NO calibra nada: el script FALLA antes de ejecutar ningún test.
const noAplicables = [];
for (const m of MUTANTS) {
  if (only.size && !only.has(m.id)) continue;
  const cur = new Map();
  for (const e of m.edits) {
    const f = join(root, e.file);
    const src = cur.get(f) ?? readFileSync(f, "utf8");
    const k = src.split(e.find).length - 1;
    if (k !== 1) {
      noAplicables.push(`${m.id}: patrón con ${k} apariciones en ${e.file}`);
      break;
    }
    cur.set(
      f,
      src.replace(e.find, () => e.replace),
    );
  }
}
for (const id of [...only].filter((id) => !MUTANTS.some((m) => m.id === id)))
  noAplicables.push(`${id}: mutante desconocido`);
if (noAplicables.length) {
  for (const l of noAplicables) console.log(`FALLO (no aplicado) ${l}`);
  console.log(`mutantes no aplicables: ${noAplicables.length} · el script FALLA`);
  process.exit(2);
}
if (checkOnly) {
  console.log(`precomprobación OK: ${only.size || MUTANTS.length} mutantes aplicables`);
  process.exit(0);
}

const base = new Map();
let survivors = 0;
let killedCount = 0;
let total = 0;
for (const m of MUTANTS) {
  if (only.size && !only.has(m.id)) continue;
  const key = `${m.test}::${m.t}`;
  if (!base.has(key)) base.set(key, run(m.test, m.t));
  total++;
  if (base.get(key) !== 0) {
    console.log(`${m.id}: BASE ROJA (rc ${base.get(key)}), no calibrable`);
    survivors++;
    continue;
  }
  const originals = new Map();
  for (const e of m.edits) {
    const f = join(root, e.file);
    if (!originals.has(f)) originals.set(f, readFileSync(f, "utf8"));
  }
  const current = new Map(originals);
  for (const e of m.edits) {
    const f = join(root, e.file);
    current.set(
      f,
      current.get(f).replace(e.find, () => e.replace),
    );
  }
  try {
    for (const [f, s] of current) writeFileSync(f, s);
    const rc = run(m.test, m.t);
    const killed = rc !== 0;
    if (!killed) survivors++;
    else killedCount++;
    console.log(`${m.id}: ${killed ? "MUERTO (test en rojo, rc " + rc + ")" : "SOBREVIVE (rc 0)"} · ${m.why}`);
  } finally {
    for (const [f, s] of originals) writeFileSync(f, s);
  }
}
console.log(`MUERTOS ${killedCount}/${total} · supervivientes/errores: ${survivors}`);
process.exit(survivors ? 1 : 0);

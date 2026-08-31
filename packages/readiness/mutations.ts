/**
 * R17 · Escenario nominal y MUTACIONES.
 *
 * "Una comprobación que no puede ponerse roja no es una comprobación." Aquí se
 * define (a) el escenario nominal en el que TODO sale verde y (b) para cada
 * comprobación, mutaciones que reproducen fallos reales observados en este
 * proyecto. El test `readiness.test.ts` exige que cada comprobación tenga al
 * menos una mutación y que TODAS las mutaciones la saquen de `verified`.
 *
 * Este fichero es producto, no utillaje de test: el runner de producción puede
 * ejecutar el escenario nominal como autodiagnóstico del propio motor.
 */
import type { ReadinessContext, ReadinessProbes } from "./engine.ts";

export function nominalEnv(): Record<string, string | undefined> {
  return {
    S9_DATA_DIR: "/data/replays",
    S9_DB_URL: undefined,
    S9_DB_URL_FILE: "/run/secrets/<secret-name>",
    S9_JWT_SECRET_FILE: "/run/secrets/<secret-name>",
    S9_BACKUP_TARGET: "sftp://<backup-host>/<repo>",
    S9_ENABLE_REAL_BATTLE_RUNS: "0",
    S9_PUBLIC_SPECTATE_ENABLED: "0",
  };
}

export function nominalProbes(): ReadinessProbes {
  return {
    async dataDirWrite() {
      return { bytesWritten: 32, readBack: true, sameContent: true };
    },
    async backupLastRun() {
      return {
        ranAt: "2026-08-30T02:00:00Z",
        exitCode: 0,
        snapshotCount: 14,
        lastSnapshotBytes: 4_194_304,
        ageHours: 6,
      };
    },
    async backupRestoreDrill() {
      return { attempted: true, restoredBytes: 65_536, canaryFound: true };
    },
    async deployedVersion() {
      return {
        imageTag: "ghcr.io/<owner>/<image>:4d469dc",
        taggedCommit: "4d469dc",
        builtFromCommit: "4d469dc",
        runningImageId: "sha256:aaaa",
        imageIdPresentInDaemon: true,
      };
    },
    async secretMounted() {
      return { existsOnHost: true, mountedInProcess: true, readableBytes: 64 };
    },
    async dbCanary() {
      return { queryExecuted: true, canaryRowsSeen: 1, rowsAffected: 1 };
    },
    async gateState() {
      return { envEnabled: false, runtimeAdvertisesEnabled: false, probedRuntime: true };
    },
    async diagnosticsBundle() {
      return { generated: true, bytes: 12_288, secretLikeMatches: 0 };
    },
  };
}

export function nominalContext(): ReadinessContext {
  return { env: nominalEnv(), probes: nominalProbes() };
}

export interface ReadinessMutation {
  /** Comprobación que debe detectarla. */
  checkId: string;
  /** Fallo real que reproduce. */
  name: string;
  apply(ctx: ReadinessContext): void;
}

export const MUTATIONS: readonly ReadinessMutation[] = [
  {
    checkId: "storage.writable",
    name: "volumen root:root, el uid del proceso no puede escribir",
    apply: (c) => {
      c.probes.dataDirWrite = async () => ({
        bytesWritten: 0,
        readBack: false,
        sameContent: false,
        reason: "EACCES: permission denied",
      });
    },
  },
  {
    checkId: "storage.writable",
    name: "escritura aceptada pero la relectura no coincide",
    apply: (c) => {
      c.probes.dataDirWrite = async () => ({
        bytesWritten: 32,
        readBack: true,
        sameContent: false,
      });
    },
  },
  {
    checkId: "storage.writable",
    name: "S9_DATA_DIR sin definir: no se escribe en ninguna parte",
    apply: (c) => {
      c.env.S9_DATA_DIR = "";
    },
  },
  {
    checkId: "backup.last_run_succeeded",
    name: "contenedor healthy con la copia nocturna fallando cada noche",
    apply: (c) => {
      c.probes.backupLastRun = async () => ({
        ranAt: "2026-08-30T02:00:00Z",
        exitCode: 1,
        snapshotCount: 0,
        lastSnapshotBytes: 0,
        ageHours: 6,
      });
    },
  },
  {
    checkId: "backup.last_run_succeeded",
    name: "exit 0 con snapshot de 0 bytes (EXIT 0 != BEHAVIOR EXERCISED)",
    apply: (c) => {
      c.probes.backupLastRun = async () => ({
        ranAt: "2026-08-30T02:00:00Z",
        exitCode: 0,
        snapshotCount: 1,
        lastSnapshotBytes: 0,
        ageHours: 2,
      });
    },
  },
  {
    checkId: "backup.last_run_succeeded",
    name: "copia rancia: última con éxito hace semanas",
    apply: (c) => {
      c.probes.backupLastRun = async () => ({
        ranAt: "2026-07-17T02:00:00Z",
        exitCode: 0,
        snapshotCount: 3,
        lastSnapshotBytes: 1024,
        ageHours: 1000,
      });
    },
  },
  {
    checkId: "backup.last_run_succeeded",
    name: "no consta ninguna ejecución (temporizador sano que nunca corrió)",
    apply: (c) => {
      c.probes.backupLastRun = async () => ({
        ranAt: null,
        exitCode: null,
        snapshotCount: 0,
        lastSnapshotBytes: 0,
        ageHours: null,
      });
    },
  },
  {
    checkId: "backup.restore_drill",
    name: "existe copia pero nunca se ha intentado restaurar",
    apply: (c) => {
      c.probes.backupRestoreDrill = async () => ({
        attempted: false,
        restoredBytes: 0,
        canaryFound: false,
      });
    },
  },
  {
    checkId: "backup.restore_drill",
    name: "restauración con éxito que recupera datos sin el canario",
    apply: (c) => {
      c.probes.backupRestoreDrill = async () => ({
        attempted: true,
        restoredBytes: 4096,
        canaryFound: false,
      });
    },
  },
  {
    checkId: "security.secret_mounted",
    name: "el secreto existe en el host pero el contenedor no lo monta",
    apply: (c) => {
      c.probes.secretMounted = async () => ({
        existsOnHost: true,
        mountedInProcess: false,
        readableBytes: 0,
      });
    },
  },
  {
    checkId: "security.secret_mounted",
    name: "montado pero vacío: se firmaría con nada",
    apply: (c) => {
      c.probes.secretMounted = async () => ({
        existsOnHost: true,
        mountedInProcess: true,
        readableBytes: 0,
      });
    },
  },
  {
    checkId: "security.deployed_version",
    name: "contenedor corriendo una image ID ya borrada del daemon",
    apply: (c) => {
      c.probes.deployedVersion = async () => ({
        imageTag: "ghcr.io/<owner>/<image>:4d469dc",
        taggedCommit: "4d469dc",
        builtFromCommit: "4d469dc",
        runningImageId: "sha256:bbbb",
        imageIdPresentInDaemon: false,
      });
    },
  },
  {
    checkId: "security.deployed_version",
    name: "etiqueta con un commit, imagen construida desde otro",
    apply: (c) => {
      c.probes.deployedVersion = async () => ({
        imageTag: "ghcr.io/<owner>/<image>:4d469dc",
        taggedCommit: "4d469dc",
        builtFromCommit: "0badc0d",
        runningImageId: "sha256:aaaa",
        imageIdPresentInDaemon: true,
      });
    },
  },
  {
    checkId: "gate.s9_enable_real_battle_runs",
    name: "puerta de ejecución encendida por entorno",
    apply: (c) => {
      c.env.S9_ENABLE_REAL_BATTLE_RUNS = "1";
    },
  },
  {
    checkId: "gate.s9_enable_real_battle_runs",
    name: "entorno apagado pero el runtime la anuncia encendida",
    apply: (c) => {
      c.probes.gateState = async () => ({
        envEnabled: false,
        runtimeAdvertisesEnabled: true,
        probedRuntime: true,
      });
    },
  },
  {
    checkId: "gate.s9_public_spectate_enabled",
    name: "spectator público encendido por entorno",
    apply: (c) => {
      c.env.S9_PUBLIC_SPECTATE_ENABLED = "true";
    },
  },
  {
    checkId: "gate.s9_public_spectate_enabled",
    name: "no se pudo preguntar al runtime (creer al entorno no basta)",
    apply: (c) => {
      c.probes.gateState = async () => ({
        envEnabled: false,
        runtimeAdvertisesEnabled: false,
        probedRuntime: false,
        reason: "runtime no responde",
      });
    },
  },
  {
    checkId: "diagnostics.db_canary",
    name: "0 filas porque la consulta no llegó a ejecutarse (EMPTY != ERROR)",
    apply: (c) => {
      c.probes.dbCanary = async () => ({
        queryExecuted: false,
        canaryRowsSeen: 0,
        rowsAffected: 0,
        reason: "conexión rechazada",
      });
    },
  },
  {
    checkId: "diagnostics.db_canary",
    name: "UPDATE 0 sobre tabla vacía leído como aceptado",
    apply: (c) => {
      c.probes.dbCanary = async () => ({ queryExecuted: true, canaryRowsSeen: 0, rowsAffected: 0 });
    },
  },
  {
    checkId: "diagnostics.bundle_redacted",
    name: "el paquete de diagnóstico incluye algo con pinta de secreto",
    apply: (c) => {
      c.probes.diagnosticsBundle = async () => ({
        generated: true,
        bytes: 9000,
        secretLikeMatches: 3,
      });
    },
  },
  {
    checkId: "diagnostics.bundle_redacted",
    name: "paquete generado con 0 bytes",
    apply: (c) => {
      c.probes.diagnosticsBundle = async () => ({
        generated: true,
        bytes: 0,
        secretLikeMatches: 0,
      });
    },
  },
];

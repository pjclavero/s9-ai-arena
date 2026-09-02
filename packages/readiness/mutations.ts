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

/**
 * Entorno nominal: las claves del CONTRATO REAL de instalación, con los valores
 * que tiene el despliegue (topología escrita con marcadores, nunca literal).
 */
export function nominalEnv(): Record<string, string | undefined> {
  return {
    REPLAYS_DIR: "/data/replays",
    PGHOST: "<internal-db-host>",
    PGUSER: "arena",
    PGDATABASE: "arena",
    PGPASSWORD_FILE: "/run/secrets/<secret-name>",
    JWT_SECRET_FILE: "/run/secrets/<secret-name>",
    ARENA_ENGINE_SHARED_SECRET_FILE: "/run/secrets/<secret-name>",
    REPLAY_INGEST_SECRET_FILE: "/run/secrets/<secret-name>",
    RESTIC_REPOSITORY: "sftp:<usuario>@<backup-host>:/<repo>",
    RESTIC_PASSWORD_FILE: "/run/secrets/<secret-name>",
    RESTIC_SSH_KEY_FILE: "/run/secrets/<secret-name>",
    RESTIC_SSH_KNOWN_HOSTS_FILE: "/run/secrets/<secret-name>",
    S9_DOMAIN: "<dominio-publico>",
    S9_ENABLE_REAL_BATTLE_RUNS: "0",
    S9_PUBLIC_SPECTATE_ENABLED: "0",
  };
}

export function nominalProbes(): ReadinessProbes {
  return {
    async dataDirWrite() {
      return { attempted: true, bytesWritten: 32, readBack: true, sameContent: true };
    },
    async backupProcessAlive() {
      return { probed: true, processRunning: true };
    },
    async backupLastRun() {
      return { probed: true, ranAt: "2026-08-30T02:00:00Z", exitCode: 0, ageHours: 6 };
    },
    async backupLastSnapshot() {
      return {
        probed: true,
        snapshotCount: 14,
        latestSnapshotAt: "2026-08-30T02:00:05Z",
        latestSnapshotBytes: 4_194_304,
        ageHours: 6,
      };
    },
    async backupPgDumpChecksum() {
      return { probed: true, checksumMatches: true, dumpBytes: 108_979 };
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
      return { probed: true, existsOnHost: true, mountedInProcess: true, readableBytes: 64 };
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
        attempted: true,
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
        attempted: true,
        bytesWritten: 32,
        readBack: true,
        sameContent: false,
      });
    },
  },
  {
    checkId: "storage.writable",
    name: "REPLAYS_DIR sin definir: no se escribe en ninguna parte",
    apply: (c) => {
      c.env.REPLAYS_DIR = "";
    },
  },
  {
    checkId: "storage.writable",
    name: "ni se intentó la escritura (no mirar no es un volumen roto)",
    apply: (c) => {
      c.probes.dataDirWrite = async () => ({
        attempted: false,
        bytesWritten: 0,
        readBack: false,
        sameContent: false,
        reason: "el volumen no está montado en este proceso",
      });
    },
  },
  {
    checkId: "backup.process_alive",
    name: "el planificador de la copia no está corriendo: nadie la disparará",
    apply: (c) => {
      c.probes.backupProcessAlive = async () => ({ probed: true, processRunning: false });
    },
  },
  {
    checkId: "backup.process_alive",
    name: "no se pudo mirar el servicio de copias",
    apply: (c) => {
      c.probes.backupProcessAlive = async () => ({
        probed: false,
        processRunning: false,
        reason: "el daemon no responde",
      });
    },
  },
  {
    checkId: "backup.last_run_success",
    name: "contenedor healthy con la copia nocturna fallando cada noche",
    apply: (c) => {
      c.probes.backupLastRun = async () => ({
        probed: true,
        ranAt: "2026-08-30T02:00:00Z",
        exitCode: 1,
        ageHours: 6,
      });
    },
  },
  {
    checkId: "backup.last_run_success",
    name: "copia rancia: última con éxito hace semanas",
    apply: (c) => {
      c.probes.backupLastRun = async () => ({
        probed: true,
        ranAt: "2026-07-17T02:00:00Z",
        exitCode: 0,
        ageHours: 1000,
      });
    },
  },
  {
    checkId: "backup.last_run_success",
    name: "no consta ninguna ejecución (temporizador sano que nunca corrió)",
    apply: (c) => {
      c.probes.backupLastRun = async () => ({ probed: true, ranAt: null, exitCode: null, ageHours: null });
    },
  },
  {
    checkId: "backup.last_run_success",
    name: "no se pudo leer el registro de la última copia",
    apply: (c) => {
      c.probes.backupLastRun = async () => ({
        probed: false,
        ranAt: null,
        exitCode: null,
        ageHours: null,
        reason: "métricas ilegibles",
      });
    },
  },
  {
    checkId: "backup.last_snapshot_verified",
    name: "exit 0 sin snapshot: la ejecución dijo que sí y el repositorio está vacío",
    apply: (c) => {
      c.probes.backupLastSnapshot = async () => ({
        probed: true,
        snapshotCount: 0,
        latestSnapshotAt: null,
        latestSnapshotBytes: 0,
        ageHours: null,
      });
    },
  },
  {
    checkId: "backup.last_snapshot_verified",
    name: "snapshot creado con 0 bytes (una copia vacía no es una copia)",
    apply: (c) => {
      c.probes.backupLastSnapshot = async () => ({
        probed: true,
        snapshotCount: 5,
        latestSnapshotAt: "2026-08-30T02:00:05Z",
        latestSnapshotBytes: 0,
        ageHours: 2,
      });
    },
  },
  {
    checkId: "backup.last_snapshot_verified",
    name: "ejecuciones con éxito que ya no añaden snapshots: el último es rancio",
    apply: (c) => {
      c.probes.backupLastSnapshot = async () => ({
        probed: true,
        snapshotCount: 35,
        latestSnapshotAt: "2026-07-17T04:15:00Z",
        latestSnapshotBytes: 6126,
        ageHours: 1000,
      });
    },
  },
  {
    checkId: "backup.last_snapshot_verified",
    name: "no se pudo consultar el repositorio de copias",
    apply: (c) => {
      c.probes.backupLastSnapshot = async () => ({
        probed: false,
        snapshotCount: 0,
        latestSnapshotAt: null,
        latestSnapshotBytes: 0,
        ageHours: null,
        reason: "repositorio inalcanzable",
      });
    },
  },
  {
    checkId: "backup.pg_dump_checksum_verified",
    name: "el volcado almacenado no cuadra con su checksum del manifest",
    apply: (c) => {
      c.probes.backupPgDumpChecksum = async () => ({
        probed: true,
        checksumMatches: false,
        dumpBytes: 108_979,
      });
    },
  },
  {
    checkId: "backup.pg_dump_checksum_verified",
    name: "volcado de 0 bytes con pg_dump 'correcto'",
    apply: (c) => {
      c.probes.backupPgDumpChecksum = async () => ({ probed: true, checksumMatches: true, dumpBytes: 0 });
    },
  },
  {
    checkId: "backup.pg_dump_checksum_verified",
    name: "nadie releyó el volcado: creer al productor no es contrastar",
    apply: (c) => {
      c.probes.backupPgDumpChecksum = async () => ({
        probed: false,
        checksumMatches: false,
        dumpBytes: 0,
        reason: "no se releyó el volcado almacenado",
      });
    },
  },
  {
    checkId: "backup.restore_verified",
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
    checkId: "backup.restore_verified",
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
    checkId: "backup.restore_verified",
    name: "restauración que se ejecuta y devuelve la nada",
    apply: (c) => {
      c.probes.backupRestoreDrill = async () => ({
        attempted: true,
        restoredBytes: 0,
        canaryFound: false,
      });
    },
  },
  {
    checkId: "security.secret_mounted",
    name: "el secreto existe en el host pero el contenedor no lo monta",
    apply: (c) => {
      c.probes.secretMounted = async () => ({
        probed: true,
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
        probed: true,
        existsOnHost: true,
        mountedInProcess: true,
        readableBytes: 0,
      });
    },
  },
  {
    checkId: "security.secret_mounted",
    name: "no se miró el espacio de montaje (esto NO es 'no está montado')",
    apply: (c) => {
      c.probes.secretMounted = async () => ({
        probed: false,
        existsOnHost: false,
        mountedInProcess: false,
        readableBytes: 0,
        reason: "sonda no disponible en este entorno",
      });
    },
  },
  {
    checkId: "security.deployed_version",
    name: "la etiqueta se movió: hoy resuelve a otra imagen distinta de la que corre",
    apply: (c) => {
      c.probes.deployedVersion = async () => ({
        imageTag: "ghcr.io/<owner>/<image>:4d469dc",
        taggedCommit: "4d469dc",
        builtFromCommit: "4d469dc",
        runningImageId: "sha256:aaaa",
        imageIdPresentInDaemon: true,
        tagResolvesToRunningId: false,
      });
    },
  },
  {
    checkId: "security.deployed_version",
    name: "imagen sin identidad de build embebida: sólo la etiqueta afirma la procedencia",
    apply: (c) => {
      c.probes.deployedVersion = async () => ({
        imageTag: "ghcr.io/<owner>/<image>:4d469dc",
        taggedCommit: "4d469dc",
        builtFromCommit: null,
        runningImageId: "sha256:aaaa",
        imageIdPresentInDaemon: true,
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

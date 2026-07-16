/**
 * E6 · bot-manager — sandbox de ejecución de bots (T6.2, tabla 18.2).
 *
 * DOS CAPAS (honestidad de entorno, ia02 SIN grupo docker):
 *   - DockerContainerRunner: implementación REAL con los flags EXACTOS de la tabla 18.2.
 *     `buildRunArgs()` es una función PURA (probada con tests reales sobre el array de
 *     flags) y `analyzeInspect()` interpreta la salida real de `docker inspect` (probada
 *     contra un JSON de inspect representativo). Lanzar contenedores de verdad queda
 *     PENDIENTE de un entorno con Docker.
 *   - SandboxSpec / SecurityPosture: contrato de seguridad que el motor/orquestador exige
 *     antes de considerar "sano" un contenedor. `assertCompliant()` rechaza cualquier
 *     configuración que no cumpla los controles.
 *
 * Un análisis estático NO sustituye a esto (ver static-analysis.ts): el bot es código
 * arbitrario ejecutándose; el aislamiento tiene que ser del PROCESO/kernel, no del texto.
 */

import { assertRealDigest } from "./digest-guard.js";

export interface ContainerLimits {
  /** Cuota de CPU (nº de núcleos, p. ej. 0.5). */
  cpus: number;
  /** RAM máxima en bytes (hard limit). */
  memoryBytes: number;
  /** Máximo de PIDs (anti fork-bomb). */
  pids: number;
  /** Tamaño de /tmp (tmpfs) en bytes. */
  tmpfsBytes: number;
  /** Deadline de arranque en ms. */
  startupDeadlineMs: number;
}

export const DEFAULT_LIMITS: ContainerLimits = {
  cpus: 0.5,
  memoryBytes: 256 * 1024 * 1024,
  pids: 64,
  tmpfsBytes: 32 * 1024 * 1024,
  startupDeadlineMs: 5000,
};

export interface SandboxSpec {
  /** Imagen del runtime FIJADA POR DIGEST (nunca tag mutable). Ver T6.3. */
  imageDigest: string; // p. ej. "arena/bot-runtime-python@sha256:..."
  botId: string;
  version: number;
  battleId: string;
  /** Red interna del motor. Sin DNS externo, sin Internet. */
  network: string; // "arena"
  /** Endpoint del motor al que puede hablar el bot. */
  engineEndpoint: string;
  /** Variables de entorno (NUNCA secretos). */
  env: Record<string, string>;
  limits: ContainerLimits;
  /** Ruta al perfil seccomp restrictivo. */
  seccompProfilePath: string;
}

/** Postura de seguridad normalizada, para inspección/aserción. */
export interface SecurityPosture {
  user: string; // no root
  capDropAll: boolean;
  readonlyRootfs: boolean;
  noNewPrivileges: boolean;
  seccompProfile: string | null; // no "unconfined"
  networks: string[];
  hasExternalDns: boolean;
  tmpfsMounts: string[];
  mountsDockerSock: boolean;
  privileged: boolean;
  bindMounts: string[]; // fuera de tmpfs: debería estar vacío (sin secretos)
  limits: Partial<ContainerLimits>;
}

export interface ContainerHandle {
  id: string;
  stop(): Promise<void>;
  posture(): Promise<SecurityPosture>;
}

export interface ContainerRunner {
  launch(spec: SandboxSpec): Promise<ContainerHandle>;
}

/** Comprueba que una postura cumple TODOS los controles de la tabla 18.2. Devuelve las
 *  violaciones (vacío = cumple). */
export function complianceViolations(p: SecurityPosture): string[] {
  const v: string[] = [];
  if (p.privileged) v.push("contenedor privilegiado");
  if (p.mountsDockerSock) v.push("monta el socket de Docker (/var/run/docker.sock)");
  if (!p.user || p.user === "root" || p.user === "0") v.push("corre como root");
  if (!p.capDropAll) v.push("no elimina todas las capabilities (cap-drop ALL)");
  if (!p.readonlyRootfs) v.push("filesystem raíz no es de solo lectura");
  if (!p.noNewPrivileges) v.push("falta no-new-privileges");
  if (!p.seccompProfile || p.seccompProfile === "unconfined") v.push("seccomp unconfined o ausente");
  if (p.hasExternalDns) v.push("tiene DNS externo (fuga a Internet)");
  if (p.networks.some((n) => n !== "arena")) v.push(`conectado a red no permitida: ${p.networks.join(",")}`);
  if (p.bindMounts.length) v.push(`bind-mounts presentes (posibles secretos): ${p.bindMounts.join(",")}`);
  if (p.tmpfsMounts.length === 0) v.push("sin /tmp por tmpfs limitado");
  return v;
}

export function assertCompliant(p: SecurityPosture): void {
  const v = complianceViolations(p);
  if (v.length) throw new Error(`postura de seguridad NO conforme (tabla 18.2): ${v.join("; ")}`);
}

/**
 * Implementación Docker real. En una máquina con Docker, `launch()` haría spawn de
 * `docker run` con estos flags. Aquí exponemos `buildRunArgs()` (pura, testeable) y el
 * parser de `docker inspect`.
 */
export class DockerContainerRunner implements ContainerRunner {
  constructor(private dockerBin = "docker") {}

  /** Flags EXACTOS de la tabla 18.2. */
  static buildRunArgs(spec: SandboxSpec, name: string): string[] {
    // Guard issue #12: nunca componer un `docker run` sobre un digest placeholder.
    assertRealDigest(spec.imageDigest, `imagen de runtime para ${spec.botId} v${spec.version}`);
    const l = spec.limits;
    return [
      "run",
      "--name", name,
      "--detach",
      // no root, sin privilegios nuevos
      "--user", "10001:10001",
      "--security-opt", "no-new-privileges",
      // todas las capabilities eliminadas
      "--cap-drop", "ALL",
      // seccomp restrictivo (NO unconfined)
      "--security-opt", `seccomp=${spec.seccompProfilePath}`,
      // filesystem de solo lectura + /tmp limitado por tamaño
      "--read-only",
      "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${l.tmpfsBytes}`,
      // red SOLO arena, sin DNS externo, sin Internet
      "--network", spec.network,
      "--dns", "0.0.0.0",
      // límites estrictos de CPU, memoria y PIDs
      "--cpus", String(l.cpus),
      "--memory", String(l.memoryBytes),
      "--memory-swap", String(l.memoryBytes), // sin swap extra
      "--pids-limit", String(l.pids),
      // sin socket de Docker, sin secretos montados: simplemente NO se añade ningún -v
      // variables de entorno (sin secretos)
      ...Object.entries(spec.env).flatMap(([k, val]) => ["--env", `${k}=${val}`]),
      spec.imageDigest,
    ];
  }

  /** Interpreta la salida de `docker inspect <id>` (array con un objeto) en una postura. */
  static analyzeInspect(inspectJson: unknown): SecurityPosture {
    const c = Array.isArray(inspectJson) ? (inspectJson[0] as any) : (inspectJson as any);
    const hostConfig = c?.HostConfig ?? {};
    const config = c?.Config ?? {};
    const mounts: any[] = c?.Mounts ?? [];
    const secOpt: string[] = hostConfig.SecurityOpt ?? [];
    const seccomp = secOpt.find((o) => o.startsWith("seccomp="))?.slice("seccomp=".length) ?? null;
    const tmpfs = Object.keys(hostConfig.Tmpfs ?? {});
    const bindMounts = mounts.filter((m) => m.Type === "bind").map((m) => m.Source as string);
    const networks = Object.keys(c?.NetworkSettings?.Networks ?? {});
    return {
      user: config.User ?? "root",
      capDropAll: (hostConfig.CapDrop ?? []).map((s: string) => s.toUpperCase()).includes("ALL"),
      readonlyRootfs: hostConfig.ReadonlyRootfs === true,
      noNewPrivileges: secOpt.includes("no-new-privileges"),
      seccompProfile: seccomp,
      networks,
      hasExternalDns: (hostConfig.Dns ?? []).some((d: string) => d !== "0.0.0.0"),
      tmpfsMounts: tmpfs,
      mountsDockerSock: bindMounts.some((s) => s.includes("docker.sock")),
      privileged: hostConfig.Privileged === true,
      bindMounts,
      limits: {
        cpus: hostConfig.NanoCpus ? hostConfig.NanoCpus / 1e9 : undefined,
        memoryBytes: hostConfig.Memory || undefined,
        pids: hostConfig.PidsLimit || undefined,
      },
    };
  }

  async launch(_spec: SandboxSpec): Promise<ContainerHandle> {
    // Guard issue #12 ANTES de cualquier intento de lanzamiento: con digests
    // placeholder (000…0) el bot-manager se niega a lanzar bots.
    assertRealDigest(_spec.imageDigest, `imagen de runtime para ${_spec.botId} v${_spec.version}`);
    throw new Error(
      "DockerContainerRunner.launch: requiere un entorno con Docker (ia02 no está en el grupo docker). " +
        "Usa buildRunArgs()/analyzeInspect() para inspección, o SandboxProcessRunner en tests.",
    );
  }
}

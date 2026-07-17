/**
 * Tipos de compliance.mjs (única fuente de verdad de la postura de seguridad).
 * Estructuralmente idéntico a SecurityPosture de container-runner.ts, que
 * re-exporta estas funciones para mantener su API.
 */

export interface CompliancePosture {
  user: string;
  capDropAll: boolean;
  readonlyRootfs: boolean;
  noNewPrivileges: boolean;
  seccompProfile: string | null;
  networks: string[];
  hasExternalDns: boolean;
  tmpfsMounts: string[];
  mountsDockerSock: boolean;
  privileged: boolean;
  bindMounts: string[];
  limits: { cpus?: number; memoryBytes?: number; pids?: number; tmpfsBytes?: number; startupDeadlineMs?: number };
}

export function complianceViolations(p: CompliancePosture): string[];
export function assertCompliant(p: CompliancePosture): void;
export function compliantBasePosture(): CompliancePosture;

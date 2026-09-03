/**
 * R17 · Instalación y readiness. Punto de entrada del paquete.
 *
 * Idea central: PRESENTE no es FUNCIONAL. healthy != ready, backed_up !=
 * recovery_verified, image tag != deployed version, secret exists != secret
 * mounted, storage exists != storage writable, empty != error, y sobre todo
 * exit 0 != behavior exercised.
 */
export * from "./config.ts";
export * from "./engine.ts";
export * from "./checks.ts";
export * from "./backup-evidence.ts";
export * from "./first-run.ts";
export * from "./report.ts";
export * from "./mutations.ts";
export * from "./probes-docker.ts";
export * from "./probes-local.ts";

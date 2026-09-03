/**
 * R17 · Sondas locales HONESTAS.
 *
 * Sólo una se puede ejercer sin infraestructura: la escritura en el directorio
 * de datos (se escribe y se relee de verdad, como en `packages/data-dir`). El
 * resto necesitan daemon de contenedores, base de datos o repositorio de
 * copias, y aquí devuelven "no ejercida" CON MOTIVO — jamás verde por omisión.
 *
 * Este fichero es la demostración de la regla: preferimos un NOT_READY honesto
 * a un READY que nadie ha probado.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReadinessProbes } from "./engine.ts";
import { deployedVersionProbe } from "./probes-docker.ts";

const NEEDS_INFRA = "sonda no disponible en este entorno (requiere infraestructura)";

export function localProbes(env: Record<string, string | undefined> = process.env): ReadinessProbes {
  return {
    async dataDirWrite(dir: string) {
      const probe = join(dir, `.r17-readiness-${process.pid}`);
      const payload = `r17 ${Date.now()}`;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(probe, payload, { encoding: "utf8", mode: 0o600 });
        const readBack = readFileSync(probe, "utf8");
        return {
          bytesWritten: Buffer.byteLength(payload),
          readBack: true,
          sameContent: readBack === payload,
        };
      } catch (err) {
        return {
          bytesWritten: 0,
          readBack: false,
          sameContent: false,
          reason: (err as Error).message,
        };
      } finally {
        try {
          rmSync(probe, { force: true });
        } catch {
          /* el fichero de prueba no manda sobre el veredicto */
        }
      }
    },
    async backupLastRun() {
      return {
        ranAt: null,
        exitCode: null,
        snapshotCount: 0,
        lastSnapshotBytes: 0,
        ageHours: null,
        reason: NEEDS_INFRA,
      };
    },
    async backupRestoreDrill() {
      return { attempted: false, restoredBytes: 0, canaryFound: false, reason: NEEDS_INFRA };
    },
    // Única sonda de infraestructura ya implementada de verdad: lee el daemon
    // en SOLO LECTURA. Sin `S9_READINESS_CONTAINER` no observa nada y lo dice.
    deployedVersion: deployedVersionProbe(env.S9_READINESS_CONTAINER ?? ""),
    async secretMounted() {
      return {
        existsOnHost: false,
        mountedInProcess: false,
        readableBytes: 0,
        reason: NEEDS_INFRA,
      };
    },
    async dbCanary() {
      return { queryExecuted: false, canaryRowsSeen: 0, rowsAffected: 0, reason: NEEDS_INFRA };
    },
    async gateState() {
      return {
        envEnabled: false,
        runtimeAdvertisesEnabled: false,
        probedRuntime: false,
        reason: NEEDS_INFRA,
      };
    },
    async diagnosticsBundle() {
      return { generated: false, bytes: 0, secretLikeMatches: 0, reason: NEEDS_INFRA };
    },
  };
}

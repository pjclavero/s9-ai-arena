/**
 * R17 · Sondas locales del asistente. Las de almacenamiento son REALES: se
 * escribe, se relee y se borra de verdad, y se registra el uid/gid del proceso
 * que lo hizo. La de administrador necesita base de datos y aquí devuelve
 * "no ejercida" CON MOTIVO — nunca verde por omisión.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AdminIdentityEffect, FirstRunProbes, StorageKind, StorageWriteEffect } from "./checks.ts";

const NEEDS_INFRA = "sonda no disponible en este entorno (requiere base de datos)";

function processIds(): { uid: number | null; gid: number | null } {
  // En Windows `process.getuid` no existe: sin sujeto, la comprobación no
  // aprueba (queda `not_exercised`), que es el defecto seguro.
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  return { uid, gid };
}

export function localStorageWrite(kind: StorageKind, dir: string): StorageWriteEffect {
  const { uid, gid } = processIds();
  const base: StorageWriteEffect = {
    dir,
    uid,
    gid,
    bytesWritten: 0,
    readBack: false,
    sameContent: false,
    cleanedUp: false,
  };
  if (uid === null || gid === null) return { ...base, reason: "el sistema no expone uid/gid del proceso" };

  const probe = join(dir, `.r17-first-run-${kind}-${process.pid}`);
  const payload = `r17:${kind}:${process.pid}:${Date.now()}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, payload, { encoding: "utf8", mode: 0o600 });
    const written = statSync(probe).size;
    const readBack = readFileSync(probe, "utf8");
    let cleanedUp = false;
    try {
      rmSync(probe, { force: true });
      cleanedUp = true;
    } catch (err) {
      return {
        ...base,
        bytesWritten: written,
        readBack: true,
        sameContent: readBack === payload,
        cleanedUp: false,
        reason: (err as Error).message,
      };
    }
    return {
      ...base,
      bytesWritten: written,
      readBack: true,
      sameContent: readBack === payload,
      cleanedUp,
    };
  } catch (err) {
    try {
      rmSync(probe, { force: true });
    } catch {
      /* el fichero de prueba no manda sobre el veredicto */
    }
    return { ...base, reason: (err as Error).message };
  }
}

export function localFirstRunProbes(): FirstRunProbes {
  return {
    async storageWriteAsProcess(kind: StorageKind, dir: string) {
      return localStorageWrite(kind, dir);
    },
    async adminIdentity(): Promise<AdminIdentityEffect> {
      return { queried: false, adminCount: 0, seededWithRepoCredentials: 0, reason: NEEDS_INFRA };
    },
  };
}

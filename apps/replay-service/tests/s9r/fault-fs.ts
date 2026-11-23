/**
 * V1 REPLAYS PR-3 · Sistema de ficheros REAL (disco temporal) con fallos inyectables, para los
 * tests del grabador y del cableado: ENOSPC/EIO tras N bytes escritos por fichero, escrituras que
 * se ATASCAN (no resuelven hasta `release()`) y `link` que falla. Los fallos son rápidos y
 * deterministas: nada espera a un temporizador largo.
 */
import { nodeFs, type S9rFile, type S9rFs } from "../../src/s9r/io.js";

export interface FaultPlan {
  /** Sólo afecta a rutas que contengan este texto (p. ej. ".s9v.part"). */
  match?: string;
  /** Tras escribir estos bytes en un fichero que casa, cada `write` rechaza con `errCode`. */
  failWriteAfterBytes?: number;
  errCode?: string;
  /** Tras estos bytes, cada `write` queda pendiente hasta `release()`. */
  hangWriteAfterBytes?: number;
  /** `link(..., destino)` rechaza con `errCode` si el destino contiene este texto. */
  failLinkTo?: string;
}

export interface FaultFs extends S9rFs {
  /** Libera las escrituras atascadas (con error, para no dejar nada escrito a medias). */
  release(): void;
  readonly hung: number;
  readonly failedWrites: number;
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} (inyectado)`), { code });
}

export function faultFs(plan: FaultPlan): FaultFs {
  const pending: (() => void)[] = [];
  let failedWrites = 0;
  const code = plan.errCode ?? "ENOSPC";
  const applies = (p: string) => plan.match === undefined || p.includes(plan.match);
  const wrapFile = (path: string, f: S9rFile): S9rFile => {
    let written = 0;
    return {
      ...f,
      async write(buf) {
        if (applies(path)) {
          if (plan.failWriteAfterBytes !== undefined && written + buf.length > plan.failWriteAfterBytes) {
            failedWrites++;
            throw errno(code);
          }
          if (plan.hangWriteAfterBytes !== undefined && written + buf.length > plan.hangWriteAfterBytes) {
            await new Promise<void>((resolve) => pending.push(resolve));
            throw errno("EIO");
          }
        }
        await f.write(buf);
        written += buf.length;
      },
    };
  };
  return {
    ...nodeFs,
    async create(p) {
      return wrapFile(p, await nodeFs.create(p));
    },
    async link(a, b) {
      if (plan.failLinkTo !== undefined && b.includes(plan.failLinkTo)) throw errno(code);
      return nodeFs.link(a, b);
    },
    release() {
      for (const r of pending.splice(0)) r();
    },
    get hung() {
      return pending.length;
    },
    get failedWrites() {
      return failedWrites;
    },
  };
}

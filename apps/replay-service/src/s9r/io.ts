/**
 * Costura mínima con el sistema de ficheros: permite inyectar fallos (ENOSPC, EIO)
 * y contar lecturas en los tests sin tocar el disco real.
 */
import { promises as fsp } from "node:fs";

export interface S9rFile {
  write(buf: Buffer): Promise<void>;
  read(buf: Buffer, position: number): Promise<number>;
  sync(): Promise<void>;
  close(): Promise<void>;
  size(): Promise<number>;
}
export interface S9rFs {
  /** Abre en modo exclusivo ("wx") para escribir. */
  create(path: string): Promise<S9rFile>;
  openRead(path: string): Promise<S9rFile>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** fsync del directorio que contiene `path`. */
  syncDir(dir: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

function wrap(fh: import("node:fs").promises.FileHandle): S9rFile {
  return {
    async write(buf) {
      let off = 0;
      while (off < buf.length) {
        const { bytesWritten } = await fh.write(buf, off, buf.length - off, null);
        off += bytesWritten;
      }
    },
    async read(buf, position) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, position);
      return bytesRead;
    },
    sync: () => fh.sync(),
    close: () => fh.close(),
    size: async () => (await fh.stat()).size,
  };
}

export const nodeFs: S9rFs = {
  create: async (p) => wrap(await fsp.open(p, "wx")),
  openRead: async (p) => wrap(await fsp.open(p, "r")),
  rename: (a, b) => fsp.rename(a, b),
  unlink: (p) => fsp.unlink(p),
  async syncDir(dir) {
    const fh = await fsp.open(dir, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
  async exists(p) {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
};

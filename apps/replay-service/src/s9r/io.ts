/**
 * Costura mínima con el sistema de ficheros: permite inyectar fallos (ENOSPC, EIO)
 * y contar lecturas en los tests sin tocar el disco real.
 */
import { promises as fsp } from "node:fs";

export interface S9rFile {
  write(buf: Buffer): Promise<void>;
  read(buf: Buffer, position: number): Promise<number>;
  sync(): Promise<void>;
  /** ftruncate del fichero abierto para escribir. */
  truncate(len: number): Promise<void>;
  /** pwrite en una posición concreta. */
  writeAt(buf: Buffer, position: number): Promise<void>;
  close(): Promise<void>;
  size(): Promise<number>;
}
export interface S9rFs {
  /** Abre en modo exclusivo ("wx") para escribir. */
  create(path: string): Promise<S9rFile>;
  openRead(path: string): Promise<S9rFile>;
  rename(from: string, to: string): Promise<void>;
  /** Enlace duro: falla con EEXIST si el destino existe (publicación sin sobrescribir). */
  link(from: string, to: string): Promise<void>;
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
        if (bytesWritten === 0) throw Object.assign(new Error("write devolvió 0 bytes"), { code: "EIO" });
        off += bytesWritten;
      }
    },
    async read(buf, position) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, position);
      return bytesRead;
    },
    sync: () => fh.sync(),
    truncate: (len) => fh.truncate(len),
    async writeAt(buf, position) {
      await fh.write(buf, 0, buf.length, position);
    },
    close: () => fh.close(),
    size: async () => (await fh.stat()).size,
  };
}

export const nodeFs: S9rFs = {
  // 0640: legible por el grupo del servicio, nunca por «otros» ni ejecutable.
  create: async (p) => wrap(await fsp.open(p, "wx", 0o640)),
  openRead: async (p) => wrap(await fsp.open(p, "r")),
  rename: (a, b) => fsp.rename(a, b),
  link: (a, b) => fsp.link(a, b),
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

/**
 * H1/H3/H4/H9 · Lectura segura de la contraseña del CLI (sin PostgreSQL: rápido y ligero).
 *
 * Cada garantía lleva el mutante que la protege en scripts/v1-first-admin-mutants.mjs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PassThrough } from "node:stream";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCreateAdminArgs,
  PasswordInputError,
  readPasswordFile,
  readPasswordStdin,
  type TtyLike,
} from "./password-input.js";

const PW = "una-clave-larga-de-prueba-42";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pw-input-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fichero(nombre: string, modo: number): string {
  const f = join(dir, nombre);
  writeFileSync(f, `${PW}\n`);
  chmodSync(f, modo);
  return f;
}

describe("readPasswordFile (H1, H9)", () => {
  it("0600 y 0400 se aceptan", () => {
    expect(readPasswordFile(fichero("ok600", 0o600))).toBe(PW);
    expect(readPasswordFile(fichero("ok400", 0o400))).toBe(PW);
  });

  it.each([0o640, 0o660, 0o604, 0o644, 0o666, 0o610])("permisos %o se rechazan", (modo) => {
    expect(() => readPasswordFile(fichero(`m${modo.toString(8)}`, modo))).toThrow(/permisos .* demasiado abiertos/);
  });

  it("un enlace simbólico se rechaza aunque apunte a un 0600 propio (O_NOFOLLOW)", () => {
    const real = fichero("real600", 0o600);
    const enlace = join(dir, "enlace");
    symlinkSync(real, enlace);
    expect(() => readPasswordFile(enlace)).toThrow(/enlace simbólico/);
  });

  it("un directorio se rechaza con «no es un fichero regular»", () => {
    const d = join(dir, "un-dir");
    mkdirSync(d, { mode: 0o700 });
    expect(() => readPasswordFile(d)).toThrow(/no es un fichero regular/);
  });

  it("un propietario distinto se rechaza", () => {
    const f = fichero("ajeno", 0o600);
    const miUid = process.getuid?.() ?? 0;
    expect(() => readPasswordFile(f, { uid: miUid + 1 })).toThrow(/no pertenece al usuario/);
    expect(readPasswordFile(f, { uid: miUid })).toBe(PW);
  });

  it("fichero inexistente: error de entrada controlado (no ENOENT crudo)", () => {
    expect(() => readPasswordFile(join(dir, "no-existe"))).toThrow(PasswordInputError);
    expect(() => readPasswordFile(join(dir, "no-existe"))).toThrow(/no existe/);
  });
});

describe("readPasswordStdin (H3)", () => {
  function tty(teclas: string[]): { stream: TtyLike; out: string[]; raw: boolean[] } {
    const s = new PassThrough() as unknown as TtyLike & PassThrough;
    const raw: boolean[] = [];
    s.isTTY = true;
    s.setRawMode = (m: boolean) => {
      raw.push(m);
      return s;
    };
    const out: string[] = [];
    queueMicrotask(() => {
      for (const t of teclas) s.write(t);
    });
    return { stream: s, out, raw };
  }

  it("en una TTY pide la contraseña dos veces, en modo raw (sin eco) y sin escribirla en la salida", async () => {
    const { stream, out, raw } = tty([`${PW}\r`, `${PW}\r`]);
    const r = await readPasswordStdin(stream, { write: (x) => out.push(x) });
    expect(r).toBe(PW);
    expect(raw).toContain(true);
    expect(raw[raw.length - 1]).toBe(false);
    expect(out.join("")).not.toContain(PW);
    expect(out.join("")).toMatch(/sin eco/);
  });

  it("en una TTY, dos entradas distintas se rechazan", async () => {
    const { stream, out } = tty([`${PW}\r`, "otra-clave-distinta\r"]);
    await expect(readPasswordStdin(stream, { write: (x) => out.push(x) })).rejects.toThrow(/no coinciden/);
  });

  it("en una TTY, Ctrl-C cancela", async () => {
    const { stream, out } = tty(["abc\u0003"]);
    await expect(readPasswordStdin(stream, { write: (x) => out.push(x) })).rejects.toThrow(/cancelado/);
  });

  it("sin TTY (tubería) lee hasta EOF, sin prompt ni modo raw", async () => {
    const s = new PassThrough() as unknown as TtyLike & PassThrough;
    s.end(`${PW}\n`);
    const out: string[] = [];
    expect(await readPasswordStdin(s, { write: (x) => out.push(x) })).toBe(PW);
    expect(out).toEqual([]);
  });
});

describe("parseCreateAdminArgs (H4)", () => {
  it("no repite en el error lo que haya tras `=` ni lo pegado a -p", () => {
    for (const malo of ["--password-text=SECRETO123", "-pSECRETO123", "-p=SECRETO123"]) {
      let msg = "";
      try {
        parseCreateAdminArgs(["a@b.test", "N", "--password-stdin", malo]);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg, malo).not.toBe("");
      expect(msg, malo).not.toContain("SECRETO123");
    }
  });
});

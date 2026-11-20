/**
 * Lectura de la contraseña del CLI: SOLO stdin o fichero 0600. NUNCA argv
 * (la línea de comandos es visible en `ps` y en el historial).
 */
import { readFileSync, statSync } from "node:fs";

export class PasswordInputError extends Error {}

/** Quita UN salto de línea final (el que añade `echo`/el editor), nada más. */
export function stripTrailingNewline(raw: string): string {
  return raw.replace(/\r?\n$/, "");
}

/** El fichero debe ser regular, del usuario actual y sin permisos para grupo/otros (0600). */
export function readPasswordFile(path: string): string {
  const st = statSync(path);
  if (!st.isFile()) throw new PasswordInputError(`${path}: no es un fichero regular`);
  if ((st.mode & 0o077) !== 0) {
    throw new PasswordInputError(
      `${path}: permisos ${(st.mode & 0o777).toString(8)} demasiado abiertos; exige 0600 (chmod 600)`,
    );
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new PasswordInputError(`${path}: el fichero no pertenece al usuario que ejecuta el comando`);
  }
  return stripTrailingNewline(readFileSync(path, "utf8"));
}

export async function readPasswordStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return stripTrailingNewline(Buffer.concat(chunks).toString("utf8"));
}

export interface CreateAdminArgs {
  email: string;
  displayName: string;
  source: { kind: "stdin" } | { kind: "file"; path: string };
  allowAdditionalAdmin: boolean;
}

/** Analiza los argumentos tras `create-admin`. Rechaza cualquier forma de pasar la contraseña por argv. */
export function parseCreateAdminArgs(argv: string[]): CreateAdminArgs {
  const positional: string[] = [];
  let stdin = false;
  let file: string | null = null;
  let allow = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--password-stdin") stdin = true;
    else if (a === "--password-file") {
      const v = argv[++i];
      if (!v) throw new PasswordInputError("--password-file requiere una ruta");
      file = v;
    } else if (a === "--allow-additional-admin") allow = true;
    else if (/^--?password(=|$)/.test(a) || a === "-p") {
      throw new PasswordInputError(
        "La contraseña NO se pasa por argv: usa --password-stdin o --password-file <ruta 0600>",
      );
    } else if (a.startsWith("-")) throw new PasswordInputError(`Opción desconocida: ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 2) {
    throw new PasswordInputError("Se esperan exactamente <email> <nombre-visible>");
  }
  if (stdin === (file !== null)) {
    throw new PasswordInputError("Indica exactamente una fuente: --password-stdin o --password-file <ruta>");
  }
  return {
    email: positional[0],
    displayName: positional[1],
    source: file !== null ? { kind: "file", path: file } : { kind: "stdin" },
    allowAdditionalAdmin: allow,
  };
}

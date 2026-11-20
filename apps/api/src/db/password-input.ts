/**
 * Lectura de la contraseña del CLI: SOLO stdin o fichero 0600. NUNCA argv
 * (la línea de comandos es visible en `ps` y en el historial).
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

export class PasswordInputError extends Error {}

/** Quita UN salto de línea final (el que añade `echo`/el editor), nada más. */
export function stripTrailingNewline(raw: string): string {
  return raw.replace(/\r?\n$/, "");
}

/**
 * H1 · El fichero se ABRE con O_NOFOLLOW (un enlace simbólico se rechaza) y se valida sobre el
 * DESCRIPTOR ya abierto (`fstat`): regular, del usuario actual y sin permisos de grupo/otros.
 * Así no hay ventana entre «comprobar» y «leer» (TOCTOU). O_NONBLOCK evita colgarse con una FIFO;
 * después `fstat` la descarta por no ser regular.
 * `uid` es inyectable sólo para poder probar el caso «propietario distinto» sin ser root.
 */
export function readPasswordFile(path: string, opts: { uid?: number } = {}): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new PasswordInputError(`${path}: es un enlace simbólico; se rechaza`);
    if (code === "ENOENT") throw new PasswordInputError(`${path}: el fichero no existe`);
    if (code === "EACCES") throw new PasswordInputError(`${path}: sin permiso de lectura`);
    throw new PasswordInputError(`${path}: no se pudo abrir (${code ?? "error"})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new PasswordInputError(`${path}: no es un fichero regular`);
    if ((st.mode & 0o077) !== 0) {
      throw new PasswordInputError(
        `${path}: permisos ${(st.mode & 0o777).toString(8)} demasiado abiertos; exige 0600 (chmod 600)`,
      );
    }
    const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    if (uid !== undefined && st.uid !== uid) {
      throw new PasswordInputError(`${path}: el fichero no pertenece al usuario que ejecuta el comando`);
    }
    return stripTrailingNewline(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

/** Lo mínimo de un stdin interactivo que usamos (inyectable en tests). */
export interface TtyLike extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

/** Lee UNA línea sin eco (modo raw): retroceso borra; Ctrl-C cancela; el eco no se escribe nunca. */
function readHiddenLine(stdin: TtyLike, prompt: string, out: { write(s: string): unknown }): Promise<string> {
  return new Promise((resolve, reject) => {
    out.write(prompt);
    stdin.setRawMode?.(true);
    let buf = "";
    const done = (fn: () => void) => {
      stdin.setRawMode?.(false);
      stdin.removeListener("data", onData);
      (stdin as unknown as { pause?: () => void }).pause?.();
      out.write("\n");
      fn();
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(() => resolve(buf));
        if (ch === "\u0003") return done(() => reject(new PasswordInputError("cancelado por el usuario")));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
    (stdin as unknown as { resume?: () => void }).resume?.();
  });
}

/**
 * H3 · Con stdin en una TTY pide la contraseña SIN eco y la confirma; si no es una TTY
 * (tubería o redirección) la lee entera hasta EOF, como siempre.
 */
export async function readPasswordStdin(
  stream: TtyLike = process.stdin,
  out: { write(s: string): unknown } = process.stderr,
): Promise<string> {
  if (stream.isTTY) {
    const first = await readHiddenLine(stream, "Contraseña (sin eco): ", out);
    const second = await readHiddenLine(stream, "Repite la contraseña: ", out);
    if (first !== second) throw new PasswordInputError("las dos contraseñas no coinciden");
    return first;
  }
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
    } else if (a.startsWith("-")) {
      // No se repite lo que haya tras `=`: podría ser un secreto mal tecleado (H4).
      throw new PasswordInputError(`Opción desconocida: ${a.split("=")[0]}`);
    } else positional.push(a);
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

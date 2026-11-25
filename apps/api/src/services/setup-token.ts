/**
 * V1 ADM-SETUP (D-OP-44) · Token de instalación del asistente de primer arranque.
 *
 * Es un secreto Docker (`setup_token`, fichero `secrets/setup_token.txt` que genera
 * `infrastructure/scripts/init-secrets.sh`) montado SÓLO en `api` en `/run/secrets/setup_token`.
 * Sólo lo lee quien tiene el host, que es el operador técnico de la instalación: pegarlo en
 * `#/setup` es la prueba de que quien crea el primer administrador controla la máquina.
 *
 * Garantías (cada una con su test en `setup-web.test.ts` y su mutante en `scripts/v1-web-setup-mutants.mjs`):
 *  - el token NUNCA se escribe en el log ni en la auditoría: sólo su HUELLA (`sha256:` + 12 hex);
 *  - la comparación es en tiempo constante (`timingSafeEqual` sobre los sha256);
 *  - un fichero ausente, vacío, que no es regular o demasiado grande ⇒ token ausente (asistente cerrado);
 *  - el fichero se relee en cada consulta: vaciarlo cierra el asistente sin reiniciar.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";

/** Ruta por defecto del secreto dentro del contenedor `api`. */
export const DEFAULT_SETUP_TOKEN_FILE = "/run/secrets/setup_token";
/** Un token legítimo mide 40 caracteres; nada razonable pasa de 256 bytes. */
const MAX_TOKEN_BYTES = 256;

/** Fuente del token: devuelve el token (sin espacios finales) o `null` si no hay. */
export type SetupTokenSource = () => string | null;

/**
 * Lee el token del fichero. Lo abre con O_NOFOLLOW|O_NONBLOCK y valida el DESCRIPTOR (fichero
 * regular), como `db/password-input.ts`. No exige 0600: el secreto lo monta Docker con los
 * permisos del host (0400, uid del runtime). Cualquier fallo ⇒ `null` (asistente cerrado).
 */
export function readSetupTokenFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size === 0 || st.size > MAX_TOKEN_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    const token = buf.subarray(0, n).toString("utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Fuente de producción: `SETUP_TOKEN_FILE` o la ruta por defecto. */
export function setupTokenSourceFromEnv(env: NodeJS.ProcessEnv = process.env): SetupTokenSource {
  const path = env.SETUP_TOKEN_FILE || DEFAULT_SETUP_TOKEN_FILE;
  return () => readSetupTokenFile(path);
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** Huella pública del token: permite al operador comprobar que pega el fichero correcto. */
export function setupTokenFingerprint(token: string): string {
  return `sha256:${sha256(token).toString("hex").slice(0, 12)}`;
}

/** Comparación en tiempo constante (longitudes iguales por construcción: ambos son sha256). */
export function setupTokenMatches(expected: string, presented: unknown): boolean {
  if (typeof presented !== "string" || presented.length === 0 || presented.length > MAX_TOKEN_BYTES) return false;
  return timingSafeEqual(sha256(expected), sha256(presented.trim()));
}

/**
 * Mensaje de arranque con el asistente abierto. Lleva la HUELLA, nunca el token.
 * `publicUrl` es opcional: sin ella se indica sólo la ruta `#/setup`.
 */
export function setupBannerLines(token: string, publicUrl?: string): string[] {
  const where = publicUrl ? `${publicUrl.replace(/\/+$/, "")}/#/setup` : "la web de la plataforma, ruta #/setup";
  return [
    "[setup] Primer arranque: no hay ningún administrador.",
    `[setup] Abre ${where} y pega el contenido de secrets/setup_token.txt (huella ${setupTokenFingerprint(token)}).`,
    "[setup] El token no aparece en este log. El asistente se cierra para siempre al crear el primer administrador.",
  ];
}

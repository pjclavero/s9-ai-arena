/**
 * R2.6 · ERR-SEC-09 — Saneado de nombres de fichero subidos y emisión segura
 * de Content-Disposition (RFC 6266 + RFC 5987).
 *
 * `file.originalname` lo controla el cliente: comillas y CRLF interpolados a
 * pelo en la cabecera permitían spoofing del nombre de descarga o un 500.
 * Regla: el nombre se normaliza AL RECIBIRLO (base, allowlist, longitud) y la
 * cabecera se construye SIEMPRE con codificación estándar de parámetros, con
 * nombre por defecto derivado del id de versión.
 */

/** Longitud máxima del nombre almacenado/emitido. */
export const MAX_FILENAME_LENGTH = 100;

/** Allowlist de caracteres del nombre saneado. Todo lo demás se sustituye por `_`. */
const DISALLOWED = /[^A-Za-z0-9._-]+/g;

/**
 * Sanea un nombre de fichero subido:
 *  - solo la base (se descarta cualquier ruta, con `/` o `\`)
 *  - allowlist `[A-Za-z0-9._-]` (el resto colapsa a `_`)
 *  - sin puntos iniciales (nada de ocultos ni `..`), longitud acotada
 * Devuelve null si no queda nada utilizable (el llamante aplicará el defecto).
 */
export function sanitizeSourceFilename(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(DISALLOWED, "_").replace(/^[._]+/, "");
  if (cleaned.length === 0) return null;
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;
  // Recorte conservando la extensión si es razonable.
  const dot = cleaned.lastIndexOf(".");
  if (dot > 0 && cleaned.length - dot <= 16) {
    const ext = cleaned.slice(dot);
    return cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }
  return cleaned.slice(0, MAX_FILENAME_LENGTH);
}

/** Percent-encoding de RFC 5987 (attr-char): más estricto que encodeURIComponent. */
function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Construye el valor de `Content-Disposition: attachment` con la codificación
 * estándar de parámetros (RFC 6266/5987): fallback ASCII entre comillas (sin
 * comillas, backslash ni caracteres de control posibles) + `filename*` UTF-8.
 * El resultado NUNCA contiene CR/LF: no hay inyección de cabeceras posible.
 */
export function contentDispositionAttachment(filename: string): string {
  // Fallback ASCII: fuera control, comillas y backslash; no vacío.
  // eslint-disable-next-line no-control-regex
  const ascii = filename.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(filename)}`;
}

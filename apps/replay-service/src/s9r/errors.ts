/**
 * S9R/1 · Errores tipados. Todo fallo de la biblioteca es una `S9rError` con un
 * `code` estable; los llamadores deciden la política por clase (nunca por mensaje).
 */
export class S9rError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
    this.code = code;
  }
}

/** El fichero no tiene pie válido: es un parcial y nadie debe tratarlo como publicado. */
export class IncompleteReplayError extends S9rError {}
/** Bytes que no cuadran con su crc, sha256, geometría o cadena. */
export class CorruptReplayError extends S9rError {}
/** Versión mayor o algoritmo que este lector no entiende. */
export class UnsupportedFormatError extends S9rError {}
/** Registro inválido (no es una línea, demasiado grande). */
export class InvalidRecordError extends S9rError {}
/** Clase A: el tope de bytes de la batalla se habría superado. Determinista; no envenena el escritor. */
export class ReplayLimitExceededError extends S9rError {
  readonly limit: number;
  readonly attempted: number;
  constructor(limit: number, attempted: number) {
    super("limit_exceeded", `tope de bytes excedido: ${attempted} > ${limit}`);
    this.limit = limit;
    this.attempted = attempted;
  }
}
/** Clase B: fallo del entorno de almacenamiento. Envenena el escritor. */
export class StorageError extends S9rError {
  readonly op: string;
  readonly errno: string | undefined;
  constructor(code: string, op: string, cause: unknown) {
    super(code, `fallo de almacenamiento en ${op}: ${(cause as Error)?.message ?? cause}`, { cause });
    this.op = op;
    this.errno = (cause as NodeJS.ErrnoException)?.code;
  }
}
export class StorageFullError extends StorageError {}
export class StorageIoError extends StorageError {}
/** El escritor ya se cerró, abortó o falló. */
export class WriterStateError extends S9rError {}

/** ENOSPC/EDQUOT -> disco lleno; EIO -> error de E/S; resto -> StorageError genérico. */
export function toStorageError(err: unknown, op: string): StorageError {
  if (err instanceof StorageError) return err;
  const c = (err as NodeJS.ErrnoException)?.code;
  if (c === "ENOSPC" || c === "EDQUOT") return new StorageFullError("storage_full", op, err);
  if (c === "EIO") return new StorageIoError("storage_io", op, err);
  return new StorageError("storage_error", op, err);
}

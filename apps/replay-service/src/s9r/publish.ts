/**
 * S9R/1 · Publicación atómica y SIN sobrescribir, desde `.partial`.
 *
 * `link(parcial, final)` crea el nombre final de forma atómica y falla con EEXIST si ya
 * existe (a diferencia de `rename`, que sobrescribe en POSIX y obligaría a un `exists()`
 * previo con carrera). Después se quita el nombre del parcial: ambos apuntan al mismo
 * fichero ya cerrado y con `fsync`, así que en ningún instante hay un final incompleto.
 * Si el `unlink` del parcial falla, la publicación YA ocurrió: queda un parcial redundante
 * que el janitor limpia (no se devuelve error). Se sincroniza el directorio del destino y,
 * si es otro, también el del parcial.
 *
 * Con vista y receta se publica la VISTA primero y la RECETA al final: la presencia de la
 * receta equivale a «publicado». Si falla la receta, la vista queda sin receta (huérfana:
 * la limpia el janitor; no se deshace aquí).
 */
import { dirname } from "node:path";
import { TruncatedReplayError, WriterStateError, toStorageError } from "./errors.js";
import { S9rReader } from "./reader.js";
import { verifyFile } from "./verify.js";
import { nodeFs, type S9rFs } from "./io.js";

export interface PublishOptions {
  fs?: S9rFs;
  /** Publica un replay truncado (clase A). Explícito y nombrado: por defecto se rechaza. */
  allowTruncated?: boolean;
  /** Si se indica, se hace una verificación COMPLETA (sha256 del fichero incluido) antes de publicar. */
  expectSha256?: string;
}

/**
 * Comprobación OBLIGATORIA previa a publicar: el fichero debe tener pie válido, índice y
 * cadena correctos (`S9rReader.open`). Un parcial sin pie o corrupto lanza
 * `IncompleteReplayError`/`CorruptReplayError`; un truncado lanza `TruncatedReplayError`
 * salvo `allowTruncated`. Con `expectSha256` se verifica además todo el fichero.
 */
export async function assertPublishable(path: string, opts: PublishOptions = {}): Promise<void> {
  const r = await S9rReader.open(path, { fs: opts.fs });
  const truncated = r.truncated;
  await r.close();
  if (truncated && !opts.allowTruncated) {
    throw new TruncatedReplayError("truncated", "replay truncado: no se publica sin allowTruncated explícito");
  }
  if (opts.expectSha256 !== undefined) {
    const v = await verifyFile(path, {
      fs: opts.fs,
      expectSha256: opts.expectSha256,
      allowTruncated: opts.allowTruncated,
    });
    if (!v.ok) throw v.error!;
  }
}

export async function publishPartial(partialPath: string, finalPath: string, opts: PublishOptions = {}): Promise<void> {
  const fs = opts.fs ?? nodeFs;
  await assertPublishable(partialPath, opts);
  await linkPublish(partialPath, finalPath, fs);
}

async function linkPublish(partialPath: string, finalPath: string, fs: S9rFs): Promise<void> {
  try {
    await fs.link(partialPath, finalPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new WriterStateError("final_exists", "el destino ya existe: no se sobrescribe un replay publicado");
    }
    throw toStorageError(e, "link");
  }
  try {
    await fs.unlink(partialPath);
  } catch {
    /* publicado; el parcial redundante lo limpia el janitor */
  }
  try {
    await fs.syncDir(dirname(finalPath));
    if (dirname(partialPath) !== dirname(finalPath)) await fs.syncDir(dirname(partialPath));
  } catch (e) {
    throw toStorageError(e, "fsync_dir");
  }
}

export interface PublishPair {
  recipe: { partial: string; final: string };
  view?: { partial: string; final: string };
}

/** Vista primero, receta al final. */
export async function publishPair(pair: PublishPair, opts: PublishOptions = {}): Promise<void> {
  const fs = opts.fs ?? nodeFs;
  // Se comprueban AMBOS antes de publicar nada: no se deja una vista publicada con receta inválida.
  if (pair.view) await assertPublishable(pair.view.partial, { ...opts, expectSha256: undefined });
  await assertPublishable(pair.recipe.partial, opts);
  if (pair.view) await linkPublish(pair.view.partial, pair.view.final, fs);
  await linkPublish(pair.recipe.partial, pair.recipe.final, fs);
}

/** Borra un parcial; idempotente. */
export async function discardPartial(partialPath: string, opts: { fs?: S9rFs } = {}): Promise<void> {
  const fs = opts.fs ?? nodeFs;
  try {
    await fs.unlink(partialPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw toStorageError(e, "unlink");
  }
}

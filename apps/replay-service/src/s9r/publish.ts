/**
 * S9R/1 · Publicación por `rename` atómico desde `.partial`.
 *
 * Antes del `rename` nadie ve nada; tras él el fichero es completo (el escritor ya hizo
 * `fsync`). Con vista y receta, se publica la VISTA primero y la RECETA al final: la
 * presencia de la receta equivale a "publicado".
 */
import { dirname } from "node:path";
import { StorageError, WriterStateError, toStorageError } from "./errors.js";
import { nodeFs, type S9rFs } from "./io.js";

export async function publishPartial(partialPath: string, finalPath: string, opts: { fs?: S9rFs } = {}): Promise<void> {
  const fs = opts.fs ?? nodeFs;
  if (await fs.exists(finalPath)) throw new WriterStateError("final_exists", "el destino ya existe: no se sobrescribe un replay publicado");
  try {
    await fs.rename(partialPath, finalPath);
  } catch (e) {
    throw toStorageError(e, "rename");
  }
  try {
    await fs.syncDir(dirname(finalPath));
  } catch (e) {
    throw toStorageError(e, "fsync_dir");
  }
}

export interface PublishPair {
  recipe: { partial: string; final: string };
  view?: { partial: string; final: string };
}

/** Vista primero, receta al final. Si algo falla, la receta no queda publicada. */
export async function publishPair(pair: PublishPair, opts: { fs?: S9rFs } = {}): Promise<void> {
  if (pair.view) await publishPartial(pair.view.partial, pair.view.final, opts);
  await publishPartial(pair.recipe.partial, pair.recipe.final, opts);
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

export { StorageError };

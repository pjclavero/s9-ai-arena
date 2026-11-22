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
import { WriterStateError, toStorageError } from "./errors.js";
import { nodeFs, type S9rFs } from "./io.js";

export async function publishPartial(partialPath: string, finalPath: string, opts: { fs?: S9rFs } = {}): Promise<void> {
  const fs = opts.fs ?? nodeFs;
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

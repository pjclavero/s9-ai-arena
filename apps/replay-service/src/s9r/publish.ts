/**
 * S9R/1 · Publicación atómica y SIN sobrescribir, desde `.part`.
 *
 * `link(parcial, final)` crea el nombre final de forma atómica y falla con EEXIST si ya
 * existe (a diferencia de `rename`, que sobrescribe). Los parciales sólo se quitan cuando
 * todos los finales están enlazados y sincronizados; si algo falla se deshacen los enlaces
 * ya hechos (TODO o NADA, también en `publishPair`). Con vista y receta se enlaza la VISTA
 * primero y la RECETA al final: la presencia de la receta equivale a «publicado».
 */
import { dirname } from "node:path";
import { CorruptReplayError, TruncatedReplayError, WriterStateError, toStorageError } from "./errors.js";
import { nodeFs, type S9rFs } from "./io.js";
import { S9rReader } from "./reader.js";
import { verifyFile } from "./verify.js";
import { isIssuedSummary, type WriteSummary } from "./writer.js";

export interface PublishOptions {
  fs?: S9rFs;
  /** Publica un replay truncado (clase A). Explícito y nombrado: por defecto se rechaza. */
  allowTruncated?: boolean;
  /**
   * PRUEBA DE CIERRE de la RECETA, exigida SIEMPRE: el `WriteSummary` que devolvió
   * `close()`/`closeTruncated()` del escritor de ese parcial. Es un objeto emitido y registrado
   * por el módulo (no se puede fabricar ni copiar) y su `path` y `sha256` se validan contra el
   * fichero. Un escritor cuyo cierre falló no tiene `summary`: nunca puede publicarse, aunque un
   * fallo total del almacenamiento hubiera dejado un pie válido con nombre `.part`.
   */
  proof?: WriteSummary;
  /** Idem para la VISTA en `publishPair`. */
  viewProof?: WriteSummary;
  /**
   * SÓLO tests y diagnóstico: publica sin prueba de cierre (se siguen aplicando las comprobaciones
   * de nombre, pie, cadena y truncado). Nunca debe usarse en el camino de producción.
   */
  unsafeSkipProof?: boolean;
}

/**
 * Comprobación OBLIGATORIA previa a publicar. El origen debe ser un `.part` (nunca un `.failed`
 * ni un fichero final). Después se exige la PRUEBA DE CIERRE (`proof`): un `WriteSummary` emitido
 * por un escritor que cerró bien, con el mismo `path`, cuyo `sha256` se verifica sobre el fichero
 * entero. Luego `S9rReader.open` (pie, índice, cadena): un parcial sin pie da
 * `IncompleteReplayError`, uno corrupto `CorruptReplayError`, un truncado `TruncatedReplayError`
 * salvo `allowTruncated`.
 * Nota: la comprobación y el `link` son por ruta; el directorio de parciales debe ser privado
 * del servicio (no hay protección frente a otro proceso que lo reemplace entre ambos pasos).
 */
export async function assertPublishable(
  path: string,
  opts: PublishOptions = {},
  proof: WriteSummary | undefined = opts.proof,
): Promise<void> {
  if (path.endsWith(".failed")) throw new CorruptReplayError("failed_file", "fichero .failed: nunca se publica");
  if (!path.endsWith(".part")) throw new WriterStateError("not_a_partial", "sólo se publican orígenes .part");
  if (!opts.unsafeSkipProof) {
    if (proof === undefined) {
      throw new WriterStateError(
        "proof_required",
        "se exige la prueba del cierre (el summary de close/closeTruncated)",
      );
    }
    if (!isIssuedSummary(proof)) {
      throw new WriterStateError("proof_invalid", "la prueba no es un summary emitido por un escritor que cerró bien");
    }
    if (proof.path !== path) throw new WriterStateError("proof_mismatch", "la prueba pertenece a otro fichero");
  }
  const r = await S9rReader.open(path, { fs: opts.fs });
  const truncated = r.truncated;
  await r.close();
  if (truncated && !opts.allowTruncated) {
    throw new TruncatedReplayError("truncated", "replay truncado: no se publica sin allowTruncated explícito");
  }
  if (!opts.unsafeSkipProof) {
    const v = await verifyFile(path, { fs: opts.fs, expectSha256: proof!.sha256, allowTruncated: opts.allowTruncated });
    if (!v.ok) throw v.error!;
  }
}

interface Item {
  partial: string;
  final: string;
}

/**
 * Publica TODOS o NINGUNO: se enlazan los finales en orden; si falla uno (o el fsync de
 * directorios), se deshacen los ya enlazados (los parciales siguen intactos) y se relanza.
 * Los parciales sólo se quitan cuando todo está enlazado y sincronizado.
 */
async function publishAll(items: Item[], fs: S9rFs): Promise<void> {
  const linked: string[] = [];
  const rollback = async () => {
    for (const f of linked.reverse()) await fs.unlink(f).catch(() => undefined);
  };
  try {
    for (const it of items) {
      try {
        await fs.link(it.partial, it.final);
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
          throw new WriterStateError("final_exists", "el destino ya existe: no se sobrescribe un replay publicado");
        }
        throw toStorageError(e, "link");
      }
      linked.push(it.final);
    }
    try {
      for (const dir of new Set(items.map((i) => dirname(i.final)))) await fs.syncDir(dir);
    } catch (e) {
      throw toStorageError(e, "fsync_dir");
    }
  } catch (e) {
    await rollback();
    throw e;
  }
  // Publicado: quitar los nombres de los parciales (si falla, el janitor limpia el redundante).
  for (const it of items) await fs.unlink(it.partial).catch(() => undefined);
  const partialDirs = new Set(
    items.map((i) => dirname(i.partial)).filter((d) => !items.some((i) => dirname(i.final) === d)),
  );
  for (const dir of partialDirs) await fs.syncDir(dir).catch(() => undefined);
}

export async function publishPartial(partialPath: string, finalPath: string, opts: PublishOptions = {}): Promise<void> {
  const fs = opts.fs ?? nodeFs;
  await assertPublishable(partialPath, opts, opts.proof);
  await publishAll([{ partial: partialPath, final: finalPath }], fs);
}

export interface PublishPair {
  recipe: { partial: string; final: string };
  view?: { partial: string; final: string };
}

/** Vista primero, receta al final; ATÓMICO: si algo falla no queda publicado ninguno de los dos. */
export async function publishPair(pair: PublishPair, opts: PublishOptions = {}): Promise<void> {
  const fs = opts.fs ?? nodeFs;
  // Se comprueban AMBOS antes de publicar nada.
  if (pair.view) await assertPublishable(pair.view.partial, opts, opts.viewProof);
  await assertPublishable(pair.recipe.partial, opts, opts.proof);
  await publishAll([...(pair.view ? [pair.view] : []), pair.recipe], fs);
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

/**
 * EQ5b · §7/§8 · Grabaciones MP4 del modo `record` y su retención.
 *
 * Reglas DURAS de la retención (encargo §8):
 *  - sólo se consideran ficheros REGULARES (lstat, nunca enlaces) directamente
 *    en el directorio de grabación, sin recursión, cuyo nombre es exactamente
 *    el que produce ffmpeg.ts (`broadcast-<ISO>.mp4`);
 *  - NUNCA el fichero que se está grabando;
 *  - NUNCA replays ni ningún otro fichero (los replays viven en el directorio
 *    PADRE del volumen: aquí no se sale de `recordDir`);
 *  - cada borrado se devuelve con nombre, tamaño, fecha y motivo para que la API
 *    lo audite (el streamer no tiene BD).
 */
import { lstatSync, readdirSync, statfsSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

export const RECORDING_NAME = /^broadcast-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.mp4$/;

export interface RecordingInfo {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  inProgress: boolean;
}

export interface RecordingsView {
  files: RecordingInfo[];
  count: number;
  totalBytes: number;
  disk: { totalBytes: number; freeBytes: number } | null;
}

function scan(dir: string, inProgress: string | null): (RecordingInfo & { mtimeMs: number })[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const current = inProgress ? basename(inProgress) : null;
  const out: (RecordingInfo & { mtimeMs: number })[] = [];
  for (const name of names) {
    if (!RECORDING_NAME.test(name)) continue;
    let st;
    try {
      st = lstatSync(join(dir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue; // ni enlaces, ni directorios, ni dispositivos
    out.push({
      name,
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
      mtimeMs: st.mtimeMs,
      inProgress: name === current,
    });
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export function listRecordings(dir: string, inProgress: string | null): RecordingsView {
  const files = scan(dir, inProgress);
  let disk: RecordingsView["disk"] = null;
  try {
    const s = statfsSync(dir);
    disk = { totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize) };
  } catch {
    disk = null;
  }
  return {
    files: files.map(({ mtimeMs: _m, ...f }) => f),
    count: files.length,
    totalBytes: files.reduce((a, f) => a + f.sizeBytes, 0),
    disk,
  };
}

export interface RetentionPolicy {
  /** Días de antigüedad máxima (null = sin límite por edad). */
  maxAgeDays: number | null;
  /** Tamaño total máximo de las grabaciones en bytes (null = sin límite). */
  maxTotalBytes: number | null;
}

export interface RetentionDeletion {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  reason: "age" | "size";
}

export interface RetentionResult {
  dryRun: boolean;
  deleted: RetentionDeletion[];
  errors: { name: string; error: string }[];
  keptCount: number;
  keptBytes: number;
}

export function validateRetentionPolicy(p: unknown): RetentionPolicy | string {
  if (!p || typeof p !== "object") return "política de retención inválida";
  const o = p as Record<string, unknown>;
  const age = o.maxAgeDays ?? null;
  const size = o.maxTotalBytes ?? null;
  if (age !== null && (!Number.isInteger(age) || (age as number) < 1 || (age as number) > 3650)) {
    return "maxAgeDays debe ser un entero entre 1 y 3650";
  }
  if (size !== null && (!Number.isSafeInteger(size) || (size as number) < 1024 * 1024)) {
    return "maxTotalBytes debe ser un entero de al menos 1 MiB";
  }
  if (age === null && size === null) return "la política necesita edad o tamaño máximo";
  return { maxAgeDays: age as number | null, maxTotalBytes: size as number | null };
}

/** Aplica la política. `dryRun` calcula sin borrar. */
export function applyRetention(
  dir: string,
  policy: RetentionPolicy,
  inProgress: string | null,
  opts: { now?: number; dryRun?: boolean; unlink?: (path: string) => void } = {},
): RetentionResult {
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun === true;
  const unlink = opts.unlink ?? unlinkSync;
  const all = scan(dir, inProgress);
  const candidates = all.filter((f) => !f.inProgress);
  const plan: RetentionDeletion[] = [];
  const doomed = new Set<string>();

  if (policy.maxAgeDays !== null) {
    const limit = now - policy.maxAgeDays * 86_400_000;
    for (const f of candidates) {
      if (f.mtimeMs < limit) {
        plan.push({ name: f.name, sizeBytes: f.sizeBytes, modifiedAt: f.modifiedAt, reason: "age" });
        doomed.add(f.name);
      }
    }
  }
  if (policy.maxTotalBytes !== null) {
    // El fichero en curso cuenta para el total aunque no se pueda borrar.
    let total = all.filter((f) => !doomed.has(f.name)).reduce((a, f) => a + f.sizeBytes, 0);
    for (const f of candidates) {
      if (total <= policy.maxTotalBytes) break;
      if (doomed.has(f.name)) continue;
      plan.push({ name: f.name, sizeBytes: f.sizeBytes, modifiedAt: f.modifiedAt, reason: "size" });
      doomed.add(f.name);
      total -= f.sizeBytes;
    }
  }

  const deleted: RetentionDeletion[] = [];
  const errors: { name: string; error: string }[] = [];
  for (const d of plan) {
    if (dryRun) {
      deleted.push(d);
      continue;
    }
    const path = join(dir, d.name);
    try {
      // Re-comprobación justo antes de borrar: sigue siendo un fichero regular.
      if (!lstatSync(path).isFile()) throw new Error("ya no es un fichero regular");
      unlink(path);
      deleted.push(d);
    } catch (e) {
      errors.push({ name: d.name, error: (e as Error).message.slice(0, 200) });
    }
  }
  const kept = all.filter((f) => !deleted.some((d) => d.name === f.name));
  return {
    dryRun,
    deleted,
    errors,
    keptCount: kept.length,
    keptBytes: kept.reduce((a, f) => a + f.sizeBytes, 0),
  };
}

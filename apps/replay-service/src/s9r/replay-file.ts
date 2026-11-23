/**
 * V1 REPLAYS PR-4/PR-4b · Un `Replay` en memoria ⇄ un replay S9R/1 en disco, para HERRAMIENTAS de
 * desarrollo (CLI del motor, smoke) y tests. NO es un lector de producción: `readS9rReplay` carga
 * el replay entero (los lectores del producto son RecipeCursor/ViewReader, por fragmentos).
 *
 * `writeS9rReplay` graba un replay PUBLICADO (receta `.s9r` + vista `.s9v`) con el MISMO grabador
 * y la MISMA publicación que el worker (`ReplayRecorder` + `publishPair` con prueba de cierre).
 * Sustituye a `ingestReplay`/`toJsonl` (JSONL v2, retirados por D-OP-30). Devuelve lo que la fila
 * `battles` guarda: `path` (receta) y `sha256`.
 *
 * Orden de emisión: como el motor, por tick; dentro de un tick, comandos antes que hash y
 * checkpoint (receta) y eventos antes que el snapshot (vista).
 */
import type { Replay } from "../../../arena-engine/src/replay.js";
import { ReplayRecorder } from "./recorder.js";
import { publishPair } from "./publish.js";
import { existsSync } from "node:fs";
import { RecipeCursor, forEachRecipeCommand } from "./recipe.js";
import { ViewReader } from "./view.js";
import { completenessProblems } from "./completeness.js";

export interface S9rFixture {
  path: string;
  sha256: string;
  viewPath: string;
  viewSha256: string;
  bytes: number;
  recipeBytes: number;
  viewBytes: number;
  chain: string;
  viewChain: string;
  ticks: number;
  attempt: number;
}

/**
 * V1 REPLAYS PR-4b · Validación de completitud de un `Replay` en memoria (antes `validateReplay` de
 * store.ts, la puerta de la ingesta retirada): la MISMA puerta que el worker aplica a su grabación
 * (`completenessProblems`, completeness.ts). Lista de problemas; vacía = almacenable. La usan las herramientas
 * que sustituyen a la ingesta (CLI del motor, arnés de smoke) con `writeS9rReplay(…, {validate:true})`.
 */
export function validateReplay(replay: Replay): string[] {
  return completenessProblems({
    header: replay.header,
    stateHashes: Array.isArray(replay.stateHashes) ? replay.stateHashes.length : 0,
    checkpoints: Array.isArray(replay.checkpoints) ? replay.checkpoints.length : 0,
    snapshots: Array.isArray(replay.snapshots) ? replay.snapshots.length : 0,
    finalStateHash: replay.result?.finalStateHash,
  });
}

export async function writeS9rReplay(
  dir: string,
  replay: Replay,
  opts: {
    battleId?: string;
    attempt?: number;
    recipeFragmentBytes?: number;
    viewFragmentBytes?: number;
    /** true: rechaza (sin escribir nada) un replay incompleto según `validateReplay`. */
    validate?: boolean;
  } = {},
): Promise<S9rFixture> {
  if (opts.validate) {
    const problems = validateReplay(replay);
    if (problems.length) throw new Error(`replay inválido, no se almacena: ${problems.join("; ")}`);
  }
  const battleId = opts.battleId ?? String(replay.header.battleId).replace(/[^0-9A-Za-z_-]/g, "_");
  const rec = await ReplayRecorder.create({
    dir,
    battleId,
    attempt: opts.attempt ?? 1,
    owner: "fixture",
    recipeHeader: replay.header as unknown as Record<string, unknown>,
    viewHeader: {
      battleId: replay.header.battleId,
      map: replay.header.map,
      roster: (replay.header.participants ?? []).map((p: any) => ({
        id: String(p.id),
        botId: String(p.botId ?? ""),
        team: String(p.team ?? ""),
        ...(typeof p.spec?.chassisId === "string" ? { chassis: p.spec.chassisId } : {}),
      })),
    },
    checkpointEveryNTicks: replay.header.cadences?.checkpointEveryNTicks ?? 300,
    ...(opts.recipeFragmentBytes ? { recipeFragmentBytes: opts.recipeFragmentBytes } : {}),
    ...(opts.viewFragmentBytes ? { viewFragmentBytes: opts.viewFragmentBytes } : {}),
    // Los tests escriben de golpe (sin motor que ceda): colas holgadas, siguen acotadas.
    recipeMaxPendingBytes: 64 * 1024 * 1024,
    viewMaxPendingBytes: 64 * 1024 * 1024,
  });
  const recipe: { t: number; o: number; f: () => void }[] = [];
  replay.commands.forEach((c, i) => recipe.push({ t: c.tick, o: 0 + i * 1e-9, f: () => rec.command(c) }));
  (replay.stateHashes ?? []).forEach((h) => recipe.push({ t: h.tick, o: 1, f: () => rec.hash(h) }));
  (replay.checkpoints ?? []).forEach((k) => recipe.push({ t: k.tick, o: 2, f: () => rec.checkpoint(k as any) }));
  const view: { t: number; o: number; f: () => void }[] = [];
  (replay.events ?? []).forEach((e, i) => view.push({ t: Number(e?.tick) || 0, o: i * 1e-9, f: () => rec.event(e) }));
  (replay.snapshots ?? []).forEach((s) => view.push({ t: Number(s?.tick) || 0, o: 1, f: () => rec.snapshot(s) }));
  for (const list of [recipe, view]) {
    list.sort((a, b) => a.t - b.t || a.o - b.o);
    let n = 0;
    for (const x of list) {
      x.f();
      if (++n % 2000 === 0) await rec.drain();
    }
  }
  const closed = await rec.finish(replay.result as unknown as Record<string, unknown>);
  await publishPair(
    {
      recipe: { partial: closed.recipe.partial, final: closed.recipe.final },
      view: { partial: closed.view.partial, final: closed.view.final },
    },
    { proof: closed.recipe.summary, viewProof: closed.view.summary },
  );
  return {
    path: closed.recipe.final,
    sha256: closed.recipe.summary.sha256,
    viewPath: closed.view.final,
    viewSha256: closed.view.summary.sha256,
    bytes: closed.recipe.summary.bytes + closed.view.summary.bytes,
    recipeBytes: closed.recipe.summary.bytes,
    viewBytes: closed.view.summary.bytes,
    chain: closed.recipe.summary.chain,
    viewChain: closed.view.summary.chain,
    ticks: Number(replay.result?.ticks ?? 0),
    attempt: opts.attempt ?? 1,
  };
}

/**
 * Lee un replay S9R/1 ENTERO a un `Replay` en memoria (receta y, si existe, vista). Sólo
 * herramientas y tests: el producto lee por fragmentos.
 */
export async function readS9rReplay(recipePath: string): Promise<Replay> {
  const cursor = await RecipeCursor.open(recipePath);
  const header = { ...cursor.header };
  delete header.s9r;
  const result = cursor.result;
  await cursor.close();
  const commands: Replay["commands"] = [];
  await forEachRecipeCommand(recipePath, (c) => commands.push(c));
  const off = await RecipeCursor.open(recipePath);
  const { stateHashes, checkpoints } = await off.official();
  await off.close();
  const snapshots: any[] = [];
  const events: any[] = [];
  const viewPath = recipePath.replace(/\.s9r$/, ".s9v");
  if (existsSync(viewPath)) {
    const view = await ViewReader.open(viewPath);
    try {
      for await (const r of view.records()) (r.k === "s" ? snapshots : events).push(r.k === "s" ? r.frame : r.event);
    } finally {
      await view.close();
    }
  }
  return { header, commands, events, snapshots, stateHashes, checkpoints, result } as Replay;
}

/**
 * V1 REPLAYS PR-4 · SÓLO TESTS. Graba un `Replay` ya en memoria como un replay S9R/1 PUBLICADO
 * (receta `.s9r` + vista `.s9v`) con el MISMO grabador y la MISMA publicación que el worker
 * (`ReplayRecorder` + `publishPair` con prueba de cierre). Sustituye a `ingestReplay` (JSONL v2,
 * retirado por D-OP-30) en los tests que necesitan un replay en disco para la API o las
 * estadísticas. Devuelve lo que la fila `battles` guarda: `path` (receta) y `sha256`.
 *
 * Orden de emisión: como el motor, por tick; dentro de un tick, comandos antes que hash y
 * checkpoint (receta) y eventos antes que el snapshot (vista).
 */
import type { Replay } from "../../../arena-engine/src/replay.js";
import { ReplayRecorder } from "../s9r/recorder.js";
import { publishPair } from "../s9r/publish.js";

export interface S9rFixture {
  path: string;
  sha256: string;
  viewPath: string;
  viewSha256: string;
  bytes: number;
}

export async function writeS9rReplay(
  dir: string,
  replay: Replay,
  opts: { battleId?: string; attempt?: number; recipeFragmentBytes?: number; viewFragmentBytes?: number } = {},
): Promise<S9rFixture> {
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
  };
}

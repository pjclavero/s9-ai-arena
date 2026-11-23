/**
 * V1 REPLAYS PR-4b · Fuente de replays REAL para los tests del reproductor web, sobre S9R/1.
 *
 * Sustituye al replay-service HTTP retirado (`createReplayServer` + `ingestReplay` sobre JSONL):
 * el replay grabado por el motor se publica con el MISMO grabador que el worker
 * (`writeS9rReplay` → ReplayRecorder + publishPair) y se sirve con los MISMOS lectores
 * incrementales que usa la API (`storeIndexOf`, `parseRange`, `rawSegment` de
 * apps/api/src/replay-s9r.ts) a través de `httpReplaySource` con un `fetch` en memoria: el
 * reproductor recorre el mismo camino URL → JSON que en el navegador, sin BD ni red.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Replay } from "../../arena-engine/src/replay.js";
import { writeS9rReplay } from "../../replay-service/src/s9r/replay-file.js";
import { ViewReader } from "../../replay-service/src/s9r/view.js";
import { parseRange, rawSegment, storeIndexOf } from "../../api/src/replay-s9r.js";
import { httpReplaySource, type ReplaySource } from "../src/viewer/replay-player.js";

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface S9rReplayHost {
  /** `fetch` en memoria que entiende `/replays/:id/index` y `/replays/:id/segment?fromTick&toTick`. */
  fetchImpl: FetchLike;
  sourceFor(battleId: string): ReplaySource;
  /** Peticiones servidas (para afirmar qué pidió el reproductor). */
  requests: string[];
  close(): Promise<void>;
}

/** Publica cada replay en S9R/1 en un directorio temporal y los sirve por id. */
export async function hostS9rReplays(replays: Replay[]): Promise<S9rReplayHost> {
  const dir = mkdtempSync(join(tmpdir(), "web-s9r-"));
  const byId = new Map<string, { battle: Record<string, any>; view: ViewReader }>();
  for (const replay of replays) {
    const fx = await writeS9rReplay(dir, replay);
    const view = await ViewReader.open(fx.viewPath);
    const id = String(replay.header.battleId);
    byId.set(id, {
      view,
      battle: {
        id,
        result: replay.result,
        final_state_hash: replay.result.finalStateHash,
        replay_hash: fx.sha256,
        official: true,
        engine_versions: replay.header.versions,
      },
    });
  }
  const requests: string[] = [];
  const reply = (status: number, body: unknown) => ({
    ok: status < 400,
    status,
    json: async () => JSON.parse(JSON.stringify(body)),
  });
  const fetchImpl: FetchLike = async (url) => {
    requests.push(url);
    const u = new URL(url, "http://replays.test");
    const m = /^\/replays\/([^/]+)\/(index|segment)$/.exec(u.pathname);
    const entry = m ? byId.get(decodeURIComponent(m[1])) : undefined;
    if (!m || !entry) return reply(404, { error: "replay_not_found" });
    if (m[2] === "index") return reply(200, storeIndexOf(entry.battle, entry.view));
    const range = parseRange(
      u.searchParams.get("fromTick") ?? undefined,
      u.searchParams.get("toTick") ?? undefined,
      Number(entry.battle.result?.ticks) || 0,
    );
    if (range === null) return reply(400, { error: "bad_range" });
    if (range === "too_large") return reply(400, { error: "segment_range_too_large" });
    return reply(200, await rawSegment(entry.battle, entry.view, range));
  };
  return {
    fetchImpl,
    requests,
    sourceFor: (battleId) => httpReplaySource("", battleId, fetchImpl),
    close: async () => {
      for (const { view } of byId.values()) await view.close();
    },
  };
}

/**
 * T8.1 · Servicio HTTP de replays.
 *
 * Sirve el archivo comprimido con soporte de rango (descargas reanudables), el índice
 * de keyframes para salto temporal y segmentos decodificados por rango de ticks (lo
 * que usa el reproductor de T8.3 para aterrizar en un tick sin bajarse todo).
 *
 * Es un servicio INTERNO detrás del gateway (E10): la autorización pública, las cuotas
 * anónimas y el contrato OpenAPI los pone la API de E7 (GET /replays/{battleId} +
 * POST /replays/{battleId}/verify), que lee estos mismos archivos por replay_ref.
 */
import express, { type Express } from "express";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fromJsonl } from "../../arena-engine/src/replay.js";
import { decompress, nearestKeyframe } from "./format.js";
import { ingestReplay, loadStored, readIndex, replayPath, sweepRetention, verifyStored } from "./store.js";

export interface ReplayServerOptions {
  dir: string;
  /** Reloj inyectable para las pruebas de retención. */
  now?: () => number;
}

/** Cache de segmentos: decodificar 9000 ticks por cada petición de salto sería absurdo. */
const decodedCache = new Map<string, { sha: string; snapshots: any[]; events: any[]; commands: any[] }>();

function decodedFor(dir: string, battleId: string) {
  const index = readIndex(dir, battleId);
  const p = replayPath(dir, battleId);
  if (!index || !existsSync(p)) return null;
  const cached = decodedCache.get(battleId);
  if (cached && cached.sha === index.sha256) return cached;
  const loaded = loadStored(dir, battleId);
  if (!loaded.valid || !loaded.replay) return null;
  const entry = {
    sha: index.sha256,
    snapshots: loaded.replay.snapshots,
    events: loaded.replay.events,
    commands: loaded.replay.commands,
  };
  decodedCache.set(battleId, entry);
  return entry;
}

export function createReplayServer(opts: ReplayServerOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  // La ingesta llega como JSONL crudo del motor/worker; 64 MB cubre batallas largas.
  app.use(express.text({ type: ["application/x-ndjson", "text/plain"], limit: "64mb" }));

  // ------------------------------------------------------------- ingesta
  app.post("/replays/:battleId", (req, res) => {
    let replay;
    try {
      replay = fromJsonl(String(req.body ?? ""));
    } catch (e) {
      res.status(400).json({ error: "bad_replay", message: (e as Error).message });
      return;
    }
    if (replay.header.battleId !== req.params.battleId) {
      res.status(400).json({ error: "battle_id_mismatch" });
      return;
    }
    try {
      const stored = ingestReplay(opts.dir, replay, {
        official: req.query.official === "true",
        now: opts.now,
      });
      res.status(201).json({
        battleId: stored.index.battleId,
        sha256: stored.index.sha256,
        path: stored.path,
        official: stored.index.official,
      });
    } catch (e) {
      res.status(422).json({ error: "invalid_replay", message: (e as Error).message });
    }
  });

  // ----------------------------------------------- archivo con soporte de rango
  app.get("/replays/:battleId", (req, res) => {
    const p = replayPath(opts.dir, req.params.battleId);
    if (!existsSync(p)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const size = statSync(p).size;
    const index = readIndex(opts.dir, req.params.battleId);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=3600, immutable");
    if (index) res.setHeader("X-Replay-Sha256", index.sha256);

    const range = req.headers.range;
    const bytes = readFileSync(p);
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (m[1] === "" && m[2] === "")) {
        res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
        return;
      }
      const start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
      const end = m[1] !== "" && m[2] !== "" ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
        return;
      }
      res
        .status(206)
        .setHeader("Content-Range", `bytes ${start}-${end}/${size}`)
        .send(bytes.subarray(start, end + 1));
      return;
    }
    res.status(200).send(bytes);
  });

  // -------------------------------------------------------------- índice
  app.get("/replays/:battleId/index", (req, res) => {
    const index = readIndex(opts.dir, req.params.battleId);
    if (!index) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=3600, immutable");
    res.json(index);
  });

  // ------------------------------------- segmento por ticks (salto temporal)
  app.get("/replays/:battleId/segment", (req, res) => {
    const index = readIndex(opts.dir, req.params.battleId);
    const decoded = decodedFor(opts.dir, req.params.battleId);
    if (!index || !decoded) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const fromTick = Number(req.query.fromTick ?? 0);
    const toTick = Number(req.query.toTick ?? index.ticks);
    if (!Number.isFinite(fromTick) || !Number.isFinite(toTick) || fromTick > toTick) {
      res.status(400).json({ error: "bad_range" });
      return;
    }
    // Se arranca del keyframe anterior: el reproductor aterriza con estado completo.
    const kf = nearestKeyframe(index.keyframes, fromTick);
    const startIdx = kf ? kf.snapshotIndex : 0;
    const snapshots: any[] = [];
    for (let i = startIdx; i < decoded.snapshots.length && decoded.snapshots[i].tick <= toTick; i++) {
      snapshots.push(decoded.snapshots[i]);
    }
    const events = decoded.events.filter((e: any) => e.tick >= (kf?.tick ?? 0) && e.tick <= toTick);
    res.setHeader("Cache-Control", "public, max-age=3600, immutable");
    res.json({
      battleId: index.battleId,
      fromKeyframeTick: kf?.tick ?? 0,
      snapshots,
      events,
      // T8.3: capas de depuración en replay (comandos grabados) SOLO si el dueño
      // del replay lo permitió al publicarlo (debugOpen). Nunca por defecto.
      ...(index.debugOpen
        ? { commands: decoded.commands.filter((c: any) => c.tick >= (kf?.tick ?? 0) && c.tick <= toTick) }
        : {}),
    });
  });

  // --------------------------------------------------------------- verify
  app.post("/replays/:battleId/verify", async (req, res) => {
    const result = await verifyStored(opts.dir, req.params.battleId);
    if (!result.valid && result.reason === "replay_not_found") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      battleId: result.battleId,
      valid: result.valid,
      reason: result.reason,
      matches: result.verification?.matches ?? false,
      officialHash: result.verification?.officialHash,
      recomputedHash: result.verification?.recomputedHash,
      divergedAtTick: result.verification?.divergedAtTick ?? undefined,
    });
  });

  // ------------------------------------------------------------ retención
  app.post("/retention/sweep", (_req, res) => {
    res.json(sweepRetention(opts.dir, opts.now));
  });

  return app;
}

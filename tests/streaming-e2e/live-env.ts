/**
 * EQ5b · Entorno LOCAL y efímero del E2E de streaming (§23). Base: el arnés de la
 * auditoría EQ5 (2026-11-02), ampliado con Administración → Streaming REAL:
 *   API real (createApp) sobre PostgreSQL EMBEBIDO, con el cliente HTTP REAL de la
 *   API interna de control del streamer (STREAMER_CONTROL_URL + secreto por
 *   fichero) y la clave PÚBLICA de sellado (STREAM_SECRETS_PUBLIC_KEY_FILE)
 *   + SpectateGateway real + batallas REALES del motor (HunterBot, 30 Hz)
 *   + la SPA construida (vite build) con fallback SPA, bajo un único origen:
 *     /api/v1/*      → API
 *     /ws/spectate/* → gateway de espectador
 *     /*             → apps/web/dist
 * La vista /broadcast que captura el streamer es la de ESTE origen. Sólo 127.0.0.1.
 *
 * Arnés (sólo 127.0.0.1): GET /harness/ids · POST /harness/start/:key (S|B1|B2)
 * · GET /harness/stats · POST /harness/stats/reset.
 *
 * Variables: PORT (def. 39480), PUBLIC_SPECTATE / PUBLIC_REPLAYS (1/0),
 * BATTLE_SECONDS (def. 60), STREAMER_CONTROL_URL, STREAMER_CONTROL_SECRET_FILE,
 * STREAM_SECRETS_PUBLIC_KEY_FILE.
 */
import express from "express";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";

process.env.SPECTATE_WS_URL = "/ws/spectate";

const REPO = new URL("../..", import.meta.url).pathname;
const { startTestDb } = await import(join(REPO, "apps/api/src/testing/test-db.ts"));
const { seedDev, seedContent, DEFAULT_RULESET_ID } = await import(join(REPO, "apps/api/src/db/seeds/dev.ts"));
const { createApp } = await import(join(REPO, "apps/api/src/app.ts"));
const { FakeBotManager } = await import(join(REPO, "apps/api/src/services/bot-manager.ts"));
const { SpectateGateway } = await import(join(REPO, "apps/api/src/spectate/gateway.ts"));
const { loadRuleset } = await import(join(REPO, "packages/game-rules/index.ts"));
const { Battle } = await import(join(REPO, "apps/arena-engine/src/sim/battle.ts"));
const { initPhysics } = await import(join(REPO, "apps/arena-engine/src/sim/physics.ts"));
const { emptyArena, gunnerLoadout, scoutLoadout } = await import(join(REPO, "apps/arena-engine/src/fixtures.ts"));
const { HunterBot } = await import(join(REPO, "apps/arena-engine/src/stubs.ts"));
const { HttpStreamerClient } = await import(join(REPO, "apps/api/src/services/streamer-client.ts"));
const { readPublicKey } = await import(join(REPO, "apps/api/src/services/streaming.ts"));

const PORT = Number(process.env.PORT ?? 39480);
const PUBLIC_SPECTATE = process.env.PUBLIC_SPECTATE !== "0";
const PUBLIC_REPLAYS = process.env.PUBLIC_REPLAYS !== "0";
const BATTLE_SECONDS = Number(process.env.BATTLE_SECONDS ?? 60);
const DIST = process.env.WEB_DIST ?? join(REPO, "apps/web/dist");
if (!existsSync(join(DIST, "index.html"))) throw new Error(`falta ${DIST}/index.html (vite build)`);

await initPhysics();
const h = await startTestDb();
await seedDev(h.db);
await seedContent(h.db);

const gateway = new SpectateGateway({
  wss: new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 }),
  publicSpectateEnabled: PUBLIC_SPECTATE,
});

const api = createApp({
  db: h.db,
  botManager: new FakeBotManager(h.db),
  anonQuota: { max: 100000, windowMs: 3600_000 },
  publicSpectateEnabled: PUBLIC_SPECTATE,
  publicReplaysEnabled: PUBLIC_REPLAYS,
  trustProxyHops: 0,
  metricsEnabled: true,
  streamer: new HttpStreamerClient(process.env.STREAMER_CONTROL_URL || null, process.env.STREAMER_CONTROL_SECRET_FILE),
  streamingPublicKey: () => readPublicKey(process.env),
  broadcastBaseUrl: `http://127.0.0.1:${PORT}/broadcast`,
});

// ── datos: un torneo con dos batallas y una batalla suelta ────────────────────
const [t] = await h
  .db("tournaments")
  .insert({ name: "Copa EQ5b", format: "league", mode: "deathmatch", ruleset_id: DEFAULT_RULESET_ID, state: "running" })
  .returning("*");
async function insertBattle(tournamentId: string | null): Promise<string> {
  const [row] = await h
    .db("battles")
    .insert({
      status: "scheduled",
      official: false,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: `eq5b-${Math.random().toString(36).slice(2)}`,
      ...(tournamentId ? { tournament_id: tournamentId } : {}),
    })
    .returning("*");
  return row.id as string;
}
const ids: Record<string, string> = {
  T: t.id,
  B1: await insertBattle(t.id),
  B2: await insertBattle(t.id),
  S: await insertBattle(null),
};

// ── bucle del motor con métricas (lo que mide BATTLE_PERFORMANCE_IMPACT) ──────
type Win = { steps: number; stepMs: number[]; periodMs: number[] };
let win: Win = { steps: 0, stepMs: [], periodMs: [] };
const pct = (a: number[], p: number) => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return Number(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(3));
};
const running = new Map<string, any>();

async function startBattle(key: string, seconds = BATTLE_SECONDS): Promise<void> {
  const id = ids[key];
  if (!id || running.has(id)) return;
  const b = await Battle.create({
    battleId: id,
    seed: id,
    ruleset: loadRuleset("dm_practice@1", {
      timeLimitTicks: seconds * 30,
      scoreToWin: 1000,
      respawn: { enabled: true, delayTicks: 60 },
    } as any),
    map: emptyArena(),
    participants: [
      { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
      { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
    ],
  });
  b.attachBot("v_red", new HunterBot("bot_red"));
  b.attachBot("v_blue", new HunterBot("bot_blue"));
  running.set(id, b);
  const arena = emptyArena();
  gateway.attachBattle(id, b, {
    meta: {
      mode: "deathmatch",
      tournamentId: key === "S" ? null : ids.T,
      roster: [
        { id: "v_red", botId: "bot_red", team: "red", chassis: "medium", name: "Martillo" },
        { id: "v_blue", botId: "bot_blue", team: "blue", chassis: "light", name: "Yunque" },
      ],
      world: { widthM: arena.widthM, heightM: arena.heightM, walls: [], destructibles: [], bases: [] },
    },
  });
  await h.db("battles").where({ id }).update({ status: "running", started_at: h.db.fn.now() });
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    win.periodMs.push(now - last);
    last = now;
    const t0 = performance.now();
    b.step();
    win.stepMs.push(performance.now() - t0);
    win.steps++;
    if (b.isFinished()) {
      clearInterval(timer);
      const r = b.getResult() ?? {};
      void h
        .db("battles")
        .where({ id })
        .update({
          status: "finished",
          finished_at: h.db.fn.now(),
          result: JSON.stringify({ score: (r as any).score ?? {}, ticks: (r as any).ticks ?? 0 }),
        })
        .then(async () => {
          // Como el worker de E9: el torneo se cierra cuando no le quedan batallas.
          const pend = await h.db("battles").where({ tournament_id: ids.T }).whereNot({ status: "finished" }).count();
          if (Number((pend[0] as any).count) === 0)
            await h.db("tournaments").where({ id: ids.T }).update({ state: "finished" });
          setTimeout(() => gateway.detachBattle(id), 3000);
        });
      running.delete(id);
    }
  }, 1000 / 30);
}

// ── servidor de un solo origen ────────────────────────────────────────────────
const root = express();
root.get("/harness/ids", (_q, r) => r.json(ids));
// #256 · `?seconds=N` (1..3600) acorta UNA batalla: así el diagnóstico tiene a la vez una
// batalla EN CURSO y otra TERMINADA (la matriz {en vivo, terminada}).
root.post("/harness/start/:key", async (q, r) => {
  const s = Number(q.query.seconds);
  await startBattle(q.params.key, Number.isInteger(s) && s >= 1 && s <= 3600 ? s : BATTLE_SECONDS);
  r.json({ ok: true, id: ids[q.params.key] });
});
root.get("/harness/stats", (_q, r) =>
  r.json({
    steps: win.steps,
    stepMs: { p50: pct(win.stepMs, 50), p99: pct(win.stepMs, 99), max: pct(win.stepMs, 100) },
    periodMs: { p50: pct(win.periodMs, 50), p99: pct(win.periodMs, 99), max: pct(win.periodMs, 100) },
    late50ms: win.periodMs.filter((x) => x > 50).length,
    running: running.size,
  }),
);
root.post("/harness/stats/reset", (_q, r) => {
  win = { steps: 0, stepMs: [], periodMs: [] };
  r.json({ ok: true });
});
root.use("/api/v1", api);
root.use(express.static(DIST, { index: false, dotfiles: "allow" }));
root.get(/.*/, (_q, r) => r.sendFile(join(DIST, "index.html"), { dotfiles: "allow" }));

const server = createServer(root);
server.on("upgrade", (req, socket, head) => {
  const url = req.url ?? "";
  if (!url.startsWith("/ws/spectate/")) return socket.destroy();
  req.url = url.replace(/^\/ws/, "");
  const wss = (gateway as any).wss as WebSocketServer;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
server.listen(PORT, "127.0.0.1", () =>
  console.log(JSON.stringify({ msg: "eq5b live-env listo", port: PORT, ids, PUBLIC_SPECTATE, PUBLIC_REPLAYS })),
);

const stop = async () => {
  server.close();
  await h.stop().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

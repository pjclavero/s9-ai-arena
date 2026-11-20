/**
 * VISIBILIDAD (2026-11) · §35 · Entorno LOCAL y efímero del E2E de retransmisión con
 * un bot PRIVADO. Nunca producción. Base: tests/streaming-e2e/live-env.ts.
 *
 *   API real (createApp) sobre PostgreSQL EMBEBIDO + cliente HTTP REAL del streamer
 *   + SpectateGateway real + batalla REAL del motor (agentes HunterBot, 30 Hz, con
 *   replay grabado) + la SPA construida, bajo un único origen (sólo 127.0.0.1):
 *     /api/v1/*      → API          /ws/spectate/* → gateway          /* → SPA
 *
 * Datos (por la BD, como los dejaría la web):
 *   - dueña A (correo y nombre reconocibles) con «A-DEF»: PRIVADO, código privado
 *     con marcas reconocibles en el código, el nombre de fichero y el loadout;
 *   - dueño B con «B-PUB»: PÚBLICO, código privado;
 *   - torneo «Copa Visibilidad» con `broadcast = true` y su batalla A-DEF vs B-PUB;
 *   - una batalla SUELTA A-DEF vs B-PUB (control: battle_not_public).
 * La nómina del espectador se construye como en engine-executor.ts (id, botId, team,
 * chassis, name desde la BD). Arnés: GET /harness/ids · POST /harness/start ·
 * GET /harness/state (visibilidad y code_public reales en la BD).
 */
import express from "express";
import { createServer } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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
const { replayFromBattle } = await import(join(REPO, "apps/arena-engine/src/replay.ts"));
const { emptyArena, gunnerLoadout, scoutLoadout } = await import(join(REPO, "apps/arena-engine/src/fixtures.ts"));
const { HunterBot } = await import(join(REPO, "apps/arena-engine/src/stubs.ts"));
const { ingestReplay } = await import(join(REPO, "apps/replay-service/src/store.ts"));
const { HttpStreamerClient } = await import(join(REPO, "apps/api/src/services/streamer-client.ts"));
const { readPublicKey } = await import(join(REPO, "apps/api/src/services/streaming.ts"));
const { createPublishedBot } = await import(join(REPO, "apps/tournament-worker/src/testing/fixtures.ts"));

export const SECRET_CODE = "SECRETO_CODIGO_A_DEF_7f3a";
const PORT = Number(process.env.PORT ?? 39580);
const BATTLE_SECONDS = Number(process.env.BATTLE_SECONDS ?? 45);
const DIST = process.env.WEB_DIST ?? join(REPO, "apps/web/dist");
if (!existsSync(join(DIST, "index.html"))) throw new Error(`falta ${DIST}/index.html (vite build)`);
const REPLAYS = mkdtempSync(join(tmpdir(), "vis-e2e-replays-"));

await initPhysics();
const h = await startTestDb();
await seedDev(h.db);
await seedContent(h.db);

const gateway = new SpectateGateway({
  wss: new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 }),
  publicSpectateEnabled: true,
});
const api = createApp({
  db: h.db,
  botManager: new FakeBotManager(h.db),
  anonQuota: { max: 100000, windowMs: 3600_000 },
  publicSpectateEnabled: true,
  publicReplaysEnabled: true,
  trustProxyHops: 0,
  streamer: new HttpStreamerClient(process.env.STREAMER_CONTROL_URL || null, process.env.STREAMER_CONTROL_SECRET_FILE),
  streamingPublicKey: () => readPublicKey(process.env),
  broadcastBaseUrl: `http://127.0.0.1:${PORT}/broadcast`,
});

// ── datos ─────────────────────────────────────────────────────────────────────
async function owner(local: string, display: string): Promise<string> {
  const [u] = await h
    .db("users")
    .insert({ email: `${local}@vis-e2e.example.test`, password_hash: "x", display_name: display })
    .returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role: "developer" });
  return u.id as string;
}
async function bot(ownerId: string, name: string, visibility: string): Promise<string> {
  const b = await createPublishedBot(h.db, name, { ownerId });
  await h.db("bots").where({ id: b.botId }).update({ visibility });
  const vq = () => h.db("bot_versions").where({ bot_id: b.botId, version: 1 });
  await vq().update({ state: "draft" });
  await vq().update({
    source: Buffer.from(`# ${SECRET_CODE}\nclass Bot: pass  # ${name}\n`),
    source_filename: "estrategia-secreta-a-def.py",
  });
  await vq().update({ state: "published", code_public: false });
  await h.db("bot_loadouts").where({ bot_id: b.botId, revision: 1 }).update({ name: "loadout-secreto-a-def" });
  return b.botId;
}
const A = await owner("duena-secreta-a-def", "Dueña Secreta ADEF");
const B = await owner("dueno-b-pub", "Dueño BPUB");
const BOT_A = await bot(A, "A-DEF", "private");
const BOT_B = await bot(B, "B-PUB", "public");
const [t] = await h
  .db("tournaments")
  .insert({
    name: "Copa Visibilidad",
    format: "league",
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    state: "running",
    broadcast: true,
  })
  .returning("*");
async function insertBattle(tournamentId: string | null): Promise<string> {
  const [row] = await h
    .db("battles")
    .insert({
      status: "scheduled",
      official: !!tournamentId,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: `vis-${Math.random().toString(36).slice(2)}`,
      tournament_id: tournamentId,
    })
    .returning("*");
  await h.db("participants").insert([
    { battle_id: row.id, bot_id: BOT_A, version: 1, team: "red" },
    { battle_id: row.id, bot_id: BOT_B, version: 1, team: "blue" },
  ]);
  return row.id as string;
}
const ids = { T: t.id as string, TB: await insertBattle(t.id), S: await insertBattle(null), A, B, BOT_A, BOT_B };

// ── batalla real ─────────────────────────────────────────────────────────────
let started = false;
async function startBattle(): Promise<void> {
  if (started) return;
  started = true;
  const id = ids.TB;
  const participants = [
    { id: "veh_1", botId: BOT_A, team: "red", spec: gunnerLoadout() },
    { id: "veh_2", botId: BOT_B, team: "blue", spec: scoutLoadout() },
  ];
  const b = await Battle.create({
    battleId: id,
    seed: id,
    ruleset: loadRuleset("dm_practice@1", {
      timeLimitTicks: BATTLE_SECONDS * 30,
      scoreToWin: 1000,
      respawn: { enabled: true, delayTicks: 60 },
    } as any),
    map: emptyArena(),
    participants,
    recordReplay: true,
  });
  b.attachBot("veh_1", new HunterBot(BOT_A));
  b.attachBot("veh_2", new HunterBot(BOT_B));
  // Nómina como engine-executor.ts: id, botId, team, chassis y nombre desde la BD.
  const names = new Map(
    (await h.db("bots").whereIn("id", [BOT_A, BOT_B]).select("id", "name")).map((r: any) => [r.id, r.name]),
  );
  const loadouts = new Map(
    (await h.db("bot_loadouts").whereIn("bot_id", [BOT_A, BOT_B]).select("bot_id", "chassis")).map((r: any) => [
      r.bot_id,
      r.chassis,
    ]),
  );
  const roster = participants.map((p) => ({
    id: p.id,
    botId: p.botId,
    team: p.team,
    chassis: loadouts.get(p.botId),
    name: names.get(p.botId),
  }));
  const arena = emptyArena();
  gateway.attachBattle(id, b, {
    meta: {
      mode: "deathmatch",
      tournamentId: ids.T,
      roster,
      world: { widthM: arena.widthM, heightM: arena.heightM, walls: [], destructibles: [], bases: [] },
    },
  });
  await h.db("battles").where({ id }).update({ status: "running", started_at: h.db.fn.now() });
  const timer = setInterval(() => {
    b.step();
    if (!b.isFinished()) return;
    clearInterval(timer);
    const r = b.getResult() as any;
    const replay = replayFromBattle(b, r);
    const stored = ingestReplay(REPLAYS, replay, { official: true });
    void h
      .db("battles")
      .where({ id })
      .update({
        status: "finished",
        finished_at: h.db.fn.now(),
        replay_ref: stored.path,
        replay_hash: stored.index.sha256,
        final_state_hash: r.finalStateHash ?? null,
        result: JSON.stringify({ score: r.score ?? {}, ticks: r.ticks ?? 0, winner: r.winner ?? null }),
      })
      .then(() => setTimeout(() => gateway.detachBattle(id), 3000));
  }, 1000 / 30);
}

// ── servidor de un solo origen ────────────────────────────────────────────────
const root = express();
root.get("/harness/ids", (_q, r) => r.json(ids));
root.post("/harness/start", async (_q, r) => {
  await startBattle();
  r.json({ ok: true, id: ids.TB });
});
root.get("/harness/state", async (_q, r) => {
  const bots = await h.db("bots").whereIn("id", [BOT_A, BOT_B]).select("id", "name", "visibility");
  const versions = await h.db("bot_versions").whereIn("bot_id", [BOT_A, BOT_B]).select("bot_id", "code_public");
  const battle = await h.db("battles").where({ id: ids.TB }).first("status", "result", "replay_hash");
  r.json({ bots, versions, battle });
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
server.listen(PORT, "127.0.0.1", () => console.log(JSON.stringify({ msg: "vis live-env listo", port: PORT, ids })));

const stop = async () => {
  server.close();
  await h.stop().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

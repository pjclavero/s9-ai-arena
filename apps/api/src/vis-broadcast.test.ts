/**
 * VISIBILIDAD (2026-11) · «participar ≠ hacer público el bot; salir en streaming ≠
 * hacer público el bot; bot público ≠ código público». Encargo §29–§34.
 *
 * Expectativas escritas desde la POLÍTICA, no del código:
 *  - BOT_VISIBILITY (ficha): la cambia sólo el dueño (`updateBot`); la lee `canSeeBot`.
 *  - CODE_VISIBILITY (código de una versión): la cambia sólo el dueño
 *    (`setBotVersionCodeVisibility`); la lee `canReadSource`.
 *  - COMPETITION_ELIGIBILITY: inscribir no depende de la visibilidad.
 *  - BROADCAST_VISIBILITY: una batalla de un torneo con `broadcast` se muestra en
 *    público con la proyección de competición; la ficha y el código siguen privados.
 *
 * Bots (dueño A salvo indicación):
 *  - APRIV «A-DEF»  private, código privado, con marcas reconocibles en el código;
 *  - ATEAM          team (equipo X, del que T es miembro), código privado;
 *  - CPUB           public (dueño C), código privado;
 *  - CPUBCODE       public (dueño C), código público.
 * Torneo TB (broadcast) y torneo TN (sin broadcast); batallas suelta, en TB y en TN.
 *
 * Mutaciones que ponen esto en ROJO (scripts/vis-broadcast-mutants.sh): /broadcast
 * filtrando por `getVisibleBot`, quitar la sanitización, devolver el bot completo,
 * auto-publicar al inscribir/emitir, `code_public=true` al cerrar el torneo y
 * `updateBot` sin `assertOwner`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import type { StreamerCallResult, StreamerClient } from "./services/streamer-client.js";
import { keyIdOf } from "../../../packages/stream-secrets/index.js";
import { createPublishedBot } from "../../tournament-worker/src/testing/fixtures.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { ingestReplay } from "../../replay-service/src/store.js";

// Marcas reconocibles: si aparecen fuera de la ficha/código autorizados, hay fuga.
const SECRET_CODE = "SECRETO_CODIGO_A_DEF_7f3a";
const SECRET_FILENAME = "estrategia-secreta-a-def.py";
const OWNER_EMAIL_LOCAL = "duena-secreta-a-def";
const OWNER_DISPLAY = "Dueña Secreta ADEF";
const SECRET_LOADOUT_NAME = "loadout-secreto-a-def";

const { publicKey: PUB } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

class FakeStreamer implements StreamerClient {
  configured = true;
  calls: { method: string; path: string; body: unknown }[] = [];
  state = "idle";
  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<StreamerCallResult<T>> {
    this.calls.push({ method, path, body });
    const ok = (b: unknown) => ({ ok: true, status: 200, body: b as T });
    if (path === "/status") {
      return ok({
        state: this.state,
        desired: this.state === "streaming",
        capabilities: { nvenc: false, sealedCredentials: true },
        lastError: null,
        relay: { state: this.state === "streaming" ? "publishing" : null, bytesOut: 0 },
        stats: { frames: 1 },
      });
    }
    if (path === "/control/start") {
      this.state = "streaming";
      return ok({ state: "streaming", session: { sessionId: (body as { sessionId: string }).sessionId } });
    }
    if (path === "/control/stop") {
      this.state = "stopped";
      return ok({ state: "stopped" });
    }
    if (path === "/recordings") {
      return ok({ dir: "x", files: [], count: 0, totalBytes: 0, disk: { totalBytes: 1e12, freeBytes: 1e11 } });
    }
    if (path === "/recordings/retention") return ok({ dryRun: false, deleted: [], errors: [] });
    return { ok: false, status: 404, body: {} as T };
  }
  starts() {
    return this.calls.filter((c) => c.path === "/control/start");
  }
}

let h: TestDbHandle;
let app: Express;
let fake: FakeStreamer;
let dir: string;
let base: Replay;
const tok: Record<string, string | undefined> = {};
const U: Record<string, string> = {};
const BOT: Record<string, string> = {};
const T: Record<string, string> = {};
const BAT: Record<string, string> = {};

const auth = (t: string | undefined) => (t ? { Authorization: `Bearer ${t}` } : {});
const get = (path: string, who?: string) => request(app).get(path).set(auth(who));

async function newUser(label: string, role = "developer", email?: string, display?: string) {
  const e = email ?? `${label}-${randomUUID().slice(0, 8)}@vis.example.test`;
  const [u] = await h
    .db("users")
    .insert({ email: e, password_hash: "x", display_name: display ?? label })
    .returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role });
  return { id: u.id as string, token: await tokenFor(h.db, e), email: e };
}

async function newBot(ownerId: string, name: string, visibility: string, teamId: string | null, codePublic: boolean) {
  const b = await createPublishedBot(h.db, name, { ownerId });
  await h.db("bots").where({ id: b.botId }).update({ visibility, team_id: teamId });
  // El guardián sólo deja escribir el código en `draft`: se vuelve a draft, se escribe y se republica.
  const vq = () => h.db("bot_versions").where({ bot_id: b.botId, version: 1 });
  await vq().update({ state: "draft" });
  await vq().update({
    source: Buffer.from(`# ${SECRET_CODE}\nprint("${name}")\n`),
    source_filename: SECRET_FILENAME,
  });
  await vq().update({ state: "published", code_public: codePublic });
  await h.db("bot_loadouts").where({ bot_id: b.botId, revision: 1 }).update({ name: SECRET_LOADOUT_NAME });
  return b.botId;
}

async function snapshotOf(ids: string[]) {
  const bots = await h.db("bots").whereIn("id", ids).orderBy("id").select("id", "visibility", "team_id", "name");
  const versions = await h
    .db("bot_versions")
    .whereIn("bot_id", ids)
    .orderBy(["bot_id", "version"])
    .select("bot_id", "version", "code_public");
  return { bots, versions };
}

async function newBattle(opts: {
  botIds: string[];
  status: "running" | "finished";
  tournamentId?: string | null;
  withReplay?: boolean;
}): Promise<string> {
  const id = randomUUID();
  let replay: { replay_ref: string; replay_hash: string } | null = null;
  if (opts.withReplay) {
    const header = {
      ...base.header,
      battleId: id,
      participants: base.header.participants.map((p: any, i: number) => ({ ...p, botId: opts.botIds[i] })),
    };
    const stored = ingestReplay(dir, { ...base, header }, { official: true });
    replay = { replay_ref: stored.path, replay_hash: stored.index.sha256 };
  }
  await h.db("battles").insert({
    id,
    status: opts.status,
    official: !!opts.tournamentId,
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
    seed: "vis-seed-secreta",
    tournament_id: opts.tournamentId ?? null,
    result: opts.status === "finished" ? JSON.stringify({ score: { A: 1, B: 0 }, ticks: 90 }) : null,
    started_at: h.db.fn.now(),
    finished_at: opts.status === "finished" ? h.db.fn.now() : null,
    ...(replay ?? {}),
  });
  let i = 0;
  for (const botId of opts.botIds) {
    await h.db("participants").insert({
      battle_id: id,
      bot_id: botId,
      version: 1,
      team: i++ % 2 ? "B" : "A",
      cpu_ms: 1234,
      outcome: opts.status === "finished" ? (i === 1 ? "win" : "loss") : null,
    });
  }
  await h.db("battle_stats").insert(
    opts.botIds.map((botId, k) => ({
      battle_id: id,
      bot_id: botId,
      stats: JSON.stringify({ team: k % 2 ? "B" : "A", damageDealt: 10, cpuMs: 999, decisionTimeouts: 3 }),
    })),
  );
  return id;
}

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  fake = new FakeStreamer();
  app = createApp({
    db: h.db,
    anonQuota: { max: 100_000, windowMs: 3600_000 },
    publicReplaysEnabled: true,
    publicSpectateEnabled: true,
    streamer: fake,
    streamingPublicKey: () => ({ pem: PUB, kid: keyIdOf(PUB) }),
    broadcastBaseUrl: "http://web:3000/broadcast",
  });
  dir = mkdtempSync(join(tmpdir(), "vis-broadcast-"));
  base = await record(
    {
      battleId: "vis-base",
      seed: "vis",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 60 }),
      map: emptyArena(),
      participants: [
        { id: "v_a", botId: "bot_a", team: "A", spec: gunnerLoadout() },
        { id: "v_b", botId: "bot_b", team: "B", spec: scoutLoadout() },
      ],
    },
    (b) => {
      b.attachBot("v_a", new HunterBot("bot_a"));
      b.attachBot("v_b", new HunterBot("bot_b"));
    },
  );

  const A = await newUser("owner-a", "developer", `${OWNER_EMAIL_LOCAL}@vis.example.test`, OWNER_DISPLAY);
  const B = await newUser("stranger-b");
  const Tm = await newUser("team-member-t", "user");
  const C = await newUser("owner-c");
  U.A = A.id;
  U.C = C.id;
  tok.A = A.token;
  tok.B = B.token;
  tok.T = Tm.token;
  tok.C = C.token;
  tok.anon = undefined;
  tok.organizer = await tokenFor(h.db, DEV_USERS.organizer);
  tok.moderator = await tokenFor(h.db, DEV_USERS.moderator);
  tok.admin = await tokenFor(h.db, DEV_USERS.admin);

  const [team] = await h
    .db("teams")
    .insert({ name: `vis-team-${randomUUID().slice(0, 6)}`, captain_id: A.id })
    .returning("id");
  await h.db("team_members").insert([
    { team_id: team.id, user_id: A.id, role: "captain" },
    { team_id: team.id, user_id: Tm.id, role: "member" },
  ]);

  BOT.APRIV = await newBot(A.id, "A-DEF", "private", null, false);
  BOT.ATEAM = await newBot(A.id, "A-TEAM", "team", team.id, false);
  BOT.CPUB = await newBot(C.id, "C-PUB", "public", null, false);
  BOT.CPUBCODE = await newBot(C.id, "C-PUBCODE", "public", null, true);
  // Bots sólo para la matriz de visibilidad de la ficha (§29): se mutan.
  BOT.AVIS = await newBot(A.id, "A-VIS", "private", team.id, false);
}, 180_000);

afterAll(async () => {
  await h.stop();
  rmSync(dir, { recursive: true, force: true });
});

// ───────────────────────────────────────────── §29 · visibilidad del bot
describe("§29 · visibilidad del bot (ficha)", () => {
  const patch = (who: string | undefined, visibility: string) =>
    request(app).patch(`/bots/${BOT.AVIS}`).set(auth(who)).send({ visibility });

  it("OWNER_CAN_SET_PRIVATE / TEAM / PUBLIC (y queda auditado)", async () => {
    for (const v of ["team", "public", "private"]) {
      const r = await patch(tok.A, v);
      expect(r.status, v).toBe(200);
      expect(r.body.visibility).toBe(v);
      expect((await h.db("bots").where({ id: BOT.AVIS }).first()).visibility).toBe(v);
    }
    const audits = await h.db("audit_log").where({ action: "bot.visibility_changed", target: `bot:${BOT.AVIS}` });
    expect(audits.length).toBe(3);
  });

  it("NON_OWNER_CANNOT_CHANGE: ajeno 404 (privado) / 403 (público), equipo 403, staff 403, anónimo 401", async () => {
    await h.db("bots").where({ id: BOT.AVIS }).update({ visibility: "private" });
    expect((await patch(tok.B, "public")).status).toBe(404); // no revela existencia
    expect((await patch(undefined, "public")).status).toBe(401);
    await h.db("bots").where({ id: BOT.AVIS }).update({ visibility: "team" });
    expect((await patch(tok.T, "public")).status).toBe(403); // miembro del equipo: lo ve, no lo cambia
    await h.db("bots").where({ id: BOT.AVIS }).update({ visibility: "public" });
    expect((await patch(tok.B, "private")).status).toBe(403);
    for (const s of [tok.organizer, tok.moderator, tok.admin]) expect((await patch(s, "private")).status).toBe(403);
    expect((await h.db("bots").where({ id: BOT.AVIS }).first()).visibility).toBe("public");
  });

  it("PUBLIC_CAN_VIEW_PUBLIC / PUBLIC_CANNOT_VIEW_PRIVATE / TEAM_MEMBER_CAN_VIEW_TEAM", async () => {
    await h.db("bots").where({ id: BOT.AVIS }).update({ visibility: "public" });
    expect((await get(`/bots/${BOT.AVIS}`)).status).toBe(200);
    expect((await get(`/bots/${BOT.AVIS}`, tok.B)).status).toBe(200);
    await h.db("bots").where({ id: BOT.AVIS }).update({ visibility: "private" });
    expect((await get(`/bots/${BOT.AVIS}`)).status).toBe(404);
    expect((await get(`/bots/${BOT.AVIS}`, tok.B)).status).toBe(404);
    expect((await get(`/bots/${BOT.AVIS}`, tok.T)).status).toBe(404); // private no se comparte con el equipo
    await h.db("bots").where({ id: BOT.AVIS }).update({ visibility: "team" });
    expect((await get(`/bots/${BOT.AVIS}`, tok.T)).status).toBe(200);
    expect((await get(`/bots/${BOT.AVIS}`, tok.B)).status).toBe(404);
    expect((await get(`/bots/${BOT.AVIS}`)).status).toBe(404);
  });
});

// ───────────────────────────────────────────── §30 · visibilidad del código
describe("§30 · visibilidad del código (por versión)", () => {
  const put = (who: string | undefined, botId: string, codePublic: unknown) =>
    request(app).put(`/bots/${botId}/versions/1/code-visibility`).set(auth(who)).send({ codePublic });

  it("OWNER_CAN_SET_CODE_PUBLIC y PUBLIC_CODE_READ_WHEN_ALLOWED (source, files, diff ⇒ sí)", async () => {
    await h.db("bots").where({ id: BOT.AVIS }).update({ visibility: "public" });
    const r = await put(tok.A, BOT.AVIS, true);
    expect(r.status).toBe(200);
    expect(r.body.codePublic).toBe(true);
    const src = await get(`/bots/${BOT.AVIS}/versions/1/source`, tok.B);
    expect(src.status).toBe(200);
    expect(Buffer.from(src.body).toString("utf8")).toContain(SECRET_CODE);
    expect((await get(`/bots/${BOT.AVIS}/versions/1/files`, tok.B)).status).toBe(200);
    expect((await get(`/bots/${BOT.AVIS}/versions/1`, tok.B)).body.canReadSource).toBe(true);
    expect((await get(`/bots/${BOT.AVIS}/versions/1/diff?against=1`, tok.B)).status).toBe(200);
  });

  it("VISIBILIDAD-3 · P3-2 · source, files y diff llevan `Cache-Control: private, no-store` (dueño y tercero)", async () => {
    for (const who of [tok.A, tok.B]) {
      for (const path of [
        `/bots/${BOT.AVIS}/versions/1/source`,
        `/bots/${BOT.AVIS}/versions/1/files`,
        `/bots/${BOT.AVIS}/versions/1/diff?against=1`,
      ]) {
        const r = await get(path, who);
        expect(r.status, path).toBe(200);
        expect(r.headers["cache-control"], path).toBe("private, no-store");
      }
    }
  });

  it("OWNER_CAN_SET_CODE_PRIVATE (público → privado, enmienda a D9) y PRIVATE_CODE_REMAINS_HIDDEN", async () => {
    const r = await put(tok.A, BOT.AVIS, false);
    expect(r.status).toBe(200);
    expect(r.body.codePublic).toBe(false);
    // Volver a privado corta TODAS las lecturas públicas del código.
    for (const who of [tok.B, undefined]) {
      expect((await get(`/bots/${BOT.AVIS}/versions/1/source`, who)).status).not.toBe(200);
      expect((await get(`/bots/${BOT.AVIS}/versions/1/files`, who)).status).not.toBe(200);
      expect((await get(`/bots/${BOT.AVIS}/versions/1/diff?against=1`, who)).status).not.toBe(200);
      const d = await get(`/bots/${BOT.AVIS}/versions/1`, who);
      expect(d.body.canReadSource).toBe(false);
      expect(d.body.sourceSha256).toBeUndefined();
      expect(JSON.stringify(d.body)).not.toContain(SECRET_CODE);
    }
    // El dueño lo sigue leyendo; la versión no cambia de estado ni de artefacto.
    expect((await get(`/bots/${BOT.AVIS}/versions/1/source`, tok.A)).status).toBe(200);
    const v = await h.db("bot_versions").where({ bot_id: BOT.AVIS, version: 1 }).first();
    expect(v.state).toBe("published");
    const audits = await h
      .db("audit_log")
      .where({ action: "bot.code_visibility_changed", target: `bot:${BOT.AVIS}:v1` })
      .orderBy("id");
    expect(audits.map((a: any) => (typeof a.detail === "string" ? JSON.parse(a.detail) : a.detail).to)).toEqual([
      true,
      false,
    ]);
  });

  it("NON_OWNER_CANNOT_CHANGE_CODE_VISIBILITY: ajeno 403/404, equipo 403, staff 403, anónimo 401, tipo 400", async () => {
    await h.db("bots").where({ id: BOT.AVIS }).update({ visibility: "public" });
    expect((await put(tok.B, BOT.AVIS, true)).status).toBe(403);
    expect((await put(tok.T, BOT.AVIS, true)).status).toBe(403);
    for (const s of [tok.organizer, tok.moderator, tok.admin]) expect((await put(s, BOT.AVIS, true)).status).toBe(403);
    expect((await put(undefined, BOT.AVIS, true)).status).toBe(401);
    expect((await put(tok.B, BOT.APRIV, true)).status).toBe(404); // bot privado ajeno: ni existe
    expect((await put(tok.A, BOT.AVIS, "true")).status).toBe(400);
    expect((await h.db("bot_versions").where({ bot_id: BOT.AVIS, version: 1 }).first()).code_public).toBe(false);
  });

  it("la visibilidad del bot no cambia la del código (bot público ≠ código público)", async () => {
    expect((await h.db("bots").where({ id: BOT.CPUB }).first()).visibility).toBe("public");
    expect((await get(`/bots/${BOT.CPUB}`)).status).toBe(200);
    expect((await get(`/bots/${BOT.CPUB}/versions/1/source`, tok.B)).status).toBe(403);
    expect((await get(`/bots/${BOT.CPUBCODE}/versions/1/source`, tok.B)).status).toBe(200);
  });
});

// ───────────────────────────────────────────── §31 · torneos
describe("§31 · torneos: participar no cambia ninguna visibilidad", () => {
  it("crear con broadcast lo fija; tipo inválido 400; sin él, false", async () => {
    const bad = await request(app).post("/tournaments").set(auth(tok.organizer)).send({
      name: "vis-bad",
      format: "round_robin",
      mode: "deathmatch",
      rulesetId: DEFAULT_RULESET_ID,
      broadcast: "sí",
    });
    expect(bad.status).toBe(400);
    const tb = await request(app).post("/tournaments").set(auth(tok.organizer)).send({
      name: "vis-TB",
      format: "round_robin",
      mode: "deathmatch",
      rulesetId: DEFAULT_RULESET_ID,
      broadcast: true,
    });
    expect(tb.status).toBe(201);
    expect(tb.body.broadcast).toBe(true);
    T.TB = tb.body.id;
    const tn = await request(app)
      .post("/tournaments")
      .set(auth(tok.organizer))
      .send({ name: "vis-TN", format: "round_robin", mode: "deathmatch", rulesetId: DEFAULT_RULESET_ID });
    expect(tn.status).toBe(201);
    expect(tn.body.broadcast).toBe(false);
    T.TN = tn.body.id;
    expect((await get(`/tournaments/${T.TB}`)).body.broadcast).toBe(true);
  });

  it("PRIVATE / TEAM / PUBLIC_BOT_CAN_ENTER_TOURNAMENT y TOURNAMENT_DOES_NOT_MUTATE_VISIBILITY / CODE_PUBLIC", async () => {
    const ids = [BOT.APRIV, BOT.ATEAM, BOT.CPUB];
    const before = await snapshotOf(ids);
    for (const [botId, who] of [
      [BOT.APRIV, tok.A],
      [BOT.ATEAM, tok.A],
      [BOT.CPUB, tok.C],
    ] as const) {
      const r = await request(app).post(`/tournaments/${T.TB}/entries`).set(auth(who)).send({ botId, version: 1 });
      expect(r.status, botId).toBe(201);
    }
    // Sólo el dueño inscribe (un ajeno no puede inscribir un bot privado de otro).
    expect(
      (await request(app).post(`/tournaments/${T.TN}/entries`).set(auth(tok.B)).send({ botId: BOT.APRIV, version: 1 }))
        .status,
    ).toBe(403);
    expect(await snapshotOf(ids)).toEqual(before); // durante
    const closed = await request(app).post(`/tournaments/${T.TB}/actions/close-entries`).set(auth(tok.organizer));
    expect(closed.status).toBe(200);
    expect(closed.body.broadcast).toBe(true);
    expect(await snapshotOf(ids)).toEqual(before); // freeze / cierre
    expect((await h.db("bot_versions").where({ bot_id: BOT.APRIV, version: 1 }).first()).state).toBe("frozen");
  });
});

// ───────────────────────────────────────────── §32/§19 · retransmisión
describe("§32 · retransmisión: emitir no cambia ninguna visibilidad", () => {
  beforeAll(async () => {
    BAT.tbRunPriv = await newBattle({ botIds: [BOT.APRIV, BOT.CPUB], status: "running", tournamentId: T.TB });
    BAT.tbRunTeam = await newBattle({ botIds: [BOT.ATEAM, BOT.CPUB], status: "running", tournamentId: T.TB });
    BAT.tbFinPriv = await newBattle({
      botIds: [BOT.APRIV, BOT.CPUB],
      status: "finished",
      tournamentId: T.TB,
      withReplay: true,
    });
    BAT.tnRunPriv = await newBattle({ botIds: [BOT.APRIV, BOT.CPUB], status: "running", tournamentId: T.TN });
    BAT.looseRunPriv = await newBattle({ botIds: [BOT.APRIV, BOT.CPUB], status: "running" });
    BAT.looseFinPriv = await newBattle({ botIds: [BOT.APRIV, BOT.CPUB], status: "finished", withReplay: true });
    BAT.looseRunPub = await newBattle({ botIds: [BOT.CPUB, BOT.CPUBCODE], status: "running" });
    const v = (await request(app).get("/admin/streaming").set(auth(tok.admin))).body.settings.version;
    const r = await request(app)
      .put("/admin/streaming/settings")
      .set(auth(tok.admin))
      .send({ version: v, enabled: true, mode: "record" });
    expect(r.status).toBe(200);
  });

  const target = (kind: string, id: string) =>
    request(app).get(`/admin/streaming/target?kind=${kind}&id=${id}`).set(auth(tok.admin));
  const start = (kind: string, id: string) =>
    request(app).post("/admin/streaming/start").set(auth(tok.admin)).send({ target: { kind, id } });
  const stop = () => request(app).post("/admin/streaming/stop").set(auth(tok.admin)).send({});

  it("destinos: motivo REAL (battle_not_public / tournament_not_broadcastable), no target_not_public", async () => {
    expect((await target("battle", BAT.tbRunPriv)).body).toMatchObject({
      broadcastable: true,
      broadcastBlockedReason: null,
      tournamentBroadcast: true,
    });
    expect((await target("battle", BAT.tnRunPriv)).body).toMatchObject({
      broadcastable: false,
      broadcastBlockedReason: "tournament_not_broadcastable",
    });
    expect((await target("battle", BAT.looseRunPriv)).body).toMatchObject({
      broadcastable: false,
      broadcastBlockedReason: "battle_not_public",
    });
    expect((await target("battle", BAT.looseRunPub)).body.broadcastable).toBe(true);
    for (const [id, code] of [
      [BAT.tnRunPriv, "tournament_not_broadcastable"],
      [BAT.looseRunPriv, "battle_not_public"],
    ]) {
      const r = await start("battle", id);
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(code);
    }
  });

  for (const [label, key, botKey] of [
    ["PRIVATE_BOT_BATTLE_CAN_BROADCAST", "tbRunPriv", "APRIV"],
    ["TEAM_BOT_BATTLE_CAN_BROADCAST", "tbRunTeam", "ATEAM"],
    ["PUBLIC_BOT_BATTLE_CAN_BROADCAST", "looseRunPub", "CPUB"],
  ] as const) {
    it(`${label} · BROADCAST_DOES_NOT_MUTATE_BOT · BROADCAST_DOES_NOT_MUTATE_CODE_VISIBILITY`, async () => {
      const ids = [BOT.APRIV, BOT.ATEAM, BOT.CPUB, BOT.CPUBCODE];
      const before = await snapshotOf(ids);
      const n = fake.starts().length;
      const r = await start("battle", BAT[key]);
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
      expect(fake.starts().length).toBe(n + 1);
      // Lo que /broadcast (anónima) usa: la batalla, el ticket de espectador.
      const b = await get(`/battles/${BAT[key]}`);
      expect(b.status).toBe(200);
      expect(b.body.participants.map((p: any) => p.botId)).toContain(BOT[botKey]);
      expect((await request(app).post(`/battles/${BAT[key]}/spectate-ticket`)).status).toBe(201);
      expect(await snapshotOf(ids)).toEqual(before); // durante
      expect((await stop()).status).toBeLessThan(300);
      expect(await snapshotOf(ids)).toEqual(before); // después
    });
  }

  it("torneo como destino: el director ve TODAS las batallas del torneo con broadcast", async () => {
    const r = await target("tournament", T.TB);
    expect(r.body).toMatchObject({ broadcastable: true, tournamentBroadcast: true });
    const list = await get(`/tournaments/${T.TB}/battles`);
    const ids = list.body.items.map((x: any) => x.id);
    expect(ids).toEqual(expect.arrayContaining([BAT.tbRunPriv, BAT.tbRunTeam, BAT.tbFinPriv]));
    // Sin broadcast, la batalla con bot privado sigue oculta al visitante.
    expect((await get(`/tournaments/${T.TN}/battles`)).body.items.map((x: any) => x.id)).not.toContain(BAT.tnRunPriv);
  });
});

// ───────────────────────────────────────────── §19/§20 · casos de privacidad
describe("§19/§20 · casos A–E y no revelar existencia", () => {
  it("A: batalla NO retransmisible con bot privado ⇒ nada expuesto (404 uniforme en todas las vías)", async () => {
    for (const id of [BAT.looseRunPriv, BAT.looseFinPriv, BAT.tnRunPriv]) {
      for (const who of [undefined, tok.B]) {
        expect((await get(`/battles/${id}`, who)).status).toBe(404);
        expect((await get(`/battles/${id}/stats`, who)).status).toBe(404);
        expect((await request(app).post(`/battles/${id}/spectate-ticket`).set(auth(who))).status).toBe(404);
        expect((await get(`/replays/${id}`, who)).status).toBe(404);
      }
      expect((await get(`/public/replays/${id}`)).status).toBe(404);
      expect((await get(`/public/battles/${id}`)).status).toBe(404);
    }
  });

  it("B/C: privado o de equipo en torneo con broadcast ⇒ visible en directo, cuadro y replay; ficha y código privados", async () => {
    for (const [botId, battleId] of [
      [BOT.APRIV, BAT.tbRunPriv],
      [BOT.ATEAM, BAT.tbRunTeam],
    ]) {
      const b = await get(`/battles/${battleId}`);
      const p = b.body.participants.find((x: any) => x.botId === botId);
      expect(p).toMatchObject({ version: 1 });
      expect(typeof p.botName).toBe("string");
      expect((await get(`/public/battles/${battleId}`)).status).toBe(200);
      // §20 · la ficha y el código siguen protegidos aunque el bot salga en el stream.
      for (const who of [undefined, tok.B]) {
        expect((await get(`/bots/${botId}`, who)).status).toBe(404);
        expect((await get(`/bots/${botId}/versions`, who)).status).toBe(404);
        expect((await get(`/bots/${botId}/versions/1/source`, who)).status).toBe(who ? 404 : 401);
        expect((await get(`/bots/${botId}/loadouts`, who)).status).not.toBe(200);
        expect((await get(`/bots/${botId}/rating-history`, who)).status).not.toBe(200);
      }
    }
    // Cuadro del torneo con broadcast: los inscritos se identifican (no «Bot privado»);
    // en uno sin broadcast, el mismo bot privado sigue saliendo anónimo.
    for (const tid of [T.TB, T.TN]) {
      await h.db("matches").insert({
        tournament_id: tid,
        round: 9,
        slot: `VIS-${tid.slice(0, 4)}`,
        state: "finished",
        pairing: JSON.stringify({ slot: "VIS", round: 9, home: BOT.APRIV, away: BOT.CPUB }),
        winner_bot_id: BOT.APRIV,
      });
    }
    const mb = (await get(`/tournaments/${T.TB}/matches`)).body.matches.find((m: any) => m.round === 9);
    expect(mb.winnerBotId).toBe(BOT.APRIV);
    expect(mb.pairing.home).toBe(BOT.APRIV);
    // VISIBILIDAD-3 · P3-6 · «bracket con nombre» (§13): el nombre de competición del
    // ganador, con la misma autorización (hiddenBotIds con el contexto del torneo).
    expect(mb.winnerBotName).toBe("A-DEF");
    const mn = (await get(`/tournaments/${T.TN}/matches`)).body.matches.find((m: any) => m.round === 9);
    expect(mn.winnerBotId).toBeNull();
    expect(mn.winnerPrivate).toBe(true);
    expect(mn).not.toHaveProperty("winnerBotName");
    expect(JSON.stringify(mn)).not.toContain("A-DEF");
    expect((await get(`/public/replays/${BAT.tbFinPriv}`)).status).toBe(200);
    expect((await get(`/replays/${BAT.tbFinPriv}`)).status).toBe(200);
  });

  it("D/E: público con código privado ⇒ ficha pública, código privado; con código público ⇒ ambos", async () => {
    expect((await get(`/bots/${BOT.CPUB}`)).status).toBe(200);
    expect((await get(`/bots/${BOT.CPUB}/versions/1/source`, tok.B)).status).toBe(403);
    expect((await get(`/bots/${BOT.CPUBCODE}`)).status).toBe(200);
    expect((await get(`/bots/${BOT.CPUBCODE}/versions/1/source`, tok.B)).status).toBe(200);
  });

  it("§24 · cambiar la visibilidad durante y después del torneo no rompe competición ni replay", async () => {
    for (const v of ["public", "private", "team", "private"]) {
      await request(app).patch(`/bots/${BOT.APRIV}`).set(auth(tok.A)).send({ visibility: v }).expect(200);
      expect((await get(`/battles/${BAT.tbRunPriv}`)).status).toBe(200);
      expect((await get(`/replays/${BAT.tbFinPriv}`)).status).toBe(200);
      expect((await get(`/tournaments/${T.TB}/battles`)).body.items.length).toBeGreaterThanOrEqual(3);
    }
    // Código a privado/público tampoco rompe el replay de una batalla en que se usó.
    await request(app).put(`/bots/${BOT.APRIV}/versions/1/code-visibility`).set(auth(tok.A)).send({ codePublic: true });
    await request(app)
      .put(`/bots/${BOT.APRIV}/versions/1/code-visibility`)
      .set(auth(tok.A))
      .send({ codePublic: false });
    expect((await get(`/replays/${BAT.tbFinPriv}`)).status).toBe(200);
    expect((await get(`/bots/${BOT.APRIV}/versions/1/source`, tok.B)).status).toBe(404);
    expect((await h.db("bots").where({ id: BOT.APRIV }).first()).visibility).toBe("private");
  });
});

// ───────────────────────────────────────────── §33 · fuga
describe("§33 · fuga: sólo la proyección de competición sale del contexto privado", () => {
  const FORBIDDEN = [SECRET_CODE, SECRET_FILENAME, OWNER_EMAIL_LOCAL, OWNER_DISPLAY, SECRET_LOADOUT_NAME];
  function assertClean(where: string, text: string) {
    for (const f of FORBIDDEN) expect(text, `${where} contiene «${f}»`).not.toContain(f);
    expect(text, `${where} contiene el dueño`).not.toContain(U.A);
  }

  it("/broadcast (API anónima), stats, cuadro, replay público y entrada del streamer", async () => {
    const surfaces: [string, string][] = [];
    const push = async (label: string, path: string) => {
      const r = await get(path);
      expect(r.status, `${label} ${path}`).toBe(200);
      surfaces.push([label, Buffer.isBuffer(r.body) ? r.body.toString("utf8") : JSON.stringify(r.body)]);
      return r;
    };
    const battle = await push("getBattle", `/battles/${BAT.tbRunPriv}`);
    for (const p of battle.body.participants) {
      expect(Object.keys(p).sort()).toEqual(expect.arrayContaining(["botId", "version", "team"]));
      expect(p.cpuMs).toBeNull();
      expect(p.diagnosticsVisible).toBe(false);
      expect(p).not.toHaveProperty("ownerId");
      expect(p).not.toHaveProperty("visibility");
    }
    const priv = battle.body.participants.find((p: any) => p.botId === BOT.APRIV);
    expect(priv.botName).toBe("A-DEF"); // §13: nombre, versión y equipo
    const stats = await push("stats", `/battles/${BAT.tbFinPriv}/stats`);
    expect(JSON.stringify(stats.body.diagnostics)).toBe("{}");
    expect(JSON.stringify(stats.body)).not.toContain("decisionTimeouts");
    await push("tournamentBattles", `/tournaments/${T.TB}/battles`);
    const matches = await push("matches", `/tournaments/${T.TB}/matches`);
    expect(matches.body.matches.length).toBeGreaterThan(0);
    expect(JSON.stringify(matches.body)).not.toContain("winnerPrivate");
    await push("publicLive", `/public/battles/live`);
    await push("publicReplay", `/public/replays/${BAT.tbFinPriv}`);
    await push("replayFile", `/replays/${BAT.tbFinPriv}`);
    await push("replayDownload", `/public/replays/${BAT.tbFinPriv}/download`);
    await push("audit", `/battles/${BAT.tbFinPriv}/audit`);
    for (const [label, text] of surfaces) assertClean(label, text);

    // Entrada del streamer: sólo la URL de /broadcast con ids y branding.
    const before = fake.starts().length;
    const r = await request(app)
      .post("/admin/streaming/start")
      .set(auth(tok.admin))
      .send({ target: { kind: "tournament", id: T.TB } });
    expect(r.status).toBeLessThan(300);
    const body = fake.starts().at(-1)!.body;
    expect(fake.starts().length).toBe(before + 1);
    assertClean("streamer start", JSON.stringify(body));
    await request(app).post("/admin/streaming/stop").set(auth(tok.admin)).send({});
  });

  it("el ticket del espectador lleva sólo la batalla (el feed lo sirve el gateway con el roster público)", async () => {
    const t = await request(app).post(`/battles/${BAT.tbRunPriv}/spectate-ticket`);
    expect(t.status).toBe(201);
    const payload = JSON.parse(Buffer.from(String(t.body.ticket).split(".")[1], "base64url").toString("utf8"));
    expect(payload.battleId).toBe(BAT.tbRunPriv);
    expect(payload.anon).toBe(true);
    assertClean("ticket", JSON.stringify(payload));
  });
});

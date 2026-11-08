/**
 * REVIEW #244 (revisor independiente, NO del autor) · ataques de la §36 del encargo
 * «VISIBILIDAD». Cada `it` intenta ROMPER una garantía; si la garantía se pierde, se
 * pone en ROJO (calibrado con mutantes, ver el PR de revisión).
 *
 * BROADCAST VISIBILITY ≠ BOT VISIBILITY · PUBLIC PARTICIPATION ≠ PUBLIC CODE.
 * El arnés (usuarios, bots con marcas reconocibles, batallas, replays) es copia del
 * de `vis-broadcast.test.ts` para que la revisión no dependa de los tests del autor.
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

// ════════════════════════════════════════════════════ ataques del revisor
const MARKS = [SECRET_CODE, SECRET_FILENAME, OWNER_EMAIL_LOCAL, OWNER_DISPLAY, SECRET_LOADOUT_NAME];
const tInput = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  format: "round_robin",
  mode: "deathmatch",
  rulesetId: DEFAULT_RULESET_ID,
  ...extra,
});
/** Status + cuerpo de un error sin el correlationId (varía por petición). */
const shape = (r: request.Response) => {
  const { correlationId: _c, ...rest } = (r.body ?? {}) as Record<string, unknown>;
  return { status: r.status, body: rest };
};
const userIdByDisplay = async (d: string) => (await h.db("users").where({ display_name: d }).first()).id as string;

describe("RV-T · endpoints de torneo: broadcast sólo lo fija el organizador al crear", () => {
  it("RV-T1 · crear con broadcast sin ser organizer ⇒ 403/401 y no se crea ninguna fila; coerciones ⇒ 400", async () => {
    const count = async () => Number((await h.db("tournaments").count({ n: "*" }).first())!.n);
    const before = await count();
    const cap = await tokenFor(h.db, DEV_USERS.team_captain);
    for (const [who, code] of [
      [tok.B, 403], // developer
      [tok.T, 403], // user
      [cap, 403], // team_captain
      [undefined, 401],
    ] as const) {
      const r = await request(app)
        .post("/tournaments")
        .set(auth(who))
        .send(tInput("rv-hack", { broadcast: true }));
      expect(r.status, String(who).slice(0, 8)).toBe(code);
    }
    expect(await count()).toBe(before);
    for (const b of ["true", 1, "1", [true], { v: true }, null]) {
      const r = await request(app)
        .post("/tournaments")
        .set(auth(tok.organizer))
        .send(tInput("rv-coerce", { broadcast: b }));
      expect(r.status, JSON.stringify(b)).toBe(400);
    }
    expect(await count()).toBe(before);
    const tb = await request(app)
      .post("/tournaments")
      .set(auth(tok.organizer))
      .send(tInput("rv-TB", { broadcast: true }));
    const tn = await request(app).post("/tournaments").set(auth(tok.organizer)).send(tInput("rv-TN"));
    expect([tb.status, tn.status]).toEqual([201, 201]);
    T.TB = tb.body.id;
    T.TN = tn.body.id;
    expect(tb.body.broadcast).toBe(true);
    expect(tn.body.broadcast).toBe(false);
    const a = await h
      .db("audit_log")
      .where({ action: "tournament.created", target: `tournament:${T.TB}` })
      .first();
    const detail = typeof a?.detail === "string" ? JSON.parse(a.detail) : a?.detail;
    expect(detail?.broadcast).toBe(true);
  });

  it("RV-T2 · convertir en retransmitible un torneo existente: ni PATCH/PUT ni campos colados en acciones", async () => {
    for (const who of [tok.organizer, tok.admin]) {
      for (const m of ["patch", "put"] as const) {
        const r = await request(app)[m](`/tournaments/${T.TN}`).set(auth(who)).send({ broadcast: true });
        expect(r.status, m).toBeGreaterThanOrEqual(400);
      }
    }
    await request(app).post(`/tournaments/${T.TN}/actions/dry-run`).set(auth(tok.organizer)).send({ broadcast: true });
    const again = await request(app)
      .post("/tournaments")
      .set(auth(tok.organizer))
      .send(tInput("rv-TN", { broadcast: true, id: T.TN }));
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(T.TN);
    expect((await h.db("tournaments").where({ id: T.TN }).first()).broadcast).toBe(false);
    expect((await get(`/tournaments/${T.TN}`)).body.broadcast).toBe(false);
  });

  it("RV-T3 · inscribir un bot ajeno (con el botId que expone el stream) ⇒ 403 para ajeno, miembro, capitán y staff", async () => {
    const cap = await tokenFor(h.db, DEV_USERS.team_captain);
    for (const who of [tok.B, tok.T, cap, tok.organizer, tok.moderator, tok.admin]) {
      const r = await request(app)
        .post(`/tournaments/${T.TB}/entries`)
        .set(auth(who))
        .send({ botId: BOT.APRIV, version: 1 });
      expect(r.status).toBe(403);
    }
    // Miembro del equipo con el bot `team` de su capitán A: tampoco.
    const r = await request(app)
      .post(`/tournaments/${T.TB}/entries`)
      .set(auth(tok.T))
      .send({ botId: BOT.ATEAM, version: 1 });
    expect(r.status).toBe(403);
    expect(await h.db("entries").where({ tournament_id: T.TB })).toHaveLength(0);
  });

  it("RV-T4 · inscribir + cerrar con `broadcast` en el cuerpo no cambia la marca ni ninguna visibilidad", async () => {
    const ids = [BOT.APRIV, BOT.CPUB];
    const before = await snapshotOf(ids);
    for (const [botId, who] of [
      [BOT.APRIV, tok.A],
      [BOT.CPUB, tok.C],
    ] as const) {
      const r = await request(app)
        .post(`/tournaments/${T.TN}/entries`)
        .set(auth(who))
        .send({ botId, version: 1, broadcast: true });
      expect(r.status).toBe(201);
    }
    const r = await request(app)
      .post(`/tournaments/${T.TN}/actions/close-entries`)
      .set(auth(tok.organizer))
      .send({ broadcast: true, state: "open" });
    expect(r.status).toBe(200);
    expect(r.body.broadcast).toBe(false);
    expect((await h.db("tournaments").where({ id: T.TN }).first()).broadcast).toBe(false);
    expect(await snapshotOf(ids)).toEqual(before);
  });
});

describe("RV-C · código: dueño único, reversibilidad sin caché, IDOR", () => {
  let BOTB = "";
  let TEAMBOT = "";
  beforeAll(async () => {
    BOTB = await newBot(await userIdByDisplay("stranger-b"), "B-OWN", "private", null, false);
    const team = await h.db("team_members").where({ user_id: U.A, role: "captain" }).first();
    TEAMBOT = await newBot(await userIdByDisplay("team-member-t"), "T-TEAMBOT", "team", team.team_id, false);
  });
  const put = (who: string | undefined, botId: string, version: string, codePublic: unknown) =>
    request(app).put(`/bots/${botId}/versions/${version}/code-visibility`).set(auth(who)).send({ codePublic });

  it("RV-C1 · capitán del equipo, staff, ajenos y anónimo NO cambian el code_public de un bot de equipo ajeno", async () => {
    const cap = await tokenFor(h.db, DEV_USERS.team_captain);
    expect((await put(tok.A, TEAMBOT, "1", true)).status).toBe(403); // capitán real del equipo: lo ve, no es dueño
    // Staff (moderador/admin) ve el bot: 403. El organizer no es staff y no lo ve: 404.
    for (const s of [tok.moderator, tok.admin]) expect((await put(s, TEAMBOT, "1", true)).status).toBe(403);
    expect((await put(tok.organizer, TEAMBOT, "1", true)).status).toBe(404);
    expect((await put(tok.B, TEAMBOT, "1", true)).status).toBe(404);
    expect((await put(cap, TEAMBOT, "1", true)).status).toBe(404);
    expect((await put(undefined, TEAMBOT, "1", true)).status).toBe(401);
    // Ni la ficha: capitán y staff no pueden cambiar la visibilidad del bot de T.
    for (const s of [tok.A, tok.moderator, tok.admin]) {
      expect((await request(app).patch(`/bots/${TEAMBOT}`).set(auth(s)).send({ visibility: "public" })).status).toBe(
        403,
      );
    }
    expect(
      (await request(app).patch(`/bots/${TEAMBOT}`).set(auth(tok.organizer)).send({ visibility: "public" })).status,
    ).toBe(404);
    expect((await h.db("bots").where({ id: TEAMBOT }).first()).visibility).toBe("team");
    expect((await h.db("bot_versions").where({ bot_id: TEAMBOT, version: 1 }).first()).code_public).toBe(false);
    expect(
      await h.db("audit_log").where({ action: "bot.code_visibility_changed", target: `bot:${TEAMBOT}:v1` }),
    ).toHaveLength(0);
  });

  it("RV-C2 · IDOR: con su botId y versiones raras sólo toca SU versión; los ids colados en el cuerpo se ignoran", async () => {
    const snap = async () =>
      await h
        .db("bot_versions")
        .whereNot({ bot_id: BOTB })
        .orderBy(["bot_id", "version"])
        .select("bot_id", "version", "code_public");
    const others = await snap();
    for (const v of ["0", "-1", "01", "1.0", "1e0", "999", "%31"]) {
      const r = await put(tok.B, BOTB, v, true);
      expect([200, 404], v).toContain(r.status);
    }
    const r = await request(app)
      .put(`/bots/${BOTB}/versions/1/code-visibility`)
      .set(auth(tok.B))
      .send({ codePublic: true, botId: BOT.APRIV, version: 1, id: BOT.APRIV });
    expect(r.status).toBe(200);
    expect(await snap()).toEqual(others);
    expect((await h.db("bot_versions").where({ bot_id: BOT.APRIV, version: 1 }).first()).code_public).toBe(false);
    await put(tok.B, BOTB, "1", false);
  });

  it("RV-C3 · volver el código a privado corta YA source/files/diff/sha, también con If-None-Match del ETag anterior", async () => {
    const before = await get(`/bots/${BOT.CPUBCODE}/versions/1/source`, tok.B);
    expect(before.status).toBe(200);
    const etag = before.headers.etag as string | undefined;
    expect((await put(tok.C, BOT.CPUBCODE, "1", false)).status).toBe(200);
    for (const path of ["source", "files", "diff?against=1"]) {
      const req = request(app).get(`/bots/${BOT.CPUBCODE}/versions/1/${path}`).set(auth(tok.B));
      const r = etag ? await req.set("If-None-Match", etag) : await req;
      expect(r.status, path).toBe(403);
      expect(JSON.stringify(r.body) + (r.text ?? ""), path).not.toContain(SECRET_CODE);
    }
    const v = await get(`/bots/${BOT.CPUBCODE}/versions/1`, tok.B);
    expect(v.body.canReadSource).toBe(false);
    expect(v.body.sourceSha256).toBeUndefined();
    expect(JSON.stringify((await get(`/bots/${BOT.CPUBCODE}/versions`, tok.B)).body)).not.toContain(SECRET_CODE);
    expect((await put(tok.C, BOT.CPUBCODE, "1", true)).status).toBe(200);
  });

  it("RV-C4 · bot privado con código público: el código NO sale, la ficha manda (404 a terceros)", async () => {
    expect((await put(tok.B, BOTB, "1", true)).status).toBe(200);
    for (const who of [tok.A, tok.T, tok.C]) {
      for (const path of ["/source", "/files", ""]) {
        expect((await get(`/bots/${BOTB}/versions/1${path}`, who)).status, path).toBe(404);
      }
    }
    await put(tok.B, BOTB, "1", false);
  });
});

describe("RV-O · oráculos de existencia por id", () => {
  it("RV-O1 · bot privado ≡ id inexistente (status y cuerpo) en ficha, versiones, código, artefacto, rating, PATCH y code-visibility", async () => {
    const ghost = randomUUID();
    const paths = [
      "",
      "/versions",
      "/versions/1",
      "/versions/1/source",
      "/versions/1/files",
      "/versions/1/artifact",
      "/versions/1/diff?against=1",
      "/rating-history",
    ];
    for (const who of [undefined, tok.B, tok.T]) {
      for (const p of paths) {
        const a = await get(`/bots/${BOT.APRIV}${p}`, who);
        const g = await get(`/bots/${ghost}${p}`, who);
        expect(shape(a), `${p} ${String(who).slice(0, 6)}`).toEqual(shape(g));
      }
      const a = await request(app)
        .put(`/bots/${BOT.APRIV}/versions/1/code-visibility`)
        .set(auth(who))
        .send({ codePublic: true });
      const g = await request(app)
        .put(`/bots/${ghost}/versions/1/code-visibility`)
        .set(auth(who))
        .send({ codePublic: true });
      expect(shape(a)).toEqual(shape(g));
      const pa = await request(app).patch(`/bots/${BOT.APRIV}`).set(auth(who)).send({ visibility: "public" });
      const pg = await request(app).patch(`/bots/${ghost}`).set(auth(who)).send({ visibility: "public" });
      expect(shape(pa)).toEqual(shape(pg));
    }
    expect((await h.db("bots").where({ id: BOT.APRIV }).first()).visibility).toBe("private");
  });

  it("RV-O2 · listados: ni por ownerId ni por filtros de replay (bot/user/nombre) se identifica al bot privado de un torneo retransmitido", async () => {
    BAT.tbFin = await newBattle({
      botIds: [BOT.APRIV, BOT.CPUB],
      status: "finished",
      tournamentId: T.TB,
      withReplay: true,
    });
    expect((await get(`/replays/${BAT.tbFin}`)).status).toBe(200);
    // `listReplays` exige sesión (anónimo ⇒ 401): se ataca con un ajeno y con un miembro del equipo.
    expect((await get(`/replays?bot=${BOT.APRIV}`)).status).toBe(401);
    expect((await get(`/bots?ownerId=${U.A}&limit=100`)).body.items.map((b: any) => b.id)).not.toContain(BOT.APRIV);
    for (const who of [tok.B, tok.T]) {
      const bots = await get(`/bots?ownerId=${U.A}&limit=100`, who);
      expect(bots.body.items.map((b: any) => b.id)).not.toContain(BOT.APRIV);
      const q = (s: string) => get(`/replays?${s}&includeTotal=true`, who);
      for (const s of [`bot=${BOT.APRIV}`, `user=${U.A}`, `user=${encodeURIComponent(OWNER_DISPLAY)}`, "bot=A-DEF"]) {
        const r = await q(s);
        expect(r.status, s).toBe(200);
        expect(
          r.body.items.map((x: any) => x.battleId),
          s,
        ).not.toContain(BAT.tbFin);
        expect(r.body.total, s).toBe(0);
      }
      // Por el rival público sí: el filtro no oculta la batalla, oculta la identidad del privado.
      expect((await q(`bot=${BOT.CPUB}`)).body.items.map((x: any) => x.battleId)).toContain(BAT.tbFin);
    }
  });
});

describe("RV-P · proyección pública de una batalla retransmitida", () => {
  it("RV-P1 · battles, public, stats, torneo, cuadro, índice, segmento y bytes del replay: sin marcas privadas ni dueño", async () => {
    BAT.tbRun = await newBattle({ botIds: [BOT.APRIV, BOT.CPUB], status: "running", tournamentId: T.TB });
    const paths = [
      `/battles/${BAT.tbRun}`,
      `/battles/${BAT.tbFin}`,
      `/battles/${BAT.tbFin}/stats`,
      `/public/battles/${BAT.tbFin}`,
      `/public/battles/${BAT.tbRun}`,
      `/public/replays/${BAT.tbFin}`,
      `/public/battles/live`,
      `/tournaments/${T.TB}/battles`,
      `/tournaments/${T.TB}/matches`,
      `/tournaments/${T.TB}`,
      `/replays/${BAT.tbFin}/index`,
      `/replays/${BAT.tbFin}/segment?fromTick=0&toTick=50`,
    ];
    const allowedKeys = new Set(["botId", "botName", "version", "team", "outcome", "cpuMs", "diagnosticsVisible"]);
    let ok = 0;
    for (const p of paths) {
      const r = await get(p);
      if (r.status === 200) ok++;
      const text = JSON.stringify(r.body) + (r.text ?? "");
      for (const m of MARKS) expect(text, `${p} contiene ${m}`).not.toContain(m);
      expect(text, p).not.toContain(U.A);
      expect(text, p).not.toContain("ownerId");
      if (p.startsWith("/battles/") && r.status === 200 && Array.isArray(r.body.participants)) {
        for (const pp of r.body.participants) {
          for (const k of Object.keys(pp)) expect(allowedKeys.has(k), `${p} · ${k}`).toBe(true);
          expect(pp.cpuMs ?? null).toBeNull();
        }
      }
    }
    expect(ok).toBeGreaterThanOrEqual(10); // calibración: las vías existen y responden
    const replay = await request(app)
      .get(`/replays/${BAT.tbFin}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(replay.status).toBe(200);
    const raw = (replay.body as Buffer).toString("latin1");
    expect(raw.length).toBeGreaterThan(100);
    for (const m of MARKS) expect(raw).not.toContain(m);
  });

  it("RV-P2 · ninguna vía pública devuelve el objeto bot completo (visibility, ownerId, teamId, codePublic…)", async () => {
    for (const p of [`/battles/${BAT.tbFin}`, `/tournaments/${T.TB}/battles`, `/replays/${BAT.tbFin}/index`]) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      const text = JSON.stringify(r.body);
      for (const k of [
        '"visibility"',
        '"ownerId"',
        '"owner_id"',
        '"teamId"',
        '"latestPublishedVersion"',
        '"codePublic"',
        '"sourceFilename"',
      ]) {
        expect(text, `${p} · ${k}`).not.toContain(k);
      }
    }
  });
});

describe("RV-S · streaming: destinos ajenos, motivos reales y cambios de visibilidad", () => {
  beforeAll(async () => {
    const v = (await request(app).get("/admin/streaming").set(auth(tok.admin))).body.settings.version;
    const s = await request(app)
      .put("/admin/streaming/settings")
      .set(auth(tok.admin))
      .send({ version: v, enabled: true, mode: "record" });
    expect(s.status).toBe(200);
    BAT.loosePriv = await newBattle({ botIds: [BOT.APRIV, BOT.CPUB], status: "running" });
    BAT.tnPriv = await newBattle({ botIds: [BOT.APRIV, BOT.CPUB], status: "running", tournamentId: T.TN });
    BAT.loosePub = await newBattle({ botIds: [BOT.CPUB, BOT.CPUBCODE], status: "running" });
  });
  const start = (who: string | undefined, kind: string, id: string) =>
    request(app).post("/admin/streaming/start").set(auth(who)).send({ target: { kind, id } });
  const stop = () => request(app).post("/admin/streaming/stop").set(auth(tok.admin)).send({});

  it("RV-S1 · sólo admin arranca: el dueño, el organizer o el moderador no fuerzan la emisión", async () => {
    const n = fake.starts().length;
    for (const who of [tok.A, tok.organizer, tok.moderator, tok.B]) {
      expect((await start(who, "battle", BAT.tbRun)).status).toBe(403);
    }
    expect((await start(undefined, "battle", BAT.tbRun)).status).toBe(401);
    expect(fake.starts().length).toBe(n);
  });

  it("RV-S2 · motivos reales (suelta privada / torneo sin broadcast / ids inexistentes); /broadcast tampoco las lee", async () => {
    const n = fake.starts().length;
    const a = await start(tok.admin, "battle", BAT.loosePriv);
    const b = await start(tok.admin, "battle", BAT.tnPriv);
    expect([a.status, a.body.error]).toEqual([409, "battle_not_public"]);
    expect([b.status, b.body.error]).toEqual([409, "tournament_not_broadcastable"]);
    expect((await start(tok.admin, "battle", randomUUID())).status).toBe(404);
    expect((await start(tok.admin, "tournament", randomUUID())).status).toBe(404);
    expect(fake.starts().length).toBe(n);
    for (const id of [BAT.loosePriv, BAT.tnPriv]) {
      expect((await get(`/battles/${id}`)).status).toBe(404);
      expect((await request(app).post(`/battles/${id}/spectate-ticket`)).status).toBe(404);
    }
  });

  it("RV-S3 · durante la emisión el dueño vuelve privado su bot: la batalla suelta deja de ser legible; el torneo retransmitido sigue", async () => {
    expect((await start(tok.admin, "battle", BAT.loosePub)).status).toBeLessThan(300);
    expect((await get(`/battles/${BAT.loosePub}`)).status).toBe(200);
    expect(
      (await request(app).patch(`/bots/${BOT.CPUB}`).set(auth(tok.C)).send({ visibility: "private" })).status,
    ).toBe(200);
    expect((await get(`/battles/${BAT.loosePub}`)).status).toBe(404);
    expect((await request(app).post(`/battles/${BAT.loosePub}/spectate-ticket`)).status).toBe(404);
    const tgt = await request(app).get(`/admin/streaming/target?kind=battle&id=${BAT.loosePub}`).set(auth(tok.admin));
    expect(tgt.body.broadcastable).toBe(false);
    expect((await stop()).status).toBeLessThan(300);
    expect((await get(`/battles/${BAT.tbRun}`)).status).toBe(200);
    expect((await get(`/replays/${BAT.tbFin}`)).status).toBe(200);
    expect((await get(`/bots/${BOT.CPUB}`)).status).toBe(404);
    expect((await request(app).patch(`/bots/${BOT.CPUB}`).set(auth(tok.C)).send({ visibility: "public" })).status).toBe(
      200,
    );
  });

  it("RV-S4 · emitir el torneo, terminar la batalla y emitir su replay no muta bots ni code_public", async () => {
    const ids = [BOT.APRIV, BOT.ATEAM, BOT.CPUB, BOT.CPUBCODE];
    const before = await snapshotOf(ids);
    expect((await start(tok.admin, "tournament", T.TB)).status).toBeLessThan(300);
    await h.db("battles").where({ id: BAT.tbRun }).update({ status: "finished", finished_at: h.db.fn.now() });
    expect((await stop()).status).toBeLessThan(300);
    expect((await start(tok.admin, "battle", BAT.tbFin)).status).toBeLessThan(300);
    expect((await stop()).status).toBeLessThan(300);
    expect(await snapshotOf(ids)).toEqual(before);
  });
});

describe("RV-DB · el guardián ya no protege code_public: la garantía es SÓLO de la ruta", () => {
  it("RV-DB1 · por SQL code_public cambia en ambos sentidos sin auditoría; el resto del guardián sigue", async () => {
    const q = () => h.db("bot_versions").where({ bot_id: BOT.APRIV, version: 1 });
    const n0 = (await h.db("audit_log").where({ action: "bot.code_visibility_changed" })).length;
    await q().update({ code_public: true });
    await q().update({ code_public: false });
    expect((await q().first()).code_public).toBe(false);
    expect((await h.db("audit_log").where({ action: "bot.code_visibility_changed" })).length).toBe(n0);
    await expect(q().update({ source: Buffer.from("x") })).rejects.toThrow(/bot_version_immutable/);
  });
});

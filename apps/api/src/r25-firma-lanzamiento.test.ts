/**
 * R2.5 (ERR-SEC-15) · Firma verificable de artefactos:
 *  - clave privada desde el almacén de secretos (no efímera) — fallar cerrado;
 *  - la clave PÚBLICA se publica (GET /keys/artifact-signing);
 *  - la firma se verifica ANTES de cada lanzamiento: un artefacto manipulado
 *    se rechaza y el bot no se lanza.
 *
 * DoD: "La firma de un artefacto se verifica con la clave pública publicada;
 * un artefacto manipulado se rechaza."
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createHash } from "node:crypto";
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { E6PipelineBotManager } from "./services/e6-bot-manager.js";
import { runBuildWorkerOnce } from "../../bot-manager/src/build-worker.js";
import {
  exportPrivateKeyPem,
  generateServiceKeypair,
  keypairFromPrivatePem,
  loadServiceKeypair,
  publicKeyPem,
  signArtifact,
} from "../../bot-manager/src/signing.js";
import { DbArtifactLaunchGuard } from "../../bot-manager/src/launch-verify.js";
import { pyGoodFiles, goodCandidate, referenceAgent } from "../../bot-manager/tests/fixtures.js";
import { makeRunBattleHandler, type BattleContext } from "../../tournament-worker/src/battle-runner.js";
import { createBots, insertScheduledBattle, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";
import type { JobRow } from "../../tournament-worker/src/queue.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOOD_LOADOUT = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "..", "packages", "module-catalog", "examples", "loadout-medium-gunner.json"),
    "utf8",
  ),
);

let h: TestDbHandle;
let app: Express;
const auth = { Authorization: "" };
// La MISMA clave que publica la API (loadServiceKeypair): en tests, el par de
// dev-insecure cacheado por proceso; en producción, el del almacén de secretos.
const signer = loadServiceKeypair();

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db });
  auth.Authorization = `Bearer ${await tokenFor(h.db, DEV_USERS.developer)}`;
}, 120_000);

afterAll(async () => {
  await h.stop();
});

describe("R2.5 · clave de firma desde el almacén de secretos (no efímera)", () => {
  it("ARTIFACT_SIGNING_KEY_FILE/ARTIFACT_SIGNING_KEY cargan un par estable; la pública se deriva", () => {
    const kp = generateServiceKeypair();
    const pem = exportPrivateKeyPem(kp);
    const loadedVar = loadServiceKeypair({ ARTIFACT_SIGNING_KEY: pem } as NodeJS.ProcessEnv);
    // Mismo material: la pública derivada coincide con la original.
    expect(publicKeyPem(loadedVar.publicKey)).toBe(publicKeyPem(kp.publicKey));
    // Dos cargas del MISMO secreto son la MISMA clave (no efímera por proceso).
    const again = loadServiceKeypair({ ARTIFACT_SIGNING_KEY: pem } as NodeJS.ProcessEnv);
    expect(publicKeyPem(again.publicKey)).toBe(publicKeyPem(kp.publicKey));
  });

  it("falla CERRADO sin clave y sin modo dev explícito", () => {
    expect(() => loadServiceKeypair({} as NodeJS.ProcessEnv)).toThrow(/ARTIFACT_SIGNING_KEY/);
  });

  it("rechaza claves que no sean ed25519", () => {
    expect(() => keypairFromPrivatePem("-----BEGIN PRIVATE KEY-----\nno-valido\n-----END PRIVATE KEY-----")).toThrow();
  });

  it("la clave pública se PUBLICA por la API y coincide con la de firma", async () => {
    const res = await request(app).get("/keys/artifact-signing"); // sin auth: pública
    expect(res.status).toBe(200);
    expect(res.body.algorithm).toBe("ed25519");
    expect(res.body.publicKeyPem).toBe(publicKeyPem(signer.publicKey));
    // El PEM publicado es una clave usable: la parsea crypto sin error.
    expect(() => createPublicKey(res.body.publicKeyPem)).not.toThrow();
  });
});

describe("R2.5 · el pipeline persiste artefacto firmado y el guard lo verifica antes de lanzar", () => {
  let botId: string;

  it("un build validado deja artefacto con bytes + firma verificables con la clave publicada", async () => {
    const bot = await request(app).post("/bots").set(auth).send({ name: "r25-firma-bot" });
    const loadout = await request(app).post(`/bots/${bot.body.id}/loadouts`).set(auth).send(GOOD_LOADOUT);
    expect(loadout.status).toBe(201);
    const version = await request(app)
      .post(`/bots/${bot.body.id}/versions`)
      .set(auth)
      .field("runtime", "python")
      .field("loadoutRevision", "1")
      .attach("source", Buffer.from(JSON.stringify({ files: pyGoodFiles })), "package.json");
    expect(version.status).toBe(201);
    botId = bot.body.id as string;

    const submit = await request(app).post(`/bots/${botId}/versions/1/actions/submit`).set(auth);
    expect(submit.status).toBe(202);
    const executor = new E6PipelineBotManager(h.db, { signer, agentResolver: () => goodCandidate, referenceAgent });
    const tick = await runBuildWorkerOnce(h.db, executor, { workerId: "firma-worker" });
    expect(tick.outcome).toBe("done");

    const v = await h.db("bot_versions").where({ bot_id: botId, version: 1 }).first();
    expect(v.state).toBe("validated");
    const art = await h.db("artifacts").where({ hash: v.artifact_hash }).first();
    expect(art).toBeTruthy();
    expect(art.signature).toBeTruthy();
    expect(art.bytes).toBeTruthy();
    // El hash firmado es el sha256 REAL de los bytes persistidos.
    expect(createHash("sha256").update(Buffer.from(art.bytes)).digest("hex")).toBe(art.hash);

    const guard = new DbArtifactLaunchGuard(h.db, signer.publicKey);
    expect((await guard.check(botId, 1)).ok).toBe(true);
  }, 60_000);

  it("un artefacto MANIPULADO se rechaza; sin bytes o sin firma también (fail closed)", async () => {
    const v = await h.db("bot_versions").where({ bot_id: botId, version: 1 }).first();
    const guard = new DbArtifactLaunchGuard(h.db, signer.publicKey);
    const original = await h.db("artifacts").where({ hash: v.artifact_hash }).first();

    // Bytes alterados (un byte cambia): hash ya no coincide ⇒ rechazo.
    const tampered = Buffer.from(original.bytes);
    tampered[0] = tampered[0] ^ 0xff;
    await h.db("artifacts").where({ id: original.id }).update({ bytes: tampered });
    const r1 = await guard.check(botId, 1);
    expect(r1.ok).toBe(false);
    expect(r1.reason).toMatch(/manipulado/);

    // Firma inválida (de OTRA clave) sobre bytes intactos ⇒ rechazo.
    const otherKey = generateServiceKeypair();
    await h
      .db("artifacts")
      .where({ id: original.id })
      .update({ bytes: original.bytes, signature: signArtifact(original.hash, otherKey.privateKey) });
    const r2 = await guard.check(botId, 1);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toMatch(/firma/);

    // Sin bytes persistidos ⇒ no hay nada que verificar ⇒ rechazo, nunca "pasa".
    await h.db("artifacts").where({ id: original.id }).update({ bytes: null, signature: original.signature });
    const r3 = await guard.check(botId, 1);
    expect(r3.ok).toBe(false);

    // Versión sin artefacto ⇒ rechazo.
    const r4 = await guard.check(botId, 99);
    expect(r4.ok).toBe(false);

    // Restaurado el artefacto íntegro, vuelve a ser lanzable.
    await h.db("artifacts").where({ id: original.id }).update({ bytes: original.bytes, signature: original.signature });
    expect((await guard.check(botId, 1)).ok).toBe(true);
  });
});

describe("R2.5 · verificación ANTES de cada lanzamiento en batalla", () => {
  let bots: TestBot[];

  /** Da a un bot de fixtures un artefacto REALMENTE firmado (o manipulado). */
  async function signFixtureArtifact(bot: TestBot, opts: { tamper?: boolean } = {}): Promise<void> {
    const bytes = Buffer.from(`artefacto-canonico-${bot.name}`);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const stored = opts.tamper ? Buffer.concat([bytes, Buffer.from("!")]) : bytes;
    await h.db("bot_versions").where({ bot_id: bot.botId, version: bot.version }).update({ artifact_hash: hash });
    const build = await h.db("builds").where({ bot_id: bot.botId, version: bot.version }).first();
    await h
      .db("artifacts")
      .where({ build_id: build.id })
      .update({ hash, signature: signArtifact(hash, signer.privateKey), bytes: stored });
  }

  it("el bot cuyo artefacto fue manipulado NO se lanza: descalificado, walkover del íntegro", async () => {
    bots = await createBots(h.db, 2, "r25-lanza");
    await signFixtureArtifact(bots[0]); // íntegro
    await signFixtureArtifact(bots[1], { tamper: true }); // manipulado en el almacén

    const battleId = await insertScheduledBattle(h.db, bots[0], bots[1], { seed: "r25-firma" });
    let executed = false;
    const handler = makeRunBattleHandler({
      executor: async (_ctx: BattleContext) => {
        executed = true;
        throw new Error("la batalla NO debe ejecutarse: queda un solo bando");
      },
      artifactGuard: new DbArtifactLaunchGuard(h.db, signer.publicKey),
    });
    await handler({ payload: { battleId } } as unknown as JobRow, { db: h.db, workerId: "t" });

    expect(executed).toBe(false); // el motor nunca llegó a lanzar al manipulado
    const battle = await h.db("battles").where({ id: battleId }).first();
    expect(battle.status).toBe("finished");
    expect(battle.final_state_hash).toBe("walkover");
    const result = typeof battle.result === "string" ? JSON.parse(battle.result) : battle.result;
    expect(result.disqualified).toContain(bots[1].botId);
    const pB = await h.db("participants").where({ battle_id: battleId, bot_id: bots[1].botId }).first();
    expect(pB.outcome).toBe("disqualified");
    const pA = await h.db("participants").where({ battle_id: battleId, bot_id: bots[0].botId }).first();
    expect(pA.outcome).toBe("win");
  }, 60_000);

  it("con ambos artefactos íntegros la batalla SÍ se lanza", async () => {
    await signFixtureArtifact(bots[1]); // repara el manipulado
    const battleId = await insertScheduledBattle(h.db, bots[0], bots[1], { seed: "r25-firma-ok" });
    let executed = false;
    const handler = makeRunBattleHandler({
      executor: async (ctx: BattleContext) => {
        executed = true;
        expect(ctx.adminDisqualified).toEqual([]);
        return {
          winner: "A" as const,
          ticks: 10,
          score: { A: 1, B: 0 },
          finalStateHash: "h",
          disqualified: [],
          versions: {},
        };
      },
      artifactGuard: new DbArtifactLaunchGuard(h.db, signer.publicKey),
    });
    await handler({ payload: { battleId } } as unknown as JobRow, { db: h.db, workerId: "t" });
    expect(executed).toBe(true);
  }, 60_000);
});

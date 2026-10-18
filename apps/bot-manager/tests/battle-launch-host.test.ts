/**
 * REVIEW (cierre funcional, R4.1) · createBattleLaunchHost: contrato B↔A sin Docker.
 *
 * Comprueba con BD real (PG embebido) y HTTP real del SandboxHost que el plan de
 * cada bot es «imagen de RUNTIME fijada + bootstrap + oferta del ARTEFACTO FIRMADO
 * de SU versión», que el artefacto se sirve sólo con el token de la oferta, y que
 * falla CERRADO ante versión no publicada, artefacto manipulado o firma ajena.
 * El E2E con contenedores reales está en
 * apps/tournament-worker/src/container-battle-e2e.test.ts (opt-in Docker).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { exportPrivateKeyPem, generateServiceKeypair, publicKeyPem, signArtifact } from "../src/signing.js";
import {
  BotLaunchRefused,
  bootstrapCmd,
  createBattleLaunchHost,
  loadArtifactVerifyKey,
  type RuntimeImages,
} from "../src/bot-launch.js";
import { ARTIFACT_TOKEN_HEADER } from "../src/sandbox-host.js";

const IMAGES: RuntimeImages = {
  python: `ghcr.io/example/runtime-python@sha256:${"1a".repeat(32)}`,
  node: `ghcr.io/example/runtime-node@sha256:${"2b".repeat(32)}`,
};
const signer = generateServiceKeypair();
const otherSigner = generateServiceKeypair();
let h: TestDbHandle;
let ownerId: string;

async function versionWithArtifact(
  name: string,
  opts: { state?: string; tamper?: boolean; signWith?: typeof signer } = {},
): Promise<{ botId: string; version: number; bytes: Buffer; hash: string }> {
  const [bot] = await h.db("bots").insert({ name, owner_id: ownerId }).returning("id");
  const cat = (await h.db("catalog_versions").first()).catalog_version;
  await h.db("bot_loadouts").insert({
    bot_id: bot.id,
    revision: 1,
    catalog_version: cat,
    chassis: "chassis.medium@1",
    modules: JSON.stringify([]),
  });
  const bytes = Buffer.from(`arena-artifact/v1 ${name}`);
  const hash = createHash("sha256").update(bytes).digest("hex");
  await h.db("bot_versions").insert({
    bot_id: bot.id,
    version: 1,
    state: opts.state ?? "published",
    runtime: "python",
    loadout_revision: 1,
    artifact_hash: hash,
  });
  const [build] = await h
    .db("builds")
    .insert({ bot_id: bot.id, version: 1, status: "passed", artifact_hash: hash })
    .returning("id");
  await h.db("artifacts").insert({
    build_id: build.id,
    hash,
    signature: signArtifact(hash, (opts.signWith ?? signer).privateKey),
    storage_ref: `db://${name}`,
    bytes: opts.tamper ? Buffer.concat([bytes, Buffer.from("!")]) : bytes,
  });
  return { botId: bot.id as string, version: 1, bytes, hash };
}

const planInput = (botId: string, version: number) => ({
  botId,
  version,
  vehicleId: "veh_0",
  wireBotId: "bot_0",
  battleToken: "tok-battle",
  wsUrl: "ws://engine.example.internal:1234",
});

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  ownerId = (await h.db("users").first()).id;
}, 120_000);

afterAll(async () => {
  await h?.stop();
});

describe("createBattleLaunchHost", () => {
  it("plan = runtime fijado + bootstrap + oferta del artefacto firmado de ESA versión; HTTP con token", async () => {
    const v = await versionWithArtifact("fcrev-lh-ok");
    const host = await createBattleLaunchHost(h.db, {
      engineHost: "127.0.0.1",
      battleId: "b-1",
      bindHost: "127.0.0.1",
      publicKey: signer.publicKey,
      runtimeImages: IMAGES,
    });
    try {
      expect(host.port).toBeGreaterThan(0);
      const plan = await host.plan(planInput(v.botId, v.version));
      expect(plan.imageDigest).toBe(IMAGES.python);
      expect(plan.imageDigest).not.toContain(v.hash);
      expect(plan.cmd).toEqual(bootstrapCmd("python"));
      expect(plan.autoRemove).toBe(true);
      expect(plan.artifactHash).toBe(v.hash);
      expect(plan.env.ARTIFACT_SHA256).toBe(v.hash);
      expect(plan.env.WS_URL).toBe("ws://engine.example.internal:1234");
      expect(plan.env.BOT_ID).toBe("bot_0");
      const url = plan.env.ARTIFACT_URL;
      const ok = await fetch(url, { headers: { [ARTIFACT_TOKEN_HEADER]: plan.env.ARTIFACT_TOKEN } });
      expect(ok.status).toBe(200);
      expect(Buffer.from(await ok.arrayBuffer()).equals(v.bytes)).toBe(true);
      const noTok = await fetch(url);
      expect(noTok.status).toBe(403);
      expect(host.offers()[0].fetches).toBe(1);
      await host.close();
      // Tras cerrar, la oferta no existe.
      await expect(fetch(url, { headers: { [ARTIFACT_TOKEN_HEADER]: plan.env.ARTIFACT_TOKEN } })).rejects.toThrow();
    } finally {
      await host.close().catch(() => undefined);
    }
  });

  it.each([
    ["versión no publicada (validated)", { state: "validated" }, /está validated/],
    ["artefacto manipulado en el almacén", { tamper: true }, /manipulado/],
    ["firma de OTRA clave", { signWith: otherSigner }, /firma/],
  ])("falla CERRADO: %s", async (_label, opts, re) => {
    const v = await versionWithArtifact(`fcrev-lh-${Math.random().toString(36).slice(2, 8)}`, opts);
    const host = await createBattleLaunchHost(h.db, {
      engineHost: "127.0.0.1",
      battleId: "b-neg",
      bindHost: "127.0.0.1",
      publicKey: signer.publicKey,
      runtimeImages: IMAGES,
    });
    try {
      await expect(host.plan(planInput(v.botId, v.version))).rejects.toThrow(BotLaunchRefused);
      await expect(host.plan(planInput(v.botId, v.version))).rejects.toThrow(re);
      expect(host.offers()).toHaveLength(0);
    } finally {
      await host.close();
    }
  });
});

describe("loadArtifactVerifyKey", () => {
  it("prefiere la clave PÚBLICA (ARTIFACT_VERIFY_KEY_FILE) y no necesita la privada", () => {
    const dir = mkdtempSync(join(tmpdir(), "fcrev-key-"));
    const pub = join(dir, "verify.pem");
    writeFileSync(pub, publicKeyPem(signer.publicKey), { mode: 0o600 });
    const k = loadArtifactVerifyKey({ ARTIFACT_VERIFY_KEY_FILE: pub });
    expect(publicKeyPem(k)).toBe(publicKeyPem(signer.publicKey));
  });

  it("sin pública, deriva de la de firma; sin ninguna, falla cerrado", () => {
    const dir = mkdtempSync(join(tmpdir(), "fcrev-key-"));
    const priv = join(dir, "sign.pem");
    writeFileSync(priv, exportPrivateKeyPem(signer), { mode: 0o600 });
    expect(publicKeyPem(loadArtifactVerifyKey({ ARTIFACT_SIGNING_KEY_FILE: priv }))).toBe(
      publicKeyPem(signer.publicKey),
    );
    expect(() => loadArtifactVerifyKey({})).toThrow(/clave/);
    expect(() => loadArtifactVerifyKey({ ARTIFACT_VERIFY_KEY_FILE: join(dir, "no-existe.pem") })).toThrow(/ilegible/);
  });
});

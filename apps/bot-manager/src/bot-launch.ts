/**
 * DEV-A · TD-001 / A9.14 — cómo se ARRANCA el código de una versión de bot.
 *
 * Contrato único para los dos consumidores del sandbox:
 *   - el pipeline de build (build-sandbox.ts), con el artefacto recién empaquetado;
 *   - el worker de batallas (DEV-B), con el artefacto firmado de una versión
 *     publicada, vía `resolveBotLaunch(db, botId, version)`.
 *
 * La imagen NO es por bot: es la imagen de RUNTIME fijada por digest en
 * runtimes/DIGESTS.lock (python|node). El código llega como artefacto canónico
 * (`arena-artifact/v1`, el mismo cuyo sha256 se firma) que el bootstrap descarga
 * del SandboxHost y verifica antes de ejecutar. Por eso `artifact_hash` NO es un
 * digest de imagen y no debe pasarse como `imageDigest`.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey, type KeyObject } from "node:crypto";
import type { Knex } from "knex";
import { assertRealDigest } from "./digest-guard.js";
import { DEFAULT_LIMITS, type ContainerLimits, type SandboxSpec } from "./container-runner.js";
import { DEFAULT_SECCOMP_PROFILE } from "./container-battle.js";
import { loadServiceKeypair, verifyArtifact } from "./signing.js";
import { findVersionArtifact } from "./launch-verify.js";
import { SandboxHost, type ArtifactOffer } from "./sandbox-host.js";
import type { WebSocketServer } from "ws";
import type { Runtime } from "./types.js";
import type { BootstrapSignals } from "./startup-clock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
export const DEFAULT_DIGESTS_LOCK = join(REPO_ROOT, "runtimes", "DIGESTS.lock");
const BOOTSTRAP_DIR = join(__dirname, "sandbox-bootstrap");

export type RuntimeImages = Record<Runtime, string>;

/**
 * Imágenes de runtime fijadas por digest. Fuente: runtimes/DIGESTS.lock (columna 3),
 * o `RUNTIME_DIGESTS_LOCK` si la imagen del servicio lo deja en otra ruta. Falla
 * CERRADO si falta el fichero, un runtime o el digest es placeholder.
 */
export function loadRuntimeImages(env: NodeJS.ProcessEnv = process.env): RuntimeImages {
  const path = env.RUNTIME_DIGESTS_LOCK || DEFAULT_DIGESTS_LOCK;
  if (!existsSync(path)) throw new Error(`no existe ${path}: sin digests de runtime no se lanza ningún bot`);
  const found: Partial<RuntimeImages> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [runtime, , image] = line.split(/\s+/);
    if ((runtime === "python" || runtime === "node") && image) found[runtime] = image;
  }
  for (const rt of ["python", "node"] as const) {
    const image = found[rt];
    if (!image || !/@sha256:[0-9a-f]{64}$/.test(image)) {
      throw new Error(`DIGESTS.lock sin imagen de runtime ${rt} fijada por digest (${image ?? "ausente"})`);
    }
    assertRealDigest(image, `imagen de runtime ${rt}`);
  }
  return found as RuntimeImages;
}

/** Argumentos tras el ENTRYPOINT del runtime que arrancan el código de usuario. */
export function bootstrapCmd(runtime: Runtime): string[] {
  if (runtime === "python") return ["-c", readFileSync(join(BOOTSTRAP_DIR, "bootstrap.py"), "utf8")];
  return ["--input-type=module", "-e", readFileSync(join(BOOTSTRAP_DIR, "bootstrap.mjs"), "utf8")];
}

export interface LaunchSpecInput {
  runtime: Runtime;
  imageDigest: string;
  botId: string;
  version: number;
  /** Identificador de la sesión (battleId, o `build-<buildId>`). */
  sessionId: string;
  network: string;
  wsUrl: string;
  battleToken: string;
  /** Identificador del bot EN EL CABLE (protocolBotHandle), no el uuid. */
  botHandle: string;
  offer: Pick<ArtifactOffer, "url" | "token" | "sha256">;
  limits?: ContainerLimits;
  seccompProfilePath?: string;
  autoRemove?: boolean;
}

/** SandboxSpec completo (imagen de runtime + bootstrap + entorno) para una sesión. */
export function launchSpecForBot(i: LaunchSpecInput): SandboxSpec {
  return {
    imageDigest: i.imageDigest,
    botId: i.botId,
    version: i.version,
    battleId: i.sessionId,
    network: i.network,
    engineEndpoint: i.wsUrl,
    env: {
      WS_URL: i.wsUrl,
      BATTLE_TOKEN: i.battleToken,
      BOT_ID: i.botHandle,
      ARTIFACT_URL: i.offer.url,
      ARTIFACT_TOKEN: i.offer.token,
      ARTIFACT_SHA256: i.offer.sha256,
    },
    limits: i.limits ?? DEFAULT_LIMITS,
    seccompProfilePath: i.seccompProfilePath ?? DEFAULT_SECCOMP_PROFILE,
    cmd: bootstrapCmd(i.runtime),
    autoRemove: i.autoRemove ?? true,
  };
}

export class BotLaunchRefused extends Error {}

export interface ResolvedBotLaunch {
  botVersionId: string;
  botId: string;
  version: number;
  runtime: Runtime;
  imageDigest: string;
  cmd: string[];
  artifactHash: string;
  artifactBytes: Buffer;
  signature: string;
  buildId: string;
  loadoutRevision: number;
}

/**
 * Resuelve lo necesario para ARRANCAR (bot_id, version) en una batalla. Falla
 * cerrado (BotLaunchRefused) si la versión no está published|frozen, no tiene el
 * artefacto de SU build, faltan bytes/firma o la firma no verifica.
 */
export async function resolveBotLaunch(
  db: Knex,
  botId: string,
  version: number,
  opts: { publicKey: KeyObject; runtimeImages?: RuntimeImages; allowedStates?: string[] },
): Promise<ResolvedBotLaunch> {
  const allowed = opts.allowedStates ?? ["published", "frozen"];
  const v = await db("bot_versions").where({ bot_id: botId, version }).first();
  if (!v) throw new BotLaunchRefused(`versión inexistente: ${botId} v${version}`);
  if (!allowed.includes(v.state))
    throw new BotLaunchRefused(`${botId} v${version} está ${v.state}, no ${allowed.join("|")}`);
  const art = await findVersionArtifact(db, v);
  if (!art) throw new BotLaunchRefused(`${botId} v${version} sin artefacto de su build`);
  if (!art.bytes || !art.signature) throw new BotLaunchRefused(`${botId} v${version}: artefacto sin bytes o sin firma`);
  const bytes = Buffer.from(art.bytes);
  const check = verifyArtifact({
    artifactBytes: bytes,
    signedHash: art.hash,
    signature: art.signature,
    publicKey: opts.publicKey,
  });
  if (!check.ok) throw new BotLaunchRefused(`${botId} v${version}: ${check.reason}`);
  const images = opts.runtimeImages ?? loadRuntimeImages();
  const runtime = v.runtime as Runtime;
  return {
    botVersionId: v.id,
    botId,
    version,
    runtime,
    imageDigest: images[runtime],
    cmd: bootstrapCmd(runtime),
    artifactHash: art.hash,
    artifactBytes: bytes,
    signature: art.signature,
    buildId: art.build_id,
    loadoutRevision: v.loadout_revision,
  };
}

/**
 * REVIEW (cierre funcional, R4.1) · Clave PÚBLICA con la que el worker de
 * batallas verifica la firma de los artefactos antes de lanzarlos.
 *
 * Mínimo privilegio: el worker sólo VERIFICA, así que lo normal es darle la
 * clave pública (`ARTIFACT_VERIFY_KEY_FILE`, PEM SPKI ed25519, generada por
 * init-secrets.sh a partir de la privada). Sólo si no la hay se deriva de la
 * clave de firma (`ARTIFACT_SIGNING_KEY_FILE`/`ARTIFACT_SIGNING_KEY`, o el par
 * efímero de dev), con las mismas reglas de fallar cerrado que loadServiceKeypair.
 */
export function loadArtifactVerifyKey(env: NodeJS.ProcessEnv = process.env): KeyObject {
  const file = env.ARTIFACT_VERIFY_KEY_FILE;
  if (file) {
    let pem: string;
    try {
      pem = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`ARTIFACT_VERIFY_KEY_FILE apunta a un archivo ilegible: ${file}`);
    }
    if (!pem) throw new Error(`ARTIFACT_VERIFY_KEY_FILE apunta a un archivo vacío: ${file}`);
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error(`la clave de verificación de artefactos debe ser ed25519, no '${key.asymmetricKeyType}'`);
    }
    return key;
  }
  return loadServiceKeypair(env).publicKey;
}

/** Plan de lanzamiento de UN bot (forma estructural de BotLaunchPlan del tournament-worker). */
export interface BattleBotLaunchPlan {
  imageDigest: string;
  env: Record<string, string>;
  cmd: string[];
  autoRemove: boolean;
  /** Procedencia: qué se va a ejecutar exactamente. */
  artifactHash: string;
  buildId: string;
  /** TD-034 · señales del bootstrap de esta sesión (descarga, `ready`, fallos). */
  startup: BootstrapSignals;
}

/** Host de UNA batalla (forma estructural de BattleLaunchHost del tournament-worker). */
export interface BotBattleLaunchHost {
  wss: WebSocketServer;
  port: number;
  plan(bot: {
    botId: string;
    version: number;
    vehicleId: string;
    wireBotId: string;
    battleToken: string;
    wsUrl: string;
  }): Promise<BattleBotLaunchPlan>;
  /** Ofertas vivas (diagnóstico/tests): descargas e informes del bootstrap. */
  offers(): readonly ArtifactOffer[];
  close(): Promise<void>;
}

export interface BattleLaunchHostOptions {
  /** Nombre con el que los contenedores alcanzan ESTE proceso en la red arena. */
  engineHost: string;
  battleId: string;
  bindHost?: string;
  /** Inyectables (tests); por defecto se cargan del entorno, fallando cerrado. */
  publicKey?: KeyObject;
  runtimeImages?: RuntimeImages;
  env?: NodeJS.ProcessEnv;
}

/**
 * REVIEW (cierre funcional, R4.1) · Contrato B↔A: el worker de batallas lanza el
 * ARTEFACTO FIRMADO de la versión EXACTA (bot_id, version) de cada participante.
 *
 * Abre un SandboxHost (HTTP del artefacto + WS del protocolo en un puerto); por
 * cada bot, `resolveBotLaunch` verifica estado published|frozen, artefacto DE SU
 * build, sha256 y firma ed25519 (falla cerrado), se ofrece el artefacto con un
 * token propio y se devuelve el SandboxSpec de `launchSpecForBot` (imagen de
 * runtime fijada por digest + bootstrap que descarga y verifica el sha256). Nada
 * de imágenes construidas al vuelo ni de `artifact_hash` como imagen.
 */
export async function createBattleLaunchHost(db: Knex, opts: BattleLaunchHostOptions): Promise<BotBattleLaunchHost> {
  const env = opts.env ?? process.env;
  const publicKey = opts.publicKey ?? loadArtifactVerifyKey(env);
  const runtimeImages = opts.runtimeImages ?? loadRuntimeImages(env);
  const network = env.ARENA_NETWORK || "arena";
  const host = await SandboxHost.start({ advertiseHost: opts.engineHost, bindHost: opts.bindHost, port: 0 });
  const offers: ArtifactOffer[] = [];
  return {
    wss: host.wss,
    port: host.port,
    async plan(bot) {
      const r = await resolveBotLaunch(db, bot.botId, bot.version, { publicKey, runtimeImages });
      const offer = host.offerArtifact(r.artifactBytes, r.artifactHash);
      offers.push(offer);
      const spec = launchSpecForBot({
        runtime: r.runtime,
        imageDigest: r.imageDigest,
        botId: bot.botId,
        version: bot.version,
        sessionId: opts.battleId,
        network,
        wsUrl: bot.wsUrl,
        battleToken: bot.battleToken,
        botHandle: bot.wireBotId,
        offer,
      });
      return {
        imageDigest: spec.imageDigest,
        env: spec.env,
        cmd: spec.cmd!,
        autoRemove: spec.autoRemove ?? true,
        artifactHash: r.artifactHash,
        buildId: r.buildId,
        startup: offer.signals,
      };
    },
    offers: () => offers,
    async close() {
      for (const o of offers) o.revoke();
      await host.close();
    },
  };
}

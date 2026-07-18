/**
 * E6 · bot-manager — firma y verificación del artefacto (T6.1).
 *
 * DoD T6.1: "La firma del artefacto se verifica ANTES de cada ejecución en batalla;
 * un artefacto manipulado se rechaza."
 *
 * Usamos Ed25519 nativo de Node (crypto). El servicio tiene un par de claves; firma el
 * hash del artefacto. El motor/orquestador de ejecución llama a verifyArtifact() con el
 * artefacto que va a lanzar y la firma registrada; si el artefacto fue alterado (su hash
 * ya no coincide, o la firma no valida contra la clave pública del servicio) rehúsa
 * lanzarlo. En producción la clave privada vive en un secreto del servicio; aquí se
 * genera/inyecta para poder probar la propiedad de verdad.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";

export interface ServiceKeypair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function generateServiceKeypair(): ServiceKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey };
}

/** PEM (SPKI) de la clave pública, apto para publicarse tal cual. */
export function publicKeyPem(publicKey: KeyObject): string {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

/** PEM (PKCS8) de la clave privada — SOLO para provisionar el secreto (scripts/tests). */
export function exportPrivateKeyPem(keypair: ServiceKeypair): string {
  return keypair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/** Construye el par a partir de la clave privada PEM (la pública se DERIVA: no puede divergir). */
export function keypairFromPrivatePem(pem: string): ServiceKeypair {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `la clave de firma de artefactos debe ser ed25519, no '${privateKey.asymmetricKeyType}'`,
    );
  }
  // Nota: los tipos de @types/node de este repo no admiten KeyObject directo aquí.
  return { privateKey, publicKey: createPublicKey({ key: privateKey.export({ type: "pkcs8", format: "pem" }) }) };
}

/** Par efímero del modo dev: uno por proceso, cacheado. NUNCA en producción. */
let devKeypairCache: ServiceKeypair | null = null;

/**
 * R2.5 (ERR-SEC-15) — clave de firma desde el ALMACÉN DE SECRETOS, no efímera.
 *
 * Precedencia (mismo patrón que el secreto JWT de R1.4, fallar cerrado):
 *  1. ARTIFACT_SIGNING_KEY_FILE — archivo PEM PKCS8 ed25519 (Docker secrets).
 *     Declarado pero ilegible/vacío = ERROR, sin degradación silenciosa.
 *  2. ARTIFACT_SIGNING_KEY — el PEM en la propia variable.
 *  3. ARENA_DEV_INSECURE_SECRETS=1 — par efímero por proceso (solo dev/tests;
 *     cada proceso tendría una clave DISTINTA, inservible entre servicios).
 *  4. Nada de lo anterior ⇒ throw: sin clave no se firma ni se publica nada.
 */
export function loadServiceKeypair(env: NodeJS.ProcessEnv = process.env): ServiceKeypair {
  const file = env.ARTIFACT_SIGNING_KEY_FILE;
  if (file) {
    let pem: string;
    try {
      pem = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`ARTIFACT_SIGNING_KEY_FILE apunta a un archivo ilegible: ${file}`);
    }
    if (!pem) throw new Error(`ARTIFACT_SIGNING_KEY_FILE apunta a un archivo vacío: ${file}`);
    return keypairFromPrivatePem(pem);
  }
  const plain = env.ARTIFACT_SIGNING_KEY;
  if (plain && plain.trim()) return keypairFromPrivatePem(plain.trim());
  if (env.ARENA_DEV_INSECURE_SECRETS === "1") {
    if (!devKeypairCache) devKeypairCache = generateServiceKeypair();
    return devKeypairCache;
  }
  throw new Error(
    "Falta la clave de firma de artefactos: define ARTIFACT_SIGNING_KEY_FILE (archivo de " +
      "secreto Docker con el PEM ed25519) o ARTIFACT_SIGNING_KEY. Para desarrollo/tests, " +
      "ARENA_DEV_INSECURE_SECRETS=1 usa un par efímero por proceso (NUNCA en producción).",
  );
}

/** Firma el hash del artefacto. Devuelve la firma en hex. */
export function signArtifact(artifactHash: string, privateKey: KeyObject): string {
  const sig = edSign(null, Buffer.from(artifactHash, "utf8"), privateKey);
  return sig.toString("hex");
}

export interface VerifyInput {
  /** Bytes del artefacto tal cual se van a ejecutar. */
  artifactBytes: Buffer;
  /** Hash que se firmó en publicación. */
  signedHash: string;
  /** Firma hex emitida por el servicio. */
  signature: string;
  publicKey: KeyObject;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verificación previa a ejecución. Comprueba dos cosas independientes:
 *  1) el artefacto no fue manipulado: sha256(artifactBytes) === signedHash;
 *  2) la firma del servicio sobre signedHash es válida.
 * Cualquiera de las dos que falle rechaza la ejecución.
 */
export function verifyArtifact(input: VerifyInput): VerifyResult {
  const actualHash = createHash("sha256").update(input.artifactBytes).digest("hex");
  if (actualHash !== input.signedHash) {
    return { ok: false, reason: `artefacto manipulado: hash ${actualHash} ≠ firmado ${input.signedHash}` };
  }
  let sigOk = false;
  try {
    sigOk = edVerify(null, Buffer.from(input.signedHash, "utf8"), input.publicKey, Buffer.from(input.signature, "hex"));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: "firma del servicio inválida" };
  return { ok: true };
}

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
import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

export interface ServiceKeypair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function generateServiceKeypair(): ServiceKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey };
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

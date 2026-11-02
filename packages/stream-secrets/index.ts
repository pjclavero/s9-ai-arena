/**
 * EQ5b · §19 · Credenciales de emisión SELLADAS (cifrado asimétrico en reposo).
 *
 * Problema: la clave de emisión se escribe desde la web (API) pero la usa otro
 * proceso (streamer). Un secreto montado de Docker es de sólo lectura para la
 * API, y un cifrado simétrico obligaría a que la API (y por tanto cualquiera
 * que la comprometa, o que lea la BD y el secreto de la API) pudiera DESCIFRAR.
 *
 * Diseño: par RSA-3072 generado por `infrastructure/scripts/init-secrets.sh`.
 *  - La API sólo tiene la clave PÚBLICA: cifra (RSA-OAEP-SHA256) la clave que
 *    llega del navegador, guarda el sobre en la BD y descarta el texto claro.
 *    NO puede descifrar lo que guarda: ni ella, ni un volcado de la BD, ni un
 *    backup.
 *  - El streamer tiene la clave PRIVADA (secreto montado, 0400): recibe el
 *    sobre en la orden de arranque, lo abre en memoria y se lo da al relé RTMP.
 *    Nunca lo escribe ni lo pasa a otro proceso.
 * Sin Vault ni KMS: dos ficheros con el mismo patrón que el resto de secretos.
 *
 * `kid` (huella de la pública) permite decir «la credencial se cifró con otra
 * clave: vuelve a introducirla» en vez de un error criptográfico opaco.
 */
import { constants, createHash, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt } from "node:crypto";

export const SEALED_ALG = "RSA-OAEP-256" as const;
/** Tope de la clave en claro (RSA-3072 + OAEP-SHA256 admite 318 bytes). */
export const MAX_SECRET_BYTES = 256;

export interface SealedSecret {
  v: 1;
  alg: typeof SEALED_ALG;
  /** Huella (16 hex) de la clave pública con que se selló. */
  kid: string;
  /** Texto cifrado en base64. */
  ct: string;
}

/** Huella estable de una clave pública PEM (SHA-256 del DER SPKI, 16 hex). */
export function keyIdOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/** Sella `secret` con la clave pública. Lanza si el secreto es vacío o largo. */
export function sealSecret(secret: string, publicKeyPem: string): SealedSecret {
  const pt = Buffer.from(secret, "utf8");
  if (pt.length === 0 || pt.length > MAX_SECRET_BYTES) throw new Error("longitud de secreto no admitida");
  const ct = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, pt);
  pt.fill(0);
  return { v: 1, alg: SEALED_ALG, kid: keyIdOf(publicKeyPem), ct: ct.toString("base64") };
}

export function isSealedSecret(x: unknown): x is SealedSecret {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    o.v === 1 &&
    o.alg === SEALED_ALG &&
    typeof o.kid === "string" &&
    /^[0-9a-f]{16}$/.test(o.kid) &&
    typeof o.ct === "string" &&
    o.ct.length > 0 &&
    o.ct.length <= 2048 &&
    /^[A-Za-z0-9+/]+=*$/.test(o.ct)
  );
}

export class SealedSecretError extends Error {
  constructor(
    message: string,
    readonly code: "key_mismatch" | "invalid" | "undecryptable",
  ) {
    super(message);
  }
}

/** Abre un sobre con la clave privada. Mensajes de error SIN material secreto. */
export function openSecret(sealed: unknown, privateKeyPem: string): string {
  if (!isSealedSecret(sealed)) throw new SealedSecretError("credencial sellada con formato inválido", "invalid");
  const priv = createPrivateKey(privateKeyPem);
  const kid = keyIdOf(createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }) as string);
  if (kid !== sealed.kid) {
    throw new SealedSecretError(
      "la credencial se selló con otra clave pública: vuelve a introducirla desde la web",
      "key_mismatch",
    );
  }
  try {
    const pt = privateDecrypt(
      { key: priv, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(sealed.ct, "base64"),
    );
    const s = pt.toString("utf8");
    pt.fill(0);
    return s;
  } catch {
    throw new SealedSecretError("la credencial sellada no se puede abrir", "undecryptable");
  }
}

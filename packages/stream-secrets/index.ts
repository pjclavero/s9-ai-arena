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
 *
 * EQ5c (revisión EQ6b, P2-2) · El sobre está ATADO A SU DESTINO. Sellar sólo la
 * clave permitía que quien tuviera el sobre (la BD) y el secreto interno
 * `x-streamer-auth` (la API los monta ambos) pidiera al streamer publicar la
 * clave de YouTube en `rtmps://atacante`. Desde v2:
 *  - se sella `{platform, ingest, key}`: la clave va cifrada con AES-256-GCM
 *    bajo una clave de contenido aleatoria envuelta con RSA-OAEP-SHA256, y
 *    `{v, kid, platform, ingest}` es el AAD de GCM. Cambiar el destino del sobre
 *    rompe la etiqueta de autenticación: no se puede «re-apuntar»;
 *  - `openSecret` EXIGE el destino esperado (la ingesta canónica de la orden
 *    y su plataforma) y rechaza (`binding_mismatch`) si no casa con lo sellado.
 * Con la PÚBLICA cualquiera puede sellar SU propia clave hacia donde quiera; lo
 * que ya no puede es mover una clave ajena a otro destino.
 * Los sobres v1 (sin destino) se rechazan: hay que volver a introducir la clave.
 */
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";

export const SEALED_ALG = "RSA-OAEP-256+A256GCM" as const;
/** Tope de la clave en claro. */
export const MAX_SECRET_BYTES = 256;

/** Destino al que queda atada una credencial. `ingest` en forma canónica. */
export interface SealBinding {
  platform: string;
  ingest: string;
}

export interface SealedSecret {
  v: 2;
  alg: typeof SEALED_ALG;
  /** Huella (16 hex) de la clave pública con que se selló. */
  kid: string;
  /** Destino sellado (en claro, pero autenticado como AAD: no se puede cambiar). */
  bind: SealBinding;
  /** Clave de contenido AES-256 envuelta con RSA-OAEP-SHA256 (base64). */
  ek: string;
  /** IV de GCM (base64, 12 bytes). */
  iv: string;
  /** Etiqueta de autenticación de GCM (base64, 16 bytes). */
  tag: string;
  /** Texto cifrado en base64. */
  ct: string;
}

const PLATFORM_RE = /^[a-z0-9_-]{1,32}$/;
const APP_RE = /^[A-Za-z0-9._~\-/]+$/;

/**
 * Forma canónica de una URL de ingesta RTMP(S): `proto://host:puerto/app`, con
 * host en minúsculas (WHATWG URL), puerto explícito y la aplicación sin barras
 * de los extremos. Es la que se sella y la que compara el streamer: dos
 * escrituras de la misma ingesta (`:443` implícito o explícito) casan; dos
 * ingestas distintas, no. Lanza si no es una URL de ingesta válida.
 */
export function canonicalIngestUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("URL de ingesta inválida");
  }
  const proto = u.protocol.replace(/:$/, "");
  if (proto !== "rtmps" && proto !== "rtmp") throw new Error("la ingesta debe ser rtmps://");
  if (u.username || u.password || u.search || u.hash || !u.hostname) throw new Error("URL de ingesta no canónica");
  // En esquemas no especiales (rtmps:) WHATWG deja el host «opaco»: sin pasar a
  // minúsculas ni decodificar. Se normaliza aquí y se rechaza lo que no sea un
  // nombre DNS o una IPv6 entre corchetes (nada de `%xx`, `_`, etc.).
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && !/^\[[0-9a-f:.]+\]$/.test(host)) {
    throw new Error("host de ingesta inválido");
  }
  const port = u.port ? Number(u.port) : proto === "rtmps" ? 443 : 1935;
  const app = decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, ""));
  if (!app || app.length > 128 || !APP_RE.test(app)) throw new Error("aplicación RTMP inválida");
  return `${proto}://${host}:${port}/${app}`;
}

function aadOf(kid: string, bind: SealBinding): Buffer {
  // Orden fijo de campos: el AAD es una serialización estable, no un JSON libre.
  return Buffer.from(JSON.stringify(["s9-stream-secret", 2, kid, bind.platform, bind.ingest]), "utf8");
}

function normBinding(b: SealBinding): SealBinding {
  if (!b || typeof b.platform !== "string" || !PLATFORM_RE.test(b.platform)) throw new Error("plataforma inválida");
  return { platform: b.platform, ingest: canonicalIngestUrl(b.ingest) };
}

/** Huella estable de una clave pública PEM (SHA-256 del DER SPKI, 16 hex). */
export function keyIdOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/**
 * Sella `secret` con la clave pública, ATADO a `bind` (plataforma + ingesta).
 * Lanza si el secreto es vacío o largo, o si el destino no es válido.
 */
export function sealSecret(secret: string, publicKeyPem: string, bind: SealBinding): SealedSecret {
  const b = normBinding(bind);
  const pt = Buffer.from(secret, "utf8");
  if (pt.length === 0 || pt.length > MAX_SECRET_BYTES) throw new Error("longitud de secreto no admitida");
  const kid = keyIdOf(publicKeyPem);
  const cek = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cek, iv);
  c.setAAD(aadOf(kid, b));
  const ct = Buffer.concat([c.update(pt), c.final()]);
  const tag = c.getAuthTag();
  const ek = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, cek);
  pt.fill(0);
  cek.fill(0);
  return {
    v: 2,
    alg: SEALED_ALG,
    kid,
    bind: b,
    ek: ek.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

const B64 = /^[A-Za-z0-9+/]+=*$/;
const b64 = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max && B64.test(v);

export function isSealedSecret(x: unknown): x is SealedSecret {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  const bind = o.bind as Record<string, unknown> | undefined;
  return (
    o.v === 2 &&
    o.alg === SEALED_ALG &&
    typeof o.kid === "string" &&
    /^[0-9a-f]{16}$/.test(o.kid) &&
    !!bind &&
    typeof bind === "object" &&
    typeof bind.platform === "string" &&
    PLATFORM_RE.test(bind.platform) &&
    typeof bind.ingest === "string" &&
    bind.ingest.length <= 512 &&
    b64(o.ek, 2048) &&
    b64(o.iv, 32) &&
    b64(o.tag, 32) &&
    b64(o.ct, 1024)
  );
}

export class SealedSecretError extends Error {
  constructor(
    message: string,
    readonly code: "key_mismatch" | "invalid" | "undecryptable" | "binding_mismatch",
  ) {
    super(message);
  }
}

/** Destino esperado al abrir: el de la orden que se va a ejecutar. */
export interface ExpectedBinding {
  /** URL de ingesta de la orden (cualquier forma válida: se canonicaliza). */
  ingest: string;
  /** Plataforma de la orden. */
  platform: string;
}

/**
 * Abre un sobre con la clave privada SÓLO si está atado a `expected`.
 * Mensajes de error SIN material secreto.
 */
export function openSecret(sealed: unknown, privateKeyPem: string, expected: ExpectedBinding): string {
  if (!isSealedSecret(sealed)) {
    const v = (sealed as { v?: unknown } | null)?.v;
    throw new SealedSecretError(
      v === 1
        ? "credencial sellada sin destino (formato antiguo): vuelve a introducirla desde la web"
        : "credencial sellada con formato inválido",
      "invalid",
    );
  }
  let want: SealBinding;
  try {
    want = normBinding(expected);
  } catch {
    throw new SealedSecretError("destino de la orden inválido", "binding_mismatch");
  }
  if (sealed.bind.platform !== want.platform || sealed.bind.ingest !== want.ingest) {
    throw new SealedSecretError(
      "la credencial está sellada para otro destino (plataforma o ingesta): no se usa",
      "binding_mismatch",
    );
  }
  const priv = createPrivateKey(privateKeyPem);
  const kid = keyIdOf(createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }) as string);
  if (kid !== sealed.kid) {
    throw new SealedSecretError(
      "la credencial se selló con otra clave pública: vuelve a introducirla desde la web",
      "key_mismatch",
    );
  }
  let cek: Buffer | null = null;
  try {
    cek = privateDecrypt(
      { key: priv, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(sealed.ek, "base64"),
    );
    if (cek.length !== 32) throw new Error("cek");
    const d = createDecipheriv("aes-256-gcm", cek, Buffer.from(sealed.iv, "base64"));
    // El AAD se reconstruye con el destino ESPERADO: un `bind` manipulado no autentica.
    d.setAAD(aadOf(sealed.kid, want));
    d.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const pt = Buffer.concat([d.update(Buffer.from(sealed.ct, "base64")), d.final()]);
    const s = pt.toString("utf8");
    pt.fill(0);
    return s;
  } catch {
    throw new SealedSecretError("la credencial sellada no se puede abrir", "undecryptable");
  } finally {
    cek?.fill(0);
  }
}

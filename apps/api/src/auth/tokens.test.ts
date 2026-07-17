/**
 * R1.4 (ERR-SEC-01) · Test ENFOCADO del módulo de tokens: sin BD ni app Express.
 * Importa directamente las funciones de firma/verificación y comprueba:
 *  (a) fallar cerrado — pedir el secreto sin configurarlo LANZA, sin NODE_ENV;
 *  (b) JWT_SECRET_FILE tiene precedencia sobre JWT_SECRET;
 *  (c) separación por tipo — un ticket de espectador y un access token no se
 *      validan cruzados (audience/secreto distintos);
 *  (d) algoritmo fijo — `alg:none` u otro algoritmo se rechazan.
 *
 * Corre en solitario (no necesita PostgreSQL, que en Windows falla por entorno):
 *   npx vitest run apps/api/src/auth/tokens.test.ts --maxWorkers=2
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  sessionSecret,
  spectateTicketSecret,
  signAccessToken,
  verifyAccessToken,
  signSpectateTicket,
  verifySpectateTicket,
} from "./tokens.js";

// Contrato público de las audiencias/emisor (documentado aquí a propósito).
const ISSUER = "s9-ai-arena";
const AUD_SESSION = "s9-arena/session";
const AUD_SPECTATE = "s9-arena/spectate";

const SECRET_VARS = [
  "JWT_SECRET_FILE",
  "JWT_SECRET",
  "SPECTATE_TICKET_SECRET_FILE",
  "SPECTATE_TICKET_SECRET",
  "ARENA_DEV_INSECURE_SECRETS",
  "NODE_ENV",
] as const;

let snapshot: Record<string, string | undefined>;
let tmp: string;

beforeEach(() => {
  snapshot = {};
  for (const k of SECRET_VARS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of SECRET_VARS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("R1.4 · fallar cerrado sin depender de NODE_ENV", () => {
  it("pedir el secreto sin configurarlo LANZA (y sigue lanzando en NODE_ENV=development)", () => {
    // Nada configurado: debe lanzar (no hay literal de respaldo).
    expect(() => sessionSecret()).toThrow(/Falta el secreto JWT/);
    // La lógica NO depende de NODE_ENV: incluso "development" exige secreto.
    process.env.NODE_ENV = "development";
    expect(() => sessionSecret()).toThrow(/Falta el secreto JWT/);
    // Firmar también arrastra el fallo-cerrado.
    expect(() => signAccessToken({ sub: "u1", sid: "s1" })).toThrow(/Falta el secreto JWT/);
  });

  it("el modo dev EXPLÍCITO usa un secreto EFÍMERO aleatorio (no un literal versionado)", () => {
    process.env.ARENA_DEV_INSECURE_SECRETS = "1";
    const s = sessionSecret();
    // 32 bytes aleatorios en base64url ⇒ ~43 chars: no es un literal corto conocido.
    expect(s).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(sessionSecret()).toBe(s); // estable dentro del proceso (firmar y verificar coinciden)
  });
});

describe("R1.4 · lectura por archivo con precedencia", () => {
  it("JWT_SECRET_FILE tiene precedencia sobre JWT_SECRET", () => {
    tmp = tmp ?? mkdtempSync(join(tmpdir(), "r14-secrets-"));
    const file = join(tmp, "jwt_secret");
    writeFileSync(file, "  secreto-de-archivo-r14  \n"); // se recorta al leer
    process.env.JWT_SECRET_FILE = file;
    process.env.JWT_SECRET = "secreto-de-variable-distinto";
    expect(sessionSecret()).toBe("secreto-de-archivo-r14");
  });

  it("un archivo de secreto vacío es error (no se degrada en silencio)", () => {
    tmp = tmp ?? mkdtempSync(join(tmpdir(), "r14-secrets-"));
    const empty = join(tmp, "empty_secret");
    writeFileSync(empty, "   \n");
    process.env.JWT_SECRET_FILE = empty;
    expect(() => sessionSecret()).toThrow(/vac[ií]o/);
  });

  it("sin archivo, cae a la variable en claro", () => {
    process.env.JWT_SECRET = "solo-variable";
    expect(sessionSecret()).toBe("solo-variable");
  });
});

describe("R1.4 · separación de secretos y audience/issuer", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "secreto-de-sesion-para-tests";
  });

  it("el secreto de tickets es DISTINTO del de sesión", () => {
    expect(spectateTicketSecret()).not.toBe(sessionSecret());
  });

  it("un secreto explícito de tickets tiene precedencia y precedencia por archivo", () => {
    process.env.SPECTATE_TICKET_SECRET = "secreto-tickets-explicito";
    expect(spectateTicketSecret()).toBe("secreto-tickets-explicito");
  });

  it("access token: round-trip válido con issuer/audience/alg correctos", () => {
    const token = signAccessToken({ sub: "user-1", sid: "sess-1" });
    expect(verifyAccessToken(token)).toEqual({ sub: "user-1", sid: "sess-1" });
    const decoded = jwt.decode(token, { complete: true })!;
    expect(decoded.header.alg).toBe("HS256");
    expect((decoded.payload as jwt.JwtPayload).iss).toBe(ISSUER);
    expect((decoded.payload as jwt.JwtPayload).aud).toBe(AUD_SESSION);
  });

  it("spectate ticket: round-trip válido con su audience propia", () => {
    const ticket = signSpectateTicket({ battleId: "b-1", jti: "j-1", debug: true }, 60);
    const v = verifySpectateTicket(ticket);
    expect(v?.battleId).toBe("b-1");
    expect(v?.jti).toBe("j-1");
    expect(v?.debug).toBe(true);
    const decoded = jwt.decode(ticket, { complete: true })!;
    expect(decoded.header.alg).toBe("HS256");
    expect((decoded.payload as jwt.JwtPayload).aud).toBe(AUD_SPECTATE);
  });

  it("un access token NO valida como ticket de espectador (y viceversa)", () => {
    const access = signAccessToken({ sub: "user-1", sid: "sess-1" });
    const ticket = signSpectateTicket({ battleId: "b-1", jti: "j-1" }, 60);
    // Cruce rechazado (secreto y audience distintos).
    expect(verifySpectateTicket(access)).toBeNull();
    expect(verifyAccessToken(ticket)).toBeNull();
  });

  it("el rechazo cruzado lo garantiza también la AUDIENCE (mismo secreto, aud errónea)", () => {
    // Firmado con el secreto de SESIÓN correcto, pero con la audience de espectador:
    // verifyAccessToken lo rechaza por audience aunque el secreto y el issuer casen.
    const wrongAud = jwt.sign({ sid: "s1" }, sessionSecret(), {
      algorithm: "HS256",
      subject: "u1",
      issuer: ISSUER,
      audience: AUD_SPECTATE,
      expiresIn: 60,
    });
    expect(verifyAccessToken(wrongAud)).toBeNull();
  });
});

describe("R1.4 · algoritmo fijado (allowlist)", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "secreto-de-sesion-para-tests";
  });

  it("un token con alg:none se rechaza", () => {
    const none = jwt.sign({ sid: "s1" }, "", {
      algorithm: "none",
      subject: "u1",
      issuer: ISSUER,
      audience: AUD_SESSION,
      expiresIn: 60,
    });
    expect(verifyAccessToken(none)).toBeNull();
  });

  it("un token con otro algoritmo (HS512) se rechaza aunque el secreto case", () => {
    const hs512 = jwt.sign({ sid: "s1" }, sessionSecret(), {
      algorithm: "HS512",
      subject: "u1",
      issuer: ISSUER,
      audience: AUD_SESSION,
      expiresIn: 60,
    });
    expect(verifyAccessToken(hs512)).toBeNull();
  });
});

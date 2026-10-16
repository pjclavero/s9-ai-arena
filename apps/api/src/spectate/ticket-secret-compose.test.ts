/**
 * FC-D · TD-028 — Coherencia EMISOR/VERIFICADOR del ticket de espectador en el
 * stack declarado (infrastructure/docker-compose.yml).
 *
 * El ticket lo firma la API (`signSpectateTicket`, ruta spectate-ticket) y lo
 * verifica el gateway WebSocket (`verifySpectateTicket`), que vive en OTRO
 * contenedor: el tournament-worker (`new SpectateGateway` en su entrypoint).
 * La clave sale de `SPECTATE_TICKET_SECRET_FILE` o, si no, por HKDF de
 * `JWT_SECRET_FILE` (apps/api/src/auth/tokens.ts). Antes el worker no recibía
 * ninguna de las dos ⇒ todo ticket se cerraba con 4401 invalid_ticket.
 *
 * Qué comprueba (y cómo se pone ROJO):
 *  1. Descubre los VERIFICADORES leyendo el entrypoint de cada servicio
 *     (SERVICE_ENTRY) y buscando la construcción de `SpectateGateway`; exige que
 *     haya al menos uno (si nadie verifica, el test no puede pasar en vacío).
 *  2. Para emisor y verificadores, resuelve desde el compose qué SECRETO
 *     alimenta la clave (variable *_FILE → /run/secrets/<nombre> → montado en
 *     `secrets:` del servicio y declarado en `secrets:` de primer nivel).
 *  3. EJECUTA las funciones reales: firma con el entorno del emisor y verifica
 *     con el del verificador, con un fichero temporal DISTINTO por secreto. Si
 *     el verificador no tiene secreto, o tiene otro, la verificación da null.
 * Mutación de calibración: quitar `JWT_SECRET_FILE`/`jwt_secret` del bloque
 * tournament-worker ⇒ este test falla (anotado en el informe de DEV-D).
 *
 * Techo declarado: el descubrimiento del verificador es por texto del
 * entrypoint (sin comentarios), no por grafo de imports: un gateway construido
 * en un módulo importado por el entrypoint no se vería.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { parse } from "yaml";
import { signSpectateTicket, verifySpectateTicket } from "../auth/tokens.js";

const REPO = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const compose = parse(readFileSync(join(REPO, "infrastructure/docker-compose.yml"), "utf8")) as {
  services: Record<string, any>;
  secrets: Record<string, unknown>;
};

const KEY_VARS = ["SPECTATE_TICKET_SECRET_FILE", "SPECTATE_TICKET_SECRET", "JWT_SECRET_FILE", "JWT_SECRET", "ARENA_DEV_INSECURE_SECRETS"];

function entryOf(svc: any): string | null {
  const raw = svc?.environment?.SERVICE_ENTRY;
  if (typeof raw !== "string") return null;
  const m = /^\$\{[A-Z_]+:-([^}]+)\}$/.exec(raw);
  return m ? m[1] : raw;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Variables de clave que el compose entrega al servicio, sólo las de secreto por archivo. */
function keySource(name: string): { env: Record<string, string>; secrets: string[] } {
  const svc = compose.services[name];
  const env: Record<string, string> = {};
  for (const k of KEY_VARS) {
    const v = svc?.environment?.[k];
    if (v !== undefined) env[k] = String(v);
  }
  const mounted: string[] = (svc?.secrets ?? []).map((s: any) => (typeof s === "string" ? s : s.source));
  return { env, secrets: mounted };
}

const saved = { ...process.env };
afterEach(() => {
  for (const k of KEY_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("TD-028 · el verificador del ticket de espectador recibe el MISMO secreto que el emisor", () => {
  const verifiers = Object.entries(compose.services)
    .filter(([, svc]) => {
      const e = entryOf(svc);
      if (!e) return false;
      let src: string;
      try {
        src = readFileSync(join(REPO, e), "utf8");
      } catch {
        return false;
      }
      return /new\s+SpectateGateway\s*\(/.test(stripComments(src));
    })
    .map(([n]) => n);
  const emitter = Object.entries(compose.services).find(([, s]) => entryOf(s) === "apps/api/src/server.ts")?.[0];

  it("hay emisor (api) y al menos un verificador descubierto por su entrypoint", () => {
    expect(emitter).toBe("api");
    expect(verifiers).toContain("tournament-worker");
  });

  it("ningún servicio implicado usa secreto en claro ni el modo dev inseguro", () => {
    for (const n of [emitter!, ...verifiers]) {
      const { env } = keySource(n);
      expect(env.JWT_SECRET, `${n}: JWT_SECRET en claro`).toBeUndefined();
      expect(env.SPECTATE_TICKET_SECRET, `${n}: secreto de ticket en claro`).toBeUndefined();
      expect(env.ARENA_DEV_INSECURE_SECRETS, `${n}: modo dev inseguro`).toBeUndefined();
    }
  });

  it("cada *_FILE apunta a un secreto montado en el servicio y declarado a primer nivel", () => {
    for (const n of [emitter!, ...verifiers]) {
      const { env, secrets } = keySource(n);
      const files = ["SPECTATE_TICKET_SECRET_FILE", "JWT_SECRET_FILE"].filter((k) => env[k]);
      expect(files.length, `${n}: sin fuente de clave para el ticket`).toBeGreaterThan(0);
      for (const k of files) {
        const m = /^\/run\/secrets\/([A-Za-z0-9_.-]+)$/.exec(env[k]);
        expect(m, `${n}: ${k} no es /run/secrets/<nombre>`).not.toBeNull();
        expect(secrets, `${n}: ${m![1]} no montado`).toContain(m![1]);
        expect(Object.keys(compose.secrets), `${m![1]} no declarado`).toContain(m![1]);
      }
    }
  });

  it("EJECUCIÓN: un ticket firmado con el entorno del emisor se verifica con el de cada verificador", () => {
    const dir = mkdtempSync(join(tmpdir(), "fcd-ticket-"));
    // Un fichero DISTINTO por nombre de secreto: dos servicios sólo coinciden si
    // montan el MISMO secreto, no por casualidad de valores.
    const fileFor = new Map<string, string>();
    const materialize = (env: Record<string, string>) => {
      for (const k of KEY_VARS) delete process.env[k];
      for (const [k, v] of Object.entries(env)) {
        const m = /^\/run\/secrets\/(.+)$/.exec(v);
        if (!m) continue;
        if (!fileFor.has(m[1])) {
          const p = join(dir, m[1]);
          writeFileSync(p, randomBytes(32).toString("base64url"));
          chmodSync(p, 0o600);
          fileFor.set(m[1], p);
        }
        process.env[k] = fileFor.get(m[1])!;
      }
    };
    materialize(keySource(emitter!).env);
    const ticket = signSpectateTicket({ battleId: "b-fcd", jti: "j1" }, 60);
    for (const n of verifiers) {
      materialize(keySource(n).env);
      const v = verifySpectateTicket(ticket);
      expect(v, `${n} no verifica el ticket de ${emitter}`).not.toBeNull();
      expect(v!.battleId).toBe("b-fcd");
    }
  });
});

/**
 * R1.8 · ERR-SEC-05: confianza de proxy ACOTADA para que `req.ip` sea la IP
 * real del cliente detrás del gateway (1 salto) o de VM104 + gateway (2 saltos).
 *
 * DoD:
 *  - Dos peticiones desde IPs distintas tras el gateway ⇒ cubos de cuota
 *    anónima SEPARADOS.
 *  - Una X-Forwarded-For falsificada desde fuera del gateway NO altera req.ip.
 *  - El bloqueo de login se ancla a IP real + email: no se puede bloquear una
 *    cuenta ajena desde una única IP externa con XFF falsa.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEV_PASSWORD, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { createApp } from "./app.js";
import { FailedLoginGuard } from "./middleware/rate-limit.js";
import { resolveTrustProxyHops } from "./middleware/proxy-trust.js";

let h: TestDbHandle;
let battleId: string;

/** App con cuota anónima estricta (1 petición por IP) y N saltos de confianza. */
function quotaApp(trustProxyHops: number | undefined): Express {
  return createApp({ db: h.db, trustProxyHops, anonQuota: { max: 1, windowMs: 3600_000 } });
}

async function clearUsage(): Promise<void> {
  await h.db("api_usage").delete();
}

/** actor_keys registrados en api_usage para la ruta del ticket de espectador. */
async function actorKeys(): Promise<string[]> {
  const rows = await h.db("api_usage").where({ route: "spectate-ticket" }).select("actor_key");
  return rows.map((r: { actor_key: string }) => r.actor_key);
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  // Batalla en directo: su ticket de espectador es el endpoint público con cuota anónima.
  const [live] = await h
    .db("battles")
    .insert({
      status: "running",
      official: false,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "seed-proxy",
    })
    .returning("*");
  battleId = live.id;
}, 120000);

afterAll(async () => {
  await h.stop();
});

describe("R1.8 resolveTrustProxyHops (configuración acotada, falla cerrado)", () => {
  it("sin variable ⇒ 0 saltos (no se cree ninguna X-Forwarded-For)", () => {
    expect(resolveTrustProxyHops(undefined)).toBe(0);
    expect(resolveTrustProxyHops("")).toBe(0);
    expect(resolveTrustProxyHops("  ")).toBe(0);
  });

  it("acepta solo enteros acotados: 1 (gateway) y 2 (VM104 + gateway)", () => {
    expect(resolveTrustProxyHops("0")).toBe(0);
    expect(resolveTrustProxyHops("1")).toBe(1);
    expect(resolveTrustProxyHops("2")).toBe(2);
  });

  it("valores inválidos detienen el arranque en vez de degradar la confianza", () => {
    for (const bad of ["true", "-1", "1.5", "9", "loopback", "NaN"]) {
      expect(() => resolveTrustProxyHops(bad)).toThrow(/TRUST_PROXY_HOPS/);
    }
  });
});

describe("R1.8 cuota anónima con IP real (1 salto: gateway del stack)", () => {
  it("dos clientes distintos tras el gateway consumen cubos SEPARADOS", async () => {
    await clearUsage();
    const app = quotaApp(1);
    // El gateway añade la IP real del cliente a X-Forwarded-For.
    const a1 = await request(app).post(`/battles/${battleId}/spectate-ticket`).set("X-Forwarded-For", "203.0.113.10");
    expect(a1.status).toBe(201);
    const a2 = await request(app).post(`/battles/${battleId}/spectate-ticket`).set("X-Forwarded-For", "203.0.113.10");
    expect(a2.status).toBe(429); // cuota max=1 agotada... solo para ESTA IP
    const b1 = await request(app).post(`/battles/${battleId}/spectate-ticket`).set("X-Forwarded-For", "203.0.113.11");
    expect(b1.status).toBe(201); // la otra IP tiene su propio cubo

    const keys = await actorKeys();
    expect(keys).toContain("ip:203.0.113.10");
    expect(keys).toContain("ip:203.0.113.11");
  });

  it("una XFF con cadena falsificada usa la IP añadida por el gateway (la real), no la inyectada", async () => {
    await clearUsage();
    const app = quotaApp(1);
    // El cliente externo inyecta "6.6.6.6"; el gateway AÑADE la IP real a la derecha.
    const r1 = await request(app)
      .post(`/battles/${battleId}/spectate-ticket`)
      .set("X-Forwarded-For", "6.6.6.6, 198.51.100.5");
    expect(r1.status).toBe(201);
    // Rotar la parte falsificada no da cuota nueva: el cubo sigue siendo la IP real.
    const r2 = await request(app)
      .post(`/battles/${battleId}/spectate-ticket`)
      .set("X-Forwarded-For", "7.7.7.7, 198.51.100.5");
    expect(r2.status).toBe(429);

    const keys = await actorKeys();
    expect(keys).toContain("ip:198.51.100.5");
    expect(keys).not.toContain("ip:6.6.6.6");
    expect(keys).not.toContain("ip:7.7.7.7");
  });
});

describe("R1.8 sin proxy declarado (0 saltos): la XFF externa se descarta entera", () => {
  it("una X-Forwarded-For falsificada NO altera req.ip", async () => {
    await clearUsage();
    const app = quotaApp(undefined); // sin TRUST_PROXY_HOPS ⇒ 0 saltos (falla cerrado)
    const r1 = await request(app).post(`/battles/${battleId}/spectate-ticket`).set("X-Forwarded-For", "6.6.6.6");
    expect(r1.status).toBe(201);
    // Cambiar la XFF falsa no cambia la clave de límite: mismo cubo (IP del socket) ⇒ 429.
    const r2 = await request(app).post(`/battles/${battleId}/spectate-ticket`).set("X-Forwarded-For", "8.8.8.8");
    expect(r2.status).toBe(429);

    const keys = await actorKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^ip:(::ffff:)?127\.0\.0\.1$/);
    expect(keys).not.toContain("ip:6.6.6.6");
    expect(keys).not.toContain("ip:8.8.8.8");
  });
});

describe("R1.8 dos saltos (detrás del proxy de VM104)", () => {
  it("req.ip es la IP que añadió VM104 (cliente real), ignorando lo inyectado antes", async () => {
    await clearUsage();
    const app = quotaApp(2);
    // Cadena real en modo (b): [falsificado por el cliente,] cliente real (VM104), VM104 (gateway).
    const r1 = await request(app)
      .post(`/battles/${battleId}/spectate-ticket`)
      .set("X-Forwarded-For", "6.6.6.6, 203.0.113.60, 10.0.0.4");
    expect(r1.status).toBe(201);
    const r2 = await request(app)
      .post(`/battles/${battleId}/spectate-ticket`)
      .set("X-Forwarded-For", "9.9.9.9, 203.0.113.60, 10.0.0.4");
    expect(r2.status).toBe(429); // misma IP real ⇒ mismo cubo, la parte falsa no cuenta

    const keys = await actorKeys();
    expect(keys).toEqual(["ip:203.0.113.60"]);
  });
});

describe("R1.8 bloqueo de fuerza bruta por IP real + email (no <gateway>|email)", () => {
  it("una sola IP externa con XFF falsa NO puede bloquear la cuenta de otra persona", async () => {
    const guard = new FailedLoginGuard(3, 60_000);
    const app = createApp({
      db: h.db,
      trustProxyHops: 1,
      loginGuard: guard,
      anonQuota: { max: 10_000, windowMs: 3600_000 },
    });
    const victim = DEV_USERS.user;

    // Atacante desde 198.51.100.66 forjando la parte izquierda de la XFF en cada intento.
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post("/auth/login")
        .set("X-Forwarded-For", `${i}.${i}.${i}.${i}, 198.51.100.66`)
        .send({ email: victim, password: "password-incorrecta" });
      expect(r.status).toBe(401);
    }
    // La clave bloqueada es `198.51.100.66|victim`: el atacante SÍ está bloqueado
    // aunque siga rotando la parte falsificada de la cabecera.
    const attackerAgain = await request(app)
      .post("/auth/login")
      .set("X-Forwarded-For", "99.99.99.99, 198.51.100.66")
      .send({ email: victim, password: "password-incorrecta" });
    expect(attackerAgain.status).toBe(429);

    // ...pero la víctima, desde SU IP real, entra con normalidad: no hay
    // bloqueo dirigido de cuentas ajenas (clave por IP real, no por gateway).
    const victimLogin = await request(app)
      .post("/auth/login")
      .set("X-Forwarded-For", "203.0.113.99")
      .send({ email: victim, password: DEV_PASSWORD });
    expect(victimLogin.status).toBe(200);
    expect(victimLogin.body.accessToken).toBeTruthy();
  });
});

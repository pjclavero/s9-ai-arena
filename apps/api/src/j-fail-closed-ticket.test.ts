/**
 * Carril J · FAIL-CLOSED del canal de espectador — mitad HTTP del invariante.
 *
 * `POST /battles/{battleId}/spectate-ticket` es `security: []` (x-min-role
 * visitor). Antes de este carril emitía un ticket de espectador válido a
 * CUALQUIER visitante anónimo aunque `S9_PUBLIC_SPECTATE_ENABLED` estuviera
 * apagada: la puerta pública gobernaba solo los endpoints REST `/public/*`,
 * nunca el canal en vivo. Estos tests fijan que con la puerta apagada NO se
 * emite ticket anónimo, y que el ticket que sí se emite viaja marcado `anon`
 * para que el gateway (otro proceso) pueda aplicar la puerta por su cuenta.
 *
 * La mitad que vive en el proceso del gateway está en
 * `apps/api/src/spectate/j-fail-closed.test.ts` (pura, sin BD).
 *
 * MUTACIÓN de calibración: borrar `if (!publicSpectateEnabled && !req.auth)` de
 * `routes/battles.ts`, o firmar `anon: false` fijo, pone estos tests en ROJO.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import jwt from "jsonwebtoken";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { verifySpectateTicket } from "./auth/tokens.js";

let h: TestDbHandle;
let rulesetId: string;
let battleId: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  rulesetId = (await h.db("rulesets").first()).id;
  const [row] = await h
    .db("battles")
    .insert({
      status: "running",
      official: false,
      mode: "deathmatch",
      ruleset_id: rulesetId,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "j-seed-que-no-debe-salir",
      started_at: h.db.fn.now(),
    })
    .returning("id");
  battleId = row.id as string;
}, 120_000);

afterAll(async () => {
  await h.stop();
});

function app(publicSpectateEnabled: boolean): Express {
  return createApp({
    db: h.db,
    publicSpectateEnabled,
    anonQuota: { max: 10_000, windowMs: 3600_000 },
  });
}

describe("Carril J · con la capability APAGADA no se emite ticket de espectador anónimo", () => {
  it("un visitante SIN sesión recibe 404 (no 201, no 403): no hay ticket que llevar al gateway", async () => {
    const r = await request(app(false)).post(`/battles/${battleId}/spectate-ticket`);
    expect(r.status).toBe(404);
    expect(r.body.ticket).toBeUndefined();
    expect(r.body.wsUrl).toBeUndefined();
  });

  it("el 404 es el MISMO para una batalla en directo que para un id inexistente (no filtra existencia)", async () => {
    const a = await request(app(false)).post(`/battles/${battleId}/spectate-ticket`);
    const b = await request(app(false)).post(`/battles/11111111-1111-4111-8111-111111111111/spectate-ticket`);
    expect(a.status).toBe(b.status);
    expect(a.body.error).toBe(b.body.error);
  });

  it("una sesión AUTENTICADA sí obtiene ticket con la puerta apagada, y NO va marcado anónimo", async () => {
    const token = await tokenFor(h.db, DEV_USERS.user);
    const r = await request(app(false))
      .post(`/battles/${battleId}/spectate-ticket`)
      .set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(201);
    const claims = verifySpectateTicket(r.body.ticket);
    expect(claims).not.toBeNull();
    expect(claims!.anon).toBe(false);
  });
});

describe("Carril J · con la capability ENCENDIDA el ticket anónimo vuelve, marcado como tal", () => {
  it("un visitante sin sesión recibe 201 y el ticket lleva anon=true firmado por la API", async () => {
    const r = await request(app(true)).post(`/battles/${battleId}/spectate-ticket`);
    expect(r.status).toBe(201);
    const claims = verifySpectateTicket(r.body.ticket);
    expect(claims!.anon).toBe(true);
    expect(claims!.battleId).toBe(battleId);
    // El ticket anónimo JAMÁS lleva depuración: eso es rol >= moderator.
    expect(claims!.debug).toBe(false);
  });

  it("el cuerpo de la respuesta no filtra nada de la batalla más allá del ticket y su destino", async () => {
    const r = await request(app(true)).post(`/battles/${battleId}/spectate-ticket`);
    expect(Object.keys(r.body).sort()).toEqual(["expiresAt", "ticket", "wsUrl"]);
    expect(JSON.stringify(r.body)).not.toContain("j-seed-que-no-debe-salir");
  });

  it("el cliente no puede autoconcederse `anon:false` ni `debug`: el ticket lo firma la API", async () => {
    // Un ticket fabricado por el cliente no verifica: no tiene el secreto.
    const falso = jwt.sign({ battleId, debug: true }, "secreto-del-atacante", {
      algorithm: "HS256",
      expiresIn: 60,
      issuer: "s9-ai-arena",
      audience: "s9-arena/spectate",
    });
    expect(verifySpectateTicket(falso)).toBeNull();
  });
});

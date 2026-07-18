/**
 * R-DEPLOY · R1 — arranque/healthcheck del entrypoint de servicio del map-service.
 *
 * Comprueba la app Express que el SERVICE_ENTRY del Compose ejecuta: /healthz
 * responde y las lecturas mínimas se apoyan en la librería MapService existente
 * (sin duplicar lógica). El almacén arranca vacío.
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createMapServiceApp } from "../src/main.js";

describe("map-service · entrypoint de servicio (R1)", () => {
  it("/healthz responde ok con el recuento de mapas", async () => {
    const res = await request(createMapServiceApp()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", service: "map-service", maps: 0 });
  });

  it("GET /maps lista vacío al arrancar y GET de un mapa inexistente ⇒ 404", async () => {
    const app = createMapServiceApp();
    expect((await request(app).get("/maps")).body).toEqual([]);
    const missing = await request(app).get("/maps/no-existe/1");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("not_found");
  });
});

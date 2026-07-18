/**
 * R-DEPLOY · R1 — arranque/healthcheck del entrypoint de servicio del bot-manager.
 *
 * No levanta un contenedor (aquí no hay Docker): comprueba la app Express que el
 * SERVICE_ENTRY del Compose ejecuta — que /healthz responde y que el servicio
 * FALLA CERRADO si falta DOCKER_PROXY_URL (única vía hacia Docker, R1.7).
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createBotManagerApp } from "../src/main.js";

describe("bot-manager · entrypoint de servicio (R1)", () => {
  it("falla cerrado y claro si falta DOCKER_PROXY_URL", () => {
    expect(() => createBotManagerApp(undefined)).toThrow(/DOCKER_PROXY_URL/);
    expect(() => createBotManagerApp("")).toThrow(/DOCKER_PROXY_URL/);
  });

  it("con DOCKER_PROXY_URL responde /healthz con status ok", async () => {
    const app = createBotManagerApp("http://docker-proxy.internal:2375");
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("bot-manager");
    expect(res.body.dockerProxy).toBe("http://docker-proxy.internal:2375");
    expect(res.body.launchAuthority).toBe(true);
  });
});

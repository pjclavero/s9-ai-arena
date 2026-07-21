/**
 * N1 · Métricas Prometheus de la API (GET /metrics, S9_METRICS_ENABLED).
 *
 * Cubre: registro en memoria (formato HELP/TYPE, agregación por ruta plantilla),
 * flag apagada por defecto (404, sin instalar el middleware de conteo), flag
 * encendida (200 con texto Prometheus válido, contador incrementado) y la
 * invariante de cardinalidad: dos peticiones a la misma ruta con ids DISTINTOS
 * deben sumar en la MISMA serie `route="/battles/:battleId"`, nunca la URL cruda.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { MetricsRegistry, metricsEnabledFromEnv } from "./metrics.js";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { createApp } from "./app.js";

describe("N1 · metricsEnabledFromEnv (default OFF)", () => {
  it("es false cuando S9_METRICS_ENABLED no está definida o vale distinto de 1/true", () => {
    expect(metricsEnabledFromEnv({})).toBe(false);
    expect(metricsEnabledFromEnv({ S9_METRICS_ENABLED: "0" })).toBe(false);
    expect(metricsEnabledFromEnv({ S9_METRICS_ENABLED: "false" })).toBe(false);
    expect(metricsEnabledFromEnv({ S9_METRICS_ENABLED: "yes" })).toBe(false);
  });

  it("es true SOLO con '1' o 'true' (case-insensitive)", () => {
    expect(metricsEnabledFromEnv({ S9_METRICS_ENABLED: "1" })).toBe(true);
    expect(metricsEnabledFromEnv({ S9_METRICS_ENABLED: "TRUE" })).toBe(true);
    expect(metricsEnabledFromEnv({ S9_METRICS_ENABLED: "True" })).toBe(true);
  });
});

describe("N1 · MetricsRegistry (registro en memoria, sin Express)", () => {
  it("renderiza formato Prometheus con # HELP / # TYPE y api_up en 1", () => {
    const reg = new MetricsRegistry();
    const text = reg.render();
    expect(text).toContain("# HELP http_requests_total");
    expect(text).toContain("# TYPE http_requests_total counter");
    expect(text).toContain("# HELP http_request_duration_seconds_sum");
    expect(text).toContain("# TYPE http_request_duration_seconds_sum counter");
    expect(text).toContain("# HELP api_up");
    expect(text).toContain("# TYPE api_up gauge");
    expect(text).toContain("api_up 1");
  });

  it("agrega peticiones a la MISMA ruta plantilla en la MISMA serie (sin cardinalidad por id)", () => {
    const reg = new MetricsRegistry();
    reg.recordRequest("/battles/:battleId", 404, 0.01);
    reg.recordRequest("/battles/:battleId", 404, 0.02);
    const text = reg.render();
    expect(text).toContain('http_requests_total{service="api",route="/battles/:battleId",status="404"} 2');
    // Nunca la URL cruda con un id real.
    expect(text).not.toMatch(/route="\/battles\/[0-9a-f-]{36}"/);
  });

  it("acumula suma y recuento de duración por ruta (summary básico)", () => {
    const reg = new MetricsRegistry();
    reg.recordRequest("/system/status", 200, 0.5);
    reg.recordRequest("/system/status", 200, 0.25);
    const text = reg.render();
    expect(text).toContain('http_request_duration_seconds_sum{service="api",route="/system/status"} 0.75');
    expect(text).toContain('http_request_duration_seconds_count{service="api",route="/system/status"} 2');
  });
});

describe("N1 · GET /metrics montado en la app Express (createApp)", () => {
  let h: TestDbHandle;

  beforeAll(async () => {
    h = await startTestDb();
  }, 120_000);

  afterAll(async () => {
    await h.stop();
  });

  it("createApp() sin metricsEnabled explícito usa el entorno real (apagado por defecto en test)", async () => {
    delete process.env.S9_METRICS_ENABLED;
    const app: Express = createApp({ db: h.db }); // sin cfg.metricsEnabled: cae al default del entorno
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(404);
  });

  it("flag apagada (explícita): GET /metrics responde 404, como si no existiera", async () => {
    const app: Express = createApp({ db: h.db, metricsEnabled: false });
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("flag encendida: GET /metrics responde 200 con texto Prometheus válido", async () => {
    const app: Express = createApp({ db: h.db, metricsEnabled: true });
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("# HELP http_requests_total");
    expect(res.text).toContain("# TYPE http_requests_total counter");
    expect(res.text).toContain("api_up 1");
  });

  it("flag encendida: tras peticiones a una ruta, http_requests_total la refleja incrementada", async () => {
    const app: Express = createApp({ db: h.db, metricsEnabled: true });
    // No importa el status exacto (puede ser 401/403 según minRole); lo que
    // importa es que la ruta quede registrada bajo su plantilla.
    await request(app).get("/system/rbac");
    await request(app).get("/system/rbac");

    const metrics = await request(app).get("/metrics");
    expect(metrics.status).toBe(200);
    expect(metrics.text).toMatch(/http_requests_total\{service="api",route="\/system\/rbac",status="\d+"\} 2/);
  });

  it("cardinalidad: dos ids DISTINTOS de battleId suman en la MISMA serie de ruta plantilla", async () => {
    const app: Express = createApp({ db: h.db, metricsEnabled: true });
    const id1 = randomUUID();
    const id2 = randomUUID();
    const r1 = await request(app).get(`/battles/${id1}`);
    const r2 = await request(app).get(`/battles/${id2}`);
    // Batallas inexistentes: ambas 404 de negocio (not_found), no de ruta.
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);

    const metrics = await request(app).get("/metrics");
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('http_requests_total{service="api",route="/battles/:battleId",status="404"} 2');
    // Ningún id real debe aparecer en el texto expuesto (evita explosión de cardinalidad).
    expect(metrics.text).not.toContain(id1);
    expect(metrics.text).not.toContain(id2);
  });
});

// Verificación de las configuraciones de observabilidad (T10.3, cap. 24).
// Sin Docker no se puede levantar el stack ni disparar alertas reales; aquí se
// verifica ejecutando de verdad: parseo YAML/JSON de todas las configs,
// presencia de las cinco alertas del cap. 24 (+ backup de T10.4), scrape del
// motor a 5 s (para que EngineTickStalled dispare en < 30 s), datasources y
// dashboards aprovisionados coherentes entre sí, y que promtail NO usa
// docker.sock. El disparo real de alertas queda como test de caos pendiente
// (docs/entrega-E10.md).
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const obs = (...p: string[]) => join(here, "..", "observability", ...p);

const prometheus = parse(readFileSync(obs("prometheus", "prometheus.yml"), "utf8"));
const alerts = parse(readFileSync(obs("prometheus", "alerts.yml"), "utf8"));
const promtail = parse(readFileSync(obs("promtail", "promtail-config.yml"), "utf8"));
const loki = parse(readFileSync(obs("loki", "loki-config.yml"), "utf8"));

describe("prometheus", () => {
  it("scrapea el motor cada 5 s (necesario para alertar de tick estancado en < 30 s)", () => {
    const engine = prometheus.scrape_configs.find((j: any) => j.job_name === "arena-engine");
    expect(engine.scrape_interval).toBe("5s");
  });

  it("scrapea todos los servicios instrumentables + cadvisor/node/postgres-exporter", () => {
    const jobs = prometheus.scrape_configs.map((j: any) => j.job_name);
    for (const j of [
      "arena-engine",
      "api",
      "web",
      "map-service",
      "replay-service",
      "bot-manager",
      "postgres",
      "cadvisor",
      "node",
    ]) {
      expect(jobs, `job ${j}`).toContain(j);
    }
  });

  it("carga las reglas de alerta y apunta a alertmanager", () => {
    expect(prometheus.rule_files).toContain("/etc/prometheus/alerts.yml");
    expect(JSON.stringify(prometheus.alerting)).toContain("alertmanager:9093");
  });
});

describe("alertas del cap. 24 (motor bloqueado, cola, disco, BD, stream) + backup (T10.4)", () => {
  const names = alerts.groups.flatMap((g: any) => g.rules.map((r: any) => r.alert));

  it.each([
    "EngineTickStalled",
    "QueueBacklog",
    "DiskAlmostFull",
    "PostgresDown",
    "StreamDown",
    "BackupFailed",
    "BackupTooOld",
  ])("existe la alerta %s", (name) => {
    expect(names).toContain(name);
  });

  it("EngineTickStalled dispara en < 30 s: umbral 10 s + for 10 s + scrape 5 s", () => {
    const rule = alerts.groups.flatMap((g: any) => g.rules).find((r: any) => r.alert === "EngineTickStalled");
    expect(rule.expr).toContain("arena_engine_last_tick_timestamp_seconds > 10");
    expect(rule.for).toBe("10s");
  });

  it("BackupTooOld usa el umbral de 26 h de la DoD de T10.4", () => {
    const rule = alerts.groups.flatMap((g: any) => g.rules).find((r: any) => r.alert === "BackupTooOld");
    expect(rule.expr).toContain("26 * 3600");
  });
});

describe("loki + promtail (trazas por correlation_id)", () => {
  it("promtail NO monta ni usa docker.sock (cap. 28: solo bot-manager)", () => {
    // Sobre la config parseada (los comentarios del archivo sí lo mencionan).
    expect(JSON.stringify(promtail)).not.toContain("docker.sock");
    expect(JSON.stringify(promtail.scrape_configs)).not.toContain("docker_sd");
  });

  it("promtail empuja a loki, etiqueta por servicio y parsea el JSON estructurado", () => {
    expect(promtail.clients[0].url).toContain("loki:3100");
    const stages = promtail.scrape_configs[0].pipeline_stages;
    expect(JSON.stringify(stages)).toContain("com.docker.compose.service");
  });

  it("loki parsea y tiene retención activada", () => {
    expect(loki.limits_config.retention_period).toBe("720h");
    expect(loki.compactor.retention_enabled).toBe(true);
  });
});

describe("grafana aprovisionado desde el repo (sin clicks manuales)", () => {
  const datasources = parse(readFileSync(obs("grafana", "provisioning", "datasources", "datasources.yml"), "utf8"));
  const provider = parse(readFileSync(obs("grafana", "provisioning", "dashboards", "dashboards.yml"), "utf8"));

  it("datasources prometheus y loki con uid fijo", () => {
    const uids = datasources.datasources.map((d: any) => d.uid);
    expect(uids.sort()).toEqual(["loki", "prometheus"]);
  });

  it("el proveedor carga los dashboards del repo", () => {
    expect(provider.providers[0].options.path).toBe("/var/lib/grafana/dashboards");
  });

  it("los dashboards versionados son JSON válido y solo referencian datasources aprovisionados", () => {
    const files = readdirSync(obs("grafana", "dashboards")).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const dash = JSON.parse(readFileSync(obs("grafana", "dashboards", f), "utf8"));
      expect(dash.uid, f).toBeDefined();
      expect(dash.panels.length, f).toBeGreaterThan(0);
      for (const panel of dash.panels) {
        expect(["prometheus", "loki"], `${f}:${panel.title}`).toContain(panel.datasource.uid);
      }
    }
  });

  it("los paneles del dosier: ticks/s, retraso de tick, colas, builds, CPU/RAM, errores por endpoint", () => {
    const plataforma = JSON.parse(readFileSync(obs("grafana", "dashboards", "plataforma.json"), "utf8"));
    const exprs = JSON.stringify(plataforma.panels);
    for (const m of [
      "arena_engine_ticks_per_second",
      "arena_engine_tick_delay_seconds",
      "arena_queue_depth",
      "s9_build_duration_seconds",
      "container_cpu_usage_seconds_total",
      "container_memory_working_set_bytes",
      "http_requests_total",
    ]) {
      expect(exprs).toContain(m);
    }
  });
});

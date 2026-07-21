/**
 * N1 · Métricas Prometheus de la API — CAPABILITY apagada por defecto.
 *
 * `GET /metrics` expone un registro mínimo EN MEMORIA (sin `prom-client`: mismo
 * patrón a mano que `apps/streamer/src/metrics.ts`, función `renderPrometheus`)
 * con el contrato que ya declara `infrastructure/observability/prometheus/prometheus.yml`
 * (job "api", scrape en `api:8080`) y consumen los paneles/alertas del perfil
 * observability (`alerts.yml` · HighErrorRate):
 *   - http_requests_total{service,route,status}          (counter)
 *   - http_request_duration_seconds_sum{service,route}    (counter, summary básico)
 *   - http_request_duration_seconds_count{service,route}  (counter, summary básico)
 *   - api_up                                               (gauge)
 *
 * Cardinalidad acotada A PROPÓSITO: `route` es SIEMPRE la ruta PLANTILLA que
 * Express ya resolvió (`req.route.path`), nunca la URL con ids reales — dos
 * peticiones a `/api/v1/battles/abc` y `/api/v1/battles/xyz` suman en la MISMA
 * serie `route="/api/v1/battles/:id"`. Las peticiones sin ruta casada (404,
 * rutas fuera de contrato) se agrupan bajo `route="unmatched"` en vez de
 * explotar cardinalidad con URLs arbitrarias.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

/** S9_METRICS_ENABLED === "1" | "true" (case-insensitive). Apagada por defecto. */
export function metricsEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.S9_METRICS_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

const SERVICE = "api";
/** Separador interno de clave compuesta (route, status): no puede aparecer en una ruta. */
const KEY_SEP = " ";

/** Ruta PLANTILLA de la petición ya resuelta por Express, o "unmatched" si no hubo match. */
function templateRoute(req: Request): string {
  const routePath = req.route?.path as string | undefined;
  if (!routePath) return "unmatched";
  const base = typeof req.baseUrl === "string" ? req.baseUrl : "";
  const full = `${base}${routePath}`;
  return full || "unmatched";
}

/** Registro en memoria: contadores por (ruta plantilla, status) + duración acumulada por ruta. */
export class MetricsRegistry {
  private requestsTotal = new Map<string, number>();
  private durationSecondsSum = new Map<string, number>();
  private durationSecondsCount = new Map<string, number>();

  /** Registra una petición terminada: incrementa el contador y acumula duración. */
  recordRequest(route: string, status: number, durationSeconds: number): void {
    const reqKey = `${route}${KEY_SEP}${status}`;
    this.requestsTotal.set(reqKey, (this.requestsTotal.get(reqKey) ?? 0) + 1);
    this.durationSecondsSum.set(route, (this.durationSecondsSum.get(route) ?? 0) + durationSeconds);
    this.durationSecondsCount.set(route, (this.durationSecondsCount.get(route) ?? 0) + 1);
  }

  /** Texto Prometheus (contrato con prometheus.yml, job "api"). */
  render(): string {
    const lines: string[] = [
      "# HELP http_requests_total Peticiones HTTP totales por ruta plantilla y codigo de estado",
      "# TYPE http_requests_total counter",
    ];
    for (const [key, count] of this.requestsTotal) {
      const sepIdx = key.lastIndexOf(KEY_SEP);
      const route = key.slice(0, sepIdx);
      const status = key.slice(sepIdx + 1);
      lines.push(`http_requests_total{service="${SERVICE}",route="${route}",status="${status}"} ${count}`);
    }

    lines.push(
      "# HELP http_request_duration_seconds_sum Suma de duracion de peticiones (segundos) por ruta plantilla",
      "# TYPE http_request_duration_seconds_sum counter",
    );
    for (const [route, sum] of this.durationSecondsSum) {
      lines.push(`http_request_duration_seconds_sum{service="${SERVICE}",route="${route}"} ${sum}`);
    }

    lines.push(
      "# HELP http_request_duration_seconds_count Recuento de peticiones medidas por ruta plantilla",
      "# TYPE http_request_duration_seconds_count counter",
    );
    for (const [route, count] of this.durationSecondsCount) {
      lines.push(`http_request_duration_seconds_count{service="${SERVICE}",route="${route}"} ${count}`);
    }

    lines.push(
      "# HELP api_up 1 si el proceso de la API esta sirviendo peticiones",
      "# TYPE api_up gauge",
      "api_up 1",
      "",
    );
    return lines.join("\n");
  }
}

/**
 * Middleware de conteo: mide la duración de la petición y registra en `finish`
 * usando la ruta PLANTILLA resuelta por Express (nunca la URL cruda). No lee ni
 * expone cabeceras ni cuerpos: solo ruta plantilla, código de estado y duración.
 */
export function metricsMiddleware(registry: MetricsRegistry): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const route = templateRoute(req);
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      registry.recordRequest(route, res.statusCode, durationSeconds);
    });
    next();
  };
}

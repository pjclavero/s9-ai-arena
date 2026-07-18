/**
 * R-DEPLOY · R1 — entrypoint de servicio del map-service (E4).
 *
 * El Compose declaraba `apps/map-service/src/main.ts` como SERVICE_ENTRY pero el
 * archivo no existía: el contenedor abortaba en el arranque. Este entrypoint NO
 * duplica lógica: reutiliza la librería `MapService` (service.ts, almacén en
 * memoria de esta fase) y expone /healthz más lecturas mínimas (list/get). La
 * importación de Tiled sigue en la librería (import-tiled.ts / cli.ts).
 *
 * Falla CERRADO si el PORT configurado no es un puerto TCP válido.
 */
import express, { type Express } from "express";
import { MapService, MapServiceError } from "./service.js";

function log(level: "info" | "error", msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, service: "map-service", msg, ...extra }));
}

/** Construye la app del map-service sobre la librería MapService existente. */
export function createMapServiceApp(maps: MapService = new MapService()): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8mb" }));

  app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "map-service", maps: maps.listMaps().length }));

  // Lecturas mínimas sobre la librería existente (sin nueva lógica de negocio).
  app.get("/maps", (_req, res) => res.json(maps.listMaps()));
  app.get("/maps/:mapId/:version", (req, res) => {
    try {
      res.json(maps.getMap(req.params.mapId, Number(req.params.version)));
    } catch (e) {
      if (e instanceof MapServiceError && e.code === "not_found") {
        res.status(404).json({ error: "not_found", message: e.message });
        return;
      }
      throw e;
    }
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("map-service/src/main.ts")) {
  const port = Number(process.env.PORT ?? 8082);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    log("error", `PORT inválido: '${process.env.PORT}'. Debe ser un entero 1-65535.`);
    process.exit(1);
  }
  const server = createMapServiceApp().listen(port, () => log("info", `map-service escuchando en :${port}`));
  const shutdown = (sig: string): void => {
    log("info", `${sig}: parando`);
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

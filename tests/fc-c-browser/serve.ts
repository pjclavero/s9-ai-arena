/**
 * FC-C · Entorno AISLADO mínimo para el E2E de navegador de DEV-C (pendiente de
 * unificar con la base canónica de DEV-D, tests/browser/, cuando REVIEW integre).
 *
 *  - PostgreSQL REAL embebido (el mismo de los tests de BD), migraciones reales.
 *  - Contenido base con `seedContent` (= `cli.ts bootstrap`): rulesets + catálogo +
 *    mapa de serie. SIN usuarios de desarrollo: el E2E se registra por la UI.
 *  - API REAL (`createApp`) bajo /api/v1, y la SPA REAL compilada por `vite build`
 *    servida en el mismo origen (como tras el gateway).
 *
 * Única pieza no real (declarada): el pipeline de build de bots usa FakeBotManager.
 * Publicar un bot exige el sandbox de builds (área de DEV-A), que en ia02 no hay;
 * el resto (mapas, equipos, loadout, rulesets, batallas) es el código de producción.
 *
 * Uso: WEB_DIST=/ruta/dist PORT=4317 npx tsx tests/fc-c-browser/serve.ts
 * Escribe "READY <port>" en stdout cuando acepta peticiones. Nunca toca producción.
 */
import express from "express";
import { join } from "node:path";
import { startTestDb } from "../../apps/api/src/testing/test-db.js";
import { seedContent } from "../../apps/api/src/db/seeds/dev.js";
import { createApp } from "../../apps/api/src/app.js";
import { FakeBotManager } from "../../apps/api/src/services/bot-manager.js";

const port = Number(process.env.PORT ?? 4317);
const dist = process.env.WEB_DIST;
if (!dist) throw new Error("WEB_DIST obligatorio (salida de vite build)");

const h = await startTestDb();
await seedContent(h.db);
const api = createApp({
  db: h.db,
  botManager: new FakeBotManager(h.db),
  corsOrigin: `http://127.0.0.1:${port}`,
});
const root = express();
root.use("/api/v1", api);
// Endpoints de inspección SOLO del E2E (comprobar en BD lo que dice la UI). Lectura.
root.get("/__e2e/db/map/:mapId", async (req, res) => {
  const rows = await h.db("map_versions").where({ map_id: req.params.mapId }).orderBy("version");
  res.json(
    rows.map((r: Record<string, unknown>) => ({
      version: r.version,
      state: r.state,
      name: (r.content as { meta?: { name?: string } }).meta?.name,
    })),
  );
});
root.get("/__e2e/db/battle/:id", async (req, res) => {
  res.json((await h.db("battles").where({ id: req.params.id }).first()) ?? null);
});
root.use(express.static(dist));
root.get(/.*/, (_req, res) => res.sendFile(join(dist, "index.html")));
const server = root.listen(port, "127.0.0.1", () => console.log(`READY ${port}`));
const stop = async () => {
  server.close();
  await h.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

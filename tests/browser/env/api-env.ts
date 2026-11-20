/**
 * FC-D · E2E de navegador — API REAL sobre PostgreSQL EMBEBIDO (aislado).
 *
 * Mismo cableado que apps/api/src/server.ts para lo que ejerce la web: `createApp`
 * con la BD de tests embebida, `seedDev` (usuarios por rol con la contraseña de
 * desarrollo, SÓLO en esta BD efímera) y `seedContent` (ruleset, catálogo, mapa
 * MVP). Nada de mocks: la web habla con esta API a través del gateway nginx real.
 *
 * Entorno (lo fija tests/browser/run.sh):
 *  - PORT, DBURL_FILE (dónde dejar la URL de la BD para el worker);
 *  - JWT_SECRET_FILE: fichero 0600 COMPARTIDO con el tournament-worker (TD-028);
 *  - SPECTATE_WS_URL relativo (`/ws/spectate`): el cliente lo ancla al origen.
 * Nunca toca producción: BD en un directorio temporal, escucha sólo 127.0.0.1.
 */
import express from "express";
import { writeFileSync } from "node:fs";
import { startTestDb } from "../../../apps/api/src/testing/test-db.js";
import { seedDev, seedContent } from "../../../apps/api/src/db/seeds/dev.js";
import { createApp } from "../../../apps/api/src/app.js";
import { RuntimeSettingsStore } from "../../../apps/api/src/runtime-settings.js";

const h = await startTestDb();
await seedDev(h.db);
await seedContent(h.db);

const root = express();
root.set("trust proxy", 2);
root.get("/healthz", (_q, r) => r.json({ status: "ok", service: "api" }));
// MG · como producción (server.ts): los flags públicos salen de la fila persistida,
// creada aquí con el entorno (run.sh fija S9_PUBLIC_SPECTATE_ENABLED=true, el valor de
// producción: sin él el espectador está apagado y «Retransmitir» queda bloqueado).
// Se crea ANTES de publicar db.url, para que el worker ya encuentre la fila.
const runtimeSettings = new RuntimeSettingsStore(h.db, { bootstrap: true });
await runtimeSettings.refresh();
runtimeSettings.start();
root.use(createApp({ db: h.db, trustProxyHops: 2, runtimeSettings }));

const port = Number(process.env.PORT ?? 38080);
const server = root.listen(port, "127.0.0.1", () => {
  if (process.env.DBURL_FILE) writeFileSync(process.env.DBURL_FILE, h.url, { mode: 0o600 });
  console.log(JSON.stringify({ msg: "api-env ready", port }));
});

const stop = async () => {
  server.close();
  await h.stop().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

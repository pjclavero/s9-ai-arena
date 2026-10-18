/** Entrypoint de la API: PORT + DATABASE_URL (cap. 6.2). Servida tras el gateway bajo /api/v1. */
import express from "express";
import { createDb } from "./db/connection.js";
import { createApp } from "./app.js";
import { mountVersionEndpoint } from "../../../packages/build-info/index.js";
import { resolveTrustProxyHops } from "./middleware/proxy-trust.js";

const db = createDb();
const port = Number(process.env.PORT ?? 8080);
// R1.8 · ERR-SEC-05: se resuelve UNA vez y falla cerrado (valor inválido =
// no arranca). Se aplica también al envolvente para que ningún middleware
// futuro montado aquí vea una IP distinta de la de la app principal.
const trustProxyHops = resolveTrustProxyHops();

// REVIEW (cierre funcional, R4.1) · la API YA NO cablea el launcher HTTP de
// `POST /battles/{id}/run` (services/battle-run-http-launcher.ts): usaba
// `artifact_hash` como si fuera un digest de imagen y no arrancaba el código del
// bot. La autoridad única de ejecución es el tournament-worker (DEV-B), que lanza
// el ARTEFACTO FIRMADO de cada versión (createBattleLaunchHost, DEV-A). `/run`
// sólo delega en la cola. Sin runner, /system/status anuncia
// realBattleRuns.available=false (y la web ya no ofrece el botón).

// /healthz va en un Express envolvente, NO en createApp(): el test de
// conformidad (conformance.test.ts) exige que la app no exponga rutas fuera del
// contrato de E1 salvo las documentadas. El healthcheck es infraestructura.
const root = express();
root.set("trust proxy", trustProxyHops);
root.get("/healthz", (_req, res) => res.json({ status: "ok", service: "api" }));
// ADR-016 · /version va en el MISMO envolvente que /healthz, no en createApp():
// es señal de infraestructura y el test de conformidad prohíbe rutas fuera del
// contrato de E1 dentro de la app.
mountVersionEndpoint(root, "api");
root.use(createApp({ db, trustProxyHops }));

root.listen(port, () => {
  console.log(JSON.stringify({ level: "info", service: "api", msg: `API de plataforma escuchando en :${port}` }));
});

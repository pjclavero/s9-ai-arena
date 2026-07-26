/**
 * B6 (hallazgo del supervisor, DOS rondas, ambas demostradas ejecutando código
 * real, no leyendo) · La cadena navegador → gateway → replay-service tiene TRES
 * eslabones que deben coincidir exactamente:
 *
 *   1. La ruta que construye el cliente (`httpReplaySource()`,
 *      apps/web/src/viewer/replay-player.ts, usado por ReplayPage.tsx con
 *      `REPLAY_SERVICE_GATEWAY_BASE`).
 *   2. La transformación que le aplica el gateway (`location /replays/` en
 *      infrastructure/gateway/nginx.conf y nginx-behind-proxy.conf — con o sin
 *      `rewrite`).
 *   3. La tabla de rutas REAL que registra replay-service
 *      (apps/replay-service/src/server.ts: TODAS con el prefijo `/replays`).
 *
 * Ronda 1: el cliente pedía un prefijo (`/replay-service`) que no existía en
 * el gateway → caía en el `location /` genérico (SPA), nunca llegaba a
 * replay-service.
 *
 * Ronda 2 (la que motiva este fichero): un test que solo compara TEXTO —
 * "¿la constante vale /replays?", "¿ese string aparece en el nginx.conf?" —
 * NO detecta que (a) el gateway tenía un `rewrite` que QUITABA el prefijo
 * `/replays/` antes de reenviar, mientras replay-service registra sus rutas
 * CON ese prefijo (desajuste #1: 404 real, demostrado por el supervisor
 * ejecutando el Express real de replay-service), NI (b) que el propio cliente
 * componía un prefijo DUPLICADO (`/replays` + `/replays/...` que ya añade
 * `httpReplaySource()` internamente → `/replays/replays/...`, desajuste #2,
 * encontrado mientras se escribía ESTE test ejecutable — ver el comentario de
 * `REPLAY_SERVICE_GATEWAY_BASE` en ReplayPage.tsx).
 *
 * Por eso este fichero NO compara cadenas: reconstruye la ruta que el
 * NAVEGADOR pediría de verdad (`REPLAY_SERVICE_GATEWAY_BASE` + lo que arma
 * `httpReplaySource()`), le aplica la transformación REAL del gateway (parseada
 * de los ficheros .conf — un `rewrite` que quita el prefijo, o su ausencia, que
 * lo deja intacto) y envía el resultado con supertest contra el Express REAL de
 * replay-service (`createReplayServer()`, tras ingestar un replay real con
 * `ingestReplay()`). Si cualquiera de los tres eslabones se desalinea, la
 * petición final no encuentra ruta y el test falla con un 404 de verdad.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { ingestReplay } from "../../replay-service/src/store.js";
import { createReplayServer } from "../../replay-service/src/server.js";
import { httpReplaySource } from "../src/viewer/replay-player.js";
import { REPLAY_SERVICE_GATEWAY_BASE } from "../src/pages/ReplayPage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");

/**
 * Parsea el bloque `location <prefix> { ... }` de un nginx.conf REAL y
 * devuelve la función de transformación que nginx aplicaría de verdad a una
 * URI que caiga en ese location: si hay un `rewrite ^<prefix>(.*)$ /$1
 * break;` (la forma que quita el prefijo), lo reproduce con una regex
 * construida a partir del propio patrón capturado del fichero — no un
 * literal adivinado aquí; si no hay `rewrite`, la identidad (nginx reenvía la
 * URI íntegra cuando `proxy_pass` no lleva URI tras el host, como en estos
 * bloques).
 */
function parseGatewayTransform(nginxConf: string, locationPrefix: string): (uri: string) => string {
  const escaped = locationPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockMatch = new RegExp(`location\\s+${escaped}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(nginxConf);
  if (!blockMatch) {
    throw new Error(`no se encontró "location ${locationPrefix}" en el nginx.conf dado (fixture de test rota)`);
  }
  const block = blockMatch[1];
  const rewriteMatch = /rewrite\s+(\S+)\s+(\S+)\s+break;/.exec(block);
  if (!rewriteMatch) {
    // Sin rewrite: proxy_pass sin URI tras el host reenvía la URI original íntegra.
    return (uri: string) => uri;
  }
  const [, pattern, replacement] = rewriteMatch;
  const re = new RegExp(pattern);
  if (replacement !== "/$1") {
    throw new Error(`patrón de rewrite no soportado por este parser de test: "${replacement}"`);
  }
  return (uri: string) => {
    const m = re.exec(uri);
    if (!m) throw new Error(`la URI "${uri}" no matchea el rewrite del gateway "${pattern}"`);
    return "/" + (m[1] ?? "");
  };
}

/** La ruta EXACTA que el navegador pide para el índice de un replay, tal como la
 *  compone hoy `ReplayPage.tsx` (REPLAY_SERVICE_GATEWAY_BASE + httpReplaySource). */
function clientIndexRequestPath(battleId: string): string {
  let captured = "";
  const fakeFetch = async (url: string) => {
    captured = url;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  void httpReplaySource(REPLAY_SERVICE_GATEWAY_BASE, battleId, fakeFetch)
    .index()
    .catch(() => {});
  return captured;
}

let app: Express;
let replay: Replay;
let dir: string;

beforeAll(async () => {
  await initPhysics();
  dir = mkdtempSync(join(tmpdir(), "b6-gateway-path-"));
  app = createReplayServer({ dir });
  replay = await record(
    {
      battleId: "battle_gateway_chain",
      seed: "gw",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 60 }),
      map: emptyArena(),
      participants: [
        { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
        { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
      ],
    },
    (b) => {
      b.attachBot("v_red", new HunterBot("bot_red"));
      b.attachBot("v_blue", new HunterBot("bot_blue"));
    },
  );
  ingestReplay(dir, replay, { official: false });
}, 60_000);

describe("B6 · la cadena navegador→gateway→replay-service llega a una ruta REAL (ejecutado, no comparado en texto)", () => {
  for (const [confName, confPath] of [
    ["nginx.conf", join(REPO, "infrastructure/gateway/nginx.conf")],
    ["nginx-behind-proxy.conf", join(REPO, "infrastructure/gateway/nginx-behind-proxy.conf")],
  ] as const) {
    it(`${confName}: GET del índice de un replay ingerido, tal como lo pediría el navegador, aplicando la transformación REAL del gateway, resuelve 200 contra el Express real de replay-service (no 404)`, async () => {
      const nginxConf = readFileSync(confPath, "utf8");
      const transform = parseGatewayTransform(nginxConf, "/replays/");

      const clientPath = clientIndexRequestPath(replay.header.battleId);
      // Eslabón 1 comprobado en vivo: la ruta que de verdad compone el cliente
      // (no lo que "debería" componer según un comentario).
      expect(clientPath).toBe(`/replays/${replay.header.battleId}/index`);

      // Eslabón 2: la MISMA transformación que aplicaría nginx en producción.
      const upstreamPath = transform(clientPath);

      // Eslabón 3: se envía esa ruta exacta al Express REAL de replay-service.
      const res = await request(app).get(upstreamPath);
      expect(
        res.status,
        `GET ${upstreamPath} (tras aplicar el gateway "${confName}" a ${clientPath}) → ${res.status}, se esperaba 200`,
      ).toBe(200);
      expect(res.body.battleId).toBe(replay.header.battleId);
    });
  }

  it("MUTACIÓN: si el gateway reintrodujera un rewrite que quita /replays/, este test lo cazaría (simulado sobre el texto real + Express real, sin editar el .conf)", async () => {
    const nginxConf = readFileSync(join(REPO, "infrastructure/gateway/nginx.conf"), "utf8");
    // Reproduce la configuración ROTA que tenía el gateway antes de este arreglo
    // (mismo bloque, con el `rewrite` que se quitó) para demostrar que el
    // parser+Express real la detecta como 404, no como texto que "parece bien".
    const brokenConf = nginxConf.replace(
      "    location /replays/ {\n      set $replays_up http://replay-service:8083;\n",
      "    location /replays/ {\n      set $replays_up http://replay-service:8083;\n      rewrite ^/replays/(.*)$ /$1 break;\n",
    );
    expect(brokenConf).not.toBe(nginxConf); // la sustitución de verdad encontró el bloque

    const transform = parseGatewayTransform(brokenConf, "/replays/");
    const clientPath = clientIndexRequestPath(replay.header.battleId);
    const upstreamPath = transform(clientPath);

    const res = await request(app).get(upstreamPath);
    expect(res.status).toBe(404);
  });

  it("MUTACIÓN: si REPLAY_SERVICE_GATEWAY_BASE volviera a ser '/replays' (el desajuste #2, prefijo duplicado), la ruta compuesta por el cliente REAL (httpReplaySource) ya NO resuelve contra el gateway/replay-service", async () => {
    // Reproduce, con la MISMA función que usa el cliente, lo que compondría
    // httpReplaySource con la base incorrecta de la ronda 1 del arreglo
    // (`/replays`, que sumada al `/replays/<id>/index` que ya añade
    // httpReplaySource por dentro da un prefijo duplicado).
    let captured = "";
    await httpReplaySource("/replays", replay.header.battleId, async (url: string) => {
      captured = url;
      return { ok: true, status: 200, json: async () => ({}) };
    })
      .index()
      .catch(() => {});
    expect(captured).toBe(`/replays/replays/${replay.header.battleId}/index`);

    const nginxConf = readFileSync(join(REPO, "infrastructure/gateway/nginx.conf"), "utf8");
    const transform = parseGatewayTransform(nginxConf, "/replays/");
    const upstreamPath = transform(captured);

    const res = await request(app).get(upstreamPath);
    expect(res.status).toBe(404);
  });
});

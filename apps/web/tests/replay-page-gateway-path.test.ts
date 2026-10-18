/**
 * PRC (TD-004) · La cadena navegador → gateway → API del reproductor de replays,
 * EJECUTADA (no comparada en texto). Sustituye a la cadena B6 (navegador →
 * gateway → replay-service), que era justamente el bypass: `location /replays/`
 * hacía `proxy_pass` al replay-service sin autenticación.
 *
 * Eslabones que deben coincidir:
 *   1. La URL que el NAVEGADOR pide de verdad: `httpReplaySource(REPLAY_API_BASE,
 *      …)` + `replayApiFetch` (que usa `api()`, apps/web/src/api.ts, con el Bearer
 *      y el prefijo `/api/v1`). Se captura stubbeando `fetch`.
 *   2. La transformación REAL del gateway para `/api/v1/` (el `rewrite` parseado
 *      de infrastructure/gateway/nginx.conf y nginx-behind-proxy.conf).
 *   3. La operación del CONTRATO de la API que resuelve esa ruta (Express real
 *      montado con las rutas de apps/api/openapi.yaml): debe ser
 *      `getReplayIndex` / `getReplaySegment`, que aplican la política de acceso.
 * Y además: el `location /replays/` del gateway ya NO hace proxy a ningún sitio.
 *
 * El comportamiento con nginx REAL (anónimo 404, participante 200, mutación que
 * re-expone el proxy ⇒ rojo) lo prueba infrastructure/gateway/tests/replay-gateway.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express, { type Express } from "express";
import request from "supertest";
import { httpReplaySource } from "../src/viewer/replay-player.js";
import { REPLAY_API_BASE, replayApiFetch } from "../src/pages/ReplayPage.js";
import { setToken } from "../src/api.js";
import { loadContract, toExpressPath } from "../../api/src/openapi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");
const CONFS = [
  ["nginx.conf", join(REPO, "infrastructure/gateway/nginx.conf")],
  ["nginx-behind-proxy.conf", join(REPO, "infrastructure/gateway/nginx-behind-proxy.conf")],
] as const;

function locationBlock(conf: string, prefix: string): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`location\\s+${escaped}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(conf);
  if (!m) throw new Error(`no se encontró "location ${prefix}" en la conf (fixture rota)`);
  return m[1];
}

/** Transformación que nginx aplica en `location /api/v1/` (rewrite … /$1 break). */
function apiTransform(conf: string): (uri: string) => string {
  const block = locationBlock(conf, "/api/v1/");
  const rw = /rewrite\s+(\S+)\s+(\S+)\s+break;/.exec(block);
  if (!rw || rw[2] !== "/$1") throw new Error("rewrite de /api/v1/ no soportado por este parser");
  const re = new RegExp(rw[1]);
  return (uri) => {
    const m = re.exec(uri);
    if (!m) throw new Error(`"${uri}" no matchea el rewrite del gateway`);
    return "/" + (m[1] ?? "");
  };
}

/** URLs que pide el navegador para índice y segmento, capturadas del fetch real. */
async function browserUrls(battleId: string): Promise<string[]> {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string | URL, init?: RequestInit) => {
      urls.push(String(u));
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer tok-de-prueba");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  );
  const src = httpReplaySource(REPLAY_API_BASE, battleId, replayApiFetch);
  await src.index();
  await src.segment(0, 600);
  return urls;
}

/** Express con TODAS las operaciones GET del contrato; responde su operationId. */
let contractApp: Express;
beforeAll(() => {
  contractApp = express();
  for (const op of loadContract().operations) {
    if (op.method !== "get") continue;
    contractApp.get(toExpressPath(op.path), (_req, res) => {
      res.json({ operationId: op.operationId });
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

describe("PRC TD-004 · navegador → gateway → API (contrato) para el reproductor", () => {
  for (const [name, path] of CONFS) {
    it(`${name}: índice y segmento van a /api/v1 con Bearer y resuelven getReplayIndex/getReplaySegment`, async () => {
      setToken("tok-de-prueba");
      const conf = readFileSync(path, "utf8");
      const [indexUrl, segmentUrl] = await browserUrls("btl_cadena");
      expect(indexUrl).toBe("/api/v1/replays/btl_cadena/index");
      expect(segmentUrl).toBe("/api/v1/replays/btl_cadena/segment?fromTick=0&toTick=600");

      const t = apiTransform(conf);
      const ix = await request(contractApp).get(t(indexUrl));
      expect(ix.status).toBe(200);
      expect(ix.body.operationId).toBe("getReplayIndex");
      const seg = await request(contractApp).get(t(segmentUrl));
      expect(seg.body.operationId).toBe("getReplaySegment");
    });

    it(`${name}: /replays y /replays/ responden 404 en el gateway, sin proxy_pass al replay-service`, () => {
      const conf = readFileSync(path, "utf8");
      for (const loc of ["= /replays", "/replays/"]) {
        const block = locationBlock(conf, loc);
        expect(block).not.toMatch(/proxy_pass/);
        expect(block).toMatch(/return\s+404/);
      }
      expect(conf).not.toMatch(/replay-service:8083/);
    });
  }
});

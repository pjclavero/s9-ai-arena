/**
 * BROADCAST-PUBLIC-ACCESS · gate INTERNAL_BROADCAST_API_PROXY con NGINX REAL.
 *
 * Ejecuta la conf REAL del servidor web (infrastructure/docker/web/nginx.conf) en
 * la MISMA imagen base que la imagen `web` (nginx:1.27-alpine, Dockerfile) y le
 * pone delante stubs que hacen de `api` (HTTP JSON), de `tournament-worker`
 * (WebSocket real, paquete `ws`) y de `replay-service` (cuenta si alguien llega).
 * De la conf SÓLO se sustituyen `listen`, el resolver de Docker y los nombres de
 * servicio por 127.0.0.1:<puerto>; las `location` son las del repo. Comprueba:
 *  - GET /api/v1/... ⇒ application/json con el cuerpo del upstream y la ruta
 *    reescrita como en el gateway (nunca text/html ni el index.html);
 *  - /ws/spectate/<id> ⇒ 101 y eco por el upstream WS;
 *  - /broadcast ⇒ la SPA (index.html) con Cache-Control: no-cache;
 *  - /replays* ⇒ SPA, y el replay-service no recibe NINGUNA petición.
 *
 * Opt-in (Docker + imagen nginx): S9_RUN_WEB_PROXY_E2E=1. Sin él se SALTA, y
 * saltado NO es verde. CALIBRACIÓN: S9_WEB_PROXY_E2E_CONF=<conf de origin/main>
 * debe ponerlo ROJO por el Content-Type de /api/v1 (las sustituciones son
 * opcionales para que el rojo salga de la aserción, no de la preparación).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const RUN = process.env.S9_RUN_WEB_PROXY_E2E === "1";
const IMAGE = process.env.S9_WEB_PROXY_E2E_NGINX_IMAGE ?? "nginx:1.27-alpine";
const here = dirname(fileURLToPath(import.meta.url));
const CONF = process.env.S9_WEB_PROXY_E2E_CONF ?? join(here, "..", "docker", "web", "nginx.conf");
const TAG = `bcpa-web-${process.pid}`;
const SPA_MARK = "SPA-INDEX-MARK-7f3a";
const BID = "dc5a7d91-fe90-4ca9-90f6-83aedd2196e6";

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function req(port: number, path: string, method = "GET"): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port, path, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", reject);
    r.setTimeout(5000, () => r.destroy(new Error("timeout")));
    r.end();
  });
}

async function listen(s: Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const s = createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
}

describe.skipIf(!RUN)("INTERNAL_BROADCAST_API_PROXY · nginx real de web", () => {
  let work = "";
  let webPort = 0;
  const apiHits: string[] = [];
  let replayHits = 0;
  const servers: Server[] = [];
  let wss: WebSocketServer | null = null;
  let wsPath = "";

  beforeAll(async () => {
    const api = createServer((rq, rs) => {
      apiHits.push(`${rq.method} ${rq.url}`);
      rs.setHeader("Content-Type", "application/json; charset=utf-8");
      rs.end(JSON.stringify({ from: "api-stub", url: rq.url, method: rq.method }));
    });
    const replay = createServer((_rq, rs) => {
      replayHits++;
      rs.end("replay-service");
    });
    const tw = createServer((_rq, rs) => rs.end("tw-http"));
    wss = new WebSocketServer({ server: tw });
    wss.on("connection", (ws, rq) => {
      wsPath = rq.url ?? "";
      ws.on("message", (m) => ws.send(`echo:${m.toString()}`));
    });
    servers.push(api, replay, tw);
    const [apiPort, replayPort, twPort] = [await listen(api), await listen(replay), await listen(tw)];
    webPort = await freePort();

    work = mkdtempSync(join(tmpdir(), `${TAG}-`));
    chmodSync(work, 0o755);
    let c = readFileSync(CONF, "utf8");
    c = c.split("listen 3000;").join(`listen 127.0.0.1:${webPort};`);
    c = c.split("resolver 127.0.0.11 valid=10s ipv6=off;").join("# resolver: upstreams por IP");
    c = c.split("http://api:8080").join(`http://127.0.0.1:${apiPort}`);
    c = c.split("http://tournament-worker:8081").join(`http://127.0.0.1:${twPort}`);
    c = c.split("replay-service:8083").join(`127.0.0.1:${replayPort}`);
    expect(c, "la conf debe escuchar en el puerto de prueba").toContain(`listen 127.0.0.1:${webPort};`);
    const confFile = join(work, "default.conf");
    writeFileSync(confFile, c);
    chmodSync(confFile, 0o644);
    const html = join(work, "html");
    mkdirSync(join(html, "assets"), { recursive: true });
    writeFileSync(join(html, "index.html"), `<!doctype html><html><body>${SPA_MARK}</body></html>`);
    writeFileSync(join(html, "assets", "app-abc.js"), "console.log(1)");
    writeFileSync(join(html, "version.json"), "{}");
    execFileSync("chmod", ["-R", "a+rX", html]);

    // nginx -t con la conf tal cual (sintaxis + directivas válidas en esta versión).
    const t = execFileSync(
      "docker",
      ["run", "--rm", "--network", "host", "-v", `${confFile}:/etc/nginx/conf.d/default.conf:ro`, IMAGE, "nginx", "-t"],
      { stdio: "pipe" },
    );
    void t;
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        TAG,
        "--network",
        "host",
        "-v",
        `${confFile}:/etc/nginx/conf.d/default.conf:ro`,
        "-v",
        `${html}:/usr/share/nginx/html:ro`,
        IMAGE,
      ],
      { stdio: "pipe" },
    );
    for (let i = 0; i < 60; i++) {
      try {
        if ((await req(webPort, "/healthz")).status === 200) return;
      } catch {
        /* aún no escucha */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`nginx no arrancó: ${execFileSync("docker", ["logs", TAG], { stdio: "pipe" }).toString()}`);
  }, 120_000);

  afterAll(async () => {
    try {
      execFileSync("docker", ["rm", "-f", TAG], { stdio: "pipe" });
    } catch {
      /* ya no existe */
    }
    wss?.close();
    for (const s of servers) await new Promise((r) => s.close(r));
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it.each([
    ["GET", `/api/v1/battles/${BID}`, `/battles/${BID}`],
    ["POST", `/api/v1/battles/${BID}/spectate-ticket`, `/battles/${BID}/spectate-ticket`],
    ["GET", "/api/v1/tournaments/b4d6cb4d/battles", "/tournaments/b4d6cb4d/battles"],
    ["GET", "/api/v1/tournaments?limit=100", "/tournaments?limit=100"],
  ])("%s %s ⇒ JSON del upstream api (ruta %s), nunca el index.html", async (method, path, upstreamUrl) => {
    const r = await req(webPort, path, method);
    expect(String(r.headers["content-type"])).toMatch(/^application\/json/);
    expect(r.body).not.toContain(SPA_MARK);
    expect(JSON.parse(r.body)).toEqual({ from: "api-stub", url: upstreamUrl, method });
  });

  it("/ws/spectate/<id> ⇒ 101 Upgrade al upstream WebSocket (ruta reescrita) y eco", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws/spectate/${BID}`, ["spectate.v1"]);
    const got = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("ping"));
      ws.on("message", (m) => resolve(m.toString()));
      ws.on("error", reject);
      ws.on("unexpected-response", (_q, res) => reject(new Error(`sin upgrade: HTTP ${res.statusCode}`)));
      setTimeout(() => reject(new Error("timeout ws")), 5000);
    });
    ws.close();
    expect(got).toBe("echo:ping");
    expect(wsPath).toBe(`/spectate/${BID}`);
  });

  it("/broadcast ⇒ SPA (index.html) con Cache-Control: no-cache", async () => {
    const r = await req(webPort, `/broadcast?tournament=b4d6cb4d`);
    expect(r.status).toBe(200);
    expect(String(r.headers["content-type"])).toMatch(/^text\/html/);
    expect(r.body).toContain(SPA_MARK);
    expect(String(r.headers["cache-control"])).toMatch(/no-cache|no-store/);
  });

  it("/replays y /replays/* ⇒ SPA; ni el replay-service ni la api reciben nada", async () => {
    const before = apiHits.length;
    for (const p of ["/replays", `/replays/${BID}/index`, `/replays/${BID}/segment/0`]) {
      const r = await req(webPort, p);
      expect(r.body, p).toContain(SPA_MARK);
    }
    expect(replayHits).toBe(0);
    expect(apiHits.length).toBe(before);
  });

  it("/assets/ sigue inmutable (no se rompe la caché larga de los ficheros con hash)", async () => {
    const r = await req(webPort, "/assets/app-abc.js");
    expect(r.status).toBe(200);
    expect(String(r.headers["cache-control"])).toMatch(/immutable/);
  });
});

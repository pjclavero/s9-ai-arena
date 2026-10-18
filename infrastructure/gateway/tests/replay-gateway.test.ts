/**
 * PRC (TD-004) · Autorización de replays a través del GATEWAY REAL.
 *
 * Ejecuta nginx de verdad (contenedor, misma versión mayor que la imagen del
 * gateway: nginx 1.27) con las confs REALES del repo —
 * infrastructure/gateway/nginx.conf (TLS en el gateway) y
 * nginx-behind-proxy.conf (TLS fuera)— a las que SÓLO se les sustituyen los
 * nombres de servicio Docker por 127.0.0.1:<puerto>, los `listen` y el
 * resolver. Todas las `location` son las del repo. Detrás: la API real
 * (createApp + PostgreSQL embebido) y el replay-service REAL sirviendo el MISMO
 * directorio de replays.
 *
 * Comprueba (SPEC DEV-SEC):
 *  - SEC-4 anónimo por el gateway: /replays, /replays/, /replays/<id>, /index,
 *    /segment, POST /verify y POST de ingesta ⇒ 404; por /api/v1: metadata,
 *    índice, segmento y archivo ⇒ 404, listado ⇒ 401.
 *  - SEC-5 participante por el gateway ⇒ índice, segmento y archivo 200.
 *  - SEC-6 ajeno ⇒ 404 idéntico al de un id inexistente.
 *  - SEC-7 capability pública: apagada ⇒ anónimo 404; encendida ⇒ 200 SÓLO
 *    para la batalla de bots públicos; la del bot privado sigue en 404.
 *  - SEC-9 (TD-014) ninguna respuesta de replay redirige, y nunca a http://.
 *
 * SEC-8 · MUTACIÓN: devolver a `location /replays/` su `proxy_pass` al
 * replay-service (lo que había antes de TD-004) pone ROJO este fichero, porque
 * el replay-service real entrega el índice del replay PRIVADO al anónimo. Por
 * eso la sustitución de `replay-service:8083` es OPCIONAL aquí: la conf buena no
 * lo menciona, la mutada sí, y el test la conecta al servicio real.
 *
 * Opt-in (necesita Docker y la imagen nginx): S9_RUN_GATEWAY_SECURITY_E2E=1.
 * Sin él, el fichero se SALTA, y saltado NO es verde. Recursos Docker con
 * prefijo `prcsec-gw-`; sólo se borran los propios.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { startTestDb, type TestDbHandle } from "../../../apps/api/src/testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "../../../apps/api/src/db/seeds/dev.js";
import { tokenFor } from "../../../apps/api/src/testing/helpers.js";
import { createApp } from "../../../apps/api/src/app.js";
import { createReplayServer } from "../../../apps/replay-service/src/server.js";
import { ingestReplay } from "../../../apps/replay-service/src/store.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../../apps/arena-engine/src/sim/physics.js";
import { record } from "../../../apps/arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../../apps/arena-engine/src/fixtures.js";
import { HunterBot } from "../../../apps/arena-engine/src/stubs.js";

const RUN = process.env.S9_RUN_GATEWAY_SECURITY_E2E === "1";
const NGINX_IMAGE = process.env.S9_GATEWAY_TEST_NGINX_IMAGE ?? "nginxinc/nginx-unprivileged:1.27-alpine";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TAG = `prcsec-gw-${process.pid}`;

interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Petición SIN seguir redirecciones (para ver cualquier 3xx tal cual). */
function req(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; rawPath?: string } = {},
): Promise<Resp> {
  const u = new URL(url);
  const fn = u.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = fn(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        // rawPath: se envía TAL CUAL (sin normalizar en el cliente) para ver qué hace nginx.
        path: opts.rawPath ?? `${u.pathname}${u.search}`,
        method: opts.method ?? "GET",
        headers: opts.headers,
        rejectUnauthorized: false,
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error(`timeout ${url}`)));
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

function listen(app: express.Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

function must(src: string, from: string, to: string): string {
  if (!src.includes(from)) throw new Error(`conf real: no aparece «${from}» (cambió la conf; revisa el test)`);
  return src.split(from).join(to);
}

/**
 * Conf REAL → conf ejecutable en 127.0.0.1. Sólo hostnames, listen, resolver y
 * pid. `replay-service:8083` se conecta SI aparece (sólo en la conf mutada).
 */
function localConf(file: string, p: { http: number; https?: number; api: number; replay: number }): string {
  let g = readFileSync(join(REPO, "infrastructure/gateway", file), "utf8");
  g = must(g, "listen 80;", `listen 127.0.0.1:${p.http};`);
  if (p.https) g = must(g, "listen 443 ssl;", `listen 127.0.0.1:${p.https} ssl;`);
  g = must(g, "resolver 127.0.0.11 valid=10s ipv6=off;", "# resolver: upstreams por IP");
  g = must(g, "http://api:8080", `http://127.0.0.1:${p.api}`);
  g = g.split("replay-service:8083").join(`127.0.0.1:${p.replay}`);
  // Resto de servicios: no participan; puerto muerto (502 si alguien los pidiera).
  g = g.replace(/\b(web|api|arena-engine|tournament-worker|grafana):(\d+)/g, "127.0.0.1:9");
  return g.replace("events {", "pid /tmp/nginx.pid;\nevents {");
}

let h: TestDbHandle;
let dir: string;
let work: string;
const servers: Server[] = [];
const containers: string[] = [];
let BEHIND = ""; // nginx-behind-proxy.conf → API (capability apagada)
let TLS = ""; // nginx.conf (server 443) → API (capability apagada)
let TLS_HTTP = ""; // nginx.conf (server 80)
let PUBLIC_ON = ""; // nginx-behind-proxy.conf → API (capability ENCENDIDA)
let owner = "";
let stranger = "";
let privBattle = "";
let pubBattle = "";

function startNginx(name: string, conf: string, certs?: string): void {
  const confFile = join(work, `${name}.conf`);
  writeFileSync(confFile, conf);
  chmodSync(confFile, 0o644);
  const args = [
    "run",
    "-d",
    "--name",
    `${TAG}-${name}`,
    "--network",
    "host",
    "-v",
    `${confFile}:/etc/nginx/nginx.conf:ro`,
  ];
  if (certs) args.push("-v", `${certs}:/etc/nginx/tls:ro`);
  args.push(NGINX_IMAGE);
  execFileSync("docker", args, { stdio: "pipe" });
  containers.push(`${TAG}-${name}`);
}

async function waitUp(url: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await req(url)).status === 200) return;
    } catch {
      /* aún no escucha */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const logs = containers.map((c) => {
    try {
      return execFileSync("docker", ["logs", c], { stdio: "pipe" }).toString();
    } catch (e) {
      return String(e);
    }
  });
  throw new Error(`gateway no responde en ${url}\n${logs.join("\n")}`);
}

beforeAll(async () => {
  if (!RUN) return;
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  dir = mkdtempSync(join(tmpdir(), "prcsec-gw-replays-"));
  work = mkdtempSync(join(tmpdir(), "prcsec-gw-work-"));
  chmodSync(work, 0o755);

  // Usuarios: dueño del bot privado (developer), ajeno (user).
  owner = await tokenFor(h.db, DEV_USERS.developer);
  stranger = await tokenFor(h.db, DEV_USERS.user);
  const ownerId = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id;
  const catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
  const bot = async (visibility: string) => {
    const id = randomUUID();
    await h.db("bots").insert({ id, name: `gw-${id.slice(0, 8)}`, owner_id: ownerId, visibility });
    await h.db("bot_loadouts").insert({
      bot_id: id,
      revision: 1,
      catalog_version: catalogVersion,
      chassis: "chassis.scout@1",
      modules: JSON.stringify([]),
    });
    await h
      .db("bot_versions")
      .insert({ bot_id: id, version: 1, state: "published", runtime: "python", loadout_revision: 1 });
    return id;
  };
  const base = await record(
    {
      battleId: "gw-base",
      seed: "gw",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 90 }),
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
  const battle = async (bots: string[]) => {
    const id = randomUUID();
    // Mismo almacén que el worker: el replay-service real lo encontraría por id.
    const stored = ingestReplay(dir, { ...base, header: { ...base.header, battleId: id } }, { official: false });
    await h.db("battles").insert({
      id,
      status: "finished",
      official: false,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "gw-secret-seed",
      replay_ref: stored.path,
      replay_hash: stored.index.sha256,
      final_state_hash: base.result.finalStateHash,
      finished_at: h.db.fn.now(),
    });
    for (const [i, b] of bots.entries()) {
      await h.db("participants").insert({ battle_id: id, bot_id: b, version: 1, team: i ? "B" : "A" });
    }
    return id;
  };
  privBattle = await battle([await bot("private")]);
  pubBattle = await battle([await bot("public"), await bot("public")]);

  const apiApp = (publicReplaysEnabled: boolean) => {
    const root = express();
    root.set("trust proxy", 2);
    root.use(
      createApp({ db: h.db, trustProxyHops: 2, publicReplaysEnabled, anonQuota: { max: 100_000, windowMs: 3600_000 } }),
    );
    return root;
  };
  const apiOff = await listen(apiApp(false));
  const apiOn = await listen(apiApp(true));
  const replay = await listen(createReplayServer({ dir }));
  servers.push(apiOff.server, apiOn.server, replay.server);

  const certs = join(work, "tls");
  execFileSync("mkdir", ["-p", certs]);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      join(certs, "privkey.pem"),
      "-out",
      join(certs, "fullchain.pem"),
    ],
    { stdio: "pipe" },
  );
  chmodSync(certs, 0o755);
  chmodSync(join(certs, "privkey.pem"), 0o644);
  chmodSync(join(certs, "fullchain.pem"), 0o644);

  const [p1, p2, p3, p4] = [await freePort(), await freePort(), await freePort(), await freePort()];
  startNginx("behind", localConf("nginx-behind-proxy.conf", { http: p1, api: apiOff.port, replay: replay.port }));
  startNginx("tls", localConf("nginx.conf", { http: p2, https: p3, api: apiOff.port, replay: replay.port }), certs);
  startNginx("public", localConf("nginx-behind-proxy.conf", { http: p4, api: apiOn.port, replay: replay.port }));
  BEHIND = `http://127.0.0.1:${p1}`;
  TLS_HTTP = `http://127.0.0.1:${p2}`;
  TLS = `https://127.0.0.1:${p3}`;
  PUBLIC_ON = `http://127.0.0.1:${p4}`;
  await waitUp(`${BEHIND}/healthz`);
  await waitUp(`${TLS}/healthz`);
  await waitUp(`${PUBLIC_ON}/healthz`);
}, 240_000);

afterAll(async () => {
  for (const c of containers) {
    try {
      execFileSync("docker", ["rm", "-f", c], { stdio: "pipe" });
    } catch {
      /* ya no existe */
    }
  }
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  await h?.stop();
  for (const d of [dir, work]) if (d) rmSync(d, { recursive: true, force: true });
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Nada del contenido del replay en el cuerpo, y ninguna redirección. */
function expectDenied(r: Resp, what: string, statuses: number[] = [404]): void {
  expect(statuses, `${what} ⇒ ${r.status} ${r.body.slice(0, 200)}`).toContain(r.status);
  expect(r.headers.location, `${what}: sin Location`).toBeUndefined();
  expect(r.body, `${what}: sin contenido del replay`).not.toMatch(
    /keyframes|snapshots|finalStateHash|"items"\s*:\s*\[\s*\{/,
  );
}

describe.skipIf(!RUN)("TD-004 · gateway REAL: el bypass /replays/* está cerrado", () => {
  for (const [label, base] of [
    ["nginx-behind-proxy.conf", () => BEHIND],
    ["nginx.conf (TLS)", () => TLS],
  ] as const) {
    it(`${label} · SEC-4/SEC-8: anónimo por /replays* directo ⇒ 404 en TODO (inventario, archivo, índice, segmento, verify, ingesta)`, async () => {
      const g = base();
      const id = privBattle;
      expectDenied(await req(`${g}/replays`), "GET /replays");
      expectDenied(await req(`${g}/replays/`), "GET /replays/");
      expectDenied(await req(`${g}/replays?limit=500`), "GET /replays?limit");
      expectDenied(await req(`${g}/replays/${id}`), "GET /replays/<id>");
      expectDenied(await req(`${g}/replays/${id}/index`), "GET /replays/<id>/index");
      expectDenied(await req(`${g}/replays/${id}/segment?fromTick=0&toTick=60`), "GET /replays/<id>/segment");
      expectDenied(await req(`${g}/replays/${id}/verify`, { method: "POST" }), "POST /replays/<id>/verify");
      expectDenied(
        await req(`${g}/replays/${id}`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }),
        "POST /replays/<id> (ingesta)",
      );
      // Variantes de ruta que nginx normaliza (sin normalizar en el cliente): tampoco llegan.
      for (const raw of [
        `/api/v1/../../replays/${id}/index`,
        `//replays/${id}/index`,
        `/%72eplays/${id}/index`,
        `/replays/./${id}/index`,
      ]) {
        expectDenied(await req(g, { rawPath: raw }), `GET ${raw}`);
      }
    });

    it(`${label} · SEC-4: anónimo por la API ⇒ metadata/índice/segmento/archivo 404, listado 401`, async () => {
      const g = base();
      const id = privBattle;
      expectDenied(await req(`${g}/api/v1/replays/${id}`), "api archivo");
      expectDenied(await req(`${g}/api/v1/replays/${id}/index`), "api índice");
      expectDenied(await req(`${g}/api/v1/replays/${id}/segment?fromTick=0&toTick=60`), "api segmento");
      expectDenied(await req(`${g}/api/v1/replays/${id}/verify`, { method: "POST" }), "api verify");
      expectDenied(await req(`${g}/api/v1/public/replays/${id}`), "api metadata pública");
      expectDenied(await req(`${g}/api/v1/replays`), "api listado", [401]);
    });

    it(`${label} · SEC-5: el participante lee índice, segmento y archivo por el gateway`, async () => {
      const g = base();
      const id = privBattle;
      const ix = await req(`${g}/api/v1/replays/${id}/index`, { headers: bearer(owner) });
      expect(ix.status).toBe(200);
      expect(JSON.parse(ix.body).battleId).toBe(id);
      expect(ix.headers["cache-control"]).toBe("private, no-store");
      const seg = await req(`${g}/api/v1/replays/${id}/segment?fromTick=0&toTick=60`, { headers: bearer(owner) });
      expect(seg.status).toBe(200);
      expect(JSON.parse(seg.body).snapshots.length).toBeGreaterThan(0);
      const file = await req(`${g}/api/v1/replays/${id}`, { headers: bearer(owner) });
      expect(file.status).toBe(200);
      expect(file.headers["content-type"]).toContain("application/octet-stream");
      const list = await req(`${g}/api/v1/replays`, { headers: bearer(owner) });
      expect(JSON.parse(list.body).items.map((i: { battleId: string }) => i.battleId)).toContain(id);
    });

    it(`${label} · SEC-6: ajeno ⇒ 404 idéntico a «no existe» (sin enumeración por UUID)`, async () => {
      const g = base();
      const strip = (r: Resp) => {
        const b = JSON.parse(r.body);
        return { status: r.status, error: b.error, message: b.message };
      };
      for (const suffix of ["", "/index", "/segment?fromTick=0&toTick=60"]) {
        const denied = await req(`${g}/api/v1/replays/${privBattle}${suffix}`, { headers: bearer(stranger) });
        const missing = await req(`${g}/api/v1/replays/${randomUUID()}${suffix}`, { headers: bearer(stranger) });
        expect(denied.status).toBe(404);
        expect(strip(denied)).toEqual(strip(missing));
      }
      const list = await req(`${g}/api/v1/replays`, { headers: bearer(stranger) });
      expect(JSON.parse(list.body).items.map((i: { battleId: string }) => i.battleId)).not.toContain(privBattle);
    });
  }

  it("SEC-7: capability apagada ⇒ el replay de bots públicos tampoco es anónimo", async () => {
    expectDenied(await req(`${BEHIND}/api/v1/replays/${pubBattle}/index`), "pub index (flag off)");
    expectDenied(await req(`${BEHIND}/api/v1/public/replays/${pubBattle}`), "pub metadata (flag off)");
  });

  it("SEC-7: capability ENCENDIDA ⇒ anónimo lee SÓLO la batalla de bots públicos; la privada sigue en 404", async () => {
    const ok = await req(`${PUBLIC_ON}/api/v1/replays/${pubBattle}/index`);
    expect(ok.status).toBe(200);
    expect((await req(`${PUBLIC_ON}/api/v1/replays/${pubBattle}/segment?fromTick=0&toTick=60`)).status).toBe(200);
    expect((await req(`${PUBLIC_ON}/api/v1/public/replays/${pubBattle}`)).status).toBe(200);
    expectDenied(await req(`${PUBLIC_ON}/api/v1/replays/${privBattle}/index`), "priv index (flag on)");
    expectDenied(await req(`${PUBLIC_ON}/api/v1/public/replays/${privBattle}`), "priv metadata (flag on)");
    const list = JSON.parse((await req(`${PUBLIC_ON}/api/v1/public/replays`)).body);
    const ids = list.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(pubBattle);
    expect(ids).not.toContain(privBattle);
    // Y el bypass sigue cerrado aunque la capability esté encendida.
    expectDenied(await req(`${PUBLIC_ON}/replays/${pubBattle}/index`), "/replays directo (flag on)");
  });

  it("SEC-9 (TD-014): /replays bajo TLS no redirige; el server :80 sólo redirige a https://", async () => {
    for (const p of ["/replays", "/replays/", `/api/v1/replays/${privBattle}/index`]) {
      const r = await req(`${TLS}${p}`);
      expect(r.status >= 300 && r.status < 400, `${p} ⇒ ${r.status}`).toBe(false);
      expect(r.headers.location, p).toBeUndefined();
    }
    const r80 = await req(`${TLS_HTTP}/replays`);
    if (r80.headers.location) expect(String(r80.headers.location)).toMatch(/^https:\/\//);
    const behind = await req(`${BEHIND}/replays`);
    expect(behind.headers.location).toBeUndefined();
  });
});

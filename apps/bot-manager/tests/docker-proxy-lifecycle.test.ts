/**
 * OLA2-MF · el proxy de Docker puede BORRAR y LISTAR, pero sólo lo PROPIO.
 *
 * Antes el proxy podía crear contenedores que nadie podía quitar (create OK +
 * start fallido ⇒ `Created` para siempre; camino /run sin AutoRemove ⇒ `Exited`)
 * y no había forma de encontrar lo que dejaba una batalla. Aquí se fija:
 *  - DELETE sólo con Id completo, sólo `force`, y el servidor sólo lo reenvía
 *    sobre contenedores con las labels de propiedad de ESTA instancia;
 *  - el listado exige `filters.label` con labels `arena.*`, el proxy añade su
 *    propiedad al filtro y la respuesta sólo trae propios y campos mínimos;
 *  - el runner borra el contenedor cuando el start falla, lleva las labels de
 *    batalla en el create y usa nombres únicos (sin 409 en el reintento).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LIMITS,
  LABEL_BATTLE_ID,
  LABEL_ROLE,
  ROLE_BATTLE_BOT,
  battleLabels,
  type SandboxSpec,
} from "../src/container-runner.js";
import {
  DEFAULT_PROXY_INSTANCE,
  LABEL_INSTANCE,
  LABEL_MANAGED,
  ProxyContainerRunner,
  createDockerProxyServer,
  evaluateProxyRequest,
  sanitizeContainerList,
  type DockerBackend,
} from "../src/docker-proxy.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const RUNTIME = readFileSync(join(REPO, "runtimes", "DIGESTS.lock"), "utf8")
  .split("\n")
  .map((l) => l.replace(/#.*$/, "").trim())
  .filter(Boolean)[0]
  .split(/\s+/)[2];
const SECCOMP = join(here, "..", "security", "seccomp-bot.json");
const HEX = (c: string) => c.repeat(64).slice(0, 64);
const OWN = { [LABEL_MANAGED]: "true", [LABEL_INSTANCE]: DEFAULT_PROXY_INSTANCE };

const spec = (battleId = "b-1"): SandboxSpec => ({
  imageDigest: RUNTIME,
  botId: "bot-1",
  version: 1,
  battleId,
  network: "arena",
  engineEndpoint: "ws://arena-engine:8081",
  env: {},
  limits: DEFAULT_LIMITS,
  seccompProfilePath: SECCOMP,
  autoRemove: true,
  labels: battleLabels(battleId, "w1:job:1"),
});

interface FC {
  id: string;
  name: string;
  labels: Record<string, string>;
  state: "created" | "running" | "exited";
}

/** Doble de la Engine con create/start/stop/json/DELETE/list (filtros por label). */
function fakeEngine(opts: { failStart?: boolean } = {}) {
  const cs = new Map<string, FC>();
  const reqs: { method: string; path: string }[] = [];
  let seq = 0;
  const add = (c: Omit<FC, "id">) => {
    const id = (++seq).toString(16).padStart(64, "e");
    cs.set(id, { ...c, id });
    return id;
  };
  const backend: DockerBackend = {
    async dispatch(method, path, body) {
      reqs.push({ method, path });
      const url = new URL(path, "http://x");
      if (method === "POST" && url.pathname === "/containers/create") {
        const b = JSON.parse(body ?? "{}");
        const name = url.searchParams.get("name") ?? "anon";
        if ([...cs.values()].some((c) => c.name === name)) return { status: 409, body: '{"message":"Conflict"}' };
        return { status: 201, body: JSON.stringify({ Id: add({ name, labels: b.Labels ?? {}, state: "created" }) }) };
      }
      if (method === "GET" && url.pathname === "/containers/json") {
        const f = JSON.parse(url.searchParams.get("filters") ?? "{}").label as string[];
        const out = [...cs.values()]
          .filter((c) => f.every((kv) => c.labels[kv.split("=")[0]] === kv.slice(kv.indexOf("=") + 1)))
          .map((c) => ({
            Id: c.id,
            Names: [`/${c.name}`],
            Image: "secret-image",
            Labels: c.labels,
            State: c.state,
            Created: 1000,
            Mounts: [{ Source: "/etc" }],
          }));
        return { status: 200, body: JSON.stringify(out) };
      }
      const del = /^\/containers\/([0-9a-f]{64})$/.exec(url.pathname);
      if (del && method === "DELETE") {
        if (!cs.has(del[1])) return { status: 404, body: "{}" };
        cs.delete(del[1]);
        return { status: 204, body: "" };
      }
      const m = /^\/containers\/([0-9a-f]{64})\/(start|stop|json)$/.exec(url.pathname);
      const c = m ? cs.get(m[1]) : undefined;
      if (!c) return { status: 404, body: "{}" };
      if (m![2] === "start") {
        if (opts.failStart) return { status: 500, body: '{"message":"start roto"}' };
        c.state = "running";
        return { status: 204, body: "" };
      }
      if (m![2] === "stop") {
        c.state = "exited";
        return { status: 204, body: "" };
      }
      return {
        status: 200,
        body: JSON.stringify({ Id: c.id, Config: { Labels: c.labels }, State: { Running: c.state === "running" } }),
      };
    },
  };
  return { backend, cs, reqs, add };
}

async function serve(fake: ReturnType<typeof fakeEngine>) {
  const server = createDockerProxyServer({ backend: fake.backend });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("OLA2-MF · decisión del proxy: DELETE y listado acotados", () => {
  it("DELETE con Id completo (con/sin force) se admite; nombre, prefijo o parámetros extra no", () => {
    expect(evaluateProxyRequest("DELETE", `/containers/${HEX("a")}`, undefined)).toMatchObject({
      ok: true,
      action: { kind: "remove", force: false },
    });
    expect(evaluateProxyRequest("DELETE", `/containers/${HEX("a")}?force=true`, undefined)).toMatchObject({
      ok: true,
      forwardPath: `/containers/${HEX("a")}?force=true`,
    });
    for (const p of [
      "/containers/bot-x",
      `/containers/${HEX("a").slice(0, 12)}`,
      `/containers/${HEX("a")}?v=1`,
      `/containers/${HEX("a")}?force=yes`,
      `/containers/${HEX("a")}?link=1`,
    ])
      expect(evaluateProxyRequest("DELETE", p, undefined).ok, p).toBe(false);
  });

  it("listado: sin filters, con filtros no arena.* o con claves extra → 403", () => {
    for (const p of [
      "/containers/json",
      "/containers/json?all=1",
      `/containers/json?all=1&filters=${encodeURIComponent('{"label":["s9.managed=true"]}')}`,
      `/containers/json?all=1&filters=${encodeURIComponent('{"label":["com.docker.compose.service=postgres"]}')}`,
      `/containers/json?all=1&filters=${encodeURIComponent('{"label":["arena.role=battle-bot"],"name":["x"]}')}`,
      `/containers/json?all=1&size=1&filters=${encodeURIComponent('{"label":["arena.role=battle-bot"]}')}`,
    ])
      expect(evaluateProxyRequest("GET", p, undefined).ok, p).toBe(false);
    expect(evaluateProxyRequest("POST", "/containers/json", undefined).ok).toBe(false);
  });

  it("listado válido: el proxy AÑADE sus labels de propiedad al filtro reenviado", () => {
    const d = evaluateProxyRequest(
      "GET",
      `/containers/json?all=1&filters=${encodeURIComponent('{"label":["arena.role=battle-bot"]}')}`,
      undefined,
    );
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const fwd = new URL(d.forwardPath, "http://x");
    expect(JSON.parse(fwd.searchParams.get("filters")!).label).toEqual([
      `${LABEL_MANAGED}=true`,
      `${LABEL_INSTANCE}=${DEFAULT_PROXY_INSTANCE}`,
      "arena.role=battle-bot",
    ]);
  });

  it("sanitizeContainerList: sólo propios y sólo Id/Labels arena.*/State/Created", () => {
    const out = JSON.parse(
      sanitizeContainerList(
        JSON.stringify([
          {
            Id: HEX("1"),
            Labels: { ...OWN, "arena.battle-id": "b", other: "x" },
            State: "exited",
            Created: 5,
            Image: "i",
            Names: ["/n"],
          },
          { Id: HEX("2"), Labels: { [LABEL_MANAGED]: "true" }, State: "running", Created: 5 },
          { Id: "corto", Labels: OWN, State: "running" },
        ]),
      ),
    );
    expect(out).toEqual([{ Id: HEX("1"), Labels: { "arena.battle-id": "b" }, State: "exited", Created: 5 }]);
  });
});

describe("OLA2-MF · servidor real + Engine simulada", () => {
  const fake = fakeEngine();
  let url = "";
  let server: import("node:http").Server;
  beforeAll(async () => ({ server, url } = await serve(fake)));
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("DELETE de un contenedor AJENO → 403 y sigue existiendo; del PROPIO → 204", async () => {
    const foreign = fake.add({ name: "infrastructure-postgres-1", labels: {}, state: "running" });
    const res = await fetch(`${url}/containers/${foreign}?force=true`, { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(fake.cs.has(foreign)).toBe(true);
    const own = fake.add({ name: "bot-own", labels: { ...OWN }, state: "exited" });
    expect((await fetch(`${url}/containers/${own}?force=true`, { method: "DELETE" })).status).toBe(204);
    expect(fake.cs.has(own)).toBe(false);
  });

  it("el listado nunca devuelve contenedores ajenos aunque lleven labels arena.*", async () => {
    fake.add({ name: "ajeno", labels: { [LABEL_ROLE]: ROLE_BATTLE_BOT, [LABEL_BATTLE_ID]: "b-x" }, state: "running" });
    const mine = fake.add({
      name: "mio",
      labels: { ...OWN, [LABEL_ROLE]: ROLE_BATTLE_BOT, [LABEL_BATTLE_ID]: "b-x" },
      state: "exited",
    });
    const listed = await new ProxyContainerRunner(url).list({
      [LABEL_ROLE]: ROLE_BATTLE_BOT,
      [LABEL_BATTLE_ID]: "b-x",
    });
    expect(listed.map((c) => c.id)).toEqual([mine]);
    expect(listed[0]).toMatchObject({ state: "exited", createdAtMs: 1_000_000 });
    expect(Object.keys(listed[0].labels).every((k) => k.startsWith("arena."))).toBe(true);
  });

  it("launch lleva las labels de batalla y nombres únicos: dos launches de la misma batalla no chocan (409)", async () => {
    const r = new ProxyContainerRunner(url);
    const a = await r.launch(spec("b-same"));
    const b = await r.launch(spec("b-same"));
    expect(a.id).not.toBe(b.id);
    expect(fake.cs.get(a.id)!.labels).toMatchObject({
      ...OWN,
      [LABEL_BATTLE_ID]: "b-same",
      [LABEL_ROLE]: ROLE_BATTLE_BOT,
    });
    await a.remove!();
    await b.remove!();
    expect(fake.cs.has(a.id) || fake.cs.has(b.id)).toBe(false);
    await expect(a.remove!()).resolves.toBeUndefined(); // 404 = ya borrado
  });

  it("stop({timeoutSeconds:0}) pide KILL inmediato (t=0); por defecto t=5", async () => {
    const h = await new ProxyContainerRunner(url).launch(spec("b-kill"));
    await h.stop({ timeoutSeconds: 0 });
    await h.stop();
    const stops = fake.reqs.filter((q) => q.path.startsWith(`/containers/${h.id}/stop`)).map((q) => q.path);
    expect(stops).toEqual([`/containers/${h.id}/stop?t=0`, `/containers/${h.id}/stop?t=5`]);
    await h.remove!();
  });
});

describe("OLA2-MF · start fallido: el contenedor creado se BORRA (antes quedaba `Created` para siempre)", () => {
  const fake = fakeEngine({ failStart: true });
  let url = "";
  let server: import("node:http").Server;
  beforeAll(async () => ({ server, url } = await serve(fake)));
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("launch rechaza y no queda ningún contenedor", async () => {
    await expect(new ProxyContainerRunner(url).launch(spec("b-start"))).rejects.toThrow(/start/);
    expect([...fake.cs.values()]).toEqual([]);
    expect(fake.reqs.some((q) => q.method === "DELETE")).toBe(true);
  });
});

describe("OLA2-MF · AutoRemove: Docker ya está borrando (409 «already in progress») no es un fallo", () => {
  const fake = fakeEngine();
  const inner = fake.backend.dispatch.bind(fake.backend);
  let url = "";
  let server: import("node:http").Server;
  const removing = new Set<string>();
  fake.backend.dispatch = async (method, path, body) => {
    const del = /^\/containers\/([0-9a-f]{64})$/.exec(new URL(path, "http://x").pathname);
    if (method === "DELETE" && del && removing.has(del[1])) {
      return { status: 409, body: `{"message":"removal of container ${del[1]} is already in progress"}` };
    }
    return inner(method, path, body);
  };
  beforeAll(async () => ({ server, url } = await serve(fake)));
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("removeById espera a que el contenedor desaparezca y resuelve", async () => {
    const id = fake.add({ name: "bot-ar", labels: { ...OWN, [LABEL_ROLE]: ROLE_BATTLE_BOT }, state: "running" });
    removing.add(id);
    setTimeout(() => fake.cs.delete(id), 500);
    await new ProxyContainerRunner(url).removeById(id);
    expect(fake.cs.has(id)).toBe(false);
  });
  it("el sondeo del 409 se acota por battleId: sólo espera al contenedor de ESA batalla", async () => {
    const id = fake.add({
      name: "bot-b1",
      labels: { ...OWN, [LABEL_ROLE]: ROLE_BATTLE_BOT, [LABEL_BATTLE_ID]: "B1" },
      state: "running",
    });
    removing.add(id);
    setTimeout(() => fake.cs.delete(id), 400);
    const t0 = Date.now();
    await new ProxyContainerRunner(url).removeById(id, "B1");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350); // con la label correcta lo VE y espera
    // Con otro battleId el contenedor no cae en el listado filtrado: el sondeo no lo ve.
    const id2 = fake.add({
      name: "bot-b2",
      labels: { ...OWN, [LABEL_ROLE]: ROLE_BATTLE_BOT, [LABEL_BATTLE_ID]: "B2" },
      state: "running",
    });
    removing.add(id2);
    const t1 = Date.now();
    await new ProxyContainerRunner(url).removeById(id2, "OTRA");
    expect(Date.now() - t1).toBeLessThan(300);
    fake.cs.delete(id2);
  });
  it("si Docker nunca termina el borrado en curso, falla (no lo da por bueno)", async () => {
    const id = fake.add({ name: "bot-stuck", labels: { ...OWN, [LABEL_ROLE]: ROLE_BATTLE_BOT }, state: "running" });
    removing.add(id);
    const t0 = Date.now();
    await expect(new ProxyContainerRunner(url).removeById(id)).rejects.toThrow(/no terminó/);
    expect(Date.now() - t0).toBeGreaterThan(14_000);
  }, 30_000);
});

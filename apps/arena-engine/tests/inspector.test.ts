/**
 * R13.1 · Inspector HTTP de solo lectura.
 *
 * Comprueba que el inspector sirve exactamente el snapshot público del motor,
 * que no filtra estado privado (seed, RNG, minas, velocidad, energía), que
 * responde con los códigos correctos fuera de sus dos rutas, y que cierra sin
 * dejar handles colgados. También comprueba que el pacing tick a tick (lo que
 * hace `--speed` en la CLI) no altera el determinismo del motor.
 */
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { connect } from "node:net";
import { once } from "node:events";
import { Battle, type BattleConfig } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { mvpArena, gunnerLoadout, scoutLoadout } from "../src/fixtures.js";
import { CircleBot, ForwardBot, HunterBot } from "../src/stubs.js";
import { createInspector, type Inspector } from "../src/inspector.js";

beforeAll(async () => {
  await initPhysics();
});

function makeConfig(seed: string): BattleConfig {
  return {
    battleId: "insp_test",
    seed,
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 600, scoreToWin: 99 }),
    map: mvpArena(),
    participants: [
      { id: "veh_1", botId: "bot_a", team: "red", spec: gunnerLoadout() },
      { id: "veh_2", botId: "bot_b", team: "red", spec: scoutLoadout() },
      { id: "veh_3", botId: "bot_c", team: "blue", spec: gunnerLoadout() },
      { id: "veh_4", botId: "bot_d", team: "blue", spec: scoutLoadout() },
    ],
  };
}

function makeBattle(seed: string): Battle {
  const b = new Battle(makeConfig(seed));
  b.attachBot("veh_1", new HunterBot("bot_a"));
  b.attachBot("veh_2", new CircleBot("bot_b"));
  b.attachBot("veh_3", new HunterBot("bot_c"));
  b.attachBot("veh_4", new ForwardBot("bot_d"));
  return b;
}

async function fetchJson(
  port: number,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}

let openInspectors: Inspector[] = [];

afterEach(async () => {
  await Promise.all(openInspectors.map((i) => i.close()));
  openInspectors = [];
});

describe("inspector HTTP", () => {
  it("bind por defecto es 127.0.0.1 con puerto efímero", async () => {
    const b = makeBattle("seed-insp-1");
    const inspector = await createInspector({ battle: b });
    openInspectors.push(inspector);
    expect(inspector.host).toBe("127.0.0.1");
    expect(inspector.port).toBeGreaterThan(0);
    b.free();
  });

  it("GET /health responde 200 y refleja el tick actual", async () => {
    const b = makeBattle("seed-insp-2");
    const inspector = await createInspector({ battle: b });
    openInspectors.push(inspector);

    const before = await fetchJson(inspector.port, "/health");
    expect(before.status).toBe(200);
    expect(before.body.ok).toBe(true);
    expect(before.body.tick).toBe(0);
    expect(typeof before.body.uptimeMs).toBe("number");

    for (let i = 0; i < 10; i++) b.step();

    const after = await fetchJson(inspector.port, "/health");
    expect(after.body.tick).toBe(10);
    b.free();
  });

  it("GET /snapshot === JSON de battle.getPublicSnapshot()", async () => {
    const b = makeBattle("seed-insp-3");
    for (let i = 0; i < 15; i++) b.step();
    const inspector = await createInspector({ battle: b });
    openInspectors.push(inspector);

    const { status, body } = await fetchJson(inspector.port, "/snapshot");
    expect(status).toBe(200);
    expect(body).toEqual(JSON.parse(JSON.stringify(b.getPublicSnapshot())));
    b.free();
  });

  it("el snapshot servido no filtra estado privado", async () => {
    const b = makeBattle("seed-insp-4");
    for (let i = 0; i < 15; i++) b.step();
    const inspector = await createInspector({ battle: b });
    openInspectors.push(inspector);

    const { body } = await fetchJson(inspector.port, "/snapshot");
    const serialized = JSON.stringify(body);
    for (const forbidden of ["seed", "rng", "mines", "velocity", "energyEU"]) {
      expect(serialized.includes(`"${forbidden}"`), `no debe contener la clave "${forbidden}"`).toBe(false);
    }
    b.free();
  });

  it("404 en ruta desconocida", async () => {
    const b = makeBattle("seed-insp-5");
    const inspector = await createInspector({ battle: b });
    openInspectors.push(inspector);

    const { status, body } = await fetchJson(inspector.port, "/unknown");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "not_found" });
    b.free();
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])("405 con Allow: GET en %s", async (method) => {
    const b = makeBattle("seed-insp-6");
    const inspector = await createInspector({ battle: b });
    openInspectors.push(inspector);

    const { status, headers, body } = await fetchJson(inspector.port, "/snapshot", { method });
    expect(status).toBe(405);
    expect(headers.get("allow")).toBe("GET");
    expect(body).toEqual({ error: "method_not_allowed" });
    b.free();
  });

  it("close() deja el puerto cerrado y no hay handles colgados", async () => {
    const b = makeBattle("seed-insp-7");
    const inspector = await createInspector({ battle: b });
    const port = inspector.port;

    await inspector.close();
    openInspectors = openInspectors.filter((i) => i !== inspector);

    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toBeDefined();
    b.free();
  });
});

/**
 * R13.2 · REGRESSION LOCK — hardening del inspector (rate/tamaño de exposición,
 * no lógica de dominio). Cubre: Cache-Control: no-store en las dos rutas,
 * maxConnections realmente rechazando por encima del límite, timeouts de
 * servidor realmente cortando una conexión ociosa (con connectionsCheckingInterval
 * corto inyectado para no ralentizar la suite — Node lo fija en 30 s por
 * defecto, que anularía en la práctica timeouts de test cortos), y las URLs
 * raras del punto 8 de la auditoría (query string, `..`, dobles barras, encoding).
 */
describe("R13.2 · REGRESSION LOCK — hardening del inspector", () => {
  it("Cache-Control: no-store en /health y /snapshot (snapshots vivos, nunca cacheables)", async () => {
    const b = makeBattle("seed-insp-r132-cache");
    const inspector = await createInspector({ battle: b });
    openInspectors.push(inspector);

    const health = await fetchJson(inspector.port, "/health");
    expect(health.headers.get("cache-control")).toBe("no-store");
    const snapshot = await fetchJson(inspector.port, "/snapshot");
    expect(snapshot.headers.get("cache-control")).toBe("no-store");
    b.free();
  });

  it("maxConnections rechaza conexiones por encima del límite configurado", async () => {
    const b = makeBattle("seed-insp-r132-maxconn");
    const inspector = await createInspector({ battle: b, maxConnections: 1 });
    openInspectors.push(inspector);

    const s1 = connect(inspector.port, "127.0.0.1");
    await once(s1, "connect");
    try {
      const s2 = connect(inspector.port, "127.0.0.1");
      // Node acepta el socket a nivel TCP y lo destruye de inmediato al superar
      // maxConnections: se observa como un cierre casi instantáneo.
      await once(s2, "close");
      expect(s2.destroyed).toBe(true);
    } finally {
      s1.destroy();
    }
    b.free();
  });

  it("una conexión que no envía nada se cierra sola por headersTimeout", async () => {
    const b = makeBattle("seed-insp-r132-timeout");
    // Timeouts cortos + barrido rápido inyectados: Node solo revisa timeouts de
    // cabeceras/petición en cada `connectionsCheckingInterval` (30 s por defecto),
    // así que sin acortarlo el candado tardaría decenas de segundos en disparar.
    const inspector = await createInspector({
      battle: b,
      requestTimeoutMs: 500,
      headersTimeoutMs: 300,
      keepAliveTimeoutMs: 300,
      connectionsCheckingIntervalMs: 100,
    });
    openInspectors.push(inspector);

    const socket = connect(inspector.port, "127.0.0.1");
    await once(socket, "connect");
    // El socket crudo debe quedar en modo "flowing" (resume()) para que el
    // 408 que manda el servidor al expirar el timeout se consuma y el socket
    // pueda cerrarse del todo — si se deja en pausa (sin `data`/`resume()`),
    // Node nunca completa el lado legible y `close` no llega aunque el
    // servidor ya haya respondido y colgado su extremo.
    socket.resume();
    // Deliberadamente no se envía ninguna petición: debe cerrarse sola.
    await once(socket, "close");
    expect(socket.destroyed).toBe(true);
    b.free();
  }, 10_000);

  it("URLs raras: query string sigue sirviendo, .. y %2e%2e normalizan, // y /snapshot/ dan 404", async () => {
    const b = makeBattle("seed-insp-r132-urls");
    const inspector = await createInspector({ battle: b });
    openInspectors.push(inspector);

    const withQuery = await fetchJson(inspector.port, "/health?foo=bar");
    expect(withQuery.status).toBe(200);
    const snapWithQuery = await fetchJson(inspector.port, "/snapshot?x=1");
    expect(snapWithQuery.status).toBe(200);

    // `new URL()` normaliza los segmentos ".." de esquemas especiales (http): esto
    // acaba sirviendo /snapshot, no un 404 ni un escape de ruta.
    const dotDot = await fetchJson(inspector.port, "/health/../snapshot");
    expect(dotDot.status).toBe(200);

    const doubleSlash = await fetchJson(inspector.port, "//snapshot");
    expect(doubleSlash.status).toBe(404);

    const trailingSlash = await fetchJson(inspector.port, "/snapshot/");
    expect(trailingSlash.status).toBe(404);

    // `%2e` es equivalente a "." en la normalización de segmentos de WHATWG URL
    // (case-insensitive, por especificación): "/%2e%2e/snapshot" normaliza igual
    // que "/../snapshot" ⇒ /snapshot. No es una fuga: el inspector no toca el
    // sistema de archivos, solo compara `pathname` contra dos rutas fijas, así
    // que no hay escape posible a ningún otro recurso.
    const encodedDotDot = await fetchJson(inspector.port, "/%2e%2e/snapshot");
    expect(encodedDotDot.status).toBe(200);

    const nothingElse = await fetchJson(inspector.port, "/");
    expect(nothingElse.status).toBe(404);
    b.free();
  });
});

describe("determinismo con pacing tick a tick (lo que hace --speed en la CLI)", () => {
  it("una corrida normal y una paced tick a tick producen el mismo hash final", async () => {
    const normal = makeBattle("seed-insp-paced");
    const normalResult = normal.run(600);
    normal.free();

    const paced = makeBattle("seed-insp-paced");
    while (!paced.isFinished() && paced.tick < 600) {
      paced.step();
      // Simula la cadencia de --speed sin esperar de verdad: cede el bucle de eventos.
      await new Promise((r) => setImmediate(r));
    }
    if (!paced.isFinished()) paced.run(600);
    const pacedResult = paced.getResult()!;
    paced.free();

    expect(pacedResult.finalStateHash).toBe(normalResult.finalStateHash);
    expect(pacedResult.ticks).toBe(normalResult.ticks);
  }, 30_000);
});

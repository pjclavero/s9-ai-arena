/**
 * Release 0.5.0 · PR A · timeouts de batalla y clasificación de errores
 * (DIAG-PROD-TORNEOS, hallazgos F2 y F3). Parte PURA: sin BD, sin contenedores.
 *
 *  - margen PROPORCIONAL del guard (batalla larga dentro del margen);
 *  - `battle_timeout` ≠ `engine_start_failure` (sólo si el motor llegó a jugar);
 *  - clasificación de errores transitorios de BD (Knex/pool/DNS/pg);
 *  - política de reintento por código.
 */
import { readFileSync } from "node:fs";
import { createServer, isIP, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import knex from "knex";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  BATTLE_GUARD_FACTOR,
  CONTAINER_BATTLE_GRACE_MS,
  MAX_CONTAINER_BATTLE_TIMEOUT_MS,
  loadRuleset,
  maxBattleTicks,
  proportionalBattleGuardMs,
} from "../../../packages/game-rules/index.js";
import { classifyEnd } from "./battle-resources.js";
import { battleGuardFailure } from "./container-agents.js";
import {
  InfrastructureFailure,
  classifyDbError,
  classifyFailure,
  dbEndpointFromEnv,
  isTransientDbError,
  retryPolicyFor,
  toInfrastructureFailure,
} from "./errors.js";

describe("F2 · el guard es PROPORCIONAL a las reglas reales del modo", () => {
  // Peor caso MEDIDO en producción: 9000 ticks de TDM en 323 s (ratio 1,06 sobre 306 s).
  const MEDIDO_PEOR_MS = 323_000;

  it("una batalla larga de 9000 ticks que tarda lo medido (315-323 s) cabe con holgura", () => {
    const guard = proportionalBattleGuardMs(9000, 34);
    expect(guard).toBe(Math.ceil(9000 * 34 * BATTLE_GUARD_FACTOR) + CONTAINER_BATTLE_GRACE_MS); // 397 500
    expect(guard - MEDIDO_PEOR_MS).toBeGreaterThan(60_000); // antes: -2 s (321 000 vs 323 000)
  });

  it("el margen ESCALA con la duración: más ticks, más holgura absoluta (un margen fijo no)", () => {
    const margen = (t: number) => proportionalBattleGuardMs(t, 34) - t * 34;
    expect(margen(18_000)).toBeGreaterThan(margen(9000));
    expect(margen(9000)).toBeGreaterThan(margen(3000));
    expect(margen(9000)).toBe(Math.ceil(9000 * 34 * 0.25) + CONTAINER_BATTLE_GRACE_MS);
  });

  it("se calcula con `maxBattleTicks` del ruleset real, no con una constante", () => {
    const corto = loadRuleset("dm_practice@1", { timeLimitTicks: 600 });
    const largo = loadRuleset("dm_practice@1", { timeLimitTicks: 4500 });
    const g = (r: typeof corto) => proportionalBattleGuardMs(maxBattleTicks(r), 34);
    expect(g(corto)).toBeLessThan(g(largo));
    expect(g(corto)).toBe(Math.ceil(maxBattleTicks(corto) * 34 * BATTLE_GUARD_FACTOR) + CONTAINER_BATTLE_GRACE_MS);
  });

  it("nunca baja del teórico + arranque (factor < 1 o inválido se ignora) y respeta el techo de setTimeout", () => {
    expect(proportionalBattleGuardMs(1000, 34, 15_000, 0.1)).toBe(1000 * 34 + 15_000);
    expect(proportionalBattleGuardMs(1000, 34, 15_000, Number.NaN)).toBe(1000 * 34 + 15_000);
    const silencio = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(proportionalBattleGuardMs(1_000_000, 3000)).toBe(MAX_CONTAINER_BATTLE_TIMEOUT_MS);
    silencio.mockRestore();
  });
});

describe("F2 · un timeout real NO es un fallo de arranque", () => {
  it("el motor jugó (tick > 0) → battle_timeout, y se cierra como TIMEOUT", () => {
    const err = battleGuardFailure(397_500, 8_800, 9000);
    expect(err).toBeInstanceOf(InfrastructureFailure);
    expect(err.code).toBe("battle_timeout");
    expect(err.message).toMatch(/timeout global/);
    expect(classifyEnd({ ok: false, error: err })).toBe("TIMEOUT");
    expect(classifyFailure(err.code)).toBe("infrastructure");
  });

  it("el motor no llegó a ningún tick → engine_start_failure (lo que el nombre dice)", () => {
    const err = battleGuardFailure(397_500, 0, 9000);
    expect(err.code).toBe("engine_start_failure");
    expect(classifyEnd({ ok: false, error: err })).toBe("ENGINE_ERROR");
  });
});

// ─── Formas REALES de error (P2-7) ───────────────────────────────────────────────────────────
// Los fixtures NO están escritos a mano: los genera `scripts/capture-pg-errors.mjs` con pg y knex
// reales (Node 22) contra un puerto cerrado, `localhost` dual-stack, un backend terminado, un
// servidor Postgres muerto, un RST sobre una conexión abierta y un DSN POR NOMBRE que resuelve a
// una IP (red de Docker). Aquí se rehidratan con su pila (sólo las rutas de pg/knex/tarn/node).
interface Forma {
  ctor?: string;
  name?: string;
  code?: string;
  errno?: number;
  syscall?: string;
  address?: string;
  port?: number;
  hostname?: string;
  message?: string;
  stackFrames?: string[];
  cause?: Forma;
  errors?: Forma[];
  ok?: boolean;
}
const REAL = JSON.parse(
  readFileSync(fileURLToPath(new URL("./testing/fixtures/real-db-errors.json", import.meta.url)), "utf8"),
) as Record<string, Record<string, Forma | undefined>>;

function rehidratar(f: Forma): Error {
  const mensaje = f.message ?? "";
  const e: Error & Record<string, unknown> =
    f.ctor === "AggregateError"
      ? (new AggregateError((f.errors ?? []).map(rehidratar), mensaje) as never)
      : (new Error(mensaje, f.cause ? { cause: rehidratar(f.cause) } : undefined) as never);
  if (f.name) e.name = f.name;
  for (const k of ["code", "errno", "syscall", "address", "port", "hostname"] as const) {
    if (f[k] !== undefined) e[k] = f[k];
  }
  e.stack = `${e.name}: ${mensaje}\n${(f.stackFrames ?? []).map((l) => `    at ${l}`).join("\n")}`;
  return e;
}
const real = (caso: string, via: string): Error => {
  const f = REAL[caso]?.[via];
  if (!f || f.ok) throw new Error(`fixture real ausente o sin error: ${caso}.${via}`);
  return rehidratar(f);
};
const puertoDe = (caso: string, via: string): number => {
  const f = REAL[caso][via] as Forma;
  return (f.port ?? f.errors?.[0]?.port) as number;
};

describe("P1-1/P2-7 · errores REALES de pg/knex (capturados), decididos por ORIGEN", () => {
  // Producción: `PGHOST=postgres` (un NOMBRE) y puerto 5432. Node deja en `address` la IP resuelta.
  const PROD = { host: "postgres", port: 5432 };

  it("ningún fixture lleva un NOMBRE en `address` (Node nunca lo produce: siempre es una IP)", () => {
    const dump = JSON.stringify(REAL);
    expect(dump).not.toMatch(/"address":\s*"postgres"/i);
    // toda `address` es una IP literal (v4 o v6), nunca un nombre
    const direcciones = [...dump.matchAll(/"address":\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(direcciones.length).toBeGreaterThan(0);
    for (const a of direcciones) expect(isIP(a), `address no es una IP: ${a}`).not.toBe(0);
  });

  it("DSN por NOMBRE → IP: ECONNREFUSED real (pg y knex) hacia el puerto de la BD es db_unavailable", () => {
    for (const via of ["pg", "knex"]) {
      const err = real("nombre_sin_escucha", via);
      expect((err as { address?: string }).address).toMatch(/^\d+\.\d+\.\d+\.\d+$/); // IP, no «postgres»
      expect(isTransientDbError(err, PROD)).toBe(true);
      expect(toInfrastructureFailure(err, "engine_start_failure", PROD).code).toBe("db_unavailable");
    }
  });

  it("el MISMO error real hacia OTRO puerto (docker-proxy 2375, Redis 6379, bot 9001) NO es la BD", () => {
    const err = real("nombre_sin_escucha", "pg");
    for (const puerto of [2375, 6379, 9001]) {
      expect(isTransientDbError(err, { host: "postgres", port: puerto })).toBe(false);
    }
    // y con la BD en otro puerto, el 5432 del error tampoco vale
    expect(isTransientDbError(err, { host: "postgres", port: 5433 })).toBe(false);
  });

  it("puerto IPv4 cerrado real (DSN por IP literal): se reconoce con la IP y el puerto exactos", () => {
    const err = real("ipv4_cerrado", "pg");
    const port = puertoDe("ipv4_cerrado", "pg");
    expect(isTransientDbError(err, { host: "127.0.0.1", port })).toBe(true);
    expect(isTransientDbError(real("ipv4_cerrado", "knex"), { host: "127.0.0.1", port })).toBe(true);
    // con DSN por IP literal, otra IP en `address` NO es la BD aunque el puerto coincida
    expect(isTransientDbError(err, { host: "10.0.0.9", port })).toBe(false);
  });

  it("`localhost` dual-stack: AggregateError (sin address/port/cause/pila de pg) → se recorre `.errors[]`", () => {
    for (const via of ["pg", "knex"]) {
      const err = real("localhost_dualstack", via) as AggregateError & { address?: unknown; port?: unknown };
      expect(err).toBeInstanceOf(AggregateError);
      expect(err.address).toBeUndefined();
      expect(err.port).toBeUndefined();
      expect(err.cause).toBeUndefined();
      expect(err.errors.length).toBeGreaterThanOrEqual(2);
      const port = puertoDe("localhost_dualstack", via);
      expect(isTransientDbError(err, { host: "localhost", port })).toBe(true);
      expect(isTransientDbError(err, { host: "localhost", port: 2375 })).toBe(false); // otro puerto
    }
  });

  it("`read ECONNRESET` de un socket YA ABIERTO (RST) con una consulta de pg en vuelo: sin dirección, pila de pg", () => {
    const err = real("reset_en_vuelo", "pg") as Error & { code?: string; address?: unknown; port?: unknown };
    expect(err.message).toBe("read ECONNRESET");
    expect(err.code).toBe("ECONNRESET");
    expect(err.address).toBeUndefined();
    expect(err.port).toBeUndefined();
    expect(isTransientDbError(err, PROD)).toBe(true);
  });

  it("`read ECONNRESET` vía knex: sin dirección ni pila de pg; el SQL antepuesto lo delata", () => {
    const err = real("reset_en_vuelo_knex", "knex") as Error & { address?: unknown };
    expect(err.message).toMatch(/^select pg_sleep\(30\) - read ECONNRESET$/);
    expect(err.address).toBeUndefined();
    expect(String(err.stack)).not.toMatch(/node_modules/); // sólo node:internal: no hay otra evidencia
    expect(isTransientDbError(err, PROD)).toBe(true);
  });

  it("un `read ECONNRESET` SIN evidencia de BD (socket de otro servicio) NO es db_unavailable", () => {
    // el mismo error real, pero de un socket que no es el de la BD: el mensaje no lleva SQL
    const ajeno = rehidratar({ ...(REAL.reset_en_vuelo_knex.knex as Forma), message: "read ECONNRESET" });
    expect(isTransientDbError(ajeno, PROD)).toBe(false);
    const ocioso = real("reset_ocioso", "evento_error_del_cliente"); // sin pila de pg
    expect(isTransientDbError(ocioso, PROD)).toBe(false); // llega al `on('error')` del pool, no al trabajo
  });

  it("reset durante la conexión (RST al conectar): address+puerto de la BD", () => {
    const err = real("reset_durante_conexion", "pg");
    const port = puertoDe("reset_durante_conexion", "pg");
    expect(isTransientDbError(err, { host: "127.0.0.1", port })).toBe(true);
    expect(isTransientDbError(err, { host: "127.0.0.1", port: 6379 })).toBe(false);
  });

  it.each([
    ["backend terminado con consulta en vuelo (57P01)", "backend_terminado_en_vuelo", "pg"],
    ["backend terminado con el cliente ocioso (57P01)", "backend_terminado_ocioso", "pg"],
    ["consulta sobre un cliente ya muerto", "consulta_sobre_cliente_muerto", "pg"],
    ["servidor muerto con una consulta en vuelo", "servidor_muerto_en_vuelo", "pg"],
    ["servidor muerto: evento de error del cliente", "servidor_muerto_en_vuelo", "evento_error_del_cliente"],
    ["DSN por nombre: pg `timeout expired` (el nombre dejó de resolver)", "nombre_no_resuelve", "pg"],
    ["DSN por nombre: KnexTimeoutError", "nombre_no_resuelve", "knex"],
    ["DSN por nombre: knex tras matar el servidor", "nombre_servidor_matado_en_vuelo", "knex_tras_muerte"],
    ["DSN por nombre: pg tras matar el servidor", "nombre_servidor_matado_en_vuelo", "reconexion_pg"],
  ])("%s → db_unavailable", (_n, caso, via) => {
    const err = real(caso, via);
    expect(isTransientDbError(err, PROD)).toBe(true);
    expect(classifyDbError(err, PROD)).toBe("db_unavailable");
  });

  it("ENOTFOUND real (el nombre del DSN no resuelve): sólo si el `hostname` es el de la BD", () => {
    const err = real("dns_no_resuelve", "pg");
    expect(isTransientDbError(err, { host: "no-existe.invalid", port: 5432 })).toBe(true);
    expect(isTransientDbError(err, { host: "postgres", port: 5432 })).toBe(false); // era otro nombre
  });

  it("`timeout expired` de pg SIN pila de pg (otro origen) NO es db_unavailable", () => {
    const f = REAL.nombre_no_resuelve.pg as Forma;
    const ajeno = rehidratar({ ...f, stackFrames: ["Timeout._onTimeout (node:internal/timers)"] });
    expect(isTransientDbError(ajeno, PROD)).toBe(false);
  });

  it("57014 REAL (statement_timeout): NO es db_unavailable; tiene su propia clase `db_query_timeout`", () => {
    const err = real("statement_timeout", "pg");
    expect((err as { code?: string }).code).toBe("57014");
    expect(classifyDbError(err, PROD)).toBe("db_query_timeout");
    expect(isTransientDbError(err, PROD)).toBe(true);
    expect(toInfrastructureFailure(err, "engine_start_failure").code).toBe("db_query_timeout");
    // si va envuelto junto a una caída real, manda la caída
    const mixto = new AggregateError([err, real("nombre_sin_escucha", "pg")], "");
    expect(classifyDbError(mixto, PROD)).toBe("db_unavailable");
  });

  it("AggregateError sin ningún origen de BD (docker-proxy dual-stack) NO se atribuye a la BD", () => {
    const sub = (address: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}:2375`), {
        code: "ECONNREFUSED",
        address,
        port: 2375,
        syscall: "connect",
      });
    const agg = Object.assign(new AggregateError([sub("::1"), sub("127.0.0.1")], ""), { code: "ECONNREFUSED" });
    expect(isTransientDbError(agg, { host: "localhost", port: 5432 })).toBe(false);
  });
});

describe("P1-1 · EN VIVO: pg y knex reales contra un puerto cerrado", () => {
  const puertoLibre = async (): Promise<number> => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const { port } = srv.address() as AddressInfo;
    await new Promise<void>((r) => srv.close(() => r()));
    return port;
  };
  const conectar = async (host: string, port: number): Promise<unknown> => {
    const c = new pg.Client({ host, port, user: "x", password: "x", database: "x", connectionTimeoutMillis: 3000 });
    try {
      await c.connect();
    } catch (e) {
      return e;
    }
    await c.end();
    throw new Error("se esperaba un fallo de conexión");
  };

  it("pg → 127.0.0.1 cerrado: ECONNREFUSED con IP+puerto, y la pila NO pasa por pg", async () => {
    const port = await puertoLibre();
    const err = (await conectar("127.0.0.1", port)) as Error & { code?: string };
    expect(err.code).toBe("ECONNREFUSED");
    expect(String(err.stack)).not.toMatch(/node_modules[\\/](pg|knex|tarn)/);
    expect(isTransientDbError(err, { host: "127.0.0.1", port })).toBe(true);
    expect(isTransientDbError(err, { host: "127.0.0.1", port: port + 1 })).toBe(false);
  });

  it("pg → localhost cerrado (dual-stack): se reconoce con el endpoint `localhost`", async () => {
    const port = await puertoLibre();
    const err = (await conectar("localhost", port)) as Error & { code?: string };
    expect(err.code).toBe("ECONNREFUSED");
    expect(isTransientDbError(err, { host: "localhost", port })).toBe(true);
    expect(isTransientDbError(err, { host: "localhost", port: port + 1 })).toBe(false);
  });

  it("knex → puerto cerrado: mismo criterio", async () => {
    const port = await puertoLibre();
    const k = knex({
      client: "pg",
      connection: { host: "127.0.0.1", port, user: "x", password: "x", database: "x" },
      pool: { min: 0, max: 1 },
      acquireConnectionTimeout: 3000,
    });
    let err: unknown;
    try {
      await k.raw("select 1");
    } catch (e) {
      err = e;
    } finally {
      await k.destroy();
    }
    expect(err).toBeDefined();
    expect(isTransientDbError(err, { host: "127.0.0.1", port })).toBe(true);
  });
});

describe("F3 · errores transitorios de BD (decididos por ORIGEN)", () => {
  const DB = { host: "postgres", port: 5432 };
  const knexTimeout = Object.assign(new Error("Knex: Timeout acquiring a connection. The pool is probably full."), {
    name: "KnexTimeoutError",
  });
  const net = (code: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`${code} (red)`), { code, ...extra });

  it.each([
    ["KnexTimeoutError por nombre", knexTimeout],
    ["pool: mensaje de tarn", new Error("Acquire connection error: operation timed out for an unknown reason")],
    ["EAI_AGAIN resolviendo el nombre de la BD", net("EAI_AGAIN", { hostname: "postgres" })],
    ["ENOTFOUND resolviendo el nombre de la BD", net("ENOTFOUND", { hostname: "postgres" })],
    [
      "ECONNRESET sin dirección pero con pila de pg",
      Object.assign(net("ECONNRESET"), {
        stack:
          "Error: read ECONNRESET\n at Client._handleErrorWhileConnecting (/app/node_modules/pg/lib/client.js:318:19)",
      }),
    ],
    [
      "EPIPE con pila de knex",
      Object.assign(net("EPIPE"), { stack: "Error: write EPIPE\n at /app/node_modules/knex/lib/client.js:1:1" }),
    ],
    ["57P01 admin_shutdown", net("57P01")],
    ["57P03 cannot_connect_now", net("57P03")],
    ["53300 too_many_connections", net("53300")],
    ["terminating connection sin código", new Error("terminating connection due to administrator command")],
    ["en `cause` (con origen de BD)", new Error("query failed", { cause: net("EAI_AGAIN", { hostname: "postgres" }) })],
  ])("%s → transitorio", (_n, err) => {
    expect(isTransientDbError(err, DB)).toBe(true);
  });

  // P2-2: los mismos códigos de red, con OTRO origen, NO son `db_unavailable`.
  it.each([
    ["docker-proxy ECONNREFUSED", net("ECONNREFUSED", { address: "172.20.0.3", port: 2375 })],
    ["docker-proxy ETIMEDOUT", net("ETIMEDOUT", { address: "10.9.0.5", port: 2375 })],
    ["WebSocket del bot ECONNREFUSED", net("ECONNREFUSED", { address: "172.20.0.7", port: 9001 })],
    ["WebSocket del bot ECONNRESET sin dirección", net("ECONNRESET")],
    ["Redis ECONNREFUSED", net("ECONNREFUSED", { address: "172.20.0.4", port: 6379 })],
    ["Redis EAI_AGAIN", net("EAI_AGAIN", { hostname: "redis" })],
    ["EPIPE de un stream cualquiera", net("EPIPE", { syscall: "write" })],
    ["mismo host (IP), otro puerto (no es la BD)", net("ECONNREFUSED", { address: "172.20.0.2", port: 6379 })],
    ["un nombre ajeno en `address` con el puerto de la BD", net("ECONNREFUSED", { address: "redis", port: 5432 })],
    [
      "en `cause` de un error de otro origen",
      new Error("docker", { cause: net("ECONNREFUSED", { address: "172.20.0.3", port: 2375 }) }),
    ],
  ])("%s → NO es db_unavailable", (_n, err) => {
    expect(isTransientDbError(err, DB)).toBe(false);
  });

  it.each([
    ["bug del worker", new TypeError("Cannot read properties of undefined")],
    ["violación de unicidad (23505)", net("23505")],
    ["sintaxis SQL (42601)", net("42601")],
    ["no es un error", "texto"],
    ["null", null],
  ])("%s → NO es transitorio", (_n, err) => {
    expect(isTransientDbError(err, DB)).toBe(false);
  });

  it("`cause` cíclica o muy profunda: sin recursión infinita y con tope de profundidad", () => {
    const ciclo = new Error("a") as Error & { cause?: unknown };
    ciclo.cause = ciclo;
    expect(isTransientDbError(ciclo, DB)).toBe(false);
    const hondo = new Error("n0", {
      cause: new Error("n1", {
        cause: new Error("n2", { cause: new Error("n3", { cause: new Error("n4", { cause: knexTimeout }) }) }),
      }),
    });
    expect(isTransientDbError(hondo, DB)).toBe(false); // más allá de la profundidad 3 no se mira
    const cerca = new Error("n0", { cause: new Error("n1", { cause: knexTimeout }) });
    expect(isTransientDbError(cerca, DB)).toBe(true);
    const agg = new AggregateError([new AggregateError([new AggregateError([knexTimeout], "")], "")], "");
    expect(isTransientDbError(agg, DB)).toBe(true); // AggregateError anidados dentro del tope
  });

  it("AggregateError enorme: tope de nodos visitados (no recorre un grafo sin límite)", () => {
    const muchos = new AggregateError([...Array.from({ length: 200 }, () => new Error("ruido")), knexTimeout], "");
    expect(isTransientDbError(muchos, DB)).toBe(false); // el transitorio queda más allá del tope de nodos
  });

  // P2-12/P2-13: EHOSTUNREACH y ENETUNREACH están CAPTURADOS EN VIVO con pg y knex (Node 22, ver
  // `scripts/capture-pg-errors.mjs`): IP sin asignar dentro de la subred de una red Docker propia
  // (EHOSTUNREACH, falla el ARP) y contenedor `--network none` hacia una IP sin ruta (ENETUNREACH, IPv4 e
  // IPv6). ECONNABORTED NO se puede provocar de forma segura en `connect` (es un aborto del lado local de
  // una conexión ya aceptada), así que sigue siendo un fixture CONSTRUIDO con la forma documentada de Node.
  const nodeNet = (code: string, errno: number, syscall: string, address?: string, port?: number) =>
    Object.assign(new Error(address ? `${syscall} ${code} ${address}:${port}` : `${syscall} ${code}`), {
      errno,
      code,
      syscall,
      ...(address ? { address, port } : {}),
    });
  const REALES_SIN_RUTA = [
    ["EHOSTUNREACH", "ip_sin_asignar", -113],
    ["ENETUNREACH", "red_sin_ruta_ipv4", -101],
    ["ENETUNREACH", "red_sin_ruta_ipv6", -101],
  ] as const;

  it.each(REALES_SIN_RUTA)(
    "P2-13 · %s REAL (%s): forma capturada (connect, IP literal, puerto, pila sólo node:net)",
    (codigo, caso, errno) => {
      for (const via of ["pg", "knex"]) {
        const e = real(caso, via) as Error & Record<string, unknown>;
        expect(e.code).toBe(codigo);
        expect(e.errno).toBe(errno);
        expect(e.syscall).toBe("connect");
        expect(isIP(String(e.address))).not.toBe(0);
        expect(e.port).toBe(5432);
        expect(String(e.stack)).not.toMatch(/node_modules\/(pg|knex|tarn)/); // no pasa por pg/knex: sólo cuenta el origen
      }
    },
  );

  it.each(REALES_SIN_RUTA)(
    "P2-12 · %s hacia el puerto de la BD (REAL, %s) → db_unavailable (pg y knex)",
    (_c, caso) => {
      for (const via of ["pg", "knex"]) {
        const e = real(caso, via);
        expect(classifyDbError(e, { host: "postgres", port: 5432 })).toBe("db_unavailable"); // DSN por nombre
        expect(classifyDbError(e, { host: (e as { address?: string }).address, port: 5432 })).toBe("db_unavailable"); // DSN por IP
      }
    },
  );

  it.each(REALES_SIN_RUTA)(
    "P2-12 · %s REAL (%s) hacia OTRO puerto (docker-proxy/Redis) → NO es db_unavailable",
    (_c, caso) => {
      for (const via of ["pg", "knex"]) {
        const e = real(caso, via);
        for (const puerto of [2375, 6379, 9001]) {
          expect(classifyDbError(e, { host: "postgres", port: puerto })).toBeUndefined();
        }
      }
    },
  );

  it("P2-12 · ECONNABORTED hacia el puerto de la BD (CONSTRUIDO: no capturable de forma segura) → db_unavailable", () => {
    expect(classifyDbError(nodeNet("ECONNABORTED", -103, "connect", "172.19.0.2", 5432), DB)).toBe("db_unavailable");
  });

  it.each([
    ["EHOSTUNREACH", nodeNet("EHOSTUNREACH", -113, "connect", "172.20.0.3", 2375)],
    ["ENETUNREACH", nodeNet("ENETUNREACH", -101, "connect", "172.20.0.4", 6379)],
    ["ECONNABORTED", nodeNet("ECONNABORTED", -103, "read")],
  ])("P2-12 · %s de otro origen (docker-proxy/Redis/sin evidencia) → NO es db_unavailable", (_c, err) => {
    expect(classifyDbError(err, DB)).toBeUndefined();
  });

  it("P2-12 · ECONNABORTED sin dirección: sólo con pila de pg (en vuelo) → db_unavailable", () => {
    const e = nodeNet("ECONNABORTED", -103, "read");
    e.stack =
      "Error: read ECONNABORTED\n    at Client._handleErrorWhileConnecting (/app/node_modules/pg/lib/client.js:318:19)";
    expect(classifyDbError(e, DB)).toBe("db_unavailable");
  });

  // P2-11: FIJA el límite conocido. NO es un comportamiento deseable, es el que la forma del error impone:
  // el mismo error contra el puerto de la BD, con la IP de OTRO servicio, se atribuye a la BD.
  it("P2-11 · límite conocido: servicio AJENO en el puerto de la BD, DSN por nombre → se atribuye a la BD", () => {
    const ajeno = nodeNet("ECONNREFUSED", -111, "connect", "172.20.0.99", 5432);
    expect(classifyDbError(ajeno, DB)).toBe("db_unavailable"); // falso positivo ACEPTADO (acotado, ver errors.ts)
    // acotado: es db_unavailable con tope de 8 fallos y backoff acotado, nunca un reintento infinito
    expect(retryPolicyFor("db_unavailable").maxFailures).toBe(8);
    expect(retryPolicyFor("db_unavailable").backoffMs(50)).toBe(120_000);
    // con el DSN por IP literal el límite NO existe: otra IP no se atribuye
    expect(classifyDbError(ajeno, { host: "172.19.0.2", port: 5432 })).toBeUndefined();
  });

  it("sin endpoint conocido, un código de red SIN más evidencia no se atribuye a la BD", () => {
    expect(isTransientDbError(net("ECONNREFUSED", { address: "172.20.0.2", port: 5432 }), {})).toBe(false);
    expect(isTransientDbError(knexTimeout, {})).toBe(true);
  });

  it("el endpoint se toma de DATABASE_URL o de PGHOST/PGPORT", () => {
    expect(dbEndpointFromEnv({ DATABASE_URL: "postgres://u:p@db.interno:6543/arena" })).toEqual({
      host: "db.interno",
      port: 6543,
    });
    expect(dbEndpointFromEnv({ PGHOST: "pg", PGPORT: "5433" })).toEqual({ host: "pg", port: 5433 });
    expect(dbEndpointFromEnv({})).toEqual({});
  });

  it("toInfrastructureFailure: respeta lo clasificado, mapea BD transitoria y cae a `fallback`", () => {
    const ya = new InfrastructureFailure("map_unavailable", "x");
    expect(toInfrastructureFailure(ya, "engine_start_failure")).toBe(ya);
    expect(toInfrastructureFailure(knexTimeout, "engine_start_failure").code).toBe("db_unavailable");
    // un fallo de red del docker-proxy NO se etiqueta db_unavailable: conserva el fallback
    const docker = net("ECONNREFUSED", { address: "172.20.0.3", port: 2375 });
    expect(toInfrastructureFailure(docker, "engine_start_failure").code).toBe("engine_start_failure");
    expect(toInfrastructureFailure(new Error("motor"), "engine_start_failure").code).toBe("engine_start_failure");
  });
});

describe("política de reintento por código", () => {
  it("battle_timeout: un solo reintento (por clase) con pausa larga; el resto conserva lo de siempre", () => {
    expect(retryPolicyFor("battle_timeout").maxFailures).toBe(2);
    expect(retryPolicyFor("battle_timeout").backoffMs(1)).toBeGreaterThanOrEqual(60_000);
    expect(retryPolicyFor("engine_start_failure").maxFailures).toBeUndefined();
    expect(retryPolicyFor("engine_start_failure").backoffMs(1)).toBe(2000);
    expect(retryPolicyFor("engine_start_failure").backoffMs(20)).toBe(60_000);
  });

  it("db_unavailable: tope PROPIO y tolerancia total de 5 a 10 minutos, backoff creciente y acotado", () => {
    const db = retryPolicyFor("db_unavailable");
    expect(db.backoffMs(2)).toBeGreaterThan(db.backoffMs(1));
    expect(db.backoffMs(50)).toBe(120_000);
    expect(db.overridesJobMax).toBe(true);
    expect(db.maxFailures).toBeGreaterThan(3); // más que el max_attempts por defecto del trabajo
    // esperas efectivas: tras cada fallo salvo el último (que va a revisión)
    let total = 0;
    for (let n = 1; n < (db.maxFailures as number); n++) total += db.backoffMs(n);
    expect(total).toBeGreaterThanOrEqual(5 * 60_000);
    expect(total).toBeLessThanOrEqual(10 * 60_000);
  });

  it("db_query_timeout (57014): tope CORTO de 2 fallos, un reintento tras ~30 s; no hereda la ventana de 8,5 min", () => {
    const q = retryPolicyFor("db_query_timeout");
    expect(q.maxFailures).toBe(2);
    expect(q.backoffMs(1)).toBe(30_000);
    expect(classifyFailure("db_query_timeout")).toBe("infrastructure");
  });
});

describe("classifyEnd decide por CÓDIGO, nunca por el texto del mensaje", () => {
  it("battle_timeout con un mensaje SIN «timeout global» → TIMEOUT (rama por código)", () => {
    const err = new InfrastructureFailure("battle_timeout", "la batalla se pasó de reloj");
    expect(classifyEnd({ ok: false, error: err })).toBe("TIMEOUT");
  });
  it("engine_start_failure → ENGINE_ERROR aunque el mensaje diga «timeout global»", () => {
    const err = new InfrastructureFailure("engine_start_failure", "timeout global de la batalla tras 9 ms");
    expect(classifyEnd({ ok: false, error: err })).toBe("ENGINE_ERROR");
  });
  it("un código ajeno con «timeout global» en el texto NO es TIMEOUT", () => {
    const err = new InfrastructureFailure("map_unavailable", "timeout global descargando el mapa");
    expect(classifyEnd({ ok: false, error: err })).toBe("FAILED");
  });
});

describe("P2-5 · el recorte del guard al techo de setTimeout NO es silencioso", () => {
  it("avisa por consola al acotar y no avisa cuando cabe", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(proportionalBattleGuardMs(9000, 34)).toBeLessThan(MAX_CONTAINER_BATTLE_TIMEOUT_MS);
      expect(spy).not.toHaveBeenCalled();
      expect(proportionalBattleGuardMs(1_000_000, 3000)).toBe(MAX_CONTAINER_BATTLE_TIMEOUT_MS);
      expect(spy).toHaveBeenCalledTimes(1);
      const log = JSON.parse(String(spy.mock.calls[0][0]));
      expect(log.level).toBe("warn");
      expect(log.appliedTimeoutMs).toBe(MAX_CONTAINER_BATTLE_TIMEOUT_MS);
      expect(log.requestedTimeoutMs).toBeGreaterThan(MAX_CONTAINER_BATTLE_TIMEOUT_MS);
      expect(log.ticks).toBe(1_000_000);
    } finally {
      spy.mockRestore();
    }
  });
});

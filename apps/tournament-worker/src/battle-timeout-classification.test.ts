/**
 * Release 0.5.0 · PR A · timeouts de batalla y clasificación de errores
 * (DIAG-PROD-TORNEOS, hallazgos F2 y F3). Parte PURA: sin BD, sin contenedores.
 *
 *  - margen PROPORCIONAL del guard (batalla larga dentro del margen);
 *  - `battle_timeout` ≠ `engine_start_failure` (sólo si el motor llegó a jugar);
 *  - clasificación de errores transitorios de BD (Knex/pool/DNS/pg);
 *  - política de reintento por código.
 */
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
    ["ECONNREFUSED hacia el endpoint de la BD", net("ECONNREFUSED", { address: "postgres", port: 5432 })],
    ["ECONNREFUSED por IP y puerto de la BD", net("ECONNREFUSED", { address: "postgres", port: "5432" })],
    ["ETIMEDOUT hacia la BD", net("ETIMEDOUT", { address: "POSTGRES", port: 5432 })],
    ["EAI_AGAIN resolviendo el nombre de la BD", net("EAI_AGAIN", { hostname: "postgres" })],
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
    ["57014 query_canceled", net("57014")],
    ["terminating connection sin código", new Error("terminating connection due to administrator command")],
    ["en `cause` (con origen de BD)", new Error("query failed", { cause: net("EAI_AGAIN", { hostname: "postgres" }) })],
  ])("%s → transitorio", (_n, err) => {
    expect(isTransientDbError(err, DB)).toBe(true);
  });

  // P2-2: los mismos códigos de red, con OTRO origen, NO son `db_unavailable`.
  it.each([
    ["docker-proxy ECONNREFUSED", net("ECONNREFUSED", { address: "docker-proxy", port: 2375 })],
    ["docker-proxy ETIMEDOUT", net("ETIMEDOUT", { address: "10.9.0.5", port: 2375 })],
    ["WebSocket del bot ECONNREFUSED", net("ECONNREFUSED", { address: "172.20.0.7", port: 9001 })],
    ["WebSocket del bot ECONNRESET sin dirección", net("ECONNRESET")],
    ["Redis ECONNREFUSED", net("ECONNREFUSED", { address: "redis", port: 6379 })],
    ["Redis EAI_AGAIN", net("EAI_AGAIN", { hostname: "redis" })],
    ["EPIPE de un stream cualquiera", net("EPIPE", { syscall: "write" })],
    ["mismo host, otro puerto (no es la BD)", net("ECONNREFUSED", { address: "postgres", port: 6379 })],
    [
      "en `cause` de un error de otro origen",
      new Error("docker", { cause: net("ECONNREFUSED", { address: "docker-proxy", port: 2375 }) }),
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

  it("sin endpoint conocido, un código de red SIN más evidencia no se atribuye a la BD", () => {
    expect(isTransientDbError(net("ECONNREFUSED", { address: "postgres", port: 5432 }), {})).toBe(false);
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
    const docker = net("ECONNREFUSED", { address: "docker-proxy", port: 2375 });
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

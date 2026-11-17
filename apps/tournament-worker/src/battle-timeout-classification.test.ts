/**
 * Release 0.5.0 · PR A · timeouts de batalla y clasificación de errores
 * (DIAG-PROD-TORNEOS, hallazgos F2 y F3). Parte PURA: sin BD, sin contenedores.
 *
 *  - margen PROPORCIONAL del guard (batalla larga dentro del margen);
 *  - `battle_timeout` ≠ `engine_start_failure` (sólo si el motor llegó a jugar);
 *  - clasificación de errores transitorios de BD (Knex/pool/DNS/pg);
 *  - política de reintento por código.
 */
import { describe, expect, it } from "vitest";
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
    expect(proportionalBattleGuardMs(1_000_000, 3000)).toBe(MAX_CONTAINER_BATTLE_TIMEOUT_MS);
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
    expect(classifyEnd({ ok: false, error: err })).toBe("TIMEOUT");
  });
});

describe("F3 · errores transitorios de BD", () => {
  const knexTimeout = Object.assign(new Error("Knex: Timeout acquiring a connection. The pool is probably full."), {
    name: "KnexTimeoutError",
  });
  it.each([
    ["KnexTimeoutError por nombre", knexTimeout],
    ["pool: mensaje de tarn", new Error("Acquire connection error: operation timed out for an unknown reason")],
    ["ECONNREFUSED", Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" })],
    ["EAI_AGAIN", Object.assign(new Error("getaddrinfo EAI_AGAIN postgres"), { code: "EAI_AGAIN" })],
    ["ECONNRESET", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    ["57P01 admin_shutdown", Object.assign(new Error("terminating connection (admin)"), { code: "57P01" })],
    ["57P03 cannot_connect_now", Object.assign(new Error("the database system is starting up"), { code: "57P03" })],
    ["terminating connection sin código", new Error("terminating connection due to administrator command")],
    ["en `cause`", new Error("query failed", { cause: Object.assign(new Error("x"), { code: "EAI_AGAIN" }) })],
  ])("%s → transitorio", (_n, err) => {
    expect(isTransientDbError(err)).toBe(true);
  });

  it.each([
    ["bug del worker", new TypeError("Cannot read properties of undefined")],
    ["violación de unicidad (23505)", Object.assign(new Error("duplicate key"), { code: "23505" })],
    ["sintaxis SQL (42601)", Object.assign(new Error("syntax error"), { code: "42601" })],
    ["no es un error", "texto"],
    ["null", null],
  ])("%s → NO es transitorio", (_n, err) => {
    expect(isTransientDbError(err)).toBe(false);
  });

  it("toInfrastructureFailure: respeta lo clasificado, mapea BD transitoria y cae a `fallback`", () => {
    const ya = new InfrastructureFailure("map_unavailable", "x");
    expect(toInfrastructureFailure(ya, "engine_start_failure")).toBe(ya);
    expect(toInfrastructureFailure(knexTimeout, "engine_start_failure").code).toBe("db_unavailable");
    expect(toInfrastructureFailure(new Error("motor"), "engine_start_failure").code).toBe("engine_start_failure");
  });
});

describe("política de reintento por código", () => {
  it("battle_timeout: un solo reintento con pausa larga; db_unavailable: backoff creciente y acotado", () => {
    expect(retryPolicyFor("battle_timeout").maxAttempts).toBe(2);
    expect(retryPolicyFor("battle_timeout").backoffMs(1)).toBeGreaterThanOrEqual(60_000);
    const db = retryPolicyFor("db_unavailable");
    expect(db.backoffMs(2)).toBeGreaterThan(db.backoffMs(1));
    expect(db.backoffMs(50)).toBe(120_000);
    // el resto conserva el comportamiento de siempre
    expect(retryPolicyFor("engine_start_failure").maxAttempts).toBeUndefined();
    expect(retryPolicyFor("engine_start_failure").backoffMs(1)).toBe(2000);
    expect(retryPolicyFor("engine_start_failure").backoffMs(20)).toBe(60_000);
  });
});

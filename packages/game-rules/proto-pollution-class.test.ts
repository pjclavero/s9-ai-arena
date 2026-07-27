/**
 * B8 · Barrido de la CLASE "indexación de objeto plano con clave externa".
 *
 * Es la séptima aparición del patrón en el proyecto (B2 lo cerró en cuatro
 * sitios, el supervisor de B2 encontró dos más, el de B9 otro). Cada bloque
 * anterior arregló los casos que tenía delante y afirmó que no quedaban más.
 * Este fichero prueba la CLASE, no un caso: cada `it` ataca un punto DISTINTO
 * del sistema con la misma familia de claves envenenadas, y todos los tests son
 * de COMPORTAMIENTO — comprueban el efecto observable (se rechaza, el checksum
 * cambia, el número sigue siendo un número), no que se haya llamado a
 * `safeLookup`.
 *
 * Claves usadas: TODAS las propiedades heredadas de `Object.prototype` que
 * devuelven algo truthy al indexar un objeto plano. `"constructor"` es la peor
 * de todas: devuelve `Object`, una FUNCIÓN real e invocable, así que ni siquiera
 * una guarda `typeof x === "function"` la detecta.
 *
 * UBICACIÓN (a propósito): vive en `packages/game-rules/`, que es donde vive
 * `safeLookup`/`emptyDict`, y NO en `tests/acceptance/` — el workflow de CI solo
 * ejecuta `apps packages infrastructure`, `sdks`, `apps/arena-engine/tests` y
 * `tests/e2e`, así que un test en `tests/acceptance/` NUNCA se ejecutaría en CI
 * (ver el informe de B8: es un hueco real que afecta también a los ficheros que
 * ya había allí). Importa de `apps/` por ruta relativa, igual que ya hacen otros
 * módulos del monorepo.
 */
import { describe, expect, it } from "vitest";
import { safeLookup, emptyDict } from "./safe-lookup.js";
import { resolveTeamColors } from "./art-direction.js";
import { performanceOf } from "./index.js";
import { assertTransition, TRANSITIONS, type BotState } from "../../apps/api/src/services/bots.js";
import { ApiError } from "../../apps/api/src/errors.js";
import { ROLE_RANK } from "../../apps/api/src/openapi.js";
import { canonicalize } from "../../apps/map-service/src/canonical.js";
import { clearanceFor } from "../../apps/map-service/src/validate/navigation.js";
import type { ChassisSize } from "../../apps/map-service/src/types.js";

/** Propiedades heredadas de Object.prototype: todas dan algo TRUTHY al indexar `{}`. */
const POISONED = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"] as const;

describe("B8 · premisa de la clase (por qué la guarda `if (!dict[k])` no basta)", () => {
  it("cada clave envenenada devuelve algo TRUTHY al indexar un objeto plano", () => {
    const dict: Record<string, number> = { a: 1 };
    for (const k of POISONED) {
      expect(Boolean((dict as Record<string, unknown>)[k]), `dict["${k}"] debería ser truthy`).toBe(true);
      // ...y `safeLookup` lo convierte en el `undefined` que el autor esperaba.
      expect(safeLookup(dict, k), `safeLookup(dict, "${k}")`).toBeUndefined();
    }
  });

  it('"constructor" resuelve a una FUNCIÓN real: ni `typeof === "function"` la filtra', () => {
    const dict: Record<string, () => unknown> = {};
    expect(typeof (dict as Record<string, unknown>)["constructor"]).toBe("function");
    expect(safeLookup(dict, "constructor")).toBeUndefined();
  });

  it("emptyDict() acepta `__proto__` como clave NORMAL (el lado de escritura de la clase)", () => {
    const roto: Record<string, number> = {};
    roto["__proto__"] = 7;
    // Con `{}` la asignación pisa el prototipo: ni es propia ni sale al serializar.
    expect(Object.prototype.hasOwnProperty.call(roto, "__proto__")).toBe(false);
    expect(JSON.stringify(roto)).toBe("{}");

    const bien = emptyDict<number>();
    bien["__proto__"] = 7;
    expect(Object.prototype.hasOwnProperty.call(bien, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(bien))["__proto__"]).toBe(7);
  });
});

describe("B8 · api/services/bots.ts · assertTransition (el caso del enunciado)", () => {
  it("una acción envenenada da 409 illegal_transition, NUNCA un 500", () => {
    for (const action of POISONED) {
      let err: unknown;
      try {
        assertTransition(action, "draft");
      } catch (e) {
        err = e;
      }
      // Antes: `TRANSITIONS["__proto__"]` era truthy, la guarda no saltaba y
      // `t.from.includes(...)` lanzaba TypeError ⇒ 500 sin `status`, sin `extra`.
      expect(err, `action="${action}" debe rechazarse`).toBeInstanceOf(ApiError);
      expect((err as ApiError).status, `action="${action}"`).toBe(409);
      expect((err as ApiError).extra.currentState).toBe("draft");
      expect(Array.isArray((err as ApiError).extra.allowedTransitions)).toBe(true);
      expect(err).not.toBeInstanceOf(TypeError);
    }
  });

  it("las transiciones LEGÍTIMAS siguen funcionando exactamente igual", () => {
    for (const [action, t] of Object.entries(TRANSITIONS)) {
      for (const from of t.from) {
        expect(assertTransition(action, from as BotState)).toBe(t.to);
      }
    }
  });
});

/**
 * ALCANCE HONESTO: hoy este fallo NO es alcanzable desde fuera —`user_roles.role`
 * tiene FK contra `roles(name)`, poblada solo con `ROLES`. Es defensa en
 * profundidad. Lo que el test demuestra es que la MECÁNICA del bug era real (el
 * NaN desactiva la guarda RBAC), para que quede documentado por qué la FK no
 * puede seguir siendo la única barrera.
 */
describe("B8 · api/middleware/authenticate.ts · ROLE_RANK (defensa en profundidad)", () => {
  /** Réplica EXACTA del cálculo de rango del middleware, en sus dos versiones. */
  const rankRoto = (roles: string[]) =>
    Math.max(0, ...roles.map((r) => (ROLE_RANK as unknown as Record<string, number>)[r] ?? 0));
  const rankArreglado = (roles: string[]) => Math.max(0, ...roles.map((r) => safeLookup(ROLE_RANK, r) ?? 0));

  it("un rol envenenado daba NaN, y `rank < required` con NaN es SIEMPRE false", () => {
    const required = ROLE_RANK.admin;
    for (const role of POISONED) {
      // Demostración del agujero: con la indexación directa el rango es NaN...
      expect(Number.isNaN(rankRoto([role])), `rol "${role}"`).toBe(true);
      // ...y la guarda RBAC de registry.ts (`if (rank < required) forbidden()`)
      // no dispararía: el rango NaN pasa por administrador.
      expect(rankRoto([role]) < required).toBe(false);

      // Con el arreglo: rango 0 (visitante) y la guarda SÍ dispara.
      expect(rankArreglado([role])).toBe(0);
      expect(rankArreglado([role]) < required).toBe(true);
    }
  });

  it("los roles reales conservan su rango", () => {
    expect(rankArreglado(["admin"])).toBe(ROLE_RANK.admin);
    expect(rankArreglado(["user", "moderator"])).toBe(ROLE_RANK.moderator);
    expect(rankArreglado([])).toBe(0);
  });
});

describe("B8 · map-service/canonical.ts · colisión de checksum (lado de ESCRITURA)", () => {
  it("dos mapas DISTINTOS ya no canonicalizan igual por culpa de una clave `__proto__`", () => {
    const conProto = JSON.parse('{"name":"m","__proto__":{"trampa":1}}');
    const sinProto = JSON.parse('{"name":"m"}');
    // Antes: `out["__proto__"] = v` sobre `{}` pisaba el prototipo, la clave
    // desaparecía del JSON y AMBOS producían '{"name":"m"}' ⇒ MISMO checksum.
    expect(canonicalize(conProto)).not.toBe(canonicalize(sinProto));
    expect(canonicalize(conProto)).toContain("__proto__");
    // Y el mapa sin trampa sigue canonicalizando exactamente igual que siempre.
    expect(canonicalize(sinProto)).toBe('{"name":"m"}');
  });

  it("la canonicalización normal (orden de claves, anidamiento) no cambia", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalize([3, { z: 1, y: 2 }])).toBe('[3,{"y":2,"z":1}]');
  });
});

describe("B8 · map-service/navigation.ts · clearanceFor (validación de mapas subidos)", () => {
  it("un tamaño de chasis envenenado devuelve un NÚMERO, no una cadena disparatada", () => {
    for (const size of POISONED) {
      const c = clearanceFor(size as unknown as ChassisSize);
      // Antes: `CHASSIS_COLLISION_RADIUS_M["__proto__"] + 0.3` daba la STRING
      // "[object Object]0.3" y toda la validación de navegación operaba sobre eso.
      expect(typeof c, `size="${size}"`).toBe("number");
      expect(Number.isFinite(c), `size="${size}"`).toBe(true);
      // Fail-closed: cae al chasis MÁS grande (el requisito más restrictivo).
      expect(c).toBe(clearanceFor("heavy"));
    }
  });

  it("los tres tamaños reales conservan su clearance", () => {
    expect(clearanceFor("light")).toBeLessThan(clearanceFor("medium"));
    expect(clearanceFor("medium")).toBeLessThan(clearanceFor("heavy"));
  });
});

describe("B8 · game-rules/art-direction.ts · resolveTeamColors", () => {
  it("un equipo llamado `__proto__` recibe un COLOR (número), no `Object.prototype`", () => {
    const colors = resolveTeamColors([...POISONED, "red"]);
    for (const team of POISONED) {
      const c = colors.get(team);
      expect(typeof c, `equipo "${team}"`).toBe("number");
    }
    // El equipo canónico conserva su identidad fija.
    expect(typeof colors.get("red")).toBe("number");
    // Y ningún par de equipos comparte color mientras quede paleta.
    expect(new Set(colors.values()).size).toBe(colors.size);
  });
});

describe("B8 · game-rules/index.ts · performanceOf", () => {
  it("un estado de módulo envenenado rinde 0, no un objeto", () => {
    for (const state of POISONED) {
      const p = performanceOf(state as never);
      expect(typeof p, `state="${state}"`).toBe("number");
      expect(p).toBe(0);
    }
    expect(performanceOf("operational")).toBeGreaterThan(0);
  });
});

/**
 * B2 (arena-engine) · REGRESSION LOCK — quinto/sexto sitio del mismo patrón
 * (indexación de objeto plano con clave externa), encontrado por el supervisor
 * tras el barrido mecánico anterior (que solo casaba `identificador[identificador]`
 * y se le escapaban expresiones/`??`):
 *
 *   cli.ts:106       STUBS[stubNames[i % stubNames.length]] ?? STUBS.idle
 *   local-sim.ts:93  STUBS[s.kind ?? "idle"] ?? STUBS.idle
 *
 * Con clave `"__proto__"`, `STUBS["__proto__"]` resuelve a `Object.prototype`
 * (truthy: el `??` NO lo sustituye por `STUBS.idle`) y revienta al intentar
 * usarlo como fábrica de bot; con `"constructor"` resuelve a `Object` (una
 * función real, invocable), y produce un "bot" corrupto en vez de caer al
 * stub idle. `safeLookup(STUBS, key) ?? STUBS.idle` cierra esto: una clave
 * envenenada nunca resuelve a nada del prototipo, así que el `??` sí aplica.
 *
 * `cli.ts` exporta `STUBS` para test directo (mismo patrón que
 * `validateInspectHost` en cli-inspect-host.test.ts: importar el módulo no
 * ejecuta `main()`, hay guarda de entrypoint). `local-sim.ts` NO tiene esa
 * guarda — su `main()` se ejecuta incondicionalmente al importar el módulo
 * (preexistente, ajeno a este fix) — así que NO se importa aquí; se prueba el
 * mismo patrón (`safeLookup(dict, key) ?? dict.idle`) contra un diccionario de
 * la MISMA forma (`Record<string, (id: string) => unknown>`, mismas 4 claves)
 * para no ejecutar un proceso de simulación real dentro del test.
 */
import { describe, expect, it } from "vitest";
import { safeLookup } from "../../../packages/game-rules/safe-lookup.js";
import { STUBS as CLI_STUBS } from "../src/cli.js";

const POLLUTED_KEYS = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];

describe("B2 · STUBS[key] envenenado en cli.ts (fix real, import directo)", () => {
  for (const key of POLLUTED_KEYS) {
    it(`safeLookup(STUBS, "${key}") es undefined (así que el "?? STUBS.idle" real SÍ aplica)`, () => {
      expect(safeLookup(CLI_STUBS, key)).toBeUndefined();
      const stub = safeLookup(CLI_STUBS, key) ?? CLI_STUBS.idle;
      expect(stub).toBe(CLI_STUBS.idle);
    });
  }

  it("las rutas legítimas (hunter/circle/forward/idle) siguen resolviendo al stub correcto", () => {
    for (const name of ["hunter", "circle", "forward", "idle"]) {
      const stub = safeLookup(CLI_STUBS, name) ?? CLI_STUBS.idle;
      expect(stub).toBe(CLI_STUBS[name]);
    }
  });
});

describe('B2 · mismo patrón en local-sim.ts (STUBS[s.kind ?? "idle"] ?? STUBS.idle)', () => {
  // Diccionario de la MISMA forma que local-sim.ts::STUBS (no se importa el
  // módulo real: ver la nota de cabecera). Las fábricas son opacas a propósito
  // (no instancian HunterBot/etc.): lo que se prueba es la búsqueda, no el motor.
  const localSimShapedStubs: Record<string, (id: string) => unknown> = {
    idle: (id) => ({ kind: "idle", id }),
    hunter: (id) => ({ kind: "hunter", id }),
    circle: (id) => ({ kind: "circle", id }),
    forward: (id) => ({ kind: "forward", id }),
  };

  for (const key of POLLUTED_KEYS) {
    it(`kind="${key}" → safeLookup da undefined, cae a idle (nunca Object.prototype/Object)`, () => {
      const kind: string | undefined = key;
      const mk = safeLookup(localSimShapedStubs, kind ?? "idle") ?? localSimShapedStubs.idle;
      expect(mk).toBe(localSimShapedStubs.idle);
      const bot = mk("bot_1") as { kind: string };
      expect(bot.kind).toBe("idle");
    });
  }

  it("kind ausente (undefined) sigue cayendo a idle, como antes del fix", () => {
    const kind: string | undefined = undefined;
    const mk = safeLookup(localSimShapedStubs, kind ?? "idle") ?? localSimShapedStubs.idle;
    expect(mk).toBe(localSimShapedStubs.idle);
  });

  it("las rutas legítimas (hunter/circle/forward) siguen resolviendo al stub correcto, no a idle", () => {
    for (const name of ["hunter", "circle", "forward"]) {
      const mk = safeLookup(localSimShapedStubs, name) ?? localSimShapedStubs.idle;
      expect(mk).toBe(localSimShapedStubs[name]);
    }
  });
});

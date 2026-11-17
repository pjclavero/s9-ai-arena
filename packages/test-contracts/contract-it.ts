/**
 * OLA 2 · ME · `contractIt`: contratos pendientes COMPARTIDOS por las suites de contrato
 * de arena-engine y bot-manager (helper de TESTS; ningún código de producción lo importa).
 *
 * Un contrato pendiente del equipo dueño `team` se declara con `contractIt(team, …)`:
 *  - pendiente (por defecto): el test es VERDE sólo si `fn` falla con una ASERCIÓN
 *    (AssertionError de chai/vitest o de node:assert). Cualquier otra excepción
 *    (TypeError, ReferenceError, import roto, ancla undefined, timeout) NO es «rojo
 *    esperado»: es un error de INFRAESTRUCTURA del contrato y el test falla con el
 *    prefijo `INFRA:`. Si `fn` pasa («unexpected pass»), el test falla: nadie arregla
 *    un contrato sin activarlo a propósito (cambiar `contractIt("MX", …)` por `it(…)`).
 *  - activado (`S9_CONTRACT_ENFORCE=MX|ALL`, equipos separados por comas): corre como un
 *    test normal; una excepción que no sea aserción se relanza con el prefijo `INFRA:`
 *    para distinguirla de un contrato incumplido.
 */
import { it } from "vitest";

export const OWNER_TEAMS = ["MF", "MD", "MA", "MB", "MC", "ME", "M0"] as const;
export type OwnerTeam = (typeof OWNER_TEAMS)[number];

function parseEnforce(raw: string | undefined): Set<string> {
  const set = new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
  const valid = new Set<string>([...OWNER_TEAMS, "ALL"]);
  const unknown = [...set].filter((s) => !valid.has(s));
  if (unknown.length > 0) {
    throw new Error(
      `S9_CONTRACT_ENFORCE contiene equipos desconocidos: ${unknown.join(", ")} (válidos: ${[...valid].join(", ")})`,
    );
  }
  return set;
}

/** Se evalúa al cargar el módulo: un typo en la variable rompe la suite, no la silencia. */
const ENFORCED = parseEnforce(process.env.S9_CONTRACT_ENFORCE);

export function enforced(team: OwnerTeam): boolean {
  return ENFORCED.has(team) || ENFORCED.has("ALL");
}

/** ¿Es una aserción (el contrato se incumple) y no un fallo de código/infraestructura? */
export function isAssertionError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const x = e as { name?: unknown; code?: unknown; constructor?: { name?: unknown } };
  return x.name === "AssertionError" || x.constructor?.name === "AssertionError" || x.code === "ERR_ASSERTION";
}

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.split("\n")[0]!.slice(0, 300);
  return String(e).slice(0, 300);
}

/** Para guardas de fixture: un error que NUNCA cuenta como contrato incumplido. */
export class FixtureError extends Error {
  override name = "FixtureError";
}

/** Control positivo del escenario: si no se cumple, el contrato no mide nada (error de infra). */
export function fixtureGuard(cond: unknown, message: string): asserts cond {
  if (!cond) throw new FixtureError(message);
}

export function contractIt(team: OwnerTeam, name: string, fn: () => unknown | Promise<unknown>, timeout?: number) {
  const title = `[contract-pending ${team}] ${name}`;
  const run = async (): Promise<{ threw: boolean; error?: unknown }> => {
    try {
      await fn();
      return { threw: false };
    } catch (error) {
      return { threw: true, error };
    }
  };
  if (enforced(team)) {
    return it(
      title,
      async () => {
        const r = await run();
        if (!r.threw) return;
        if (isAssertionError(r.error)) throw r.error;
        throw new Error(
          `INFRA: el contrato falló por una excepción que no es una aserción (${describeError(r.error)})`,
          {
            cause: r.error,
          },
        );
      },
      timeout,
    );
  }
  return it(
    title,
    async () => {
      const r = await run();
      if (!r.threw) {
        throw new Error(
          `CONTRATO CUMPLIDO ("unexpected pass"): ${team} lo ha implementado; actívalo cambiando contractIt("${team}", …) por it(…)`,
        );
      }
      if (!isAssertionError(r.error)) {
        throw new Error(
          `INFRA: el contrato pendiente de ${team} falla por una excepción que no es una aserción (${describeError(r.error)}); ` +
            `un TypeError/ReferenceError/import roto no es «rojo por la razón correcta»`,
          { cause: r.error },
        );
      }
    },
    timeout,
  );
}

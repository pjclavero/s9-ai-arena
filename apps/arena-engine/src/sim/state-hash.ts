/**
 * OLA2-MD · Hash de estado v2 POR COMPONENTES (contrato engine-v2 §13, `StateHashComponent`).
 *
 * stateHash = sha256 de la lista ordenada `componente:hashDelComponente`. Cada componente es
 * sha256 de la forma canónica de su estado. Así un fallo de verificación dice QUÉ parte del
 * estado divergió, y un campo nuevo de estado vivo entra con sólo nombrarlo en su componente.
 *
 * La forma canónica (`canonicalize`) es GENÉRICA y data-driven:
 *   - números cuantizados a 1e-5 (mismo criterio que el hash v1); `-0` → 0; NaN/±Infinity se
 *     codifican como texto explícito (JSON los convertiría en `null` y una divergencia se
 *     tragaría en silencio);
 *   - objetos: TODAS sus claves propias enumerables, ordenadas por code-unit (nunca
 *     `localeCompare`), emitidas como pares [clave, valor] (un `__proto__` de datos no puede
 *     colarse como prototipo);
 *   - Map: entradas ordenadas por la forma canónica de la clave; Set: elementos ordenados;
 *   - funciones y `undefined` se omiten; referencias cíclicas = error en voz alta.
 * Las claves listadas en `skipKeys` se omiten: sólo se usa para la configuración INMUTABLE
 * que ya viaja en la cabecera del replay (p. ej. `spec`), nunca para estado mutable.
 *
 * Fuera del hash, por contrato: todo lo de proyección/visibilidad (`visibilityEpoch`, ids
 * públicos, cachés por audiencia). Este módulo no los conoce y `battle.ts` no se los pasa.
 */
import { createHash } from "node:crypto";

/** Orden canónico de componentes (= `StateHashComponent` del contrato; lo fija un test). */
export const STATE_HASH_COMPONENTS = [
  "tick",
  "rng",
  "allocator",
  "solver",
  "vehicles",
  "projectiles",
  "deployables",
  "effects",
  "effectQueue",
  "interference",
  "destructibles",
  "radioQueue",
  "pendingCommands",
  "botRefs",
  "mode",
] as const;
export type StateHashComponentV2 = (typeof STATE_HASH_COMPONENTS)[number];

/** Identificador del esquema: va en la cabecera del replay v2. */
export const STATE_HASH_SCHEME = "components/v1";

export type StateHashInput = Record<StateHashComponentV2, unknown>;

export interface StateHashBreakdown {
  hash: string;
  components: Record<StateHashComponentV2, string>;
}

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function qn(n: number): number | string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "+Inf";
  if (n === -Infinity) return "-Inf";
  const r = Math.round(n * 1e5) / 1e5;
  return r === 0 ? 0 : r; // normaliza -0
}

export interface CanonicalizeOptions {
  /** Claves de configuración inmutable a omitir (nunca estado mutable). */
  skipKeys?: ReadonlySet<string>;
}

/** Forma canónica (estructura JSON estable) de un valor de estado. */
export function canonicalize(value: unknown, opts: CanonicalizeOptions = {}): unknown {
  const skip = opts.skipKeys ?? new Set<string>();
  const seen = new Set<object>();
  const walk = (v: unknown): unknown => {
    if (v === null) return null;
    switch (typeof v) {
      case "number":
        return qn(v);
      case "string":
      case "boolean":
        return v;
      case "bigint":
        return `${v}n`;
      case "undefined":
      case "function":
      case "symbol":
        return undefined;
    }
    const o = v as object;
    if (seen.has(o)) throw new Error("canonicalize: referencia cíclica en el estado de simulación");
    seen.add(o);
    try {
      if (Array.isArray(o))
        return o.map((x) => {
          const c = walk(x);
          return c === undefined ? null : c;
        });
      if (o instanceof Map) {
        const entries = [...o.entries()].map(([k, x]) => [walk(k), walk(x)] as [unknown, unknown]);
        entries.sort((a, b) => codeUnitCompare(JSON.stringify(a[0]), JSON.stringify(b[0])));
        return ["$map", entries];
      }
      if (o instanceof Set) {
        const items = [...o.values()].map((x) => walk(x));
        items.sort((a, b) => codeUnitCompare(JSON.stringify(a), JSON.stringify(b)));
        return ["$set", items];
      }
      const keys = Object.keys(o).sort(codeUnitCompare);
      const pairs: [string, unknown][] = [];
      for (const k of keys) {
        if (skip.has(k)) continue;
        const c = walk((o as Record<string, unknown>)[k]);
        if (c === undefined) continue;
        pairs.push([k, c]);
      }
      return pairs;
    } finally {
      seen.delete(o);
    }
  };
  return walk(value);
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Hash de un componente (sha256 de su forma canónica). */
export function hashComponent(value: unknown, opts?: CanonicalizeOptions): string {
  return sha256Hex(JSON.stringify(canonicalize(value, opts) ?? null));
}

/**
 * Hash completo: exige EXACTAMENTE los componentes del contrato (ni uno de más, ni uno de
 * menos: un componente olvidado no puede pasar por "no aplica" en silencio).
 */
export function computeStateHash(input: StateHashInput, opts?: CanonicalizeOptions): StateHashBreakdown {
  const given = Object.keys(input).sort(codeUnitCompare);
  const expected = [...STATE_HASH_COMPONENTS].sort(codeUnitCompare);
  if (given.length !== expected.length || given.some((k, i) => k !== expected[i])) {
    throw new Error(`computeStateHash: componentes ${JSON.stringify(given)} ≠ contrato ${JSON.stringify(expected)}`);
  }
  const components = {} as Record<StateHashComponentV2, string>;
  for (const name of STATE_HASH_COMPONENTS) {
    components[name] = hashComponent(input[name], opts);
  }
  return { hash: hashFromComponents(components), components };
}

/**
 * Hash global a partir de los hashes por componente (única definición del esquema).
 * verify() lo usa para exigir que `components` de un checkpoint oficial cuadre con su `hash`.
 * Devuelve null si falta algún componente del contrato o no es una cadena.
 */
export function hashFromComponents(components: Partial<Record<string, unknown>> | null | undefined): string | null {
  if (!components || typeof components !== "object") return null;
  const lines: string[] = [];
  for (const name of STATE_HASH_COMPONENTS) {
    const h = components[name];
    if (typeof h !== "string") return null;
    lines.push(`${name}:${h}`);
  }
  return sha256Hex(`${STATE_HASH_SCHEME}\n${lines.join("\n")}`);
}

/** Componentes cuyo hash difiere entre dos desgloses (orden canónico). */
export function diffComponents(
  a: Partial<Record<string, string>>,
  b: Partial<Record<string, string>>,
): StateHashComponentV2[] {
  return STATE_HASH_COMPONENTS.filter((n) => a[n] !== b[n]);
}

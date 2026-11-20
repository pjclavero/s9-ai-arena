/**
 * EQ1 · validación del cursor v2 SIN base de datos (EQ6, #223).
 *
 * `decodeCursor` debe rechazar con 400, antes de tocar PostgreSQL, todo valor que la
 * columna no pueda convertir; `runCursorQuery` es la defensa en profundidad: convierte
 * en 400 sólo los errores de conversión de PostgreSQL de una consulta CON cursor.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "./errors.js";
import { decodeCursor, runCursorQuery, type CursorKeyType } from "./serialize.js";

const c = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const T = "2026-01-01T00:00:00.123456Z";
const UUID = "0b5c6f1e-8d2a-4c3b-9e7f-1a2b3c4d5e6f";

function status(fn: () => unknown): number | "ok" {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof ApiError ? e.status : -1;
  }
}

describe("decodeCursor · tipos de clave", () => {
  const cases: [string, CursorKeyType[], unknown, number | "ok"][] = [
    ["uuid válido", ["uuid"], { v: 2, t: T, k: [UUID] }, "ok"],
    ["uuid en mayúsculas", ["uuid"], { v: 2, t: T, k: [UUID.toUpperCase()] }, "ok"],
    ["no-uuid", ["uuid"], { v: 2, t: T, k: ["no-es-un-uuid"] }, 400],
    ["entero en uuid", ["uuid"], { v: 2, t: T, k: [42] }, 400],
    ["comilla en uuid", ["uuid"], { v: 2, t: T, k: ["x' OR '1'='1"] }, 400],
    ["uuid con un carácter de más", ["uuid"], { v: 2, t: T, k: [UUID + "0"] }, 400],
    ["text + int4 válidos", ["text", "int4"], { v: 2, t: T, k: ["mvp-arena-01", 3] }, "ok"],
    ["text vacío", ["text", "int4"], { v: 2, t: T, k: ["", 1] }, 400],
    ["text con NUL", ["text", "int4"], { v: 2, t: T, k: ["a\0b", 1] }, 400],
    ["text demasiado largo", ["text", "int4"], { v: 2, t: T, k: ["x".repeat(201), 1] }, 400],
    ["int4 en texto", ["text", "int4"], { v: 2, t: T, k: ["m", "uno"] }, 400],
    ["int4 decimal", ["text", "int4"], { v: 2, t: T, k: ["m", 1.5] }, 400],
    ["int4 en el máximo", ["text", "int4"], { v: 2, t: T, k: ["m", 2147483647] }, "ok"],
    ["int4 desbordado", ["text", "int4"], { v: 2, t: T, k: ["m", 2147483648] }, 400],
    ["int4 2^40", ["text", "int4"], { v: 2, t: T, k: ["m", 2 ** 40] }, 400],
    ["aridad de menos", ["text", "int4"], { v: 2, t: T, k: ["m"] }, 400],
    ["aridad de más", ["uuid"], { v: 2, t: T, k: [UUID, UUID] }, 400],
  ];
  for (const [name, types, payload, want] of cases) {
    it(name, () => {
      expect(status(() => decodeCursor(c(payload), types))).toBe(want);
    });
  }
});

describe("decodeCursor · instante exacto (ida y vuelta por Date)", () => {
  const cases: [string, string, number | "ok"][] = [
    ["válido", T, "ok"],
    ["29 de febrero bisiesto", "2028-02-29T23:59:59.999999Z", "ok"],
    ["año 0001", "0001-01-01T00:00:00.000000Z", "ok"],
    ["31 de febrero", "2026-02-31T00:00:00.000000Z", 400],
    ["29 de febrero no bisiesto", "2026-02-29T00:00:00.000000Z", 400],
    ["año 0000", "0000-01-01T00:00:00.000000Z", 400],
    ["hora 24", "2026-01-01T24:00:00.000000Z", 400],
    ["minuto 60", "2026-01-01T10:60:00.000000Z", 400],
    ["mes 13", "2026-13-01T00:00:00.000000Z", 400],
    ["sólo milisegundos", "2026-01-01T00:00:00.123Z", 400],
    ["sin Z", "2026-01-01T00:00:00.123456", 400],
  ];
  for (const [name, t, want] of cases) {
    it(name, () => {
      expect(status(() => decodeCursor(c({ v: 2, t, k: [UUID] })))).toBe(want);
    });
  }
});

describe("runCursorQuery · defensa en profundidad", () => {
  const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
  const cursor = decodeCursor(c({ v: 2, t: T, k: [UUID] }));

  for (const code of ["22P02", "22008", "22007", "22003"]) {
    it(`con cursor, el error de conversión ${code} es un 400`, async () => {
      await expect(runCursorQuery(Promise.reject(pgError(code)), cursor)).rejects.toMatchObject({ status: 400 });
    });
  }
  it("sin cursor, el mismo error NO se disfraza de 400", async () => {
    await expect(runCursorQuery(Promise.reject(pgError("22P02")), null)).rejects.toThrow("pg 22P02");
  });
  it("con cursor, cualquier otro error se propaga intacto", async () => {
    await expect(runCursorQuery(Promise.reject(pgError("40001")), cursor)).rejects.toThrow("pg 40001");
  });
  it("sin error, devuelve las filas", async () => {
    await expect(runCursorQuery(Promise.resolve([{ id: 1 }]), cursor)).resolves.toEqual([{ id: 1 }]);
  });
});

/**
 * V1 · Política de contraseñas ÚNICA (unidad, sin base de datos): 12-128 caracteres, blocklist sin
 * distinguir mayúsculas, derivadas de la cuenta y SIN reglas de composición.
 * Cada `it` lleva su mutante en scripts/v1-password-policy-mutants.mjs.
 */
import { describe, it, expect, vi } from "vitest";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordPolicyViolation } from "./passwords.js";
import { COMMON_PASSWORDS, COMMON_PASSWORDS_VERSION } from "./common-passwords.js";

const ok = (p: unknown, ctx = {}) => passwordPolicyViolation(p, undefined, ctx);

describe("V1 política de contraseñas · longitud", () => {
  it("128 caracteres se aceptan y 129 se rechazan", () => {
    expect(MAX_PASSWORD_LENGTH).toBe(128);
    expect(ok("ab".repeat(64))).toBeNull();
    expect(ok("ab".repeat(64) + "c")).toMatch(/no puede superar 128/);
  });

  it("el mínimo sigue siendo 12: 11 se rechazan, 12 se aceptan", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(ok("tortugaverd")).toMatch(/al menos 12/);
    expect(ok("tortugaverde")).toBeNull();
    expect(ok(undefined)).toMatch(/al menos 12/);
    expect(ok(123456789012)).toMatch(/al menos 12/);
  });

  it("emoji y multibyte cuentan como UN carácter (puntos de código), no por bytes ni por unidades UTF-16", () => {
    expect(ok("😀".repeat(128))).toBeNull(); // 128 caracteres = 512 bytes = 256 unidades UTF-16
    expect(ok("😀".repeat(129))).toMatch(/no puede superar 128/);
    expect(ok("😀".repeat(12))).toBeNull(); // 12 caracteres (24 unidades UTF-16)
    expect(ok("😀".repeat(11))).toMatch(/al menos 12/);
    expect(ok("ñ".repeat(12))).toBeNull();
  });

  it("se cuenta tras normalizar a NFC: «e»+acento combinante es UN carácter", () => {
    const decompuesta = "é";
    expect(ok(decompuesta.repeat(128))).toBeNull(); // 256 puntos de código sin normalizar, 128 en NFC
    expect(ok(decompuesta.repeat(129))).toMatch(/no puede superar 128/);
    expect(ok(decompuesta.repeat(6))).toMatch(/al menos 12/); // 12 sin normalizar, 6 en NFC
  });
});

describe("V1 política de contraseñas · entradas hostiles", () => {
  it("rechaza sustitutos UTF-16 solitarios (texto mal formado)", () => {
    expect(ok("\ud800".repeat(12))).toMatch(/Unicode no válidos/);
    expect(ok("contraseña-larga-\ud801")).toMatch(/Unicode no válidos/);
    expect(ok("contraseña-larga-😀")).toBeNull(); // un par sustituto válido sí
  });

  it("una entrada enorme se rechaza por longitud ANTES de normalizar", () => {
    const spy = vi.spyOn(String.prototype, "normalize");
    try {
      expect(ok("a".repeat(1_000_000))).toMatch(/no puede superar 128/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("V1 política de contraseñas · blocklist", () => {
  it("rechaza una contraseña común sin distinguir mayúsculas", () => {
    expect(COMMON_PASSWORDS).toContain("qwertyqwerty");
    for (const p of ["qwertyqwerty", "QWERTYQWERTY", "QwErTyQwErTy"]) {
      expect(ok(p)).toMatch(/demasiado común/);
    }
  });

  it("la lista es versionada, de miles de entradas, en minúsculas NFC y de 12 a 128 caracteres", () => {
    expect(COMMON_PASSWORDS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
    expect(COMMON_PASSWORDS.length).toBeGreaterThanOrEqual(5000);
    for (const p of COMMON_PASSWORDS) {
      expect(p).toBe(p.normalize("NFC").toLowerCase());
      const n = [...p].length;
      expect(n >= 12 && n <= 128).toBe(true);
    }
  });

  it("el mensaje no revela la contraseña ni la entrada de la lista", () => {
    const msg = ok("QWERTYQWERTY")!;
    expect(msg.toLowerCase()).not.toContain("qwerty");
  });
});

describe("V1 política de contraseñas · derivadas de la cuenta", () => {
  const ctx = { email: "juanperez@ejemplo.test", displayName: "María del Carmen" };

  it("rechaza el email, su parte local (con cola numérica) y el nombre visible", () => {
    for (const p of [
      "juanperez@ejemplo.test",
      "JuanPerez@Ejemplo.Test",
      "juanperez2024!",
      "JUANPEREZ12345",
      "maríadelcarmen99",
      "maría del carmen",
    ]) {
      expect(ok(p, ctx), p).toMatch(/email o nombre visible/);
    }
  });

  it("sin contexto (o con otra cuenta) la misma contraseña se acepta", () => {
    expect(ok("juanperez2024!")).toBeNull();
    expect(ok("juanperez2024!", { email: "otra@ejemplo.test", displayName: "Otra" })).toBeNull();
  });

  it("el nombre de usuario SOLO como contraseña (si ya cumple la longitud) se rechaza", () => {
    expect(ok("usuario-largo-nombre", { email: "x@ejemplo.test", displayName: "usuario-largo-nombre" })).toMatch(
      /email o nombre visible/,
    );
  });
});

describe("V1 política de contraseñas · sin reglas de composición", () => {
  it("no exige mayúsculas, cifras ni símbolos: sólo minúsculas, sólo cifras o un solo carácter repetido (ñ) valen", () => {
    for (const p of ["tortugasverdes", "ñññññññññññññ", "73918264057316", "ñandúñandúñandú", "con espacios en medio"]) {
      expect(COMMON_PASSWORDS, `${p} no debería estar en la lista`).not.toContain(p.toLowerCase());
      expect(ok(p), p).toBeNull();
    }
  });

  it("si un carácter repetido está en la blocklist, se rechaza por la LISTA y no por composición", () => {
    // `aaaaaaaaaaaa` es una de las 10 000 contraseñas más frecuentes de 12+ caracteres.
    expect(COMMON_PASSWORDS).toContain("aaaaaaaaaaaa");
    const msg = ok("aaaaaaaaaaaa")!;
    expect(msg).toMatch(/demasiado común/);
    expect(msg).not.toMatch(/mayúscula|número|símbolo|cifra/i);
  });
});

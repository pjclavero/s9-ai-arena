/**
 * EQ5e (revisión ronda 3, R3-A) · `redactSecret` con caracteres que cambian de
 * longitud (o no) al pasar a minúsculas. Antes los índices se calculaban sobre
 * `text.toLowerCase()` y se aplicaban sobre `text`: con 'İ' (U+0130, que pasa a
 * dos unidades) la marca se desplazaba y la clave salía entera.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { foldSameLength, redactSecret } from "./config.js";

const KEY = `eq5e-${randomBytes(12).toString("hex")}-Zq`;

/** Trozos de ≥8 de la clave que sobreviven (sin distinguir mayúsculas ASCII). */
function leaked(text: string, k = KEY): string[] {
  const t = text.toLowerCase();
  const out: string[] = [];
  for (let i = 0; i + 8 <= k.length; i++) if (t.includes(k.slice(i, i + 8).toLowerCase())) out.push(k.slice(i, i + 8));
  return out;
}

const PREFIXES: Array<[string, string]> = [
  ["İ (U+0130, crece al pasar a minúsculas)", "İ"],
  ["ß (U+00DF)", "ß"],
  ["ﬁ (ligadura U+FB01)", "ﬁ"],
  ["combinante (e + U+0301)", "é"],
  ["combinante suelto (U+0307)", "̇"],
  ["emoji (par subrogado)", "😀"],
  ["emoji con modificador y ZWJ", "👩🏽‍💻"],
  ["Kelvin (U+212A, encoge a 'k')", "K"],
  ["letra astral con caso (Deseret U+10400)", "\u{10400}"],
  ["ẞ mayúscula (U+1E9E)", "ẞ"],
];

describe("EQ5e · R3-A · foldSameLength conserva la longitud", () => {
  for (const [name, p] of PREFIXES) {
    it(`${name}: misma longitud y ASCII plegado`, () => {
      const t = `${p.repeat(7)}AbC${p}`;
      const f = foldSameLength(t);
      expect(f.length).toBe(t.length);
      expect(f.includes("abc")).toBe(true);
    });
  }
});

describe("EQ5e · R3-A · la clave no sobrevive delante, detrás ni entre caracteres raros", () => {
  for (const [name, p] of PREFIXES) {
    for (const n of [1, 3, KEY.length, 64]) {
      it(`${name} ×${n}: delante, detrás y en medio, tal cual y en MAYÚSCULAS`, () => {
        const pad = p.repeat(n);
        for (const k of [KEY, KEY.toUpperCase()]) {
          for (const text of [`${pad}${k}`, `${k}${pad}`, `${pad}${k}${pad}`, `x${pad}y ${k} ${pad}z`]) {
            const out = redactSecret(text, KEY);
            expect(leaked(out), out).toEqual([]);
            // Lo que no es la clave sigue ahí (no se come el texto vecino).
            expect(out.includes(pad), out).toBe(true);
          }
        }
      });
    }
  }
  it("la clave intercalada en JSON con rarezas: sale *** y el resto intacto", () => {
    const line = JSON.stringify({ msg: `İİİ${KEY}😀ß`, service: "streamer" });
    const out = redactSecret(line, KEY);
    expect(leaked(out)).toEqual([]);
    expect(JSON.parse(out)).toEqual({ msg: "İİİ***😀ß", service: "streamer" });
  });
});

describe("EQ5e · R3-A · falso positivo ACEPTADO (documentado): palabra común dentro de la clave", () => {
  it('si la clave contiene `streamer`, `"service":"streamer"` también se redacta (sobre-redacción, nunca fuga)', () => {
    const k = `x1-streamer-${randomBytes(6).toString("hex")}`;
    const line = JSON.stringify({ level: "info", service: "streamer", msg: "ok" });
    const out = redactSecret(line, k);
    expect(JSON.parse(out)).toEqual({ level: "info", service: "***", msg: "ok" });
  });
  it("con una clave aleatoria (sin palabras), la misma línea queda intacta", () => {
    const k = randomBytes(16).toString("hex");
    const line = JSON.stringify({ level: "info", service: "streamer", msg: "ok" });
    expect(redactSecret(line, k)).toBe(line);
  });
});

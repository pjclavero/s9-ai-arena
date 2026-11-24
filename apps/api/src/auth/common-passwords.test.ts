/**
 * V1 · Higiene de la lista de contraseñas comunes: el repo es público y la lista procede de filtraciones,
 * así que no puede contener datos personales de terceros (emails, dominios) ni basura de codificación.
 */
import { describe, it, expect } from "vitest";
import { COMMON_PASSWORDS } from "./common-passwords.js";

const EMAIL = /@[^\s@]*\.[a-z]{2,}/;
const DOMAIN = /(?:[a-z0-9-]+\.)+[a-z]{2,}/;
const URLISH = /:\/\/|htt|www\.|&#\d|&[a-z]+;|\.(?:com|net|org|info|biz|ru|jp|tv)\d/;
const MOJIBAKE = /[ãâðïÐÑÃÂ][\u0080-¿€™]/;
const LATIN = /^[ -~ -ɏ]+$/;

describe("V1 lista de contraseñas comunes · higiene", () => {
  it("sin direcciones de email ni dominios (datos personales de terceros)", () => {
    const malas = COMMON_PASSWORDS.filter((p) => EMAIL.test(p) || DOMAIN.test(p));
    expect(malas).toEqual([]);
  });

  it("sin URL (`://`, `htt`, `www.`), entidades HTML ni TLD seguido de cifras", () => {
    const malas = COMMON_PASSWORDS.filter((p) => URLISH.test(p));
    expect(malas).toEqual([]);
  });

  it("sin `$hex[...]`, sin U+FFFD, sin mojibake y sin caracteres fuera del alfabeto latino", () => {
    const malas = COMMON_PASSWORDS.filter(
      (p) => p.includes("$hex[") || p.includes("�") || MOJIBAKE.test(p) || !LATIN.test(p),
    );
    expect(malas).toEqual([]);
  });

  it("sin duplicados", () => {
    expect(new Set(COMMON_PASSWORDS).size).toBe(COMMON_PASSWORDS.length);
  });
});

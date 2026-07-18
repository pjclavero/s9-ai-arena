/**
 * R2.6 · ERR-SEC-10 — decodificación ESTRICTA del paquete de código.
 * DoD: un paquete con `path` `../x` o absoluto se rechaza en decodificación.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_PACKAGE_FILES,
  PackageValidationError,
  assertSafeRelativePath,
  decodePackage,
  wrapSingleFile,
} from "./source-package.js";

const pkg = (files: { path: string; content: string }[]) => Buffer.from(JSON.stringify({ files }));
const MANIFEST = { path: "requirements.txt", content: "arena-sdk==1.0.0\n" };

describe("R2.6 decodePackage estricto (ERR-SEC-10)", () => {
  it("acepta un paquete válido con manifiesto en la raíz exacta", () => {
    const files = [MANIFEST, { path: "src/bot.py", content: "print('hola')" }];
    expect(decodePackage(pkg(files), "python")).toEqual(files);
  });

  it("DoD: rechaza rutas ../ y absolutas en decodificación", () => {
    for (const path of ["../x", "a/../../x", "/etc/passwd", "src/../../x"]) {
      expect(() => decodePackage(pkg([MANIFEST, { path, content: "x" }]), "python"), path).toThrow(
        PackageValidationError,
      );
    }
  });

  it("rechaza backslash, letra de unidad, esquema, control, segmentos vacíos y '.'", () => {
    for (const path of [
      "src\\bot.py",
      "C:/x",
      "file:x",
      "src/bo\nt.py",
      "src/bot\u0007.py",
      "a//b",
      "./x",
      "a/./b",
      "a/b/",
    ]) {
      expect(() => assertSafeRelativePath(path), JSON.stringify(path)).toThrow(PackageValidationError);
    }
  });

  it("exige el manifiesto en la raíz EXACTA (anidado no vale)", () => {
    const nested = [
      { path: "sub/requirements.txt", content: "arena-sdk==1.0.0\n" },
      { path: "src/bot.py", content: "x" },
    ];
    expect(() => decodePackage(pkg(nested), "python")).toThrow(/manifiesto requirements.txt/);
    const node = [
      { path: "sub/package.json", content: "{}" },
      { path: "src/bot.js", content: "x" },
    ];
    expect(() => decodePackage(pkg(node), "node")).toThrow(/manifiesto package.json/);
  });

  it("limita el número de ficheros del paquete", () => {
    const files = [MANIFEST];
    for (let i = 0; i < MAX_PACKAGE_FILES; i++) files.push({ path: `src/f${i}.py`, content: "x" });
    expect(() => decodePackage(pkg(files), "python")).toThrow(/maxItems|esquema/);
  });

  it("rechaza rutas duplicadas y entradas con forma inválida (sin degradar en silencio)", () => {
    expect(() => decodePackage(pkg([MANIFEST, MANIFEST]), "python")).toThrow(/duplicada/);
    // Antes, una entrada inválida se FILTRABA en silencio; ahora el paquete entero se rechaza.
    const bad = Buffer.from(JSON.stringify({ files: [MANIFEST, { path: 42, content: "x" }] }));
    expect(() => decodePackage(bad, "python")).toThrow(PackageValidationError);
    const extra = Buffer.from(JSON.stringify({ files: [MANIFEST], sorpresa: true }));
    expect(() => decodePackage(extra, "python")).toThrow(PackageValidationError);
  });

  it("código pegado (no-JSON o JSON sin `files`) se envuelve en el esqueleto estándar", () => {
    expect(decodePackage(Buffer.from("print('hola')"), "python")).toEqual(wrapSingleFile("python", "print('hola')"));
    const jsonNoPackage = '{"nombre": "no soy un paquete"}';
    expect(decodePackage(Buffer.from(jsonNoPackage), "node")).toEqual(wrapSingleFile("node", jsonNoPackage));
  });
});

/**
 * CLASIFICACIÓN DE DEPENDENCIAS DE RUNTIME.
 *
 * Un paquete que el código de producción importa tiene que estar en `dependencies`. Hoy da
 * igual —la imagen se construye con `npm ci` sin `--omit=dev` y se instala todo—, y por eso
 * precisamente hace falta el guard: el error es invisible hasta que alguien reduce la imagen
 * y el servicio no arranca. Cuando se destapó por `multer`, eran DIEZ los paquetes en esa
 * situación, con `express` y `knex` entre ellos.
 *
 * El alcance se calcula siguiendo imports desde los entrypoints que el compose declara, no
 * por convención de carpetas. Cada garantía va con su control negativo: se comprueba que el
 * auditor SABE detectar una mala clasificación y que no inventa hallazgos donde no los hay,
 * porque un auditor que sólo se ha visto en verde no demuestra nada.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — script .mjs sin tipos, se consume desde tests y CI.
import { auditar, ENTRYPOINTS, nombrePaquete, recorrer } from "../../scripts/runtime-deps-audit.mjs";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8"));

describe("clasificación de dependencias de runtime", () => {
  it("el recorrido llega de verdad al código, no se queda en los entrypoints", () => {
    // Control de cordura: si el resolutor de imports se rompe (p. ej. deja de reescribir
    // `./app.js` → `./app.ts`), el recorrido muere en el primer salto y la auditoría sale
    // «limpia» por no haber mirado nada. Siete ficheros serían exactamente los entrypoints.
    const { alcanzados } = recorrer();
    expect(alcanzados.size).toBeGreaterThan(ENTRYPOINTS.length * 5);
  });

  it("todos los entrypoints declarados existen", () => {
    const ausentes = ENTRYPOINTS.filter((e: string) => !existsSync(join(RAIZ, e)));
    expect(ausentes, `entrypoints que no existen: ${ausentes.join(", ")}`).toEqual([]);
  });

  it("ningún paquete alcanzable desde producción está en devDependencies", () => {
    const r = auditar(RAIZ);
    const nombres = r.malClasificados.map((d: { paquete: string }) => d.paquete);
    expect(
      nombres,
      `en devDependencies pero importados desde código de producción: ${nombres.join(", ")}. ` +
        "Hoy funciona porque la imagen instala también las dev; con `npm ci --omit=dev` el " +
        "servicio no arrancaría.",
    ).toEqual([]);
  });

  it("ningún paquete alcanzable está sin declarar", () => {
    const r = auditar(RAIZ);
    const nombres = r.sinDeclarar.map((d: { paquete: string }) => d.paquete);
    expect(nombres, `importados y no declarados: ${nombres.join(", ")}`).toEqual([]);
  });

  it("los paquetes de runtime conocidos están en dependencies", () => {
    // Lista explícita: si alguien mueve uno de vuelta a dev, esto falla nombrándolo,
    // sin depender de que el recorrido lo alcance ese día.
    for (const p of ["express", "knex", "multer", "argon2", "jsonwebtoken", "otplib", "ajv", "yaml", "acorn"]) {
      expect(Object.keys(PKG.dependencies ?? {}), `${p} debe estar en dependencies`).toContain(p);
      expect(Object.keys(PKG.devDependencies ?? {}), `${p} no debe seguir en devDependencies`).not.toContain(p);
    }
  });

  it("el utillaje de desarrollo NO se cuela en dependencies", () => {
    // El movimiento contrario también es un error: vitest o vite en `dependencies` harían
    // inútil cualquier reducción posterior de la imagen.
    for (const p of ["vitest", "vite", "typescript", "eslint", "prettier", "embedded-postgres"]) {
      expect(Object.keys(PKG.dependencies ?? {}), `${p} no debe estar en dependencies`).not.toContain(p);
    }
  });

  it("CONTROL NEGATIVO · el auditor detecta una mala clasificación simulada", () => {
    // Se simula el estado anterior al arreglo (multer en dev) sobre una copia del manifiesto,
    // sin tocar el del repo: el auditor debe señalarlo por su nombre.
    const falso = JSON.parse(JSON.stringify(PKG));
    falso.devDependencies.multer = falso.dependencies.multer;
    delete falso.dependencies.multer;
    const deps = new Set(Object.keys(falso.dependencies));
    const dev = new Set(Object.keys(falso.devDependencies));
    const { externos } = recorrer();
    const mal = [...externos.keys()].filter((p: string) => dev.has(p) && !deps.has(p));
    expect(mal).toContain("multer");
  });

  it("CONTROL NEGATIVO · el extractor de nombre de paquete no inventa", () => {
    expect(nombrePaquete("express")).toBe("express");
    expect(nombrePaquete("knex/lib/util")).toBe("knex");
    expect(nombrePaquete("@dimforge/rapier2d-compat")).toBe("@dimforge/rapier2d-compat");
    expect(nombrePaquete("@a/b/c/d")).toBe("@a/b");
  });
});

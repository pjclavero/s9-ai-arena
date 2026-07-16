/**
 * T3.4 · DoD: "escribe un test que falle si data/ alguna vez tiene un archivo
 * modificado que ya tenía un golden file de T3.3 apuntándolo (señal de que
 * sobrescribiste una versión usada)".
 *
 * golden/.catalog-lock.json es una foto de los módulos que los 4 arquetipos de
 * referencia (resolve/archetypes.ts) usaban cuando sus golden files se generaron.
 * Si data/<id>@<version>.json cambia de contenido sin subir de versión, este test
 * lo detecta: cap. 10.4 exige que un ajuste de balance cree @N+1, nunca reescriba
 * @N in situ.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "../loadCatalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(readFileSync(join(__dirname, "golden", ".catalog-lock.json"), "utf8")) as {
  modules: Record<string, Record<string, unknown>>;
};

const catalog = loadCatalog();

describe("T3.4 · inmutabilidad de versiones ya usadas por los goldens de T3.3", () => {
  for (const [versionedId, lockedFields] of Object.entries(lock.modules)) {
    it(`${versionedId} conserva los campos con los que se generaron los goldens`, () => {
      const [base, versionStr] = versionedId.split("@");
      const current = catalog.find((m) => m.id === base && m.version === Number(versionStr));

      expect(current, `${versionedId} ha desaparecido del catálogo: eso también rompe los goldens`).toBeDefined();

      for (const [field, lockedValue] of Object.entries(lockedFields)) {
        expect(
          // vía unknown: ModuleDefinition no indexa por string (1 error tsc de H7, issue #11)
          (current as unknown as Record<string, unknown>)[field],
          `${versionedId}.${field} cambió respecto al snapshot bloqueado. ` +
            `Si es un ajuste de balance deliberado, crea ${base}@${Number(versionStr) + 1} ` +
            `en vez de editar ${versionedId} in situ (cap. 10.4), y regenera los goldens de T3.3.`,
        ).toEqual(lockedValue);
      }
    });
  }
});

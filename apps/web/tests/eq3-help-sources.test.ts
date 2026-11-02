/**
 * EQ3 · El Centro de Ayuda se genera desde las FUENTES DE VERDAD. Estos tests se
 * ponen ROJOS si la ayuda diverge de ellas:
 *  - catálogo: la ayuda ve exactamente lo que carga loadCatalog() (mismo nº, ids y
 *    versiones), y TODAS las ranuras/propiedades tienen nombre humano;
 *  - las copias literales (PLATFORM_MODES, CATALOG_VERSION, rating) coinciden con
 *    el original que no se puede importar en el navegador;
 *  - versiones: SDK Python/JS y la que instala la plataforma salen de sus ficheros;
 *  - ejemplos: el código mostrado es byte a byte el fichero testeado;
 *  - ninguna fuente de la ayuda apunta a GitHub ni a Internet (salvo el enlace
 *    opcional al código fuente).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, CATALOG_VERSION as SEED_CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { PLATFORM_MODES as API_PLATFORM_MODES } from "../../api/src/routes/catalog.js";
import { INITIAL_RATING, DEFAULT_K } from "../../tournament-worker/src/ratings.js";
import { SDK_VERSION } from "../../api/src/services/source-package.js";
import {
  CATALOG,
  CATALOG_VERSION,
  EXAMPLES,
  PLATFORM_MODES,
  VERSIONS,
  ENGINE_RULESETS,
  MODES,
} from "../src/help/sources.js";
import { PROP_NAME, SLOT_NAME, CATEGORY_NAME } from "../src/help/names.js";
import { NON_GAMEPLAY_KEYS } from "../../../packages/module-catalog/effect-status.js";
import { RULESETS } from "../../../packages/game-rules/index.js";
import { MODE_REGISTRY } from "../../arena-engine/src/sim/modes.js";
import { RATING_FACTS } from "../src/help/sections/tournaments.js";
import { HELP_TREE } from "../src/help/tree.js";
import { HELP_CONTENT } from "../src/pages/HelpPage.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("EQ3 fuentes · catálogo", () => {
  it("la ayuda embebe EXACTAMENTE el catálogo que siembra la plataforma", () => {
    const seed = loadCatalog();
    expect(CATALOG.map((m) => `${m.id}@${m.version}`)).toEqual(seed.map((m) => `${m.id}@${m.version}`));
    expect(CATALOG).toEqual(seed);
    expect(CATALOG_VERSION).toBe(SEED_CATALOG_VERSION);
  });

  it("toda ranura, categoría y propiedad de juego del catálogo tiene nombre humano", () => {
    const missingSlots: string[] = [];
    const missingProps: string[] = [];
    for (const m of loadCatalog()) {
      if (!CATEGORY_NAME[m.category]) missingProps.push(`categoría ${m.category}`);
      for (const s of m.slots ?? []) if (!SLOT_NAME[s.id]) missingSlots.push(s.id);
      for (const k of Object.keys(m)) if (!NON_GAMEPLAY_KEYS.has(k) && !PROP_NAME[k]) missingProps.push(k);
      for (const k of Object.keys(m.power ?? {})) if (!PROP_NAME[`power.${k}`]) missingProps.push(`power.${k}`);
    }
    expect(missingSlots).toEqual([]);
    expect(missingProps).toEqual([]);
    // Los ejemplos del encargo.
    expect(SLOT_NAME.mine_bay).toBe("Compartimento de minas");
    expect(SLOT_NAME.armor_rear).toBe("Blindaje trasero");
    expect(SLOT_NAME.turret_main).toBe("Torreta principal");
    expect(SLOT_NAME.drive).toBe("Propulsión");
  });
});

describe("EQ3 fuentes · reglas, modos y rating", () => {
  it("rulesets y registro de modos son los del motor (mismo objeto, no copia)", () => {
    expect(ENGINE_RULESETS).toBe(RULESETS);
    expect(MODES).toBe(MODE_REGISTRY);
  });

  it("PLATFORM_MODES de la ayuda == el de la API", () => {
    expect([...PLATFORM_MODES]).toEqual([...API_PLATFORM_MODES]);
  });

  it("Elo inicial 1000 y K por defecto: los mismos que el worker de ratings", () => {
    expect(RATING_FACTS.initial).toBe(INITIAL_RATING);
    expect(RATING_FACTS.initial).toBe(1000);
    expect(RATING_FACTS.defaultK).toBe(DEFAULT_K);
  });
});

describe("EQ3 fuentes · SDK y versiones", () => {
  it("versiones leídas de sus ficheros reales", () => {
    const py = readFileSync(join(ROOT, "sdks/python/arena_sdk/__init__.py"), "utf8").match(/__version__ = "(.+)"/)![1];
    const js = JSON.parse(readFileSync(join(ROOT, "sdks/javascript/package.json"), "utf8")).version;
    const deps = JSON.parse(readFileSync(join(ROOT, "apps/arena-engine/src/engine-deps.json"), "utf8"));
    expect(VERSIONS.sdkPython).toBe(py);
    expect(VERSIONS.sdkJs).toBe(js);
    expect(VERSIONS.sdkPlatform).toBe(SDK_VERSION);
    expect(VERSIONS.engine).toBe(deps.engine.version);
    expect(VERSIONS.protocol).toBe(deps.protocol);
  });

  it("cada ejemplo es byte a byte el fichero testeado que dice ser", () => {
    const files: Record<string, string> = {
      "py-tutorial": "sdks/python/tests/_tutorial_bot.py",
      "js-tutorial": "sdks/javascript/tests/tutorial-bot.js",
      "py-explorer": "example-bots/python/explorer.py",
      "py-defender": "example-bots/python/defender.py",
      "js-gunner": "example-bots/javascript/gunner.js",
      "js-miner": "example-bots/javascript/miner.js",
    };
    for (const [id, path] of Object.entries(files)) {
      const ex = EXAMPLES.find((e) => e.id === id)!;
      expect(ex, id).toBeTruthy();
      expect(ex.code, id).toBe(readFileSync(join(ROOT, path), "utf8"));
      expect(ex.origin, id).toContain(path);
    }
  });
});

describe("EQ3 fuentes · árbol y offline", () => {
  it("toda hoja del árbol tiene contenido y viceversa", () => {
    const leaves = HELP_TREE.flatMap((g) => g.leaves.map((l) => `${g.id}/${l.id}`));
    expect(new Set(leaves).size).toBe(leaves.length);
    expect(Object.keys(HELP_CONTENT).sort()).toEqual([...leaves].sort());
  });

  it("estructura del encargo: los grupos y hojas pedidos existen", () => {
    const ids = (g: string) => HELP_TREE.find((x) => x.id === g)!.leaves.map((l) => l.id);
    expect(HELP_TREE.map((g) => g.id)).toEqual([
      "inicio",
      "bots",
      "equipamiento",
      "batallas",
      "modos",
      "torneos",
      "mapas",
      "referencia",
    ]);
    expect(ids("bots")).toEqual(
      expect.arrayContaining([
        "conceptos",
        "sdk-python",
        "sdk-javascript",
        "observaciones",
        "comandos",
        "sensores",
        "radio",
        "ejemplos",
      ]),
    );
    expect(ids("equipamiento")).toEqual(
      expect.arrayContaining(["chassis", "movement", "power", "sensor", "weapon", "ammo", "armor", "radio", "otros"]),
    );
    expect(ids("batallas")).toEqual(["nueva", "1v1", "equipos", "respawns", "puntuacion", "desempates"]);
    expect(ids("modos")).toEqual(
      expect.arrayContaining([
        "deathmatch",
        "team_deathmatch",
        "eliminacion",
        "respawn-limitado",
        "capture_the_flag",
        "zone_control",
        "otros",
      ]),
    );
    expect(ids("mapas")).toEqual(["editor", "spawns", "bases", "banderas", "zonas", "muros", "cajas", "validacion"]);
    expect(ids("referencia")).toEqual(["reglas", "catalogo", "protocolo", "versiones"]);
  });

  it("ningún fichero del Centro de Ayuda pide nada a GitHub ni a Internet (sólo el enlace opcional de content.ts)", () => {
    const dir = join(ROOT, "apps/web/src/help");
    const files = [
      ...readdirSync(dir).map((f) => join(dir, f)),
      ...readdirSync(join(dir, "sections")).map((f) => join(dir, "sections", f)),
      join(ROOT, "apps/web/src/pages/HelpPage.tsx"),
    ].filter((f) => /\.(tsx?|css)$/.test(f));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // fetch/import de URL absoluta, o cualquier URL http(s) salvo en content.ts (REPO_URL).
      if (/fetch\(\s*["'`]https?:/.test(src) || /import\(\s*["'`]https?:/.test(src))
        offenders.push(`${f}: fetch/import externo`);
      const urls = src.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
      for (const u of urls) {
        if (f.endsWith("content.ts") && u.startsWith("https://github.com/pjclavero/s9-ai-arena")) continue;
        offenders.push(`${f}: ${u}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

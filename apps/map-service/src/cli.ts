/**
 * CLI del map-service (parte de T4.1): importa un mapa de Tiled al formato interno.
 *
 * Uso:
 *   map-service import <archivo.json> --out <salida.json>
 *
 * IMPORTANTE: `<archivo>` debe ser el JSON EXPORTADO por Tiled ("JSON Map Format"),
 * no el .tmx (XML). Si se pasa un `.tmx` se aborta con un mensaje explicativo: este
 * importador no parsea el XML de Tiled a propósito (ver cabecera de import-tiled.ts).
 *
 * La salida se escribe con `JSON.stringify(map, null, 2) + "\n"` para que el golden
 * file del repo sea estable byte a byte.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { importTiled, type TiledMap } from "./import-tiled.js";

function fail(msg: string): never {
  process.stderr.write(`map-service: ${msg}\n`);
  process.exit(1);
}

export function runCli(argv: string[]): void {
  const [cmd, input, ...rest] = argv;
  if (cmd !== "import") {
    fail(`comando desconocido '${cmd ?? ""}'. Uso: map-service import <archivo.json> --out <salida.json>`);
  }
  if (!input) fail("falta el archivo de entrada. Uso: map-service import <archivo.json> --out <salida.json>");
  if (input.toLowerCase().endsWith(".tmx")) {
    fail(`'${input}' parece un .tmx (XML). Este importador consume el JSON exportado por Tiled; expórtalo como .json.`);
  }

  // Parseo minimalista de --out <ruta>.
  const outIdx = rest.indexOf("--out");
  const out = outIdx >= 0 ? rest[outIdx + 1] : undefined;
  if (!out) fail("falta --out <salida.json>.");

  let tiled: TiledMap;
  try {
    tiled = JSON.parse(readFileSync(input, "utf8")) as TiledMap;
  } catch (e) {
    fail(`no se pudo leer/parsear '${input}': ${(e as Error).message}`);
  }

  const { map, warnings } = importTiled(tiled);
  writeFileSync(out, JSON.stringify(map, null, 2) + "\n");

  for (const w of warnings) process.stderr.write(`  aviso: ${w}\n`);
  process.stdout.write(`OK  ${input} -> ${out}  (${map.checksum}, ${warnings.length} aviso(s))\n`);
}

// Punto de entrada cuando se ejecuta directamente (no cuando se importa como módulo).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.ts")) {
  runCli(process.argv.slice(2));
}

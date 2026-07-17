// R6.1 — Genera el package.json del @arena/sdk COMPILADO que se instala en el runtime
// de bots. El del repo es `private: true` y apunta a `src/index.ts` (TypeScript), que
// Node no puede ejecutar: aquí se reescribe apuntando al JS emitido por tsc.
// Uso: node sdk-package.mjs <package.json del repo> <destino>
import { readFileSync, writeFileSync } from "node:fs";

const [, , src, dest] = process.argv;
const p = JSON.parse(readFileSync(src, "utf8"));

if (!p.dependencies?.ws) {
  console.error("ERROR R6.1: el SDK ya no declara 'ws'; revisa la allowlist del runtime");
  process.exit(1);
}

writeFileSync(
  dest,
  JSON.stringify(
    {
      name: p.name,
      version: p.version,
      type: "module",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      dependencies: { ws: p.dependencies.ws },
    },
    null,
    2,
  ) + "\n",
);
console.log(`SDK empaquetado: ${p.name}@${p.version}`);

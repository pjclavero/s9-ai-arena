#!/usr/bin/env node
/**
 * R-DEPLOY · R5 — comprobación de versión de Node para scripts críticos.
 *
 * La suite zstd de replays usa `zstdCompressSync` (node:zlib), ausente en Node
 * 20: Node 20 NO está soportado. Node objetivo: >=22.15 (ver package.json
 * `engines`). Este guard FALLA CERRADO (exit 1) si la versión es menor, para
 * usarlo en pasos de build/despliegue donde arrancar con Node 20 sería un fallo
 * silencioso. Uso: `node scripts/check-node.mjs`.
 */
const MIN = [22, 15, 0];
const cur = process.versions.node.split(".").map((n) => parseInt(n, 10));

function lt(a, b) {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) < (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) > (b[i] ?? 0)) return false;
  }
  return false;
}

if (lt(cur, MIN)) {
  console.error(
    `[check-node] Node ${process.versions.node} NO soportado. Requiere Node >=${MIN.join(".")} ` +
      `(Node 20 no soporta zstdCompressSync). Instala Node 22.15+ y reintenta.`,
  );
  process.exit(1);
}
console.log(`[check-node] OK: Node ${process.versions.node} (>= ${MIN.join(".")})`);

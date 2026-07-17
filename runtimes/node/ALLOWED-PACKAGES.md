# Allowlist de paquetes · Runtime Node.js (E6 · T6.3 · R6.1)

Únicos paquetes de terceros que un bot Node puede importar. Preinstalados en
`arena/bot-runtime-node` (fijada por digest en `runtimes/DIGESTS.lock`); `npm`/`pnpm`/
`yarn`/`corepack` están deshabilitados en ejecución.

| Paquete | Versión | Origen | Motivo |
|---------|---------|--------|--------|
| `@arena/sdk` | 0.1.0 | **repo (`sdks/javascript`)** | SDK oficial de bots (E5). Obligatorio. |
| `ws` | 8.18.0 | npmjs, con `integrity` real | Cliente WebSocket para el protocolo `arena/1`. |

## Lo que R6.1 corrigió aquí

1. **`@arena/sdk` NO se resuelve desde npmjs.** El scope `@arena` no es nuestro en el
   registro público: pedirlo por nombre era **dependency confusion**. Se compila desde
   `sdks/javascript` en la etapa `sdk-builder` del Dockerfile y se instala desde el árbol
   local, sin tocar el registro.
2. **El SDK de JS nunca se había compilado.** `sdks/javascript` es TypeScript con
   `noEmit: true` y `main: src/index.ts`, y `private: true`: como paquete no era
   instalable (los bots de ejemplo lo importaban por ruta relativa del monorepo). El
   runtime lo emite a JS + `.d.ts` con `tsc` y reescribe su `package.json` apuntando a
   `dist/index.js`.
3. **La versión es `0.1.0`, no `1.0.0`** (la que declara `sdks/javascript/package.json`).
4. **El `integrity` de `ws` era un placeholder de ceros** en `allowed-package-lock.json`:
   `npm ci` no verificaba nada. Ahora es el real del registro.
5. **Los paquetes viven en `/node_modules`, no en `/opt/runtime` con `NODE_PATH`.**
   `NODE_PATH` solo lo respeta CommonJS; el SDK es ESM, así que un `import "@arena/sdk"`
   desde `/bot/main.js` fallaba con `ERR_MODULE_NOT_FOUND`. La resolución ESM sube por los
   `node_modules` de los directorios padre, y desde `/bot` encuentra `/node_modules`.

Fuente de verdad para el pipeline: `apps/bot-manager/src/config.ts`
(`DEFAULT_NODE_ALLOWLIST`). Verificado por `apps/bot-manager/tests/runtimes.test.ts`.

## Proceso para añadir un paquete

Igual que el runtime Python: issue → revisión de seguridad E6 → PR que actualiza esta
tabla, `allowed-package.json` + lockfile (con `integrity` real), `DEFAULT_NODE_ALLOWLIST`
y el digest de `DIGESTS.lock`. CI (incluido el escaneo de vulnerabilidades) debe pasar
antes del merge.

# Allowlist de paquetes · Runtime Node.js (E6 · T6.3)

Únicos paquetes de terceros que un bot Node puede importar. Preinstalados en
`arena/bot-runtime-node` (fijada por digest en `runtimes/DIGESTS.lock`); `npm`/`pnpm`/
`yarn`/`corepack` están deshabilitados en ejecución.

| Paquete | Versión | Motivo |
|---------|---------|--------|
| `@arena/sdk` | 1.0.0 | SDK oficial de bots (E5). Obligatorio. |
| `ws` | 8.18.0 | Cliente WebSocket para el protocolo `arena/1`. |

Fuente de verdad para el pipeline: `apps/bot-manager/src/config.ts`
(`DEFAULT_NODE_ALLOWLIST`). Verificado por `apps/bot-manager/tests/runtimes.test.ts`.

## Proceso para añadir un paquete

Igual que el runtime Python: issue → revisión de seguridad E6 → PR que actualiza esta
tabla, `allowed-package.json` + lockfile, `DEFAULT_NODE_ALLOWLIST` y el digest de
`DIGESTS.lock`. CI (incluido el escaneo de vulnerabilidades) debe pasar antes del merge.

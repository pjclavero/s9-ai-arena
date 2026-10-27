# runtimes

Imágenes de runtime en las que se ejecuta el código de los bots, tanto en el build (sandbox)
como en las batallas. Propietario: E6 (Sandbox). Las imágenes se referencian siempre por
**digest**, nunca por tag, y no permiten instalar nada en ejecución (`pip`, `npm`, `pnpm`,
`yarn` y `corepack` deshabilitados).

| Fichero | Qué es |
|---|---|
| [`DIGESTS.lock`](DIGESTS.lock) | Digests fijados de la imagen base y de la imagen de runtime de cada lenguaje. Los publica `.github/workflows/runtimes-publish.yml` y los verifica la CI (`scripts/verify-runtime-digests.ts`) |
| [`python/Dockerfile`](python/Dockerfile) | Runtime `python`: base fijada por digest, allowlist de paquetes con hash y el SDK `arena-sdk` construido desde `sdks/python` |
| [`python/ALLOWED-PACKAGES.md`](python/ALLOWED-PACKAGES.md) | Únicos paquetes de terceros que puede importar un bot Python |
| `python/allowed-requirements.lock`, `python/sdk-wheel.lock` | Requisitos con hash y hash del wheel del SDK |
| [`node/Dockerfile`](node/Dockerfile) | Runtime `node`: base fijada por digest, allowlist con `integrity` y el SDK `@arena/sdk` compilado desde `sdks/javascript` (nunca desde npmjs) |
| [`node/ALLOWED-PACKAGES.md`](node/ALLOWED-PACKAGES.md) | Únicos paquetes de terceros que puede importar un bot Node |
| `node/allowed-package.json`, `node/allowed-package-lock.json`, `node/sdk-package.mjs`, `node/tsconfig.sdk-runtime.json` | Allowlist con su lock y empaquetado del SDK compilado |

El runtime `node` ejecuta **JavaScript ESM plano**: el código TypeScript se rechaza en la
etapa `static_analysis` del build. Ambos SDK (versión 0.1.0) vienen preinstalados en su
runtime; no están publicados en npm ni en PyPI.

Cómo se construye y se fija un runtime: cabecera de [`DIGESTS.lock`](DIGESTS.lock). Uso en el
build y en las batallas: [docs/technical/bots.md](../docs/technical/bots.md).

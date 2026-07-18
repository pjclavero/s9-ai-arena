# Allowlist de paquetes · Runtime Python (E6 · T6.3 · R6.1)

Estos son los ÚNICOS paquetes de terceros que un bot Python puede importar. Están
preinstalados en la imagen `arena/bot-runtime-python` (fijada por digest en
`runtimes/DIGESTS.lock`) y `pip` está deshabilitado en ejecución: no se puede instalar
nada más dentro del contenedor.

| Paquete | Versión | Import | Origen | Motivo |
|---------|---------|--------|--------|--------|
| `arena-sdk` | 0.1.0 | `arena_sdk` | **repo (`sdks/python`)** | SDK oficial de bots (E5). Obligatorio. |
| `numpy` | 1.26.4 | `numpy` | PyPI, con hash | Álgebra/vectores para heurísticas de bot. |
| `websocket-client` | 1.8.0 | `websocket` | PyPI, con hash | Transporte del protocolo `arena/1` (lo usa el SDK). |

## Tres cosas que R6.1 corrigió aquí (no son detalles)

1. **`arena-sdk` NO se resuelve desde PyPI.** Es el SDK propio del repo. Pedirlo por
   nombre al registro público sería **dependency confusion**: cualquiera puede publicar un
   `arena-sdk` en PyPI y acabaría dentro del runtime. Se construye desde `sdks/python` en
   la etapa `sdk-builder` del Dockerfile y se instala desde el wheel local con
   `--no-index`, con su sha256 fijado en `runtimes/python/sdk-wheel.lock`.
2. **La versión es `0.1.0`, no `1.0.0`.** Es la que declara `sdks/python/pyproject.toml`
   (y `sdks/javascript/package.json`). El `1.0.0` de esta tabla era ficción del MVP: no
   existía ningún artefacto con esa versión.
3. **El paquete es `websocket-client`, no `websockets`.** Son paquetes DISTINTOS. El SDK
   hace `import websocket` y su `pyproject.toml` depende de `websocket-client>=1.7,<2`.
   `websockets` no lo usa nadie. Como el módulo (`websocket`) no se llama igual que el
   paquete, la traducción vive en `static-analysis.ts` (`PYTHON_IMPORT_TO_DIST`).

La lista de la plataforma (fuente de verdad para el pipeline) está en
`apps/bot-manager/src/config.ts` (`DEFAULT_PYTHON_ALLOWLIST`). El test
`apps/bot-manager/tests/runtimes.test.ts` verifica que ambas coinciden, y que `arena-sdk`
se construye desde el repo en vez de resolverse del registro.

## Proceso para añadir un paquete

1. Abrir un **issue** con: paquete, versión exacta, motivo, y por qué no se puede resolver
   con la stdlib o la allowlist actual.
2. **Revisión de seguridad** (equipo E6): licencia, mantenimiento, CVEs conocidos,
   superficie (¿red?, ¿ejecución de código?, ¿binarios nativos?), tamaño.
3. Si se aprueba: PR que actualiza (a) esta tabla, (b) `allowed-requirements.lock` con el
   hash real del paquete, (c) `DEFAULT_PYTHON_ALLOWLIST` en `config.ts`, (d) reconstrucción
   de la imagen y nuevo digest en `DIGESTS.lock`. CI debe pasar (incluido el escaneo de
   vulnerabilidades) antes del merge.

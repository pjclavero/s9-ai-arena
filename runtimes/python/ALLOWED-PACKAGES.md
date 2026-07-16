# Allowlist de paquetes · Runtime Python (E6 · T6.3)

Estos son los ÚNICOS paquetes de terceros que un bot Python puede importar. Están
preinstalados en la imagen `arena/bot-runtime-python` (fijada por digest en
`runtimes/DIGESTS.lock`) y `pip` está deshabilitado en ejecución: no se puede instalar
nada más dentro del contenedor.

| Paquete | Versión | Motivo |
|---------|---------|--------|
| `arena-sdk` | 1.0.0 | SDK oficial de bots (E5). Obligatorio. |
| `numpy` | 1.26.4 | Álgebra/vectores para heurísticas de bot. |
| `websockets` | 12.0 | Transporte del protocolo `arena/1` (usado por el SDK). |

La lista de la plataforma (fuente de verdad para el pipeline) está en
`apps/bot-manager/src/config.ts` (`DEFAULT_PYTHON_ALLOWLIST`). El test
`apps/bot-manager/tests/runtimes.test.ts` verifica que ambas coinciden.

## Proceso para añadir un paquete

1. Abrir un **issue** con: paquete, versión exacta, motivo, y por qué no se puede resolver
   con la stdlib o la allowlist actual.
2. **Revisión de seguridad** (equipo E6): licencia, mantenimiento, CVEs conocidos,
   superficie (¿red?, ¿ejecución de código?, ¿binarios nativos?), tamaño.
3. Si se aprueba: PR que actualiza (a) esta tabla, (b) `allowed-requirements.lock` con el
   hash del paquete, (c) `DEFAULT_PYTHON_ALLOWLIST` en `config.ts`, (d) reconstrucción de
   la imagen y nuevo digest en `DIGESTS.lock`. CI debe pasar (incluido el escaneo de
   vulnerabilidades) antes del merge.

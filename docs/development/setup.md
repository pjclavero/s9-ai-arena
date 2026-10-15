# Entorno de desarrollo

## Resumen

Cómo preparar una máquina para desarrollar y ejecutar los tests de S9 AI Arena: Node exacto,
`npm ci`, PostgreSQL embebido (no hace falta instalar PostgreSQL ni Docker), Python para el SDK y,
opcionalmente, Docker (incluido el modo rootless) para las suites que levantan contenedores.

## Índice

- [Requisitos](#requisitos)
- [Instalación](#instalación)
- [PostgreSQL embebido](#postgresql-embebido)
- [Python y el SDK](#python-y-el-sdk)
- [Docker (opcional)](#docker-opcional)
- [Arrancar servicios en local](#arrancar-servicios-en-local)
- [Errores / limitaciones](#errores--limitaciones)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Requisitos

| Herramienta | Versión | Notas |
|---|---|---|
| Node.js | **≥ 22.15** (`engines`; la CI usa `22.15`) | Node 20 **no** está soportado: falta `zstdCompressSync` y fallan los tests de replays |
| npm | el que trae Node | el monorepo usa **npm workspaces** y `package-lock.json` |
| Python | ≥ 3.10 (la CI usa 3.12) | SDK Python y algunos tests cruzados |
| Git | — | — |
| Docker / Docker rootless | opcional | E2E de backup/restore, imágenes, sandbox |

Comprobación: `npm run check:node` (sale con 1 si Node < 22.15).

## Instalación

```bash
git clone https://github.com/pjclavero/s9-ai-arena.git
cd s9-ai-arena
npm run check:node
npm ci
npm run typecheck && npm run lint
npm run test:pure          # rápido, sin base de datos
```

`npm ci` instala todo lo necesario, incluido `embedded-postgres`, `tsx`, `vitest`, `typescript` y
`prettier`. No hay paso de compilación de los servicios: se ejecutan con `tsx`. La web se compila con
Vite sólo al construir su imagen.

`pnpm-workspace.yaml` es un resto del prototipo v1 y **no** se usa: los workspaces son los de
`package.json` (`packages/*`, `sdks/javascript`).

## PostgreSQL embebido

Los tests que tocan base de datos (`startTestDb()` de `apps/api/src/testing/test-db.ts`) arrancan un
PostgreSQL **real** a nivel de usuario con `embedded-postgres` (descarga los binarios oficiales en
`node_modules`, sin root), aplican las mismas migraciones que producción y lo destruyen al terminar
(ADR-E7-002).

- No hay que instalar nada más.
- Alternativa: con `DATABASE_URL` definida, los tests usan ese servidor y crean una base de datos
  efímera por test (útil en Windows, donde el embebido no arranca).
- Los tests de BD activan `ARENA_DEV_INSECURE_SECRETS=1` para firmar tokens con un secreto efímero.

## Python y el SDK

```bash
python3 -m venv sdks/python/.venv
sdks/python/.venv/bin/python -m pip install -e 'sdks/python[dev]'
(cd sdks/python && .venv/bin/python -m pytest tests/ -q)
```

Las suites lentas cruzadas (CTF 2v2 con bots Python) esperan el venv en `sdks/python/.venv`
o `PYTHON_BIN` apuntando a un intérprete con `arena-sdk` instalado.

## Docker (opcional)

Sólo para: `infrastructure/tests/backup-sftp-e2e.test.ts`, `restore-sftp-bootstrap.test.ts`, los
contratos de imagen (`verify-image-provenance.mjs`), la suite de escape del sandbox y validar el
stack en local. Docker rootless sirve para todo lo anterior y para levantar el stack en un proyecto
aislado (nombre de proyecto y puertos propios, nunca contra producción):

```bash
cp infrastructure/.env.example /tmp/dev.env      # y fija TAG/BACKUP_TAG=sha-<commit>, HTTP_PORT=18080, GATEWAY_CONF=nginx-behind-proxy.conf
bash infrastructure/scripts/init-secrets.sh
docker compose -p s9dev -f infrastructure/docker-compose.yml --env-file /tmp/dev.env --profile production up -d --no-build postgres queue api web gateway
```

Con Docker rootless el uid de los contenedores no coincide con el del host: puede hacer falta
relajar los permisos de los secretos **sólo en ese entorno de prueba**. Algunos tests usan
`unshare -rm` (espacios de nombres de usuario sin privilegios); si tu sistema los restringe
(AppArmor), fallarán por esa causa.

## Arrancar servicios en local

Cada servicio es un entrypoint TypeScript (ver `SERVICE_ENTRY` en el compose). Ejemplo de la API
contra el PostgreSQL de un stack local:

```bash
DATABASE_URL=postgres://arena:<password>@127.0.0.1:5432/arena ARENA_DEV_INSECURE_SECRETS=1 \
  npx tsx apps/api/src/db/cli.ts bootstrap
DATABASE_URL=… ARENA_DEV_INSECURE_SECRETS=1 PORT=8080 npx tsx apps/api/src/server.ts
```

Para desarrollo **sí** se puede usar `cli.ts seed` (crea usuarios de desarrollo con contraseñas
conocidas); nunca en una instalación real.

## Errores / limitaciones

| Síntoma | Causa | Remedio |
|---|---|---|
| `zstdCompressSync is not a function` | Node 20 | Node ≥ 22.15 |
| El PG embebido no arranca (Windows) | `pg_ctl` | `DATABASE_URL` a un PostgreSQL propio |
| `spawn ENOENT` en el CTF 2v2 | falta `sdks/python/.venv` | crear el venv o `PYTHON_BIN` |
| Tests con `unshare` en rojo | userns sin privilegios restringido | habilitarlos o asumir el rojo localmente |

## Documentación relacionada

[testing.md](testing.md) · [repository.md](repository.md) · [workflow.md](workflow.md) ·
[../operations/installation.md](../operations/installation.md) ·
[ADR-E7-002](../adr/ADR-E7-002-postgres-embebido-en-tests.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| `engines >=22.15`; CI `NODE_VERSION: "22.15"`; `check:node` | CODE_VERIFIED | `package.json`; `.github/workflows/ci.yml:33`; `scripts/check-node.mjs` |
| `check-node.mjs` rechaza Node 20 | RUNTIME_VERIFIED | ejecutado en la máquina de desarrollo con Node 20.19.2 → exit 1 |
| Workspaces `packages/*`, `sdks/javascript`; `pnpm-workspace.yaml` sin uso | CODE_VERIFIED | `package.json`; ningún script usa pnpm |
| PG embebido + fallback `DATABASE_URL` + `ARENA_DEV_INSECURE_SECRETS` | CODE_VERIFIED | `apps/api/src/testing/test-db.ts:1-30` |
| Instalación del SDK Python como en la CI | CODE_VERIFIED | `.github/workflows/ci.yml` job `contracts`; `sdks/python/pyproject.toml` |
| Stack aislado con Docker rootless | RUNTIME_VERIFIED | entorno aislado de esta consolidación (proyecto propio, puerto 18080) |

# Primeros pasos — ejecutar la suite de tests

Guía mínima para poner en marcha la suite de S9 AI Arena en cualquier sistema,
incluido Windows. Nace de R2.3 (ERR-GES-04): la suite mezclaba tests puros con
tests que arrancan PostgreSQL embebido, y en Windows estos últimos rompían la
ejecución completa.

## Requisitos

- **Node.js 20 o superior.** Con Node < 22.15 hay un fallo conocido y aceptado:
  1 test de `zstd` en `replay-golden.test.ts` (la descompresión zstd nativa de
  Node llega en 22.15).
- `npm install` en la raíz del repo.
- **Para los tests de base de datos**: PostgreSQL. En Linux/macOS no hay que
  instalar nada (ver abajo); en Windows sí.

## Las dos mitades de la suite

La suite se divide según dependa o no de PostgreSQL:

| Comando | Qué ejecuta | Necesita PostgreSQL |
|---|---|---|
| `npm test` | Toda la suite (pura + BD) | Sí |
| `npm run test:pure` | Motor, validadores, SDK, catálogo… | No |
| `npm run test:db` | Los tests que usan `startTestDb` (API, workers, E2E…) | Sí |

El reparto **no es una lista manual**: `scripts/list-db-tests.mjs` escanea los
ficheros de test y etiqueta como "de BD" los que usan `startTestDb`
(`apps/api/src/testing/test-db.ts`), exactamente el criterio por el que fallan
sin PostgreSQL. Un test nuevo que llame a `startTestDb` cambia de suite solo.
Si el escaneo no encontrara ninguno, `test:db` falla en vez de dar un verde
vacío.

## Los tests de BD: dos caminos

Los tests de BD corren siempre contra **PostgreSQL real** (mismo SQL de
migraciones que producción, cap. 6.2 y ADR-E7-002). Cómo se consigue ese
PostgreSQL depende del sistema:

### Linux / macOS — embebido, sin instalar nada

Por defecto `startTestDb` usa `embedded-postgres`: descarga binarios oficiales
de PostgreSQL y arranca un clúster efímero a nivel de usuario, sin root y sin
Docker. No hay que configurar nada:

```sh
npm run test:db     # o npm test para todo
```

### Windows — PostgreSQL externo vía `DATABASE_URL`

**Motivo:** en Windows `embedded-postgres` no consigue arrancar el clúster
(`pg_ctl` falla, ERR-GES-04), así que el camino embebido no está disponible.
En su lugar, apunta los tests a un PostgreSQL real tuyo con la variable
`DATABASE_URL`; puede ser un contenedor o un servicio local:

```powershell
# Opción A: contenedor
docker run -d --name arena-test-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18

# Opción B: servicio local de PostgreSQL ya instalado (usa tus credenciales)

$env:DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/postgres"
npm run test:db
```

Con `DATABASE_URL` definida, `startTestDb` **no** intenta el embebido: se
conecta a ese servidor, crea una base de datos efímera con nombre único por
test (`arena_test_<aleatorio>`), aplica las migraciones y la borra al terminar.
El usuario de la URL necesita permiso `CREATEDB`. Varios ficheros de test
corren en paralelo sin pisarse porque cada uno usa su propia base de datos.

`DATABASE_URL` también funciona en Linux/macOS si prefieres tu propio servidor
al embebido (por ejemplo, para acelerar la suite reutilizando un clúster ya
arrancado).

### Windows sin PostgreSQL

Si no tienes PostgreSQL a mano, ejecuta solo la parte pura:

```sh
npm run test:pure
```

Eso cubre motor, validadores y SDK en verde; los tests de BD quedan
**pendientes**, no aprobados: repórtalos como omitidos (regla de la Ronda 2:
lo no verificable falla cerrado, nunca se da por bueno).

# Runbook · Contenido base de una instancia

Una instancia recién desplegada tiene el esquema creado pero **sin contenido**: no hay
catálogo de módulos, ni ruleset, ni mapas. Con la BD así, el editor de loadout avisa de
que «el catálogo de módulos no está disponible o no contiene ningún chasis»
(`ERR-VIS-04`), que es su comportamiento correcto ante un catálogo vacío.

## Diagnóstico

```sh
docker exec <postgres> psql -U arena -d arena -tAc \
  "select 'catalog_versions', count(*) from catalog_versions
   union all select 'module_definitions', count(*) from module_definitions
   union all select 'rulesets', count(*) from rulesets
   union all select 'map_versions', count(*) from map_versions;"
```

Si esas cuatro cuentas son `0`, falta el contenido base.

## Solución

Desde el contenedor de la API, con el repo montado en `/app`:

```sh
docker exec -w /app <contenedor-api> npx tsx apps/api/src/db/cli.ts bootstrap
```

Aplica migraciones pendientes y luego el contenido base: ruleset por defecto, catálogo de
módulos y mapa MVP publicado. Es **idempotente**: repetirlo no duplica nada.

## No usar `seed` en un entorno real

```sh
# ❌ NO en producción
npx tsx apps/api/src/db/cli.ts seed
```

`seed` incluye `bootstrap` **y además crea siete usuarios, uno por rol, con una contraseña
conocida y escrita en el repositorio**. En una instancia accesible desde fuera eso es un
acceso administrativo abierto. `seed` es solo para desarrollo local y CI.

## Qué desbloquea (y qué no)

`bootstrap` deja utilizable el editor de loadout y la creación de bots. **No** habilita la
ejecución real de batallas ni el espectador público: ambos siguen tras sus flags
(`S9_ENABLE_REAL_BATTLE_RUNS`, `S9_PUBLIC_SPECTATE_ENABLED`), apagadas por defecto y con
activación reservada al operador.

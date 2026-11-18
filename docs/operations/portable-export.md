# Export e import portable de bots y equipos

## Resumen

Herramienta de línea de comandos (`scripts/portable/portable.mjs`, Node >= 20, sin dependencias) que **copia los
bots y los equipos de un usuario** de una instalación de S9 AI Arena a un directorio autocontenido y los
**reconstruye** en otra instalación, siempre a través de la API (la propiedad, el validador de loadouts y los
límites los aplica la propia aplicación). Sirve para reinstalar desde cero conservando sólo lo que importa.

No migra: batallas, replays, torneos, rankings, estadísticas, usuarios, sesiones, roles, mapas, rulesets ni la
configuración de streaming. Eso se recrea en la instalación nueva.

## Índice

- [Qué se exporta](#qué-se-exporta)
- [Formato (formatVersion 1)](#formato-formatversion-1)
- [Qué versiones se exportan](#qué-versiones-se-exportan)
- [Uso](#uso)
- [Qué hace el import](#qué-hace-el-import)
- [Garantías y límites](#garantías-y-límites)
- [Errores frecuentes](#errores-frecuentes)
- [Verificación](#verificación)

## Qué se exporta

Del usuario autenticado:

| Dato | Se exporta | Observación |
|---|---|---|
| Bots propios (también los retirados) | sí | nombre, visibilidad, marca de retirado |
| Revisiones de loadout | las de las versiones exportadas y la más reciente | chasis, módulos y munición, nombre y catálogo; el loadout incluye la radio |
| Versiones de código | según la política (ver abajo) | los bytes exactos subidos, runtime, revisión de loadout, versión padre, código público sí/no, estado original |
| Equipos de los que es capitán | sí | nombre y bots propios del equipo (por slug) |
| Miembros de equipo que no son el operador | **no** | las cuentas no se migran: el export sólo cuenta cuántos hay y sus roles; hay que volver a invitarlos |
| Bots de otros usuarios en un equipo | **no** | sólo queda su nombre en `externalBots` |
| Equipos de los que sólo es miembro | **no** | se avisa en `manifest.warnings` |

La «estrategia» de un equipo no es un dato aparte: vive en el código de sus bots, que sí viaja. La radio es un
módulo del loadout y viaja con él. Los artefactos compilados no se exportan: se **reconstruyen** al importar.

## Formato (formatVersion 1)

```
portable-export/
  manifest.json          formatVersion, sourceSha, engineVersion, createdAt, versionsPolicy, catalogVersions,
                         counts, omittedVersions, warnings y files[] {path, sha256, bytes}
  checksums.sha256       formato de sha256sum -c: «<sha256>␣␣<ruta>» de TODOS los ficheros, incluido manifest.json
  bots/<slug>/bot.json   name, visibility, retired, loadouts[], versions[] (con source.file/filename/sha256/bytes)
  bots/<slug>/versions/v<N>/source.bin   los bytes del código tal cual se subieron
  teams/<slug>.json      name, operatorRole, bots[] (slugs), externalBots[], otherMembers {count, roles}
```

- El `slug` sale del nombre (`[a-z0-9-]`, único y determinista); el nombre original va dentro del JSON.
- Todo el JSON es canónico (claves ordenadas): el mismo contenido da los mismos bytes y los mismos hashes.
- **Sin secretos ni datos personales**: ni correos, ni contraseñas, ni tokens, ni ids internos (no hay ningún UUID
  en los metadatos), ni claves de streaming. El export escanea sus propios ficheros al terminar y **aborta** si
  encuentra algo; el código de los bots sólo se rechaza por credenciales de alta confianza (JWT, clave PEM,
  `Bearer`, tokens de proveedor, destinos de streaming).
- Verificable a mano: `cd portable-export && sha256sum -c checksums.sha256`.
- El directorio se escribe con un marcador `.export-incomplete` que sólo se borra tras verificarlo entero; un
  export interrumpido o fallido **no se puede importar**.

### Compatibilidad

`formatVersion` distinta de la que lee la herramienta (1) ⇒ error. `engineVersion` se compara con el motor del
destino: ambos deben figurar en `SUPPORTED_ENGINE_VERSIONS` (`scripts/portable/lib/format.mjs`: 0.3.0, 0.4.0,
0.5.0) y el export no puede ser de un motor **más nuevo** que el destino. Al subir el motor hay que ampliar esa
lista a mano tras comprobar que el catálogo y el protocolo siguen siendo compatibles.

## Qué versiones se exportan

Política `heads` (por defecto) para cada bot:

1. **La cabeza jugable**: la última versión `published`; si no hay, la última `frozen`, `validated`, `suspended`
   o `retired`, por ese orden.
2. **La última en borrador** (`draft`), exista o no una publicada (es el trabajo en curso del operador).
3. La última `rejected`/`validating` sólo si es posterior a todo lo anterior.

Todo bot con alguna versión exporta al menos una. Las omitidas quedan listadas en `manifest.omittedVersions`
(bot, versión, estado). Justificación: las versiones anteriores sólo servían a las batallas y rankings, que no se
migran; lo que se pierde es el historial de versiones antiguas del código. Si se quiere conservarlo,
`--versions all` exporta todas. Si la versión padre de una exportada no está en el export, se anota como
`parentVersionOmitted` y el padre queda vacío al importar.

## Uso

Las credenciales **nunca** van por argumentos: fichero con permisos `0600` o stdin.

```bash
# credenciales: JSON {"email": "...", "password": "..."[, "totp": "..."]}  (0600)  o un token de acceso (0600)
export S9_API_URL=https://<host>/api/v1
export S9_CREDENTIALS_FILE=/ruta/segura/credenciales.json

# 1) EXPORT (sólo lectura). --engine-version es el motor del ORIGEN y es obligatorio: no se adivina.
node scripts/portable/portable.mjs export --out /mnt/backup/portable-export --engine-version 0.5.0 [--source-sha <sha>] [--versions heads|all]

# 2) comprobación sin red (en cualquier máquina que tenga el disco)
node scripts/portable/portable.mjs verify /mnt/backup/portable-export
( cd /mnt/backup/portable-export && sha256sum -c checksums.sha256 )

# 3) IMPORT en la instalación nueva, con el usuario nuevo (rol developer o superior; admin sirve)
export S9_API_URL=https://<host-nuevo>/api/v1
export S9_CREDENTIALS_FILE=/ruta/segura/credenciales-nuevas.json
node scripts/portable/portable.mjs import --from /mnt/backup/portable-export --dry-run --report /tmp/plan.json
node scripts/portable/portable.mjs import --from /mnt/backup/portable-export --report /tmp/correspondencias.json
```

Opciones del import:

| Opción | Efecto |
|---|---|
| `--dry-run` | verifica el export y lee el destino; no escribe nada. Sin credenciales hace una verificación offline |
| `--submit` | **encola la validación (build)** de las versiones que estaban `published`/`frozen`/`validated`; no publica |
| `--restore-visibility` | restaura la visibilidad de los bots y el código público (por defecto todo queda privado) |
| `--target-engine <x.y.z>` | motor del destino (por defecto, el del checkout de la herramienta) |
| `--report <fichero>` | informe de correspondencias slug → id nuevo (JSON, `0600`) |
| `--rate-limit-wait-max <s>` | cuánto esperar ante un 429 antes de abandonar (por defecto 65 min) |

Salida: `0` todo bien; `1` fallo (export corrupto, formato o motor incompatibles, error de API o elementos con
error en el informe).

### Reconstruir y publicar

El import deja **todas las versiones en `draft`** y no publica nada. Para dejar el rebuild listo, `--submit`
encola la validación de lo que estaba publicado; cuando los builds terminen, publicar es una acción del operador
(`POST /bots/{id}/versions/{n}/actions/publish`, o desde la web) usando el informe de correspondencias.

La API limita la creación de versiones y el encolado de builds a **60 por hora y usuario**. Con más de 60 el
import espera (`429`) y sigue solo; si se agota la espera máxima, basta **repetir el mismo comando**: el import es
idempotente y continúa donde se quedó.

## Qué hace el import

1. **Antes de tocar nada** (sin red y sin credenciales): comprueba que no esté marcado como incompleto, los
   checksums de todos los ficheros contra el disco, que no sobren ni falten ficheros, `formatVersion`,
   `engineVersion`, los recuentos y las referencias (revisión de loadout de cada versión, versión padre, bots de
   cada equipo). Un export corrupto falla aquí, con cero peticiones al destino.
2. Lee el estado del destino (bots, equipos del usuario).
3. Por cada bot: lo crea (privado) o lo reutiliza si ya existe uno **con el mismo nombre del mismo usuario**;
   crea las revisiones de loadout que falten (comparando por contenido) pasando por el validador de la aplicación;
   sube cada versión como `draft` con el mismo runtime, loadout y padre, y comprueba que el hash del código en el
   destino es el exportado. Después aplica `retired` (y, con `--restore-visibility`, visibilidad y código público).
4. Por cada equipo: lo crea (el usuario queda capitán) o lo reutiliza si ya es capitán, y añade sus bots. Un
   equipo con un nombre ya usado por otro usuario se informa como bloqueado.

Las revisiones de loadout y los números de versión **cambian** en el destino (son consecutivos de nuevo); el
informe da la correspondencia. Dos versiones con idéntico código, runtime y loadout se fusionan en una.

## Garantías y límites

- Idempotente: repetir el import no duplica bots, loadouts, versiones ni equipos.
- Un fallo en un bot no detiene los demás; todo fallo queda en el informe y en el código de salida. Un equipo
  cuyo bot falló se marca incompleto.
- Los miembros no migran: los equipos importados sólo tienen al usuario nuevo como capitán.
- Si un loadout ya no valida en el destino (catálogo o presupuesto cambiados) la API lo rechaza y la herramienta
  lo cuenta como error; no se fuerza nada.

## Errores frecuentes

| Síntoma | Causa | Qué hacer |
|---|---|---|
| `checksum_mismatch`, `unlisted_file`, `missing_file` | el disco o la copia se corrompió | repetir la copia o el export; no se importa nada |
| `incomplete` | export interrumpido | repetir el export en un directorio vacío |
| `engine_newer_than_target` / `engine_unsupported` | el destino es de un motor anterior o no soportado | desplegar el motor correcto o ampliar `SUPPORTED_ENGINE_VERSIONS` tras revisar |
| `rate_limited` | más de 60 versiones por hora | repetir el comando más tarde |
| HTTP 403 al crear versiones | el usuario nuevo no tiene rol `developer` o superior | promoverlo |
| `team_name_taken` / equipo «blocked» | ese nombre de equipo pertenece a otro usuario | renombrar en el JSON del export o liberar el nombre |

## Verificación

| Qué | Cómo |
|---|---|
| Formato y seguridad | `apps/api/src/portable-format.test.ts` |
| Round-trip origen → destino nuevo contra la API real | `apps/api/src/portable-roundtrip.test.ts` |
| Calibración (mutantes) | `python3 scripts/portable/mutants.py` (sólo en el laboratorio) |

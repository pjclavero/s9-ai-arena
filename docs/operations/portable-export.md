# Export e import portable de bots y equipos

## Resumen

Herramienta de línea de comandos (`scripts/portable/portable.mjs`, Node >= 20, sin dependencias) que **copia los
bots y los equipos de un usuario** de una instalación de S9 AI Arena a un directorio autocontenido y los
**reconstruye** en otra instalación, siempre a través de la API (la propiedad, el validador de loadouts y los
límites los aplica la propia aplicación). Sirve para reinstalar desde cero conservando sólo lo que importa.

No migra: batallas, replays, torneos, rankings, estadísticas, usuarios, sesiones, roles, mapas, rulesets ni la
configuración de streaming. Eso se recrea en la instalación nueva.

La herramienta se ejecuta **fuera** de la máquina de producción, contra su API: no necesita Node ni nada
instalado allí.

## Índice

- [Qué se exporta](#qué-se-exporta)
- [Formato (formatVersion 1)](#formato-formatversion-1)
- [Qué versiones se exportan](#qué-versiones-se-exportan)
- [Uso](#uso)
- [Runbook de migración (reinstalación desde cero)](#runbook-de-migración-reinstalación-desde-cero)
- [Autenticación de larga duración y 2FA](#autenticación-de-larga-duración-y-2fa)
- [Qué hace el import](#qué-hace-el-import)
- [Garantías y límites](#garantías-y-límites)
- [Errores frecuentes](#errores-frecuentes)
- [Verificación](#verificación)

## Qué se exporta

Del usuario autenticado:

| Dato | Se exporta | Observación |
|---|---|---|
| Bots propios (también los retirados) | sí | nombre, visibilidad, marca de retirado |
| Revisiones de loadout | las de las versiones exportadas y la más reciente | chasis, módulos y munición, nombre y catálogo; el loadout incluye la radio. Las demás **se listan** en `manifest.omittedLoadouts` (bot y revisión) |
| Versiones de código | **todas** por defecto (ver abajo) | los bytes exactos subidos, runtime, revisión de loadout, versión padre, código público sí/no, estado original |
| Equipos de los que es capitán | sí | nombre y bots propios del equipo (por slug) |
| Miembros de equipo que no son el operador | **no** | las cuentas no se migran: el export sólo cuenta cuántos hay y sus roles; hay que volver a invitarlos |
| Bots de otros usuarios en un equipo | **no** | sólo queda su nombre en `externalBots` |
| Equipos de los que sólo es miembro | **no** | se avisa en `manifest.warnings`, y `manifest.botsInForeignTeams` lista **qué bots propios** (por slug, con el nº de equipos) pertenecían a ellos: esa pertenencia hay que rehacerla con el capitán. No se guarda el nombre del equipo ni dato alguno de otros usuarios |

La «estrategia» de un equipo no es un dato aparte: vive en el código de sus bots, que sí viaja. La radio es un
módulo del loadout y viaja con él. Los artefactos compilados no se exportan: se **reconstruyen** al importar.
Tampoco viajan `created_at`, los motivos de rechazo o suspensión ni `published_at`.

## Formato (formatVersion 1)

```
portable-export/
  manifest.json          formatVersion, sourceSha, engineVersion, engineVersionSource, createdAt, versionsPolicy,
                         catalogVersions, counts, omittedVersions, omittedLoadouts, botsInForeignTeams, warnings
                         y files[] {path, sha256, bytes}
  checksums.sha256       formato de sha256sum -c: «<sha256>␣␣<ruta>» de TODOS los ficheros, incluido manifest.json
  bots/<slug>/bot.json   name, visibility, retired, loadouts[], versions[] (con source.file/filename/sha256/bytes)
  bots/<slug>/versions/v<N>/source.bin   los bytes del código tal cual se subieron
  teams/<slug>.json      name, operatorRole, bots[] (slugs), externalBots[], otherMembers {count, roles}
```

- El `slug` sale del nombre (`[a-z0-9-]`, único y determinista); el nombre original va dentro del JSON.
- Todo el JSON es canónico (claves ordenadas): el mismo contenido da los mismos bytes y los mismos hashes.
- **Sin secretos ni datos personales**: ni correos, ni contraseñas, ni tokens, ni ids internos (no hay ningún UUID
  en los metadatos), ni claves de streaming. El export escanea sus propios ficheros (**manifest incluido**) al
  terminar y **aborta** si encuentra algo; el código de los bots sólo se rechaza por credenciales de alta
  confianza (JWT, clave PEM, `Bearer`, tokens de proveedor, destinos de streaming).
  - **Nombres que parecen un correo o un UUID**: el nombre de un bot, de un equipo o de un loadout lo escribe el
    usuario y puede parecerse a un correo (`ana@club.es`) o a un UUID. Ese texto libre (campos `name` y los
    avisos del manifest) **no** dispara el escáner de correo/UUID; y si el nombre es un UUID, el slug se escribe
    sin guiones para que la ruta tampoco lo imite. Una credencial de alta confianza (JWT, PEM, Bearer…) o un valor
    sensible conocido (el correo, el id o el token de la sesión) dentro de un nombre **sí** aborta.
- Verificable a mano: `cd portable-export && sha256sum -c checksums.sha256`.
- El directorio se escribe con un marcador `.export-incomplete` que sólo se borra tras verificarlo entero; un
  export interrumpido o fallido **no se puede importar**.
- **El export no se edita a mano.** Cambiar cualquier byte (un nombre de equipo en un JSON, un bot que sobra…)
  rompe los checksums y el import lo rechaza, a propósito. Si hay que cambiar algo, se **rehace el export** desde
  el origen (o se corrige en el destino, ver «Errores frecuentes»).

### Topes de tamaño

`verifyExport` (y por tanto `verify` e `import`) mira el tamaño en disco **antes** de leer nada a memoria y
rechaza un export que se pase de:

| Tope | Por defecto | Opción |
|---|---|---|
| Por fichero (código de bot, `bot.json`, equipos) | 10 MiB (el máximo que admite la API para un código) | `--max-file-mb N` |
| `manifest.json` y `checksums.sha256` | 64 MiB | (fijo) |
| Total del export | 2 GiB | `--max-total-mb N` |

Un export normal está muy por debajo (unas decenas de ficheros pequeños). Superar un tope da `file_too_large` o
`export_too_large`: es señal de un export corrupto o ajeno, no de «subir el límite».

### Compatibilidad

`formatVersion` distinta de la que lee la herramienta (1) ⇒ error. `engineVersion` se compara con el motor del
destino: ambos deben figurar en `SUPPORTED_ENGINE_VERSIONS` (`scripts/portable/lib/format.mjs`: 0.3.0, 0.4.0,
0.5.0) y el export no puede ser de un motor **más nuevo** que el destino. Al subir el motor hay que ampliar esa
lista a mano tras comprobar que el catálogo y el protocolo siguen siendo compatibles.

**Motor de origen.** Es el motor de la instalación de la que se exporta, y no el del checkout de la herramienta.
El export lo **lee de la propia API de origen**: la auditoría de la batalla terminada más reciente
(`GET /battles/{id}/audit`, campo `versions.engine`) dice con qué motor se jugó. Si además se pasa
`--engine-version`, se **valida** contra ese valor y una discrepancia es un error (`engine_mismatch`). El origen
queda anotado en `manifest.engineVersionSource` (`audit`, `flag+audit` o `flag`). Si el origen no tiene ninguna
batalla terminada legible, `--engine-version` es **obligatorio**: se obtiene del despliegue, con el commit que
corre en producción: `git show <commit>:apps/arena-engine/src/engine-deps.json` (campo `engine.version`).

## Qué versiones se exportan

Por defecto **todas** (`--versions all`). Es la única política que no pierde nada, y una migración es justo el
caso en que no se puede perder nada: las **versiones congeladas en torneos** (las que quedaron inscritas) y las
que fueron la cabeza jugable antes de otra posterior sólo sobreviven a una reinstalación si viajan. Con la
política anterior (`heads`) esas versiones se descartaban en cuanto había una publicada posterior.

El coste es el límite de la API de **60 versiones creadas por hora y usuario**: el import espera y continúa solo
(ver «Duración»).

`--versions heads` (opcional, para copias parciales deliberadas) exporta por bot:

1. **La cabeza jugable**: la última versión `published`; si no hay, la última `frozen`, `validated`, `suspended`
   o `retired`, por ese orden.
2. **La última en borrador** (`draft`), exista o no una publicada.
3. La última `rejected`/`validating` sólo si es posterior a todo lo anterior.

Las omitidas quedan listadas en `manifest.omittedVersions` (bot, versión, estado). Si la versión padre de una
exportada no está en el export, se anota como `parentVersionOmitted` y el padre queda vacío al importar.

## Uso

Las credenciales **nunca** van por argumentos: fichero con permisos `0600` o stdin. Cualquier opción como
`--password`, `--token`, `--totp` o `--email` se rechaza con el error `credentials_argv` (quedarían en el
historial de la shell y en la lista de procesos).

```bash
# credenciales: JSON {"email": "...", "password": "..."[, "totp": "..."]}  (0600)  o un token de acceso (0600)
export S9_API_URL=https://<host>/api/v1
export S9_CREDENTIALS_FILE=/ruta/segura/credenciales.json

# 1) EXPORT (sólo lectura). El motor de origen se lee de la API; --engine-version lo valida (o es obligatorio
#    si el origen no tiene batallas). --versions all es el valor por defecto.
node scripts/portable/portable.mjs export --out <directorio-nuevo> [--engine-version <x.y.z>] [--source-sha <sha>] [--versions all|heads]

# 2) comprobación sin red (en cualquier máquina que tenga el disco)
node scripts/portable/portable.mjs verify <directorio> [--max-file-mb N] [--max-total-mb N]
( cd <directorio> && sha256sum -c checksums.sha256 )

# 3) IMPORT en la instalación nueva, con el usuario nuevo (rol developer o superior; admin sirve)
export S9_API_URL=https://<host-nuevo>/api/v1
export S9_CREDENTIALS_FILE=/ruta/segura/credenciales-nuevas.json
node scripts/portable/portable.mjs import --from <directorio> --dry-run --report /tmp/plan.json
node scripts/portable/portable.mjs import --from <directorio> --report /tmp/correspondencias.json
```

Opciones del import:

| Opción | Efecto |
|---|---|
| `--dry-run` | verifica el export y lee el destino; no escribe nada. Sin credenciales hace una verificación offline |
| `--submit` | **encola la validación (build)** de las versiones que estaban `published`/`frozen`/`validated`; no publica |
| `--restore-visibility` | restaura la visibilidad de los bots y el código público (por defecto todo queda privado) |
| `--target-engine <x.y.z>` | motor del destino (por defecto, el del checkout de la herramienta) |
| `--report <fichero>` | informe de correspondencias slug → id nuevo (JSON, `0600`); incluye lo que el export declaró que no viaja |
| `--rate-limit-wait-max <s>` | cuánto esperar ante un 429 antes de abandonar (por defecto 65 min) |
| `--max-file-mb`, `--max-total-mb` | topes de tamaño de la verificación previa |

Salida: `0` todo bien; `1` fallo (export corrupto, formato o motor incompatibles, error de API o elementos con
error en el informe).

### Reconstruir y publicar

El import deja **todas las versiones en `draft`** y no publica nada. Para dejar el rebuild listo, `--submit`
encola la validación de lo que estaba publicado; cuando los builds terminen, publicar es una acción del operador
(`POST /bots/{id}/versions/{n}/actions/publish`, o desde la web) usando el informe de correspondencias.

### Duración y reanudación (límite de 60 versiones por hora)

La API limita la **creación de versiones a 60 por hora y usuario** (y, aparte, el encolado de builds). Con más
de 60 el import espera (`429`, comprobando cada minuto) y sigue solo. Estimación:

```
espera total ≈ (⌈N / 60⌉ − 1) horas      (N = nº de versiones; el resto es la subida en sí, de segundos)
```

`verify <directorio>` (o la línea `EXPORT OK` del export) da N: p. ej. N = 62 ⇒ ≈ 1 h; N = 130 ⇒ ≈ 2 h. El último
inventario de producción de que se dispone (29-oct-2026) tenía 62 versiones publicadas entre todas las cuentas;
el número exacto de la cuenta del operador **no está medido** y lo da el propio export (`counts.versions`).
El import avisa al empezar cuando N > 60 y registra cada espera.

**Reanudación.** Si el import se corta (red, fin de la espera máxima de 65 min por petición, `Ctrl-C`,
caducidad de la sesión), basta **repetir exactamente el mismo comando**: es idempotente (bot por dueño+nombre,
loadout por contenido, versión por sha256+runtime+loadout) y continúa donde se quedó, sin duplicar nada. El
informe `--report` de la ejecución cortada puede descartarse; el de la última es el bueno.

## Runbook de migración (reinstalación desde cero)

**Contexto.** El disco de backup donde debe quedar la copia (un pool ZFS) está en el **host del hipervisor** y
**no** se monta en la máquina de producción. Por eso el export **no se ejecuta en la máquina de producción**: se
ejecuta desde una máquina de trabajo contra su API, y la copia al host se hace después, con verificación. Regla:
**crear → copiar al disco de backup → verificar el hash → verificar la lectura → borrar el temporal.**

Los valores reales (URL de la API de producción, nombre del host y ruta del dataset de backup) **no** están en
este repositorio: están en la nota operativa del operador. Aquí se usan marcadores: `<API_ORIGEN>`,
`<HOST_BACKUP>`, `<USUARIO_BACKUP>`, `<RUTA_BACKUP>`.

### Antes de empezar

1. Máquina de trabajo con Node >= 20 y un checkout del repositorio en el commit que contiene esta herramienta.
   `umask 077` en la sesión (todo lo que se cree será sólo del operador).
2. Fichero de credenciales `0600` con la cuenta **propietaria de los bots** (`{"email","password"}`):
   ```bash
   umask 077; install -m 600 /dev/null "$HOME/.s9-portable-cred.json"   # y escribirlo con un editor
   ```
   Si la cuenta tiene **2FA**, léase «Autenticación de larga duración y 2FA» antes: hace falta un código TOTP
   **vigente** en el fichero (`"totp"`) en el momento de lanzar el comando.
3. Comprobar que hay sitio en el temporal local (el export de unas decenas de bots son pocos MiB) y en el destino.
4. Hacer **antes un `--dry-run`** del import en la instalación nueva (paso 8), no el día de la destrucción.

### Pasos (en este orden; cualquier fallo = parar, no seguir)

```bash
# 0) variables (los valores reales: nota operativa)
export S9_API_URL=<API_ORIGEN>                      # …/api/v1 de la instalación de ORIGEN
export S9_CREDENTIALS_FILE="$HOME/.s9-portable-cred.json"
umask 077
T=$(mktemp -d)                                       # temporal local: se borra al final, no antes

# 1) EXPORT a un directorio temporal local (sólo lectura contra la API; --versions all es el defecto)
node scripts/portable/portable.mjs export --out "$T/portable-export"
#    El motor de origen se lee de la API y se imprime («motor de origen X (audit)»). Debe ser el desplegado
#    (hoy 0.4.0). Si el origen no tiene batallas terminadas, añadir --engine-version <x.y.z> (obligatorio).
#    Anotar la línea «EXPORT OK · N bots · M versiones …» y los avisos.

# 2) verify (sin red) y 3) sha256sum -c, sobre el temporal
node scripts/portable/portable.mjs verify "$T/portable-export"
( cd "$T/portable-export" && sha256sum -c checksums.sha256 )

# 4) copia al host del hipervisor (disco de backup), comprobando por contenido
rsync -a --checksum "$T/portable-export/" <USUARIO_BACKUP>@<HOST_BACKUP>:<RUTA_BACKUP>/portable-export/
#    (alternativa sin rsync: scp -r … y los pasos 5 y 6 siguen siendo obligatorios)

# 5) verificar el hash EN EL DESTINO y que la lista de hashes es idéntica a la del origen
ssh <USUARIO_BACKUP>@<HOST_BACKUP> "cd <RUTA_BACKUP>/portable-export && sha256sum -c checksums.sha256"
( cd "$T/portable-export" && find . -type f | sort | xargs sha256sum ) > "$T/hash-origen.txt"
ssh <USUARIO_BACKUP>@<HOST_BACKUP> "cd <RUTA_BACKUP>/portable-export && find . -type f | sort | xargs sha256sum" > "$T/hash-destino.txt"
diff "$T/hash-origen.txt" "$T/hash-destino.txt" && echo HASH_DESTINO_IGUAL

# 6) verificación de LECTURA: traer la copia del disco de backup a un directorio NUEVO y verificarla
mkdir "$T/lectura" && rsync -a <USUARIO_BACKUP>@<HOST_BACKUP>:<RUTA_BACKUP>/portable-export/ "$T/lectura/"
node scripts/portable/portable.mjs verify "$T/lectura"
( cd "$T/lectura" && sha256sum -c checksums.sha256 )

# 7) SÓLO si 1–6 han salido bien: borrar el temporal y el fichero de credenciales
rm -rf "$T"
shred -u "$S9_CREDENTIALS_FILE"      # o borrarlo de forma segura si no hay shred
```

En el destino no se pasa a la fase siguiente (importar, destruir la máquina de producción) sin los pasos 5 y 6 en
verde: la copia de `<RUTA_BACKUP>` es la autoridad, no el temporal.

### Importar en la instalación nueva

```bash
# 8) traer la copia verificada del host de backup a la máquina de trabajo (o importar desde un temporal verificado)
export S9_API_URL=<API_DESTINO>
export S9_CREDENTIALS_FILE=<credenciales-del-usuario-nuevo-0600>
node scripts/portable/portable.mjs import --from <copia-verificada> --target-engine <motor-del-destino> --dry-run --report plan.json
node scripts/portable/portable.mjs import --from <copia-verificada> --target-engine <motor-del-destino> --report correspondencias.json
# si se corta: el MISMO comando otra vez (idempotente). Después, repetirlo una vez más debe dar todo «reused».
```

El informe incluye `exportNotes` (avisos, versiones y loadouts omitidos, bots que estaban en equipos ajenos): hay
que leerlo y rehacer a mano lo que no viaja (invitar miembros, volver a unir bots a equipos ajenos…).

## Autenticación de larga duración y 2FA

El token de acceso de la API **dura 15 minutos**. Un export o un import largo (con las esperas del límite de 60
versiones por hora) lo supera, así que el cliente **se renueva solo** ante un `401`, una vez por petición:

1. **Refresh token** (`POST /auth/refresh`, rotatorio: cada uso entrega uno nuevo y el anterior deja de valer;
   dura 14 días deslizantes, 30 absolutos). **No necesita TOTP**, así que sirve a cuentas con 2FA: el login inicial
   consume el código TOTP del fichero **una sola vez** y las renovaciones usan el refresh.
2. Si no hay refresh válido y la cuenta **no** tiene 2FA, reautentica con usuario y contraseña.
3. Si la cuenta tiene 2FA y el refresh falla, **no** reenvía el código TOTP (un TOTP consumido no se puede
   reutilizar): para con `auth_failed` y un mensaje que lo explica. Se **repite el mismo comando** con un código
   TOTP nuevo en el fichero (el import es reanudable; el export se rehace en un directorio vacío).

Consecuencias prácticas:

- Usar **`--credentials-file`** (usuario y contraseña) para exportar e importar. Es lo único que se renueva.
- **`--token-file` / `--token-stdin` no se pueden renovar**: sirven sólo para operaciones de menos de 15 minutos
  (un `verify` no necesita red; un `--dry-run` corto sí). Un import largo con token suelto acabará en `401` y
  se para con el mensaje correspondiente.
- Si la cuenta del operador usa **2FA**, escribir en el fichero de credenciales `"totp"` con un código vigente
  justo antes de lanzar el comando (caduca en 30 s). Si la cuenta usa 2FA no se ha comprobado desde esta
  herramienta (la API no lo expone en `GET /users/me`): el síntoma es un `401` con «Se requiere un código TOTP
  válido (2FA activo)» en el primer login, y la herramienta lo explica en el error.
- Alternativa que evita el 2FA durante la migración: importar con la cuenta **nueva** de la instalación nueva (sin
  2FA todavía) y activar el 2FA después.

## Qué hace el import

1. **Antes de tocar nada** (sin red y sin credenciales): comprueba que no esté marcado como incompleto, los
   topes de tamaño, los checksums de todos los ficheros contra el disco, que no sobren ni falten ficheros,
   `formatVersion`, `engineVersion`, los recuentos y las referencias (revisión de loadout de cada versión, versión
   padre, bots de cada equipo). Un export corrupto falla aquí, con cero peticiones al destino.
2. Lee el estado del destino (bots, equipos del usuario).
3. Por cada bot: lo crea (privado) o lo reutiliza si ya existe uno **con el mismo nombre del mismo usuario**;
   crea las revisiones de loadout que falten (comparando por contenido) pasando por el validador de la aplicación;
   sube cada versión como `draft` con el mismo runtime, loadout y padre, y comprueba que el hash del código en el
   destino es el exportado (si no coincide, esa versión falla y queda en el informe). Después aplica `retired`
   (y, con `--restore-visibility`, visibilidad y código público).
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
- Pérdidas declaradas, no silenciosas: versiones no exportadas (`omittedVersions`), revisiones de loadout
  descartadas (`omittedLoadouts`), bots que estaban en equipos ajenos (`botsInForeignTeams`) y avisos de equipos
  (`warnings`) quedan en el manifest, en la salida del export y en el informe del import.

## Errores frecuentes

| Síntoma | Causa | Qué hacer |
|---|---|---|
| `checksum_mismatch`, `unlisted_file`, `missing_file` | el disco o la copia se corrompió, o alguien editó el export | repetir la copia o **rehacer el export**; no se importa nada |
| `file_too_large`, `export_too_large` | un fichero o el total superan el tope (ver «Topes de tamaño») | sospechar de un export corrupto o ajeno; sólo si es legítimo, `--max-file-mb`/`--max-total-mb` |
| `incomplete` | export interrumpido | repetir el export en un directorio vacío |
| `engine_newer_than_target` / `engine_unsupported` | el destino es de un motor anterior o no soportado | desplegar el motor correcto o ampliar `SUPPORTED_ENGINE_VERSIONS` tras revisar |
| `engine_mismatch` (export) | `--engine-version` no coincide con el motor que declara la API de origen | comprobar qué motor está desplegado; no forzar |
| `credentials_argv` | se pasó `--password`, `--token`… por argumentos | usar `--credentials-file`, `--token-file` o `--token-stdin` |
| `rate_limited` | más de 60 versiones por hora | repetir el mismo comando más tarde |
| `auth_failed` (token caducado / TOTP consumido) | token suelto de 15 min o 2FA sin refresh válido | ver «Autenticación de larga duración y 2FA» |
| HTTP 403 al crear versiones | el usuario nuevo no tiene rol `developer` o superior | promoverlo |
| `team_name_taken` / equipo «blocked» | ese nombre de equipo pertenece a otro usuario del destino | **no editar el JSON del export** (rompe los checksums). Opciones: liberar el nombre (que el otro usuario renombre o borre su equipo); o importar igualmente (los bots sí entran) y crear en el destino el equipo con otro nombre y añadirle los bots; o, si el origen sigue vivo, renombrar allí el equipo y **rehacer el export** |

## Verificación

| Qué | Cómo |
|---|---|
| Formato y seguridad | `apps/api/src/portable-format.test.ts` |
| Round-trip origen → destino nuevo contra la API real | `apps/api/src/portable-roundtrip.test.ts` |
| Ensayo con procesos reales (Docker, APIs, CLI) | `bash scripts/portable/e2e/run.sh` (sólo en el laboratorio; puertos efímeros, limpieza por PID/grupo, registra su salida completa en `E2E_LOG_DIR`) |
| Repetición (N vitest + N E2E con captura de cada salida y comprobación de huérfanos) | `bash scripts/portable/e2e/repeat.sh 20 <dir-evidencias>` (sólo en el laboratorio) |
| Calibración (mutantes) | `python3 scripts/portable/mutants.py` (sólo en el laboratorio) |

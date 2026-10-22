# Proxy de la API de Docker (host)

> **Estado:** vigente, revisado contra RC2 (`rc2/dev-proxy`, base `7cf88dd`) y TD-062 (`main` `4cc7651`, base de RC3). El proxy se instala en
> el host como unidad systemd y es el único proceso con `/var/run/docker.sock`. RC2 cambia su
> alcance de red (red dedicada `bot-control`) y su política (control de cliente, allowlist de
> imágenes y propiedad de contenedores). La **ejecución real de bots sigue apagada** por defecto:
> `DOCKER_PROXY_URL` vacío en `tournament-worker`/`arena-engine` (puerta del operador). Ojo: eso
> apaga las batallas, no los builds: `bot-build-worker` trae la URL por defecto y valida bots en el
> sandbox en cuanto el proxy arranca ([Estado actual](#estado-actual)). Índice de
> operación: [index.md](index.md) · Seguridad: [../technical/security.md](../technical/security.md).

R-DEPLOY · R2 (R1.7 · ERR-SEC-02) · RC2. Este documento describe el **único proceso autorizado a
tocar `/var/run/docker.sock`** en el host. Ningún contenedor del stack monta el socket; los
consumidores lanzan contenedores de bots **sólo** a través de este proxy.

## Por qué existe

Montar el socket de Docker dentro de un servicio que procesa **código de usuario** equivale a RCE →
root del host. R1.7 retiró esa excepción: un proxy con allowlist media todas las operaciones. RC1
(2026-10) demostró que la allowlist de endpoints y de postura **no bastaba**: quien alcanzara el
proxy podía crear un contenedor con cualquier imagen fijada por digest y parar o inspeccionar
cualquier contenedor del host, `postgres` incluido (controles N20–N23 de OPS-C).

## Política (RC2)

Cuatro controles independientes, todos *fail closed*. Lógica en `apps/bot-manager/src/docker-proxy.ts`,
configuración del proceso en `apps/bot-manager/src/docker-proxy-config.ts`, entrypoint
`apps/bot-manager/src/docker-proxy-main.ts`.

| Control | Qué hace | Si falla |
|---|---|---|
| Cliente | Sólo atiende conexiones cuya **IP de origen del socket** está en `DOCKER_PROXY_ALLOWED_CLIENTS` (nunca una cabecera) y **no** está excluida. La exclusión prevalece y contiene siempre la IP de bind y las direcciones locales del host (un proceso del host que conecta a `10.89.250.1` sale con ese origen, dentro de la subred admitida), más `DOCKER_PROXY_DENIED_CLIENTS`; con bind loopback, loopback no se excluye. | 403 crudo y cierre de la conexión sin leer la petición; queda registrado con la IP. |
| Imagen | El create sólo admite una imagen **idéntica** a una de la 3.ª columna de `runtimes/DIGESTS.lock` (`repo@sha256:…`). La base (2.ª columna), un tag, otro registro o un digest ajeno no entran. | 403; no se llama a Docker. Lock ilegible o vacío: el proxy no arranca. |
| Propiedad | El create **impone** `s9.managed=true` y `s9.proxy.instance=<DOCKER_PROXY_INSTANCE>`; el cliente no puede fijar ninguna label `s9.*`. `start`/`stop`/`json`/`stats` exigen el **Id completo** (64 hex, nunca nombre ni prefijo); el proxy inspecciona antes y sólo reenvía si el contenedor lleva esas labels. | Contenedor ajeno: 403, sin tocarlo. Inexistente: 404 (el runner lo trata como «ya parado»). |
| Postura | Allowlist de campos del create y `complianceViolations` (tabla 18.2): usuario del sandbox, `cap-drop ALL`, rootfs de sólo lectura, `no-new-privileges`, seccomp, sin `privileged`, sin bind-mounts ni volúmenes, sin namespaces del host, sólo red `arena` con endpoint `{}`, DNS bloqueado y **límites obligatorios** (memoria ≤ 1 GiB, CPU ≤ 2, PIDs ≤ 256, sin swap extra). | 403 con el motivo. |

Operaciones permitidas (todo lo demás → 403): `POST /containers/create`, `POST /containers/{id}/start`,
`POST /containers/{id}/stop[?t=0..300]`, `GET /containers/{id}/json`,
`GET /containers/{id}/stats?stream=false`. No hay `DELETE`, `wait`, `logs`, `kill` ni `exec`: los
flujos reales usan `AutoRemove` y `state()` sobre el inspect (`ProxyContainerRunner`), y no hay
código que necesite más.

## Alcance de red

El proxy escucha **sólo** en la IP de gateway de la red dedicada `s9-bot-control` (bridge del host
`s9-botctl0`, subred `10.89.250.0/24`, gateway `10.89.250.1`), y sólo la consumen los servicios que
crean contenedores (por AST: `bot-build-worker`, `tournament-worker` y `arena-engine`; el
`bot-manager` no). Desde el Compose:

```yaml
extra_hosts: ["docker-proxy.internal:10.89.250.1"]   # IP fija, nunca host-gateway
environment:
  DOCKER_PROXY_URL: http://docker-proxy.internal:2375
```

La red dedicada **no basta**: una IP propiedad del host es alcanzable desde cualquier contenedor con
ruta por defecto (redes no internas, como las de `gateway` y `backup`), compartan red o no. Por eso
hay tres capas, cada una con su prueba: la red (compose, ver [networking.md](networking.md)), el
firewall del host (2375 sólo desde `s9-botctl0`) y el **control de cliente del propio proxy**
(`DOCKER_PROXY_ALLOWED_CLIENTS=10.89.250.0/24`), que rechaza esos orígenes aunque lleguen al puerto.

## Configuración

`/etc/s9-ai-arena/docker-proxy.env` (plantilla `infrastructure/systemd/docker-proxy.env.example`):

| Variable | Valor de producción | Validación (el proxy no arranca si falla; exit 78) |
|---|---|---|
| `DOCKER_PROXY_BIND` | `10.89.250.1` | **Obligatoria**, IP literal. Prohibidos vacío, `0.0.0.0`, `::`, la IP de `docker0` y `host-gateway`/nombres. |
| `DOCKER_PROXY_PORT` | `2375` | Entero 1–65535. |
| `DOCKER_PROXY_ALLOWED_CLIENTS` | `10.89.250.0/24` | IP o CIDR separados por comas; prohibido `/0`. Obligatoria si el bind no es loopback; con bind loopback, por defecto sólo loopback. |
| `DOCKER_PROXY_DENIED_CLIENTS` | (vacía) | IP o CIDR **siempre** rechazados, además de la IP de bind y las direcciones locales del host (leídas al arrancar). Prohibido `/0`. |
| `DOCKER_PROXY_IMAGE_ALLOWLIST` | `/etc/s9-docker-proxy/DIGESTS.lock` | **Obligatoria** (TD-062): la copia de root que instala `install`. El bundle instalado no la deduce del árbol (sin ella, exit 78); `preflight` falla si apunta a otra ruta. Se lee al arrancar: cambiar el lock exige reinstalar y reiniciar. |
| `DOCKER_PROXY_INSTANCE` | `s9-docker-proxy` | Valor de `s9.proxy.instance`; `[A-Za-z0-9][A-Za-z0-9_.-]{0,62}`. |
| `DOCKER_SOCKET`, `ARENA_NETWORK`, `SANDBOX_USER` | `/var/run/docker.sock`, `arena`, `10001:10001` | — |
| `DOCKER_PROXY_INSECURE_BIND_FOR_TESTS` | **nunca en producción** | `1` admite bind comodín o de `docker0` (sólo tests; avisa en el log y sigue exigiendo clientes). `check-env` la rechaza en el fichero instalado. |
| `NODE_*`, `LD_*` | **prohibidas** | Inyectarían código en node o en el enlazador: `check-env` las rechaza y la unidad las retira (`UnsetEnvironment`). |

Si el bind falla porque `s9-botctl0` aún no existe (`EADDRNOTAVAIL`), el proceso sale con 1 y la
unidad reintenta; nunca cae a otra dirección.

## Frontera de privilegio (TD-062)

El proceso tiene el grupo `docker`, y eso equivale a root en el host. La regla es: **el llamador
puede pedir una operación; no puede modificar la autoridad que la aplica.** Todo lo que el proxy
ejecuta o lee como política es de root y nadie más lo puede escribir. Eso incluye **todos los
directorios padre hasta `/`**, porque un padre escribible permite renombrar o sustituir lo que
contiene.

| Ruta | Propietario / modo | Qué es | Escritores permitidos |
|---|---|---|---|
| `/usr/bin/node` | root:root 0755 (paquete de la distribución) | intérprete | root (gestor de paquetes) |
| `/usr/local/lib/s9-docker-proxy/` | root:root 0755 | directorio del artefacto | root (`install`) |
| `…/docker-proxy.mjs` | root:root 0644 | bundle autocontenido: sólo importa `node:*` | root (`install`) |
| `…/docker-proxy.mjs.sha256` | root:root 0644 | hash registrado en la instalación (lo comprueba `preflight`) | root (`install`) |
| `/etc/s9-docker-proxy/DIGESTS.lock` | root:root 0644 | allowlist de imágenes (copia verificada de `runtimes/DIGESTS.lock`) | root (`install`) |
| `/etc/s9-ai-arena/docker-proxy.env` | root:root 0640 | configuración | operador (root) |
| `/etc/systemd/system/s9-docker-proxy.service` | root:root 0644 | unidad, sin drop-ins (ni propios en `/etc`, `/run`, `/usr/lib`, `/usr/local/lib`, ni globales `service.d` en `/etc` o `/run`) | root (`install`) |
| `/usr/local/sbin/s9-docker-proxy-preflight` | root:root 0755 | **preflight instalado**: la única copia que vale para `preflight`/`validate`/`restore` y para TD-057 | root (`install`) |
| `/var/lib/s9-docker-proxy/backup/` | root:root 0700 | copias de seguridad que hace `install` (unidad, drop-ins, `.env`) | root (`install`) |
| `/bin/sh` y `/usr/local/sbin`, `/usr/local/bin`, `/usr/sbin`, `/usr/bin` | root, sin escritura de grupo ni de otros | `ExecStartPre` (`sh`, `ip`, `grep`, `sleep` por el `PATH` del servicio) | root |
| `/var/run/docker.sock` | root:docker 0660 | lo **único** escribible por el proceso | — |
| `/opt/s9-ai-arena` (árbol de despliegue) | usuario de despliegue | **no es autoridad del proxy**: el proceso no lo ve (`InaccessiblePaths`) | usuario de despliegue |

Cómo se garantiza:

- **Ancla de confianza (REVIEW #167, B1):** nada de lo que corre como root sale del árbol de
  despliegue.
  - El instalador se ejecuta desde un **clon de root fijado al SHA revisado**.
  - El bundle se construye **en ese clon**, con `npm ci --ignore-scripts` y `--commit <SHA>`.
    Decisión: así no hace falta ni un token de GitHub en el host ni artefactos de la CI, y el
    resultado es determinista. Tiene que coincidir con el sha256 que publica la CI de `main` para
    ese SHA: son dos medidas independientes del mismo commit.
  - `validate`, `preflight` y `restore` se ejecutan **sólo** con la copia instalada
    `/usr/local/sbin/s9-docker-proxy-preflight`.
  - `install`, `preflight` y `validate` comprueban su propia procedencia y la de lo que instalan.
    Desde una copia que no es sólo de root (la de `/opt`), se niegan con rc 2.
  - Esa comprobación protege del **error** del operador. Del atacante protege el procedimiento
    ([upgrades.md](upgrades.md#td-062)).
- **El build** comprueba con el metafile de esbuild que todas las entradas vienen de
  `apps/bot-manager/src/` y que no hay importaciones fuera de `node:*`. Es determinista: el mismo
  `--commit` da el mismo sha256 en cualquier máquina (comprobado en local y en la CI).
- **`install`:**
  - exige `S9PX_EXPECT_SHA256`;
  - copia el bundle a un temporal de root y verifica el sha256 **de la copia** contra ese valor;
  - lo mueve a su sitio de forma atómica, y la allowlist sigue el mismo camino;
  - la comparación sólo vale porque la hace una copia de root. Desde una copia escribible por otro
    usuario, ese mismo script podría saltársela: por eso el ancla es la procedencia de la copia, no
    la variable.
- **Unidad** (`ExecStart=/usr/bin/node --no-addons /usr/local/lib/s9-docker-proxy/docker-proxy.mjs`):
  - sin `npx`/`tsx` y sin `WorkingDirectory`;
  - `ProtectSystem=strict` + `ReadOnlyPaths` del artefacto y de la allowlist; sólo el socket es
    escribible;
  - `InaccessiblePaths=-/opt/s9-ai-arena` y `ProtectHome`;
  - sin capacidades (`CapabilityBoundingSet=`), `PrivateDevices`, `ProtectClock`, `ProtectProc`,
    `RestrictSUIDSGID`, `SystemCallArchitectures=native` y `SystemCallFilter=@system-service`
    (errno EPERM), `UMask=0077`, y `UnsetEnvironment` de `NODE_*`/`LD_*`;
  - `MemoryDenyWriteExecute=false` **declarado**: V8 necesita memoria W+X.
  - Exposición de `systemd-analyze security --offline`: **1.5** (antes 6.5).
  - No se usa `PrivateUsers`, porque haría perder el grupo `docker` del socket, ni
    `PrivateNetwork`, porque el proxy escucha.
  - Tampoco se usa `~@privileged`: `ip`, en el `ExecStartPre`, suelta capacidades con `capset()`
    y con EPERM sale con 1, así que el bridge «nunca» aparecería. Pasó en la CI y se reprodujo con
    `systemd-run`.
  - Lo que ejecuta la unidad se prueba **dentro de su sandbox real** (`docker-proxy-privilege.test.ts`,
    con `systemd-run`); reintroducir `~@privileged` lo pone ROJO.
- **`preflight`**: ver [Validación](#validación). El firewall (`s9-firewall`, root) sigue la misma
  regla y `preflight` también revisa sus unidades.

Riesgo residual (declarado):

- Se confía en GitHub y en el SHA revisado: el clon de root se obtiene por HTTPS y se fija por
  commit. Las dependencias del build salen del `package-lock.json` de ese SHA (integridad sha512
  de npm), sin ejecutar sus scripts de instalación.
- `s9-firewall.sh install` aplica la misma regla: hay que ejecutarlo desde el clon de root, no
  desde `/opt` (lo indica [firewall.md](firewall.md)). Su script **no** tiene autocomprobación de
  procedencia: lo vigila `preflight` una vez instalado.
- `preflight` no audita las bibliotecas dinámicas de `node`.

## Instalación

Procedimiento completo, con sus condiciones de parada: [upgrades.md](upgrades.md#td-062). En resumen,
como root:

```bash
S=/root/s9-td062/$SHA        # clon de root fijado al SHA revisado (paso 1 de upgrades.md#td-062)
cd "$S" && npm ci --ignore-scripts && node infrastructure/scripts/build-docker-proxy-bundle.mjs --commit "$SHA"
S9PX_EXPECT_SHA256=<sha256 publicado por la CI de main para $SHA> bash "$S/infrastructure/scripts/install-docker-proxy.sh" install
```

`install` hace, por este orden:

1. Comprueba su procedencia y la de sus orígenes. Si no son sólo de root: rc 2.
2. Exige que el sha256 del bundle sea el esperado. Si no: PARA.
3. Hace la **copia de seguridad** de la unidad, los drop-ins y el `.env`.
4. Instala el bundle, la allowlist y el preflight.
5. Crea el `.env` desde la plantilla si no existe.
   - Si existe y su allowlist no es la de `/etc`, aborta.
   - Con `S9PX_MIGRATE_ENV=1` cambia **sólo** esa línea, y sólo cuando la copia de root ya existe.
6. Pasa `check-env`.
7. Escribe la unidad y pasa `preflight --static`. Si sale ROJO, **restaura** la unidad y el `.env`
   y sale sin reiniciar.
8. Crea `s9proxy` en el grupo `docker`, recarga systemd, reinicia la unidad y pasa el `preflight`
   completo con la copia instalada.

La unidad corre como `s9proxy` (sin login) con `Restart=always`. Las imágenes de runtime deben estar
ya en el host (el proxy no permite `pull`).

## Validación

```bash
sudo /usr/local/sbin/s9-docker-proxy-preflight preflight   # frontera de privilegio (TD-062); SÓLO la copia instalada
sudo /usr/local/sbin/s9-docker-proxy-preflight validate    # preflight + config + escucha + firewall
sudo journalctl -u s9-docker-proxy -f   # cada decisión allow/deny, con "client" (IP de origen)
```

`preflight` imprime una línea `preflight: ROJO: …` por fallo y sale con 1 si hay alguno; con rc 2 se
**niega** a dar veredicto si la copia que se ejecuta no es sólo de root (por ejemplo, la del árbol).
Falla si:

- cualquier ruta de la tabla de arriba, o un padre suyo hasta `/`, no es de root, es escribible por
  grupo u otros o tiene ACL;
- el bundle no es un fichero regular o su sha256 no es el registrado;
- la allowlist no es válida, o el entorno la apunta a otra ruta;
- el entorno no pasa `check-env`;
- en la unidad, el fichero o lo que systemd tiene **cargado** (`systemctl show`) usa otro
  `ExecStart`, un `WorkingDirectory`, un `EnvironmentFile` distinto, `npx`/`tsx`/`node_modules`,
  rutas de `/opt` o drop-ins, o bien le falta `InaccessiblePaths` del árbol o hay que hacer
  `daemon-reload`;
- el **proceso en marcha** no es `/usr/bin/node` + el bundle (`/proc/<pid>/exe` y `cmdline`), o
  **ve** el árbol (lo comprueba en su namespace de montaje);
- una unidad del firewall ejecuta algo que no es `/usr/local/sbin/s9-firewall`.

`--static` omite systemd y el proceso. `S9PX_TREE=<dir>` cambia el árbol que el proceso no debe ver;
por defecto es `APP_DIR`.

Comprobación manual equivalente (sólo lectura):

```bash
systemctl show s9-docker-proxy -p ExecStart -p WorkingDirectory -p DropInPaths -p NeedDaemonReload
pid=$(systemctl show -p MainPID --value s9-docker-proxy); sudo readlink -f /proc/$pid/exe; sudo tr '\0' ' ' </proc/$pid/cmdline
stat -c '%U:%G %a %n' / /usr /usr/local /usr/local/lib /usr/local/lib/s9-docker-proxy /usr/local/lib/s9-docker-proxy/* /etc/s9-docker-proxy /etc/s9-docker-proxy/DIGESTS.lock
```

La línea de arranque (`proxy de Docker escuchando en …`) lista `allowedClients`, la ruta y las
imágenes de la allowlist y la instancia. Comprobaciones de alcance, desde contenedores del stack:

| Desde | Esperado |
|---|---|
| un consumidor (`bot-build-worker`) | conecta; `GET /_ping` → 403 de la allowlist de endpoints |
| `gateway`, `backup` (redes no internas) | firewall: timeout; sin firewall, el proxy responde 403 `cliente no autorizado` |
| servicios sólo en redes internas que no son `bot-control` | `ENETUNREACH` |

## Rollback

**Volver al estado anterior a un `install`** (lo normal):

```bash
sudo /usr/local/sbin/s9-docker-proxy-preflight restore /var/lib/s9-docker-proxy/backup/<fecha>-<pid>
```

Repone la unidad, los drop-ins y el `.env` de la copia que hizo `install` (la ruta la imprime
`install`), recarga systemd y reinicia el proxy. Si lo repuesto es la unidad de RC1/RC2, TD-062
vuelve a estar abierta y el comando lo avisa: es una medida de emergencia
([upgrades.md](upgrades.md#td-062)).

**Retirar el proxy** (parar y quitar la unidad; conserva config, artefacto, allowlist, preflight y
usuario):

```bash
sudo /usr/local/sbin/s9-docker-proxy-preflight rollback
```

Volver a la política de RC1 no es un rollback admisible: reabre N20–N23.

> **DANGER** — borrado total del proxy
>
> **PRECONDITION:** el proxy ya está parado (`rollback`) y no se va a reinstalar con la misma
> configuración.
>
> **EFFECT:** elimina `/etc/s9-ai-arena` (configuración del proxy) y el usuario de sistema `s9proxy`.
>
> **ROLLBACK:** reinstalar con el procedimiento de [upgrades.md](upgrades.md#td-062) y rehacer la configuración.

```bash
sudo rm -rf /etc/s9-ai-arena && sudo userdel s9proxy
```

## Estado actual

- **FUNCIONA (código y tests):** control de cliente, allowlist de imágenes, propiedad por labels,
  bind que falla cerrado y límites obligatorios. Probado en proceso
  (`apps/bot-manager/tests/docker-proxy.test.ts`, CI normal) y contra Docker real con el proceso real
  del proxy (`apps/bot-manager/tests/docker-proxy-docker.test.ts`, opt-in `S9_RUN_DOCKER_SANDBOX_E2E=1`;
  lo activa el job `functional-e2e / docker-e2e` con 0 skipped).
- **INTEGRADO (RC2, `integration/rc2-docker-proxy`):** red `bot-control` en compose
  ([networking.md](networking.md#red-de-control-del-docker-proxy-bot-control)), firewall del host
  ([firewall.md](firewall.md)), unidad y `docker-proxy.env.example` con las variables nuevas, y el
  E2E contenedor → proxy en CI (`functional-e2e / container-proxy-e2e`, check obligatorio de
  `main`; [ci.md](../development/ci.md)). Cierra [TD-051](../roadmap/technical-debt.md#td-051),
  [TD-052](../roadmap/technical-debt.md#td-052) y [TD-056](../roadmap/technical-debt.md#td-056).
- **SIN DESPLEGAR:** el proxy de producción sigue con la configuración de RC1 hasta la ventana del
  operador (unidad nueva, `docker-proxy.env` con `DOCKER_PROXY_BIND=10.89.250.1`, firewall, runtimes
  descargados por digest; ver [upgrades.md](upgrades.md#rc2-proxy-de-docker-red-dedicada-y-firewall)).
- **Límite declarado:** las direcciones locales del host que se excluyen del control de cliente se
  leen al arrancar; un bridge creado después no entra en la exclusión hasta reiniciar el proxy (la IP
  de bind sí entra siempre). Lo cubre además el firewall ([firewall.md](firewall.md)).
- **TD-062 (frontera de privilegio):** CERRADA en código, en `main` desde `4cc7651` (PR #167, REVIEW
  ronda 2 PASS). La **unidad instalada en producción sigue siendo la de RC1** (`npx tsx` desde el
  árbol), así que TD-062 está **abierta en producción** hasta la migración
  ([upgrades.md](upgrades.md#td-062)). Desde el 2026-10-22 esa unidad está **parada y deshabilitada** por
  decisión del operador (`systemctl stop` y después `systemctl disable`: `inactive`, `disabled`, nadie
  escucha en `:2375`), sin degradación de los servicios. El fichero de la unidad se conserva.
  **Política del operador (RC3):** el proxy antiguo (unidad de RC1/RC2, `npx tsx` desde el árbol) queda siempre **parado y deshabilitado** (`stop` + `disable`), nunca `enabled`; el fichero de la unidad se conserva. Cualquier vuelta atrás o restauración que deje esa unidad instalada termina con `systemctl disable --now s9-docker-proxy` y la comprobación `systemctl is-enabled` = `disabled`, `is-active` = `inactive` y nadie escuchando en `:2375`. La CI la mide en `container-proxy-e2e` (regla R11) y en
  `infrastructure/tests/docker-proxy-privilege.test.ts`.
- **El «interruptor» `DOCKER_PROXY_URL` sólo gobierna las batallas.** En `tournament-worker` y
  `arena-engine` va vacío por defecto, y eso apaga la ejecución real de **batallas**. `bot-build-worker`
  trae la URL por defecto (`http://docker-proxy.internal:2375`, `infrastructure/docker-compose.yml`). En
  cuanto el proxy está en marcha y los runtimes descargados, los **builds ya ejecutan código de usuario**
  en el sandbox, aunque `DOCKER_PROXY_URL` no esté en `.env`. Arrancar el proxy es, por tanto, activar
  los builds; el operador tiene que tratarlo así.
- **Compatibilidad:** el arnés manual `scripts/e2e-real-battle-smoke.ts` usa una imagen
  `s9-smoke-bot` que no está en `DIGESTS.lock`; con RC2 hay que arrancar el proxy con un lock propio
  (`DOCKER_PROXY_IMAGE_ALLOWLIST`) que la incluya. Los contenedores creados antes de RC2 no llevan las
  labels y el proxy ya no los opera.

## Documentación relacionada

[docker.md](docker.md#otros-servicios) · [networking.md](networking.md#puertos-lógicos) ·
[configuration.md](configuration.md) · [../technical/bots.md](../technical/bots.md) ·
[../technical/security.md](../technical/security.md) · Informe de origen (R1.7):
[../history/rondas/ronda2/reportes/R1.7-docker-sock.md](../history/rondas/ronda2/reportes/R1.7-docker-sock.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| `install|preflight|validate|rollback|restore`, `APP_DIR`, `/etc/s9-ai-arena`, usuario `s9proxy` | CODE_VERIFIED | `infrastructure/scripts/install-docker-proxy.sh` |
| B1: `install`/`preflight`/`validate` se niegan (rc 2) desde una copia que no es sólo de root; `S9PX_EXPECT_SHA256` obligatorio; preflight instalado de root | TEST (propietarios reales) + CI (R11: el instalador del checkout se niega) | `docker-proxy-privilege.test.ts` «B1 ·»; `container-proxy-e2e` R11 B1 |
| B2: copia de seguridad, migración de una sola línea del `.env`, restauración si `--static` sale ROJO, `restore` | TEST | `docker-proxy-privilege.test.ts` «B2 ·» |
| Bundle autocontenido (sólo `node:*`), determinista, arranca fuera del repo y exige la allowlist | TEST | `infrastructure/tests/docker-proxy-privilege.test.ts` (B); mutación «el proxy importa un paquete» ⇒ build ROJO |
| `install` fija root:root 0755/0644/0640; `preflight` ROJO ante 26 mutaciones (modo, propietario de un padre, enlace en la hoja o en un padre intermedio, sha256, entorno, unidad, drop-in, firewall) | TEST (propietarios reales en userns/sudo) | `docker-proxy-privilege.test.ts` (P) |
| Un usuario no root recibe EACCES sobre bundle, allowlist, unidad y entorno | TEST (núcleo real) | `docker-proxy-privilege.test.ts` (N); `container-proxy-e2e` R11 (`s9cpx-arena`, `s9proxy`) |
| Proceso efectivo = `/usr/bin/node` + bundle, como `s9proxy`, sin ver el checkout | CI (unidad systemd real en el runner) | `container-proxy-e2e` R11 |
| Unidad de producción instalada hoy = RC1 (`npx tsx`, `WorkingDirectory` en el árbol) | RUNTIME_VERIFIED (lectura, 2026-10-21) | `systemctl cat`/`show` y `/proc` en el host (no se versiona la topología) |
| Bind obligatorio; vacío, comodín, `docker0` y nombres rechazados | CODE_VERIFIED + TEST | `docker-proxy-config.ts` (`proxyConfigFromEnv`); `docker-proxy.test.ts` «bind y configuración» y spawn del proceso real (exit 78) |
| Control de cliente por IP de origen | CODE_VERIFIED + TEST (proceso, Docker real) | `docker-proxy.ts` (`createDockerProxyServer`); `docker-proxy-docker.test.ts`: cliente de red ajena no interna → 403 |
| Allowlist de imágenes = 3.ª columna de `DIGESTS.lock` | CODE_VERIFIED + TEST (N20) | `parseImageAllowlist`, `imageAllowlistViolation` |
| Propiedad por labels impuestas, Id completo, inspección previa | CODE_VERIFIED + TEST (N21–N23, Docker real) | `ownershipViolation`; víctima creada fuera del proxy sigue `running` con el mismo `StartedAt` |
| Cada control se pone ROJO al retirarlo | TEST (mutación) | informe RC2 DEV-PROXY |
| Red `bot-control`, firewall y unidad | PENDIENTE DE INTEGRACIÓN | ramas `rc2/dev-net`, `rc2/dev-secops` |
| Unidad presente en la instalación de referencia | RUNTIME_VERIFIED (auditoría 2026-10-15, sólo lectura; política de RC1) | `s9-docker-proxy.service` |

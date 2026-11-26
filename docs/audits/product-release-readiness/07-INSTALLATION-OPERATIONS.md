# 07 · Instalación y operación por una persona ajena

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Propósito: responder si una persona que no ha escrito el proyecto puede instalarlo, configurarlo, actualizarlo, respaldarlo, restaurarlo y mantenerlo, y qué falta para que pueda. Informe de síntesis: [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md).

Convenciones: «P1→P2 (REVISION-TECNICA)» marca una severidad ajustada por la revisión técnica; «(DECISIONES-DIRECTOR)» un arbitraje. Los recuentos de pasos son **estimaciones por lectura de la documentación, no mediciones**. Las cifras de la reinstalación real son **evidencia de tercero (el operador), no reverificada por la auditoría** y se citan sin datos de su infraestructura. En FASE 1 no se instaló, arrancó ni restauró nada.

Fuentes: informe 04 (DevOps), informe 07, REVISION-TECNICA, REVISION-PRODUCTO, DECISIONES-DIRECTOR, V-03/V-04/V-07.

## 1. Respuesta directa: ¿puede instalarlo una persona ajena?

**Hoy no, sin ayuda de los autores.** Veredicto del área: NOT_READY (informe 04, mantenido por REVISION-TECNICA; REVISION-TECNICA añade que la frase «el camino a READY_WITH_CONDITIONS es sólo documentación y dos scripts pequeños» es optimista, porque OPS-03 depende de publicar releases y OPS-06/07 siguen siendo P1).

Con matices honestos:

- Un administrador de sistemas experto con Docker y paciencia llega, siguiendo `docs/operations/installation.md`, a un stack **sano** (servicios `healthy`, `/healthz` respondiendo). `CODE_VERIFIED` más CI: el job `ci` de 8f380eb (run 44383512640) levanta el stack Compose desde cero en `functional-e2e` y `container-proxy-e2e`. Eso demuestra la mecánica, no una instalación de tercero.
- Ese stack sano **no ejecuta bots ni batallas**: con la guía principal, `DOCKER_PROXY_URL` queda vacío, el worker no reclama `run_battle` y los builds se rechazan por «sandbox no verificado» ([OPS-01](#ops-01)). Para llegar a un producto que juegue hace falta una segunda instalación a nivel de host y como root (runtimes, red de control, firewall, proxy de Docker, variable en `.env`), descrita como migración de producción y no como instalación en limpio ([OPS-03](#ops-03)).
- El primer administrador se crea con SQL directo ([OPS-02](#ops-02)); no hay hardware ni SO declarados ([OPS-05](#ops-05)); la plantilla `.env` induce a error ([OPS-04](#ops-04)); el README dice «no funcional» ([OPS-11](#ops-11)).
- La seguridad del diseño no debe relajarse para facilitar la adopción: la complejidad de la frontera de root en el proxy es en parte inherente (OPS-03).

Medición: FASE 2 escenarios S01, S04 y S12 (§12) medirán pasos no documentados; el objetivo es 0.

## 2. Evidencia disponible y límites

| Fuente | Qué aporta | Estado |
|---|---|---|
| CI de 8f380eb: run `ci` 44383512640 | `functional-e2e / golden`, `container-proxy-e2e`, `docker-e2e`, `e2e-backup-sftp`, `e2e-restore-sftp-bootstrap` en success | `TEST_VERIFIED` sólo para lo que esos jobs ejercen. REVISION-TECNICA: el run tiene 28 jobs (no 26), y `deploy-staging` y `smoke-and-promote` figuran `success` siendo no-op: no citarlos como evidencia de despliegue |
| Reinstalación limpia del operador (informe informe-reinstalación, 19-nov, 16 gates) | Instalación real sobre Debian 12 con proxy, firewall, runtimes y backup | Evidencia de tercero (operador), no reverificada |
| Backups y restore del operador (informe-export/informe-export-b) | Restore real a una BD temporal con 40/40 tablas idénticas; export portable 37/37 bots, 8/8 equipos | Evidencia de tercero, parcial |
| Código y docs de 8f380eb | `installation.md`, `first-run.md`, `upgrades.md`, `docker-proxy.md`, `restore.md`… | `CODE_VERIFIED` / `DOC_ONLY` |
| Nightly | Último success programado 2026-08-04; 111 failure en las últimas 129 ejecuciones listadas (V-03/V-06; REVISION-TECNICA: ≥107 consecutivos) | Ver [QA-01](#qa-01) |

## 3. Recorrido documentado paso a paso

Recuento del informe 04 sobre `installation.md`, `first-run.md`, `upgrades.md#rc2` y `docker-proxy.md`. **No es un tiempo medido.**

| Bloque | Pasos | Contenido | ¿Documentado? |
|---|---|---|---|
| A. Host previo | 4 | Instalar Docker Engine y Compose v2; git, curl, openssl; usuario de despliegue; repositorio de backup externo y cuenta confinada | **No**: la guía lista software pero no cómo instalar Docker ni cómo crear el destino de backup |
| B. `installation.md` | 10 | Secretos (`init-secrets.sh`), 4 acciones manuales con custodia, `.env` con 11 variables mínimas, `pull`, `up` | Sí, con defectos (OPS-04, OPS-13) |
| C. `first-run.md` | 6 | `bootstrap`, registro, SQL de admin, `--init-repo`, primera copia manual, readiness que «nunca» da READY | Sí, el SQL es el paso conflictivo (OPS-02) |
| D. Host/root para ejecución real | 7-8 | Clon de root fijado al SHA, build del bundle del proxy (Node ≥22.15), comparación con un sha256 de un run de CI, instalar proxy, preflight/validate, firewall, runtimes por digest, `DOCKER_PROXY_URL` en `.env` y recrear workers | Parcial: escrito como migración (OPS-01, OPS-03) |

**Total estimado: ≈27-30 pasos discretos y ≈10 decisiones** (informe 04). Decisiones que la documentación no explica en el flujo: modo del gateway y saltos de proxy de confianza según topología (`GATEWAY_CONF`, `TRUST_PROXY_HOPS`; existe en `networking.md` pero no en el flujo), dónde alojar el repositorio de backup y cómo crear la cuenta SFTP confinada, `RESTIC_HOSTNAME` (explicado el porqué, no cómo elegirlo), concurrencia según hardware, y si activar `streaming` y `observability`.

## 4. Intervenciones manuales observadas en la reinstalación real del operador

Evidencia de tercero (informe informe-reinstalación), sin datos privados. La columna «¿Las sufriría una persona ajena?» es la clasificación del informe 04; las notas son mías.

| # | Intervención fuera del guion | ¿La sufriría una persona ajena? | Nota |
|---|---|---|---|
| 1 | La imagen de nube de la VM no detectaba la configuración inicial; hubo que sembrarla a mano | **No**: específico de la plataforma de virtualización e imagen del operador | — |
| 2 | Instalar Docker Engine y Compose desde el repositorio oficial | Sí | No documentado (OPS-05) |
| 3 | Instalar Node 22.x desde un repositorio externo para construir el bundle del proxy | Sí | La guía lo llama «opcional» (OPS-03) |
| 4 | Clon de root fijado al SHA, `npm ci --ignore-scripts`, build del bundle, comparación del sha256 con el run de CI | Sí | Exige consultar la UI de GitHub Actions |
| 5 | Instalar el firewall de host y su temporizador desde el clon de root | Sí | — |
| 6 | Descargar las imágenes de runtime por digest | Sí | — |
| 7 | `bot-build-worker` reinició en bucle hasta ejecutar `bootstrap` | Sí | `up` antes de `bootstrap` (OPS-13) |
| 8 | Elegir un `RESTIC_HOSTNAME` distinto y recolocar secretos de backup en la VM nueva | En parte | Decisión no explicada para instalación nueva (OPS-06) |
| 9 | Interceptar `forget --prune` al lanzar `backup.sh` a mano, para no tocar snapshots migrados del mismo repositorio | No en su motivo (repositorio compartido con histórico); sí si el repositorio es de sólo anexar | `backup.sh` poda siempre; no hay interruptor (OPS-06) |
| 10 | Primer admin: registro por web y promoción por SQL | Sí | OPS-02 |
| 11 | `TOURNAMENT_WORKER_CONCURRENCY=2` por el tamaño de la VM; claves de streaming no migradas, reintroducidas por la web | Sí (ajuste de capacidad) | OPS-05 |

Conteo propio sobre la tabla: **8 intervenciones atribuibles a cualquier persona ajena (2, 3, 4, 5, 6, 7, 10, 11), 2 parciales o condicionales (8, 9) y 1 específica del operador (1)**. El informe 04 habla de «5» en su resumen y de «≥6» en su cierre; no coinciden entre sí ni con esta tabla. Se usa el conteo de la tabla y se marca como discrepancia abierta.

Lo específico de su infraestructura queda fuera de este documento. Cifras como el tiempo de arranque de la VM o el número de contenedores (13, con perfiles `production,streaming`) son de ese entorno y no extrapolables.

## 5. Prerrequisitos, hardware y SO

| Elemento | Estado | Evidencia | Qué falta documentar |
|---|---|---|---|
| Software de host | PARCIAL | `installation.md:34-44` lista Docker/Compose v2, git, curl, openssl, ssh-keygen; Node ≥22.15 «opcional» | Cómo instalar Docker; Node ≥22.15 **no es opcional** si se instala el proxy desde el árbol de fuentes (Debian 12 trae Node 18); REVISION-PRODUCTO: pendiente de determinar si el instalador ejecuta Node en runtime aunque no construya (`install-docker-proxy.sh:225,309`) |
| Hardware mínimo y recomendado | **FALTA** | Sólo hechos dispersos: producción corre con 4 vCPU y ≈7 GB; «3 batallas simultáneas ahogaron la VM» y recomendación de fijar `TOURNAMENT_WORKER_CONCURRENCY` (`configuration.md:58`); streaming exige ≥3 vCPU libres y ≥1 GiB sin swap (`streaming.md:636`) | Tabla mínimo/recomendado por perfil, concurrencia sugerida, dimensionado de disco (imágenes, volúmenes, replays, `backup_work` que «duplica los volúmenes», MP4 del streamer) |
| Límites de compose | Suma del informe 04: perfil `production` ≈19,5 CPU y ≈12,75 GiB de **límite** (no reserva); `streaming` +4 CPU/4 GiB; cada bot ≤1 GiB y ≤2 CPU | `docker-compose.yml` (`deploy.resources.limits`) | Es una suma del informe 04, no repetida por la revisión (REVISION-TECNICA §8) |
| SO soportado | Sólo Debian 12 evidenciado, y por un tercero | `firewall.md:47` asume iptables-nft; persistencia systemd del firewall «no ensayada» (`firewall.md:165`, `DESIGN_ONLY`) | Matriz de SO; Ubuntu LTS sólo si pasa la batería en laboratorio (S01-bis). Docker rootless no soportado por el diseño del proxy |
| Contraste con el hipervisor | Una prueba de carga en un host compartido ya degradó un servicio del operador | memoria de proyecto del operador | Plan de capacidad antes de anunciar una instancia (REVISION-PRODUCTO §8) |

Para A+ basta declarar «soportado: Debian 12» (REVISION-PRODUCTO §4).

## 6. Dominio y TLS

El gateway nginx sirve TLS con certificados puestos en `secrets/tls/` (por defecto, **autofirmados de 365 días** generados por `init-secrets.sh`) o delega en un proxy inverso externo (`nginx-behind-proxy.conf`). No hay emisión ACME integrada ni receta con Caddy/Traefik. Con autofirmado el navegador muestra un aviso de seguridad en la primera visita; el comportamiento de streamer y WebSocket con certificado autofirmado no está verificado; la caducidad anual no tiene aviso (hipótesis). Evidencia: `networking.md:55-92`, `init-secrets.sh`.

Ver [OPS-09](#ops-09). Para A+: una **receta documentada** con un proxy que emita certificados (S); el perfil ACME integrado es B/C.

## 7. Primer administrador, bootstrap y seed

- `bootstrap` crea reglas, catálogo y mapas, **no usuarios ni bots**. El registro da `user` y `developer`; `PUT /users/{id}/roles` exige admin; el único camino al primer administrador es `INSERT INTO user_roles …` con `psql` (`first-run.md:79-103`). Un email mal escrito produce un no-op silencioso. Perder al único admin vuelve a exigir SQL ([OPS-02](#ops-02)).
- `seed` está prohibido en producción por la documentación (`first-run.md:131-139,142`), pero **no existe guarda técnica** (`cli.ts:63-66` sin comprobación de entorno). Crea una cuenta por rol, incluida admin, con la contraseña pública del repositorio ([SEC-14](#sec-14)).
- **Riesgo REV-05** (REVISION-TECNICA): si la cuenta de desarrollo con rol admin ya existe, `seedDev` no cambia su contraseña y le añade el rol; con registro abierto, quien haya registrado antes ese email con su propia contraseña obtiene `admin` en cuanto alguien ejecute `seed` (`seeds/dev.ts:27-34,73-89`, `cli.ts:63-66`, `auth.ts:26,147-171`). P2, grupo B; exige un error del operador contra una prohibición explícita, pero el modo de fallo ya ocurrió en la historia del proyecto.
- Además, REV-06 (P3, C): `setUserRoles` puede dejar la instalación sin administradores (`users.ts:38-63`).

## 8. Backups, restore, actualización, rollback, desinstalación

### Backup
Diseño: `pg_dump -Fc`, manifest con sha256, secretos en snapshot aparte, retención por host lógico (14/8/12), healthcheck que mira la copia (26 h) y no el demonio. `CODE_VERIFIED` más CI (`e2e-backup-sftp`). Evidencia de tercero: copia correcta desde la VM reinstalada y `restic check` ok. Faltas: repositorio externo obligatorio sin guía del lado servidor; `forget --prune` incondicional (`backup.sh:771`); `.env` no entra en el backup; sin alertas por defecto ([OPS-06](#ops-06)).

### Restore
`restore.sh` restaura a un directorio; BD y volúmenes se colocan a mano (fases 4-7). Hay evidencia de tercero de un restore real a una BD temporal, pero **no** del procedimiento completo de `restore.md` en un host limpio y sin tiempos. Sin la contraseña del repositorio de backup, la clave SSH y `known_hosts` verificados fuera del servidor no hay restauración ([OPS-07](#ops-07)).

### Actualización y rollback
Procedimiento seguro pero manual: copia, editar `TAG`, `config --hash`, `pull`, `up --no-build --no-deps` por grupos, `migrate` a mano, verificación. La API no migra al arrancar: hay una ventana con esquema viejo (hipótesis). Rollback de datos = restic; de migraciones, lista cerrada (`NAMED_ROLLBACK_ALLOWED`: 016-019), con trampa documentada en `rollback:1` ([OPS-08](#ops-08)). Sin releases ni changelog ([OPS-14](#ops-14)).

### Desinstalación
**No existe procedimiento.** Sólo `s9-firewall uninstall`, la retirada del proxy y la advertencia de que `down -v` borra datos ([OPS-10](#ops-10)).

### Diagnóstico y monitorización
Buenas guías (`diagnostics.md`, `troubleshooting.md`), pero ningún comando único de «estoy sano». `observability` es un perfil opcional con 11 alertas «NOT TESTED» en instalación real; webhook vacío significa que nadie recibe nada; `readiness` nunca da READY; `/healthz` no informa de migraciones ([OPS-12](#ops-12)). `smoke.sh` no puede dar verde (OPS-04).

## 9. Asistente web frente a CLI guiado

| Criterio | Asistente web | CLI guiado idempotente |
|---|---|---|
| Parte difícil (Docker, proxy root, firewall, runtimes, backup, TLS) | La web no puede ni debe hacerla: es de host y requiere root | Sí |
| Dependencia | Necesita el stack ya levantado (huevo y gallina) | Sólo el host |
| Valor real | Pequeño: «bootstrap + admin + comprobaciones» | Alto |
| Riesgo | Superficie expuesta mientras queda accesible | Bajo |
| Esfuerzo | L, incertidumbre alta | M-L, incertidumbre media |
| Base existente | `packages/first-run/` (13 dominios, con tests y mutantes) **sin interfaz** | Reutiliza los 13 dominios como lista de comprobaciones |

**Recomendación (informe 04, coincidente con REVISION-PRODUCTO):** CLI guiado idempotente (`s9ctl` o `scripts/install.sh`): `preflight` → `secrets` → `env` → `pull` verificando digest → `host` (proxy, firewall, runtimes con el bundle de la release) → `up` → `bootstrap` → `create-admin` → `backup-init` → `doctor`; cada paso reanudable, con `--dry-run`. Un asistente web puede venir después, como panel de estado tras el CLI, no como instalador (grupo C/D).

**Partición para A+ (REVISION-PRODUCTO §4):** el paquete completo `s9ctl` no es el mínimo.

| Grupo | Pieza | Esfuerzo |
|---|---|---|
| A | `install-host.sh` (runtimes, red, firewall, proxy desde el asset de la release, `DOCKER_PROXY_URL`, con preflight) | M |
| A | `cli.ts create-admin` | S |
| A | `.env.example` limpio, requisitos de hardware y SO, orden `postgres+queue` → `bootstrap` → `up`, README nuevo | S |
| A | «doctor-lite»: `smoke.sh` arreglado que cree y termine una batalla de humo | S-M |
| B | `doctor` completo, `upgrade.sh`, `restore-all.sh`, CLI interactivo | M-L |
| C | Desinstalación, perfil ACME, SO adicionales | S-M |
| D | Asistente web como instalador | — |

## 10. Hallazgos OPS con severidad final

Formato: severidad final · grupo final · estado de evidencia · evidencia · informe origen (04 salvo indicación).

<a id="ops-01"></a>
### OPS-01 · El camino documentado no produce un producto que ejecute bots ni batallas
- **P1 · Grupo A** · DEFECTO_CONFIRMADO (documentación y flujo) · `CODE_VERIFIED` / `DOC_ONLY`; CONFIRMADO_CON_MATIZ (REVISION-TECNICA)
- Descripción: tras `installation.md` §1-10 el stack está sano, pero `DOCKER_PROXY_URL` queda vacío en `tournament-worker` y `arena-engine` y las batallas quedan `scheduled`; en `bot-build-worker` el defecto apunta a un proxy inexistente y «sin proxy, todo build se rechaza `sandbox no verificado`».
- **Matiz de REVISION-TECNICA (D-04):** es **falso** que `installation.md` no mencione proxy e imágenes de runtime: existen las secciones «Imágenes de runtime de los bots» (`installation.md:129-147`) y «Proxy de Docker del host» (`:149-169`). Lo que falta es (a) fijar `DOCKER_PROXY_URL` en `.env` (0 menciones en `installation.md` ni `first-run.md`), (b) el firewall (sólo un enlace en `:256`) y (c) que el prerrequisito lo presenta como «opcional… hoy apagado en producción» (`installation.md:44-46`), cosa obsoleta. P1/A se mantiene.
- Evidencia: `infrastructure/docker-compose.yml:290-308,366-368,474,543`; `docs/operations/configuration.md:52-53`; `docs/operations/upgrades.md#rc2`. Tercero: la reinstalación del operador lo tiene instalado.
- Solución: paso obligatorio «Ejecución de bots» en `installation.md` y un `install-host.sh` con preflight; un chequeo «puede jugar» (batalla de humo), no sólo `/healthz`. Esfuerzo S (doc) + M (script), incertidumbre baja. Dependencias: OPS-03. Validación: S01-S04.

<a id="ops-02"></a>
### OPS-02 · El primer administrador exige SQL directo
- **P1→P2 (REVISION-TECNICA) · Grupo A (DECISIONES-DIRECTOR)** · FALTA · `CODE_VERIFIED`
- REVISION-TECNICA rechaza el argumento de «ventana insegura con registro abierto»: que otros se registren no hace insegura la promoción por email exacto. Queda como fricción de instalación con paliativo documentado (PRECONDITION/ROLLBACK), pero un tercero no debe tocar SQL: grupo A por coste S.
- Evidencia: `first-run.md:79-103`; `apps/api/src/db/cli.ts` sin `create-admin`; `routes/auth.ts:167-171`; TD-023 (P2 mantenida, D-05).
- Solución: `cli.ts create-admin --email <e> [--password-file <f>]`, idempotente, con auditoría; opcional `S9_INITIAL_ADMIN_EMAIL` en `bootstrap`. Esfuerzo S, incertidumbre baja. Validación: S03; test de CI con mutante (DoD D5).

<a id="ops-03"></a>
### OPS-03 · Instalar el proxy de Docker en limpio exige root, Node ≥22.15 y un sha256 que sólo está en un run de CI
- **P1 · Grupo A en forma mínima (REVISION-PRODUCTO: B→A)** · RIESGO/DEUDA · `CODE_VERIFIED` + evidencia de tercero
- Descripción: `docker-proxy.md#instalación` y `upgrades.md#td-062` describen una migración. Para instalar desde cero hay que clonar como root fijado al SHA, `npm ci --ignore-scripts`, construir el bundle y compararlo con un `EXPECTED` que está en el resumen de un run de CI o en un artefacto de Actions. Que los artefactos exijan sesión y caduquen es hipótesis, no verificada.
- Evidencia: `upgrades.md:140-215`; `docker-proxy.md#instalación`; `install-docker-proxy.sh`; informe del operador (gate del proxy PASS, sha256 igual al de CI).
- Solución mínima para A: adjuntar el bundle y su sha256 a una **release de GitHub** (de todos modos hace falta, OPS-14); `install-host.sh` lo descarga y verifica. Documentar Node ≥22.15 como requisito si el instalador lo necesita en runtime. Esfuerzo M, incertidumbre media (política de confianza: asset de release o build local). Dependencias: OPS-14.

<a id="ops-04"></a>
### OPS-04 · `.env.example`, `smoke.sh` y mensajes remiten a valores y documentos inexistentes
- **P1 · Grupo A** · DEFECTO_CONFIRMADO · `CODE_VERIFIED` (V-04; REVISION-TECNICA CONFIRMADO)
- Descripción (sin reproducir valores): `infrastructure/.env.example` trae `TAG=latest` y `BACKUP_TAG=latest` (la CI sólo publica `sha-<commit>` y `v<versión>`, `ci.yml:390-392`); enlaces a `docs/despliegue.md`, que no existe en main (los docs están en `docs/operations/*`); y un valor por defecto de `S9_DOMAIN` y comentarios que son los de la **instalación del operador**, misma clase que un incidente previo de topología en el repositorio. Severidad de seguridad BAJA (dominio ya público); severidad de producto P1 (plantilla equivocada para un tercero). El `.env.example` de la raíz es del prototipo v1 (3 variables). `docker-compose.demo.yml` sigue en la raíz.
- **Matiz `smoke.sh` (REVISION-TECNICA):** `smoke.sh` comprueba `/api/healthz` y `/replays/healthz` esperando 200, pero el gateway devuelve **404** en `/replays/*` (`gateway/nginx.conf:124-131`) y `/api/healthz` cae en la SPA: **el humo no puede dar verde nunca** (y puede dar un verde falso en `/api/healthz`). TD-020 P2 se mantiene (arreglo S).
- Incertidumbre: REVISION-TECNICA no pudo comprobar si existe un `:latest` antiguo en GHCR; si existiera, `TAG=latest` traería una imagen vieja en silencio, peor que fallar (FASE 2: `docker manifest inspect`).
- Evidencia: `infrastructure/.env.example:57,79`; `infrastructure/scripts/init-secrets.sh:2`; `infrastructure/scripts/smoke.sh:2-4,21-24`; `installation.md:#5`.
- Solución: `TAG=` vacío con fallo claro, plantilla con `example.com`, eliminar enlaces muertos, arreglar o borrar `smoke.sh`, retirar `.env.example` y compose de la v1. Esfuerzo S. DECISIONES-DIRECTOR: la limpieza de ficheros rastreados es grupo A; la purga de historial, E.

<a id="ops-05"></a>
### OPS-05 · Sin requisitos de hardware, disco ni SO
- **P1→P2 (REVISION-TECNICA) · Grupo A (como tarea S)** · FALTA · `CODE_VERIFIED`/`DOC_ONLY`
- REVISION-TECNICA: es una tabla de documentación; los incidentes citados son de producción, no del producto. Ver §5. Esfuerzo S (doc) + M (medir en laboratorio, FASE 2), incertidumbre media. Validación: S06.

<a id="ops-06"></a>
### OPS-06 · Backup: repositorio externo obligatorio sin guía, poda no desactivable, sin alertas por defecto
- **P1 · Grupo B, con una parte A (aviso claro si `RESTIC_REPOSITORY` está vacío; REVISION-PRODUCTO)** · RIESGO · `CODE_VERIFIED` + tercero (REVISION-TECNICA: CONFIRMADO)
- Descripción: sin repositorio configurado el contenedor `backup` arranca pero queda `unhealthy` y no copia; sólo avisa a las 26 h con una alerta que no existe si `observability` está apagado. Sin guía del lado servidor ni opción de volumen local gestionado. `forget --prune` incondicional. `infrastructure/.env` no entra en el backup. Copias y VM en el mismo host físico no son independientes.
- Evidencia: `backup.md#estados`, `entrypoint.sh:30-58`, `backup.sh:~747-771`, `observability.md:75-91`, `restore.md#custodia`; informe del operador (desviación 4).
- Solución: incluir `.env` en el snapshot de configuración, `BACKUP_PRUNE=0`, guía de 10 líneas para un destino SFTP o local, fallar o avisar en `up`, alerta mínima sin `observability`. Esfuerzo M, incertidumbre baja.

<a id="ops-07"></a>
### OPS-07 · Restauración completa manual y sin ensayo reciente
- **P1 · Grupo B; el *ensayo* completo en laboratorio es A (REVISION-PRODUCTO), la automatización B** · RIESGO · `CODE_VERIFIED` + `PROD_VERIFIED` parcial de tercero (REVISION-TECNICA: CONFIRMADO; TD-025 P1 se mantiene)
- Evidencia: `restore.md` (fases 1-7, «Ensayo», «Estado actual»); informe-export-b. Solución: `scripts/ops/restore-all.sh` y ensayo trimestral registrado; custodia fuera de banda como requisito. Esfuerzo M, incertidumbre media. Validación: S08.

<a id="ops-08"></a>
### OPS-08 · Actualización y rollback sin comando único
- **P2 · Grupo B** · DEUDA/HIPÓTESIS · `CODE_VERIFIED`. Hipótesis: errores transitorios entre `up` y `migrate`. Evidencia: `upgrades.md`, `apps/api/src/db/migrations.ts`. Solución: `upgrade.sh --to sha-<x>` y matriz de versiones; ensayo de rollback (S09). Esfuerzo M-L, incertidumbre media.

<a id="ops-09"></a>
### OPS-09 · TLS sin emisión de certificados
- **P2 · Grupo B (receta con proxy: A; perfil ACME: C)** · FALTA · `CODE_VERIFIED`. Ver §6. Esfuerzo M, incertidumbre media.

<a id="ops-10"></a>
### OPS-10 · Sin desinstalación
- **P2 · Grupo C (B en la opción pública, REVISION-PRODUCTO)** · FALTA · `CODE_VERIFIED` (ausencia). No cubre: orden de baja, volúmenes `infrastructure_*`, imágenes y runtimes por digest, usuario del proxy, `/etc/s9-*`, unidades y binarios instalados, clon de root, red de control, reglas iptables, timers, copias en el repositorio de backup. Solución: `uninstall.md` y `uninstall.sh --dry-run`. Esfuerzo S-M.

<a id="ops-11"></a>
### OPS-11 · README y documentación de entrada contradicen el estado actual
- **P2 · Grupo A** · DEFECTO_CONFIRMADO · `CODE_VERIFIED` (V-02). Duplicado de DOC-01: consolidado en [DOC-01](10-DOCUMENTATION-AUDIT.md#doc-01). `README.md:8-16,41-52` («Estado actual 2026-10-18… no es funcional de extremo a extremo», «12 servicios» frente a 13 en main); `docs/operations/index.md:6-9`.

<a id="ops-12"></a>
### OPS-12 · Monitorización y readiness no certifican una instalación real
- **P2 · Grupo B** · DEUDA · `CODE_VERIFIED`/`DOC_ONLY`. Solución: `doctor` (versión y commit por servicio, migraciones, proxy alcanzable, batalla de humo, último backup, disco, firewall `check`) y una alerta probada de punta a punta (S10). Esfuerzo M, incertidumbre media. «Doctor-lite» es A.

<a id="ops-13"></a>
### OPS-13 · El orden `up` → `bootstrap` deja servicios en bucle de reinicio
- **P3 · Grupo A (REVISION-PRODUCTO §6)** · DEUDA · `DOC_ONLY` + tercero. `installation.md:#7-#8`; el conteo «11 healthy + backup» (`:218`) y «12 servicios» (`:120`) no cuentan el `streamer` (13 en 0.5.0). Solución: `up -d postgres queue` → `bootstrap` → `up -d`. Esfuerzo S.

<a id="ops-14"></a>
### OPS-14 · Sin releases versionadas ni changelog
- **P2 · Grupo A en forma mínima (REVISION-PRODUCTO: B→A)** · FALTA · `CODE_VERIFIED`: 0 tags, 0 releases. La CI publica `sha-<commit>` y `v0.0.0` (móvil). Mínimo: tag `v0.x.y`, notas, digests de imágenes, bundle del proxy con sha256 (DoD D1). Esfuerzo S-M. Consolidado con [DOC-05](10-DOCUMENTATION-AUDIT.md#doc-05).

<a id="ops-15"></a>
### OPS-15 · SO soportado y firewall fuera de Debian
- **P3 · Grupo C** · HIPÓTESIS · `DOC_ONLY`. Declarar «soportado: Debian 12»; probar Ubuntu 24.04 en laboratorio (S01-bis). Esfuerzo M.

### Hallazgos de otras áreas que condicionan la operación

<a id="sec-14"></a>
- **SEC-14 · Guardarraíl de `seed` y REV-05**: SEC-14 P3→**P2 (REVISION-TECNICA)** · Grupo **B** (DECISIONES-DIRECTOR no lo cambia; REVISION-PRODUCTO: B) · `CODE_VERIFIED` · Esfuerzo S. Ver §7.
<a id="qa-01"></a>
- **QA-01 · Nightly en rojo crónico**: **P2 · Grupo A (DECISIONES-DIRECTOR)** · `TEST_VERIFIED` (run 44519497401, `slow-suites` failure; `determinism-1000` success) · causa: `nightly.yml` no prepara ffmpeg ni userns (6 tests fallan de entorno; confirmado con `--log-failed`). Racha agravada respecto a QA-01 original: último verde programado 2026-08-04. Cierre: 7 ejecuciones verdes consecutivas (DoD D13). Sin esa señal no se puede congelar versión.
- **QA-03 · Sin prueba de instalación limpia ni de upgrade**: P1→**P2 (REVISION-TECNICA), grupo B (DECISIONES-DIRECTOR)**; en A basta el ensayo manual de laboratorio con acta (DoD D4). REVISION-TECNICA: «sin prueba de instalación limpia» es parcialmente falso (el stack se levanta desde cero en CI y hubo una reinstalación real del operador); lo que falta es upgrade N-1→N con datos y rollback.
- **SEC-13 / TD-008 · Topología en ficheros rastreados**: P2 (REVISION-TECNICA); **A sólo la limpieza de ficheros rastreados**, purga de historial E (DECISIONES-DIRECTOR). Incluye `infrastructure/.env.example` (OPS-04).
- **REV-01 · La prueba de aislamiento de red está vacía (P1, grupo A, DECISIONES-DIRECTOR)**: `tests/sandbox-escape/run-escape-suite.sh:52,88` usa una red `--internal` vacía y `--dns 0.0.0.0`; no puede ponerse roja. Afecta a la afirmación «instalación segura»: la alcanzabilidad real de los workers desde los bots es **NO VERIFICADA (FASE 2)** (V-07). El detalle vive en el informe de seguridad.
- **SEC-02 · Modo de registro**: P2 · A (DECISIONES-DIRECTOR). Decisión que debe tomar el instalador, no un estado heredado: `REGISTRATION_MODE=open|invite|closed` con valor por defecto cerrado o por invitación. Pendiente de definir cómo se invita a alguien (véase [UX-12](06-UX-PRODUCT-REVIEW.md#ux-12)).
- **BE-01 / BE-02**: P1→P2 (REVISION-TECNICA); BE-01 grupo B con runbook SQL en A (DECISIONES-DIRECTOR); BE-02 grupo B, runbook en A.

## 11. Reclasificaciones de deuda histórica (operación)

| TD | Anterior | Propuesta del informe 04 | Resolución final |
|---|---|---|---|
| TD-006 Runtime mezclado sin identidad de build | P0 | P3 | **P3 justificada** (13/13 en `sha-8f380eb` por tercero); cerrar con `runtime-drift-scan` en FASE 2 (REVISION-TECNICA) |
| TD-007 Backup sin alertas ni apagado limpio | P0 | P1 | **P1 justificada**; `postgres` sin `stop_grace_period` |
| TD-012 Registro abierto | P1 | P1 | P1 si se abre a externos; P2 si hay invitación (REVISION-TECNICA D-01) |
| TD-020 Healthz/humo engañosos | P2 | P2→P1 | **P2** (REVISION-TECNICA: arreglo S; defecto confirmado) |
| TD-023 Administración por SSH / primer admin | P2 | P1 | **P2** (REVISION-TECNICA: «no justificada», D-05) |
| TD-024 Instalación no reproducible | P2 | P1 | **P1 justificada** (paraguas de OPS-01/03) |
| TD-025 Restauración sin ensayo reciente | P1 | P1 | P1 |
| TD-031 Imágenes de servicio sin escanear | P1 | — | **P1, grupo A hasta medir con `trivy` en FASE 2** (DECISIONES-DIRECTOR) |
| TD-062 Proxy ejecuta código de árbol no root | P1 (cerrada en main) | cerrada verificable | Cerrada; coste restante de adopción = OPS-03 |

## 12. Escenarios de FASE 2 (laboratorio aislado)

Entorno: **laboratorio aislado**, nunca producción ni el hipervisor de producción: VM Debian 12 limpia (4 vCPU y 7 GB, como producción, con snapshot de base limpia) y, para S01-bis, una segunda con Ubuntu 24.04; red sólo hacia el registro de imágenes, npm y GitHub; destino de backup SFTP **de laboratorio** en otro disco; ejecutar con `LAB=1`, registrar rc y salida de cada paso. La máquina de orquestación sólo orquesta (nada pesado ahí).

| ID | Escenario | Comandos (resumen) | Criterio de PASS |
|---|---|---|---|
| S01 | **Instalación limpia** siguiendo sólo las docs; cronometrar y contar intervenciones | Desde el snapshot: instalar Docker, clonar, fijar SHA, `init-secrets.sh`, `.env`, `$DC pull`, `$DC up -d --no-build` | Todos los pasos de `installation.md` ejecutables sin conocimiento externo; 12 servicios `healthy` (13 con streaming) salvo `backup`; `/healthz`, `/api/v1/healthz` y `/version` con el commit esperado; **0 pasos no documentados** (se registra el número) |
| S02 | Configuración mínima | `.env` con sólo las 11 variables mínimas; `GATEWAY_CONF` en ambos modos; `TRUST_PROXY_HOPS` 1 y 2 | Arranca con TLS autofirmado y tras un nginx de laboratorio; `X-Forwarded-For` correcto (el bloqueo de login usa la IP real) |
| S03 | Primer administrador y `seed` | `bootstrap`; registro; promoción; tras el arreglo, `create-admin`; intento de `seed`; registrar antes el email semilla y ejecutar `seed` (REV-05, R6) | Sin `psql`: login admin y acceso al panel; con el procedimiento SQL actual: rc 0, roles correctos y rollback SQL revierte; `seed` rechazado en producción y sin elevar la cuenta registrada por un tercero |
| S04 | Ejecución real: proxy, firewall, runtimes | `pull-runtime-images.sh` (`RUNTIME_IMAGES_READY=YES`), `s9-firewall.sh install/check`, construir e instalar el proxy, `preflight`, `validate`, fijar `DOCKER_PROXY_URL`, recrear workers, `network-probe.mjs --expect-default-route-blocked` | `preflight`, `check` y `network-probe` con rc 0; **medir** pasos y decisiones no documentados; repetir la prueba de aislamiento **dentro de la red `arena` real** (REV-01/R1) con control positivo |
| S05 | Primer bot, build y batalla | Cuenta, bot de ejemplo, versión, build hasta `published`, batalla A contra B | Versión `published`; batalla `finished` con ganador; replay reproducible y `verify` OK; sin contenedores huérfanos en `docker ps -a` |
| S06 | Primer torneo y carga | Torneo de 4 bots, formato liga; `TOURNAMENT_WORKER_CONCURRENCY` 1 y 2 | Todas las batallas `finished`, ranking Elo no vacío, replays presentes; CPU y RAM medidas (`docker stats`, `vmstat`) y sin bloqueos del kernel en `dmesg`; **datos para la tabla de requisitos (OPS-05)** |
| S07 | Streaming opcional | `COMPOSE_PROFILES=production,streaming`; destino RTMP receptor de laboratorio (no un servicio real) | `streamer` healthy; sesión iniciada hacia el receptor; ≥3 vCPU libres medidas; sin claves en `docker inspect` ni argv |
| S08 | Backup y restore completo | `--init-repo`; `backup.sh`; `evidence.sh`; destruir la VM y restaurar desde la base limpia con sólo la custodia (contraseña, clave, `known_hosts`, `.env`); `restore.md` fases 1-7 | Todas las tablas restauradas (conteo y md5 por tabla frente al original), replays y bots; `healthz` OK; nueva copia correcta; **tiempo y pasos manuales registrados**; sin la custodia el procedimiento falla en cerrado |
| S09 | Actualización desde la versión anterior y rollback | Instalar `sha-<anterior>` con datos; seguir `upgrades.md` hasta `sha-8f380eb`; volver; probar con una batalla `running`; tráfico sintético entre `up` y `migrate` | Migraciones aplicadas sin pérdida; tras el rollback la app funciona y el esquema es coherente (`rollback:name` y «restore previo»); documentar la ventana de desfase (hipótesis OPS-08) |
| S10 | Recuperación tras fallo | `kill -9` a `postgres`; disco al 95 %; reinicio en caliente de la VM; perder `queue`; parar el proxy; backup con destino caído; con `observability` y un webhook de laboratorio | Cada fallo se detecta (healthcheck o alerta recibida en el webhook) y se recupera según la documentación, sin pérdida salvo el trabajo en vuelo declarado y sin batallas `running` zombis; `BackupTooOld` simulada llega |
| S11 | Desinstalación | Seguir (futuro) `uninstall.md`: `down`, retirar proxy y firewall, volúmenes, usuario, red, clon de root | Inventario posterior = inventario previo a S01 (`docker ps -a`, `volume ls`, `systemctl list-unit-files 's9*'`, `iptables -S`, `ls /etc/s9*`); los datos se destruyen sólo con confirmación |
| S12 | Persona ajena sin conocimientos previos | Una persona que no es autora sigue sólo README → `installation` → `first-run` | Llega a S05 sin preguntar; cada pregunta es un hallazgo; **mide el recuento real de pasos y decisiones** frente a las estimaciones de §3 |
| S01-bis | Segundo SO | Repetir S01 y S04 en Ubuntu 24.04 | PASS amplía la matriz de SO (OPS-15); FAIL documenta el límite |

### Comprobaciones sueltas (laboratorio o lectura)
| Qué | Prueba | Confirma o refuta |
|---|---|---|
| `TAG=latest` rompe `pull` | Copiar `.env.example` y `$DC pull`; `docker manifest inspect …/api:latest` (R5) | `manifest unknown` confirma OPS-04; si existe, trae una imagen antigua |
| Sin `DOCKER_PROXY_URL` las batallas quedan `scheduled` | Tras S01, crear bot y batalla | Confirma OPS-01 |
| Un tercero obtiene el sha256 del proxy | Consultar el run de `main` de un SHA sin cuenta de GitHub | Si exige sesión o caducó, confirma OPS-03 |
| Desfase de esquema `up`/`migrate` | S09 con tráfico sintético | 5xx confirman OPS-08 |
| Autofirmado caduca a los 365 días | `openssl x509 -enddate` sobre `tls/fullchain.pem` | Sin aviso confirma OPS-09 |
| `backup.sh` con repositorio de sólo anexar | Destino SFTP sin permisos de borrado | `forget --prune` falla: confirma OPS-06 |
| Nightly | `gh run view 44519497401 --log-failed` y 7 verdes tras el arreglo | QA-01 |
| TD-031 | `trivy image --severity HIGH,CRITICAL` sobre las 6 imágenes Node (R4) | Decide P1 o P2 |

Todo lo anterior queda `BLOCKED (FASE 2)` hasta ejecutarse.

## 13. Fortalezas verificables (sin adornos)

- Imágenes inmutables `sha-<commit>`, compose canónico y gates con mutantes (`release-gate.mjs`, `tag-override-gate.mjs`, `compose-canonical-check.mjs`): `CODE_VERIFIED`; en CI sólo para lo que los jobs ejercen.
- Secretos por fichero, sin argv ni `.env`; `init-secrets.sh` idempotente. `CODE_VERIFIED`.
- Backup con healthcheck que mira la copia y no el demonio; `--init-repo` explícito. `CODE_VERIFIED` + CI.
- Proxy de Docker con frontera de privilegio explícita; en la reinstalación del operador, preflight y validate verdes (evidencia de tercero).
- Documentación operativa honesta sobre sus límites (cada doc declara FUNCIONA/PARCIAL/PENDIENTE y enlaza TD-xxx).
- Export portable (`scripts/portable/portable.mjs`) verificado por el operador (tercero).

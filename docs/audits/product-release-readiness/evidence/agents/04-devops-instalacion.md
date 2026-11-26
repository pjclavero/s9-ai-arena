> Anexo de trazabilidad: informe de trabajo original, saneado para publicación (rutas locales sustituidas por marcadores y sección de anexo privado retirada; estaba vacía). Las severidades y grupos **finales** son los de los documentos 01-15, no los de este informe.

repo pjclavero/s9-ai-arena · HEAD verificado `8f380eb700c3e984691649b3449d2c543038dfb1` (`git -C <árbol-auditado@8f380eb> rev-parse HEAD`)

# Agente 4 · DevOps, instalación y operación (prefijo OPS-)

## 1. Cabecera

- Fecha: 2026-11-19. Fase 1 (estática, sólo lectura). Árbol: `<árbol-auditado@8f380eb>` @8f380eb.
- Alcance leído: `README.md`, `.env.example` (raíz) e `infrastructure/.env.example`, `docker-compose.demo.yml`, `docs/operations/*` (installation, first-run, configuration, upgrades, backup, restore, docker-proxy, firewall, networking, observability, shutdown, troubleshooting, readiness), `docs/recuperacion.md` (cabecera), `infrastructure/{docker-compose.yml,scripts/,backup/,firewall/,systemd/}`, `scripts/ops`, `docs/roadmap/technical-debt.md` (TD-006/007/012/020/023/024/025/057/062/066), CI de 8f380eb (`gh run`, sólo lectura).
- Evidencia de terceros (informes del equipo, no verificada por mí): `informe-reinstalación-INFORME.md` (reinstalación limpia de producción el 19-nov sobre Debian 12, 16 gates), `informe-export-INFORME.md`/`informe-export-b-INFORME.md` (backups, restore real a PG temporal, export portable), `PLAN.md`. No abrí ficheros 0600 ni directorios con credenciales.
- NO se pudo mirar (prohibido en fase 1): ninguna ejecución. No he instalado, arrancado, restaurado ni actualizado nada. Todo lo que dice «funciona» procede de código, de la CI o de informes de terceros y así se etiqueta.
- CI de 8f380eb: `ci` (run 44383512640, 26/26 jobs success, incluye `e2e-restore-sftp-bootstrap`, `e2e-backup-sftp`, `functional-e2e / golden`, `docker-e2e`, `container-proxy-e2e`), `E6 security` success, `acceptance` success, **`nightly` failure** (run 44519497401, job `slow-suites`; causa no investigada, fuera de mi área; ver §7).

## 2. Resumen y veredicto

**Veredicto: NOT_READY** para la pregunta central («¿una persona ajena puede instalar, configurar, actualizar, respaldar, restaurar y mantener sin los desarrolladores?»). Camino a READY_WITH_CONDITIONS: cerrar OPS-01..OPS-05 (todo documentación y dos scripts pequeños).

1. La documentación de operaciones es extensa, honesta con sus límites y está cubierta por tests de CI (compose, backup SFTP, restore bootstrap, gates de despliegue). No es el problema; el problema es que **el camino «feliz» documentado no llega a un producto que funcione**: tras `installation.md` pasos 1-10 el stack está `healthy` pero **no se pueden validar bots ni ejecutar batallas** (OPS-01).
2. Para lograrlo hace falta una segunda instalación, a nivel de host y como root (proxy de Docker, firewall, imágenes de runtime, `DOCKER_PROXY_URL`), cuyo procedimiento está escrito como *migración* TD-062 y exige construir un bundle con Node ≥22.15 y compararlo con un sha256 sacado del resumen de un run de CI en GitHub (OPS-03).
3. El primer administrador sólo se crea por SQL directo con el registro abierto (OPS-02).
4. No hay requisitos de hardware, disco ni SO documentados; la única medida real (4 vCPU / 7 GB) es la de producción y la documentación admite que 3 batallas simultáneas ahogaron esa VM (OPS-05).
5. Los valores por defecto de `.env.example` inducen a error (`TAG=latest` no existe, dominio de otra instalación, enlaces a `docs/despliegue.md` inexistente) y el README declara el producto «no funcional» con estado del 2026-10-18 (OPS-04, OPS-11).
6. Backup: funciona y hay evidencia de terceros de un restore real a una BD temporal (40/40 tablas idénticas) y de una copia desde la VM reinstalada; pero exige un repositorio restic externo preexistente, `.env` no se copia, no hay alertas por defecto, la restauración completa es manual y el último ensayo documentado del procedimiento es de agosto (OPS-06, OPS-07).
7. Actualización/rollback: procedimiento seguro pero artesanal (tags por servicio, `config --hash`, `migrate` a mano, rollbacks por lista cerrada), sin releases versionadas ni changelog (OPS-08, OPS-14). No existe desinstalación documentada (OPS-10).
8. Medición real de complejidad (informe-reinstalación): **11 intervenciones manuales** fuera del guion en la reinstalación limpia; 5 serían sufridas por un tercero (§4.2).
9. Asistente de primera instalación: **no recomendado como primer paso**; recomendado un CLI guiado + comando `create-admin` (§8).
10. Falta además una LICENSE en main (fuera de mi área; impide una adopción legítima por terceros).

## 3. Matriz del área

| Elemento | Estado real | Evidencia | Qué falta | Prio | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Prerrequisitos de software | PARTIAL | `installation.md:34-44` lista Docker/Compose v2, git, curl, openssl, ssh-keygen; Node ≥22.15 «opcional» | cómo instalar Docker; Node ≥22.15 NO es opcional si se instala el proxy (OPS-03); Debian 12 trae Node 18 (informe-reinstalación usó NodeSource) | P1 | S | Sí (A) |
| Hardware mínimo/recomendado | **FALTA** | `grep` de RAM/vCPU/disco en `docs/operations/{installation,docker,configuration,index}.md`: sólo `configuration.md:58` (concurrencia auto) y `streaming.md:636` (≥3 vCPU libres + 1 GiB) | tabla mínimo/recomendado, disco, advertencia de carga | P1 | S | Sí (A) |
| SO soportados | DOC_ONLY/UNKNOWN | «Linux con Docker»; firewall asume iptables-nft (`firewall.md:47`); único SO evidenciado: Debian 12 (informe-reinstalación, tercero) | matriz de SO; persistencia systemd del firewall «no ensayada» (`firewall.md:165` DESIGN_ONLY) | P2 | S | No |
| Instalación del stack (pasos 1-10) | CODE_VERIFIED + CI (compose/e2e) | `installation.md`; `infrastructure/tests/compose*.test.ts`; job `container-proxy-e2e` verde | ver OPS-01/04 | P1 | S | Sí (A) |
| Ejecución real de bots (proxy+firewall+runtimes) | PARTIAL: procedimiento escrito como migración | `docker-proxy.md`, `upgrades.md#td-062`; CI `container-proxy-e2e` verde; PROD_VERIFIED por tercero (informe-reinstalación gate DOCKER_PROXY_OPS PASS, 19-nov) | ruta de instalación en limpio; artefacto publicado | P1 | M | Sí (A) |
| Dominio/TLS | Sin ACME. Autofirmado (`init-secrets.sh`) o proxy externo (`nginx-behind-proxy.conf`) | `networking.md:55-92`, `init-secrets.sh` (último bloque) | emisión de certificados reales; qué hacer si no hay proxy | P2 | M | No (B) |
| Primer admin | FALTA: SQL directo | `first-run.md:79-103`; TD-023; `cli.ts` sin comando | `create-admin` o `PROMOTE` | P1 | S | Sí (A) |
| bootstrap vs seed | Bien separado y documentado | `first-run.md:131-139` (`seed` prohibido); `cli.ts` | guardarraíl: `seed` no debería ejecutarse en perfil `production` | P3 | S | No |
| Secretos | `init-secrets.sh` idempotente; 0400 uid 1000 | `init-secrets.sh`; CODE_VERIFIED | custodia: ver OPS-07 | P2 | S | No |
| Backup | Funciona (CI SFTP); PROD_VERIFIED por tercero (copia desde VM nueva rc 0, `restic check` ok) | `backup.md`; informe-reinstalación gate BACKUP_FROM_NEW_VM; informe-export-b | repo restic externo obligatorio; sin alertas; `.env` fuera del backup | P1 | M | Sí (B) |
| Restore | `restore.sh` + fases manuales 5-6 | `restore.md`; CI `e2e-restore-sftp-bootstrap`; informe-export-b REAL_RESTORE (tercero, a PG temporal, no el procedimiento completo en host nuevo) | ensayo completo cronometrado en lab; automatizar fases 4-7 | P1 | M | Sí (B) |
| Actualización | Procedimiento seguro, manual | `upgrades.md` | comando único; releases versionadas; matriz de compatibilidad | P2 | M | No (B) |
| Rollback | App: etiqueta anterior; datos: sólo restic; migraciones: lista cerrada | `upgrades.md` «Vuelta atrás», `NAMED_ROLLBACK_ALLOWED` | rollback probado extremo a extremo en lab | P2 | M | No (B) |
| Desinstalación | FALTA | grep: sólo `s9-firewall uninstall` y retirada del proxy | documento + script | P2 | S | No (C) |
| Diagnóstico | Bueno en docs, con trampas conocidas | `diagnostics.md`, `troubleshooting.md`; `smoke.sh` engañoso (TD-020) | `doctor` único; `/healthz` con migraciones | P2 | M | No (B) |
| Monitorización/alertas | Perfil `observability` opt-in; 11 alertas; webhook vacío = nadie recibe | `observability.md:75-91`; TD-007 «NOT TESTED» | alertas probadas; activar por defecto un mínimo | P1 | M | Sí (B) |
| README / docs de entrada | Obsoletos | `README.md:8-16,41-52` (estado 2026-10-18) | reescribir estado y «12 servicios» (hay 13) | P2 | S | Sí (A) |
| Imágenes por TAG/sha | Bien: `sha-<commit>` inmutable, GHCR anónimo | `installation.md:#4`; compose; CI | `v0.0.0` móvil; sin releases | P2 | S | No |
| `docker-compose.demo.yml` | Retirado y rotulado | cabecera del fichero; `README.md:176` | eliminarlo del árbol para evitar confusión | P3 | S | No |

## 4. Fortalezas y debilidades

### 4.1 Fortalezas (con evidencia)
- **Imágenes inmutables y compose canónico**: `sha-<commit>` en GHCR, `--no-build`, `--no-deps`, gates (`release-gate.mjs`, `tag-override-gate.mjs`, `compose-canonical-check.mjs`) con mutantes; CODE_VERIFIED, y en CI (`ci` 26/26 verde @8f380eb) — TEST_VERIFIED sólo para lo que esos jobs ejercen, no para una instalación de tercero.
- **Secretos por fichero, sin argv ni `.env`**: `init-secrets.sh` idempotente, no sobrescribe, avisa si no puede dar el dueño; CODE_VERIFIED.
- **Backup bien diseñado**: `pg_dump -Fc`, manifest con sha256, secretos en snapshot aparte, retención por host lógico, healthcheck que mira la copia (26 h) y no el demonio, `--init-repo` explícito; CODE_VERIFIED + CI (`e2e-backup-sftp`, `e2e-restore-sftp-bootstrap`).
- **Proxy de Docker con frontera de privilegio explícita** (bundle de root, hash comprobado, preflight, rollback transaccional); la reinstalación del 19-nov lo instaló con preflight/validate verdes y 8 operaciones reales vía proxy (PROD_VERIFIED, tercero).
- **Honestidad documental**: cada doc declara FUNCIONA/PARCIAL/PENDIENTE y enlaza TD-xxx; comandos peligrosos con PRECONDITION/EFFECT/ROLLBACK.
- **Export portable** (`scripts/portable/portable.mjs`) permite mover bots/equipos entre instalaciones; informe-export-b lo verificó (37/37 bots, 8/8 equipos, idempotente) — evidencia de tercero.

### 4.2 Debilidades / medición de complejidad real (informe-reinstalación)

Intervenciones fuera del guion en la reinstalación limpia del 19-nov y si un tercero las sufriría:

| # | Intervención en informe-reinstalación | ¿Tercero? | Nota |
|---|---|---|---|
| 1 | cloud-init no veía el ISO (kernel `-cloud`); hubo que sembrar NoCloud a mano en el disco | NO (específico de Proxmox + imagen genericcloud) | |
| 2 | Instalar Docker Engine + Compose desde repo oficial | SÍ | no documentado (OPS-05) |
| 3 | Instalar Node 22.x desde NodeSource en el host (para el bundle del proxy) | SÍ | la guía dice «opcional» (OPS-03) |
| 4 | Clon de root fijado al SHA, `npm ci --ignore-scripts`, build del bundle y comparación del sha256 con el run de CI | SÍ | requiere consultar GitHub (OPS-03) |
| 5 | Instalar firewall de host (`s9-firewall install` + timer) desde el clon de root | SÍ | |
| 6 | Descargar imágenes de runtime por digest (`pull-runtime-images.sh`) | SÍ | |
| 7 | `bot-build-worker` reinició en bucle hasta ejecutar `bootstrap` | SÍ | orden up→bootstrap no avisa (OPS-13) |
| 8 | Elegir `RESTIC_HOSTNAME` distinto y recolocar secretos restic en la VM nueva | SÍ en parte | decisión no explicada para instalación nueva (OPS-06) |
| 9 | **Shim anti-forget/prune** al lanzar `backup.sh` a mano (para no tocar snapshots migrados del mismo repo) | NO en su motivo (repo compartido con histórico); SÍ si el repo es append-only | `backup.sh` ejecuta siempre `forget --prune`; no hay modo «sin poda» (OPS-06) |
| 10 | Primer admin: registro por web y promoción por SQL (paso 12, quedó pendiente del usuario) | SÍ | OPS-02 |
| 11 | `TOURNAMENT_WORKER_CONCURRENCY=2` por la VM de 4 vCPU; claves de streaming no migradas, hay que reintroducirlas por web | SÍ (ajuste de capacidad) | OPS-05 |

Adicionalmente (cuentas del propio informe): 13 contenedores con perfiles `production,streaming`; el tiempo de arranque de VM (~12-20 s) y demás cifras de informe-reinstalación son de ese entorno y no extrapolables.

Conteo de la ruta documentada para un producto funcional (mi recuento de `installation.md` + `first-run.md` + `upgrades.md#rc2` + `docker-proxy.md`, no un tiempo medido):
- Pasos de host previos no documentados: 4 (Docker, git/curl/openssl, usuario de despliegue, repositorio restic/SFTP).
- `installation.md`: 10 pasos (secretos, 4 acciones manuales con custodia; `.env` con 11 variables mínimas).
- `first-run.md`: 6 pasos (bootstrap, registro, SQL admin, `--init-repo`, copia manual, readiness que «nunca» da READY).
- Host/root para ejecución real: 7-8 pasos (clon de root, build, sha CI, install proxy, preflight/validate, firewall, runtimes, `DOCKER_PROXY_URL` en `.env` + recrear worker).
- Total: **≈ 27-30 pasos discretos y ≈ 10 decisiones**, de las cuales no están explicadas: `GATEWAY_CONF`/`TRUST_PROXY_HOPS` según topología (sí está en `networking.md` pero no en el flujo), dónde alojar el repositorio restic y la cuenta SFTP confinada (sin guía de creación del lado servidor), `RESTIC_HOSTNAME` (explicado el porqué, no cómo elegirlo), concurrencia según hardware, y si activar `streaming`/`observability`.

## 5. Hallazgos

### OPS-01 · El camino de instalación documentado no produce un producto que ejecute bots ni batallas
- Área: Instalación · Severidad **P1** · Tipo: DEFECTO_CONFIRMADO (documentación/flujo) · Grupo **A**
- Descripción e impacto (administrador, jugador): tras `installation.md` §1-10 el stack queda sano, pero `DOCKER_PROXY_URL` queda vacío en `tournament-worker` (sin valor por defecto «a propósito»): el worker no reclama `run_battle` y las batallas quedan `scheduled`; en `bot-build-worker` el defecto apunta a un proxy que no existe, así que «sin proxy, todo build se rechaza `sandbox no verificado`» (`configuration.md:52-53`). Ni `installation.md` ni `first-run.md` dicen que hay que instalar el proxy, el firewall, las imágenes de runtime y fijar `DOCKER_PROXY_URL` en `.env`; la tabla de prerrequisitos lo llama «opcional… hoy apagado en producción» (`installation.md:44`), lo que quedó obsoleto (el 19-nov producción lo tiene instalado). Un tercero obtiene una plataforma «verde» en la que ningún bot llega a `published`.
- Evidencia: `infrastructure/docker-compose.yml:290-308,366-368,474,543`; `docs/operations/installation.md:44,123-165`; `docs/operations/upgrades.md#rc2` («encender la ejecución real… sigue siendo un gate aparte»); `docs/operations/configuration.md:52-53`. CODE_VERIFIED/DOC_ONLY. Tercero: informe-reinstalación instaló proxy+firewall+runtimes en producción (PROD_VERIFIED, 19-nov).
- Reproducción: FASE 2 escenario S01+S04.
- Causa: la ejecución real nació como gate del operador (RC2) y la guía principal no se actualizó.
- Solución: integrar en `installation.md` un paso «Ejecución de bots» obligatorio (host: runtimes → red `bot-control` → firewall → proxy → `DOCKER_PROXY_URL`), y un `scripts/ops/install-host.sh` que lo encadene con preflight; añadir al `readiness`/`doctor` la comprobación «batallas se ejecutan» (no sólo `/healthz`).
- Esfuerzo: S (doc) + M (script) · incertidumbre baja. Dependencias: OPS-03. Validación: S01-S04 de la batería en lab.

### OPS-02 · El primer administrador exige SQL directo con el registro abierto
- Área: Administración · Severidad **P1** (antes TD-023 = P2; **sube** porque, con registro abierto TD-012, entre «registrarse» y «promover» no hay ventana segura y obliga a ejecutar SQL de escritura como paso de instalación) · Tipo: FALTA · Grupo **A**
- Descripción: `bootstrap` no crea usuarios; el registro da `user`+`developer`; `PUT /users/{id}/roles` exige admin. El único camino es `INSERT INTO user_roles … 'admin'` con `psql` (`first-run.md:79-103`). Valoración: es correcto como paliativo, está bien protegido (DANGER, rollback) y se verificó en entorno aislado (RUNTIME_VERIFIED por la consolidación) y en producción (informe-reinstalación, plan de paso 12), pero un tercero sin conocimiento del esquema tiene que tocar la BD de producción para poder usar la web; un error de email crea un no-op silencioso. Además no existe forma de recuperar acceso si se pierde el único admin (misma ruta SQL).
- Evidencia: `docs/operations/first-run.md:79-103`; `apps/api/src/db/cli.ts` (comandos: bootstrap, migrate, seed, rollback*, demo-teams; sin alta de admin); `apps/api/src/routes/auth.ts:167-171`; TD-023/TD-012. CODE_VERIFIED.
- Solución: `cli.ts create-admin --email <e> [--password-file <f>]` (idempotente: crea la cuenta si no existe, con contraseña por fichero/stdin, o promueve la existente; log de auditoría) y/o `S9_INITIAL_ADMIN_EMAIL` en `bootstrap`. Opcional: cerrar registro hasta que exista un admin.
- Esfuerzo: S · incertidumbre baja. Validación: S03 con PASS «login admin sin `psql`», test de CI.

### OPS-03 · La instalación del proxy de Docker en limpio exige root, Node ≥22.15, npm y un sha256 que sólo está en un run de CI
- Área: Instalación del host · Severidad **P1** · Tipo: RIESGO/DEUDA · Grupo **B**
- Descripción: `docker-proxy.md#instalación` y `upgrades.md#td-062` describen una *migración* de producción. Para instalar desde cero hay que: clonar como root fijado al SHA; `npm ci --ignore-scripts` (red a npm, Node ≥22.15 que Debian 12 no trae); construir el bundle; y comparar con `EXPECTED`, que «está en el run de `main` → job `container-proxy-e2e` → resumen del paso Veredicto independiente, o en el artefacto `functional-e2e-container-proxy-<intento>`» (`upgrades.md:~160`). Un tercero necesita acceso a la UI de GitHub Actions (los artefactos exigen sesión; la retención de runs/artefactos es limitada — HIPÓTESIS, no verificada) y saber qué run corresponde a su SHA. La seguridad del diseño es sólida, pero la ergonomía de adopción es de equipo, no de tercero. Parte de esta complejidad es inherente (frontera de root) y no debe relajarse.
- Evidencia: `upgrades.md:140-215`; `docker-proxy.md:#instalación`; `install-docker-proxy.sh`; informe-reinstalación (DOCKER_PROXY_OPS PASS, Node instalado desde NodeSource «no estaba en la lista», sha256 == CI). CODE_VERIFIED + PROD_VERIFIED (tercero).
- Solución: publicar el bundle y su sha256 como **asset de una release firmada** (GitHub Release del SHA) y un `install-host.sh` que lo descargue, verifique el sha contra el valor de la release y llame al instalador; documentar Node≥22.15 como requisito del host (o producir el bundle en CI como único camino y no construir en el host).
- Esfuerzo: M · incertidumbre media (política de confianza: asset de release vs. build local). Dependencias: OPS-14 (releases).

### OPS-04 · `.env.example`, `smoke.sh` y mensajes remiten a valores y documentos inexistentes
- Área: Configuración · Severidad **P1** (primera fricción de cualquier instalación) · Tipo: DEFECTO_CONFIRMADO · Grupo **A**
- Descripción: `infrastructure/.env.example` trae `TAG=latest` y `BACKUP_TAG=latest` (no existen en GHCR; `pull` falla), `S9_DOMAIN=` con un subdominio de la instalación del autor (ya reservado a otro proyecto del instalación del operador según su propio comentario), comentarios con referencias internas (VM de otro servidor) y enlaces a `docs/despliegue.md`, que no existe en main (`git ls-tree 8f380eb`). `init-secrets.sh` y `smoke.sh` también remiten a `docs/despliegue.md`; `smoke.sh` comprueba `/api/healthz` y `/replays/healthz` (TD-020: nunca da verde con sentido). El `.env.example` de la raíz (`ARENA_PORT/TICK_RATE/VIEWER_PORT`) es del prototipo v1 retirado. `docker-compose.demo.yml` sigue en la raíz.
- Evidencia: `infrastructure/.env.example` (secciones Identidad e Imágenes); `.env.example`; `infrastructure/scripts/init-secrets.sh:2`; `infrastructure/scripts/smoke.sh:2-4,21-24`; `installation.md:#5` (reconoce el `TAG=latest`). CODE_VERIFIED.
- Solución: `TAG=` vacío con fallo claro (el compose ya falla en cerrado para backup), plantilla sin datos de otra instalación (`example.com`), eliminar enlaces muertos, arreglar o borrar `smoke.sh`, mover o borrar el `.env.example` y el compose de la v1.
- Esfuerzo: S · incertidumbre baja.

### OPS-05 · Sin requisitos de hardware, disco ni SO; la sobrecarga ya causó incidentes
- Área: Prerrequisitos · Severidad **P1** · Tipo: FALTA · Grupo **A**
- Descripción: no existe tabla de mínimo/recomendado. Sólo hay hechos dispersos: producción corre con 4 vCPU/≈7 GB; «3 batallas en 4 vCPU ahogaron la VM» y recomendación de fijar `TOURNAMENT_WORKER_CONCURRENCY` (`configuration.md:58`); streaming exige ≥3 vCPU libres y ≥1 GiB sin swap (`streaming.md:636`). Los límites del compose, sumados (CODE_VERIFIED, mi cálculo): perfil `production` = 19,5 CPU y ≈12,75 GiB de límite (no son reservas; el uso real es menor); `streaming` añade 4 CPU/4 GiB; la ejecución de bots añade contenedores con ≤1 GiB/≤2 CPU cada uno. El hipervisor compartido también tumbó una prueba (memoria de proyecto: incidente de carga). No hay dimensionado de disco (imágenes, volúmenes, replays, `backup_work` que «duplica los volúmenes», MP4 del streamer) ni SO soportados más allá de Debian 12 evidenciado por un tercero.
- Evidencia: `docker-compose.yml` (`deploy.resources.limits`); `configuration.md:58`; `streaming.md:573,622-636`; `backup.md:149`. CODE_VERIFIED/DOC_ONLY.
- Solución: tabla «Requisitos» en `installation.md` (mínimo/recomendado por perfil, concurrencia sugerida, disco por componente), SO soportados (Debian 12 / Ubuntu LTS **sólo si** se pasa la batería en lab), y comprobación de recursos en el preflight del instalador.
- Esfuerzo: S (doc) + M (medir en lab, FASE 2) · incertidumbre media.

### OPS-06 · Backup: repositorio externo obligatorio sin guía del lado servidor, poda no desactivable y sin alertas por defecto
- Área: Backup · Severidad **P1** · Tipo: RIESGO · Grupo **B**
- Descripción: sin `RESTIC_REPOSITORY` el contenedor `backup` arranca pero queda `unhealthy` y no copia; el entrypoint tolera esa config incompleta (decisión explícita «el día 1») y sólo avisa a las 26 h por una alerta que no existe si `observability` está apagado y `ALERT_WEBHOOK_URL` vacío (nadie recibe nada). Un tercero debe crear por su cuenta el host/cuenta SFTP confinada (`ChrootDirectory`) y verificar la huella a mano; no hay guía del lado servidor ni opción de volumen local gestionado. `backup.sh` ejecuta siempre `forget --prune` (retención 14/8/12) sobre el grupo `host,tags`; no hay modo append-only/sin poda, y la reinstalación de informe-reinstalación tuvo que interceptarlo con un shim (motivo específico, pero demuestra la falta del interruptor). `infrastructure/.env` **no** entra en el backup (`restore.md#custodia`). El propio informe de terceros advierte: copias y VM en el mismo host físico = no independientes (riesgo de infraestructura; para un tercero equivale a «copia en el mismo disco» si usa una ruta montada local).
- Evidencia: `backup.md:#estados`, `entrypoint.sh:30-58`, `backup.sh` (forget/prune ~l.747-771), `observability.md:75-91`, `restore.md#custodia`; informe-reinstalación desv. 4 y gate BACKUP_FROM_NEW_VM; informe-export-b §4. CODE_VERIFIED + tercero.
- Solución: (a) incluir `.env` (sin secretos, ya lo es) en el snapshot de config; (b) `BACKUP_PRUNE=0`; (c) guía de 10 líneas para montar un destino SFTP o local mínimo; (d) `up` falla o avisa claramente si `RESTIC_REPOSITORY` está vacío; (e) alerta mínima sin perfil observability (p. ej. healthcheck → webhook).
- Esfuerzo: M · incertidumbre baja.

### OPS-07 · Restauración completa: manual y sin ensayo cronometrado desde agosto
- Área: Restore · Severidad **P1** (TD-025 ya es P1; **se mantiene**) · Tipo: RIESGO · Grupo **B**
- Descripción: `restore.sh` restaura a un directorio; BD y volúmenes se colocan a mano (fases 4-7, con `pg_restore -c` y copia a volúmenes). Evidencia favorable de terceros: restore real del dump a una BD temporal con 40/40 tablas idénticas y sha256 del dump igual (informe-export-b REAL_RESTORE, 18-nov), restore de secretos y lectura del repositorio con la contraseña custodiada (SECRETS_CUSTODY), y copia desde la VM nueva. Pero no se probó el procedimiento `restore.md` completo en un host limpio y no hay tiempos. Dependencia de custodia: sin contraseña restic + clave SSH + known_hosts verificado fuera del servidor no hay restauración; la custodia propuesta por terceros está en otra VM del mismo hipervisor (riesgo declarado, no resuelto).
- Evidencia: `restore.md` (fases 1-7, «Ensayo», «Estado actual»); TD-025; informe-export-b §1.2, §3, §4. CODE_VERIFIED + PROD_VERIFIED parcial (tercero).
- Solución: `scripts/ops/restore-all.sh` que encadene fases 2-7 con comprobaciones (conteo de tablas, `migrate`, healthz) y un ensayo trimestral registrado en lab; documentar la custodia fuera de banda como requisito.
- Esfuerzo: M · incertidumbre media. Validación: S08.

### OPS-08 · Actualización y rollback sin comando único y con riesgo de desfase de esquema
- Área: Actualización · Severidad **P2** · Tipo: DEUDA/HIPÓTESIS · Grupo **B**
- Descripción: el procedimiento (copia → editar `TAG` → `config --hash` → `pull` → `up --no-build --no-deps` por grupos → `migrate` a mano → verificar) es seguro pero largo y exige criterio. La API no migra al arrancar: entre `up` de la versión nueva y `migrate` los servicios corren con esquema viejo (HIPÓTESIS: producir errores transitorios; no verificado). El rollback de datos sólo es restic (sin snapshots de VM en la referencia, TD-007); el de migraciones admite una lista cerrada (`NAMED_ROLLBACK_ALLOWED`: 016-019) y `rollback:1` actúa sobre «la última de la lista» (trampa documentada). Las secciones de `upgrades.md` por versión (016-019, 0.4.0, 0.5.0) crecen cada release sin una matriz de compatibilidad desde-hasta. «Estado de partida» describe la instalación de referencia mezclada, no una instalación limpia.
- Evidencia: `upgrades.md` (completo), `apps/api/src/db/migrations.ts`, TD-006/007. CODE_VERIFIED.
- Solución: `scripts/ops/upgrade.sh --to sha-<x>` que haga preflight, copia, diff de `config --hash`, up por grupos, `migrate`, verificación y registro; matriz de versiones; ensayo de rollback en lab (S09).
- Esfuerzo: M-L · incertidumbre media.

### OPS-09 · Dominio y TLS: sin emisión de certificados; el tercero debe aportar proxy o certificados
- Área: Red · Severidad **P2** · Tipo: FALTA (decisión de producto) · Grupo **B**
- Descripción: el gateway nginx sirve TLS con certificados que el operador pone en `secrets/tls/` (por defecto, autofirmados de 365 días generados por `init-secrets.sh`) o delega en un proxy inverso externo. No hay ACME/Let's Encrypt ni Caddy/Traefik opcional. Con autofirmado el navegador muestra error y el streamer/WebSocket pueden comportarse distinto (no verificado). Para un tercero sin proxy, la ruta «dominio real + HTTPS» no está resuelta; la autorrenovación tampoco (HIPÓTESIS: el autofirmado caduca al año y no hay aviso).
- Evidencia: `networking.md:55-92`, `init-secrets.sh` (bloque TLS), `nginx.conf`/`nginx-behind-proxy.conf`. CODE_VERIFIED.
- Solución: documentar receta con un proxy (Caddy de 5 líneas) y/o perfil `tls-acme` opcional; alerta de caducidad.
- Esfuerzo: M · incertidumbre media.

### OPS-10 · No existe procedimiento de desinstalación ni de limpieza
- Área: Operación · Severidad **P2** · Tipo: FALTA · Grupo **C**
- Descripción: sólo hay `s9-firewall uninstall`, retirada del proxy (parar y quitar la unidad conservando config, usuario y allowlist) y la advertencia de que `down -v` borra los datos. No se cubre: orden de baja, volúmenes `infrastructure_*`, imágenes y runtimes por digest, usuario `s9proxy`, `/etc/s9-*`, `/usr/local/{lib,sbin}/s9-*`, clon de root (informe-reinstalación deja `<clon de trabajo de root en el host> red `s9-botctl0`, reglas iptables, cron/timers, copias en el repositorio restic.
- Evidencia: `docker-proxy.md#rollback`, `firewall.md:95`, `docker.md:108`, `index.md:78`. CODE_VERIFIED (ausencia).
- Solución: `docs/operations/uninstall.md` + `scripts/ops/uninstall.sh --dry-run` con inventario antes de borrar.
- Esfuerzo: S-M · incertidumbre baja.

### OPS-11 · README y documentación de entrada contradicen el estado actual
- Área: Documentación · Severidad **P2** · Tipo: DEFECTO_CONFIRMADO · Grupo **A**
- Descripción: el README abre con «Estado actual (2026-10-18): en producción no es funcional de extremo a extremo… el cierre funcional está sin fusionar», tabla de estado con Build «Bloqueado», visor «Roto en navegador» y «12 servicios» (main tiene 13 con `streamer`; `installation.md:#10` dice «11 healthy + backup»). `docs/operations/index.md` declara contraste con `27f70bb` (octubre), `installation.md` «hoy apagado en producción». Es lo primero que lee un tercero, y le dice que el producto no sirve.
- Evidencia: `README.md:8-16,41-52,176`; `docs/operations/index.md:6-9`. CODE_VERIFIED. Prioridad previa: sin TD; el tema de docs obsoletas está en `known-issues.md`.
- Solución: reescribir estado desde `docs/roadmap/current-status.md` (actualizada) y fecha de última verificación; matiz: coordinar con el agente de documentación.
- Esfuerzo: S · incertidumbre baja.

### OPS-12 · Monitorización y readiness no certifican una instalación real
- Área: Observabilidad · Severidad **P2** · Tipo: DEUDA · Grupo **B**
- Descripción: `observability` es opcional; sus alertas (11) existen en configuración pero «NOT TESTED» en instalación real (`observability.md` Verificación); `scripts/readiness.ts` «nunca» da READY (comprobaciones obligatorias no ejercibles desde CLI); `/api/v1/healthz` no informa de migraciones; no hay alerta de salud real de la emisión (TD-066). Un operador no tiene una señal única de «mi instalación está sana y puede jugar».
- Evidencia: `observability.md:75-97`, `readiness.md`, `first-run.md:#5`, TD-007/TD-020/TD-066. CODE_VERIFIED/DOC_ONLY.
- Solución: comando `doctor` (versión y commit por servicio, migraciones, proxy alcanzable, batalla de humo, último backup, disco, firewall `check`) con rc≠0 accionable; probar una alerta de punta a punta en lab (S10).
- Esfuerzo: M · incertidumbre media.

### OPS-13 · El orden up → bootstrap deja servicios en bucle de reinicio sin avisar
- Área: Instalación · Severidad **P3** · Tipo: DEUDA · Grupo **B**
- Descripción: `installation.md` ordena `up -d` (paso 7) antes de `bootstrap` (paso 8). En informe-reinstalación `bot-build-worker` reinició en bucle hasta que existió la tabla `jobs` (tras el bootstrap quedó healthy). La guía dice «esperable: backup unhealthy…» pero no esto, y el conteo esperado («11 healthy + backup») es de 12 servicios, no de los 13 de 0.5.0.
- Evidencia: `installation.md:#7-#8`; informe-reinstalación gate SERVICES_HEALTHY (tercero). DOC_ONLY + tercero.
- Solución: documentarlo, o `up -d postgres queue` → `bootstrap` → `up -d` (mejor, y reflejarlo en `install.sh`).
- Esfuerzo: S.

### OPS-14 · Sin releases versionadas ni changelog: «qué actualizo y a qué»
- Área: Release · Severidad **P2** · Tipo: FALTA · Grupo **B**
- Descripción: la CI publica `sha-<commit>` y `v0.0.0` (móvil); el motor es 0.5.0 pero el paquete raíz no declara versión; no hay GitHub Release, tag ni notas. Un tercero debe elegir un SHA «bueno» sin guía y no sabe qué migraciones o pasos de host trae cada uno (esos están en `upgrades.md` por RC). Sin LICENSE en main (fuera de mi área, afecta a terceros).
- Evidencia: `installation.md:#4` («siempre `v0.0.0`… móvil»), `.github/workflows/ci.yml:362,375-377` (según installation.md); `git ls-tree 8f380eb` sin LICENSE/CHANGELOG. CODE_VERIFIED.
- Solución: tags semver + GitHub Releases con notas, sha del bundle del proxy (OPS-03), digests y migraciones; política de soporte (versión actual y anterior).
- Esfuerzo: M.

### OPS-15 · SO soportado y firewall del host: supuestos no ensayados fuera de Debian
- Área: Host · Severidad **P3** · Tipo: HIPÓTESIS · Grupo **C**
- Descripción: el firewall asume iptables-nft, `systemd` y reglas sobre bridges `br-+`; «si Docker pasa a nftables… reevaluar»; la persistencia con systemd real figura como DESIGN_ONLY; el instalador se ejecuta como root desde clon fijado. Docker rootless no soporta este diseño (proxy con grupo `docker`); Ubuntu/RHEL/ARM no probados. Sólo evidencia: CI en runner Ubuntu y Debian 12 de terceros.
- Evidencia: `firewall.md:47,138,165`; `firewall.env.example`. DOC_ONLY.
- Solución: declarar matriz de SO y probar en lab (S01 en Debian 12 y Ubuntu 24.04).
- Esfuerzo: M.

## 6. Deuda técnica

### 6.1 Revalidación de la registrada (área operaciones/instalación)

| TD | Prioridad anterior | Nueva | Motivo |
|---|---|---|---|
| TD-006 Runtime mezclado sin identidad de build | P0 (MEJORADA) | **P3 / casi cerrable** | La reinstalación limpia del 19-nov deja 13/13 contenedores en `sha-8f380eb…` verificados con `docker inspect .Config.Image` (PROD_VERIFIED, tercero). Cerrar cuando una auditoría de lectura lo confirme. |
| TD-007 Backup sin alertas, sin snapshots de VM, apagado no limpio | P0 (MEJORADA) | **P1** | Backup funciona y se verificó desde la VM nueva (tercero); se mantiene abierto por alertas no probadas y destino compartido en el mismo host (OPS-06, OPS-12). Ya no es P0. |
| TD-012 Registro abierto | P1 | P1 (sin cambio) | Se agrava en instalación: sin ventana segura previa a la promoción (OPS-02). |
| TD-020 Healthz/humo engañosos | P2 | **P2 → P1 si no se arregla antes de ofrecer la guía** | `smoke.sh` y `/api/healthz` son lo primero que probará un tercero; falsos verdes (OPS-04). |
| TD-023 Administración sólo por SSH / primer admin | P2 | **P1** | OPS-02. |
| TD-024 Instalación no reproducible | P2 | **P1** | Hoy es reproducible sólo con ayuda de los autores (OPS-01/03/05), parcialmente mitigada. |
| TD-025 Restauración sin ensayo reciente | P1 | P1 (sin cambio) | El ensayo parcial de informe-export-b no es el procedimiento completo (OPS-07). |
| TD-057 Árbol de despliegue con ficheros de root | P2 | P2 | Sin cambio. |
| TD-062 Proxy ejecuta código de árbol no root | P1 (CERRADA en main) | **CERRADA verificable** | Instalado con preflight/validate verdes y sha igual al de CI en producción (PROD_VERIFIED, tercero). El coste que queda es de adopción (OPS-03). |
| TD-066 Streaming: clave en argv de FFmpeg, sin retención MP4 ni alerta | P3 | P3 | Fuera de mi área; sólo la alerta de emisión cae en OPS-12. |

### 6.2 Deuda nueva no registrada
- OPS-01 (flujo de instalación no llega a ejecución real), OPS-03 (adopción del proxy), OPS-04 (valores por defecto y `smoke.sh`), OPS-05 (requisitos), OPS-10 (desinstalación), OPS-14 (releases/changelog), OPS-15 (SO). Proponer TD-0xx para OPS-01/03/05/10/14.

## 7. Verificaciones para FASE 2 (laboratorio aislado)

Entorno: **laboratorio aislado**, nunca producción ni el hipervisor de producción: una VM Debian 12 limpia (4 vCPU/7 GB, igual que producción, con snapshot `BASE-LIMPIA`) y, para S01-bis, una segunda con Ubuntu 24.04; acceso a Internet sólo a GHCR/npm/GitHub; repositorio restic en destino SFTP **de laboratorio** (contenedor `atmoz/sftp` o similar, otro disco). Ejecutar con `LAB=1`; registrar rc y salida de cada paso. la máquina de orquestación sólo orquesta.

### Batería de escenarios

| ID | Escenario | Comandos (resumen) | Criterio de PASS |
|---|---|---|---|
| S01 | **Instalación limpia** (sólo con las docs, sin ayuda): cronometrar y contar intervenciones | desde snapshot: instalar Docker, `git clone`, checkout SHA, `bash infrastructure/scripts/init-secrets.sh`, `.env`, `$DC pull`, `$DC up -d --no-build` | Todos los pasos de `installation.md` ejecutables sin conocimiento externo; `$DC ps` = 12 (13 con streaming) servicios `healthy` salvo `backup`; `curl /healthz`, `/api/v1/healthz`, `/version` con el commit esperado. Registrar nº de pasos no documentados (objetivo 0) |
| S02 | Config mínima | `.env` con sólo las 11 variables mínimas; `GATEWAY_CONF` en ambos modos; `TRUST_PROXY_HOPS` 1 y 2 | Stack arranca en modo (a) con TLS autofirmado y en modo (b) tras un nginx de lab; `X-Forwarded-For` correcto (login bloqueado por IP real) |
| S03 | Primer admin | `bootstrap`; registro por web/API; promoción; (tras fix OPS-02) `create-admin` | Sin `psql`: login admin y acceso al panel; con el procedimiento SQL actual: rc=0, roles correctos, rollback SQL revierte; `seed` rechazado en perfil production (si se implementa) |
| S04 | Ejecución real: proxy + firewall + runtimes | `pull-runtime-images.sh` (`RUNTIME_IMAGES_READY=YES`), `s9-firewall.sh install/check`, build y `install-docker-proxy.sh install`, `preflight`, `validate`, fijar `DOCKER_PROXY_URL`, recrear workers; `network-probe.mjs --expect-default-route-blocked` | `preflight` rc 0, `check` rc 0, `network-probe` rc 0; **medir** nº de pasos/decisiones no documentados |
| S05 | Primer bot + build + batalla | crear cuenta, bot de ejemplo (`example-bots/`), versión, build → `published`, batalla A vs B | Versión `published`; batalla `finished` con ganador; replay reproducible y `verify` OK; sin contenedores huérfanos en `docker ps -a` |
| S06 | Primer torneo | torneo de 4 bots, formato liga | Todas las batallas `finished`, ranking Elo no vacío, replays presentes; con `TOURNAMENT_WORKER_CONCURRENCY` 1 y 2: carga de CPU/RAM medida (`docker stats`, `vmstat`) y VM sin lockups (dmesg) |
| S07 | Streaming opcional | `COMPOSE_PROFILES=production,streaming`; configurar destino desde la web con un RTMP receptor de lab (no YouTube) | `streamer` healthy; sesión iniciada hacia el receptor de lab; recursos medidos en ≥3 vCPU libres; sin claves en `docker inspect`/argv |
| S08 | Backup + restore completo | `--init-repo`; `backup.sh`; `evidence.sh`; **destruir la VM**, restaurar desde snapshot base con sólo la custodia (password+clave+known_hosts+`.env`); seguir `restore.md` fases 1-7 | Restauradas todas las tablas (conteo + md5 por tabla vs. original), replays y bots; `healthz` OK; nueva copia manual correcta; **cronometrar y contar pasos manuales**; sin la custodia el procedimiento falla en cerrado |
| S09 | Actualización desde la versión anterior + rollback | instalar `sha-<anterior>` con datos; `upgrades.md` hasta `sha-8f380eb`; luego volver; probar con batalla `running` | Migraciones aplicadas; sin datos perdidos; tras rollback app OK y esquema coherente (probar `rollback:name` y el camino «restore previo»); documentar ventana de desfase entre `up` y `migrate` (HIPÓTESIS OPS-08) |
| S10 | Recuperación tras fallo | matar `postgres` (kill -9), llenar disco al 95 %, reiniciar VM en caliente, perder `queue`, parar el proxy, backup con destino caído; con `observability` activado y webhook de lab | Cada fallo: detección (healthcheck/alerta recibida en el webhook de lab), recuperación documentada sin pérdida (excepto trabajo en vuelo declarado) y sin batallas `running` zombis; alerta `BackupTooOld` simulada llega |
| S11 | Desinstalación | seguir (futuro) `uninstall.md`: `down`, retirar proxy/firewall/unidades, volúmenes, usuario, red, clon de root | Inventario posterior = inventario previo a S01 (`docker ps -a`, `volume ls`, `systemctl list-unit-files 's9*'`, `iptables -S`, `ls /etc/s9*`); datos destruidos a propósito sólo con confirmación |
| S12 | Sin conocimientos previos (usabilidad) | una persona ajena (no autora) sigue sólo `README`→`installation`→`first-run` | Llega a S05 sin preguntar; se registran los puntos de bloqueo (cada pregunta = un hallazgo) |
| S01-bis | Segundo SO | repetir S01+S04 en Ubuntu 24.04 | PASS ⇒ ampliar matriz de SO (OPS-15); FAIL ⇒ documentar límite |

### Comprobaciones sueltas (lab/lectura)

| Qué | Comando/prueba | Entorno | Confirma / refuta |
|---|---|---|---|
| El `TAG=latest` de `.env.example` rompe `pull` | copiar `.env.example`, `$DC pull` | lab | `manifest unknown` ⇒ OPS-04 confirmado |
| Sin `DOCKER_PROXY_URL` las batallas quedan `scheduled` y el build se rechaza | tras S01: crear bot y batalla | lab | confirma OPS-01 |
| Un tercero obtiene el sha256 esperado del proxy | consultar el run `main` de un SHA sin cuenta de GitHub | lectura GitHub + lab | si exige login o ya expiró ⇒ confirma OPS-03 |
| Desfase de esquema entre `up` y `migrate` | S09 con tráfico sintético durante la ventana | lab | errores 5xx ⇒ confirma OPS-08 |
| Retención de logs/artefactos de CI | `gh run view <viejo>` | lectura | si caducó ⇒ el sha del proxy no es recuperable (OPS-03) |
| Certificado autofirmado expira a los 365 días | `openssl x509 -enddate` sobre `tls/fullchain.pem` | lab | sin aviso ⇒ OPS-09 |
| `nightly/slow-suites` rojo en 8f380eb | `gh run view 44519497401 --log-failed` | lectura | si afecta a operación (restore/backup) elevar; si es de suite lenta ajena, descartar |
| `backup.sh` con repositorio de sólo-anexar | destino SFTP sin permisos de borrado | lab | `forget --prune` falla ⇒ confirma OPS-06 (poda no desactivable) |

## 8. Respuestas cortas a las preguntas del brief

- **¿Puede un ajeno instalar, configurar, actualizar, respaldar, restaurar y mantener sin los desarrolladores?** Hoy no (NOT_READY). Un sysadmin experto con Docker y paciencia llegaría a un stack sano siguiendo `installation.md`, pero **no a uno que ejecute bots**; para eso necesita un procedimiento de host escrito como migración, Node ≥22.15 y un sha256 de un run de CI. Actualizar y restaurar son seguros pero artesanales y sin ensayo reciente completo.
- **Prerrequisitos / hardware / SO:** software razonablemente listado (salvo cómo instalar Docker y que Node ≥22.15 no es opcional con proxy); hardware **no documentado** (producción corre con 4 vCPU/≈7 GB; se sabe que 3 batallas simultáneas la ahogan; límites de compose suman ≈12,75 GiB); SO: sólo Debian 12 evidenciado (tercero).
- **Pasos:** ≈27-30 pasos discretos y ≈10 decisiones para un producto funcional; 11 intervenciones manuales en la reinstalación real, 5 atribuibles a infraestructura propia (cloud-init, parte del backup) y ≥6 que sufriría un tercero.
- **Dominio/TLS:** no lo trae resuelto; autofirmado o proxy externo (el modo (b) se usa en producción con un proxy del instalación del operador).
- **Primer admin por SQL (valoración):** aceptable como paliativo documentado y reversible, **no aceptable como camino de instalación**: sube a P1; se arregla con un `create-admin` de ≈1 día.
- **bootstrap vs seed:** correcto y bien advertido (`seed` prohibido en producción; crea usuarios con contraseña del repo); falta un guardarraíl técnico.
- **Backups/restore:** diseño sólido y verificado en CI y, parcialmente, en producción por un tercero; faltan destino local por defecto, alertas, inclusión de `.env`, automatización de las fases 4-7 y ensayo completo reciente.
- **Actualización y rollback:** seguro y trazable; sin comando único ni releases; rollback de datos = restic; trampas conocidas con `rollback:1`.
- **Desinstalación:** inexistente.
- **Diagnóstico y monitorización:** buenas guías, pero ningún comando único de «estoy sano»; alertas opt-in y sin probar en real.
- **Asistente de primera instalación vs. CLI guiado (viabilidad y recomendación):**
  - Ya existe un modelo: `packages/first-run/` (13 dominios, librería con tests y mutantes) **sin interfaz** (`first-run.md#el-asistente-r17`).
  - Un asistente web tiene un problema de huevo y gallina: necesita el stack levantado y la parte difícil (Docker, proxy root, firewall, runtimes, restic, TLS) es de host y requiere root: la web no puede ni debe hacerla. Un asistente web sería sólo «bootstrap+admin+comprobaciones» (valor real pequeño, riesgo de exposición si queda accesible; L, incertidumbre alta).
  - Recomendación: **CLI guiado idempotente** `s9ctl` (o `scripts/install.sh`): `preflight` (SO, recursos, Docker, puertos, Node, DNS/GHCR) → `secrets` → `env` (preguntas con defaults y validación, sin datos de otra instalación) → `pull` verificando digest → `host` (proxy/firewall/runtimes con el bundle de la release) → `up` → `bootstrap` → `create-admin` → `backup-init` → `doctor`. Cada paso reanudable, con `--dry-run` y salida accionable. Reutilizar los 13 dominios de `first-run` como lista de comprobaciones. Esfuerzo estimado: **M-L** (incertidumbre media), empezando por lo de más valor y menos riesgo: `create-admin` (S), `.env.example` y requisitos (S), `doctor` (M), `install-host.sh` (M).
  - Un asistente web puede venir después (grupo C/D), como «checklist de estado» tras el CLI, no como instalador.


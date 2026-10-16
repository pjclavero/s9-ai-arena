# Informe de consolidación documental (2026-10)

## Resumen

Toda la documentación de S9 AI Arena se reorganizó en una estructura canónica única, tomando como
base la auditoría del 2026-10-15. La documentación que explica cómo funciona el sistema **hoy**
(visión general, usuario, técnica, operaciones, desarrollo y roadmap) queda separada de la que
explica **cómo se llegó hasta aquí** (auditorías, pruebas, ADR e histórico).

El código no ha cambiado. Este trabajo no corrige ningún defecto del producto: los documenta con su
estado real y su deuda. El veredicto de producto de la auditoría sigue vigente.

## Índice

- [Base y alcance](#base-y-alcance)
- [Cambios desde la auditoría](#cambios-desde-la-auditoría)
- [Hallazgos de la auditoría](#hallazgos-de-la-auditoría)
- [Recuentos documentales](#recuentos-documentales)
- [Coherencia código ↔ documentación](#coherencia-código--documentación)
- [Coherencia servidor ↔ Git](#coherencia-servidor--git)
- [Árbol documental canónico](#árbol-documental-canónico)
- [Deuda, pendientes y problemas conocidos](#deuda-pendientes-y-problemas-conocidos)
- [Pruebas humanas](#pruebas-humanas)
- [Huecos documentales que quedan](#huecos-documentales-que-quedan)
- [Método](#método)
- [Veredicto](#veredicto)

## Base y alcance

| Dato | Valor |
|---|---|
| BASELINE AUDIT | auditoría del 2026-10-15 sobre `27f70bb` ([resumen](2026-10-15/README.md)) |
| CURRENT COMMIT | `27f70bb` (origin/main, sin cambios desde la auditoría) |
| Rama de trabajo | consolidación documental, sin integrar en `main` |
| Cambios en producción | ninguno |
| Cambios de código | ninguno (solo `.md` dentro de `docs/` y el `README.md` raíz) |

## Cambios desde la auditoría

| Medida | Resultado |
|---|---|
| COMMITS_SINCE_AUDIT | 0 |
| FILES_CHANGED_SINCE_AUDIT | 0 |
| FEATURES_CHANGED_SINCE_AUDIT | ninguna. Todo hallazgo de código conserva su estado (PRESERVE AUDIT STATUS) |
| DOCS_CHANGED_SINCE_AUDIT | 0 antes de esta consolidación |
| Runtime | el backup programado del 2026-10-15 04:15 UTC terminó correctamente, `restic check` sin errores, y el contenedor pasó a `healthy`. Las imágenes en ejecución y el árbol desplegado no cambiaron. El host sigue sin snapshots de VM. |

Única área afectada: copias de seguridad. Detalle en el [AUDIT-DELTA](2026-10-15/AUDIT-DELTA-2026-10.md).

## Hallazgos de la auditoría

| Estado actual | Nº |
|---|---|
| CLOSED | 0 |
| IMPROVED | 2 (P0-7 copia de seguridad y el área BACKUP) |
| UNCHANGED | 38 |
| SUPERSEDED | 2 (correcciones de la propia auditoría) |
| REGRESSED | 0 |
| UNKNOWN | 1 |

**AUDIT FINDINGS CLOSED:** ninguno.

**AUDIT FINDINGS STILL OPEN:** los ocho P0 siguen abiertos.

- P0-1: build sin sandbox.
- P0-2: bot de relleno y doble camino de ejecución.
- P0-3: costura `rulesetId`.
- P0-4: replays a anónimos.
- P0-5: autorización de participantes.
- P0-6: runtime mezclado.
- P0-8: topología en el repositorio público. En `main` sigue abierta; esta consolidación la limpia en `docs/`, pero quedan ficheros fuera de `docs/` (TD-008).
- P0-7: mejora, aunque sigue sin alertas, sin snapshots y con apagado sucio.

Los P1 siguen igual.

**NEW FINDINGS** (salidos de la verificación de esta consolidación, todos CODE_VERIFIED):

| Id | Hallazgo | Deuda |
|---|---|---|
| NEW-1 | El worker aloja el WebSocket de espectador, pero no recibe el secreto para verificar tickets: todo ticket se rechaza | [TD-028](../roadmap/technical-debt.md#td-028) |
| NEW-2 | El aviso Redis del worker no tiene productor; la cola avanza por polling | [TD-026](../roadmap/technical-debt.md#td-026) |
| NEW-3 | La clasificación pública consulta una temporada en la que nunca se escribe; sale siempre vacía | [TD-029](../roadmap/technical-debt.md#td-029) |
| NEW-4 | El compose no entrega a la API varias variables que esta lee; ponerlas en `.env` no tiene efecto | [TD-030](../roadmap/technical-debt.md#td-030) |

También aparecieron otros dos defectos, que se registraron dentro de deudas ya existentes:

- El motor tiene tres modos que la plataforma no expone ([game-modes](../technical/game-modes.md)).
- El mapa de serie declara menos modos de los que admite ([maps](../technical/maps.md)).

**Correcciones a la auditoría** (el informe original no se modifica):

- La API usa Express 5, no Fastify.
- Sí hay límite de intentos de login: bloquea tras 20 fallos. El defecto es que la clave del límite
  se agrupa en la IP del proxy.
- `restore.sh` admite `--snapshot <id>`, no solo `latest`.

## Recuentos documentales

| Medida | Valor |
|---|---|
| OLD DOC COUNT | 138 `.md` en `origin/main` (incluidos los README de paquetes, SDK y runtimes, y el `README.md` raíz) |
| Decisiones de migración | KEEP 21 · UPDATE 2 · MERGE 49 · MOVE 22 · ARCHIVE 44 · DELETE 0 ([mapa](../DOC-MIGRATION-MAP.md)) |
| NEW CANONICAL DOC COUNT | 70 en `docs/{overview,user,technical,operations,development,roadmap}`, más `README.md` raíz y `docs/README.md` |
| ARCHIVED / EVIDENCE DOC COUNT | 119 en `docs/{adr,testing,history,audits}` (12 ADR, 11 de pruebas, 89 históricos y 7 de auditoría) |
| DELETED DUPLICATES | 0. Ningún duplicado era puro y no se eliminó información histórica |
| Fuera de la estructura | `docs/recuperacion.md` (lo vigila un test), `docs/aceptacion/` y `docs/balance/` (los genera el código) |

## Coherencia código ↔ documentación

| Control | Resultado |
|---|---|
| Afirmaciones marcadas en los documentos canónicos | 390 CODE_VERIFIED · 80 RUNTIME_VERIFIED · 11 DESIGN_ONLY |
| Documentos técnicos, de operación, desarrollo y roadmap con sección «Verificación» | todos |
| Documentos de usuario con sección «Verificación» | ninguno, a propósito: sus afirmaciones enlazan al documento técnico que las verifica |
| Enlaces relativos rotos | 12. Son las anclas del índice generado de un documento histórico (`history/planes/Dosier_tareas_S9_AI_Arena.md`), que ya estaban rotas en `main` |
| Documentos huérfanos en `docs/` | 0 (en `main` había 81) |
| Tests que leen documentos | 3 lecturas reales en el código. Ninguna apunta a un documento movido. `docs/recuperacion.md` sigue en su sitio, y su test se ejecutó (3 passed, rc=0) y se calibró con una mutación (1 failed, rc=1) |
| Referencias a rutas antiguas de `docs/` en el código | unas 30, todas en comentarios o mensajes; inventariadas en el [mapa](../DOC-MIGRATION-MAP.md) como deuda menor |
| Seguridad documental (IPs con `ipaddress`, Tailscale, WAN, VMID, hosts, dominios, emails y tokens) | 0 hallazgos reales en `README.md` y `docs/`. Las coincidencias restantes son marcadores (`<vmid>`) o falsos positivos (`paquete@versión`, `usuario@192.0.2.10`) |

Los comandos de instalación y operación se contrastaron con el código. Una parte se ejecutó en un
entorno aislado, nunca en producción: perfiles, nombre del proyecto y volúmenes, arranque sin build,
`bootstrap` idempotente, `pg_dump` con el rol real, resolución de etiquetas de imagen en el
registro y un ensayo seco de restauración. Esos comandos están marcados como RUNTIME_VERIFIED.

## Coherencia servidor ↔ Git

Sin cambios respecto a la auditoría:

- El árbol desplegado está 12 commits por detrás de `main`, y es ancestro suyo.
- El runtime mezcla tres versiones de imagen sin identidad de build verificable.
- El perfil real es `production`, con 12 servicios.

Esta consolidación no despliega nada. El contenido nuevo de `docs/` no afecta al runtime.
Deuda: [TD-006](../roadmap/technical-debt.md#td-006).

## Árbol documental canónico

```text
README.md                    portada: qué es, estado, arquitectura, inicio rápido, navegación
docs/
  README.md                  entrada: por audiencia, por pregunta y por carpeta
  overview/                  project, architecture, technologies, glossary
  user/                      getting-started, accounts, bots, equipment, teams, maps, game-modes,
                             battles, tournaments, viewer, replays, rankings, statistics, administration
  technical/                 architecture, services, data-flow, database, queue, workers, gateway,
                             api, websocket, engine, game-modes, battles, bots, equipment, maps,
                             tournaments, replays, frontend, security
  operations/                installation, first-run, configuration, docker, networking, backup,
                             restore, readiness, diagnostics, upgrades, shutdown, troubleshooting,
                             docker-proxy, runtime-drift-scanner
  development/               setup, repository, workflow, testing, ci, releases, contributing,
                             conventions, contract-compatibility
  roadmap/                   current-status, technical-debt, known-issues, pending-features
  adr/                       decisiones de arquitectura (12)
  audits/                    2026-10-15/ (resumen público + delta), anteriores/, este informe
  testing/                   drills, validación, smoke, spikes, regresión del motor
  history/                   status/, entregas/, rondas/, programas/, planes/, diseños/, operaciones/
  DOC-MIGRATION-MAP.md       destino de cada documento anterior
```

Cada carpeta tiene un `index.md` razonado que resume cada capítulo en una frase. La deuda solo
vive en `roadmap/technical-debt.md`. Los documentos funcionales la enlazan, no la repiten.

## Deuda, pendientes y problemas conocidos

| Documento | Contenido |
|---|---|
| [technical-debt.md](../roadmap/technical-debt.md) | 30 entradas confirmadas al cerrar la consolidación (TD-001 a TD-030): 8 P0, 11 P1, 6 P2, 2 P3, 3 P4. Después se añadió TD-031 (P1), que salió del refresco de dependencias de PR #151 |
| [pending-features.md](../roadmap/pending-features.md) | 27 entradas: diseñadas sin implementar, mejoras previstas e ideas |
| [known-issues.md](../roadmap/known-issues.md) | 27 síntomas visibles para usuario u operador, con su solución temporal y su deuda |
| [current-status.md](../roadmap/current-status.md) | fuente única del estado; sustituye a `estado-proyecto.md` y `ESTADO_ACTUAL.md`, ahora en `history/status/` |

## Pruebas humanas

Se comprobaron recorriendo enlaces desde `README.md`, sin búsqueda. Los 26 destinos que piden las dos
pruebas están como máximo a **2 clics**, y desde el README se alcanzan 196 documentos:

- Prueba 1: qué es, tecnologías, arquitectura, bots, mapas, modos de juego, batalla, instalación,
  Docker, API, frontend y backend, backup, cómo desarrollar y deuda.
- Prueba 2: quién crea y ejecuta una batalla, dónde se guarda el resultado, replays, build de bots,
  mapas, comunicaciones, PostgreSQL, Redis, cómo arrancar, cómo ejecutar los tests, cómo hacer un
  PR, qué está roto y qué viene después.

Además, [docs/README.md](../README.md#preguntas-frecuentes-y-dónde-se-responden) tiene una tabla
que va directamente de cada pregunta a su documento.

## Huecos documentales que quedan

- **Documentación de usuario de flujos que no funcionan.** Publicar un bot, ver una batalla con
  código propio, reproducir replays y guardar mapas en el editor se describen como PENDIENTE. Hay
  que reescribirla cuando se cierren TD-001, TD-002, TD-003, TD-009 y TD-010.
- **Topología fuera de `docs/`.** Siguen con datos reales `infrastructure/.env.example`, la
  configuración nginx detrás de proxy, `deploy-contract.json`, `smoke.sh` y fixtures de tests. Va
  aparte porque son código y tests ([TD-008](../roadmap/technical-debt.md#td-008)). El historial de
  Git conserva las versiones anteriores de los documentos saneados.
- **Referencias a rutas antiguas de `docs/` en comentarios del código.** Inventariadas, sin
  corregir. Este trabajo no toca código.
- **Ejemplos de punta a punta.** No se pueden documentar como ejemplo real crear un bot y verlo
  ganar una batalla, ni abrir su replay, hasta que esos flujos funcionen.
- **Documento histórico con anclas rotas.** El índice del dosier E1-E12 quedó tal cual.
- **Suites completas.** No se ejecutaron en esta fase, que es solo documental. Las cifras de tests
  citadas proceden de la auditoría.

## Método

- Tres carriles en paralelo, cada uno en su worktree y desde el mismo commit, con propiedad de
  ficheros disjunta:
  - estado, código y arquitectura;
  - producto, usuario y técnica de producto;
  - operaciones, desarrollo y migración.
- Integración, portada, índices, nueva deuda, este informe y la verificación final.
- Las herramientas de comprobación se calibraron antes de usarse:
  - el escáner detectó en `main` la topología que ya había contado la auditoría;
  - el comprobador de enlaces distinguió anclas válidas e inválidas en un caso de control;
  - el generador de anclas reprodujo las de GitHub en 8 casos conocidos.
- La evidencia completa es interna y no está en el repositorio.

## Veredicto

**DOCUMENTACIÓN CONSOLIDADA.**

- Hay una estructura canónica única con fuente de estado única, deuda confirmada con id, evidencia
  separada y navegación completa desde el README.
- Cada afirmación relevante de la documentación técnica está atada a una línea de código o a una
  medición.
- Ninguna funcionalidad rota se presenta como existente.

**El producto sigue NO FUNCIONAL de extremo a extremo.** Esta consolidación lo deja escrito, no lo
cambia. La siguiente fase es cerrar los P0 ([current-status.md](../roadmap/current-status.md)) y
reescribir la documentación de usuario a medida que cada flujo funcione de verdad.

## Documentación relacionada

- [Auditorías](README.md)
- [Mapa de migración](../DOC-MIGRATION-MAP.md)
- [Estado actual](../roadmap/current-status.md)
- [Entrada a la documentación](../README.md)

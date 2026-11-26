> Anexo de trazabilidad: informe de trabajo original, saneado para publicación (rutas locales sustituidas por marcadores y sección de anexo privado retirada; estaba vacía). Las severidades y grupos **finales** son los de los documentos 01-15, no los de este informe.

# Agente 7 — Documentación, producto y roadmap (prefijo DOC-)

- Repo: pjclavero/s9-ai-arena · HEAD verificado (`git -C <árbol-auditado@8f380eb> rev-parse HEAD`): `8f380eb700c3e984691649b3449d2c543038dfb1` · Fecha: 2026-11-19
- Alcance: docs/ de main, ficheros de raíz, ramas y PR documentales (sólo `git show/diff/log`, `gh` lectura), roadmap contrastado con código, preparación para publicar, onboarding de colaboradores, inventario de PR abiertos.
- NO se miró: producción, laboratorio, ejecución de tests/builds. Los enlaces se comprobaron con un script estático propio (sólo lectura); los anclajes `#...` no se verificaron.

## 2. Resumen y veredicto: NOT_READY (documentación/roadmap para publicación) · READY_WITH_CONDITIONS en estructura

1. La estructura de docs/ es buena y consistente (portada por audiencia, `DOC-MIGRATION-MAP`, histórico separado, ADR indexados). 2.311 enlaces relativos en `.md`: **0 rotos** (CODE_VERIFIED, script estático).
2. El **contenido de estado está obsoleto**: `README.md` raíz dice «Estado actual (2026-10-18)… no es funcional de extremo a extremo», con tabla de TD-001/002/003/009 que ya están resueltas; `docs/README.md` y todo `docs/roadmap/*` fijan `MAIN_SHA e3bf2fa` (2026-11-02, motor 0.4.0, migraciones 001–016). main real = `8f380eb`: **586 commits después**, motor 0.5.0, migraciones hasta 022, OpenAPI 0.25.0.
3. Para quien llegue al repo público, la primera pantalla afirma que el producto no funciona. Es el defecto de documentación más grave (DOC-01).
4. **No hay LICENSE** (ni en main ni declarada en `package.json`/pyproject); GitHub confirma `license: null`. Legalmente «todos los derechos reservados»: nadie puede usar, copiar ni contribuir con garantías (DOC-02).
5. No hay CHANGELOG, ni tags, ni releases de GitHub (0 tags en el clon; `.changeset/` sólo contiene `config.json`, sin changesets). No hay SECURITY.md, ni plantillas de issue/PR, ni CODE_OF_CONDUCT ni plantillas (`.github/` sólo contiene CODEOWNERS y workflows).
6. Buena base de onboarding: `docs/development/{setup,contributing,workflow,testing,conventions}.md`, guía del jugador `user/getting-started.md` (8 pasos) y 12 páginas de programación de bots con ejemplos Python/JS. Falta un «quick start» único de 5 minutos y capturas.
7. Ramas docs: `docs/usuario` y `docs/integracion` 0 por delante (integradas). #277 está **superada por OLA 2 ya mergeada** y 384 por detrás: rescatar parcialmente, no mergear.
8. 35 drafts `[REVIEW] … NO MERGEAR` (#182–#248): todos apuntan a PR ya MERGED (comprobados 6 de ellos); candidatos a cerrar tras verificar que sus tests de rotura se integraron o archivarlos.
9. Roadmap: 8 afirmaciones clave obsoletas (TD-066 argv, TD-015 batalla `failed`, inscripción de equipos, cancelar torneo…). Ver DOC-03.
10. Veredicto: la plataforma documenta mucho y bien; lo que falla es la **vigencia** y los **mínimos de publicación** (licencia, versionado, SECURITY).

## 3. Matriz de roadmap (contrastada con main 8f380eb)

Clasificación: **I** imprescindible próxima versión · **C** conveniente aplazable · **F** futuro/experimental.

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Motor y reglas | Funciona, motor 0.5.0, reglas oficiales/presets, CTF con prórroga (CODE_VERIFIED; CI de 8f380eb: 28 success, 1 neutral, 1 failure = `nightly`) | `apps/arena-engine/src/engine-deps.json`; ADR-022/024; docs desfasadas (`technical/engine.md:195` aún «OLA 2 sin desplegar») | Actualizar docs; issues #232 (`sharedTeamVision` no aplicada) y #233 (`utility` ignorado) abiertas; #261-263 (inferencia por API pública) | I (docs y #261-263 si se abre público) / C | S docs · M-L motor | No (docs sí recomendable) |
| Bots y equipamiento | Funciona; TD-016 PARCIAL (campos de catálogo sin efecto), #197/#198 munición | `docs/technical/equipment.md`, `effect-status` citado en roadmap; issues #197 #198 | Decisión de masa/coste de munición; efectos pendientes del catálogo; Module Catalog v2 (PR #266 DESIGN_ONLY) | C | M | No |
| Torneos | 6 formatos; inscripción de equipos (#290), cancelar (#289), ciclo de vida con batallas `failed` (#299) mergeados; CTF rechazado con motivo (TD-070) | `apps/api/src/routes/tournaments.ts:45-70`; `apps/tournament-worker/src/results.ts:73,266-271`; `battle-rules.ts:415` | Roadmap sigue diciendo «batalla failed bloquea cierre» y «teams no usable»; E2E de formatos distintos de eliminación simple; CTF en torneos | C (docs: I) | S docs · M E2E | No |
| Replays y espectador | Replays y lectura gobernada (CODE_VERIFIED); espectador/replays públicos apagados por capability (#269 ajustes runtime en admin) | `docs/roadmap/pending-features.md` (Parciales); `apps/web/src/pages/LivePage.tsx`, `ReplaysPage.tsx` | Decisión de activación y gate de perímetro; replay v2 pendiente; #264 revisión de semilla | I si se quiere espectador público; si no, C | M | Sólo si se anuncia modo público |
| Streaming V1 | Cadena Chromium→FFmpeg→RTMPS; clave **ya no en argv** (cambio posterior al roadmap); YouTube real reportado PASS por operador (DOC_ONLY/evidencia de tercero) | `apps/streamer/src/ffmpeg.ts:10`; issues #252 #254 #256 #241 | Actualizar TD-066 (aún ABIERTA en main); retención de MP4 y alerta; #256 imagen blanca | C | S-M | No |
| Streaming V2 | DESIGN_ONLY (PR #275 MS-1; sin código `StreamSession`/`BroadcastQueue` en main: `git grep` vacío) | PR #275 `docs/technical/STREAMING_ARCHITECTURE_V2.md` (1.249 líneas, sólo en rama) | Implementación MS-2+ | F | XL | No |
| Administración web | Parcial: roles, auditoría, hallazgos, catálogo, estado, streaming, ajustes runtime (#269) | `AdminPage.tsx`, `StreamingPage.tsx`, `SystemPage.tsx`, `RolesPage.tsx`; TD-023 | Backup/restore/readiness/drift sólo CLI | C | L | No |
| Usuarios y cuentas | **Incompleto**: `/auth/recover` crea el token y lo descarta; sin canal de entrega; sin pantallas de 2FA ni sesiones (`git grep "auth/(2fa|sessions|recover|reset)" apps/web/src` vacío); registro abierto | `apps/api/src/routes/auth.ts:386-398,440`; TD-012 | Canal de email o recuperación por operador; pantallas 2FA/sesiones; límites de registro | **I** (cualquier apertura a terceros) | M-L | **Sí** si se abre a usuarios externos |
| Estadísticas y rankings | Elo, clasificación de temporada con política `official_played_not_reverted` (#229, migr. 018) | `docs/user/rankings.md`, `statistics.md`; ADR-E9-002 | P3: TD-067/068/069/071 | C | S-M | No |
| Mejoras visuales | R16.1-R16.3 hechas; fases visuales posteriores (sonido, texturas, niebla) pendientes; PR #253 visual-bots (4.477 líneas, sólo en rama, con test de contrato) | `docs/roadmap/pending-features.md`; PR #253 | Decidir plan maestro; mount types | F/C | L-XL | No |
| SDK y herramientas para programadores | SDK JS y Python reales + `local-simulator.ts` (JS); .NET y Java sólo README | `sdks/javascript/src`, `sdks/python/arena_sdk`, `sdks/dotnet/README.md`; `docs/user/bots/probar.md` | Publicar SDK (paquetes sin registro, sin licencia), tutorial primer bot ya existe pero sin captura; retirar o rotular dirs vacíos | C (I el tutorial y la licencia) | S-M | No (licencia sí) |
| Instalación y mantenimiento | Docs ops completas (installation, upgrades, backup, restore, portable-export) | `docs/operations/*`; issue #107 (`restore.sh --verify` falla), TD-025 restore sin ensayo, TD-031 imágenes vulnerables, `nightly` rojo (run 44519497401 en 8f380eb) | Arreglar nightly y #107; ensayo de restauración; escaneo de imágenes | I (fiabilidad) | M | Parcial (restore verificado) |
| Auth/seguridad de superficie pública | TD-008 (nombres internos en código, tests, CI), TD-033, TD-041, TD-043 abiertas | `docs/roadmap/technical-debt.md:42,67,75,77`; #247 oráculo de existencia de bots | Limpieza previa a publicidad del repo | **I** | M | Sí para publicidad amplia |

## 4. Fortalezas y debilidades

Fortalezas (con evidencia):
- Estructura canónica clara por audiencia y `docs/README.md` con «reglas de lectura»; histórico aislado en `docs/history` (CODE_VERIFIED, listado de directorios).
- Enlaces internos sanos: 0/2.311 rotos.
- Convención de «## Verificación» con estados de evidencia en cada documento; los roadmaps están escritos con rigor (citan fichero:línea).
- Guía del jugador y de programador de bots amplia (12 páginas de bots, ejemplos Python/JS, `probar.md`); ADR 18 + índice; `CODEOWNERS`, `contributing.md`, `workflow.md`, `setup.md` (Node ≥ 22.15) detallados.
- OpenAPI versionada (0.25.0) con histórico de cambios en comentarios.

Debilidades:
- Estado desactualizado en README, docs/README y roadmap (DOC-01, DOC-03).
- Sin LICENSE/SECURITY/CHANGELOG/releases (DOC-02, DOC-05).
- Idioma: toda la documentación y el README en español; el repo es público y SDK/OpenAPI son internacionales (sin versión en inglés). Los comentarios de código mezclan español (DOC-09).
- Ficheros sueltos en raíz sin explicación (DOC-07).
- docs/README reconoce «rutas `docs/…` inexistentes citadas en comentarios de código y compose» (deuda conocida).

## 5. Hallazgos (por severidad)

### DOC-01 · README raíz y portada de docs declaran un estado falso
- Área: Documentación · P1 · DEFECTO_CONFIRMADO · Grupo A (bloqueante de lanzamiento público)
- `README.md` (cabecera «Estado actual (2026-10-18)»: «no es funcional de extremo a extremo», tabla con TD-001/002/003/009/010/029 «roto/bloqueado», y «Hoy ese flujo se corta en varios puntos») contradice `docs/roadmap/current-status.md` (golden path en navegador real PASS). `docs/README.md` y todo `docs/roadmap/*` anclan en `e3bf2fa` (2026-11-02), 586 commits atrás. Impacto: un visitante/colaborador/evaluador concluye que el producto no sirve; todo audit posterior parte de cifras falsas (motor 0.4.0, migraciones 016, «111 commits por delante de producción»).
- Evidencia: `README.md:8-16,41-52,118`; `docs/README.md:7`; `docs/roadmap/current-status.md:8-16`; `git rev-list --count e3bf2fa..8f380eb` = 586. CODE_VERIFIED.
- Solución: reescribir cabecera/tabla de README desde current-status actualizado; sustituir `MAIN_SHA` fijo por «revisado a fecha X» y automatizar con un check de CI que compare SHA citado vs ancestro de main. Esfuerzo S (README) + M (roadmap completo), incertidumbre baja.

### DOC-02 · Repo público sin LICENSE
- P1 · FALTA · Grupo A
- Sin licencia, el código es «all rights reserved» por defecto: terceros no pueden legalmente usar, forkear (más allá de lo que concede GitHub ToS: ver/fork en la plataforma), distribuir ni contribuir con claridad; los SDK no son consumibles por un programador de bots; ningún package declara `license`. Además hay dependencias con licencias propias (Rapier, Phaser, etc.) cuya compatibilidad no está inventariada (sin SBOM/NOTICE). Decisión de negocio: MIT/Apache-2.0 (permisivas, Apache da cláusula de patentes) vs AGPL (protege servicio alojado) vs mantener privado. El `.docx` del dosier y el zip podrían tener contenido no licenciado.
- Evidencia: `git ls-tree 8f380eb` sin LICENSE*; `gh api repos/...` → `license: null`, `visibility: public`. CODE_VERIFIED.
- Solución: elegir licencia, añadir `LICENSE`, campo `license` en package.json/pyproject, `NOTICE`/terceros, CLA o DCO si se aceptan PR externos. S (decisión del propietario), incertidumbre media (legal).

### DOC-03 · Roadmap con afirmaciones obsoletas frente a main
- P2 · DEFECTO_CONFIRMADO · Grupo B
- `known-issues.md`: «un torneo con una batalla fallida no termina» (TD-015) → resuelto en main (`results.ts:73,266-271,367-369`, #299). `pending-features.md`/TD-066: «clave de emisión en argv de FFmpeg» → comentario `ffmpeg.ts:10` indica que ya no (EQ5b); TD-066 aparece ABIERTA. «Inscripción de equipos en torneos» (#290, issue #287 abierta pero PR mergeado) y «cancelar torneo» (#289) no aparecen como completadas. `technical/engine.md:195` sigue diciendo «OLA 2 sin desplegar»/«hardening/contracts»; OLA 2 está en main (#294). «Migraciones 001–016» vs 022; «OpenAPI 0.12.0» vs 0.25.0. Impacto: planificación errónea y re-trabajo.
- Evidencia: ficheros citados @8f380eb. CODE_VERIFIED salvo estado de producción (REPORTADO).
- Solución: re-auditoría documental sobre 8f380eb (reusar método de PENDING-AUDIT). L (≈1 semana por el volumen de technical-debt.md: 1.444 líneas, 71 TD). Incertidumbre media.

### DOC-04 · Deuda TD-064 no registrada en main
- P3 · DEUDA · Grupo C
- PR #169 (draft, 2026-10-22) corrige `init-secrets.sh` (enlaces simbólicos/directorios ajenos) con 275 líneas de test; `grep TD-064` en `technical-debt.md` de main no encuentra nada. La corrección y su registro se perdieron. Solución: rescatar rama (rebase) o registrar TD y cerrar PR. S.

### DOC-05 · Versionado y releases inexistentes
- P2 · FALTA · Grupo B
- 0 tags, 0 releases GitHub, sin CHANGELOG. `.changeset/config.json` presente pero sin changesets ni script `changeset` verificado; `docs/development/releases.md` define «una release es un commit de main» (ADR-017) con imágenes GHCR. Hay versiones por componente (motor 0.5.0, OpenAPI 0.25.0) sin fecha ni notas de compatibilidad agregada para usuarios/operadores. Solución: tag `v0.5.0` con notas generadas (los PR están bien titulados), CHANGELOG mínimo, o retirar `.changeset` si no se usa. S-M.

### DOC-06 · Falta de ficheros de comunidad
- P2 · FALTA · Grupo B
- Sin SECURITY.md (el procedimiento está en `contributing.md#informar-de-un-problema-de-seguridad`, pero GitHub no lo detecta), sin `.github/ISSUE_TEMPLATE`, sin PULL_REQUEST_TEMPLATE (`.github/` sólo tiene CODEOWNERS y workflows), sin CONTRIBUTING.md en raíz (está en `docs/development/contributing.md`). Contributing exige «mutantes y controles negativos» en cada PR: barrera alta para externos, sin versión «ligera». Solución: archivos de 1 pantalla enlazando a docs. S.

### DOC-07 · Ficheros sueltos en raíz sin propósito documentado
- P3 · DEUDA · Grupo C
- `Dosier_tecnico_S9_AI_Arena_motor_2D_modular.docx` (58 KB) y `s9-ai-arena-part2.zip` (26 KB; 55 entradas, scaffold de arena-server/arena-viewer anterior; commit «Add S9 AI Arena project scaffold») son artefactos de la génesis; el código cita «dosier 22.x/capítulo 28» en CODEOWNERS, ci.yml y `acceptance/criteria.mjs`, sin enlace al documento. El zip duplica y contradice el árbol actual. `docker-compose.demo.yml` raíz es «prototipo v1 retirado y no debe usarse» (README) y sigue en raíz; `pnpm-workspace.yaml` coexiste con npm workspaces (el setup dice npm). Solución: mover docx a `docs/history/` con nota (o convertir en md), eliminar zip y compose demo (o moverlos a history). S.

### DOC-08 · PR documentales: contenido y destino
- P3 · RIESGO · Grupo B
- #277 (docs/refresh-2026-11-12, 17 commits, 384 detrás, **no draft**): su MAIN_SHA es `f590947` y declara OLA 2 «no integrada» y `MS-1 DESIGN_ONLY`; es obsoleta como conjunto (main ya integró OLA 2). Rescatar: texto de `operations/streaming.md` (YouTube real, límites v1), `user/administration.md` (+39 líneas, ajustes de acceso público runtime #269/#274), `user/equipment.md`, `user/visibility.md`, cierre de TD-066 y `history/status/completadas-2026-11.md`. No mergear los 4 de `roadmap/*` (se rehacen). Cerrar tras cherry-pick selectivo.
- #286 (2 commits; `roadmap/NEXT_WEB_STREAMING_UX_WAVE.md`, 586 líneas, ausente en main): plan vigente de producto, conviene mergear tras revisar fechas; hoy es el único plan de siguiente ola. #266 (`roadmap/engine-hardening-module-catalog-v2.md`, 656 líneas, ausente en main): Module Catalog v2 es DESIGN_ONLY; parte de OLA 2 ya está hecha (#285 g1, #280, #281): reconciliar con lo mergeado antes de integrar o archivar en history. #258 (rc8-status-refresh, 444 detrás): superada por completo, cerrar. #253 (visual-bots, 4.477 líneas + test de contrato de 1.874 líneas, 444 detrás): único activo de las «mejoras visuales»; decisión de producto: o se integra en `docs/history/diseños` / roadmap F, o se cierra conservando rama. #174 (auditoría de desarrollador externo 2026-10-27, no draft, 855 detrás, 32 ficheros): su valor es el hallazgo de que README de SDK/runtimes estaban mal; contrastar contra main (muchos README ya reescritos) y rescatar sólo los de `sdks/*/README`, `runtimes/README`, `example-bots/javascript/README` si siguen desfasados; cerrar. #173 (informe RC4): histórico; mover el informe a `docs/history/entregas` o cerrar. #168 (RC3 gates, 863 detrás): `operations/upgrades.md` con +178 líneas — main ya tiene un `upgrades.md` más reciente; comparar, cerrar.
- Evidencia: `git diff --stat` por rama @ merge-base; `git ls-tree 8f380eb` para los ficheros nuevos. CODE_VERIFIED. Esfuerzo S-M.

### DOC-09 · Idioma y accesibilidad internacional
- P3 · DEUDA · Grupo C
- Todo en español, incluida la API (OpenAPI comentarios), mensajes de error y SDK README. Para un público de programadores de bots fuera del ámbito hispano es una barrera; no es bloqueante para una comunidad hispanohablante. Solución: README + quick start + guía de bots en inglés (M).

### DOC-10 · Sin material demo/capturas
- P3 · FALTA · Grupo B
- `git ls-tree` sin imágenes `.png/.gif` ni capturas (sólo seeds de demo en `apps/api/src/db/seeds`). La guía del jugador es sólo texto; no hay GIF del visor ni de una batalla. Solución: 4-6 capturas/GIF (lo captura el golden path Playwright, ya existente) y un vídeo corto. S.

### DOC-11 · Sin quick start de 5 minutos para programadores externos
- P2 · FALTA · Grupo B
- Existe `user/getting-started.md` (8 pasos web) y `user/bots/probar.md` y SDK locales, pero no una guía «escribe un bot y ejecútalo contra un simulador local sin cuenta» enlazada desde README. El simulador local existe (`sdks/javascript/src/local-simulator.ts`); lo comprobable ejecutando queda en Fase 2. Solución: `docs/user/bots/quickstart.md` + enlace en README. S.

### DOC-12 · Documentación de API: referencia sólo a mano
- P3 · FALTA · Grupo C
- `docs/technical/api.md` (279 líneas) + `apps/api/openapi.yaml` (107 operaciones, v0.25.0) sin una referencia renderizada (Redoc/Swagger) publicada. Tipos del SDK JS generados desde el contrato (`generate-types.mjs`). Solución: publicar referencia estática en CI. S-M.

### DOC-13 · 35 PR `[REVIEW] … NO MERGEAR` abiertos
- P3 · DEUDA · Grupo E
- #182–#248: ramas `review/*`/`eq6*` con pruebas de rotura de PR ya mergeados (comprobado MERGED: #201, #220, #227, #229, #242, #244). Hay ruido (~35 de 52 abiertos), riesgo de merge accidental pese al título, y ocultan los PR vivos. Además el flujo exige que sus tests entren al árbol principal («mutantes en no vacuidad»); no verificado que todos lo hayan hecho (HIPÓTESIS). Propuesta: ver sección 8.

## 6. Deuda técnica relacionada

Revalidada (documentación/roadmap): TD-008 (P0, topología en código/tests/CI) mantiene P0 hasta publicitar; si el repo ya es público, **debería ser P1 bloqueante** de visibilidad pública (el repo ya expone nombres internos en código según el propio registro). TD-012 (P1) mantiene P1 y sube a «bloqueante» si se abre el registro a terceros. TD-066 P3: debe cerrarse (argv). TD-015 P1 PARCIAL: la parte del cierre con batalla `failed` está resuelta (#299); queda E2E de formatos. TD-064: sin registro en main. TD-019 (nightly rojo) sigue vigente (run 44519497401 failure en 8f380eb). Nueva: «estado documental desfasado» (DOC-01/03), «sin licencia» (DOC-02).

## 7. Verificaciones para FASE 2
1. Que `quickstart` local funciona sin cuenta: en laboratorio aislado, `npm ci && npm test` y ejecutar el simulador local del SDK con un bot de ejemplo; confirma setup.md. 
2. Que los comandos de `docs/operations/installation.md` instalan un stack de cero (lab aislado, sólo lectura en prod).
3. Estado real de producción vs afirmaciones «REPORTADO por el operador» (versión desplegada, migración): `/version` en prod sólo lectura.
4. Enlaces con ancla `#...` y enlaces externos: script en CI.
5. Que `nightly` rojo es el mismo defecto TD-019 (`gh run view 44519497401 --log-failed`).
6. Si los tests de los PR `[REVIEW]` existen en main: diff de nombres de tests por PR.

## 8. Respuestas cortas
- **Organización/duplicados:** correcta; duplicados menores (`docs/history/status/ESTADO_ACTUAL.md` vs `current-status*`, `docs/balance/informe-v1.md` vs `v1.md`, `aceptacion/ultimo-informe.md` generado). Idioma: 100 % español.
- **Enlaces rotos:** 0 de 2.311 relativos; sin comprobar anclajes ni externos.
- **Ramas docs:** `docs/usuario`, `docs/integracion`: integradas, borrables. #277: parcial, superada. #286: mergear tras revisar. #266: reconciliar. #258: cerrar. #253: decisión de producto. #174/#173/#168: cerrar tras rescatar README SDK/informe RC4.
- **LICENSE:** sin licencia = no utilizable ni contribuible legalmente; elegir y añadir antes de promocionar.
- **PR [REVIEW] (35):** cerrar todos con comentario «integrado en #NNN»; antes, un script que verifique que cada test añadido existe en main o abrir un PR único «tests de rotura» con los que falten. Conservar las ramas con tag `archive/review-...` si se desea. **Drafts históricos R11-R17 (#96-#113)**: sus contenidos (ADR-R14, R16 audit) ya están en main en `docs/adr`/`audits/anteriores`; cerrar. **Vivos**: #295 (reset competitivo, con tests; mantener hasta decisión de lanzamiento), #275 (diseño streaming v2; mantener como DESIGN_ONLY o mergear como doc), #169 (rescatar/registrar), #153 (TD-045 ya cubierto por `functional-e2e`; cerrar), #136 (replay access governance: superado por #158; cerrar).
- **Colaboradores nuevos:** buen mapa (`setup`, `workflow`, `testing`, `conventions`), pero faltan CONTRIBUTING en raíz, plantillas, «good first issue», y quick start; ver DOC-06/11. `.changeset` y `pnpm-workspace.yaml` son ruido.


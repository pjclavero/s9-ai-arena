# 10 · Auditoría de documentación

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Propósito: inventariar y contrastar la documentación del repositorio con main, decidir qué hacer con las ramas y PR documentales y listar los mínimos de publicación que faltan. Informe de síntesis: [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md).

Convenciones: «P1→P2 (REVISION-TECNICA)» marca una severidad ajustada; «(DECISIONES-DIRECTOR)» un arbitraje. Fuente principal: informe 07, REVISION-TECNICA, REVISION-PRODUCTO, V-01, V-02, V-04. Las comprobaciones marcadas «(consolidación)» se repitieron en solo lectura sobre 8f380eb el 2026-11-19.

## 1. Veredicto

**NOT_READY para publicar; READY_WITH_CONDITIONS en estructura** (informe 07, mantenido por REVISION-TECNICA).

1. La estructura de `docs/` es buena: portada por audiencia, `DOC-MIGRATION-MAP.md`, histórico aislado, 18 ADR indexados. `CODE_VERIFIED`.
2. El **estado** que cuenta está obsoleto: el README de la raíz dice «no es funcional de extremo a extremo» (V-02) y `docs/README.md` y todo `docs/roadmap/*` anclan en un commit de hace 586 commits.
3. No hay LICENSE, SECURITY.md, CHANGELOG, tags ni releases, plantillas de issue/PR ni una sola imagen o captura.
4. La documentación del producto (usuario, bots, operaciones, técnica) es amplia y rigurosa en su método; falla su **vigencia** y los **mínimos de publicación**.
5. 51 PR abiertos, 29 con «NO MERGEAR» en el título (consolidación); ramas documentales ya integradas; una PR de refresco (#277) que no se puede mergear.

## 2. Inventario y organización

Recuento de ficheros bajo `docs/` en 8f380eb (consolidación, `git ls-tree`): 246 ficheros, de ellos:

| Directorio | Ficheros | Contenido | Estado |
|---|---|---|---|
| `docs/user` | 44 (incluye 12 páginas de bots y ejemplos) | Guía del jugador y del programador | Amplia; sin capturas |
| `docs/operations` | 19 | Instalación, primer arranque, upgrades, backup, restore, proxy, firewall, red, observabilidad | Completa; defectos de flujo (ver [07](07-INSTALLATION-OPERATIONS.md)) |
| `docs/technical` | 23 | Arquitectura, API, motor, BD, colas, streaming | `engine.md:195` aún dice «OLA 2 sin desplegar» |
| `docs/development` | 10 | `setup`, `contributing`, `workflow`, `testing`, `conventions`, `releases`, `ci` | Detallada; barrera alta para externos (exige mutantes y controles negativos) |
| `docs/adr` | 18 | Decisiones de arquitectura con índice | — |
| `docs/roadmap` | 5 | `current-status`, `known-issues`, `pending-features`, `technical-debt` (1.444 líneas, 71 TD), índice | **Obsoleto** (ver DOC-01, DOC-03) |
| `docs/testing` | 11 | Estrategia y matrices de pruebas | — |
| `docs/overview` | 5 | Proyecto, arquitectura, tecnologías, glosario | — |
| `docs/audits` | 12 | Auditorías anteriores y cierres | Histórico |
| `docs/history` | 93 | Diseños, entregas, planes, programas, rondas, estados | Histórico aislado, bien separado |
| `docs/balance`, `docs/aceptacion`, `docs/recuperacion.md` | 2 + 1 + 1 | Balance, aceptación generada, recuperación | Duplicados menores |

Organización: correcta. Duplicados menores: `docs/history/status/ESTADO_ACTUAL.md` frente a `current-status*`, `docs/balance/informe-v1.md` frente a `v1.md`, `aceptacion/ultimo-informe.md` generado. `docs/README.md` reconoce la existencia de «rutas `docs/…` inexistentes citadas en comentarios de código y compose» (por ejemplo `docs/despliegue.md`).

Enlaces: el informe 07 declaró 0 rotos de 2.311 enlaces relativos con un script propio **no conservado**; REVISION-TECNICA lo marca `NO_VERIFICABLE` (no bloquea). Los anclajes `#…` y los enlaces externos no se comprobaron. Se propone un comprobador de enlaces en CI (FASE 2, verificación 4).

Idioma: 100 % español (README, guías, OpenAPI, errores, SDK README). Ver DOC-09.

## 3. Exactitud frente a main

| Afirmación documental | Realidad en 8f380eb | Evidencia | Hallazgo |
|---|---|---|---|
| README: «Estado actual (2026-10-18)… no es funcional de extremo a extremo»; tabla con TD-001/002/003/009/010/029 bloqueados | El golden path funciona en navegador real según `current-status` y el run `functional-e2e` de 8f380eb; la cabecera menciona un cierre funcional «sin fusionar» que ya está fusionado | `README.md:8-16,41-52` (V-02, `CODE_VERIFIED`); `docs/roadmap/current-status.md:8-16` | DOC-01 |
| README: «un despliegue Docker Compose de 12 servicios» | 13 con el perfil `streaming` (0.5.0) | `README.md`; compose | DOC-01 / OPS-11 |
| `docs/README.md` y `docs/roadmap/*`: `MAIN_SHA e3bf2fa` (2026-11-02, motor 0.4.0, migraciones 001-016, OpenAPI 0.12.0) | main = 8f380eb: motor 0.5.0, migraciones hasta 022, OpenAPI 0.25.0; `git rev-list --count e3bf2fa..8f380eb` = 586 (consolidación: 586) | `docs/README.md:7` | DOC-01, DOC-03 |
| `known-issues.md`: un torneo con una batalla fallida no termina (TD-015) | Resuelto en main (#299) | `apps/tournament-worker/src/results.ts:73,266-271,367-369` | DOC-03 |
| TD-066: clave de emisión en argv de FFmpeg, ABIERTA | La clave ya no va en argv (pipe) | `apps/streamer/src/ffmpeg.ts:10-13` (REVISION-TECNICA `CONFIRMADO`) | DOC-03 |
| Inscripción de equipos en torneos y cancelar torneo no aparecen como completadas | #290 y #289 mergeados | `apps/api/src/routes/tournaments.ts:45-70` | DOC-03 |
| `installation.md`: «11 healthy + backup», «12 servicios»; proxy «opcional… hoy apagado en producción» | 13 servicios; producción del operador tiene el proxy | `installation.md:44-46,120,218` | OPS-11, OPS-13 |
| `infrastructure/.env.example`: remite a `docs/despliegue.md`, `TAG=latest`, valores de otra instalación | `docs/despliegue.md` no existe; los docs están en `docs/operations/*` (V-04) | `.env.example:5,19,57` | OPS-04 |

<a id="doc-01"></a>
### DOC-01 · README raíz y portada de docs declaran un estado falso
- **P1 · Grupo A** · DEFECTO_CONFIRMADO · `CODE_VERIFIED` (V-02; REVISION-TECNICA CONFIRMADO) · informe 07 (consolida OPS-11)
- Impacto: la primera pantalla del repositorio público afirma que el producto no sirve; toda auditoría posterior parte de cifras falsas.
- Evidencia: `README.md:8-16,41-52,118`; `docs/README.md:7`; `docs/roadmap/current-status.md:8-16`.
- Solución: reescribir cabecera y tabla de estado desde `current-status` actualizado, con «verificado a fecha X»; sustituir el `MAIN_SHA` fijo por una referencia automatizable (una comprobación de CI que compare el SHA citado con un ancestro de main). Esfuerzo S (README) + M (roadmap), incertidumbre baja.

<a id="doc-03"></a>
### DOC-03 · Roadmap con afirmaciones obsoletas
- **P2 · Grupo B** (REVISION-PRODUCTO: en A sólo README, `current-status` y `known-issues`; el resto B) · DEFECTO_CONFIRMADO · `CODE_VERIFIED` (REVISION-TECNICA confirmó el muestreo de TD-066 y TD-015)
- Detalle en la tabla anterior. Solución: re-auditoría documental sobre 8f380eb con el método de `PENDING-AUDIT`. Esfuerzo L (≈1 semana por el volumen de `technical-debt.md`: 1.444 líneas), incertidumbre media.

## 4. Licencia

<a id="doc-02"></a>
### DOC-02 · Repo público sin LICENSE
- **P1 · Grupo A** · FALTA · `CODE_VERIFIED` (`git ls-tree 8f380eb` sin LICENSE; `gh api` devuelve `license: null` con `visibility: public`) · informes 07 y 04, UX-09 consolidados (director)
- Impacto: derechos reservados por defecto; terceros no pueden usar, distribuir ni contribuir con garantías; los SDK no son consumibles por un programador de bots; ningún `package.json` ni `pyproject` declara `license`. No hay inventario de licencias de dependencias (Rapier, Phaser…) ni NOTICE.
- Decisión del propietario antes de anunciar nada: permisiva (MIT o Apache-2.0, esta con cláusula de patentes) para adopción; AGPL-3.0 si se quiere proteger el servicio alojado. Revisar el `.docx` y el zip de la raíz antes de licenciar por si contienen material no propio (V-01 no halló secretos, no se valoró la autoría).
- Solución: añadir `LICENSE`, campo `license` en cada paquete, `NOTICE` o inventario de terceros; CLA o DCO si se aceptan PR externos. Esfuerzo S (decisión) + S, incertidumbre media (legal). DoD D2.

## 5. Changelog, versionado y comunidad

<a id="doc-05"></a>
### DOC-05 · Sin versionado ni releases
- **P2 · Grupo B en el informe; A en forma mínima (REVISION-PRODUCTO, junto con OPS-14)** · FALTA · `CODE_VERIFIED`: 0 tags (consolidación), sin GitHub Releases, sin CHANGELOG; `.changeset/config.json` presente sin changesets y sin que se verificara el script. `docs/development/releases.md` define que «una release es un commit de main» (ADR-017) con imágenes GHCR `sha-<commit>`; el paquete raíz no declara versión.
- Solución: tag `v0.x.y` con notas generadas (los PR están bien titulados), CHANGELOG mínimo, digests y bundle del proxy como assets; retirar `.changeset` si no se usa. Esfuerzo S-M. Consolidado con [OPS-14](07-INSTALLATION-OPERATIONS.md#ops-14).

<a id="doc-06"></a>
### DOC-06 · Ficheros de comunidad
- **P2 · Grupo B** (REVISION-PRODUCTO: B en A-min, A en la opción pública) · FALTA · `CODE_VERIFIED`: `.github/` sólo contiene `CODEOWNERS` y workflows (consolidación).
- Faltan: `SECURITY.md` (el procedimiento está en `docs/development/contributing.md#informar-de-un-problema-de-seguridad`, pero GitHub no lo detecta), plantillas de issue y de PR, `CONTRIBUTING.md` en la raíz, `CODE_OF_CONDUCT.md`. El contributing existente exige «mutantes y controles negativos» en cada PR: barrera alta para externos sin versión «ligera».
- Solución: ficheros de una pantalla que enlacen a los docs. Esfuerzo S.

## 6. Quick start, referencia de API, capturas

<a id="doc-11"></a>
### DOC-11 · Sin quick start de 5 minutos
- **P2 · Grupo B (A mínimo para la opción pública)** · FALTA · `CODE_VERIFIED`. Existen `user/getting-started.md` (8 pasos web), `user/bots/probar.md` y el simulador local (`sdks/javascript/src/local-simulator.ts`), pero no una guía «escribe un bot y ejecútalo contra el simulador sin cuenta» enlazada desde el README. Solución: `docs/user/bots/quickstart.md` y enlace en README. Esfuerzo S. Validación FASE 2: `npm ci` y el simulador con un bot de ejemplo en laboratorio.

<a id="doc-12"></a>
### DOC-12 · Referencia de API sólo a mano
- **P3 · Grupo C** (B en la opción pública) · FALTA. `docs/technical/api.md` (279 líneas) y `apps/api/openapi.yaml` (106 operaciones, v0.25.0) sin referencia renderizada. Los tipos del SDK JS se generan del contrato (`generate-types.mjs`). Solución: publicar referencia estática en CI. Esfuerzo S-M.

<a id="doc-10"></a>
### DOC-10 · Sin capturas ni demo
- **P3 · Grupo A para «presentar» (DECISIONES-DIRECTOR)** · FALTA · `CODE_VERIFIED`: `git ls-tree` sin ningún `.png`, `.gif`, `.jpg`, `.svg` ni `.mp4` fuera de `node_modules` (consolidación). La guía es sólo texto. Solución: 2-4 capturas o un GIF (el golden Playwright ya existente puede generarlos) y un vídeo corto. Esfuerzo S. DoD D3. Ver también [UX-12](06-UX-PRODUCT-REVIEW.md#ux-12).

<a id="doc-09"></a>
### DOC-09 · Idioma
- **P3 · Grupo C (D para el inglés completo, REVISION-PRODUCTO)** · DEUDA. Todo en español, incluidos comentarios de OpenAPI y SDK README. No bloquea para una comunidad hispanohablante; declararlo en las limitaciones del README (DoD D16). Mínimo posterior: README, quick start y guía de bots en inglés (M).

## 7. Ficheros sueltos en la raíz

<a id="doc-07"></a>
### DOC-07 · Ficheros sin propósito documentado
- **P3 · Grupo A (higiene de escaparate, S; REVISION-PRODUCTO §5.2)** · DEUDA · `CODE_VERIFIED`; V-01 del director.

| Fichero | Qué es | Verificación | Acción propuesta |
|---|---|---|---|
| `s9-ai-arena-part2.zip` (26 KB) | Scaffold v1 de 55 entradas (arena-server, arena-viewer, dos bots de ejemplo); duplica y contradice el árbol actual | V-01: sin secretos ni credenciales (sólo direcciones de enlace genéricas) | Eliminar de la raíz (queda en el historial de git) |
| `Dosier_tecnico_S9_AI_Arena_motor_2D_modular.docx` (58 KB) | Dosier de diseño original; el código lo cita («dosier 22.x/capítulo 28») en `CODEOWNERS`, `ci.yml` y `acceptance/criteria.mjs` sin enlace | V-01: sin IPs ni credenciales | Convertir a Markdown o moverlo a `docs/history/` con nota; revisar autoría antes de licenciar |
| `docker-compose.demo.yml` | Prototipo v1 «retirado y no debe usarse» (el propio README) | informe 04 | Eliminar o mover a `docs/history/` |
| `.env.example` (raíz) | Variables del prototipo v1 (`ARENA_PORT`, `TICK_RATE`, `VIEWER_PORT`) | V-04 | Eliminar o reemplazar por un puntero a `infrastructure/.env.example` |
| `pnpm-workspace.yaml` | Coexiste con npm workspaces (el setup indica npm) | informe 07 | Eliminar si no se usa |
| `.changeset/` | Sólo `config.json`, sin changesets | informe 07 | Usarlo (DOC-05) o eliminarlo |

Conclusión V-01: limpieza P3, **no incidente de seguridad**. Se recomienda no purgar el historial (grupo E).

## 8. Ramas y PR documentales

Ramas (consolidación, `git rev-list --left-right --count origin/main...origin/<rama>`):

| Rama | Por detrás de main / por delante | Decisión |
|---|---|---|
| `docs/usuario` | 584 / 0 | Integrada; borrable |
| `docs/integracion` | 579 / 0 | Integrada; borrable |
| `docs/refresh-2026-11-12` (PR #277) | 384 / 17 | **No mergeable**: ver abajo |

<a id="doc-08"></a>
### DOC-08 · PR documentales: contenido y destino
- **P3 · Grupo B** (informe 07; DECISIONES-DIRECTOR no lo arbitra) · RIESGO · `CODE_VERIFIED` (`git diff --stat` por rama y `git ls-tree 8f380eb`) · informe 07.

**PR #277 (`docs/refresh-2026-11-12`, no draft, 17 commits, 384 por detrás).** Su `MAIN_SHA` es el de una fecha anterior y declara OLA 2 «no integrada» y MS-1 `DESIGN_ONLY`; OLA 2 ya está en main (#294). No mergear como conjunto. **Rescatar por cherry-pick selectivo**: `operations/streaming.md` (YouTube real y límites v1), `user/administration.md` (+39 líneas, ajustes de acceso público runtime, #269/#274), `user/equipment.md`, `user/visibility.md`, el cierre de TD-066 y `history/status/completadas-2026-11.md`. **No mergear** los cuatro ficheros de `roadmap/*` (se rehacen en DOC-03). Después, cerrar la PR.

### Tabla de PR de documentación y afines abiertos (consolidación: `gh pr list`, 51 abiertos el 2026-11-19)

| PR | Título (resumido) | Estado | Acción propuesta | Motivo |
|---|---|---|---|---|
| #286 | docs: próxima ola Web/Streaming/UX | draft | **Mergear tras revisar fechas** | Único plan vigente de la siguiente ola (`roadmap/NEXT_WEB_STREAMING_UX_WAVE.md`, 586 líneas, ausente en main) |
| #277 | docs: refrescar roadmap y manuales a 2026-11-12 | no draft | **Rescatar parcialmente y cerrar** | Ver arriba |
| #275 | [MS-1] Streaming architecture v2 | draft | Mantener como `DESIGN_ONLY` o mergear como documento | Diseño sin código en main (`git grep` de `StreamSession`/`BroadcastQueue` vacío); grupo D (DECISIONES-DIRECTOR) |
| #266 | docs: roadmap de hardening del motor y Module Catalog v2 | draft | **Reconciliar con lo mergeado** y luego integrar o archivar en `history` | Parte de OLA 2 ya está hecha (#285, #280, #281) |
| #258 | docs: actualizar documentación canónica a RC8 | draft | **Cerrar** | Superada por completo |
| #253 | docs(visual-bots): inventario y contrato visual | draft, «no mergear» | **Decisión de producto**: integrar en `history/diseños` o cerrar conservando la rama | Único activo de «mejoras visuales» (4.477 líneas y un test de contrato de 1.874) |
| #174 | auditoría de desarrollador externo 2026-10-27 | no draft | **Rescatar README de SDK/runtimes si siguen desfasados, y cerrar** | Muchos README ya reescritos; contrastar con main |
| #173 | docs(rc4): informe RC4 | no draft | Mover el informe a `docs/history/entregas` o cerrar | Histórico |
| #168 | [RC3] estado de la RC3 y deuda TD-050…TD-062 | draft | **Cerrar** tras comparar | `upgrades.md` de main ya es más reciente |
| #169 | fix(td-064): `init-secrets.sh` no sigue enlaces | draft | **Rescatar (rebase) o registrar TD-064 y cerrar** | La corrección y su registro se perdieron (DOC-04) |
| #153 | [DO NOT MERGE] PRC DEV-CI TD-045 | draft | **Cerrar** | Ya cubierto por `functional-e2e` |
| #136 | Carril replay access governance | no draft | **Cerrar** | Superado por #158 |
| #113, #106, #105, #101, #100, #99, #98, #97, #96 | Drafts históricos R11-R17 (auditorías y ADR) | draft | **Cerrar** con referencia a su integración | Sus contenidos (ADR-R14, auditoría R16…) ya están en `docs/adr` y `audits/anteriores` según el informe 07 |
| #295 | ops: reset competitivo pre-0.5 | draft | Mantener hasta decisión de lanzamiento | Con tests; no es documentación |

<a id="doc-13"></a>
### DOC-13 · PR «NO MERGEAR» abiertos
- **P3 · Grupo A para higiene de escaparate (DECISIONES-DIRECTOR; REVISION-PRODUCTO)**; el informe 07 lo clasificaba E · DEUDA · `CODE_VERIFIED`.
- Recuento corregido: el informe 07 dijo «35 de 52»; REVISION-TECNICA contó 51 abiertos con 29 «NO MERGEAR» (31 con REVIEW o NO MERGE) y la consolidación del 2026-11-19 reproduce **51 abiertos y 29 con «NO MERGEAR» en el título**.
- Descripción: ramas `review/*` y `eq6*` (#182-#248) con pruebas de rotura de PR ya mergeados (comprobados 6: #201, #220, #227, #229, #242, #244). Ruido, riesgo de merge accidental y PR vivos tapados. **Hipótesis no verificada**: que todos los tests de rotura hayan entrado en main (el flujo del proyecto lo exige).
- Acción propuesta (la ejecuta el operador): (1) un script que verifique, por PR, que cada test añadido existe en main; (2) abrir un PR único «tests de rotura» con los que falten; (3) cerrar los demás con el comentario «integrado en #NNN»; (4) opcional: conservar las ramas bajo `archive/review-…`. DoD D14: `gh pr list --search "NO MERGEAR in:title" --state open` vacío.
- Esfuerzo S, incertidumbre baja.

<a id="doc-04"></a>
### DOC-04 · TD-064 no registrada en main
- P3 · Grupo C · DEUDA. PR #169 corrige `init-secrets.sh` (enlaces simbólicos y directorios ajenos) con 275 líneas de test; `grep TD-064` en `technical-debt.md` de main no encuentra nada. Rescatar la rama o registrar la TD y cerrar. S.

## 9. Mapa de acciones por grupo

| Grupo | Acciones documentales |
|---|---|
| A | LICENSE (DOC-02), README real (DOC-01/OPS-11), `.env.example` y enlaces muertos (OPS-04), requisitos de hardware (OPS-05), capturas (DOC-10), ficheros sueltos (DOC-07), cerrar PR «NO MERGEAR» (DOC-13), tag y notas de release (DOC-05/OPS-14), sección «Limitaciones de esta versión» (DoD D16) |
| B | `current-status` y `known-issues` al día y re-auditoría del roadmap (DOC-03), SECURITY.md y plantillas (DOC-06), quick start (DOC-11), rescate de #277 (DOC-08), `engine.md`, `streaming.md` desfasados |
| C | Referencia de API renderizada (DOC-12), TD-064 (DOC-04), versión en inglés (DOC-09) |
| D | Inglés completo, Streaming V2 y diseños visuales como diseño |
| E | Purga del historial de git |

## 10. Verificaciones para FASE 2

| # | Qué | Prueba | Resultado que confirma |
|---|---|---|---|
| 1 | Quick start local sin cuenta | En laboratorio: `npm ci`, simulador local con un bot de ejemplo, siguiendo sólo `docs/development/setup.md` | Setup correcto (DOC-11) |
| 2 | Los comandos de `installation.md` instalan un stack de cero | Escenarios S01 y S12 de [07](07-INSTALLATION-OPERATIONS.md#12-escenarios-de-fase-2-laboratorio-aislado) | 0 pasos no documentados |
| 3 | Estado real de producción frente a lo «reportado por el operador» | `/version` en producción, sólo lectura | Versión desplegada coincide |
| 4 | Enlaces con ancla y externos | Comprobador en CI | 0 rotos; sustituye al script no conservado |
| 5 | Nightly | `gh run view 44519497401 --log-failed`; 7 ejecuciones verdes tras el arreglo | QA-01 / DoD D13 |
| 6 | Los tests de los PR «NO MERGEAR» existen en main | Diff de nombres de test por PR | Hipótesis de DOC-13 |

Todo queda `BLOCKED (FASE 2)` hasta ejecutarse.

## 11. Respuestas cortas

- **Organización y duplicados:** correcta; duplicados menores listados en §2.
- **Enlaces rotos:** 0 de 2.311 relativos según un script no conservado (`NO_VERIFICABLE`); anclajes y externos sin comprobar.
- **Ramas documentales:** `docs/usuario` y `docs/integracion` integradas y borrables; #277 parcial; #286 mergeable tras revisión; #266 reconciliar; #258 cerrar; #253 decisión de producto; #174, #173 y #168 cerrar tras rescatar lo útil.
- **LICENSE:** sin licencia el código no es utilizable ni contribuible; decidir y añadir antes de promocionar.
- **PR «NO MERGEAR»:** 29 (de 51 abiertos), acción en DOC-13.
- **Colaboradores nuevos:** buen mapa (`setup`, `workflow`, `testing`, `conventions`); faltan CONTRIBUTING en raíz, plantillas, «good first issue» y quick start.

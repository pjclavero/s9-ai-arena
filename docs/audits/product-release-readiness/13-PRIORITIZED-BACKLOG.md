# 13 · Backlog priorizado de la próxima versión presentable

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Propósito: convertir los hallazgos de la auditoría en **tareas implementables** (T-NN), cada una en un único grupo A/B/C/D/E, con dependencias, esfuerzo, pruebas exigidas y evidencia de cierre, para que un equipo pueda repartirlas por carriles. Documento maestro: [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md). Análisis de brecha: [11-RELEASE-GAP-ANALYSIS.md](11-RELEASE-GAP-ANALYSIS.md) · Definición de terminado: [12-RELEASE-DEFINITION-OF-DONE.md](12-RELEASE-DEFINITION-OF-DONE.md) · Plan de entrega: [14-RELEASE-DELIVERY-PLAN.md](14-RELEASE-DELIVERY-PLAN.md).

## 0. Cómo leer este backlog

- **Alcance de referencia: opción A+** (DECISIONES-DIRECTOR): autoalojable v0.x, en español, registro por invitación por defecto, streaming «experimental», un solo host Debian 12.
- **Grupo** (eje de lanzamiento, distinto de la severidad): **A** bloquea la versión presentable A+ · **B** necesaria para la versión objetivo siguiente (pública completa) · **C** poslanzamiento · **D** futuro · **E** descartar (la tarea consiste en registrar y ejecutar el descarte). Una tarea pertenece a un solo grupo; si un hallazgo se parte (p. ej. cuentas: reset asistido en A, email en B) cada parte es una tarea distinta.
- **Severidad final** de cada hallazgo: la de REVISION-TECNICA cuando la ajusta («P1→P2 (REVISION-TECNICA)»); si no, la del autor; los arbitrajes se marcan «(DECISIONES-DIRECTOR)». La **prioridad de la tarea** es la severidad más alta de los hallazgos que cierra.
- **Esfuerzo**: bandas de los informes (S ≤ ½ día · M 1-3 días · L 1-2 semanas · XL > 2 semanas) con su incertidumbre. Para sumar se usa S = 0,5 d, M = 1-3 d, L = 5-10 d, XL ≥ 10 d sin cota (días-persona). **Las sumas son sumas de estimaciones, no mediciones.**
- **Marcas**: ⚑ **DECISIÓN DEL OPERADOR** (no puede empezar o cerrarse sin una decisión del propietario) · 🔬 **FASE 2** (exige laboratorio aislado o lectura de producción; hoy `BLOCKED (FASE 2)` mientras la migración de producción siga abierta).
- **Etapa**: F0 decisiones + FASE 2 · F1 bloqueantes en paralelo · F2 integración y condicionales · F3 congelación, RC y GO · F4 después del GO (definidas en [14](14-RELEASE-DELIVERY-PLAN.md)).
- **Carril** (propiedad de ficheros disjunta, ver [14 §3](14-RELEASE-DELIVERY-PLAN.md#3-carriles)): L1 Instalación/operación · L2 API y CLI · L3 Web y E2E · L4 CI y release · L5 Seguridad de plataforma · L6 Documentación y escaparate · L7 Laboratorio/QA · OP Operador (sin ficheros).
- Detalle de cada hallazgo: informes por área enlazados desde [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md) — instalación en [07](07-INSTALLATION-OPERATIONS.md), seguridad en [05](05-SECURITY-REVIEW.md), UX en [06](06-UX-PRODUCT-REVIEW.md), pruebas en [08](08-TEST-QUALITY.md), documentación en [10](10-DOCUMENTATION-AUDIT.md). Los hallazgos ARQ-, BE- y STR- se citan por ID (informe de área en el índice del documento maestro).

## 1. Resumen

| Grupo | Tareas | Suma de estimaciones (días-persona) | Notas |
|---|---|---|---|
| A (A+) implementación | T-01 … T-22 | 19,5 – 52,5 | Incluye tres ensayos de laboratorio (T-20, T-21, T-22). |
| A (A+) verificación FASE 2 | T-23 … T-26 | 3,5 – 9,5 | Más la remediación que resulte, hoy UNKNOWN (REV-01, TD-031, REV-02). |
| **Total A+** | 26 tareas | **23 – 62** (≈ 4,6 – 12,4 semanas-persona) | No incluye la espera de calendario de las N ejecuciones nocturnas ni la latencia de las decisiones del operador. |
| B | T-30 … T-51 | 28,5 – 79,5 | Versión objetivo siguiente. |
| C | T-60 … T-75 | ver tabla §4 (incluye L) | Poslanzamiento. |
| D | T-80 … T-84 | incluye XL: sin cota superior | Sólo diseño en este ciclo. |
| E | T-90, T-91 | ≤ 1 | Descartes registrados. |

Tareas con ⚑ DECISIÓN DEL OPERADOR: T-01 (licencia), T-02 (cierre de PR de revisión), T-10 (publicación de imágenes y release), T-12 (política de registro), T-21 (persona ajena para el ensayo), T-30 (canal de correo), T-45 (purga de replays / PR #295), T-47 (PR documentales), T-49 (hosting de instancia de demo), T-60 (alcance de streaming), T-71 (publicación de SDK), T-75 (PR #169), T-80 (PR #275), T-81 (PR #253), T-90 (no purgar historial).
Tareas 🔬 FASE 2: T-16, T-18, T-20, T-21, T-22, T-23, T-24, T-25, T-26 (y la medición condicional de T-38 y T-44).

---

## 2. Grupo A — bloquea la versión presentable A+

<a id="t-01"></a>
### T-01 · Licencia del repositorio y de los paquetes ⚑
- **Objetivo:** que un tercero pueda usar, modificar y contribuir legalmente; los SDK pasan a ser consumibles.
- **Cierra:** DOC-02 (P1 · A · CODE_VERIFIED: `git ls-tree 8f380eb` sin LICENSE; `gh api` → `license: null`, repo público; informe DOC) · parte de licencia de UX-09 (P2, CONF/M REVISION-TECNICA) · hallazgo inicial del director (00-PRERREQUISITOS).
- **Prioridad:** P1 · **Especialidad:** propietario + documentación · **Carril:** OP (decisión) → L6 (ficheros) · **Complejidad:** baja técnica, media legal.
- **Dependencias:** decisión del operador sobre la licencia (REVISION-PRODUCTO §8 enumera AGPL-3.0 si se quiere proteger el servicio alojado; Apache-2.0/MIT si se busca adopción). Antes de licenciar, decidir el destino del zip/docx de la raíz (T-03), por si contienen material no propio.
- **Esfuerzo:** S · incertidumbre media (legal) · **Riesgo:** licencias de dependencias (Rapier, Phaser…) incompatibles con la elegida; se mitiga con inventario de terceros en `NOTICE`.
- **Pruebas exigidas:** `gh api repos/<repo>` → `license` no nulo; comprobación de que todo `package.json`/`pyproject.toml` publicable tiene `license` (lista explícita de los privados exentos).
- **Evidencia de cierre:** commit con `LICENSE`, `NOTICE` y campos `license`; salida de la comprobación. Criterio [D2](12-RELEASE-DEFINITION-OF-DONE.md#d2).
- **Paralelizable:** sí, con todo (el commit de campos `license` toca muchos `package.json`: hacerlo en un único commit al inicio de F1 para no chocar con otros carriles). **Etapa:** F0 → F1.

<a id="t-02"></a>
### T-02 · Cerrar los PR de revisión «NO MERGEAR» ⚑
- **Objetivo:** que el listado de PR del repo público muestre sólo trabajo vivo y no haya riesgo de merge accidental.
- **Cierra:** DOC-13 (P3 · A (DECISIONES-DIRECTOR; el autor proponía E) · CONF/M REVISION-TECNICA: hoy 51 PR abiertos, 29 con «NO MERGEAR» (31 con REVIEW/NO MERGE), no 35 de 52).
- **Prioridad:** P3 · **Especialidad:** operador · **Carril:** OP · **Complejidad:** baja.
- **Dependencias:** decisión del operador; antes de cerrar, comprobar que los tests de cada PR de revisión están en main (HIPÓTESIS de DOC-13 no verificada: diff de nombres de tests por PR).
- **Esfuerzo:** S · incertidumbre baja · **Riesgo:** perder un test de no vacuidad que sólo vive en la rama: se mitiga con el diff previo y conservando las ramas (cerrar ≠ borrar).
- **Pruebas exigidas:** `gh pr list --search "NO MERGEAR in:title" --state open` vacío.
- **Evidencia de cierre:** salida del comando y tabla PR → test equivalente en main. Criterio [D14](12-RELEASE-DEFINITION-OF-DONE.md#d14).
- **Paralelizable:** sí, con todo. **Etapa:** F0.

<a id="t-03"></a>
### T-03 · Escaparate limpio: ficheros sueltos de la raíz y topología en ficheros rastreados
- **Objetivo:** que la raíz y los ficheros rastreados no muestren artefactos de génesis ni valores de la instalación del operador, con un gate que lo impida en adelante.
- **Cierra:** DOC-07 / ARQ-08 (P3 · A por higiene de escaparate (REVISION-PRODUCTO §5.2, criterio D14); V-01 lo clasificó «limpieza P3, grupo C» como asunto de seguridad: sin secretos) · SEC-13 / TD-008 limpieza de ficheros (TD-008 P0→P2 (REVISION-TECNICA); grupo A sólo la limpieza (DECISIONES-DIRECTOR); la purga de historial va a [T-90](#t-90)).
- **Evidencia:** `git ls-tree 8f380eb` raíz (`s9-ai-arena-part2.zip`, `Dosier_tecnico_….docx`, `docker-compose.demo.yml` y `.env.example` de v1); restos de topología en la cabecera de `infrastructure/gateway/nginx-behind-proxy.conf`, comentarios de `infrastructure/scripts/smoke.sh`, una config de Playwright visual y tests (REVISION-TECNICA D-06). CODE_VERIFIED.
- **Prioridad:** P2 · **Especialidad:** documentación + CI · **Carril:** L6 (raíz, docs y script del gate); cada carril limpia sus propios ficheros según la lista de L6; `infrastructure/.env.example` lo limpia [T-06](#t-06).
- **Dependencias:** T-01 (decidir si el docx/zip se conserva en `docs/history` o se elimina). El gate lo cablea L4 en CI.
- **Esfuerzo:** S-M · incertidumbre media (SEC-13 estima M incluyendo el gate) · **Riesgo:** gate por texto con falsos negativos; debe parsear direcciones privadas y nombres de host, no contar apariciones.
- **Pruebas exigidas:** gate de CI que falla con un mutante (añadir una dirección privada no de ejemplo a un fichero rastreado) y pasa en el árbol limpio; `git ls-tree` sin los ficheros retirados.
- **Evidencia de cierre:** run de CI con el gate en verde + run del mutante en rojo. Criterio [D14](12-RELEASE-DEFINITION-OF-DONE.md#d14).
- **Paralelizable:** sí (la lista de ficheros por carril evita colisiones). **Etapa:** F1.

<a id="t-04"></a>
### T-04 · README, estado actual y limitaciones declaradas
- **Objetivo:** que la primera pantalla del repo describa el estado real, enlace instalación, guía de bots y licencia, y diga lo que no se promete.
- **Cierra:** DOC-01 (P1 · A · CODE_VERIFIED, V-02: `README.md:8-16` «no es funcional de extremo a extremo (2026-10-18)», «12 servicios»; docs anclados en `e3bf2fa`, 586 commits atrás) · OPS-11 (P2 · A, duplicado de DOC-01) · DOC-03 sólo `docs/roadmap/current-status.md` y `known-issues.md` (P2; el resto en [T-46](#t-46)) · sección «Limitaciones de esta versión» (REVISION-PRODUCTO D16).
- **Prioridad:** P1 · **Especialidad:** documentación · **Carril:** L6 · **Complejidad:** baja.
- **Dependencias:** T-01 (enlace a licencia), T-05 (capturas), decisiones de T-12 (modo de registro) y de alcance de streaming (D-OP-3) para el texto de limitaciones; versión de T-10.
- **Esfuerzo:** S + S · incertidumbre baja · **Riesgo:** volver a desfasarse: incluir «revisado a fecha X sobre SHA Y» y un check que compare el SHA citado con la historia de main (propuesta de DOC-01).
- **Pruebas exigidas:** revisión por una persona que no sea autora; comprobación de enlaces (script en CI) e imágenes presentes (`git ls-tree`).
- **Evidencia de cierre:** criterio [D3](12-RELEASE-DEFINITION-OF-DONE.md#d3) y [D16](12-RELEASE-DEFINITION-OF-DONE.md#d16).
- **Paralelizable:** borrador en paralelo; versión final tras T-05/T-10. **Etapa:** F1 (borrador) → F2 (final).

<a id="t-05"></a>
### T-05 · Capturas o GIF del producto
- **Objetivo:** que quien llega al repo vea qué es un «juego de bots» sin instalar nada.
- **Cierra:** DOC-10 (P3 · A (DECISIONES-DIRECTOR) · CODE_VERIFIED: sin `.png/.gif` en `git ls-tree`).
- **Prioridad:** P3 · **Especialidad:** documentación + E2E · **Carril:** L6 (con apoyo de L3 para capturar desde el golden path de Playwright).
- **Dependencias:** T-13 (que haya bots de práctica para una escena real); entorno de laboratorio, no producción.
- **Esfuerzo:** S · incertidumbre baja · **Riesgo:** capturas con datos de la instalación del operador (nombres de cuenta, dominio): capturar sólo en laboratorio con datos de prueba.
- **Pruebas exigidas:** revisión de privacidad de cada imagen.
- **Evidencia de cierre:** 2-4 capturas o un GIF en el árbol, enlazados desde el README. Criterio [D3](12-RELEASE-DEFINITION-OF-DONE.md#d3).
- **Paralelizable:** sí, tras T-13. **Etapa:** F2.

<a id="t-06"></a>
### T-06 · Plantilla `infrastructure/.env.example` correcta para terceros
- **Objetivo:** que la plantilla lleve a una versión fija, a documentos existentes y a valores de ejemplo, no de la instalación del operador.
- **Cierra:** OPS-04 parte plantilla (P1 · A · CONF REVISION-TECNICA; V-04: `infrastructure/.env.example:57` `TAG=latest`, `:79` `BACKUP_TAG=latest`, `:5,19` remiten a `docs/despliegue.md` inexistente, `:10-14` dominio del operador como valor por defecto, `:94` `DOCKER_PROXY_URL` comentado; `ci.yml:390-392` sólo publica `sha-<commit>` y `v<version>`) · parte de TD-008 en este fichero.
- **Prioridad:** P1 · **Especialidad:** DevOps · **Carril:** L1.
- **Dependencias:** T-10 (convención de etiqueta de versión que la plantilla fija). Comprobación R5 (¿existe un `:latest` antiguo en GHCR?) en [T-23](#t-23).
- **Esfuerzo:** S · incertidumbre baja · **Riesgo:** si existe un `:latest` antiguo, cualquier instalación previa con la plantilla vieja trae una imagen desfasada en silencio: documentarlo en notas de release.
- **Pruebas exigidas:** test que parsea la plantilla: ninguna variable de imagen con `latest`; todo enlace a `docs/` existe; `S9_DOMAIN` con valor de documentación.
- **Evidencia de cierre:** test en CI + mutante (volver a `latest`) en rojo.
- **Paralelizable:** sí. **Etapa:** F1.

<a id="t-07"></a>
### T-07 · Humo real y «doctor-lite» que demuestre «puede jugar»; aviso de backup no configurado
- **Objetivo:** que una instalación diga con rc ≠ 0 si no puede ejecutar una batalla o si no tiene destino de backup.
- **Cierra:** OPS-04 parte `smoke.sh` / TD-020 (P2 (REVISION-TECNICA) · CODE_VERIFIED: `smoke.sh` espera 200 en `/replays/healthz` y el gateway devuelve 404 en `/replays/*` (`infrastructure/gateway/nginx.conf:124-131`); `/api/healthz` cae en la SPA → el humo no puede dar verde) · doctor-lite (REVISION-PRODUCTO §4) · parte mínima de OPS-12 (P2) · parte A de OPS-06 (P1 · aviso si `RESTIC_REPOSITORY` vacío; resto en [T-34](#t-34)).
- **Prioridad:** P1 · **Especialidad:** DevOps · **Carril:** L1 (`infrastructure/scripts/`).
- **Dependencias:** T-08 (la cadena de ejecución tiene que existir para que la batalla de humo termine); T-13 (bots de práctica como participantes de la batalla de humo).
- **Esfuerzo:** S-M + S · incertidumbre media · **Riesgo:** batalla de humo lenta en hosts justos; fijar un tiempo máximo derivado de la medición de T-22, no inventado.
- **Pruebas exigidas:** en laboratorio: con proxy desactivado → rc ≠ 0 y mensaje; con `RESTIC_REPOSITORY` vacío → aviso explícito; con todo correcto → batalla `finished` y rc 0.
- **Evidencia de cierre:** acta de laboratorio con los tres casos y su rc. Criterios [D4](12-RELEASE-DEFINITION-OF-DONE.md#d4) y [D12](12-RELEASE-DEFINITION-OF-DONE.md#d12).
- **Paralelizable:** desarrollo sí; validación tras T-08. **Etapa:** F1 → F2.

<a id="t-08"></a>
### T-08 · `install-host.sh`: runtimes → red → firewall → proxy (desde la release) → `DOCKER_PROXY_URL`, con preflight
- **Objetivo:** que seguir la guía deje un stack que **ejecuta batallas**, no uno «verde» que deja las batallas en `scheduled`.
- **Cierra:** OPS-01 (P1 · A · CONF/M REVISION-TECNICA: `infrastructure/docker-compose.yml:308,368` `DOCKER_PROXY_URL:-` vacío; `:474,543` proxy inexistente por defecto; `docs/operations/installation.md:46` «Opcional… hoy apagado»; la guía sí describe proxy e imágenes de runtime (`:129-169`) pero como opcionales, sin el paso de `.env` ni firewall) · OPS-03 forma mínima (P1 · A por REVISION-PRODUCTO §4: el proxy se instala desde el asset de release con su sha256, no compilando como root con un sha de un run de CI que caduca; `install-docker-proxy.sh:225,309` valida Node ≥ 22.15) · TD-024 (P2→P1, paraguas).
- **Prioridad:** P1 · **Especialidad:** DevOps · **Carril:** L1.
- **Dependencias:** T-10 (asset del bundle + sha256 publicados); T-22 (umbrales mínimos del preflight). Queda por determinar si el host necesita Node aunque no compile: si sí, se declara requisito.
- **Esfuerzo:** M · incertidumbre baja-media · **Riesgo:** el script toca firewall del host: ejecutarlo sólo en laboratorio; en el host de producción el operador decide.
- **Pruebas exigidas:** escenario OPS S04 en laboratorio desde snapshot limpio; preflight que falla por debajo del mínimo; `network-probe` con la ruta por defecto bloqueada para los bots.
- **Evidencia de cierre:** acta S04 con rc de cada paso; criterio [D4](12-RELEASE-DEFINITION-OF-DONE.md#d4).
- **Paralelizable:** sí con L2-L6; secuencial con T-10. **Etapa:** F1 → F2.

<a id="t-09"></a>
### T-09 · Guía de instalación coherente: orden, requisitos, Debian 12, TLS, proxy obligatorio, primer admin
- **Objetivo:** que `installation.md` → `first-run.md` sea un camino único y ejecutable por un tercero.
- **Cierra:** OPS-01 parte documental (P1) · OPS-13 (P3 · A en A+ · CONF: `installation.md:172,189` `up` antes de `bootstrap`; `:120` «12 servicios»; `:218` «11 healthy + backup»; compose 0.5.0 tiene 13 con `streamer`) · OPS-05 (P1→P2 (REVISION-TECNICA) · A como tarea S: sin tabla de requisitos en `installation.md:35-46`) · OPS-09 forma mínima (P2: receta TLS con un proxy que emita certificados; perfil ACME en [T-72](#t-72)) · OPS-15 sólo la declaración «soportado: Debian 12» (P3) · paso `create-admin` (T-11) y modo de registro (T-12).
- **Prioridad:** P1 · **Especialidad:** documentación de operaciones · **Carril:** L1 (`docs/operations/installation.md`, `first-run.md`, `configuration.md`).
- **Dependencias:** T-08, T-11, T-12 (comandos reales); T-22 (cifras de la tabla de requisitos: `BLOCKED (FASE 2)` hasta medir S06).
- **Esfuerzo:** 4 × S · incertidumbre baja (media para las cifras) · **Riesgo:** publicar requisitos inventados: la tabla no se rellena sin la medición.
- **Pruebas exigidas:** la propia guía es el guion de [T-21](#t-21); enlaces comprobados por script.
- **Evidencia de cierre:** criterios [D4](12-RELEASE-DEFINITION-OF-DONE.md#d4) y [D15](12-RELEASE-DEFINITION-OF-DONE.md#d15).
- **Paralelizable:** redacción en paralelo; cierre tras T-08/T-22. **Etapa:** F1 → F2.

<a id="t-10"></a>
### T-10 · Release etiquetada con notas, digests de imágenes y bundle del proxy + sha256 ⚑
- **Objetivo:** que exista un identificador de versión estable que un tercero pueda instalar y verificar.
- **Cierra:** OPS-14 (P2 · A (REVISION-PRODUCTO §4)) · DOC-05 (P2 · A · CONF: `git tag` = 0, 0 releases, sin CHANGELOG) · OPS-03 parte de publicación (P1).
- **Prioridad:** P1 · **Especialidad:** CI/release · **Carril:** L4 (`.github/workflows/`, notas de release).
- **Dependencias:** ⚑ decisión del operador: número de versión (`v0.x.y`), visibilidad de imágenes en el registro y aceptación del asset de release como fuente de confianza del proxy. El **tag definitivo** se crea en F3 sobre el SHA congelado; en F1 se construye y prueba el flujo con una pre-release de ensayo.
- **Esfuerzo:** S-M + M · incertidumbre media (política de confianza asset vs build local) · **Riesgo:** publicar una release desde un SHA no congelado; el flujo sólo debe dispararse desde un tag.
- **Pruebas exigidas:** `gh release view v0.x.y` lista bundle, `.sha256` y notas con digests; descarga + `sha256sum -c` correcto; las imágenes citadas existen por digest.
- **Evidencia de cierre:** criterio [D1](12-RELEASE-DEFINITION-OF-DONE.md#d1).
- **Paralelizable:** sí; T-08 depende de su asset. **Etapa:** F1 (flujo) → F3 (tag).

<a id="t-11"></a>
### T-11 · `cli.ts create-admin`
- **Objetivo:** crear el primer administrador sin `psql`.
- **Cierra:** OPS-02 (P1→P2 (REVISION-TECNICA) · A (DECISIONES-DIRECTOR) · CODE_VERIFIED: `docs/operations/first-run.md:79-103` INSERT por `psql`; `apps/api/src/db/cli.ts` sin `create-admin`) · parte de TD-023 (P2).
- **Prioridad:** P2 · **Especialidad:** backend · **Carril:** L2 (`apps/api/src/db/cli.ts`).
- **Dependencias:** ninguna. La contraseña nunca por argv: por stdin o fichero 0600.
- **Esfuerzo:** S · incertidumbre baja · **Riesgo:** bajo.
- **Pruebas exigidas:** test de CI que crea el admin y hace login; mutante (no asignar rol) en rojo; escenario OPS S03 en laboratorio.
- **Evidencia de cierre:** criterio [D5](12-RELEASE-DEFINITION-OF-DONE.md#d5).
- **Paralelizable:** sí. **Etapa:** F1.

<a id="t-12"></a>
### T-12 · Modo de registro `open | invite | closed` con valor por defecto cerrado o por invitación ⚑
- **Objetivo:** que ninguna instalación nazca con alta libre y cómputo de sandbox abierto a cualquiera.
- **Cierra:** SEC-02 (P2 · A (DECISIONES-DIRECTOR) · CODE_VERIFIED: registro abierto con rol `developer`, sin verificación de email ni interruptor, `apps/api/src/routes/auth.ts:147-175`) · parte de TD-012 / D-01 (con este interruptor UX-02 deja de ser P1, ver [T-30](#t-30)).
- **Prioridad:** P2 (es la condición que mantiene en P2 a REV-02, REV-03 y TD-012) · **Especialidad:** backend + web · **Carril:** L2 (API, variable, invitaciones) y L3 (pantalla de alta con código de invitación).
- **Dependencias:** ⚑ política de registro por defecto (invitación o cerrado) y quién emite invitaciones.
- **Esfuerzo:** M · incertidumbre baja · **Riesgo:** romper el golden path de CI que se registra: el entorno de CI debe fijar el modo explícitamente.
- **Pruebas exigidas:** test de contrato: con el `.env` por defecto, `POST /auth/register` anónimo → rechazo; con invitación válida → 201; mutante (ignorar el modo) en rojo.
- **Evidencia de cierre:** criterio [D6](12-RELEASE-DEFINITION-OF-DONE.md#d6).
- **Paralelizable:** sí (L2 primero el contrato en `openapi.yaml`, L3 después la pantalla). **Etapa:** F1.

<a id="t-13"></a>
### T-13 · Bots de práctica «de la casa» e instancia no vacía
- **Objetivo:** que un usuario nuevo llegue a su primera batalla con un solo bot propio, y que una instalación recién hecha muestre contenido.
- **Cierra:** UX-01 (P1→P2 (REVISION-TECNICA) · A en forma barata (DECISIONES-DIRECTOR) · CODE_VERIFIED: `apps/web/src/pages/BattleNewPage.tsx:421-422` rechaza el mismo bot en ambos bandos; `:285,298` lista bots publicados ajenos, que en una instalación nueva no existen) · «instancia recién instalada vacía» (nuevo, REVISION-PRODUCTO §2) · V-05 (`apps/api/src/db/cli.ts:10,70`, `demo-teams` crea equipos en `draft` para un usuario existente).
- **Prioridad:** P2 · **Especialidad:** backend + E2E · **Carril:** L2 (cuenta del sistema y paso de `bootstrap` que publica ≥3 bots de práctica **pasando por el pipeline real**, sin estados fabricados) y L3 (golden de Playwright «primer bot → batalla contra rival de la casa → replay»).
- **Dependencias:** T-08 (en una instalación real el build necesita la cadena de ejecución). Nunca `seed` (crea cuentas con contraseña pública; ver [T-40](#t-40)).
- **Esfuerzo:** M + S-M · incertidumbre media (cómo modela la API un bot de sistema) · **Riesgo:** atajo que publique sin build: lo detecta la auditoría de transición exigida en D9.
- **Pruebas exigidas:** tras `bootstrap` en laboratorio, la API lista ≥3 bots de práctica `published` con build real; golden nuevo obligatorio en `functional-e2e`.
- **Evidencia de cierre:** criterios [D8](12-RELEASE-DEFINITION-OF-DONE.md#d8) y [D9](12-RELEASE-DEFINITION-OF-DONE.md#d9).
- **Paralelizable:** sí con L1/L4/L5/L6; dentro de L2 tras T-11. **Etapa:** F1 → F2.

<a id="t-14"></a>
### T-14 · Cambio de contraseña y reset asistido por administrador (auditado)
- **Objetivo:** que nadie quede fuera de su cuenta sin que el operador escriba un hash Argon2 por SQL.
- **Cierra:** SEC-03 parte (P2 · CODE_VERIFIED: `apps/api/src/routes/auth.ts:386-396` crea y descarta el token de recuperación; sin cambio de contraseña) · UX-02 parte (P1 condicional → P2 con registro por invitación (REVISION-TECNICA D-01); grupo A sólo cambio + reset asistido (DECISIONES-DIRECTOR)) · TD-012 parte.
- **Prioridad:** P2 · **Especialidad:** backend + web · **Carril:** L2 (endpoints, auditoría) y L3 («Mi cuenta», acción de admin).
- **Dependencias:** T-12 (mismo módulo de auth: secuenciar dentro de L2).
- **Esfuerzo:** S-M · incertidumbre baja · **Riesgo:** el reset asistido revela la contraseña temporal al admin: entregarla una vez y forzar cambio en el primer login.
- **Pruebas exigidas:** E2E del ciclo «admin resetea → usuario entra → cambia»; entrada en `audit_log`; mutante (sin comprobación de rol admin) en rojo.
- **Evidencia de cierre:** criterio [D11](12-RELEASE-DEFINITION-OF-DONE.md#d11).
- **Paralelizable:** sí, con L1/L4/L5/L6. **Etapa:** F1.

<a id="t-15"></a>
### T-15 · Cabeceras de seguridad de la SPA
- **Objetivo:** CSP, `X-Frame-Options`/`frame-ancestors`, `nosniff` y `Referrer-Policy` en la SPA, sin romper el visor.
- **Cierra:** SEC-01 (P2 · A (DECISIONES-DIRECTOR) · CODE_VERIFIED: `infrastructure/docker/web/nginx.conf` sólo `Content-Type`/`Cache-Control`; gateway sólo HSTS (`infrastructure/gateway/nginx.conf:88`, `nginx-behind-proxy.conf:60`); CSP/XFO sólo en la API).
- **Prioridad:** P2 · **Especialidad:** seguridad web · **Carril:** L5 (`infrastructure/docker/web/`, `infrastructure/gateway/`).
- **Dependencias:** ninguna; verificar si el proxy inverso del operador ya las añade (T-23) no cambia el defecto del producto.
- **Esfuerzo:** S (M si la CSP del visor/Phaser lo exige) · incertidumbre media · **Riesgo:** CSP que rompe el visor: el golden en navegador debe seguir verde.
- **Pruebas exigidas:** test sobre la configuración real del gateway; `curl -sI` en laboratorio; golden en verde.
- **Evidencia de cierre:** criterio [D7](12-RELEASE-DEFINITION-OF-DONE.md#d7).
- **Paralelizable:** sí. **Etapa:** F1.

<a id="t-16"></a>
### T-16 · Prueba de aislamiento de red del sandbox en la red real, calibrada 🔬
- **Objetivo:** sustituir una garantía que hoy no puede ponerse roja por una medición de la topología real.
- **Cierra:** REV-01 (P2→P1, grupo A (DECISIONES-DIRECTOR) · V-07 CONFIRMADO: `tests/sandbox-escape/run-escape-suite.sh:26,52,57,87-88` crea una red `--internal` vacía con `--dns 0.0.0.0`; `tests/sandbox-escape/bots/05_internal_network_scan.py:7-8` prueba nombres inexistentes en esa red; en compose real `tournament-worker` (`docker-compose.yml:360`, también en la red `data`) y `bot-build-worker` (`:535`) comparten la red `arena` con los bots) · aporta la medición de REV-04 y SEC-04/TD-033 (verificación FASE 2 #5 de SEC, obligatoria según REVISION-TECNICA).
- **Prioridad:** P1 · **Especialidad:** seguridad + QA · **Carril:** L5 (prueba en `tests/sandbox-escape/`) + L4 (cableado en el job `container-proxy-e2e`) + L7 (ejecución en laboratorio).
- **Dependencias:** laboratorio aislado (🔬). El resultado decide si [T-39](#t-39) (REV-04) y la parte de SEC-04 de [T-67](#t-67) suben de grupo.
- **Esfuerzo:** M · incertidumbre media · **Riesgo:** **alto de alcance**: si la medición muestra conexiones no previstas bot → worker con credenciales de BD, la remediación (red por batalla, `enable_icc=false`, separar el anfitrión) es M-L con incertidumbre alta y entra en el camino crítico.
- **Pruebas exigidas:** escaneo por IP de la subred y puertos reales de los workers desde un bot en la red `arena` del stack real; **control positivo** (mutante: añadir a `arena` un servicio con puerto abierto ⇒ la prueba se pone roja); mismo escaneo bot ↔ bot.
- **Evidencia de cierre:** run de CI con la prueba nueva + run del control positivo en rojo + acta de laboratorio con la matriz de alcanzabilidad medida. Criterio [D17](12-RELEASE-DEFINITION-OF-DONE.md#d17).
- **Paralelizable:** sí con todo salvo otros calibradores sobre el mismo árbol (calibraciones en serie). **Etapa:** F0 (medición) → F1 (prueba) → F2 (remediación si procede).

<a id="t-17"></a>
### T-17 · Nightly en verde
- **Objetivo:** recuperar la señal diaria (determinismo ×1000 y suites lentas) sin la que no se puede congelar.
- **Cierra:** QA-01 (P2 · A (DECISIONES-DIRECTOR) · TEST_VERIFIED: run 44519497401 sobre 8f380eb, `slow-suites` failure por `spawnSync ffmpeg ENOENT` y `unshare -rm` sin userns; último verde programado 2026-08-04, 111 fallos en las últimas 129 ejecuciones (V-03/V-06)) · STR-09 (P2, mismo defecto) · TD-019 (P3→P2).
- **Prioridad:** P2 · **Especialidad:** CI · **Carril:** L4 (`.github/workflows/nightly.yml`).
- **Dependencias:** ninguna para el arreglo; el criterio de N ejecuciones verdes consecutivas se cumple sobre el SHA congelado en F3.
- **Esfuerzo:** S · incertidumbre baja (más la espera de calendario de N ejecuciones, que no es esfuerzo) · **Riesgo:** que, una vez verde, aparezcan fallos reales que el rojo de entorno ocultaba desde agosto: presupuestar su corrección como UNKNOWN.
- **Pruebas exigidas:** `workflow_dispatch` tras el cambio; recuento de conclusiones de todos los jobs, no la cola de `--watch`.
- **Evidencia de cierre:** criterio [D13](12-RELEASE-DEFINITION-OF-DONE.md#d13).
- **Paralelizable:** sí. **Etapa:** F1 (arreglo) → F3 (N verdes).

<a id="t-18"></a>
### T-18 · Escaneo y remediación de las imágenes de servicio (TD-031) 🔬
- **Objetivo:** saber cuántos HIGH/CRITICAL tienen hoy las imágenes de servicio y bajar de P1 sólo con medición.
- **Cierra:** TD-031 (P1, grupo A «hasta pasar trivy en FASE 2» (DECISIONES-DIRECTOR); la rebaja P1→P2 de SEC no está justificada sin medir (REVISION-TECNICA)) · parte de SEC-05 (P2: escaneo; `ci.yml:880` sólo escanea `fs`, E6 sólo runtimes de bots; `infrastructure/docker/node-service/Dockerfile:9,21` con herramientas de desarrollo).
- **Prioridad:** P1 · **Especialidad:** seguridad + CI · **Carril:** L5 (Dockerfiles) + L4 (job de escaneo de imágenes en CI) + L7 (medición).
- **Dependencias:** laboratorio (🔬) para la medición inicial; el resto de SEC-05 (`--omit=dev`, base por digest) en [T-37](#t-37) salvo que la remediación lo exija antes.
- **Esfuerzo:** M · incertidumbre **alta** (la remediación depende del recuento, hoy UNKNOWN; el último dato, 74 HIGH/CRITICAL, no se re-midió) · **Riesgo:** que la remediación exija cambiar imágenes base y re-ejecutar toda la batería.
- **Pruebas exigidas:** `trivy image --severity HIGH,CRITICAL --ignore-unfixed` sobre las 6 imágenes Node del SHA candidato; gate en CI con excepciones datadas.
- **Evidencia de cierre:** informe de escaneo del SHA congelado y run del gate. Criterio [D18](12-RELEASE-DEFINITION-OF-DONE.md#d18).
- **Paralelizable:** sí. **Etapa:** F0 (medición) → F1/F2 (remediación) → F3 (re-escaneo del SHA congelado).

<a id="t-19"></a>
### T-19 · Runbooks de salida: torneo `closed` atascado y jobs `needs_review`
- **Objetivo:** que el operador tenga una salida documentada (SQL/CLI revisado, con precondición y rollback) mientras la salida de producto llega en B.
- **Cierra:** BE-01 parte A (P1→P2 (REVISION-TECNICA) · grupo B + runbook SQL en A (DECISIONES-DIRECTOR) · CODE_VERIFIED: `apps/tournament-worker/src/battle-failure.ts:15-16`, `results.ts:549-558` rescata sólo `running`, `apps/api/src/routes/tournaments.ts:41` `CANCELLABLE = draft,open`, `scheduler.ts:249-275` + `queue.ts:213-226` → `needs_review` sin reintentos) · BE-02 parte A (P1→P2 (REVISION-TECNICA); runbook en A según REVISION-PRODUCTO §5.1).
- **Prioridad:** P2 · **Especialidad:** backend + operaciones · **Carril:** L1 (`docs/operations/` runbooks; fichero propio, distinto de los de T-09).
- **Dependencias:** ninguna. Validación en laboratorio forzando el fallo (verificación BE FASE 2 #1).
- **Esfuerzo:** S + S · incertidumbre baja · **Riesgo:** runbook que se desfasa con el esquema: incluir la versión de esquema a la que aplica.
- **Pruebas exigidas:** ejecución del runbook en laboratorio sobre un torneo forzado a `closed` con `generate_schedule` fallido y sobre un job forzado a `needs_review`.
- **Evidencia de cierre:** acta de laboratorio. Criterio [D10](12-RELEASE-DEFINITION-OF-DONE.md#d10).
- **Paralelizable:** sí. **Etapa:** F1 → F2.

<a id="t-20"></a>
### T-20 · Ensayo completo de restore en host limpio, con acta 🔬
- **Objetivo:** demostrar una vez, entera y cronometrada, la restauración que hoy sólo tiene procedimiento manual y evidencia parcial de terceros.
- **Cierra:** OPS-07 parte A (P1 · grupo B para la automatización, A el ensayo (REVISION-PRODUCTO §5.1) · CONF: `docs/operations/restore.md` fases manuales; evidencias de restauración del operador de agosto y de la reinstalación de noviembre son de tercero y parciales) · TD-025 (P1) · QA B-12 / OPS S08.
- **Prioridad:** P1 · **Especialidad:** QA/operaciones · **Carril:** L7.
- **Dependencias:** laboratorio aislado con almacenamiento de backup de laboratorio (nunca el del operador); T-07 (aviso de backup). En F3 se repite sobre el SHA congelado si cambió algo de backup.
- **Esfuerzo:** M · incertidumbre media · **Riesgo:** descubrir que la restauración no reproduce todo (replays, artefactos de bots): convertiría una tarea de verificación en una de corrección (UNKNOWN).
- **Pruebas exigidas:** escenario S08: backup, destruir la VM de laboratorio, restaurar sólo con la custodia documentada; conteo y md5 por tabla frente al original; replays y artefactos presentes; tiempo total.
- **Evidencia de cierre:** acta con rc de cada fase, tiempos y comparación por tabla. Criterio [D12](12-RELEASE-DEFINITION-OF-DONE.md#d12).
- **Paralelizable:** sí con desarrollo; en el laboratorio, en serie con T-21/T-22. **Etapa:** F2 (y repetición en F3 si procede).

<a id="t-21"></a>
### T-21 · Ensayo de instalación limpia por una persona ajena (D4) 🔬 ⚑
- **Objetivo:** probar que un tercero instala siguiendo sólo README → `installation.md` → `first-run.md` hasta una batalla `finished`, sin preguntar.
- **Cierra:** QA-03 parte A (P1→P2, A→B (REVISION-TECNICA); en A basta el ensayo manual D4 con evidencia (DECISIONES-DIRECTOR)) · validación de OPS-01/02/04/13 · OPS S01+S03+S04+S05+S12 · QA B-01.
- **Prioridad:** P1 (es la prueba de que OPS-01 está cerrado) · **Especialidad:** QA + persona ajena · **Carril:** L7.
- **Dependencias:** ⚑ el operador designa a la persona ajena (no autora); SHA congelado (F3); T-04, T-06 … T-13 cerrados.
- **Esfuerzo:** M · incertidumbre media (más las correcciones que destape, UNKNOWN) · **Riesgo:** cada pregunta de la persona es un hallazgo; si hay correcciones, cambia el SHA y se repite (ver [14 §6](14-RELEASE-DELIVERY-PLAN.md#6-congelación)).
- **Pruebas exigidas:** VM Debian 12 limpia de laboratorio; registro de cada intervención y tiempo total; `doctor-lite` rc 0.
- **Evidencia de cierre:** acta firmada por la persona ajena y el validador. Criterio [D4](12-RELEASE-DEFINITION-OF-DONE.md#d4).
- **Paralelizable:** no (es el ensayo final sobre el SHA congelado). **Etapa:** F3.

<a id="t-22"></a>
### T-22 · Medición de recursos para los requisitos declarados (S06) 🔬
- **Objetivo:** obtener las cifras de mínimo/recomendado y la concurrencia sugerida, en vez de inventarlas.
- **Cierra:** OPS-05 parte de medición (P1→P2 (REVISION-TECNICA); «M medir en lab, FASE 2») · QA B-15 · insumo de T-08 (preflight) y T-09 (tabla).
- **Prioridad:** P2 · **Especialidad:** QA/rendimiento · **Carril:** L7.
- **Dependencias:** laboratorio aislado; **nunca contra producción** (el host de producción comparte hipervisor con otros sistemas). Puede hacerse sobre 8f380eb (el consumo no depende de las tareas de A+) para no esperar a F2.
- **Esfuerzo:** M · incertidumbre media · **Riesgo:** laboratorio con recursos distintos del host tipo de un tercero: declarar la máquina de medición en la tabla.
- **Pruebas exigidas:** torneo de 4 bots con `TOURNAMENT_WORKER_CONCURRENCY` 1 y 2; `docker stats`, `vmstat`, disco antes/después; `dmesg` sin lockups.
- **Evidencia de cierre:** acta con las series medidas. Criterio [D15](12-RELEASE-DEFINITION-OF-DONE.md#d15).
- **Paralelizable:** sí con desarrollo; en serie con otros usos del laboratorio. **Etapa:** F0.

### Verificaciones FASE 2 obligatorias antes del GO (grupo A)

<a id="t-23"></a>
### T-23 · FASE 2 · Producción en sólo lectura 🔬
- **Objetivo:** contrastar con el host de producción lo que hoy es evidencia de tercero, sin escribir nada.
- **Cubre:** versión desplegada (`/version`) y `docker inspect .Config.Image` frente a lo declarado (TD-006); cabeceras reales tras el proxy inverso del operador (SEC #1); firewall aplicado (`s9-firewall.sh check`, SEC #2); permisos de `.env`/`secrets` (SEC #8, TD-060); `/version` en :80 desde fuera de la LAN (SEC-09, SEC #10); jobs y torneos zombis por SQL de lectura (BE #8, BE-01/BE-10); R5 `docker manifest inspect` del tag `latest` (lectura pública, OPS-04).
- **Prioridad:** P1 · **Especialidad:** operaciones (sólo lectura) · **Carril:** L7 con autorización del operador.
- **Dependencias:** cierre de la migración de producción en curso y confirmación del operador de que no hay operaciones críticas (00-PRERREQUISITOS #2, #5). Ningún comando de escritura; nada de carga.
- **Esfuerzo:** S · incertidumbre baja · **Riesgo:** confundir lectura con diagnóstico intrusivo; lista cerrada de comandos aprobada antes.
- **Evidencia de cierre:** acta con comando, salida saneada (sin IP, host ni dominio) y conclusión por ítem. **Paralelizable:** sí. **Etapa:** F0.

<a id="t-24"></a>
### T-24 · FASE 2 · Laboratorio: verificaciones de seguridad 🔬
- **Cubre:** R1 (REV-01/REV-04: barrido y conexión bot → workers y bot ↔ bot), R4 (= T-18), R6 (REV-05: registrar el email semilla y ejecutar `seed`), SEC #3 (alcance del proxy desde contenedor ajeno), #4 (sandbox real), #5 (SEC-04), #6 (`TRUST_PROXY_HOPS`, SEC-10), #7 (cookie `Secure`), #11 (matriz de roles + IDOR manual), #13 (Origin del WS), #14 (`npm audit`).
- **Prioridad:** P1 · **Especialidad:** seguridad · **Carril:** L7 (+ L5 para preparar bots de prueba) · **Dependencias:** laboratorio aislado; en serie con otros calibradores.
- **Esfuerzo:** M · incertidumbre media · **Riesgo:** hallazgos nuevos que suban de grupo (REV-04 pasa a A si la versión presume de competiciones públicas con premio (DECISIONES-DIRECTOR)).
- **Evidencia de cierre:** acta por verificación con «confirma / refuta» y, si confirma, tarea T-NN asignada. **Paralelizable:** con desarrollo sí. **Etapa:** F0.

<a id="t-25"></a>
### T-25 · FASE 2 · Laboratorio: backend, cola y carga 🔬
- **Cubre:** R2 (REV-02: tiempo de `verify` de una batalla larga y 10 en paralelo midiendo `/users/me`; **> 1 s ⇒ REV-02 pasa a P1 y a grupo A** con registro abierto (DECISIONES-DIRECTOR)), R3 (REV-03: 200 prácticas antes de un torneo), BE #1 (zombi de torneo), #2 (timeouts), #3 (orfandad), #4 (caída de BD → 5xx y no 404, BE-06), #5 (import ≥130 versiones, BE-07), #6 (BE-12), #7 (migraciones y rollback), #9 (registro concurrente, BE-11); ARQ #1 (ARQ-01), #5 (estrés por modo), #6 (ARQ-11).
- **Prioridad:** P2 (P1 si R2 supera el umbral) · **Especialidad:** backend + QA · **Carril:** L7 · **Dependencias:** laboratorio aislado; **las pruebas de carga nunca contra producción**.
- **Esfuerzo:** M · incertidumbre media · **Evidencia de cierre:** acta con mediciones y decisión de grupo para REV-02. **Paralelizable:** con desarrollo sí. **Etapa:** F0.

<a id="t-26"></a>
### T-26 · FASE 2 · Recorridos de producto que la auditoría no cubrió 🔬
- **Cubre (REVISION-PRODUCTO §9):** visitante anónimo (portada, ranking, ayuda, directo, replay, con los flags públicos en ambos valores); instancia recién instalada (contenido visible para un usuario nuevo); día 2 del admin (contraseña olvidada, job en `needs_review`, disco al 85 %, bot con nombre ofensivo, actualizar a un SHA nuevo); notificación de fallo (¿el usuario encuentra el motivo en ≤ 2 clics?); inventario de datos personales. Además: UX-11 (publicada ≠ elegible: si no avisa antes, pasa a A), STR T9 (replays de formato v1 y de motor 0.4.0, STR-03), quickstart local del SDK sin cuenta (DOC FASE 2 #1), axe y móvil (UX §7.2).
- **Prioridad:** P2 · **Especialidad:** producto/UX + QA · **Carril:** L7 · **Dependencias:** laboratorio con una instalación nueva; repetir «instancia nueva» y «visitante anónimo» sobre el SHA congelado.
- **Esfuerzo:** M · incertidumbre media · **Evidencia de cierre:** acta por recorrido con PASS/FAIL y tareas derivadas. **Paralelizable:** sí. **Etapa:** F0 (primera pasada) → F3 (repetición).

---

## 3. Grupo B — versión objetivo siguiente (pública completa)

Bloque más breve: cada tarea con los mismos campos. Ninguna bloquea A+, salvo las marcadas «condicional».

<a id="t-30"></a>
### T-30 · Recuperación de contraseña por correo ⚑
- **Objetivo / cierra:** recuperación autónoma. UX-02 parte email (P1 condicional → P2 con registro por invitación (REVISION-TECNICA D-01); grupo B (DECISIONES-DIRECTOR)) · SEC-03 parte transporte (P2) · TD-012.
- **Prioridad** P2 · **Especialidad** backend + web · **Carril** L2/L3 · **Dependencias** ⚑ canal de correo (proveedor, remitente, plantillas) · **Esfuerzo** L, incertidumbre media · **Riesgo** entregabilidad; oráculo de cuentas (SEC-06) · **Pruebas** E2E con buzón de laboratorio; token de un solo uso y caducidad; mutante (token reutilizable) en rojo · **Evidencia** run E2E · **Paralelizable** sí · **Etapa** F4. Pasa a A si el operador decide abrir el registro.

<a id="t-31"></a>
### T-31 · Salida de producto para torneo `closed` atascado
- **Cierra:** BE-01 (P1→P2 (REVISION-TECNICA), B (DECISIONES-DIRECTOR)) · BE-08 (P3/C: cancelación sólo en `draft`/`open`, issues #287/#288 abiertas con backend ya en main).
- **Prioridad** P2 · **Especialidad** backend · **Carril** L2 · **Dependencias** T-19 · **Esfuerzo** M, incertidumbre media · **Riesgo** cancelar con batallas `running` · **Pruebas** integración: handler que lanza error → estado final + cancelación admin posible · **Evidencia** test + mutante · **Paralelizable** sí · **Etapa** F4.

<a id="t-32"></a>
### T-32 · Superficie operativa de jobs `needs_review`
- **Cierra:** BE-02 (P1→P2 (REVISION-TECNICA); `grep needs_review` sólo en `migrations.ts` y tests).
- **Prioridad** P2 · **Especialidad** backend + web · **Carril** L2/L3 · **Dependencias** T-19 · **Esfuerzo** M, baja · **Pruebas** listado y reintento/descarte desde web o CLI, auditados · **Evidencia** E2E · **Paralelizable** sí · **Etapa** F4.

<a id="t-33"></a>
### T-33 · `doctor` completo y `/healthz` que comprueba dependencias
- **Cierra:** BE-03 (P2 · `apps/api/src/server.ts:31` devuelve `{status:"ok"}` fijo) · OPS-12 (P2).
- **Prioridad** P2 · **Carril** L1 + L2 · **Dependencias** T-07 · **Esfuerzo** M + S-M, media · **Pruebas** caída de BD/cola ⇒ healthz no-ok; mutante · **Evidencia** test + acta S10 parcial · **Paralelizable** sí · **Etapa** F4.

<a id="t-34"></a>
### T-34 · Backup completo: poda configurable, guía del lado servidor, alertas por defecto, apagado limpio
- **Cierra:** OPS-06 resto (P1, B · `infrastructure/backup/backup.sh:771` `forget … --prune` incondicional; alertmanager sólo en perfil `observability` con webhook de relleno, `docker-compose.yml:1016-1024`) · TD-007 (P0→P1; `postgres` sin `stop_grace_period`).
- **Prioridad** P1 · **Carril** L1 · **Esfuerzo** M, baja · **Pruebas** S10 (backup con destino caído ⇒ alerta en webhook de laboratorio) · **Evidencia** acta · **Paralelizable** sí · **Etapa** F4.

<a id="t-35"></a>
### T-35 · `restore-all.sh`
- **Cierra:** OPS-07 automatización (P1, B) · TD-025. **Carril** L1 · **Dependencias** T-20 (el ensayo manual fija el procedimiento) · **Esfuerzo** M, media · **Pruebas** S08 automatizado · **Etapa** F4.

<a id="t-36"></a>
### T-36 · Actualización y rollback con un comando, y prueba N-1 → N con datos
- **Cierra:** OPS-08 (P2 · `apps/api/src/server.ts` no migra al arrancar; `upgrades.md`) · QA-03 parte upgrade/rollback (P1→P2, B (REVISION-TECNICA, DECISIONES-DIRECTOR)) · QA B-13 / OPS S09.
- **Prioridad** P2 · **Carril** L1 + L4 (job `workflow_dispatch`) · **Esfuerzo** M-L + M, media · **Riesgo** pérdida de datos en `down` de migraciones (BE-09) · **Pruebas** upgrade con datos sembrados y batalla `running`, rollback, esquema coherente · **Etapa** F4.

<a id="t-37"></a>
### T-37 · Endurecer imágenes de servicio: `--omit=dev`, base por digest
- **Cierra:** SEC-05 resto (P2, B). **Carril** L5 · **Dependencias** T-18 · **Esfuerzo** M, media · **Pruebas** re-escaneo + batería completa · **Etapa** F4 (antes si T-18 lo exige).

<a id="t-38"></a>
### T-38 · Cuotas: verificación de replays y batallas de práctica (condicional)
- **Cierra:** REV-02 (P2, B; **pasa a P1/A si T-25 mide > 1 s** con registro abierto (DECISIONES-DIRECTOR) · `apps/api/src/routes/replays.ts:290-342`, `anon-quota.ts:15,20` no aplica a autenticados) · REV-03 (P2, B · `apps/api/src/routes/battles.ts:614-663` sin limitador ni `created_by`; `apps/tournament-worker/src/queue.ts:95-118` FIFO compartida).
- **Prioridad** P2 (condicional P1) · **Carril** L2 · **Esfuerzo** S-M + S-M, baja · **Pruebas** test de claim con 100 prácticas antes de una oficial; limitador de concurrencia de `verify` · **Etapa** F4 (F2 si sube a A).

<a id="t-39"></a>
### T-39 · Aislamiento entre bots: red por batalla o `enable_icc=false`
- **Cierra:** REV-04 (P2, B; A si la versión presume de competiciones públicas con premio (DECISIONES-DIRECTOR) · `docker-compose.yml:1229-1235`, `apps/bot-manager/src/docker-proxy.ts:385-386,931`).
- **Prioridad** P2 · **Carril** L5 · **Dependencias** T-16/T-24 · **Esfuerzo** M, media (el proxy exige el nombre literal `arena`) · **Pruebas** E2E con dos bots que intentan conectarse · **Etapa** F4 (F2 si T-16 lo exige).

<a id="t-40"></a>
### T-40 · Guarda de `cli seed`
- **Cierra:** SEC-14 (P3→P2 (REVISION-TECNICA)) · REV-05 (P2, B · `apps/api/src/db/seeds/dev.ts:27-34,73-89`, `cli.ts:63-66`).
- **Carril** L2 · **Esfuerzo** S, baja · **Pruebas** registrar el email semilla y ejecutar `seedDev` ⇒ rechazo · **Etapa** F4 (candidata barata a adelantar).

<a id="t-41"></a>
### T-41 · Estadísticas que comprueban la versión del motor
- **Cierra:** ARQ-01 (P2, B · `apps/replay-service/src/stats.ts:620-659` sin `headerIncompatibility`). **Obligatoria antes de la próxima subida de motor.**
- **Carril** L2 · **Esfuerzo** S, baja · **Pruebas** test calibrado (replay con `versions.engine` alterado ⇒ rechazo) · **Etapa** F4.

<a id="t-42"></a>
### T-42 · Pulido UX barato: estados en español, `aria-label` reales, selector de ruleset
- **Cierra:** UX-03 (P3, B en A+ (REVISION-PRODUCTO §3) · `apps/web/src/pages/BotsPage.tsx:1126,1315`) · UX-05 (P3, B · 23 `aria-label` tipo slug según REVISION-TECNICA) · UX-07 (P2, B · `TournamentsPage.tsx:35,150-152`).
- **Carril** L3 · **Esfuerzo** 3 × S, baja · **Pruebas** a11y-basics + test del selector · **Etapa** F4 (adelantable a F2 si sobra capacidad en L3).

<a id="t-43"></a>
### T-43 · Gestión de usuarios en la web (sin UUID tecleado)
- **Cierra:** UX-08 (P2, B (REVISION-PRODUCTO)) · TD-023 (P2 (REVISION-TECNICA D-05)). **Carril** L2/L3 · **Esfuerzo** M · **Etapa** F4.

<a id="t-44"></a>
### T-44 · Aviso de elegibilidad antes del fallo (condicional)
- **Cierra:** UX-11 (P2, HIPÓTESIS, B; **A si T-26 confirma** que no avisa antes). **Carril** L3 · **Esfuerzo** M · **Etapa** F4 (F2 si sube).

<a id="t-45"></a>
### T-45 · Replays antiguos: explicar o purgar ⚑
- **Cierra:** STR-03 (P2, B · sin `format_version_mismatch` en `apps/web/src`). **Decisión**: purga (PR #295) o mensaje. **Carril** L3 (o L1 si purga) · **Esfuerzo** S · **Etapa** F4.

<a id="t-46"></a>
### T-46 · Re-auditoría documental del roadmap y de la documentación de streaming
- **Cierra:** DOC-03 resto (P2, B; L) · STR-11 (cerrar o reescribir TD-066, refutada por el código) · STR-12 (P3). **Carril** L6 · **Esfuerzo** L + S, media · **Etapa** F4.

<a id="t-47"></a>
### T-47 · PR documentales: rescatar y cerrar ⚑
- **Cierra:** DOC-08 (P3, B: #277 obsoleto como conjunto con partes rescatables; #286 y #266 planes ausentes de main). **Carril** L6 + OP · **Esfuerzo** S-M · **Etapa** F4.

<a id="t-48"></a>
### T-48 · Ficheros de comunidad: SECURITY.md, plantillas, CONTRIBUTING en la raíz
- **Cierra:** DOC-06 (P2, B). Candidata barata a adelantar a A+ (REVISION-PRODUCTO §8 la cita junto a las cabeceras). **Carril** L6 · **Esfuerzo** S · **Etapa** F4 (o F2).

<a id="t-49"></a>
### T-49 · Privacidad, términos y baja de cuenta ⚑
- **Cierra:** hallazgo nuevo de REVISION-PRODUCTO (sin `delete` en `/users/me`, `openapi.yaml:284-330`; sin páginas de privacidad/términos). **B; pasa a A si el operador aloja una instancia pública con registro de terceros.** **Carril** L2/L3 + operador · **Esfuerzo** M · **Etapa** F4.

<a id="t-51"></a>
### T-51 · Quickstart de 5 minutos para programadores de bots
- **Cierra:** DOC-11 (P2, B). El README de A+ enlaza las guías existentes (`docs/user/getting-started.md`, `docs/user/bots/probar.md`). **Carril** L6 · **Esfuerzo** S · **Dependencias** T-26 (verificar el simulador local) · **Etapa** F4.

(T-50 queda libre a propósito: el estudio de usabilidad con 5-8 personas del guion UX §7.1 se incluye en [T-70](#t-70); no condiciona A+.)

Suma de estimaciones del grupo B (T-30 … T-51): 28,5 – 79,5 días-persona; incertidumbre dominada por T-30 (L), T-36 (M-L) y T-46 (L).

---

## 4. Grupo C — poslanzamiento

| ID | Objetivo | Hallazgos (sev. final) | Prio | Carril | Depende de | Esfuerzo | Riesgo | Pruebas / evidencia | Paral. | Etapa |
|---|---|---|---|---|---|---|---|---|---|---|
| <a id="t-60"></a>T-60 ⚑ | Streaming estable y diagnosticable (alcance a decidir) | STR-01 (P1→P2 (REVISION-TECNICA), C (DECISIONES-DIRECTOR)), STR-02 (P2), STR-05 (P2), STR-07 (P2), STR-10 (P2), STR-16 (P3), STR-17 (P2, A→B y operación (REVISION-TECNICA)) | P2 | L5/L7 | decisión de alcance de streaming | M + S-M ×4 + S | sesiones largas sólo medibles en lab ≥4 vCPU | FASE 2 STR T1-T8, T12 con actas | sí | F4 |
| <a id="t-61"></a>T-61 | Notificaciones (build, batalla, torneo) | nuevo (REVISION-PRODUCTO §3) | P3 | L2/L3 | T-30 si es por correo | M | — | E2E | sí | F4 |
| <a id="t-62"></a>T-62 | Moderación de nombres/contenido público | nuevo (C; **A si registro abierto**) | P2 | L2/L3 | T-12 | M | — | recorrido «día 2» T-26 | sí | F4 |
| <a id="t-63"></a>T-63 | Corrección de la API: errores → códigos correctos | BE-06 (P2), BE-11 (P2, TD-013 P1→P2), REV-06 (P3), REV-07 (P3) | P2 | L2 | — | M + S + S + S | tests que fijan mensajes | BE FASE 2 #4, #9 | sí | F4 |
| <a id="t-64"></a>T-64 | Operación y rendimiento backend | BE-04 (P2), BE-09 (P3), BE-10 (P3), BE-12 (P2), BE-13 (P3), BE-14 (P3), BE-15 | P2 | L2 | — | M + S + S-M + M + … | — | BE FASE 2 #3, #6, #7 | sí | F4 |
| <a id="t-65"></a>T-65 | Límite de import y `Retry-After` real | BE-07 (P2; `grep Retry-After apps/api/src` vacío) | P2 | L2 | — | S-M | — | BE FASE 2 #5 | sí | F4 |
| <a id="t-66"></a>T-66 | Validación de entrada por esquema OpenAPI | BE-05 (P2) | P2 | L2 | — | L, media | muchos tests fijan mensajes | suite API | no con T-63 | F4 |
| <a id="t-67"></a>T-67 | Endurecimiento de plataforma | SEC-04 (P2, TD-033 P1→P2 condicionada a T-16), SEC-06 (P3), SEC-07 (P3), SEC-08 (P3), SEC-09 (P3), SEC-10 (P3), SEC-11 (P3→P4 (REVISION-TECNICA)), SEC-12 (P3) | P2 | L5 | T-16 | L + M ×3 + S ×4 | SEC-04 sube a A si T-16 mide alcanzabilidad | SEC FASE 2 #3-#7, #10, #13 | sí | F4 |
| <a id="t-68"></a>T-68 | Eficacia de las pruebas | QA-02 (P2), QA-05, QA-06, QA-07 (P3), ARQ-02 (P3) | P2 | L4 | — | M + S ×3 + S-M | calibradores en serie | mutantes en nightly | sí | F4 |
| <a id="t-69"></a>T-69 | Deuda del motor | ARQ-03 (P3), ARQ-04 (P3), ARQ-05 (P4), ARQ-07 (P3), ARQ-09 (P4), ARQ-12 (P3) | P3 | L2 | — | S + M + S + M + S-M + — | — | ARQ FASE 2 #4, #5, #8 | sí | F4 |
| <a id="t-70"></a>T-70 | UX avanzada y estudio con personas | UX-04 (P2), UX-06 (P3), UX-10 (P2, hipótesis); guion UX §7.1 | P2 | L3 | — | M-L + M + M | — | SUS/SEQ, axe | sí | F4 |
| <a id="t-71"></a>T-71 ⚑ | SDK en registros públicos (PyPI/npm) | UX-09 resto (P2) | P2 | L4/L6 | T-01, decisión de publicación de paquetes | M-L | — | instalación del SDK sin clonar | sí | F4 |
| <a id="t-72"></a>T-72 | Instalador ampliado | `s9ctl` interactivo (REVISION-PRODUCTO §4), OPS-09 perfil ACME (P2), OPS-10 desinstalación (P2), OPS-15 otros SO (P3) | P2 | L1 | T-08 | M-L + M + S-M + M | — | S11, S01-bis | sí | F4 |
| <a id="t-73"></a>T-73 | Referencia API renderizada | DOC-12 (P3) | P3 | L4/L6 | — | S-M | — | publicación en CI | sí | F4 |
| <a id="t-74"></a>T-74 | Replays y espectador: política de longevidad, retardo, carga | STR-04 (P3), STR-06 (P3), STR-08 (P3), STR-15 (P3) | P3 | L2/L3 | ARQ-06 | L + … | — | STR T7, T8, T10 | sí | F4 |
| <a id="t-75"></a>T-75 ⚑ | Rescatar o registrar TD-064 | DOC-04 (P3; PR #169 draft) | P3 | L1/OP | decisión sobre PR #169 | S | — | test de `init-secrets.sh` | sí | F4 |

## 5. Grupo D — futuro (sólo diseño en este ciclo)

| ID | Objetivo | Hallazgos | Esfuerzo | Nota |
|---|---|---|---|---|
| <a id="t-80"></a>T-80 ⚑ | Streaming V2 | STR-14 (P4: PR #275 draft, sólo documento, diseño parcialmente caducado), STR-13 (P4) | XL | Decidir si el PR #275 se conserva como diseño o se cierra. No condiciona A+ ni B (DECISIONES-DIRECTOR). |
| <a id="t-81"></a>T-81 ⚑ | Mejoras visuales | PR #253 y fases visuales | L-XL | Grupo D (DECISIONES-DIRECTOR). |
| <a id="t-82"></a>T-82 | Motor, temporadas y determinismo entre plataformas | ARQ-06 (P3), ARQ-10 (P4), ARQ-11 (P3, hipótesis) | S + M | ADR «cambios de motor y temporadas». |
| <a id="t-83"></a>T-83 | Inglés / i18n | DOC-09 (P3) | M (README/quickstart) · XL (i18n) | A+ se presenta para comunidad hispanohablante. |
| <a id="t-84"></a>T-84 | Asistente web de instalación | REVISION-PRODUCTO §4 | — | No debe ser el instalador. |

## 6. Grupo E — descartes registrados

| ID | Qué se descarta | Hallazgos | Acción | Esfuerzo |
|---|---|---|---|---|
| <a id="t-90"></a>T-90 ⚑ | Purgar el historial git de topología | SEC-13 / TD-008 purga (E (DECISIONES-DIRECTOR)) | Registrar la decisión en `technical-debt.md`; el historial lo conserva todo y la información es de bajo valor (REVISION-TECNICA D-06). | S |
| <a id="t-91"></a>T-91 | Jobs de staging/humo que siempre se «omiten» | QA-04 (P3; `deploy-staging` y `smoke-and-promote` `success` siendo no-op en run 44383512640) | Retirar los jobs o renombrarlos, y documentar que la promoción es manual; dejar de citarlos como evidencia. | S |

## 7. Trazabilidad hallazgo → tarea

| Prefijo | Tareas |
|---|---|
| ARQ | 01→T-41 · 02→T-68 · 03/04/05/07/09/12→T-69 · 06/10/11→T-82 · 08→T-03 |
| BE | 01→T-19 (A) + T-31 · 02→T-19 (A) + T-32 · 03→T-33 · 04/09/10/12/13/14/15→T-64 · 05→T-66 · 06/11→T-63 · 07→T-65 · 08→T-31 |
| UX | 01→T-13 · 02→T-14 (A) + T-30 · 03/05/07→T-42 · 04/06/10→T-70 · 08→T-43 · 09→T-01 (licencia) + T-71 · 11→T-44 |
| OPS | 01→T-08 + T-09 · 02→T-11 · 03→T-10 + T-08 · 04→T-06 + T-07 · 05→T-09 + T-22 · 06→T-07 (A) + T-34 · 07→T-20 (A) + T-35 · 08→T-36 · 09→T-09 (receta) + T-72 · 10→T-72 · 11→T-04 · 12→T-07 + T-33 · 13→T-09 · 14→T-10 · 15→T-09 (declaración) + T-72 |
| SEC | 01→T-15 · 02→T-12 · 03→T-14 + T-30 · 04/06-12→T-67 · 05→T-18 + T-37 · 13→T-03 + T-90 · 14→T-40 |
| STR | 01/02/05/07/10/16/17→T-60 · 03→T-45 · 04/06/08/15→T-74 · 09→T-17 · 11/12→T-46 · 13/14→T-80 |
| DOC | 01→T-04 · 02→T-01 · 03→T-04 + T-46 · 04→T-75 · 05→T-10 · 06→T-48 · 07→T-03 · 08→T-47 · 09→T-83 · 10→T-05 · 11→T-51 · 12→T-73 · 13→T-02 |
| QA | 01→T-17 · 02/05/06/07→T-68 · 03→T-21 (A) + T-36 · 04→T-91 |
| REV | 01→T-16 · 02/03→T-38 · 04→T-39 · 05→T-40 · 06/07→T-63 |
| V / TD / nuevos | V-01→T-03 · V-02→T-04 · V-03/V-06→T-17 · V-04→T-06 · V-05→T-13 · V-07→T-16 · TD-031→T-18 · instancia vacía→T-13 · notificaciones→T-61 · moderación→T-62 · privacidad/términos→T-49 |

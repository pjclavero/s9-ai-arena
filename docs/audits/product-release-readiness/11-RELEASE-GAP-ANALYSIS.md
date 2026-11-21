# 11 · Análisis de brecha hasta una versión presentable

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Propósito: medir, dimensión por dimensión, la distancia entre el producto de `main` y una versión que una persona ajena pueda instalar, usar, mantener y que se pueda presentar públicamente; comparar tres alcances de lanzamiento y justificar la recomendación. Documento maestro: [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md). Tareas: [13-PRIORITIZED-BACKLOG.md](13-PRIORITIZED-BACKLOG.md) · Contrato: [12-RELEASE-DEFINITION-OF-DONE.md](12-RELEASE-DEFINITION-OF-DONE.md) · Plan: [14-RELEASE-DELIVERY-PLAN.md](14-RELEASE-DELIVERY-PLAN.md).

Convenciones: severidad final según REVISION-TECNICA cuando la ajusta («P1→P2 (REVISION-TECNICA)»); arbitrajes «(DECISIONES-DIRECTOR)». Grupo final = el de la opción recomendada A+. Esfuerzos: bandas de los informes (S ≤ ½ día · M 1-3 días · L 1-2 semanas · XL > 2 semanas); para sumar, S = 0,5 d, M = 1-3 d, L = 5-10 d, XL ≥ 10 d sin cota. **Toda suma es suma de estimaciones, no medición, y no incluye esperas de calendario (decisiones del operador, apertura de FASE 2, N nocturnas).** Detalle de hallazgos: instalación [07](07-INSTALLATION-OPERATIONS.md), seguridad [05](05-SECURITY-REVIEW.md), UX [06](06-UX-PRODUCT-REVIEW.md), pruebas [08](08-TEST-QUALITY.md), documentación [10](10-DOCUMENTATION-AUDIT.md); ARQ-, BE- y STR- por ID desde el documento maestro.

## 1. Veredicto de partida

**NOT_READY** para presentación pública (DECISIONES-DIRECTOR). La base técnica (motor determinista, cola, sandbox de contenedor, contrato API, golden path en CI) es sólida; lo que falta es «producto»: licencia, README veraz, una instalación documentada que **ejecute batallas**, una plantilla `.env` para terceros, una prueba de aislamiento que pueda fallar, una señal nocturna viva y una release. Producción, instalación medida, restore y streaming real: **INSUFFICIENT_EVIDENCE** hasta FASE 2.

## 2. Brecha por dimensión

Leyenda de la columna «Brecha A+»: tareas de grupo A que la cierran. «Resto» = lo que queda fuera de A+ con su grupo.

### 2.1 Motor
- **Hoy:** READY_WITH_CONDITIONS (informe ARQ, mantenido por REVISION-TECNICA). PRNG propio con flujos con nombre, hash de estado canonicalizado, lint de determinismo, verificador de replay de versión única (CODE_VERIFIED). Determinismo ×1000 en verde: job `determinism-1000` del nightly 44519497401 y acceptance 44537834319 (TEST_VERIFIED).
- **Objetivo A+:** sin cambios en el motor.
- **Brecha A+:** ninguna tarea de A. Riesgo a declarar en D16: cada subida de motor deja sin verificación los replays anteriores (STR-04, P3).
- **Resto:** ARQ-01 (P2, B, obligatorio antes de la próxima subida de motor → T-41) · ARQ-02/03/04/05/07/09/12 (P3-P4, C → T-68/T-69) · ARQ-06/10/11 (D → T-82).

### 2.2 Backend, API y datos
- **Hoy:** READY_WITH_CONDITIONS con condiciones nuevas (REVISION-TECNICA: añadir REV-02/REV-03; BE-01/BE-02 P1→P2).
- **Objetivo A+:** el operador no necesita SQL para crear el primer admin, resetear una contraseña o salir de un torneo atascado (runbook probado); hay bots de práctica en la instalación.
- **Brecha A+:** OPS-02 (P1→P2 (REVISION-TECNICA), A (DECISIONES-DIRECTOR)) → T-11 · SEC-02 → T-12 · SEC-03/UX-02 parte → T-14 · UX-01 parte API → T-13 · BE-01 (P1→P2, B + runbook en A (DECISIONES-DIRECTOR)) y BE-02 (P1→P2) → T-19.
- **Resto:** BE-01/BE-08 salida de producto (B → T-31) · BE-02 (B → T-32) · BE-03 (B → T-33) · REV-02 (P2, B; **A si FASE 2 mide > 1 s** (DECISIONES-DIRECTOR)) y REV-03 (P2, B) → T-38 · REV-05/SEC-14 (P3→P2 (REVISION-TECNICA), B → T-40) · BE-04..07, BE-09..15, REV-06, REV-07 (C → T-63..T-66).

### 2.3 Seguridad
- **Hoy:** READY_WITH_CONDITIONS **con condiciones más duras** (REVISION-TECNICA): sin P0 ni P1 con ruta de explotación conocida, pero el aislamiento de red del sandbox no está probado (REV-01, V-07), hay vectores de agotamiento sin cuota (REV-02/03) y TD-031 no se puede rebajar sin medir.
- **Objetivo A+:** postura segura por defecto para un tercero y garantías citadas que pueden ponerse rojas.
- **Brecha A+:** SEC-01 (P2, A (DECISIONES-DIRECTOR)) → T-15 · SEC-02 (P2, A) → T-12 · cuentas (UX-02/SEC-03/TD-012: cambio + reset asistido en A) → T-14 · REV-01 (P2→P1, A (DECISIONES-DIRECTOR)) → T-16 · TD-031 (P1, A hasta pasar el escaneo (DECISIONES-DIRECTOR)) → T-18 · TD-008/SEC-13 limpieza de ficheros (P2, A) → T-03/T-06. Verificaciones: T-24.
- **Resto:** SEC-05 resto (B → T-37) · REV-04 (P2, B; A si se anuncian competiciones públicas con premio) → T-39 · SEC-04 (P2, C; **sube si T-16 mide alcanzabilidad a servicios con credenciales**) y SEC-06..12 (C → T-67) · purga de historial (E → T-90).

### 2.4 Frontend
- **Hoy:** READY_WITH_CONDITIONS (UX). Nada medido con personas.
- **Objetivo A+:** primera batalla con un solo bot; pantallas de invitación, «Mi cuenta» y reset por admin.
- **Brecha A+:** UX-01 (P1→P2 (REVISION-TECNICA), A barato (DECISIONES-DIRECTOR)) → T-13 · pantallas de T-12 y T-14.
- **Resto:** UX-03/05/07 (B → T-42) · UX-08 (B → T-43) · UX-11 (P2, hipótesis, B; **A si T-26 confirma**) → T-44 · STR-03 (B → T-45) · UX-04/06/10 (C → T-70).

### 2.5 Nuevos usuarios (onboarding y visitante)
- **Hoy:** el visitante anónimo de una instalación nueva ve portada de texto, ranking vacío y replays públicos apagados por defecto (`infrastructure/.env.example:128-133`); `bootstrap` no crea bots; no hay notificaciones (REVISION-PRODUCTO §2, CODE_VERIFIED por el revisor). Recorridos «visitante anónimo» e «instancia recién instalada» no evaluados por ningún informe.
- **Objetivo A+:** instancia no vacía, rival de práctica, capturas en el README, enlace a las guías de bots existentes, SDK utilizable legalmente.
- **Brecha A+:** T-13 (bots de la casa), T-05 (DOC-10, P3, A (DECISIONES-DIRECTOR)), T-01 (licencia también para los SDK, UX-09), verificación de recorridos T-26.
- **Resto:** DOC-11 quickstart (B → T-51) · notificaciones (C → T-61) · SDK en registros públicos (C → T-71).

### 2.6 Instalación
- **Hoy:** **NOT_READY** (OPS, mantenido; REVISION-TECNICA considera optimista el camino corto que proponía OPS). La guía deja un stack «verde» que no ejecuta batallas: `DOCKER_PROXY_URL` vacío (`docker-compose.yml:308,368`), proxy presentado como «opcional» (`installation.md:46`), firewall sólo enlazado (OPS-01, CONF/M). Plantilla con `TAG=latest`, enlaces muertos y dominio del operador (OPS-04, V-04). Humo que no puede dar verde (TD-020). Orden `up` → `bootstrap` erróneo (OPS-13). Sin requisitos (OPS-05). Proxy compilado como root con un sha de un run de CI (OPS-03). Sin release (OPS-14).
- **Objetivo A+:** una persona ajena instala en Debian 12 limpio, sólo con la documentación, hasta una batalla `finished` (D4).
- **Brecha A+:** T-06 (OPS-04), T-07 (humo + doctor-lite), T-08 (OPS-01/03), T-09 (OPS-01 doc, OPS-05 P1→P2, OPS-13, OPS-09 receta TLS, OPS-15 declaración), T-10 (OPS-14/DOC-05), T-11 (OPS-02), T-22 (medición), T-21 (ensayo por tercero; QA-03 P1→P2, B, ensayo manual en A (DECISIONES-DIRECTOR)).
- **Resto:** `s9ctl` interactivo, ACME, desinstalación, otros SO (C → T-72) · upgrade/rollback (B → T-36).

### 2.7 Administración (día 2)
- **Hoy:** primer admin por SQL; roles por UUID tecleado; sin listado ni baja de usuarios (TD-023, P2 (REVISION-TECNICA D-05)); `needs_review` sólo por SQL; sin guarda de «último admin» (REV-06); sin moderación; recorrido «día 2» no evaluado de forma unificada (REVISION-PRODUCTO §2).
- **Objetivo A+:** crear admin, resetear contraseñas y salir de los dos atascos conocidos sin `psql` improvisado.
- **Brecha A+:** T-11, T-14, T-19; verificación del recorrido «día 2» en T-26.
- **Resto:** T-32 (B), T-43 (B), T-62 moderación (C; **A si registro abierto**), REV-06 (C → T-63).

### 2.8 Backups y recuperación
- **Hoy:** backup restic a almacenamiento externo con evidencia de tercero; poda incondicional (`backup.sh:771`); alertas sólo en perfil `observability` con webhook de relleno (OPS-06, P1); restore manual sin ensayo cronometrado completo desde agosto (OPS-07, P1; TD-025 P1); `postgres` sin `stop_grace_period` (TD-007 P0→P1). **INSUFFICIENT_EVIDENCE** hasta FASE 2.
- **Objetivo A+:** quien no configura backup lo sabe el día 1; un ensayo completo de restore con acta (D12).
- **Brecha A+:** T-07 (aviso), T-20 (ensayo).
- **Resto:** backup completo (B → T-34), `restore-all.sh` (B → T-35). Los P1 de B se declaran en las notas de release.

### 2.9 Streaming
- **Hoy:** READY_WITH_CONDITIONS para V1 operada por el operador; NOT_READY para sesiones largas y V2 (STR, mantenido). Desactivado por defecto. STR-01 (P1→P2 (REVISION-TECNICA), C (DECISIONES-DIRECTOR)); STR-17 sale de A (operación, no producto). V2 es documento (PR #275).
- **Objetivo A+:** **no forma parte del contrato**; se presenta como experimental en D16. La única pieza en A es la señal nocturna (STR-09 = QA-01 → T-17).
- **Resto:** T-60 (C, alcance a decidir por el operador), T-74 (C), T-80 V2 (D).

### 2.10 Documentación
- **Hoy:** **NOT_READY** (DOC). README contradice el estado (DOC-01, P1; V-02); sin LICENSE (DOC-02, P1); roadmap anclado 586 commits atrás (DOC-03, P2); sin capturas (DOC-10); sin SECURITY.md ni plantillas (DOC-06); sin quickstart de bots (DOC-11); ficheros de génesis en la raíz (DOC-07, sin secretos (V-01)).
- **Objetivo A+:** README veraz con limitaciones, licencia, guía de instalación ejecutable, capturas, `current-status` y `known-issues` al día.
- **Brecha A+:** T-01, T-03, T-04 (incluye DOC-03 sólo `current-status`/`known-issues`), T-05, T-09.
- **Resto:** DOC-03 completo + STR-11/12 (B → T-46), DOC-08 (B → T-47), DOC-06 (B → T-48, barato de adelantar), DOC-11 (B → T-51), DOC-12 (C → T-73), DOC-04 (C → T-75), DOC-09 (D → T-83).

### 2.11 Mantenibilidad (pruebas, CI, deuda)
- **Hoy:** READY_WITH_CONDITIONS con matiz (QA): la CI de PR es real (`ci` 44383512640 con golden de registro → build real → batalla → replay, TEST_VERIFIED), pero la nocturna está muerta desde el 2026-08-04 (QA-01 agravado, V-03/V-06), la única prueba de red del sandbox es vacía (REV-01), los mutantes viven fuera de CI (QA-02), hay jobs de staging que dan `success` sin hacer nada (QA-04) y el registro de deuda está desfasado (DOC-03; TD-066 refutada por el código, STR-11).
- **Objetivo A+:** señal nocturna viva, garantías de seguridad citadas con prueba capaz de ponerse roja, un SHA congelable.
- **Brecha A+:** T-17 (QA-01), T-16 (REV-01), gate de T-03.
- **Resto:** QA-03 upgrade (B → T-36), QA-02/05/06/07 + ARQ-02 (C → T-68), QA-04 (E → T-91), DOC-03 (B → T-46).

### 2.12 Preparación para publicar
- **Hoy:** repo público sin licencia; README «no funcional»; 51 PR abiertos, 29 «NO MERGEAR» (DOC-13, cifras de REVISION-TECNICA); nightly rojo visible; zip/docx en la raíz; topología del operador en ficheros rastreados (TD-008 P2, V-04); 0 tags/releases; sin capturas; sin SECURITY.md; sin términos ni privacidad (relevante sólo si se aloja una instancia con registro de terceros).
- **Objetivo A+:** escaparate limpio y coherente (D14), release descargable y verificable (D1), nada de lo publicado expone la instalación del operador (D21).
- **Brecha A+:** T-01, T-02, T-03, T-04, T-05, T-10, T-17; decisión del operador sobre instancia de demostración (si se aloja con registro de terceros, T-49 y T-62 pasan a A).

## 3. Opciones de lanzamiento

### 3.1 Opción A · mínima presentable (estricta)
- **Alcance:** sólo los grupos A que proponían los autores de los informes más lo imprescindible para que «instalar» funcione: licencia, README, plantilla `.env`, guía + `install-host.sh`, release mínima con el bundle, `create-admin`, humo arreglado, requisitos medidos, ensayo de instalación.
- **Qué falta (IDs):** DOC-02, DOC-01/OPS-11, OPS-04, OPS-01, OPS-03 (mínima), OPS-14/DOC-05 (mínima), OPS-02, OPS-05, OPS-13, QA-03 (ensayo manual). Tareas T-01, T-04, T-06, T-07, T-08, T-09, T-10, T-11, T-21, T-22.
- **Riesgos:** sale con **registro abierto por defecto** (SEC-02), **SPA sin cabeceras** (SEC-01), **instancia vacía** sin rival (UX-01), **nightly roja** visible (QA-01), **prueba de aislamiento que no puede fallar** citada como PASS (REV-01), imágenes de servicio sin escanear (TD-031), sin reset de contraseña sin SQL, PR «NO MERGEAR» y ficheros de génesis a la vista. Un revisor externo detecta varios en minutos (`curl -I`, pestaña de PR, badge de CI).
- **Esfuerzo:** suma de estimaciones 10 – 23 días-persona (≈ 2 – 4,6 semanas-persona), incertidumbre media; sin contar FASE 2.
- **Dependencias:** decisión de licencia y de publicación de release; laboratorio para T-21/T-22.
- **Ventajas:** la más corta; cierra el hallazgo más importante de la auditoría (OPS-01).
- **Inconvenientes:** contradice seis arbitrajes vinculantes del director (SEC-01, SEC-02, UX-01, QA-01, REV-01, TD-031); presenta como segura una garantía no probada; la primera impresión (instancia vacía, rojo en CI) desmiente el anuncio.
- **Criterios verificables:** D1, D2, D3 (sin capturas), D4, D5, D15, D16 de [12](12-RELEASE-DEFINITION-OF-DONE.md).

### 3.2 Opción A+ · mínima presentable ampliada (RECOMENDADA)
- **Alcance:** A + seis elementos baratos de B que la hacen presentable (REVISION-PRODUCTO §10) + los arbitrajes del director: modo de registro con invitación por defecto, cabeceras de la SPA, bots de práctica e instancia no vacía, nightly verde, release etiquetada con bundle del proxy, higiene del escaparate con capturas; cambio de contraseña y reset asistido; prueba de aislamiento de red rehecha y medida; escaneo de imágenes de servicio; runbooks de salida; ensayo de restore; verificación de FASE 2. Presentada como **autoalojable v0.x, en español, un solo host Debian 12, streaming experimental, sin correo**.
- **Qué falta (IDs):** todo lo de A más SEC-01, SEC-02, UX-01 + instancia vacía, UX-02/SEC-03 (parte), QA-01/STR-09, REV-01, TD-031/SEC-05 (escaneo), TD-008/SEC-13 (limpieza), DOC-07/ARQ-08, DOC-10, DOC-13, BE-01/BE-02 (runbooks), OPS-06 (aviso), OPS-07 (ensayo). Tareas **T-01 … T-26**.
- **Riesgos:** (1) **REV-01 puede destapar alcanzabilidad real** bot → servicios con credenciales: la remediación (M-L, incertidumbre alta) entraría en el camino crítico; (2) TD-031: remediación UNKNOWN hasta medir; (3) REV-02 y UX-11 pueden subir a A tras FASE 2; (4) arreglar la nightly puede destapar fallos reales ocultos desde agosto; (5) dependencia de una persona ajena y de decisiones del operador; (6) FASE 2 bloqueada mientras la migración de producción siga abierta.
- **Esfuerzo:** suma de estimaciones **19,5 – 52,5 días-persona** de implementación + **3,5 – 9,5** de verificación FASE 2 = **23 – 62 días-persona (≈ 4,6 – 12,4 semanas-persona)**, incertidumbre media; más la remediación que resulte de T-16/T-18/T-25 (UNKNOWN) y las esperas de calendario. REVISION-PRODUCTO daba «~4-6 semanas-persona» con un alcance algo menor (sin REV-01, TD-031 ni FASE 2 como tareas).
- **Dependencias:** decisiones del operador (licencia, registro, streaming, cierre de PR, hosting de demo, publicación de release); laboratorio aislado; cierre de la migración de producción para T-23.
- **Ventajas:** cumple todos los arbitrajes; ninguna afirmación de seguridad sin prueba que pueda fallar; la primera impresión (repo, web, CI) es coherente; deja B como siguiente versión natural.
- **Inconvenientes:** 2-3 veces el esfuerzo de A; más dependencia del laboratorio (cuello de botella único); el usuario aún sin correo ni notificaciones.
- **Criterios verificables:** **D1-D21** completos en [12](12-RELEASE-DEFINITION-OF-DONE.md).

### 3.3 Opción B · pública completa
- **Alcance:** A+ más instalación sencilla (`s9ctl`, doctor completo, upgrade y restore automatizados, ACME), buena UX (estados en español, a11y, gestión de usuarios, notificaciones, aviso de elegibilidad, SDK en registros públicos), documentación sólida (roadmap re-auditado, quickstart, SECURITY.md, referencia API), correo de recuperación, privacidad/términos/baja, moderación, cuotas y aislamiento entre bots, imágenes endurecidas.
- **Qué falta (IDs):** A+ más el grupo B completo (T-30 … T-51: UX-02/SEC-03 email, BE-01/02/03/08, OPS-06/07/08/12, QA-03, SEC-05, REV-02/03/04/05, SEC-14, ARQ-01, UX-03/05/07/08/11, STR-03, DOC-03/06/08/11, STR-11/12, privacidad) y lo que REVISION-PRODUCTO §6 sube a A/B en esta opción desde C: `s9ctl`, OPS-09 ACME, OPS-10, QA-02, QA-04, SEC-06, BE-04, BE-06, BE-07, BE-10, BE-11, UX-06/10, UX-09, notificaciones, DOC-12, moderación, STR-04.
- **Riesgos:** infraestructura de correo nueva (L); entorno de staging real para QA-04; prueba de upgrade N-1 → N con datos; alcance amplio que retrasa la primera presentación y acumula cambios sin señal de usuarios externos.
- **Esfuerzo:** suma de estimaciones A+ (23 – 62) + grupo B (28,5 – 79,5) + elementos subidos desde C (15 – 65) = **66,5 – 206,5 días-persona (≈ 13 – 41 semanas-persona)**, incertidumbre alta (L de correo, M-L de upgrade, L de roadmap y de validación por esquema si se incluye).
- **Dependencias:** A+ cerrada; decisiones de canal de correo, publicación de SDK, hosting y política de registro abierto.
- **Ventajas:** producto que se puede abrir a registro de terceros con recuperación, moderación y obligaciones de privacidad cubiertas.
- **Inconvenientes:** pospone cualquier presentación varias veces el plazo de A+; parte del alcance (notificaciones, SDK publicado) se diseñaría sin feedback de usuarios reales.
- **Criterios verificables:** D1-D21 más: recuperación por correo E2E, upgrade N-1 → N y rollback con acta, doctor completo con alertas recibidas en webhook de laboratorio, usuarios gestionables desde la web, estudio de usabilidad (UX §7.1) con criterios de paso acordados.

### 3.4 Opción C · ampliada (Streaming V2 y visuales)
- **Alcance:** B + Streaming V2 (PR #275, hoy sólo documento con diseño parcialmente caducado), estabilidad de sesiones largas y detección de congelado, color por equipo, fuentes tipo OBS, mejoras visuales (PR #253), soporte de otro SO, editor con resaltado.
- **Qué falta (IDs):** B + STR-14 (XL), visuales (L-XL), STR-01, STR-02 (A en esta opción), STR-05/06/07/13/15/16/17, OPS-15, UX-04, ARQ-01 antes de cualquier subida de motor.
- **Riesgos:** STR-01 exige sesiones de horas en laboratorio con ≥ 4 vCPU; el streaming compite por recursos con el resto del host de producción, que comparte hipervisor; promesa que puede fallar en directo durante el evento de presentación.
- **Esfuerzo:** B (66,5 – 206,5) + **≥ 22,5 días-persona sin cota superior** (XL + L-XL) — no estimable con la información de FASE 1.
- **Dependencias:** B cerrada; decisión de alcance de streaming; capacidad de laboratorio y de producción medida.
- **Ventajas:** demostración visualmente más atractiva y emisiones como funcionalidad.
- **Inconvenientes:** coste sin cota; condiciona la presentación a la parte menos probada del sistema; contradice el arbitraje del director (Streaming V2 y visuales = grupo D, no condicionan).
- **Criterios verificables:** D1-D21 + criterios de B + actas STR T1-T13 (render, emisión local, corte de ingesta, sesión de 8 h con RSS plano, congelado detectado, retardo, spoiler, reinicio).

## 4. Comparación

| | A estricta | **A+ (recomendada)** | B pública | C ampliada |
|---|---|---|---|---|
| Suma de estimaciones (días-persona) | 10 – 23 | **23 – 62** | 66,5 – 206,5 | ≥ 89, sin cota |
| Registro por defecto | abierto | invitación/cerrado | abierto con correo y moderación | ídem B |
| Aislamiento de red probado | no | sí (D17) | sí | sí |
| Señal nocturna | roja | verde N = 7 | verde | verde |
| Instancia nueva con contenido | no | sí | sí | sí |
| Recuperación de cuenta | SQL | reset asistido | correo | correo |
| Streaming | no anunciado | experimental | experimental | funcionalidad |
| Cumple arbitrajes del director | no | **sí** | sí | contradice «V2 = D» |
| Bloqueante dominante | OPS-01/03 | OPS-01/03 + REV-01 + laboratorio | correo, upgrade | V2, sesiones largas |

## 5. Recomendación

**A+**, por cinco motivos:

1. **Es la mínima que no presenta como cierta una garantía no probada.** A estricta saldría con la prueba de aislamiento de red vacía citada como PASS (REV-01, V-07) e imágenes sin escanear (TD-031); el director los arbitró como grupo A (DECISIONES-DIRECTOR).
2. **Protege a terceros por defecto con coste bajo.** Registro por invitación (M), cabeceras (S) y reset asistido (S-M) cierran lo que expone a quien instala; el correo y la moderación sólo son imprescindibles si se abre el registro, cosa que A+ no hace.
3. **La primera impresión es coherente.** README veraz, licencia, capturas, instancia con bots de práctica, CI nocturna verde y PR limpios: todo S o M (REVISION-PRODUCTO §5.2).
4. **Mantiene B como siguiente paso natural** y no condiciona el lanzamiento a Streaming V2 ni a visuales (grupo D), ni a automatizaciones de restore/upgrade (B), que se declaran como limitaciones (D16).
5. **Su riesgo principal es conocido y acotable:** la medición de FASE 2 (T-16, T-18, T-25) puede ampliar el alcance; por eso FASE 2 va en F0, antes de comprometer el plan de F1 ([14](14-RELEASE-DELIVERY-PLAN.md)).

Condición de la recomendación: si el operador decide **alojar una instancia pública con registro abierto a terceros**, A+ incorpora T-49 (privacidad, términos, baja), T-62 (moderación) y, según la medición, T-38 (cuotas). Esa decisión se toma en F0, antes de fijar el alcance de F1.

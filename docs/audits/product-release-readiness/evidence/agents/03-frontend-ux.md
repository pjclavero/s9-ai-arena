> Anexo de trazabilidad: informe de trabajo original, saneado para publicación (rutas locales sustituidas por marcadores y sección de anexo privado retirada; estaba vacía). Las severidades y grupos **finales** son los de los documentos 01-15, no los de este informe.

# Agente 3 · Frontend, UX y experiencia de jugador

- Repo: pjclavero/s9-ai-arena · HEAD verificado: 8f380eb700c3e984691649b3449d2c543038dfb1 (`git -C <árbol-auditado@8f380eb> rev-parse HEAD`)
- Fecha: 2026-11-19 · Prefijo: UX-
- Alcance: lectura estática de `apps/web/src` (App, pages, help, errors, bot-templates, index.html), `apps/web/tests`, `tests/browser/specs/a11y-basics.spec.ts`, `docs/user`, `docs/overview`, `docs/roadmap/{known-issues,technical-debt}.md`.
- NO se pudo mirar: render real, contraste medido, lector de pantalla, móvil real, rendimiento del visor, comportamiento de la API detrás de cada pantalla, ejecución de los tests/axe (todo FASE 2). Ningún punto de este informe es TEST_VERIFIED (no se citan runs de CI).

## 1. Resumen (veredicto: READY_WITH_CONDITIONS)

1. El frontend es un panel SPA por hash (`App.tsx`) con carcasa única, 404 propio, error boundary global y por pantalla, y recursos con carga/error/reintento. CODE_VERIFIED.
2. El onboarding es sólido para un SPA de este tamaño: portada con «qué es» y pasos (`HomePage.tsx:LandingIntro`), checklist de 9 pasos con estado real de la API, glosario, Centro de Ayuda con SDK, observaciones, comandos y equipamiento dentro de la web. CODE_VERIFIED.
3. Un novato SÍ puede llegar a una primera batalla sin conocer el juego, pero con mucha fricción: ≥8 etapas y ~20-30 interacciones, y hay que crear DOS bots publicados (no hay rival de práctica/sparring en la UI). Estimación por código, no medida.
4. Bloqueos principales: (a) el único rival posible es otro bot publicado de verdad; (b) no existe recuperación de contraseña ni 2FA/sesiones en la web (known-issues, verificado); (c) el editor de código es un `<textarea>` sin resaltado ni prueba local en navegador; (d) el simulador local exige clonar el repo, Node 22 y `pip install -e` (SDK no instalable desde un índice público según la doc).
5. Terminología mezclada: estados de versión en inglés crudo (`draft`, `validated`, `published`, `frozen`) junto a texto en español; se justifica con glosario pero sigue siendo inconsistente. Loadout/runtime/build/artifact/ruleset sin traducir.
6. Accesibilidad: base trabajada (skip link, focus-visible, `aria-live`, axe en CI de navegador con 2 excepciones registradas). Defectos: `aria-label` con slugs técnicos («nuevo-bot», «rol-userid»), tema único oscuro sin `prefers-reduced-motion` ni `prefers-color-scheme`, canvas del visor sin alternativa textual completa (PARTIAL).
7. Administración: Roles por UUID tecleado; Ruleset de torneos como texto libre con valor `mvp-default`; usuarios sin listado/baja (TD-023).
8. Idioma: sólo español, cadenas incrustadas en componentes; sin capa i18n. Para público internacional es DEUDA, no bloqueo.
9. Veredicto: usable por un jugador paciente con ayuda de la guía; NO verificado en uso real. Pasa a READY sólo tras FASE 2 (guion en §7).
10. Top-3 mejoras por impacto/esfuerzo: rival de práctica predefinido (UX-01), recuperación de contraseña (UX-02), nombres accesibles + ruleset como selector (UX-05/UX-07).

## 2. Matriz del área

| Elemento | Estado real | Evidencia | Qué falta | Prio | Esf. | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Portada / qué es S9 | Existe, texto claro | `HomePage.tsx:LandingIntro`, `help/content.ts` WHAT_IS_S9 | Sin captura/vídeo del juego; sin ejemplo visual | P3 | S | No |
| Registro/login | Validación local, mensajes en español, 2FA en login | `LoginPage.tsx` | Sin recuperar contraseña ni «Mi cuenta» | P1 | M | Condicional (ver UX-02) |
| Checklist primeros pasos | Estado real de la API, 9 pasos | `HomePage.tsx:computeFirstSteps` | Mide sólo primeros 10 bots (documentado) | P4 | S | No |
| Ayuda / SDK / API del bot | En la web, versión del SDK mostrada, avisa de desajuste | `help/sections/bots.tsx`, `help/tree.ts` | Enlaces a GitHub (`DOC_LINKS`) para SDK/ejemplos: salen de la web | P3 | S | No |
| Editor de código | `<textarea>` 16 filas, plantilla Py/JS que funciona, borrador recuperable | `BotsPage.tsx:1057` | Sin resaltado, sin autocompletado, sin «probar ahora» | P2 | L | No |
| Loadout/munición | Munición elegida explícitamente; ayuda de munición y elegibilidad existe | `LoadoutEditor.tsx:10,195`, `help/tree.ts` equipamiento, `version-eligibility.tsx` | Explicación de «publicada ≠ elegible» sólo tras fallo (HIPÓTESIS, FASE 2) | P2 | M | No |
| Build/validación | Diagnóstico con fichero/motivo y botones Corregir/Reenviar | `build-diagnosis.tsx:185-206` | Estados crudos en inglés | P3 | S | No |
| Nueva batalla | Checks previos con motivos, elegibilidad explicada | `BattleNewPage.tsx:422,509` | Sin rival de práctica | P1 | M | No |
| Torneos | Estados/formatos traducidos; elegibilidad con motivo | `TournamentsPage.tsx`, `tournament-entry.ts` | Ruleset texto libre | P2 | S | No |
| Ranking/replays/visor | Públicos, cámara/zoom con aria | `theater.tsx`, `ReplayPage.tsx:362` | Alternativa textual del canvas; teclado del visor no verificado | P2 | M | No |
| Móvil | Menú plegable ≤1024 px, tablas «stack» | `App.tsx:ShellNav`, `index.html` @media | No verificado en dispositivo | P2 | S | No |
| Administración | 4 pantallas con subnavegación | `admin-nav.tsx`, `RolesPage.tsx` | UUID manual; sin usuarios/backup/readiness (TD-023) | P2 | M | No |
| i18n | Sólo ES, cadenas en JSX | `index.html lang="es"` | Capa i18n | P4 | XL | No |

## 3. Fortalezas (con evidencia)
- Una sola carcasa y nav (`App.tsx:shell`), 404 anclado, alias `#/ayuda`, `#/docs`. CODE_VERIFIED.
- Errores clasificados en una sola función (`errors.ts:describeApiError`: validación, permisos, 404, conflicto, 5xx, plazo, red, 429 con Retry-After); evita «[object Object]». CODE_VERIFIED.
- Checklist con estado real, no flags locales (`HomePage.tsx:1-12`). CODE_VERIFIED.
- Plantillas de bot con pruebas contra el motor real (`bot-templates.ts` cabecera; CI: no verificado el run). DOC_ONLY para la parte CI.
- Pruebas de accesibilidad en navegador real con axe y 2 excepciones nominadas (`tests/browser/specs/a11y-basics.spec.ts:KNOWN`). Que exista no lo hace TEST_VERIFIED; podría ponerse rojo si aparece una infracción critical/serious fuera de KNOWN.
- Borradores recuperados tras sesión caducada (`ui/draft.ts`, aviso en `BotsPage`). CODE_VERIFIED.

## 4. Debilidades
Ver hallazgos. Resumen: sin rival de práctica, sin recuperación de cuenta, editor básico, jerga/estados en inglés, nombres accesibles técnicos, administración por UUID, ruleset libre.

## 5. Hallazgos

### UX-01 · No hay rival de práctica: la primera batalla exige dos bots publicados propios (o ajenos)
- Área: Onboarding/Batallas · P1 · FALTA · Grupo B
- Descripción: la guía pide crear, equipar, validar y publicar un SEGUNDO bot (`JOURNEY.secondBot`; `getting-started.md` paso 6). `BattleNewPage` rechaza el mismo bot en ambos bandos (`:422`, `:509`). El `grep` de «sparring/rival de prueba/oficial» en la página sólo encuentra el aviso «no son oficiales» y no hay bot-sparring en la UI. Un novato duplica todo el trabajo antes de ver nada. Aunque la validación usa un rival de prueba interno, no se ofrece en batallas de práctica.
- Evidencia: `help/content.ts:JOURNEY`, `BattleNewPage.tsx:422,509`, `docs/user/getting-started.md:#6`. CODE_VERIFIED (la ausencia, por grep; confirmar en lab).
- Solución: bots «sparring» de la plataforma (idle/hunter/circle, ya existen en el simulador) elegibles como rival, o botón «Probar contra un bot de práctica» en la ficha de la versión validada.
- Esfuerzo: M (media: depende de cómo modele la API un bot de sistema). Dependencias: Agente de API/batallas. Validación: usabilidad §7.

### UX-02 · Sin recuperación de contraseña, 2FA ni sesiones en la web
- Área: Cuentas · P1 (reclasificada: en known-issues figura como limitación; para lanzamiento público lo subo a P1) · DEFECTO_CONFIRMADO · Grupo B
- Descripción: una persona que olvida la contraseña no puede volver; el 2FA existe en login pero no hay pantalla para activarlo. La API tiene operaciones pero `/auth/recover` descarta el token (no hay canal de envío).
- Evidencia: `known-issues.md:23,61`; `git grep -nE "auth/(2fa|sessions|recover|reset)" -- apps/web/src` vacío según known-issues (no re-ejecutado por mí; revisado `LoginPage.tsx`: sin enlace «Olvidé mi contraseña»). TD previo: ABIERTA (≈P2, UX). Nueva: P1 si el lanzamiento es público con usuarios reales.
- Solución: canal de correo + pantalla; «Mi cuenta». Esfuerzo L, incertidumbre media (correo). Dependencias: infra de email.

### UX-03 · Estados y jerga en inglés crudo mezclados con español
- P3 · DEUDA · Grupo C
- `BotsPage.tsx:1126,1315` pinta `v.state` literal (`draft`, `validated`…); también «Frozen / Inmutable», «runtime», «build», «loadout», «artifact», «ruleset», «smoke»; en help «partida de humo». El glosario lo explica (`content.ts` cabecera), pero el novato ve dos idiomas en la misma fila. Solución: mapa de etiquetas con el término técnico entre paréntesis (ya existe `TOURNAMENT_STATE_NAME` para torneos: replicar para versiones). Esfuerzo S.

### UX-04 · El editor de código es un textarea sin ayuda
- P2 · FALTA · Grupo C
- `BotsPage.tsx:1057` (`<textarea rows=16 cols=80>`), sin resaltado, números de línea ni autocompletado; los errores de validación citan fichero y línea (`build-diagnosis.tsx`) pero el editor no permite ir a una línea. Un novato programa a ciegas hasta «Enviar a validación». Solución: CodeMirror ligero y salto a línea desde el diagnóstico. Esfuerzo M-L. Incertidumbre media (peso del bundle). No pegado de varios ficheros: sólo uno (`src/bot.py|js`, `help/sections/bots.tsx:~200`); proyectos multifichero requieren API directa: HIPÓTESIS a verificar.

### UX-05 · `aria-label` con identificadores técnicos y sustitución del nombre visible
- P3 · DEFECTO_CONFIRMADO · Grupo B
- 26 `aria-label` en minúsculas tipo slug: «nuevo-bot», «nuevo-equipo», «codigo» (sin tilde), «version-visor», «diff-contra», «rol-userid», «rol-roles», «archivo-mapa». `aria-label` anula el texto del `<label>` visible (p. ej. «Nombre del bot» → «nuevo-bot»); un usuario de lector de pantalla oye el slug (SC 2.5.3 Label in Name, 4.1.2). Muchos son selectores de tests. Solución: usar el `<label>` real y `data-testid` para tests. Esfuerzo S (cambia tests). Evidencia: `grep -rhoE 'aria-label="[a-z0-9-]+"' apps/web/src`. CODE_VERIFIED.

### UX-06 · Tema único oscuro, sin reduced-motion ni modo claro; contraste no medido
- P3 · RIESGO · Grupo C
- `index.html` fija fondo `#10141a` y texto `#9aa4b2` en secundarios; ninguna regla `prefers-reduced-motion`/`prefers-color-scheme`/`prefers-contrast` (grep). El visor Phaser anima sin opción de reducirlo. Contraste: HIPÓTESIS (#9aa4b2 sobre #10141a ronda ≈7:1 por cálculo mental, no medido). Verificar en FASE 2 con axe color-contrast (axe de CI usa WCAG A/AA 2.0/2.1).

### UX-07 · Ruleset de torneo como texto libre
- P2 · DEFECTO_CONFIRMADO · Grupo B
- `TournamentsPage.tsx:150-152`: `<input aria-label="ruleset" value="mvp-default">`. Un organizador teclea un id interno; un error devuelve el mensaje crudo de la API (`:74` `(err as Error).message`, sin `describeApiError`). Solución: `<select>` alimentado por la API de rulesets (ya usada en `BattleRulesPicker`) y `FormError`. Esfuerzo S. Relacionado: TD «web crea torneos con mapPool: []» (`technical-debt.md:492`).

### UX-08 · Administración por UUID tecleado y sin gestión de usuarios
- P2 · DEUDA · Grupo C. `RolesPage.tsx` pide `rol-userid` por texto; `known-issues.md:46` / TD-023: sin listado/baja de usuarios ni estado de backup. Prioridad TD-023 anterior: P2; la mantengo. Esfuerzo M.

### UX-09 · Documentación fuera de la web y SDK sólo desde el repo
- P2 · RIESGO · Grupo B. `DOC_LINKS` apunta a GitHub; las instrucciones locales exigen `git clone`, `npm install`, Node 22 y `pip install -e "sdks/python[dev]"` (`probar.md`, `help/sections/bots.tsx:181`). Para quien no usa git es un muro. El repo público actualmente sin LICENSE (contrato) hace dudar de si se pueden usar los SDK/ejemplos. Solución: publicar SDK en PyPI/npm (decisión de producto), o descargable «starter kit» desde la web. Esfuerzo M-L. Dependencias: Agente de licencia/seguridad.

### UX-10 · Visor/replay: alternativa textual y teclado no verificados
- P2 · HIPÓTESIS. Hay controles con nombre (`theater.tsx:169-197`, `ReplayPage.tsx:362`) y KNOWN registra un slider sin nombre (`a11y-basics.spec.ts:KNOWN`; puede ya estar corregido: el `aria-label` existe en `ReplayPage.tsx:362`, es decir la entrada KNOWN podría estar obsoleta y ocultando un test que ya no hace falta). El canvas no ofrece narración de eventos al lector de pantalla (hay `aria-live` para el modo de cámara únicamente). Verificar en FASE 2.

### UX-11 · Elegibilidad («publicada pero no elegible») explicada sólo en el momento del fallo
- P2 · HIPÓTESIS · Grupo B. El estado `published` se presenta como «puede combatir» (glosario `estados`), pero `isBattleEligible` puede bloquear una publicada (`BattleNewPage.tsx:135-173`, `version-eligibility.tsx`; incidencia RC5.4 «publicada≠elegible»). La ficha de versión del bot lo muestra o no: no verifiqué si `BotsPage` avisa antes de intentar crear la batalla. Probar en FASE 2.

## 6. Deuda técnica (revalidación)
- TD-022 Errores y estados web: MEJORADA; confirmo (errors.ts, ResourceView, ErrorBoundary, 404). Mantengo P2 ya mejorada; residual: UX-07 (mensaje crudo en torneos) y fallbacks TD-049 (P3, ABIERTA, no revalidado).
- TD-023 Admin operativa invisible en web: P2 → sigue P2 (UX-08).
- TD «Equipos: bot asignado sólo al crear» (`technical-debt.md:383-396`): no re-verificado; afecta a «gestiona tu equipo desde la web».
- Mapas: editor «no persiste en servidor» (`technical-debt.md:359`): no re-verificado (línea de MapEditorPage); FASE 2.
- known-issues recuperación de contraseña: ver UX-02 (sube a P1 para lanzamiento público).
- Deuda nueva no registrada: UX-01 (rival de práctica), UX-05 (aria-label slugs), UX-06, UX-07, UX-09.

## 7. Verificaciones para FASE 2

### 7.1 Guion de prueba de usabilidad en laboratorio (entorno: lab aislado, datos de prueba, NUNCA producción)
Participantes: 5-8 personas, 2 perfiles (programadora/or con Python o JS que no conoce el juego; persona no programadora para prueba de comprensión del texto de portada). Sin explicación previa; se les da sólo la URL del laboratorio y la tarea «consigue ver a tu bot luchar». Pensar en voz alta, grabación de pantalla, cuenta nueva por participante.
Tareas cronometradas (cada una con límite de 15 min y criterio de abandono):
1. T0 Explica con tus palabras qué es el juego tras 60 s en la portada (comprensión).
2. T1 Registrarse y entrar.
3. T2 Crear el primer bot.
4. T3 Equiparlo (loadout válido con arma y munición).
5. T4 Subir código (plantilla o propio) y enviarlo a validación; si falla, corregir.
6. T5 Publicar; crear segundo bot/versión.
7. T6 Lanzar una batalla y verla en directo y en replay.
8. T7 Inscribirse en un torneo de laboratorio y localizar el ranking.
9. T8 (variante) Forzar un error: validar código con import prohibido y una versión «no elegible» y observar si entienden y se recuperan.
10. T9 (admin, perfil aparte) cambiar un rol, crear un mapa/torneo/ruleset, configurar streaming.
Qué medir: tasa de éxito por tarea sin ayuda; tiempo por tarea (mediana y p90); nº de clics y de visitas a Ayuda; errores y retrocesos; puntos de abandono; mensajes de error leídos y si entienden la acción siguiente (0-2); SUS (System Usability Scale) y SEQ por tarea; uso de teclado puro en una sesión (T1-T4); lector de pantalla (NVDA/VoiceOver) en T1-T3; móvil real (T0, T1, T6 visor) en 2 dispositivos; confusión terminológica (anotar cada vez que preguntan por draft/runtime/loadout/ruleset/elegible).
Criterios de paso sugeridos (a acordar, no medidos hoy): ≥80 % completa T0-T6 sin ayuda externa; mediana a primera batalla fijada tras la primera ronda; 0 bloqueos sin salida en T4/T8.

### 7.2 Pruebas técnicas
| Verificación | Entorno | Comando/prueba | Confirma / refuta |
|---|---|---|---|
| axe completo + KNOWN obsoletas | lab | `tests/browser` @fase1 a11y-basics (run.sh del repo) | 0 critical/serious fuera de KNOWN; si pasa quitando KNOWN, UX-10 se cierra |
| Contraste | lab | axe `color-contrast` + muestreo manual | refuta/confirma UX-06 |
| Recorrido E2E real | lab | Playwright `onboarding.spec.ts` + contar pasos | cuenta real de interacciones UX-01 |
| Móvil | lab | viewport 375 px + dispositivo real | nav, tablas stack, visor |
| Teclado del visor/mapa | lab | tab+flechas manuales | UX-10 |
| ¿Warning de no elegibilidad antes de batalla? | lab | versión publicada no elegible, abrir ficha y Nueva batalla | UX-11 |
| Multi-fichero | lab | subir paquete con más de un fichero | UX-04 |

## 8. Respuestas
- ¿Puede usarlo quien no conoce el juego? Probablemente sí con paciencia (portada, checklist, ayuda con nombres reales de botones). No verificado con personas.
- ¿Dónde se queda bloqueada? (1) segundo bot obligatorio; (2) rechazo de validación sin entender el código; (3) «publicada» pero no elegible; (4) contraseña olvidada; (5) instalación local del SDK; (6) jerga mixta.
- Pasos «primer bot → primera batalla» según el código: checklist de 9 hitos (`JOURNEY`: cuenta, bot, loadout, código, validar, publicar, segundo bot, equipo[opcional], batalla); sin contar el equipo, 8. Interacciones estimadas ≈20-30 (crear x2 bots, ~8 selecciones de loadout x2, subir x2, validar x2, publicar x2, formulario de batalla ~6 campos). Estimación, no medida.
- 10 mejoras impacto/esfuerzo: 1) rival de práctica (UX-01); 2) recuperar contraseña (UX-02); 3) selector de ruleset + `describeApiError` en torneos (UX-07, S); 4) `aria-label` reales (UX-05, S); 5) etiquetas ES de estados de versión (UX-03, S); 6) salto a línea del error en el editor + resaltado (UX-04); 7) aviso de elegibilidad en la ficha de versión (UX-11); 8) «starter kit» o SDK en índice público (UX-09); 9) selector de usuario en Roles (UX-08); 10) revisar KNOWN a11y y añadir `prefers-reduced-motion` (UX-06/10).

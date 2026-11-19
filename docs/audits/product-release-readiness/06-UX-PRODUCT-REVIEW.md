# 06 · Revisión de experiencia de usuario y de producto

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Propósito: describir qué vive cada tipo de usuario (jugador, programador de bots, administrador, visitante anónimo) desde que llega hasta que obtiene valor, dónde se bloquea y qué mejorar primero. Informe de síntesis: [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md).

Convenciones: severidad y grupo finales según las revisiones y los arbitrajes del director; «P1→P2 (REVISION-TECNICA)» indica una severidad ajustada por la revisión técnica; «(DECISIONES-DIRECTOR)» indica un arbitraje. Nada de lo que sigue está medido con personas ni en un navegador: es lectura de código (`CODE_VERIFIED`) o hipótesis marcadas. Los esfuerzos son estimaciones de los informes de origen.

Fuentes: informe 03 (frontend/UX), informes 04 y 07 (instalación, documentación), REVISION-TECNICA, REVISION-PRODUCTO, DECISIONES-DIRECTOR y V-05.

## 1. Veredicto de la dimensión UX

**READY_WITH_CONDITIONS para jugadores que ya están dentro; INSUFFICIENT_EVIDENCE para «presentar»** (nadie ha visto el producto con una persona real ni como visitante anónimo).

1. El frontend es un panel SPA coherente (carcasa única, 404 propio, errores clasificados, estados de carga/error/reintento, checklist de primeros pasos con estado real de la API). `CODE_VERIFIED` (informe 03).
2. Un novato puede llegar a una primera batalla, pero tras ≥8 hitos y unas 20-30 interacciones (estimación por código, no medida) y **creando dos bots**: no hay rival de práctica (UX-01).
3. Una instalación nueva está **vacía**: sin bots, sin replays públicos (apagados por defecto), ranking vacío. Esto no lo trató ningún informe de especialista; lo añade REVISION-PRODUCTO (UX-12).
4. El ciclo de vida de la cuenta está incompleto: sin recuperación, sin cambio de contraseña, sin baja, sin pantallas de 2FA/sesiones (UX-02, UX-14).
5. No existe ninguna notificación (build terminado, batalla jugada, torneo cerrado): hay que volver y mirar (UX-13).
6. El programador de bots tiene SDK y ejemplos reales, pero sólo desde el repositorio (clonar, Node 22, `pip install -e`), sin licencia y con editor `textarea` (UX-04, UX-09, DOC-11).
7. El administrador del día 2 (usuarios, roles, jobs aparcados, moderación) opera por UUID tecleado, SQL o CLI (UX-08, BE-02, UX-15).
8. Accesibilidad: base trabajada (skip link, `aria-live`, axe en CI de navegador con 2 excepciones registradas) con defectos concretos (UX-05, UX-06, UX-10). Idioma: sólo español (DOC-09).
9. Ningún hallazgo UX es P0. Tras las revisiones: 0 P1 firmes (UX-02 es P1 sólo si se abre el registro a externos), 7 P2, resto P3 o hipótesis.
10. Recomendación: la mejora de mayor retorno es una instancia que ya tenga rivales de práctica (UX-01 + UX-12) y un reset de contraseña asistido por el administrador (UX-02), ambas en grupo A (§8).

## 2. Resumen de hallazgos UX

| ID | Título | Sev. final | Grupo final | Evidencia | Origen |
|---|---|---|---|---|---|
| [UX-01](#ux-01) | Sin rival de práctica | P2 (P1→P2, REVISION-TECNICA) | A forma barata (DECISIONES-DIRECTOR) | `CODE_VERIFIED` (ausencia por grep) | 03 |
| [UX-02](#ux-02) | Sin recuperación ni cambio de contraseña | P1 si registro abierto / P2 si invitación (REVISION-TECNICA D-01) | A: cambio + reset asistido; email B (DECISIONES-DIRECTOR) | `CODE_VERIFIED` | 03, 05 (SEC-03) |
| [UX-03](#ux-03) | Estados y jerga en inglés | P3 | B (C→B, REVISION-PRODUCTO) | `CODE_VERIFIED` | 03 |
| [UX-04](#ux-04) | Editor `textarea` sin ayuda | P2 | C | `CODE_VERIFIED` | 03 |
| [UX-05](#ux-05) | `aria-label` con slugs técnicos | P3 | B | `CODE_VERIFIED` | 03 |
| [UX-06](#ux-06) | Tema único, sin reduced-motion; contraste no medido | P3 | C | `CODE_VERIFIED` + hipótesis | 03 |
| [UX-07](#ux-07) | Ruleset de torneo como texto libre | P2 | B | `CODE_VERIFIED` | 03 |
| [UX-08](#ux-08) | Administración por UUID, sin gestión de usuarios | P2 | B (C→B, REVISION-PRODUCTO) | `CODE_VERIFIED` | 03 |
| [UX-09](#ux-09) | SDK y documentación sólo desde el repo | P2 | B (A: quickstart o starter kit) | `CODE_VERIFIED` | 03 |
| [UX-10](#ux-10) | Visor/replay: alternativa textual y teclado | P2 hipótesis | C | `UNKNOWN` | 03 |
| [UX-11](#ux-11) | «Publicada» pero no elegible, avisado tarde | P2 hipótesis | B (A si FASE 2 lo confirma) | `UNKNOWN` | 03 |
| [UX-12](#ux-12) | Visitante anónimo e instancia recién instalada vacíos | P2 (propuesta) | A | `CODE_VERIFIED` | REVISION-PRODUCTO §2 |
| [UX-13](#ux-13) | Sin notificaciones | P3 (propuesta) | B | `CODE_VERIFIED` (ausencia) | REVISION-PRODUCTO §2 |
| [UX-14](#ux-14) | Sin baja de cuenta, privacidad ni términos | P2 (propuesta) | B; A si hay instancia pública con registro de terceros | `CODE_VERIFIED` | REVISION-PRODUCTO §2 |
| [UX-15](#ux-15) | Sin moderación de contenido público | P2 (propuesta) | C; A si registro abierto con ranking público | `UNKNOWN` | REVISION-PRODUCTO §2 |
| [UX-16](#ux-16) | Bucle «mi bot pierde: ¿por qué?» no evaluado | HIPÓTESIS | sin grupo hasta FASE 2 | `BLOCKED (FASE 2)` | REVISION-PRODUCTO §2 |

Nota de IDs: UX-12 a UX-16 no existían en el informe 03. Se les asigna ID en esta consolidación para poder trazarlos; su severidad es una propuesta de la consolidación, no un arbitraje de las revisiones, salvo donde se indica el grupo (REVISION-PRODUCTO).

## 3. Recorrido del jugador, de la llegada al replay

Fuentes: `HomePage.tsx` (portada y checklist), `help/content.ts` (`JOURNEY`), `docs/user/getting-started.md`, `BattleNewPage.tsx`. El recuento es estimado por código, no medido (`S12`/guion §10 lo medirá).

| # | Etapa | Qué ve / hace el jugador | Dónde puede bloquearse un novato | Hallazgo |
|---|---|---|---|---|
| 0 | Llega a la web | Portada con «qué es S9» y pasos; sin capturas ni vídeo | No ve ningún combate. En instalación nueva: ranking vacío y replays públicos apagados por defecto (`infrastructure/.env.example:128-133`) | UX-12, DOC-10 |
| 1 | Registro / entrada | Formulario con validación local y mensajes en español | Si el operador cierra el registro (recomendado en A+), **no existe aún mecanismo de invitación**: la persona no puede entrar | SEC-02, UX-12 |
| 2 | Primeros pasos | Checklist de 9 hitos con estado real de la API | Mide sólo los primeros 10 bots (documentado, P4) | — |
| 3 | Crear bot | Alta de bot | Nombre libre, sin guía de nomenclatura | UX-15 |
| 4 | Equipar (loadout) | Selección de chasis, arma y **munición explícita** | Muchas selecciones por bot; jerga (loadout, runtime) | UX-03 |
| 5 | Escribir/subir código | `textarea` con plantilla Py/JS funcional; borrador recuperable tras sesión caducada | Programar a ciegas: sin resaltado ni salto a línea; un solo fichero | UX-04 |
| 6 | Validar | Diagnóstico con fichero/motivo y botones Corregir/Reenviar | Estados crudos en inglés; si falla y el usuario se va, **nadie le avisa** | UX-03, UX-13 |
| 7 | Publicar | Estado `published` | «Publicada» ≠ «elegible para combatir»; se descubre al fallar | UX-11 |
| 8 | Segundo bot | La guía exige repetir 3-7 con otro bot | **Principal muro**: duplica el trabajo antes de ver nada. En instancia nueva no hay bots ajenos que sirvan de rival | UX-01 |
| 9 | Nueva batalla | Formulario ~6 campos; el mismo bot no puede estar en ambos bandos (`BattleNewPage.tsx:422,509`) | Mensajes de elegibilidad con motivo (bien); cola compartida con torneos | UX-11, REV-03 |
| 10 | Ver en directo | Visor Phaser con cámara/zoom | Replay y espectador públicos dependen de capabilities apagadas por defecto | UX-12, UX-10 |
| 11 | Replay | Reproducción desde la ficha de batalla | Replays antiguos de otra versión de formato sin explicación (STR-03) | STR-03 |
| 12 | Después | Ranking, torneos | Sin aviso de que acabó nada | UX-13 |

Estimación del informe 03 (no medida): sin contar el equipo, 8 hitos de `JOURNEY`; unas 20-30 interacciones (2 bots × [crear + ~8 selecciones de loadout + subir + validar + publicar] + formulario de batalla).

Mitigación existente, **sólo para el operador**: `cli.ts demo-teams` (V-05) crea equipos de 3 bots para un usuario ya existente, en `draft`, por CLI de administración (`apps/api/src/db/cli.ts:10,70`). No da rival de práctica al jugador desde la web; tampoco pasa por el pipeline de publicación.

## 4. Recorrido del programador de bots

| Aspecto | Estado real | Evidencia | Hueco |
|---|---|---|---|
| API | OpenAPI 0.25.0 con 106 operaciones; `docs/technical/api.md` (279 líneas) | informe 07 | Sin referencia renderizada publicada (DOC-12, P3, C) |
| SDK | JS (`sdks/javascript`) y Python (`sdks/python/arena_sdk`) reales; .NET y Java son sólo README | `ls sdks` @8f380eb | No publicados en un registro; sin LICENSE; directorios casi vacíos sin rotular (UX-09) |
| Ejemplos | `example-bots/` y `docs/user/bots/examples`; 12 páginas de guía de bots | informe 07 | Sin quickstart de 5 minutos enlazado desde el README (DOC-11) |
| Pruebas locales | Simulador local `local-simulator.ts` (JS); `docs/user/bots/probar.md` | informe 07 | Requiere `git clone`, `npm install`, Node 22 y `pip install -e "sdks/python[dev]"`. Si el simulador local existe también para Python: `UNKNOWN` |
| Editor web | `textarea` de 16 filas, un fichero | `BotsPage.tsx:1057` | Sin resaltado, línea ni autocompletado (UX-04). Proyectos multifichero: hipótesis a verificar |
| Depuración | La ficha de batalla muestra rechazos, CPU y salida del contenedor (según cabecera, sin uso real) | REVISION-PRODUCTO §2 | No evaluado: UX-16 |
| Avisos | Validación fallida explicada en pantalla | `build-diagnosis.tsx` | Sin notificación fuera de la web (UX-13) |
| Licencia | Repo público sin LICENSE | DOC-02 | Un programador no puede usar legalmente SDK ni ejemplos; [DOC-02](10-DOCUMENTATION-AUDIT.md#doc-02) |

### UX-09 vs DOC-11: qué es A y qué es B
Para A basta un quickstart claro (DOC-11) o un «starter kit» descargable; publicar el SDK en PyPI/npm es decisión de producto (B).

## 5. Recorrido del administrador

### Día 1 (instalar y dejar listo)
La instalación y el primer administrador se tratan en [07-INSTALLATION-OPERATIONS.md](07-INSTALLATION-OPERATIONS.md) ([OPS-02](07-INSTALLATION-OPERATIONS.md#ops-02)). Desde la perspectiva UX falta, tras instalar, comprobar que «se puede jugar» sin escribir código (UX-12, [OPS-12](07-INSTALLATION-OPERATIONS.md#ops-12)).

### Día 2 (operar)
| Situación | Qué hay hoy | Hueco | Referencia |
|---|---|---|---|
| Un usuario no puede entrar | Nada en la web; el operador escribe un hash por SQL | Reset asistido y auditado | UX-02 |
| Asignar un rol | Pantalla Roles pide el UUID del usuario tecleado | Selector de usuarios | UX-08 |
| Ver usuarios, suspender, dar de baja | Sin listado ni baja | TD-023 | UX-08, UX-14 |
| Un job queda en `needs_review` | Sólo visible por SQL | Superficie operativa | BE-02 (P1→P2, REVISION-TECNICA) |
| Torneo `closed` atascado | Sin salida desde la web | Cancelación administrativa | BE-01 (P1→P2, REVISION-TECNICA; A mínimo, DECISIONES-DIRECTOR) |
| Dejar la instalación sin admin | `PUT /users/{id}/roles` lo permite | Guarda «último admin» | REV-06 (P3) |
| Nombre ofensivo en el ranking | No evaluado | Renombrar/ocultar | UX-15 |
| Backup / readiness | Sólo CLI | Estado en la web | TD-023 |
| Crear un torneo | `ruleset` como texto libre, `mapPool: []` desde la web | Selector y errores claros | UX-07 |

## 6. Visitante anónimo e instancia nueva

<a id="ux-12"></a>
### UX-12 · Visitante anónimo e instancia recién instalada vacíos
- Severidad: P2 (propuesta de consolidación) · Grupo: A (REVISION-PRODUCTO §3) · Tipo: FALTA · Evidencia: `CODE_VERIFIED` (revisor de producto)
- Descripción: sin sesión hay ayuda, ranking, visor/directo y replays como rutas públicas (`App.tsx:254-275`), pero replays y espectador públicos están **apagados por defecto** (`infrastructure/.env.example:128-133`; SEC §9). En una instalación nueva el anónimo ve una portada con texto, un ranking vacío y replays que dan 404. `bootstrap` crea reglas, catálogo y mapas, pero **ningún bot**; `demo-teams` crea sólo borradores y exige un usuario existente (`apps/api/src/db/seeds/demo-teams.ts:1-17`). Impacto: quien evalúa el producto no ve un combate.
- Solución: bots de la casa publicados por `bootstrap` tras pasar el sandbox (nada de estados fabricados), uno o dos replays públicos curados en la instancia de presentación y, para el README, 2-4 capturas o un GIF ([DOC-10](10-DOCUMENTATION-AUDIT.md#doc-10)). Esfuerzo S-M, incertidumbre media (depende de cómo modele la API un bot de sistema).
- Dependencias: UX-01, SEC-02 (el modo de registro decide si la persona puede entrar).
- Validación: FASE 2, recorrido §10-A.

### Qué debe ver un anónimo (criterio propuesto)
Entender qué es en 60 segundos y ver al menos un combate (con los flags públicos activados) o un mensaje claro de por qué no se ve (flags apagados).

## 7. Notificaciones, cuentas, moderación y legal

<a id="ux-13"></a>
### UX-13 · Sin notificaciones
- Severidad: P3 (propuesta) · Grupo: B (REVISION-PRODUCTO §3) · Tipo: FALTA · `CODE_VERIFIED` (ausencia; no se ha buscado exhaustivamente en toda la web)
- Ni email ni aviso en la web de build terminado, batalla jugada o torneo cerrado. La validación fallida y la batalla `failed` sí se explican en pantalla (`BattleDetailPage.tsx:294-296`, `build-diagnosis.tsx`). Un canal de correo es infraestructura nueva (la misma que bloquea la recuperación autónoma de contraseña). Mínimo viable sin correo: indicador de «novedades» en la web. Esfuerzo M.
- Validación FASE 2: enviar a validación un bot con un import prohibido, salir y volver; criterio: el motivo está a ≤2 clics desde la portada.

<a id="ux-02"></a>
### UX-02 · Sin recuperación ni cambio de contraseña, sin 2FA/sesiones en la web
- Severidad: **P1 si el registro está abierto a externos (valor por defecto actual); P2 con registro por invitación o cerrado** (REVISION-TECNICA D-01). Grupo: **A para «cambio de contraseña + reset asistido por el administrador», B para recuperación autónoma por correo** (DECISIONES-DIRECTOR). Tipo: DEFECTO_CONFIRMADO. Evidencia: `CODE_VERIFIED`: `routes/auth.ts:386-398,440-448` (el token de reset se crea y se descarta; sin canal de envío); `LoginPage.tsx` sin «Olvidé mi contraseña»; sin pantallas de 2FA o sesiones (`known-issues.md:23,61`). Origen: informe 03 (UX-02) y 05 (SEC-03, P2). Consolidado con TD-012.
- Impacto: un usuario externo que olvida la contraseña no vuelve; el operador no tiene CLI de reset y debe escribir un hash por SQL.
- Solución: cambio de contraseña con reautenticación (ya existe `requireStrongReauth`) y reset asistido desde la web con auditoría (S-M); pantallas de «Mi cuenta»; correo después (L, incertidumbre media). Dependencias: SEC-02, UX-08.

<a id="ux-14"></a>
### UX-14 · Sin baja de cuenta, aviso de privacidad ni términos
- Severidad: P2 (propuesta) · Grupo: B; **A si se aloja una instancia pública con registro de terceros** (REVISION-PRODUCTO §5.2) · Evidencia: `CODE_VERIFIED` (revisor): `openapi.yaml:284-330`, `/users/me` tiene `get` y `patch`, sin `delete`; sin página de privacidad ni términos en la web.
- Impacto: responsabilidad legal si se almacenan correos de terceros; usuarios sin forma de salir. Solución: baja de cuenta, inventario y retención de datos personales (correo, IP en `audit_log`, sesiones), aviso de privacidad y términos. Esfuerzo M. Validación: FASE 2, inventario de datos personales (lectura).

<a id="ux-15"></a>
### UX-15 · Sin moderación de contenido público
- Severidad: P2 (propuesta) · Grupo: C; A si hay registro abierto con ranking público (REVISION-PRODUCTO §6) · Evidencia: `UNKNOWN`: existen rol `moderator` y estados `suspended` de versión, pero ningún informe verificó si un administrador puede renombrar, ocultar un bot o suspender una cuenta desde la web.
- Impacto: nombres de bots, equipos y mapas son contenido de usuarios visible en público. Validación FASE 2: crear un bot con nombre ofensivo y resolverlo sin `psql`.

<a id="ux-16"></a>
### UX-16 · Bucle del programador «mi bot pierde: ¿por qué?»
- HIPÓTESIS · `BLOCKED (FASE 2)` · REVISION-PRODUCTO §2 señala que nadie siguió este bucle. Prueba: tras una derrota, medir qué telemetría, log y salida de contenedor ve el autor y en cuántos pasos llega a la causa.

## 8. Hallazgos UX detallados

<a id="ux-01"></a>
### UX-01 · Sin rival de práctica: la primera batalla exige dos bots publicados
- Sev. final: **P2 (P1→P2, REVISION-TECNICA)** · Grupo: **A en forma barata (DECISIONES-DIRECTOR)**, B según el informe 03; REVISION-PRODUCTO lo subía a A · Tipo: FALTA · Origen: informe 03 · Evidencia: `help/content.ts:JOURNEY`, `BattleNewPage.tsx:421-422,509` (mismo bot rechazado en ambos bandos), `docs/user/getting-started.md` paso 6. `CODE_VERIFIED` (ausencia por grep; confirmar en laboratorio).
- Descripción: la guía pide crear, equipar, validar y publicar un segundo bot. La revisión técnica matizó que `BattleNewPage.tsx:285,298` sí lista bots publicados **ajenos** (`latestPublishedVersion != null`): con una instancia poblada hay rivales. El problema es la instalación nueva y el primer usuario.
- Arbitraje (DECISIONES-DIRECTOR): P2, grupo A en forma barata. En una instalación nueva no hay bots ajenos, así que un **bot «sparring» del sistema publicado por `bootstrap`** (o `demo-teams` documentado) es condición de demo. V-05: `demo-teams` mitiga para el operador, no para el jugador (crea borradores por CLI).
- Solución: bots de práctica de la plataforma (idle/hunter/circle ya existen en el simulador) elegibles como rival, o botón «Probar contra un bot de práctica» en la ficha de la versión validada; pasando por el sandbox, sin estados fabricados.
- Esfuerzo: M, incertidumbre media. Dependencias: UX-12, BE (modelo de bot de sistema). Validación: golden de navegador «un bot propio → batalla contra rival de la casa → replay» (DoD D8, REVISION-PRODUCTO).

<a id="ux-03"></a>
### UX-03 · Estados y jerga en inglés mezclados con español
- P3 · B (C→B, REVISION-PRODUCTO) · DEUDA · `CODE_VERIFIED`: `BotsPage.tsx:1126,1315` pinta `v.state` literal (`draft`, `validated`, `published`, `frozen`); también «runtime», «build», «loadout», «artifact», «ruleset». El glosario lo explica, pero el novato ve dos idiomas en la misma fila. Solución: mapa de etiquetas con el término técnico entre paréntesis (ya existe `TOURNAMENT_STATE_NAME`). Esfuerzo S. Origen: 03.

<a id="ux-04"></a>
### UX-04 · El editor de código es un `textarea` sin ayuda
- P2 · C · FALTA · `CODE_VERIFIED`: `BotsPage.tsx:1057` (`rows=16 cols=80`). Los errores citan fichero y línea (`build-diagnosis.tsx`) pero el editor no salta a la línea. Solución: CodeMirror ligero y salto desde el diagnóstico. Esfuerzo M-L, incertidumbre media (peso del bundle). REVISION-PRODUCTO: no bloquea, el programador serio usa su editor. Multifichero: hipótesis. Origen: 03.

<a id="ux-05"></a>
### UX-05 · `aria-label` con identificadores técnicos
- P3 · B · DEFECTO_CONFIRMADO · `CODE_VERIFIED` (23 etiquetas únicas tipo slug según REVISION-TECNICA; el informe contó 26 ocurrencias): «nuevo-bot», «codigo», «rol-userid»… `aria-label` sustituye al `<label>` visible (WCAG 2.5.3 y 4.1.2). Muchos son selectores de tests. Solución: usar el `<label>` real y `data-testid`. Esfuerzo S (toca tests). Origen: 03.

<a id="ux-06"></a>
### UX-06 · Tema único oscuro, sin reduced-motion; contraste no medido
- P3 · C · RIESGO · `CODE_VERIFIED` (ausencia de `prefers-reduced-motion`/`prefers-color-scheme`/`prefers-contrast` por grep); contraste: HIPÓTESIS (`#9aa4b2` sobre `#10141a`, no medido). Verificar con axe `color-contrast` en FASE 2. Origen: 03.

<a id="ux-07"></a>
### UX-07 · Ruleset de torneo como texto libre
- P2 · B (en A sólo si los torneos los crean no administradores, REVISION-PRODUCTO) · DEFECTO_CONFIRMADO · `CODE_VERIFIED`: `TournamentsPage.tsx:35,150-152` (`mvp-default` en `<input>`); el error llega crudo (`:74`, sin `describeApiError`). Solución: `<select>` alimentado por la API de rulesets (ya usada en `BattleRulesPicker`) y `FormError`. Esfuerzo S. Relacionado: web crea torneos con `mapPool: []` (`technical-debt.md:492`). Origen: 03.

<a id="ux-08"></a>
### UX-08 · Administración por UUID y sin gestión de usuarios
- P2 · **B (C→B, REVISION-PRODUCTO: es el día 2 del administrador)** · DEUDA · `CODE_VERIFIED`: `RolesPage.tsx` pide `rol-userid` por texto; TD-023 (P2 mantenida; la subida a P1 de OPS no se sostuvo, REVISION-TECNICA D-05). Esfuerzo M. Origen: 03.

<a id="ux-09"></a>
### UX-09 · SDK y documentación sólo desde el repositorio
- P2 · B (A: quickstart o starter kit; DECISIONES/REVISION-PRODUCTO) · RIESGO · `CODE_VERIFIED`: `DOC_LINKS` apunta a GitHub; las instrucciones locales exigen `git clone`, `npm install`, Node 22 y `pip install -e` (`probar.md`, `help/sections/bots.tsx:181`). La licencia ausente se consolida en [DOC-02](10-DOCUMENTATION-AUDIT.md#doc-02). Solución: publicar SDK en un registro (decisión de producto) o «starter kit» descargable. Esfuerzo M-L. Origen: 03.

<a id="ux-10"></a>
### UX-10 · Visor y replay: alternativa textual y teclado no verificados
- P2 · C · HIPÓTESIS · `UNKNOWN`: hay controles con nombre (`theater.tsx:169-197`, `ReplayPage.tsx:362`); la excepción KNOWN de axe (`a11y-basics.spec.ts`) podría estar obsoleta porque el `aria-label` del slider ya existe. El canvas no narra eventos (`aria-live` sólo para la cámara). Verificar en FASE 2. Origen: 03.

<a id="ux-11"></a>
### UX-11 · Elegibilidad explicada sólo al fallar
- P2 · B; **A si FASE 2 lo confirma** (REVISION-PRODUCTO) · HIPÓTESIS · `isBattleEligible` puede bloquear una versión publicada (`BattleNewPage.tsx:135-173`, `version-eligibility.tsx`; antecedente de producto RC5.4: «publicada ≠ elegible»). No se verificó si la ficha de la versión avisa antes de intentar la batalla. Esfuerzo M. Origen: 03.

## 9. Accesibilidad e idioma

| Aspecto | Estado | Evidencia | Hallazgo |
|---|---|---|---|
| Navegación por teclado, skip link, `:focus-visible` | Presentes | informe 03, `CODE_VERIFIED` | — |
| `aria-live` | Para avisos y modo de cámara | informe 03 | UX-10 |
| axe en navegador real | En CI con 2 excepciones registradas (`a11y-basics.spec.ts:KNOWN`); existir no es `TEST_VERIFIED`; podría ponerse rojo ante una infracción critical/serious fuera de KNOWN | informe 03 | UX-10 |
| Nombres accesibles | Slugs técnicos | UX-05 | UX-05 |
| Contraste, reduced-motion, modo claro | No medido / ausente | UX-06 | UX-06 |
| Canvas del visor | Sin narración | UX-10 | UX-10 |
| Móvil | Menú plegable ≤1024 px, tablas «stack»; no verificado en dispositivo | `App.tsx:ShellNav` | FASE 2 |
| Idioma | Sólo español; cadenas incrustadas en JSX, sin capa i18n | `index.html lang="es"` | DOC-09 (P3, C; inglés = D según REVISION-PRODUCTO) |

Para el alcance A+ (público hispanohablante) el idioma no bloquea; hay que **declararlo** en las limitaciones del README (DoD D16).

## 10. Guion de prueba de usabilidad para FASE 2

Entorno: laboratorio aislado con datos de prueba, **nunca producción**. Participantes: 5-8 personas, dos perfiles (programadora o programador con Python/JS que no conoce el juego; persona no programadora para la comprensión de la portada) más 1-2 sesiones de administración. Cuenta nueva por participante; sin explicación previa; se entrega sólo la URL y la tarea «consigue ver a tu bot luchar». Pensar en voz alta y grabación de pantalla.

### 10.1 Tareas del jugador (límite 15 min cada una, con criterio de abandono)
| Tarea | Descripción | Medir |
|---|---|---|
| T0 | Tras 60 s en la portada, explicar con sus palabras qué es el juego (como **visitante anónimo**, instancia nueva) | Comprensión (0-2); ¿ve algún combate? |
| T1 | Registrarse y entrar (en el modo de registro por defecto de la instalación) | Éxito, tiempo, bloqueos si el registro es por invitación |
| T2 | Crear el primer bot | Éxito, clics |
| T3 | Equiparlo con un loadout válido (arma y munición) | Errores, consultas a Ayuda |
| T4 | Subir código (plantilla o propio) y enviarlo a validación; si falla, corregir | Éxito sin ayuda, comprensión del error |
| T5 | Publicar el bot | Si descubre la elegibilidad antes o después de fallar (UX-11) |
| T6 | Lanzar una batalla y verla en directo y en replay **sin crear un segundo bot** si hay rival de práctica; si no lo hay, registrar cuándo abandona | Éxito, tiempo a primera batalla |
| T7 | Inscribirse en un torneo de laboratorio y localizar el ranking | Éxito |
| T8 | Variante de error: validar código con un import prohibido y usar una versión no elegible | ¿Entiende y se recupera? ¿Qué acción siguiente cree que debe hacer? |
| T9 | Notificación: enviar un bot a validación, salir de la web y volver más tarde | ¿Encuentra el motivo a ≤2 clics desde la portada? |

### 10.2 Tareas de administración (sesión aparte)
| Tarea | Descripción |
|---|---|
| A1 | Cambiar un rol |
| A2 | Un usuario olvida su contraseña: resolverlo sin `psql` |
| A3 | Crear un mapa, un ruleset y un torneo |
| A4 | Bot con nombre ofensivo: renombrar u ocultar (UX-15) |
| A5 | Torneo atascado en `closed` y job en `needs_review` (forzados): salir sin SQL salvo lo declarado B |
| A6 | Configurar streaming en modo «experimental» |

### 10.3 Medidas
Tasa de éxito por tarea sin ayuda; tiempo (mediana y p90); clics y visitas a Ayuda; errores y retrocesos; puntos de abandono; mensajes de error leídos y comprensión de la acción siguiente (0-2); SUS y SEQ por tarea; una sesión sólo con teclado (T1-T4); lector de pantalla (NVDA/VoiceOver) en T1-T3; móvil real en 2 dispositivos (T0, T1, T6); anotar cada vez que preguntan por draft, runtime, loadout, ruleset o «elegible».

### 10.4 Criterios de paso sugeridos (a acordar, no medidos hoy)
≥80 % completa T0-T6 sin ayuda externa; mediana a primera batalla fijada tras la primera ronda; 0 bloqueos sin salida en T4/T8.

### 10.5 Pruebas técnicas asociadas
| Verificación | Entorno | Prueba | Confirma / refuta |
|---|---|---|---|
| axe completo sin KNOWN | laboratorio | `tests/browser` `a11y-basics` | Si pasa sin KNOWN, UX-10 se cierra |
| Contraste | laboratorio | axe `color-contrast` + muestreo | UX-06 |
| Recorrido E2E real | laboratorio | Playwright `onboarding.spec.ts` contando pasos | Cuenta real de interacciones (UX-01) |
| Móvil | laboratorio | viewport 375 px + dispositivo | Navegación, tablas, visor |
| Teclado del visor y del mapa | laboratorio | tab y flechas manuales | UX-10 |
| Aviso de no elegibilidad | laboratorio | versión publicada no elegible, abrir ficha y «Nueva batalla» | UX-11 |
| Multifichero | laboratorio | subir paquete con más de un fichero | UX-04 |
| Privacidad | lectura | inventario de datos personales y retención | UX-14 |

Todo lo anterior queda `BLOCKED (FASE 2)` hasta ejecutarse.

## 11. Top-10 de mejoras por impacto/esfuerzo

Orden: impacto en el recorrido principal dividido por esfuerzo, con la condición del alcance A+ (REVISION-PRODUCTO §10). Esfuerzos de los informes; la suma no es medición.

| # | Mejora | Hallazgos | Esfuerzo | Grupo |
|---|---|---|---|---|
| 1 | Bots de la casa publicados por `bootstrap` y botón «probar contra bot de práctica» | UX-01, UX-12 | M | A |
| 2 | Cambio de contraseña y reset asistido por el administrador | UX-02 | S-M | A |
| 3 | 2-4 capturas o un GIF y replays públicos curados en la instancia de presentación | UX-12, DOC-10 | S | A |
| 4 | Selector de ruleset y errores claros en torneos | UX-07 | S | B |
| 5 | Etiquetas en español de los estados de versión | UX-03 | S | B |
| 6 | `aria-label` reales y `data-testid` | UX-05 | S | B |
| 7 | Aviso de elegibilidad en la ficha de la versión | UX-11 | M | B (A si se confirma) |
| 8 | Quickstart de bots de 5 minutos o starter kit descargable | UX-09, DOC-11 | S | B (A mínimo) |
| 9 | Selector/listado de usuarios y baja en administración | UX-08, UX-14 | M | B |
| 10 | Indicador de novedades en la web y revisión de excepciones a11y y `prefers-reduced-motion` | UX-13, UX-06, UX-10 | M | B/C |

Fuera del top-10 a propósito: editor con resaltado (UX-04, no bloquea), inglés (DOC-09), recuperación por correo (L, B) y SDK en registro público (decisión de producto).

## 12. Preguntas del encargo, respuestas cortas

- **¿Puede usarlo quien no conoce el juego?** Probablemente sí con paciencia (portada, checklist, ayuda con nombres reales de botones); no verificado con personas.
- **¿Dónde se bloquea?** (1) segundo bot obligatorio; (2) rechazo de validación sin entender el código; (3) «publicada» pero no elegible; (4) contraseña olvidada; (5) instalación local del SDK; (6) jerga mixta; (7) instancia vacía; (8) sin aviso de que algo terminó.
- **¿Cuántos pasos de «primer bot» a «primera batalla»?** 8 hitos del `JOURNEY` (sin equipo) y unas 20-30 interacciones: estimación por código.

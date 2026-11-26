> Anexo de trazabilidad: informe de trabajo original, saneado para publicación (rutas locales sustituidas por marcadores y sección de anexo privado retirada; estaba vacía). Las severidades y grupos **finales** son los de los documentos 01-15, no los de este informe.

# Revisión de producto · Auditoría S9 AI Arena (2026-11)

- Repo: pjclavero/s9-ai-arena · HEAD verificado: `8f380eb700c3e984691649b3449d2c543038dfb1` (`git -C <árbol-auditado@8f380eb> rev-parse HEAD`)
- Fecha: 2026-11-19 · Rol: revisor de producto (no autor de ningún informe) · Fase 1, sólo lectura.
- Entrada: informes `agents/01..08` (ARQ, BE, UX, OPS, SEC, STR, DOC, QA) y comprobaciones puntuales en el árbol de 8f380eb.
- Pregunta del propietario: **¿qué falta para tener una versión estable que una persona ajena pueda INSTALAR, USAR, MANTENER y que podamos PRESENTAR públicamente con confianza?**
- Lo que NO hice: ejecutar nada, mirar producción ni laboratorio, revisar código línea a línea. Mis comprobaciones propias están marcadas como «(revisor, CODE_VERIFIED)»; todo lo demás es afirmación de los informes y conserva su estado de evidencia.

---

## 1. Veredicto de la revisión

1. **Los informes responden bien a «instalar» (OPS) y a la calidad interna (ARQ, BE, SEC, QA), y razonablemente a «usar» (UX).** Responden mal a «presentar» y a «mantener el día 2+»: nadie recorrió la plataforma como visitante anónimo, nadie miró la instancia recién instalada vacía, nadie cubrió moderación, términos/privacidad ni baja de cuenta, y la operación del día 2 sale troceada en cinco informes sin un recorrido propio.
2. **La conclusión de OPS (NOT_READY) es correcta** y el diagnóstico (OPS-01: la guía deja un stack «verde» que no ejecuta ni una batalla) es el hallazgo más importante de toda la auditoría. Su receta (CLI guiado `s9ctl` + `create-admin` + `doctor`) va en la dirección buena, pero como paquete es mayor que el mínimo: propongo partirla (§4).
3. **Prioridades:** hay desajuste en ambos sentidos. Algunos P1 no deben bloquear (sesión larga de streaming, restore automatizado, proxy con build en host si se publica el bundle), y varios P2/P3 baratos sí deben bloquear una presentación pública (licencia ya está, pero también: interruptor de registro, cabeceras de la SPA, rival de práctica, nightly rojo, PR «NO MERGEAR», ficheros sueltos, al menos una captura). Detalle en §5.
4. **Recomendación de alcance: Opción A («mínima presentable») ampliada con 6 elementos baratos de B** (lo llamo **A+**), presentada como «proyecto autoalojable en versión 0.x para comunidad hispanohablante», **sin** registro abierto por defecto y **sin** prometer streaming. B como versión objetivo siguiente; C (Streaming V2, visuales) no debe condicionar el lanzamiento.

---

## 2. ¿Se evaluó el producto desde fuera? Recorridos

| Recorrido | ¿Cubierto? | Por quién | Calidad | Qué falta |
|---|---|---|---|---|
| Visitante del **repo** público (README, licencia, primera pantalla de GitHub) | Sí | DOC-01, DOC-02, DOC-07, DOC-13, OPS-11 | Bueno | Nadie juntó la «primera impresión» completa: README que dice «no funcional» + sin LICENSE + zip/docx en raíz + ~52 PR abiertos (35 «NO MERGEAR») + nightly rojo visible + 0 imágenes. Juntos son peores que por separado. |
| Visitante **anónimo de la web** (qué ve sin cuenta) | **No** | — | — | Comprobado por el revisor (CODE_VERIFIED, `App.tsx:254-275`): sin sesión hay ayuda, ranking, visor/directo y replays como rutas públicas, pero replays y espectador públicos están **apagados por defecto** (`infrastructure/.env.example:128-133`, SEC §9). En una instalación nueva el anónimo ve una portada con texto, un ranking **vacío** y replays que dan 404. No hay instancia de demostración ni vídeo. Para «presentar» esto es central y nadie lo trató. |
| **Instancia recién instalada** (día 0 de contenido) | **No** | — | — | `bootstrap` crea reglas/catálogo/mapas pero ningún bot; `demo-teams` crea 3 equipos de 3 bots para un usuario existente, **en `draft`** (revisor, `apps/api/src/db/seeds/demo-teams.ts:1-17`). Nadie lo citó: es la base natural del rival de práctica (UX-01) y de una instancia que no esté vacía. |
| Novato jugador (registro → primer bot → primera batalla) | Sí, estático | UX §7.1, UX-01, UX-11 | Bueno, guion de usabilidad sólido | Sin medir con personas. Falta cuantificar el «muro» del segundo bot (UX lo estima en 20-30 interacciones). |
| Programador de bots (bucle local, SDK, depuración) | Parcial | UX-04, UX-09, DOC-11, DOC-12 | Correcto | Nadie siguió el bucle «mi bot pierde → ¿por qué?»: qué telemetría/log del bot ve el autor tras una batalla (BattleDetail muestra rechazos por motivo, CPU y salida del contenedor según su cabecera; no verificado en uso). |
| «**¿Cómo me entero de que mi bot falló?**» | Parcial | UX (build-diagnosis), — | Débil | La validación fallida y la batalla `failed` se explican **en pantalla** (revisor: `BattleDetailPage.tsx:294-296`, `build-diagnosis.tsx`), pero **no existe ninguna notificación** (ni email ni aviso en la web) de build terminado, batalla jugada o torneo cerrado. El usuario tiene que volver y mirar. Ningún informe lo nombra. |
| Organizador de torneos | Parcial | BE-01, BE-08, UX-07 | Bueno en backend | Falta el recorrido completo en web (crear → inscribir → cerrar → ver bracket → cancelar) con los errores que puede ver un organizador no admin. |
| Admin que **instala** | Sí | OPS (S01-S12) | Muy bueno | — |
| Admin el **día 2** (alguien no puede entrar; un job se aparca; el disco crece; actualizar) | Troceado | OPS-06/08/12, BE-02/03/10, UX-08, SEC-03 | Disperso | No hay un recorrido «día 2» unificado. Sin listado/baja de usuarios (TD-023), sin reset de contraseña asistido, jobs `needs_review` sólo por SQL, sin retención de `jobs`/`audit_log`, crecimiento de replays no dimensionado (UNKNOWN; MP4 sí tiene retención). |
| **Moderación** (nombres de bots/equipos/mapas visibles en ranking, abuso de registro) | **No** | — | — | Con registro abierto y ranking público, contenido generado por usuarios aparece en público. Existen rol `moderator` y estados `suspended` de versión, pero ningún informe evaluó si un admin puede renombrar/ocultar un bot ofensivo o suspender una cuenta desde la web. |
| **Legal/privacidad** del servicio (términos, privacidad, baja de cuenta) | **No** | — | — | Revisor (CODE_VERIFIED, `openapi.yaml:284-330`): `/users/me` tiene `get`/`patch`, no hay `delete`; no hay página de privacidad ni términos en la web (`grep` sin resultados salvo una nota de privacidad de inscripción). Si se aloja una instancia pública con emails de terceros, esto importa más que muchos P2 técnicos. |

**Conclusión §2:** la auditoría evaluó el producto desde dentro con mucha calidad, y desde fuera sólo en instalación (OPS) y en el primer recorrido del jugador (UX). Faltan cuatro recorridos que pido añadir a FASE 2: **visitante anónimo**, **instancia recién instalada**, **día 2 del admin** y **moderación/legal** (§8).

---

## 3. Usabilidad: ¿profundidad suficiente? ¿prioridades acertadas?

Profundidad: **suficiente para una fase estática**, y el guion de usabilidad (UX §7.1) es el mejor entregable de UX: tareas, métricas (SUS, SEQ, éxito sin ayuda) y criterios de paso. Nada de UX está medido con personas, y el informe lo dice.

Prioridades UX revisadas por impacto real en el usuario:

| ID | UX propone | Revisión | Motivo |
|---|---|---|---|
| UX-01 rival de práctica | P1 · B | **Subir a A** | Es la fricción nº 1 del bucle central «crear bot → combatir» (duplica todo el trabajo antes de ver nada). Coste menor de lo que estima UX: `demo-teams` ya genera bots de ejemplo con loadouts validados; falta una cuenta «de la casa» y hacerlos pasar por el pipeline (sin saltarse el sandbox). |
| UX-02 recuperar contraseña | P1 · B | **Partir**: reset asistido por admin + cambio de contraseña → **A**; email → **B** | El canal de correo es infraestructura nueva (L). Con registro por invitación/cerrado (ver SEC-02) basta un reset asistido y auditado para no tocar la BD. |
| UX-11 publicada≠elegible | P2 · B, hipótesis | B, verificar en FASE 2 | Ya causó incidencias reales (RC5.4); si se confirma que no avisa antes, pasa a A. |
| UX-07 ruleset texto libre | P2 · B | B (en A sólo si torneos los crean no-admins) | Funciona con el valor por defecto; el riesgo es un error crudo. |
| UX-03 jerga inglés | P3 · C | B | Barato (S) y lo ve todo usuario en cada fila. |
| UX-04 editor textarea | P2 · C | C | Correcto: molesto, no bloquea (el programador serio usa su editor). |
| UX-05 aria-label slugs | P3 · B | B | Correcto. |
| UX-06 tema/contraste | P3 · C | C | Correcto hasta medir. |
| UX-08 admin por UUID | P2 · C | **B** | Es el día 2 del admin (asignar un rol exige conocer un UUID). |
| UX-09 SDK sólo desde repo | P2 · B | B (A: sólo «starter kit» descargable o quickstart claro) | El SDK en PyPI/npm es decisión de producto; para A basta DOC-11. |
| UX-10 visor a11y | P2 · hipótesis | C | — |
| Nuevo: **sin notificaciones** | — | **B** (no A) | Molesto pero el producto se puede usar mirando la web. |
| Nuevo: **instancia vacía** | — | **A** | Ver §2: va con UX-01. |

---

## 4. Instalación: ¿es correcta la conclusión de OPS y mínimo su camino?

**NOT_READY es correcto.** Coincido con OPS-01, OPS-02, OPS-04, OPS-05 y OPS-11 en grupo A. Matices:

- **OPS-03 está infravalorado (B → A en forma mínima).** Hoy, para habilitar la ejecución real, un tercero debe construir el bundle del proxy como root y compararlo con un sha256 sacado de un run de CI que puede caducar. Si eso no se resuelve, OPS-01 no se puede cerrar: «ejecuta batallas» depende de ello. La versión mínima no es el instalador completo, sino **adjuntar el bundle y su sha256 a una GitHub Release** (que de todos modos hace falta, OPS-14/DOC-05). Queda por verificar si el host necesita Node ≥22.15 aunque no construya (el instalador valida Node, `install-docker-proxy.sh:225,309`; no determinado si lo ejecuta en runtime): si sí, documentarlo como requisito, no como «opcional».
- **OPS-14 / DOC-05 releases: B → A.** «Versión estable» sin un identificador de versión no existe. Mínimo: tag `v0.5.x`, notas, digests de imágenes, bundle+sha del proxy. S-M.
- **El paquete propuesto `s9ctl` (M-L) no es el mínimo.** Para A basta:
  1. `install-host.sh` que encadene runtimes → red → firewall → proxy (desde el asset de la release) → `DOCKER_PROXY_URL`, con preflight (OPS-01/03). M.
  2. `cli.ts create-admin` (OPS-02). S.
  3. `.env.example` limpio, requisitos de hardware/SO, orden `postgres+queue → bootstrap → up` y README nuevo (OPS-04/05/11/13). S.
  4. Un **chequeo final que demuestre «puede jugar»**: arreglar `smoke.sh` para que cree y termine una batalla de humo (doctor-lite). S-M.
  El `s9ctl` interactivo con preguntas de `.env`, el `doctor` completo, `upgrade.sh`, `restore-all.sh` y desinstalación son **B/C**. Un asistente web: **D** (coincido con OPS en que no debe ser el instalador).
- **Falta en OPS:**
  - **TLS en primer arranque**: con certificado autofirmado la primera impresión es un aviso de seguridad del navegador. Mínimo A: una receta documentada con un proxy que emita certificados (OPS-09 sugiere Caddy). El perfil ACME integrado es B.
  - **Contenido inicial** (ver §2): que `bootstrap` (o un paso del instalador) deje la instancia con bots de práctica, para que el admin pueda comprobar «funciona» sin escribir código.
  - **Modo de registro por defecto** en la instalación (SEC-02): debe ser una decisión del instalador, no un estado heredado.
  - **Ensayo de restore**: para «mantener» exijo en A **un** ensayo completo de restore documentado en lab (acta con tiempos), no su automatización (B).
- **Sobra para A:** OPS-10 desinstalación (C), OPS-15 matriz de SO más allá de Debian 12 (C: declarar «soportado: Debian 12» basta), OPS-08 comando único de upgrade (B), OPS-12 alertas probadas (B).

---

## 5. Prioridades: sobrevaloradas e infravaloradas

Regla aplicada: **no convertir cada mejora en condición de lanzamiento.** Bloquea A sólo lo que (a) impide instalar/usar/mantener el núcleo, (b) expone a terceros a un riesgo por defecto, o (c) arruina la primera impresión con coste S.

### 5.1 Sobrevaloradas (no deben bloquear el lanzamiento A)

| Hallazgo | Propuesto | Debería | Por qué |
|---|---|---|---|
| STR-01 sesión larga de streaming (P1) | B | C para A/B; B sólo en opción C | El streaming no está en el alcance A/B; basta no anunciarlo como funcionalidad pública. |
| OPS-07 restore automatizado (P1) | B | A sólo el **ensayo**; la automatización B | El procedimiento manual existe y tiene evidencia parcial de terceros; lo que falta es probarlo entero una vez. |
| OPS-06 backup (P1) | B | B, con **una** parte A: avisar claramente si `RESTIC_REPOSITORY` está vacío | Un tercero que no configura backup debe saberlo el día 1; el resto (poda, guía SFTP) es B. |
| BE-02 `needs_review` sin interfaz (P1) | B | B; en A sólo un runbook SQL/CLI documentado | Raro en uso normal. |
| DOC-03 re-auditoría completa del roadmap (L) | B | B; en A sólo README, `current-status`, `known-issues` | Un tercero no lee 1.444 líneas de deuda técnica. |
| TD-008 / topología en repo (DOC: P0-P1) | A | **A sólo la limpieza de ficheros rastreados** (sustituir IP/VM/dominio por valores de ejemplo, S); purga de historial **E** | Coincido con SEC-13 (P3) en riesgo; pero en la presentación se ve, y es barato. Purgar el historial no compensa. |
| UX-04 editor, UX-06 tema, DOC-09 inglés, DOC-12 referencia API | B/C | C/D | Mejoras, no condiciones. |
| ARQ-01 stats sin comprobar versión | B | B, pero **obligatorio antes de la próxima subida de motor** | Hoy no se materializa. |
| SEC-04 anfitrión con BD en la red de bots | C | C | Correcto: cadena hipotética, esfuerzo L. |

### 5.2 Infravaloradas (sí deben bloquear una presentación pública)

| Hallazgo | Propuesto | Debería | Por qué |
|---|---|---|---|
| SEC-02 registro abierto con rol `developer`, sin interruptor | P2 · B | **A** | Toda instalación de un tercero nace con alta libre y cómputo de sandbox abierto a cualquiera. Mínimo: `REGISTRATION_MODE=open|invite|closed` con valor por defecto cerrado o por invitación. M. |
| SEC-01 SPA sin cabeceras (CSP, XFO, nosniff) | P2 · B | **A** | Coste S, y es lo primero que mira cualquier revisor externo con `curl -I`. |
| UX-01 sin rival de práctica | P1 · B | **A** | §3. |
| QA-01 nightly rojo 29 días | P2 · B | **A** | S; un rojo permanente visible en un repo público quita credibilidad y oculta regresiones. |
| OPS-03 / OPS-14 / DOC-05 releases + bundle | B | **A** (forma mínima) | §4. |
| DOC-13 35 PR «NO MERGEAR» abiertos + DOC-07 zip/docx/compose v1 en raíz | P3 · C/E | **A (higiene de escaparate, S)** | Es lo que ve quien entra al repo. |
| DOC-10 sin capturas | P3 · B | **A** (2-4 capturas o un GIF) | S, y sin imágenes nadie entiende qué es un «juego de bots». |
| BE-01 torneo `closed` atascado sin salida | P1 · B | **A en forma mínima** (permitir cancelación administrativa desde `closed`) | Los torneos están en el alcance A; la alternativa es SQL. |
| Sin baja de cuenta / privacidad / términos (nuevo) | — | **A si se aloja una instancia con registro de terceros**; si sólo se publica el software autoalojable, B | Responsabilidad legal sobre datos personales. |
| Sin moderación de contenido público (nuevo) | — | B (A si hay instancia pública con registro abierto) | — |

---

## 6. Clasificación por grupos para tres alcances

Leyenda: **A** bloqueante del lanzamiento de esa opción · **B** necesario para la versión objetivo · **C** poslanzamiento · **D** futuro · **E** descartar.
Opciones: **A-min** = instalar, crear bots, combatir, torneos, resultados · **B-pública** = A-min + instalación sencilla, buena UX, docs sólidas · **C-ampliada** = B + Streaming V2 y visuales nuevas.

| Hallazgo (resumen) | Esf. | A-min | B-pública | C-ampliada |
|---|---|---|---|---|
| DOC-02 LICENSE (+ campo `license`, NOTICE) | S | A | A | A |
| DOC-01 / OPS-11 README y estado actual reales | S | A | A | A |
| OPS-01 guía que llega a ejecutar batallas + `install-host.sh` | S+M | A | A | A |
| OPS-02 `create-admin` | S | A | A | A |
| OPS-04 `.env.example`, enlaces muertos, `smoke.sh` | S | A | A | A |
| OPS-05 requisitos de hardware y SO declarado | S | A | A | A |
| OPS-13 orden bootstrap/up | S | A | A | A |
| OPS-03 bundle del proxy como asset de release | M | A | A | A |
| OPS-14 / DOC-05 tag + release + notas | S-M | A | A | A |
| Doctor-lite: chequeo «puede jugar» (batalla de humo) | S-M | A | A | A |
| Doctor completo (OPS-12, BE-03) | M | B | A | A |
| CLI guiado `s9ctl` interactivo | M-L | C | A | A |
| OPS-09 TLS: receta con proxy | S | A | A | A |
| OPS-09 perfil ACME integrado | M | C | B | B |
| OPS-06 aviso si backup no configurado | S | A | A | A |
| OPS-06 resto (poda, guía SFTP, `.env` en snapshot) | M | B | A | A |
| OPS-07 ensayo completo de restore en lab (acta) | M | A | A | A |
| OPS-07 `restore-all.sh` | M | B | A | A |
| OPS-08 `upgrade.sh` + ensayo de rollback | M-L | B | A | A |
| OPS-10 desinstalación | S-M | C | B | B |
| OPS-15 SO adicionales | M | C | C | B |
| QA-03 instalación limpia/upgrade ejecutados en lab | M | A (instalación) / B (upgrade) | A | A |
| QA-01 nightly verde (7 seguidas) | S | A | A | A |
| QA-02 mutantes en CI | M | C | B | B |
| QA-04 staging/humo | M | E (retirar jobs y documentar promoción manual) o C | B | B |
| QA-05/06/07 | S | C | C | C |
| SEC-02 modo de registro (open/invite/closed) | M | A | A | A |
| SEC-01 cabeceras de la SPA | S | A | A | A |
| SEC-03 cambio de contraseña + reset asistido por admin | S-M | A | A | A |
| UX-02/SEC-03 recuperación por email | L | B | A | A |
| SEC-05 imágenes: `--omit=dev`, base por digest, escaneo | M | B | A | A |
| SEC-14 guardarraíl de `seed` | S | B | A | A |
| SEC-04 / SEC-07 / SEC-08 / SEC-10 / SEC-11 / SEC-12 | S-L | C | C | C |
| SEC-06 oráculo de email / invitaciones a equipo | M | C | B | B |
| SEC-09 `/version` en :80 | S | C | C | C |
| SEC-13 topología: limpiar ficheros rastreados | S | A | A | A |
| SEC-13 purga de historial | M | E | E | E |
| UX-01 rival de práctica / bots de la casa | M | A | A | A |
| Instancia no vacía tras instalar (nuevo) | S-M | A | A | A |
| UX-03 estados traducidos | S | B | A | A |
| UX-05 aria-label | S | B | A | A |
| UX-07 ruleset selector + errores | S | B | A | A |
| UX-08 admin por UUID / TD-023 listado de usuarios | M | B | A | A |
| UX-11 aviso de elegibilidad | M | B (A si FASE 2 confirma) | A | A |
| UX-04 editor con resaltado | M-L | C | C | B |
| UX-06 / UX-10 accesibilidad visual del visor | M | C | B | B |
| UX-09 SDK en registro público | M-L | C | B | B |
| Notificaciones (nuevo) | M | C | B | B |
| i18n / DOC-09 inglés | XL / M | D | C | C |
| DOC-03 roadmap completo | L | B | A | A |
| DOC-06 SECURITY.md, plantillas | S | B | A | A |
| DOC-07 ficheros sueltos en raíz | S | A | A | A |
| DOC-08 PR documentales | S-M | B | B | B |
| DOC-10 capturas/GIF | S | A | A | A |
| DOC-11 quickstart de bots | S | B | A | A |
| DOC-12 referencia API renderizada | S-M | C | B | B |
| DOC-13 cerrar 35 PR «NO MERGEAR» | S | A | A | A |
| BE-01 salida para torneo `closed` atascado | S-M | A (cancelación admin) | A | A |
| BE-02 `needs_review` operable | M | B (A: runbook) | A | A |
| BE-04 métricas de cola | M | C | B | B |
| BE-05 validación por esquema | L | C | C | C |
| BE-06 `.catch(()=>null)` → 404 | M | C | B | B |
| BE-07 límite 60 versiones/h en import | S | C | B | B |
| BE-10 retención jobs/audit_log | S-M | C | B | B |
| BE-11 / TD-013 carreras → 500 | M | C | B | B |
| BE-12..15 | — | C | C | C |
| Baja de cuenta, privacidad, términos (nuevo) | M | B (A si instancia pública) | A | A |
| Moderación de nombres/contenido público (nuevo) | M | C (A si registro abierto) | B | B |
| ARQ-01 stats y versión de motor | S | B | B | A (antes de la próxima subida de motor) |
| ARQ-02..12 | S-M | C/D | C | C |
| STR-03 replays antiguos ilegibles sin explicación | S | B (o purga decidida, PR #295) | A | A |
| STR-04 política de longevidad de replays | M | C | B | A |
| STR-01 sesión larga / STR-02 imagen congelada | M | C | C | A |
| STR-05/06/07/13/15/16/17 | S-M | C | C | B |
| STR-14 Streaming V2 | XL | D | D | A |
| Mejoras visuales (PR #253, fases visuales) | L-XL | D | D | A |
| STR-11/12 docs de streaming desfasadas | S | B | B | A |

---

## 7. Definition of Done de la «próxima versión presentable» (opción A+)

Cada criterio debe tener evidencia archivada (acta con rc y salida). Ninguno se da por cumplido con DOC_ONLY.

| # | Criterio | Cómo se demuestra |
|---|---|---|
| D1 | Existe una release etiquetada `v0.x.y` con notas, digests de imágenes y bundle del proxy + sha256 como assets | `gh release view v0.x.y` lista los assets; el sha del bundle descargado coincide con el publicado (`sha256sum -c`). |
| D2 | El repo tiene LICENSE elegida por el propietario y campo `license` en todos los paquetes | `gh api repos/<repo>` → `license` no nulo; `git grep -L '"license"' -- '**/package.json'` vacío (salvo los privados declarados). |
| D3 | README describe el estado real (fecha de verificación, qué funciona, qué no) y enlaza instalación, quickstart de bots y licencia; incluye ≥2 capturas | Revisión de un tercero; enlaces comprobados por el script de 2.311 enlaces + comprobación de imágenes en `git ls-tree`. |
| D4 | **Instalación limpia por una persona ajena** en VM Debian 12 limpia siguiendo sólo README → `installation.md` → `first-run.md`, sin preguntar a los autores, hasta una batalla `finished` | Acta del escenario OPS S01+S03+S04+S05/S12 en lab: 0 pasos no documentados, nº de intervenciones y tiempo total registrados; `doctor-lite` rc 0. |
| D5 | El primer admin se crea sin `psql` | `cli.ts create-admin` rc 0 y login de admin en la web (OPS S03); test de CI que lo cubre y se pone rojo con un mutante. |
| D6 | Una instalación nueva no deja registro libre por defecto | Con el `.env` por defecto, `POST /auth/register` anónimo → rechazo (modo cerrado/invitación); test de contrato con mutación. |
| D7 | La SPA se sirve con CSP, `X-Frame-Options`/`frame-ancestors`, `nosniff`, `Referrer-Policy` | `curl -sI https://<lab>/` muestra las cabeceras; test sobre la conf real del gateway; golden en navegador sigue verde (el visor carga). |
| D8 | Un usuario nuevo llega a su **primera batalla con UN solo bot** propio contra un bot de práctica | Golden de Playwright nuevo «primer bot → batalla contra rival de la casa → replay» en `functional-e2e`, obligatorio en main. |
| D9 | La instancia recién instalada no está vacía: hay bots de práctica publicados (pasados por el sandbox) | Tras `install` + `bootstrap`, consulta API lista ≥3 bots de práctica en `published`; ninguno con estado fabricado (auditoría de la transición). |
| D10 | Un torneo de 4 bots termina con ranking y replays; un torneo atascado tiene salida desde la web | OPS S06 en lab; test de integración de BE-01 (handler que falla → cancelación admin posible). |
| D11 | Un usuario que olvida la contraseña puede recuperar el acceso sin que el operador toque la BD | Reset asistido por admin desde la web, auditado; test E2E. |
| D12 | Backup: un instalador que no configura destino lo sabe el día 1; y existe **un** ensayo de restore completo en host limpio | `doctor-lite`/arranque avisa con rc≠0 o mensaje explícito si `RESTIC_REPOSITORY` vacío; acta OPS S08 con conteo/md5 por tabla y tiempo. |
| D13 | CI sana: `ci` verde y **nightly verde 7 ejecuciones seguidas** sobre el SHA candidato | `gh run list --workflow nightly.yml` con 7 success consecutivos; recuento de conclusiones de todos los checks, no la cola de `--watch`. |
| D14 | Escaparate limpio: 0 PR «NO MERGEAR» abiertos, sin zip/docx/compose v1 en raíz, sin IP/VM internas en ficheros rastreados | `gh pr list --search "NO MERGEAR in:title" --state open` vacío; `git ls-tree` sin esos ficheros; gate de CI que parsea direcciones privadas y nombres de host en ficheros rastreados y se pone rojo con un mutante. |
| D15 | Requisitos declarados y comprobados | Tabla de mínimo/recomendado en `installation.md` derivada de la medición de OPS S06 (`docker stats`/`vmstat`) con la concurrencia sugerida; preflight del instalador falla por debajo del mínimo. |
| D16 | Lo que NO se promete está escrito | Sección «Limitaciones de esta versión» en README: sin email, streaming experimental/no soportado, sólo español, sólo Debian 12, un solo host. |

Criterio de salida: D1-D16 en PASS con acta, sobre **un único SHA**; cualquier cambio de código posterior invalida D4, D8, D13 y obliga a repetirlos.

---

## 8. Riesgos de presentación pública

| Riesgo | Estado | Impacto | Recomendación |
|---|---|---|---|
| **Sin LICENSE** en repo público | Confirmado (DOC-02; revisor: `git ls-tree` sin LICENSE) | Nadie puede usar ni contribuir legalmente; los SDK no son utilizables por terceros; una presentación «abierta» sin licencia es contradictoria | Decisión del propietario antes de anunciar nada. Si se busca proteger el servicio alojado: AGPL-3.0; si se busca adopción: Apache-2.0 (patentes) o MIT. Revisar el `.docx` y el zip antes de licenciar (pueden contener material no propio). |
| **README dice «no funcional»** | Confirmado (revisor: `README.md:8-14`, fecha 2026-10-18) | Primera línea útil del repo desmiente el producto | A, S. |
| **Topología interna en ficheros rastreados** | Confirmado (SEC-13) | Bajo en seguridad, alto en imagen («proyecto casero») | Limpiar ficheros (A); no purgar historial (E). Recordar el incidente previo del mismo tipo: auditar contra `origin/main` y verificar ausencias con `git ls-tree`. |
| **Registro abierto** | Confirmado (SEC-02) | En una instancia pública: abuso de cómputo, cuentas desechables, contenido ofensivo en el ranking sin herramientas de moderación | Lanzar con invitación/cerrado; abrir sólo tras email + moderación. |
| **Cuentas** | Sin recuperación, sin baja, sin privacidad/términos | Usuarios atrapados; obligación legal sobre datos personales si se aloja | Reset asistido + cambio de contraseña (A); baja + aviso de privacidad (A si instancia pública). |
| **Primera impresión web** | Instancia vacía; replays/espectador públicos apagados; certificado autofirmado | El visitante no ve un combate | Bots de la casa + 1-2 replays públicos curados en la instancia de presentación; receta TLS; o, si no se quiere exponer una instancia, un vídeo/GIF en el README. |
| **Escaparate del repo** | ~52 PR abiertos (35 «NO MERGEAR»), nightly rojo, zip/docx en raíz | Parece abandonado o caótico | Higiene S (D13, D14). |
| **Expectativas de streaming** | V1 funciona para el operador; sesiones largas y congelado sin demostrar; V2 sólo diseño | Promesa que falla en directo, justo durante el evento | No anunciar streaming en A/B, o anunciarlo como «experimental». |
| **Idioma** | Todo en español | Limita alcance internacional | Asumir público hispanohablante en A; inglés en C. |
| **Seguridad visible** | Sin SECURITY.md, sin cabeceras en la SPA | Un revisor externo lo detecta en minutos | SECURITY.md (S) + cabeceras (A). |
| **Instancia de presentación = producción en hipervisor compartido** | Conocido (memoria de proyecto: la carga en el host de orquestación ya tumbó una prueba en producción; OPS-05) | Una demo con tráfico real puede degradar | Limitar concurrencia y, si se anuncia, tener plan de capacidad o presentar desde el laboratorio. |

---

## 9. Verificaciones adicionales para FASE 2 (además de las de los informes)

| Recorrido | Entorno | Prueba | PASS si |
|---|---|---|---|
| Visitante anónimo | lab, instalación nueva | Navegador privado: portada, ranking, ayuda, `#/live`, un replay; con flags públicos en ambos valores | El visitante entiende qué es en 60 s (UX T0) y ve al menos un combate (con flags activados) o un mensaje claro de por qué no |
| Instancia recién instalada | lab | Tras D4: contar bots, torneos, replays visibles para un usuario nuevo | Hay rival de práctica y no hay pantallas vacías sin explicación |
| Día 2 del admin | lab | Guion: usuario olvida contraseña; job a `needs_review` (handler forzado); disco al 85 %; bot con nombre ofensivo; actualizar a un SHA nuevo | Cada caso se resuelve desde web/CLI documentada sin `psql` (salvo lo que se declare B) |
| Notificación de fallo | lab | Enviar a validación un bot con import prohibido y salir; volver al día siguiente | El usuario encuentra el motivo en ≤2 clics desde la portada |
| Privacidad | lectura | Inventario de datos personales guardados (email, IP en `audit_log`, sesiones) y su retención | Documentado en un aviso de privacidad; existe vía de baja |

---

## 10. Recomendación final

**Lanzar la opción A+**: A-min más seis elementos baratos que la hacen presentable (interruptor de registro, cabeceras de la SPA, rival de práctica / instancia no vacía, nightly verde, release etiquetada con bundle del proxy, higiene del escaparate con capturas). Presentarla como **software autoalojable v0.x, en español, con limitaciones declaradas** (sin email, streaming experimental, un solo host Debian 12) y, si se expone una instancia propia, **con registro por invitación**.

No condicionar el lanzamiento a: Streaming V2, mejoras visuales, editor con resaltado, i18n, emails, `s9ctl` interactivo completo, automatización de restore/upgrade, SEC-04/05/07, purga de historial. Son B o posteriores.

Esfuerzo orientativo de A+ (suma de estimaciones de los informes, no medido): ~4-6 semanas-persona, dominado por OPS-01/03 (`install-host.sh` + release), SEC-02 (modo de registro), UX-01 (bots de la casa) y los dos ensayos de lab (instalación por un tercero y restore). La decisión de licencia es del propietario y debe tomarse primero.

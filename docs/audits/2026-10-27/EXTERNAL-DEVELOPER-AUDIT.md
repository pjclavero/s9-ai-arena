# S9 AI ARENA — EXTERNAL DEVELOPER AUDIT (2026-10-27)

## Resumen

El 2026-10-27 se auditó si una persona externa, o una IA externa con credenciales normales,
puede completar sin ayuda interna el ciclo completo de S9: registrarse, aprender las reglas,
programar bots, versionarlos, hacer el build, leer errores, publicar, montar un equipo, combatir
y consultar el resultado.

Trabajaron cinco auditores independientes y un REVIEW que reprodujo los puntos clave por su cuenta:
- **A:** modelo de programación y SDK.
- **B:** código fuente, versiones, build y API.
- **C:** experiencia de un usuario externo en la web de producción.
- **D:** documentación.
- **E:** IA externa, automatización y seguridad.

Las pruebas en producción fueron **no destructivas**. Se usaron cuentas de auditoría identificables,
por la ruta pública y sin acceso administrativo. Durante la auditoría no se cambió nada en
producción.

Este documento es la versión pública y saneada. No incluye topología. Las vulnerabilidades
abiertas se describen por su clase, sin receta de explotación. La evidencia completa (capturas,
logs, respuestas HTTP y scripts) es **interna**.

```
AUDIT BASE:   35a4fb9 (main = f32ab2c + PR #172, sólo test y docs)
PRODUCTION:   f32ab2c (RC4, DEPLOYMENT_VERIFIED, 12/12 servicios healthy)
```

| Veredicto | Valor |
|---|---|
| PRODUCTION_CORE | **PASS**: build en sandbox real → batalla en contenedores → stats → replay, operativos en producción (con un P1 de juego, G-04) |
| HUMAN_EXTERNAL_USER | **FAIL** |
| BOT_DEVELOPER_DOCUMENTATION | **FAIL** |
| BOT_PUBLIC_API | **PASS** |
| PROGRAMMATIC_AUTH | **PASS** (sin token de desarrollador) |
| AI_EXTERNAL_AGENT | **FAIL** |
| DOCUMENTATION_CURRENT | **FAIL** |
| RAM_PROFILE | **MEASURED** |
| **EXTERNAL_USER_READY** | **NO** |
| **AI_AGENT_READY** | **NO** |

En una frase: **el producto funciona, pero no se deja descubrir.** El ciclo entero se ejecutó en
producción tanto desde el navegador como por HTTP puro, incluida una iteración en la que una
versión nueva cambió el resultado de la batalla. Pero ni un humano ni una IA lo completan usando
sólo lo que S9 publica:
- la web no explica nada ni da plantilla de código;
- la documentación canónica afirma que el ciclo es imposible;
- el tutorial JavaScript oficial se rechaza;
- el build da por buenos bots que no hacen nada;
- la batalla no ofrece ninguna señal para depurar.

## Índice

- [Método](#método)
- [Respuestas directas](#respuestas-directas)
- [Resultado por área](#resultado-por-área)
- [Prueba final de REVIEW](#prueba-final-de-review)
- [Matriz de gaps](#matriz-de-gaps)
- [Manual de bots: propuesta](#manual-de-bots-propuesta)
- [IA externa: MCP y token](#ia-externa-mcp-y-token)
- [Perfil de RAM](#perfil-de-ram)
- [Datos de auditoría en producción](#datos-de-auditoría-en-producción)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Método

| Carril | Qué hizo | Producción |
|---|---|---|
| A | Lectura del SDK, el protocolo, el motor y el sandbox. Simuladores locales, sondas en las imágenes de runtime fijadas por digest y suites de los SDK (vitest 49/49, pytest 45 passed) | no |
| B | Inventario de rutas reales (contrato y extensiones), modelo de datos y pipeline de build. Suite existente 52/52 y reproducción propia 6/6 con Postgres embebido | no |
| C | Chromium real como persona que nunca ha visto el repositorio: registro, dos bots, equipo, dos batallas, visor y replay | sí: 4 builds, 2 batallas |
| D | Cruce automático de 302 citas de rutas en los docs contra el registro real; barrido de drift | no |
| E | Flujo headless completo por HTTP; iteración real; 39 pruebas de autorización con dos cuentas; sondas de escalada | sí: 4 builds, 2 batallas |
| REVIEW | TEST H (humano con la documentación pública), TEST AI (cliente HTTP con la documentación publicada) y verificación de nueve afirmaciones de A–E | sí: 4 builds, 2 batallas |

Antes de cada build o batalla en producción se comprobó la presión del hipervisor, y las pruebas se
serializaron con un cerrojo común.

## Respuestas directas

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | ¿Dónde escribe hoy un usuario el código? | En la web, en un `<textarea>` («Subir código (pegado)») o en el editor del detalle del bot, que guarda siempre como **versión nueva**. No hay subida de fichero, ZIP ni Git. |
| 2 | ¿Puede subirlo por API? | Sí: `POST /api/v1/bots/{id}/versions`, multipart con `source`, `runtime` y `loadoutRevision`. `source` es un fichero de texto o un JSON `{"files":[{path,content}]}` multi-fichero con el manifiesto en la raíz (≤10 MB, ≤500 ficheros). El contrato lo describe mal como «archivo comprimido» (G-09). |
| 3 | ¿Qué lenguajes están soportados? | **Python** (3.11) y **JavaScript ESM** (Node 20). TypeScript se rechaza en el build. Java y .NET son *placeholders* sin runtime. |
| 4 | ¿Hay SDK oficial? | Sí, en el repo: `sdks/python` y `sdks/javascript`, versión 0.1.0, **preinstalado en los runtimes**. No está publicado en PyPI ni npm. Los SDK son del protocolo de juego; no hay cliente de la API REST. |
| 5 | ¿Basta la documentación para alguien que nunca ha visto S9? | **No.** La web no enlaza documentación. La documentación del repo está dispersa y su puerta de entrada dice que el producto no funciona (G-03). |
| 6 | ¿Hay un bot mínimo funcional que pueda copiar? | En **Python**, sí: el tutorial de `sdks/python/README.md` pasó las 10 etapas en producción tal cual. En **JavaScript**, no: el tutorial y los ejemplos son TypeScript y se rechazan (G-06). La web no ofrece plantilla. |
| 7 | ¿Están documentados todos los sensores y acciones? | **Parcialmente.** Hay esquemas (`packages/protocol/schemas`) y docs técnicas (`docs/technical/equipment.md`, `engine.md`). No hay guía de autor. Reglas relevantes (marco relativo del lidar, radio sin equipo, acústica propia, stdlib permitida) sólo aparecen en el código. |
| 8 | ¿Puede consultar los logs de compilación? | **Sí.** «Ver build» en la web y `GET /api/v1/builds/{id}` dan fase, causa y logs por etapa. Es de lo mejor resuelto. Logs del bot **durante la batalla**: no existen (G-07). |
| 9 | ¿Puede versionar y volver a una versión anterior? | Versiones inmutables con historial, diff, ficheros y clonado: sí. «Volver atrás» = elegir una versión publicada anterior en la batalla (sólo por API) o clonarla y rehacer el build. No hay *unpublish*, y `retire` es terminal. |
| 10 | ¿Puede crear un equipo con versiones exactas? | Crea equipos y añade bots, pero **el equipo no fija versiones** y no influye en la batalla (el bando es una etiqueta libre). La versión exacta se fija por participante al crear la batalla; la web elige siempre la última publicada (G-18). |
| 11 | ¿Puede lanzar una batalla por sí mismo? | Sí, desde la web (`#/battles/new`) y por API (`POST /api/v1/battles`). |
| 12 | ¿Puede hacerlo todo sin acceso administrativo? | **Sí.** Las cuentas nuevas reciben `user` y `developer`. Nada del ciclo exige admin. |
| 13 | ¿Hay autenticación apta para scripts y agentes? | **Sí, básica**: login → JWT Bearer de 15 min, más refresh por body con rotación (14 días deslizante, 30 absoluto). **No** hay API key, token personal ni OAuth (G-11). |
| 14 | ¿Puede una IA externa completar el ciclo? | **Mecánicamente sí, con lo publicado no.** E completó el bucle en producción: build fallido → leer la traza → corregir → publicar → batalla → stats y replay → nueva versión → victoria. Para descubrir rutas y formatos tuvo que leer ficheros internos del repo, porque la especificación no se sirve, y el bucle de mejora carece de señales fiables (G-05, G-07). |
| 15 | ¿Existe MCP o conector? | **No.** No hay MCP, CLI ni cliente de la API. |
| 16 | ¿Permite la API actual construirlo sin tocar el core? | **Sí.** Todo es REST con Bearer y JSON (multipart sólo para el código). Ver [IA externa: MCP y token](#ia-externa-mcp-y-token). |
| 17 | ¿Qué documentación falta? | Una puerta de entrada para autores de bots: modelo de programación, observación, comandos, reglas, límites y depuración. También una guía de la API para usuarios con el ciclo completo, el contrato servido por el producto y `llms.txt`. |
| 18 | ¿Qué documentación está desactualizada? | `README.md`, `docs/README.md`, `docs/overview/*` y casi todo `docs/user/*` dicen que producción no funciona, que juega un bot de relleno o que la ejecución está apagada. Además, `docs/technical/api.md` omite 15 operaciones, y hay contradicciones de contrato (tiempos, versión del SDK, aviso de loadout). |
| 19 | ¿Qué servicios consumen más RAM? | En reposo, `api` (~120–140 MiB), `tournament-worker` (~110–123), `arena-engine` (~103) y `replay-service` (~98). Toda la pila suma **~820 MiB**. |
| 20 | ¿Cuánta RAM adicional consumen un build y una batalla? | Un build arranca un contenedor de bot de ~18 MiB de pico: unos **+25 MiB** en total. Una batalla de dos bots: unos **+48 MiB** (2 × 18 MiB de contenedores, más el worker y PostgreSQL). Swap 0 en todo momento. |

## Resultado por área

```
CORE PRODUCT:              PASS. Build real, batalla en contenedores, stats y replay operativos en producción
BOT SOURCE ENTRY:          EXISTS_AND_USABLE (pegar o API) · multi-fichero EXISTS_BUT_UNDOCUMENTED · ZIP/Git MISSING
BOT VERSIONING:            EXISTS_AND_USABLE (inmutable, historial, diff, clone); volver atrás PARTIAL
BOT BUILD:                 EXISTS_AND_USABLE (10 etapas, fail-closed, logs por etapa); valida bots inertes: BROKEN (falso verde)
BOT SDK:                   PARTIAL. Python usable; JS funcional, pero su tutorial y ejemplos son TS y se rechazan; no publicado
BOT PROGRAMMING MANUAL:    MISSING como puerta de entrada (piezas dispersas y técnicas)
HUMAN USER ONBOARDING:     MISSING (sin landing, ayuda, plantilla ni enlaces)
PUBLIC API:                EXISTS_AND_USABLE · contrato no servido y con errores · guía para usuarios MISSING
PROGRAMMATIC AUTH:         EXISTS_AND_USABLE (JWT + refresh) · token de desarrollador MISSING
EXTERNAL AI INTEGRATION:   PARTIAL. Ciclo posible por HTTP, pero no descubrible con lo publicado
MCP:                       MISSING (construible sin tocar el core)
DOCUMENTATION CONSISTENCY: FAIL. La documentación de entrada describe el estado anterior a la RC4
SECURITY:                  autorización de objeto correcta (32/39); 7 fallos de una misma clase ya registrada (TD-047, TD-041)
RAM IDLE:                  ~820 MiB la pila completa (12 servicios)
RAM BUILD PEAK:            +25 MiB (contenedor de bot ~18 MiB)
RAM BATTLE PEAK:           +48 MiB (2 bots)
```

**Seguridad.** Con dos cuentas de auditoría se verificó que una no puede leer, modificar ni usar los
bots, fuentes o versiones privadas de la otra. Tampoco puede leer sus replays ni escalar a rutas de
administración: todo devolvió 404 o 403. Desde fuera no hay superficie de Docker, secretos ni
ficheros. Los fallos son de una sola clase: **algunas lecturas de batallas no aplican la
visibilidad de sus participantes**. Así quedan expuestos metadatos (participantes, versiones,
resultado, estadísticas y auditoría de firmas) de batallas entre bots privados, y otro usuario
puede obtener acceso de espectador a ellas. Está registrado como TD-047, y aquí se eleva a P1
(G-08). El alta de miembros de equipo por email sigue funcionando como oráculo de cuentas (TD-041).

## Prueba final de REVIEW

| Prueba | Resultado | Motivo |
|---|---|---|
| TEST H: desarrollador humano con la documentación pública | **FAIL** | El ciclo se completa sin leer el código fuente ni usar admin, pero: la documentación canónica dice que es imposible y falla en batallas y build; el tutorial JavaScript se rechaza sin pista; el aviso del editor de loadout es falso; y la batalla termina en un empate sin sentido porque la arena no tiene límites (G-04) |
| TEST AI: cliente HTTP sólo con lo publicado | **FAIL** | La especificación no se sirve en el producto, y la del repositorio describe mal la subida. No hay credencial de máquina. El build valida un bot que nunca actúa. La batalla no da señales de depuración (sólo posiciones públicas y estadísticas engañosas) |

REVIEW confirmó siete de las nueve afirmaciones de A–E y matizó dos:
- El bot que «no se movía» en las batallas de C sí se movía: chocaba contra un muro y se quedaba
  allí. La métrica `uses` del módulo de movimiento es siempre 0 por diseño de las estadísticas,
  así que no era evidencia (G-07).
- El plazo de decisión efectivo en batalla (~100 ms) no coincide ni con el que se anuncia al bot
  ni con el que se usa en el build (G-12).

Además encontró dos defectos que A–E no vieron: G-04 y G-16.

## Matriz de gaps

Prioridades: **P0** impide que un usuario externo use S9 · **P1** el flujo es posible pero está
incompleto o es inseguro · **P2** UX o documentación importante · **P3** mejora.

| ID | SEV | AREA | WHAT EXISTS | WHAT IS MISSING | USER IMPACT | RECOMMENDED FIX |
|---|---|---|---|---|---|---|
| G-01 | P0 | Onboarding web | Login y registro | Qué es S9, ayuda, enlaces a la documentación; no existen `#/help` ni `#/docs` | Un externo no sabe qué hacer después de registrarse | Landing pública y enlace «Guía del bot» en el menú |
| G-02 | P0 | Código en la web | Textarea vacío | Plantilla por runtime y contrato visible (hook, observación, comando) | Sin conocimiento externo no se puede programar un comportamiento | Precargar un bot mínimo por runtime y enlazar la referencia |
| G-03 | P0 | Documentación de entrada | `docs/roadmap/current-status.md` al día (PR #173) | `README.md`, `docs/README.md`, `overview/*` y `user/*` coherentes con la RC4 | Quien lee la documentación concluye que el ciclo es imposible y abandona | Corregir el drift (PR documental de esta auditoría) |
| G-04 | P1 | Motor / mapas | Muros interiores en los mapas | **Perímetro de la arena**: el mapa no lo declara, la conversión no lo añade y el motor no limita a `widthM`/`heightM` | Los vehículos salen del mapa en batallas reales; empates 0-0 sin sentido | Muros de borde implícitos en la conversión del mapa (o validación que los exija), con un test sobre los mapas reales |
| G-05 | P1 | Build | 10 etapas; el humo sólo falla con descalificación | Detectar un bot inerte (hook no implementado, sólo comandos vacíos) | Un bot con el hook mal escrito se publica en verde y no hace nada | Avisar o rechazar si no se sobrescribe el hook o si todos los comandos son vacíos |
| G-06 | P1 | SDK JS / ejemplos | SDK funcional; tutorial y ejemplos en TypeScript | JS subible, o transpilar TS en el build | Quien copia el ejemplo oficial queda `rejected` (a veces sin pista de TS) | Ejemplos `.js` y aviso en los README; opcional: transpilación en el build |
| G-07 | P1 | Depuración en batalla | Resultado, replay con posiciones y estadísticas | Eventos o diagnóstico por bot (comandos rechazados, excepciones, timeouts, colisiones); `uses` útil en el módulo de movimiento | No se puede averiguar por qué un bot hace lo que hace | Pestaña de diagnóstico por bot (dueño) y estadísticas de uso reales |
| G-08 | P1 | Seguridad | Replays protegidos por la política de visibilidad | La misma política en listado, detalle, estadísticas, auditoría y acceso de espectador de batallas | Exposición de metadatos de bots privados (TD-047) | Una sola política de lectura para todas las vistas de una batalla |
| G-09 | P1 | Contrato de subida | `{files}` o fichero único | Descripción correcta en `openapi.yaml`; rechazo claro de ZIP | Un ZIP se acepta (201) y falla después con un error incomprensible | Corregir el contrato; responder 415 o 422 a formatos no soportados |
| G-10 | P1 | Descubrimiento de la API | `apps/api/openapi.yaml` en el repo | Especificación servida por el producto (`/openapi.yaml` devuelve hoy el HTML de la SPA); guía de la API para usuarios | Una IA sin el repositorio no descubre la API | Servir el contrato (con las 8 extensiones) y escribir `docs/user/api.md` |
| G-11 | P2 | Autenticación | JWT de 15 min + refresh | Token de desarrollador (scopes, revocación, caducidad, último uso) | Un agente debe guardar la contraseña humana; con 2FA no hay automatización | Diseño en [IA externa](#ia-externa-mcp-y-token) |
| G-12 | P2 | Tiempos | Plazo de 80 ms en el build, p95 ≤ 100 ms, 204 ms anunciados en batalla y ~100 ms efectivos | Un único valor, documentado y aplicado igual en el build y en la batalla | Un bot que se ajuste al plazo anunciado puede validarse y luego ser descalificado | Alinear los tres valores y documentarlos |
| G-13 | P2 | Protocolo / SDK | Esquema de COMMAND | Motivo cuando se descarta un COMMAND inválido; captura de excepciones en el SDK | Errores silenciosos que acaban en descalificación; una excepción mata el bot toda la batalla | Evento `invalid_command` con la ruta del esquema; try/catch en el SDK |
| G-14 | P2 | Motor / sensores | Radio y acústica | Filtro de equipo y alcance en la radio; excluir los sonidos propios | El rival lee tu radio; contactos acústicos falsos | Aplicar el filtro, o documentarlo mientras tanto |
| G-15 | P2 | Editor web | «Guardar como versión nueva» | Conservar los paquetes multi-fichero | La versión nueva pierde en silencio todos los ficheros salvo la entrada | Reenviar el paquete completo o bloquear la edición |
| G-16 | P2 | UI de loadout | El loadout real se usa en batalla | Aviso correcto (hoy dice que se usan los módulos del arquetipo; sólo el humo del build los usa) | El usuario no sabe qué vehículo juega | Corregir el aviso y `docs/user/equipment.md` |
| G-17 | P2 | Resultados | Estadísticas por API; lista de batallas | Pantalla de estadísticas; nombres de bot en la lista y en el visor; obstáculos dibujados | Hay que usar la API para ver daño o disparos; ids y `veh_1` en vez de nombres | Pantalla de estadísticas y resolución de nombres |
| G-18 | P2 | Equipos | Equipos con bots | Versiones fijadas por equipo; relación entre equipo y batalla; elegir una versión anterior en la web | El paso «equipo» no tiene efecto en el juego | Documentarlo o integrar el equipo en la batalla |
| G-19 | P2 | Validación de la subida | Validación en el build | Validación del paquete al subir (422) | Se crean versiones inválidas que sólo fallan tras el build | Validar la estructura al crear la versión |
| G-20 | P2 | Sandbox | Allowlist de stdlib y de paquetes | Documentarla para el autor | `import logging` o `datetime` se rechazan sin que se sepa por qué | Publicar la lista (sin detalle de seguridad interno) |
| G-21 | P2 | Protocolo | WELCOME con dimensiones, spawns y bases | Geometría estática y radios de base y zona | Hay que descubrir los muros a ciegas | Enviarlos según el ruleset |
| G-22 | P2 | Abuso | Límites de ritmo por IP y usuario | Verificación o interruptor de registro; cuota de batallas | Cuentas desechables consumen la capacidad de ejecución (TD-012); oráculo de cuentas (TD-041) | Interruptor o verificación de registro, cuota por usuario e invitaciones a equipos |
| G-23 | P2 | Descubrimiento para IA | — | `llms.txt` y `llms-full.txt`; hoy `/llms.txt` devuelve el HTML de la SPA con 200 | Una IA no tiene punto de entrada y recibe un falso positivo | Recomendación en esta auditoría; implementación aparte |
| G-24 | P2 | Distribución del SDK | SDK en el repo y en los runtimes | Publicarlo o reservar los nombres en PyPI y npm | `pip install arena-sdk` podría instalar un paquete ajeno | Reservar o publicar, o documentar «sólo desde el repo» |
| G-25 | P3 | Varios | — | Borrar bots y borradores; comprobar el dueño al relanzar una batalla; paginar el listado de bots después de filtrar; Node 22 en el runtime; quitar la ruta pública de observabilidad; resumir los logs del build para el usuario; estado vacío de la pestaña de código; mensajes de formulario con etiquetas visibles | Fricción menor | Backlog |

No se abre deuda técnica automáticamente para cada gap: los ya registrados se citan por su TD.

## Manual de bots: propuesta

**Ya existe material válido, pero disperso.** No se propone un árbol nuevo: hay que consolidar.

| Tema | Hoy | Cobertura |
|---|---|---|
| Primeros pasos | `docs/user/getting-started.md`; «Tu primer bot» en los README de los SDK | Parcial (desactualizado) |
| Modelo de programación | `packages/protocol/README.md`; `sdks/python/README.md`; `docs/user/bots.md` | Parcial (en 3 sitios) |
| Sensores | `docs/technical/equipment.md`, `docs/technical/engine.md`, `observation.schema.json` | Parcial (falta la vista del autor) |
| Acciones | `docs/technical/engine.md`, `command.schema.json` | Parcial |
| Armas | `docs/technical/equipment.md`, `docs/user/equipment.md` | Completa (técnica) |
| Radio | `docs/technical/equipment.md` | Parcial |
| Ciclo de vida | `packages/protocol/README.md`, README de los SDK, `docs/user/bots.md` | Parcial (tiempos contradictorios) |
| Límites | `docs/user/bots.md`, `docs/technical/bots.md` | Parcial y disperso |
| SDK TypeScript/JS | `sdks/javascript/README.md` | Parcial (no aclara que el runtime ejecuta JS) |
| SDK Python | `sdks/python/README.md` | Completa (local) |
| Ejemplos | `example-bots/*` | Parcial (los de JS no se pueden subir) |
| Depuración | `docs/user/bots.md` («Ver build»), simuladores | Parcial (no hay depuración en batalla) |

Propuesta:
1. `docs/user/bots.md` pasa a ser el **manual del autor**, con estas secciones:
   - modelo de programación;
   - observación y sensores;
   - comandos;
   - radio;
   - reglas que importan;
   - límites y tiempos;
   - depuración;
   - subir por API.

   Cada sección resume y enlaza a la referencia técnica (`packages/protocol`, `docs/technical/equipment.md` y `engine.md`), que sigue siendo la fuente canónica de cada contrato.
2. `docs/user/getting-started.md` pasa a ser el recorrido vigente de extremo a extremo.
3. Los README de los SDK quedan como referencia de la librería.
4. La web enlaza ese manual desde el menú y el editor de código (G-01, G-02).

**Fuentes canónicas por contrato:**

| Contrato | Fuente canónica |
|---|---|
| API | `apps/api/openapi.yaml`, a completar con las 8 extensiones |
| Protocolo, observación y comando | `packages/protocol/schemas` |
| Tiempos | `packages/game-rules` |
| Ciclo de vida de batalla | `docs/technical/battles.md` |
| Ciclo de vida de build | `docs/technical/bots.md` |
| Estado del proyecto | `docs/roadmap/current-status.md` |

El resto de documentos debe enlazar a estas fuentes, no repetir su estado.

**`llms.txt` (recomendación, sin implementar).** Un índice breve con:
- qué es S9;
- que el bot no se conecta solo: la plataforma ejecuta su clase;
- lenguajes (Python o JavaScript ESM, no TypeScript);
- la autenticación (login → Bearer de 15 min + refresh);
- el ciclo de la API con sus rutas reales (bots, loadouts, versiones multipart, submit, builds con logs, publish, battles, stats, replays);
- el contrato del bot (hook, protocolo `arena/1`, tiempos, límites, SDK 0.1.0, dependencias permitidas);
- enlaces al manual del autor, a los esquemas y al contrato servido;
- dónde se publica el estado del producto.

`llms-full.txt` se generaría concatenando esas fuentes, con un test que falle si dejan de existir. No debe incluir topología. Antes, `/llms.txt` y `/openapi.yaml` tienen que dejar de responder con el HTML de la SPA.

## IA externa: MCP y token

**MCP.** No existe, pero se puede construir **fuera del core** sobre la API actual. Herramientas
conceptuales (los nombres no son definitivos) y la ruta real que usaría cada una:

| Herramienta | Ruta real (`/api/v1`) |
|---|---|
| login / refresh | `POST /auth/login`, `POST /auth/refresh` |
| catálogo | `GET /rulesets`, `GET /catalog/versions`, `GET /maps`, `GET /maps/{id}/versions/{v}/content` |
| crear bot / loadout | `POST /bots`, `POST /bots/{id}/loadouts` |
| crear versión | `POST /bots/{id}/versions` (multipart) o `…/versions/{v}/actions/clone` |
| build / estado y logs | `POST …/versions/{v}/actions/submit`, `GET /builds/{buildId}`, `GET …/versions/{v}/builds` |
| versión / diff | `GET /bots/{id}/versions/{v}`, `…/diff?against=N`, `…/files` |
| publicar / retirar | `…/actions/publish`, `…/actions/retire` |
| equipo | `POST /teams`, `POST /teams/{id}/bots` |
| batalla | `POST /battles`, `GET /battles/{id}` |
| estadísticas / replay | `GET /battles/{id}/stats`, `GET /replays/{id}`, `…/index`, `…/segment`, `POST /replays/{id}/verify` |

Lo que limita hoy a un MCP no es la API, sino lo que la rodea:
- falta un token de máquina (G-11);
- la especificación no se sirve (G-10);
- el build no detecta bots inertes (G-05);
- no hay diagnóstico en batalla (G-07).

**Token de desarrollador (diseño futuro, no implementado).**
- **Formato y almacenamiento:** un token por usuario con prefijo reconocible. En la base de datos sólo se guarda su hash, y el token se muestra una única vez.
- **Scopes:** lectura de bots, escritura de bots, envío de builds, creación de batallas y lectura de replays. Nunca administración. El permiso efectivo es el mínimo entre el rol del usuario y el scope.
- **Ciclo de vida:** caducidad obligatoria, revocación individual, `last_used_at`, rotación con solape, límites propios y presupuesto diario de builds y batallas.
- **Trazabilidad:** registro en el audit log con el id del token.
- **Creación:** exige reautenticación fuerte.
- **Validación:** el mismo middleware que hoy valida las sesiones, revocación incluida.

## Perfil de RAM

Medido en producción el 2026-10-27, con memoria por contenedor (cgroup `memory.current` y
`memory.peak`) muestreada cada 2 s, y memoria anónima por proceso. Secuencia: IDLE → 2 builds →
batalla de 2 bots → POST. No se cambió ningún límite.

| SERVICE | IDLE RAM | PEAK RAM (histórico desde la RC4) | BUILD PEAK | BATTLE PEAK | NECESSARY? | OPTIMIZATION OPPORTUNITY |
|---|---|---|---|---|---|---|
| postgres | 75 | 98 | 83 | 97 | sí | ninguna relevante |
| queue (redis) | 18 | 34 | 18 | 18 | sí | — |
| api | 141 | 206 | 141 | 144 | sí | arranque sin `npm exec`/`tsx`/`esbuild` (ver abajo) |
| gateway | 5 | 15 | 5 | 5 | sí | — |
| web | 4 | 14 | 4 | 4 | sí | — |
| arena-engine | 103 | 119 | 105 | 103 | **a verificar**: la API ya no le llama por `/run` (TD-039), pero sigue siendo consumidor autorizado del proxy | inventariar sus consumidores reales antes de decidir |
| tournament-worker | 110 | 178 | 111 | 120 | sí | arranque |
| bot-manager | 86 | 95 | 85 | 85 | sí | arranque |
| bot-build-worker | 93 | 150 | 94 | 93 | sí | arranque; concurrencia de builds 1 (medido: builds en serie) |
| replay-service | 98 | 108 | 98 | 98 | sí | arranque |
| map-service | 86 | 96 | 86 | 86 | **dudoso**: ya registrado como TD-017 | retirar del perfil o fusionar |
| backup | 2 | 53 | 2 | 2 | sí (cron) | — |
| contenedor de bot (temporal) | — | 18 | 18 (1 a la vez) | 18 × 2 | sí | — |
| **Total de la pila** | **~820** | — | **~845** | **~868** | | |

MiB. Tras la batalla (POST) la pila vuelve a unos 835–845 MiB, y el swap de la VM se mantuvo en 0
durante todo el perfil.

**Hallazgos:**
- **Arranque duplicado de Node.** Cada uno de los 7 servicios Node arranca 4 procesos:
  1. `npm exec`, ~20–25 MiB anónimos;
  2. un envoltorio de `tsx`, ~8–9 MiB;
  3. el proceso real con el *loader* de `tsx`;
  4. un servicio `esbuild` que transpila TypeScript en tiempo de ejecución, ~9–14 MiB.

  Sólo el tercero ejecuta lógica: los otros tres suman ~40–48 MiB por servicio, **~300 MiB de los ~820** de la pila en reposo. Compilar a JavaScript en la imagen y arrancar `node` directamente es la mayor oportunidad dentro de la aplicación.
- **Builds y batallas son baratos:** +25 y +48 MiB. Con estos números la RAM de la propia
  aplicación no explica la presión de memoria vista en ventanas anteriores.
- **La VM de la aplicación usa muy poca memoria propia** (<1 GiB de la pila), pero mantiene
  ~11–12 GiB de caché de páginas del sistema invitado. En un hipervisor con memoria
  sobrecomprometida, esa caché sí ocupa memoria física. La palanca principal es de dimensionado de
  la VM y del *ballooning*, no de la aplicación. Es una recomendación para el operador; no se ha cambiado nada.

## Datos de auditoría en producción

Todo lo creado lleva el prefijo `AUDIT-` / `s9audit-…@example.invalid`:
- 5 cuentas;
- 9 bots;
- 5 equipos;
- 7 batallas de práctica.

El inventario por id es interno. Los bots se crearon privados; las batallas se pueden ver en el listado público por la misma clase de fallo descrita en G-08.

Hay vía pública para borrar **equipos** y cerrar sesiones; no la hay para borrar cuentas, bots,
versiones ni batallas (G-25). Ver el estado de la limpieza en el informe interno.

## Documentación relacionada

- Estado vigente: [../../roadmap/current-status.md](../../roadmap/current-status.md)
- Deuda técnica: [../../roadmap/technical-debt.md](../../roadmap/technical-debt.md) (TD-012, TD-017, TD-039, TD-041 y TD-047)
- Auditoría anterior: [../2026-10-15/README.md](../2026-10-15/README.md)
- Bots: [../../user/bots.md](../../user/bots.md) · [../../technical/bots.md](../../technical/bots.md) · [protocolo](../../../packages/protocol/README.md)
- API: [../../technical/api.md](../../technical/api.md) · [contrato](../../../apps/api/openapi.yaml)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Producción en `f32ab2c` | RUNTIME_VERIFIED | `GET /api/v1/version` por la ruta pública |
| Ciclo completo en el navegador y por HTTP | RUNTIME_VERIFIED (producción) | carriles C y E y REVIEW: builds, batallas, estadísticas y replays reales |
| Iteración por IA que cambia el resultado | RUNTIME_VERIFIED (producción) | carril E: empate con v2 → victoria con v3 (v2 sigue publicada) |
| Bot inerte validado y publicado | RUNTIME_VERIFIED (producción) | REVIEW y C; código del pipeline de build |
| Arena sin perímetro | CODE_VERIFIED + RUNTIME_VERIFIED | `maps/mvp-arena-01.json` (sólo 3 muros interiores); conversión del mapa sin bordes; posiciones fuera del mapa en un replay real |
| TypeScript rechazado en el build | CODE_VERIFIED + RUNTIME_VERIFIED | análisis estático del build; build real rechazado |
| Autorización de objeto | RUNTIME_VERIFIED (producción) | 39 pruebas con dos cuentas: 32 PASS; los 7 fallos son de la clase TD-047/TD-041 |
| Perfil de RAM | RUNTIME_VERIFIED (producción) | muestreo de cgroups cada 2 s en las cuatro fases |
| SDK no publicado en PyPI ni npm | RUNTIME_VERIFIED | consultas a los registros: 404 |

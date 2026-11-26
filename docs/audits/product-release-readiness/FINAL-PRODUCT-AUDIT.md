# Auditoría integral de producto · S9 AI Arena

**Sujeto:** rama `main`, commit `8f380eb` (motor 0.5.0) · **Fecha:** 2026-11-19 · **Estado:** FASE 1 (análisis estático) completada y revisada; FASE 2 (laboratorio y lectura de producción) pendiente.
**Veredicto global:** **NO LISTO** para presentación pública · Opción recomendada: **A+** (versión mínima presentable).

Este es el documento maestro. Se lee de principio a fin sin necesidad de los anexos; cada capítulo enlaza al anexo con el detalle completo. Cada problema se explica en dos niveles: una **explicación general**, para quien decide, y una **solución técnica**, para quien implementa.

## Índice

- [1. Resumen ejecutivo](#1-resumen-ejecutivo)
- [2. Estado actual del proyecto](#2-estado-actual-del-proyecto)
- [3. Puntos fuertes del proyecto](#3-puntos-fuertes-del-proyecto)
- [4. Puntos débiles y riesgos](#4-puntos-débiles-y-riesgos)
- [5. Auditoría del motor y del sistema de juego](#5-auditoría-del-motor-y-del-sistema-de-juego)
- [6. Backend, API y base de datos](#6-backend-api-y-base-de-datos)
- [7. Web, usabilidad y experiencia del jugador](#7-web-usabilidad-y-experiencia-del-jugador)
- [8. Instalación, configuración y administración](#8-instalación-configuración-y-administración)
- [9. Seguridad](#9-seguridad)
- [10. Replays, espectador y streaming](#10-replays-espectador-y-streaming)
- [11. Pruebas y CI](#11-pruebas-y-ci)
- [12. Documentación y preparación para publicar](#12-documentación-y-preparación-para-publicar)
- [13. Deuda técnica](#13-deuda-técnica)
- [14. Plan para cerrar una versión presentable](#14-plan-para-cerrar-una-versión-presentable)
- [15. Veredicto final de la auditoría](#15-veredicto-final-de-la-auditoría)
- [Anexo · Glosario](#anexo--glosario)

---

## 1. Resumen ejecutivo

> Capítulo de síntesis, pensado para leerse solo. El análisis detallado de cada área, con su solución técnica, está en los capítulos 2 a 13.

### 1.1 Qué es S9 AI Arena

S9 AI Arena es una plataforma de combates entre bots. Cada jugador escribe un pequeño programa (en Python o JavaScript) que controla un vehículo, lo equipa con chasis, armas, sensores o radio, y lo enfrenta a los de otros jugadores en una arena 2D. El motor de simulación es **determinista**: en la misma plataforma, la misma batalla da siempre el mismo resultado, de modo que se puede repetir, verificar y ver de nuevo como *replay*.

La plataforma incluye:
- Una web para jugadores y administradores.
- Batallas individuales y por equipos.
- Torneos, clasificaciones y estadísticas.
- Espectador en directo, con retardo para no adelantar el resultado.
- Retransmisión a YouTube.
- Exportación e importación de bots y equipos.
- Despliegue con Docker en un único servidor: 13 servicios, con copias de seguridad en un almacenamiento externo.

### 1.2 En qué estado se encuentra

Se ha auditado la rama principal del código (`main`, versión `8f380eb`, motor 0.5.0, del 18-nov-2026). Ese código **funciona en sus pruebas automáticas**. Las pruebas que se ejecutan en cada cambio están en verde, e incluyen un recorrido completo en navegador real: registro, bot propio, compilación aislada, batalla y replay.

Según su propio informe, el operador reinstaló la producción desde cero con esa versión el 19-nov. **La auditoría no ha podido comprobarlo**: ese día la producción seguía en plena migración (importando y compilando los bots de los usuarios) y, por norma, no se tocó. Que las pruebas automáticas estén en verde **no demuestra** que la producción funcione.

| Parte | Estado |
|---|---|
| Motor, reglas, equipamiento, batallas 1v1 y por equipos, torneos, ranking, replays | **Implementado y cubierto por pruebas**, con huecos concretos: un caso de torneo atascado sin salida, replays de motores anteriores que no se abren y estadísticas sin control de versión. En la matriz figura como PARCIAL |
| Compilación y ejecución aislada de bots | **Implementado**. El aislamiento de red no está demostrado (ver 1.5) |
| Web de jugador y de administración | **Implementada en lo esencial**, con carencias de uso (ver 1.6) |
| Streaming a YouTube (V1) | **Integrado en el código**. La emisión real está documentada por el operador, no verificada. Sin prueba de emisiones largas: función *experimental* |
| Streaming V2 / Broadcast Manager, nuevas visualizaciones | **Sólo diseño** |
| Recuperación de contraseña, notificaciones, correo, moderación | **Pendiente** o a medias |
| Instalación por terceros, release publicada, licencia | **Pendiente** |

Matriz completa en el [capítulo 2](#2-estado-actual-del-proyecto).

### 1.3 Principales fortalezas

- **Un motor serio.** Es reproducible en la misma plataforma (no se ha probado entre procesadores distintos) y está protegido contra fuentes de azar no controladas. Los replays van atados a la versión exacta del motor. Esto hace creíbles los resultados y los torneos.
- **Ejecutar código ajeno con cuidado.** El contenedor de cada bot no tiene privilegios, su disco es de sólo lectura y sus llamadas al sistema están filtradas. Ningún servicio tiene acceso libre a Docker: un *proxy* sólo permite las operaciones necesarias.
- **Una base de servidor sólida.** La cola de trabajos tiene reintentos y rescate de tareas colgadas. El contrato de la API no puede desincronizarse del código. Todas las migraciones de base de datos tienen vuelta atrás, aunque algunas pierden datos al revertirse.
- **Una cultura de pruebas exigente.** Hay miles de pruebas. En las revisiones se usaron *mutantes* (fallos introducidos a propósito) para comprobar que las pruebas detectan errores reales, aunque no se ejecutan de forma automática.

Detalle en el [capítulo 3](#3-puntos-fuertes-del-proyecto).

### 1.4 Principales debilidades

Las debilidades no están en el núcleo técnico, sino en **todo lo que lo rodea**:
- Instalarlo.
- Empezar a jugar.
- Recuperar una cuenta.
- Saber qué falla.
- Publicarlo.

Y en la **fiabilidad de algunas señales**: una prueba de seguridad que no puede fallar y una batería de pruebas nocturna rota desde agosto. La rotura estaba anotada como deuda, pero nada la bloquea y se ha normalizado. Detalle en el [capítulo 4](#4-puntos-débiles-y-riesgos).

### 1.5 Problemas importantes

| # | Problema | Por qué importa |
|---|---|---|
| 1 | **La instalación documentada no juega batallas** (OPS-01) | Quien siga la guía obtiene un sistema que parece sano pero donde ninguna batalla arranca. Falta configurar un componente del servidor que la guía presenta como «opcional». |
| 2 | **No hay licencia** en un repositorio público | Legalmente nadie puede usar, modificar ni contribuir al código. Bloquea cualquier presentación. |
| 3 | **El README dice que el producto «no funciona»** | La portada del proyecto describe la situación de octubre, 586 cambios atrás. |
| 4 | **La prueba de aislamiento de red de los bots no puede fallar** (REV-01) | Se ejecuta en una red vacía, así que siempre sale bien. En la red real, los bots comparten red con servicios internos. No se ha demostrado un ataque, pero tampoco la protección. |
| 5 | **La batería nocturna lleva rota desde el 4 de agosto** | Último resultado verde el 4 de agosto; desde entonces, 111 fallos en las últimas 129 ejecuciones. Los errores que sólo detectan las pruebas lentas pueden estar pasando desapercibidos. El arreglo es pequeño. |
| 6 | **Registro abierto a cualquiera, sin interruptor, y sin recuperación de contraseña** | Quien instale el sistema lo deja abierto sin saberlo, y quien olvide su contraseña pierde la cuenta salvo que el operador edite la base de datos. |
| 7 | **El primer administrador se crea con SQL** y la plantilla de configuración trae valores erróneos y datos de la instalación del operador | Una persona ajena no sabría hacerlo, y la plantilla la lleva a errores. |
| 8 | **Una instalación nueva está vacía y la primera batalla exige dos bots propios** | Un recién llegado no puede jugar enseguida. |

### 1.6 Preguntas clave

- **¿Se puede instalar fácilmente?** **No, hoy no.** La documentación es extensa y honesta, pero no lleva a un sistema que juegue. Además exige conocimientos que no explica: instalar un componente en el servidor como administrador, un cortafuegos, Node y SQL. Con el trabajo del grupo A, la respuesta debería ser «sí, con conocimientos básicos de Linux y Docker», y debe demostrarlo una persona ajena. No se ha medido cuánto se tarda. Ver el [capítulo 8](#8-instalación-configuración-y-administración).
- **¿Está preparado para nuevos usuarios?** **No del todo.** La web explica el juego y tiene ayuda y primeros pasos, pero faltan rivales de práctica, recuperación de cuenta, notificaciones y un editor de código cómodo. No se ha probado con personas reales. Ver el [capítulo 7](#7-web-usabilidad-y-experiencia-del-jugador).
- **¿Parece suficientemente estable?** **El código sí, en sus pruebas.** La estabilidad en producción, bajo carga, en torneos largos y en emisiones largas **no está medida**. Los errores conocidos de torneos atascados y tiempos de espera están corregidos en el código; queda un caso raro sin salida, el torneo `closed` atascado. Ver los capítulos [6](#6-backend-api-y-base-de-datos) y [11](#11-pruebas-y-ci).

### 1.7 Evaluación global: **NO LISTO**

Hay bloqueantes concretos para presentar el producto (tabla 1.5). Además, la producción, la instalación medida, la restauración de backups y el streaming real están en **EVIDENCIA INSUFICIENTE** hasta que se ejecute la segunda fase de la auditoría en laboratorio. El veredicto por áreas está en el [capítulo 15](#15-veredicto-final-de-la-auditoría).

### 1.8 Qué falta para una versión presentable

Se recomienda la **opción A+**: una versión mínima pero honesta, presentada como *software autoalojable v0.x, en español, para un solo servidor*, con registro por invitación y streaming marcado como experimental. En resumen, hace falta:

1. **Decisiones del propietario**: licencia (la primera), política de registro, alcance del streaming, cierre de los PR de revisión y publicación de versiones.
2. **Instalación que funcione a la primera**:
   - plantilla de configuración correcta;
   - guía con todos los pasos obligatorios;
   - instalador del servidor;
   - versión publicada con sus componentes;
   - comando para crear el administrador;
   - comprobador que juegue una batalla de prueba.
3. **Protección por defecto**: registro cerrado o por invitación, cabeceras de seguridad de la web, reset de contraseña por el administrador y cambio de contraseña por el usuario.
4. **Primer uso sin fricción**: bots de práctica en toda instalación nueva.
5. **Evidencia fiable**:
   - arreglar la batería nocturna (7 noches seguidas en verde);
   - rehacer la prueba de aislamiento de red para que pueda fallar;
   - escanear las imágenes de los servicios.
6. **Escaparate**: README veraz con capturas, repositorio limpio y limitaciones escritas.
7. **Demostración en laboratorio**: un ensayo de restauración de backup y **una persona ajena que lo instale sólo con la documentación hasta jugar una batalla**.

Esfuerzo estimado, como suma de estimaciones y no como medición: **23 a 62 días de trabajo de una persona**, repartibles en siete líneas paralelas. A eso se suma el calendario: decisiones, siete noches de pruebas y el ensayo con una persona ajena. Plan en el [capítulo 14](#14-plan-para-cerrar-una-versión-presentable).

### Conclusión ejecutiva

S9 AI Arena tiene un **núcleo técnico de calidad**. El motor, el aislamiento de los bots, el servidor y las pruebas están por encima de lo habitual en un proyecto de este tamaño, y **no necesitan rediseño**. Lo que lo separa de un producto estable, fácil de instalar y presentable es, sobre todo, **trabajo de producto y de verificación**, no de reescritura:
- que la instalación documentada funcione de verdad;
- que una instalación nueva sea segura por defecto;
- que un recién llegado pueda jugar sin programar dos bots;
- que las pruebas que dan confianza puedan efectivamente fallar;
- que el proyecto tenga licencia, versión publicada y una portada veraz.

El camino más corto y seguro empieza por:
1. Las decisiones del propietario, empezando por la licencia.
2. La segunda fase de esta auditoría en laboratorio.
3. Los 26 trabajos del grupo A, en paralelo.
4. Una versión congelada y demostrada con los 21 criterios de la [Definition of Done](12-RELEASE-DEFINITION-OF-DONE.md), incluida una instalación real por alguien ajeno al proyecto.

Streaming V2 y las mejoras visuales deben esperar a después del lanzamiento.

---

## 2. Estado actual del proyecto

Sujeto: rama `main`, commit 8f380eb, 2026-11-19. Fase 1 (estática) de la auditoría: se ha leído código, documentación y resultados de CI; no se ha ejecutado nada ni se ha tocado producción. Fuentes de detalle: [01-PROJECT-INVENTORY.md](01-PROJECT-INVENTORY.md) y [02-FUNCTIONAL-MATRIX.md](02-FUNCTIONAL-MATRIX.md).

### 2.1 Qué se ha analizado

El producto completo tal y como está en `main`: los servicios del `docker-compose`, los módulos del monorepo (`apps/`, `packages/`, `runtimes/`, `sdks/`, `infrastructure/`, `docs/`), las 22 migraciones de base de datos, el contrato de API (OpenAPI 0.25.0, 106 operaciones), los seis flujos de CI y los informes del operador sobre su reinstalación de producción. Se separa siempre entre cuatro grados de evidencia:

- **Comprobado en código**: leído en el commit 8f380eb.
- **Comprobado en pruebas de CI**: hay una ejecución de CI sobre ese commit con su resultado. Ojo: la CI es el sistema que ejecuta las pruebas automáticamente en cada cambio, y sólo demuestra lo que esas pruebas ejercen.
- **Declarado por el operador**: informes de su reinstalación de producción; la auditoría **no los ha verificado**.
- **Sólo documentado / no verificado**: afirmado en un documento, sin contraste.

### 2.2 Qué está bien diseñado

El resumen de lo que se sostiene con evidencia está en el [capítulo 3](#3-puntos-fuertes-del-proyecto). Para entender el estado actual basta saber que la base técnica (motor determinista, cola de trabajos en base de datos, sandbox de bots y contrato de API que gobierna los permisos) está bien construida y no se ha encontrado ningún defecto de severidad P0. Lo que falta es sobre todo producto y empaquetado: licencia, README veraz, instalación que llegue a ejecutar batallas, release y escaparate del repositorio.

### 2.3 Qué funciona

#### 2.3.1 Arquitectura explicada sin jerga

Imagine una arena de combate por ordenador. Los jugadores programan robots (bots), los equipan con piezas de un catálogo y los hacen pelear. La plataforma hace posible ese ciclo y lo registra de forma que cualquier combate se pueda repetir igual en la misma plataforma (replay; entre máquinas distintas aún no está comprobado) y comprobar que nadie ha hecho trampas.

Recorrido de una petición típica:

1. El jugador abre la **web** en su navegador. Todo el tráfico entra por el **gateway**, la única puerta de la instalación.
2. La web habla con la **API**, que es el «cerebro administrativo»: cuentas, bots, equipos, torneos y permisos.
3. La API guarda todo en la **base de datos** (Postgres). La misma base de datos actúa como **cola de trabajos**: pedir una batalla es apuntar un trabajo en una lista. Redis es un aviso opcional para que los trabajadores no tengan que preguntar constantemente.
4. Los **trabajadores** (workers) cogen trabajos de esa lista. Uno valida y construye los bots dentro de un entorno aislado (sandbox) y firma el resultado; otro ejecuta las batallas y torneos.
5. El **motor** simula el combate. En producción no es un servicio aparte: el trabajador de batallas lo ejecuta dentro de su propio proceso.
6. Cada bot corre en un **contenedor efímero** (una caja aislada y desechable) que se comunica con el motor por un canal de red interno. Esos contenedores los crea el **proxy de Docker del host**, un pequeño programa instalado en la máquina que sólo permite crear cajas de bots con límites estrictos; así ningún servicio necesita control total sobre Docker.
7. El resultado se guarda como **replay**, y el servicio de replays lo almacena y puede volver a simularlo para verificarlo. El espectador en vivo y la emisión por **streaming** se alimentan de la misma batalla.
8. Un contenedor de **backup** copia periódicamente la base de datos a un almacenamiento externo que aporta el operador.

#### 2.3.2 Los 13 servicios de la instalación de referencia

La instalación de referencia (perfiles `production` y `streaming` del compose) tiene 13 servicios. El compose define además la plantilla de bot y una pila opcional de observabilidad de 8 componentes. README e `installation.md` dicen «12», que está desfasado (DOC-01/OPS-13).

| Servicio | Qué hace, en una frase |
|---|---|
| gateway | Única puerta de entrada (puertos 80/443): reparte el tráfico a web, API y espectador. |
| web | La interfaz que ve el usuario: consola de jugador, panel de administración y visor de batallas. |
| api | Gestiona cuentas, bots, equipos, torneos y permisos, y encola el trabajo pesado. |
| postgres | Base de datos principal; guarda también la cola de trabajos y la auditoría. |
| queue (Redis) | Aviso opcional entre servicios; si falta, los trabajadores consultan periódicamente. |
| tournament-worker | Ejecuta batallas y torneos, calcula clasificaciones y sirve el espectador en vivo. |
| arena-engine | El motor de simulación determinista; en producción lo usa el trabajador dentro de su proceso. |
| bot-build-worker | Valida y construye cada versión de bot en un sandbox y firma el resultado. |
| bot-manager | Gestiona las sesiones de sandbox pidiendo cajas al proxy de Docker del host. |
| replay-service | Guarda los replays y puede re-simularlos para verificar que son auténticos. |
| map-service | Gestiona mapas; está desplegado pero no se le conoce uso (deuda TD-017). |
| streamer (perfil `streaming`) | Abre el visor en un navegador virtual y emite el vídeo a una plataforma externa. |
| backup | Copia cifrada y periódica de la base de datos a un repositorio externo. |

Cómo se relacionan: web → gateway → API → base de datos y cola → workers → motor → contenedores de bots (a través del proxy de Docker del host); el streamer y el espectador beben de las batallas en curso; el backup mira sólo la base de datos. Las redes internas separan la parte pública, la de plataforma, la de datos y la de bots, con un matiz importante: los trabajadores con credenciales de base de datos comparten la red `arena` con los bots ([REV-01](03-STRENGTHS-WEAKNESSES.md#rev-01), SEC-04/REV-04; véase [capítulo 4](#4-puntos-débiles-y-riesgos)).

#### 2.3.3 Qué está integrado, probado, pendiente y sólo diseñado

| Situación | Qué contiene |
|---|---|
| **Integrado en `main` y con CI verde en el camino de PR** | Motor de combate 0.5.0 (la versión de la física está fijada con una huella digital para que no cambie sin aviso), grabaciones de batalla (replays) que se pueden volver a comprobar, cola de batallas, sandbox de bots, torneos (6 formatos), batallas 4v4, ranking por temporada, panel de administración, SDK JavaScript y Python 0.1.0, export/import portable, backup con restic, Streaming V1 a YouTube (función experimental: comprobado en código y pruebas unitarias; la emisión real sólo está documentada). Run de `ci` 44383512640 en success (28 jobs; incluye golden con navegador real, batalla real en contenedor y backup/restore sintético) |
| **Probado, con matices** | El «verde» de la CI incluye jobs vacíos (`deploy-staging`, `smoke-and-promote`: pasos que no hacen nada y aun así salen en verde); la prueba de aislamiento de red de los bots no puede fallar (REV-01); la nightly está roja desde el 2026-08-04 (111 fallos en las últimas 129 ejecuciones) porque a su flujo le falta ffmpeg (un programa de vídeo) y una función de aislamiento de Linux llamada userns (QA-01). El fallo estaba registrado (TD-019), pero no bloquea nada y se ha normalizado |
| **Pendiente (no hecho o hecho a medias)** | LICENSE, README veraz, instalación que llegue a ejecutar batallas, `create-admin`, release etiquetada, registro por invitación, recuperación de contraseña, rival de práctica, ensayo de restore completo (grupo A/B del backlog) |
| **Sólo diseñado** | Streaming V2 / Broadcast Manager (PR #275, documento), mejoras visuales Fase 0 (PR #253, documentos y un test de contrato; no existe Fase 1: sonido, texturas, niebla), Module Catalog v2 (PR #266), reanudación de batallas por checkpoint (ARQ-10) |

#### 2.3.4 Diferencias posibles entre `main` y producción

La auditoría **no ha leído producción**: su Fase 2 está bloqueada porque había una migración en curso el día de la auditoría. Lo que se sabe viene del informe de reinstalación del operador:

- Declara una reinstalación limpia sobre una imagen etiquetada con el commit 8f380eb, 13 contenedores, proxy, firewall y runtimes instalados, 8 operaciones reales de bots a través del proxy.
- Declara una copia de seguridad correcta, un restore real del volcado a una base temporal (40/40 tablas idénticas) y un export portable de 37/37 bots y 8/8 equipos.
- Declara el streaming desactivado y las claves de emisión sin migrar.

Nada de esto se ha reverificado. Que `main` esté en verde **no demuestra** que producción funcione. Quedan sin saber: versión realmente desplegada, qué replays antiguos se conservan (STR-03), jobs atascados, capacidad real y número exacto de intervenciones manuales de la reinstalación (D-18, abierta; se medirá en el escenario S01 de la Fase 2). Hay además una incidencia abierta de memoria/swap del host (#185).

#### 2.3.5 Matriz funcional completa

**Leyenda de estados** (sólo se usan estos siete):

| Estado | Significado |
|---|---|
| COMPLETA | Implementada e integrada en `main`, con evidencia y sin hueco relevante conocido para la versión presentable. |
| PARCIAL | Existe y funciona en su camino principal, con huecos concretos conocidos. |
| PENDIENTE | No existe o no es utilizable; hay que construirla. |
| DISEÑO | Sólo hay documento, ADR o PR de diseño; sin código integrado. |
| BLOQUEADA | No puede avanzar o comprobarse por una dependencia externa (aquí: la Fase 2 de laboratorio/producción, o decisión del propietario). |
| NO VERIFICADA | Hay código o declaración, pero esta auditoría no tiene evidencia propia de que funcione. |
| DESCARTADA | Decidido no hacerla o retirarla. |

| Funcionalidad | Estado | Evidencia | Qué falta |
|---|---|---|---|
| Simulación determinista (PRNG, hash de estado, lint) | PARCIAL | Código; `determinism-1000` pasa en la nightly 44519497401 | Determinismo entre CPU/versiones de Node sin probar (ARQ-11, hipótesis) |
| Física Rapier fijada por sha256 | PARCIAL | Código (`engine-deps.json`) | Arranque con wasm alterado sin ejecutar |
| Versionado de motor y rulesets | PARCIAL | Código, ADR-022/024 | Versión duplicada a mano sin test cruzado (ARQ-03) |
| Replay v2 y verificación | PARCIAL | Código; golden en CI | El job de estadísticas re-simula sin comprobar versión (ARQ-01) |
| Modos y rulesets (dm, tdm, ctf, zona, 4v4) | PARCIAL | Código | Resistencia sólo ejerce `dm_practice` (ARQ-04); CTF rechazado en torneos |
| Rendimiento por tick y memoria | NO VERIFICADA | Sin medición | Medir en laboratorio (ARQ-12) |
| Crear bot, editor, versiones, validación, publicación | PARCIAL | Código; golden con navegador real | Editor sin resaltado (UX-04); estados en inglés (UX-03) |
| Equipamiento y catálogo de módulos | PARCIAL | Código | Campos de catálogo sin efecto (TD-016); Catálogo v2 sólo diseño |
| Rival para el primer combate | PENDIENTE | `demo-teams` sólo por CLI de operador (V-05) | Bot «sparring» de la casa (UX-01, [T-13](13-PRIORITIZED-BACKLOG.md#t-13)) |
| Sandbox de bots: postura del contenedor | COMPLETA | Código del proxy; `container-proxy-e2e` en CI | Ninguna para la postura; la red va en la fila siguiente |
| Sandbox de bots: aislamiento de red | NO VERIFICADA | La prueba no puede fallar ([REV-01](03-STRENGTHS-WEAKNESSES.md#rev-01), V-07) | Rehacer la prueba en la red real ([T-16](13-PRIORITIZED-BACKLOG.md#t-16)) |
| Imágenes de servicio sin vulnerabilidades graves | NO VERIFICADA | 74 HIGH/CRITICAL de una medición anterior, no remedida (TD-031) | Escaneo con Trivy ([T-18](13-PRIORITIZED-BACKLOG.md#t-18)) |
| Cola de batallas (Postgres, lease, reintentos) | COMPLETA | Código; golden y docker-e2e en CI | Huérfanas y locks sin renovar (BE-13/14, hipótesis) |
| Batallas de práctica | PARCIAL | Código | Sin cuota ni autor registrado (REV-03) |
| Batallas 4v4 y radio de equipo | PARCIAL | Código; declarado en producción por el operador | Marca visual por bot (STR-15) |
| Ejecución real de bots en una instalación nueva | PARCIAL | `container-proxy-e2e` verde en CI; reinstalación declarada | La guía deja las batallas en `scheduled` (OPS-01, [T-08](13-PRIORITIZED-BACKLOG.md#t-08)) |
| Verificación de replay por API | PARCIAL | Código | Sin cuota para autenticados (REV-02) |
| Torneos: formatos, inscripción, cancelación | PARCIAL | Código; `e2e-mvp` en CI | Sin E2E de formatos distintos de eliminación simple |
| Torneo atascado en `closed` | PENDIENTE | Código | Salida de producto y runbook (BE-01, [T-19](13-PRIORITIZED-BACKLOG.md#t-19)) |
| Operar jobs `needs_review` | PENDIENTE | Sólo por SQL | Listar/reintentar/descartar (BE-02, [T-32](13-PRIORITIZED-BACKLOG.md#t-32)) |
| Reproductor web de replays | PARCIAL | Golden en CI | Replays antiguos devuelven el mismo 404 sin explicar (STR-03) |
| Espectador en vivo | PARCIAL | Código; apagado por defecto | Prueba de fuga E2E real y carga (STR-08) |
| Visitante anónimo / instancia vacía | PENDIENTE | Código | Primera impresión sin contenido (UX-01, DOC-10) |
| Accesibilidad del visor | NO VERIFICADA | Hipótesis (UX-10) | Alternativa textual del canvas |
| Streaming V1 (cadena web → API → streamer → RTMPS) | PARCIAL | Código y pruebas unitarias; emisión real en noviembre sólo documentada | Sesión larga, imagen congelada, color blanco (STR-01/02/05); se presenta como experimental |
| Streaming V1: operación en producción | NO VERIFICADA | Desactivado y claves sin migrar, declarado por el operador | Comprobar en Fase 2 (STR-17) |
| Streaming V2 / Broadcast Manager | DISEÑO | PR #275 | Decidir ir/no ir ([T-80](13-PRIORITIZED-BACKLOG.md#t-80)); no condiciona la versión |
| «Próxima ola» web/streaming/UX | DISEÑO | PR #286 | Revisar fechas y fusionar como plan |
| Panel de administración | PARCIAL | Código | Roles por UUID tecleado, sin baja de usuarios (UX-08) |
| Primer administrador | PENDIENTE | Sólo por SQL | `create-admin` (OPS-02, [T-11](13-PRIORITIZED-BACKLOG.md#t-11)) |
| Salud y métricas del día 2 | PARCIAL | `/healthz` devuelve `ok` fijo | Comprobar dependencias, métricas de cola (BE-03/04) |
| Moderación, baja de cuenta, términos | PENDIENTE | Recorrido no evaluado | [T-49](13-PRIORITIZED-BACKLOG.md#t-49), [T-62](13-PRIORITIZED-BACKLOG.md#t-62) |
| Notificaciones | PENDIENTE | No existen | [T-61](13-PRIORITIZED-BACKLOG.md#t-61) |
| Registro, login y sesión | COMPLETA | Código | Longitud mínima del secreto JWT (SEC-12) |
| Activar el 2FA (doble factor) y gestionar sesiones desde la web | PARCIAL | El servidor pide el 2FA en el login, pero no hay pantalla para activarlo ni para ver o cerrar sesiones; el 2FA no está demostrado de extremo a extremo (B-02) | Pantallas de seguridad de cuenta (UX/SEC, [T-14](13-PRIORITIZED-BACKLOG.md#t-14)) |
| Registro por invitación / cerrado | PENDIENTE | Hoy sólo abierto | Interruptor (SEC-02, [T-12](13-PRIORITIZED-BACKLOG.md#t-12)) |
| Cambio y recuperación de contraseña | PENDIENTE | `/auth/recover` crea el token y lo descarta | [T-14](13-PRIORITIZED-BACKLOG.md#t-14), [T-30](13-PRIORITIZED-BACKLOG.md#t-30) |
| Cabeceras de seguridad de la SPA | PENDIENTE | Código | [T-15](13-PRIORITIZED-BACKLOG.md#t-15) |
| Elo, clasificación de temporada, estadísticas | PARCIAL | Código, migración 018 | Política ante cambio de motor (ARQ-06); ranking real sin datos en instalación nueva |
| Visor Phaser, atlas y tinte de equipo | PARCIAL | Código | Marca por bot (STR-15) |
| Mejoras visuales Fase 0 (contrato) | DISEÑO | PR #253 | Decisión de producto ([T-81](13-PRIORITIZED-BACKLOG.md#t-81)) |
| Mejoras visuales Fase 1 (sonido, texturas, niebla) | DISEÑO | No existen | Fuera de la versión |
| SDK JavaScript y Python 0.1.0 | PARCIAL | Código; simulador local JS | Sólo desde el repo, sin licencia (UX-09, [T-71](13-PRIORITIZED-BACKLOG.md#t-71)) |
| SDK .NET y Java | PENDIENTE | Sólo README | Rotular o retirar |
| Referencia de API renderizada | PARCIAL | OpenAPI a mano | Publicación (DOC-12) |
| Instalación del stack | PARCIAL | Reinstalación declarada con 11 intervenciones manuales | Instalador de host y guía coherente ([T-08](13-PRIORITIZED-BACKLOG.md#t-08), [T-09](13-PRIORITIZED-BACKLOG.md#t-09)) |
| Instalación por una persona ajena | PENDIENTE | Ensayo D4 no hecho. Depende de las tareas A de instalación (T-06 a T-11) y además de la Fase 2 de laboratorio | [T-21](13-PRIORITIZED-BACKLOG.md#t-21) |
| `.env.example` y `smoke.sh` | PARCIAL | Código (V-04) | Plantilla correcta y humo real ([T-06](13-PRIORITIZED-BACKLOG.md#t-06), [T-07](13-PRIORITIZED-BACKLOG.md#t-07)) |
| Requisitos de hardware y SO | PENDIENTE | No declarados | [T-22](13-PRIORITIZED-BACKLOG.md#t-22) |
| TLS | PARCIAL | Autofirmado o proxy del operador | Receta documentada (OPS-09) |
| Actualización y rollback | PARCIAL | Procedimiento manual y seguro | `upgrade.sh`, prueba N-1 → N (OPS-08, [T-36](13-PRIORITIZED-BACKLOG.md#t-36)) |
| Desinstalación | PENDIENTE | No existe | OPS-10 |
| Observabilidad y alertas | PARCIAL | Perfil opcional; 11 alertas sin probar en instalación real | OPS-12 |
| Backup restic | PARCIAL | La mecánica está en código y `e2e-backup-sftp` pasa en CI con datos sintéticos; el operador declara que funciona, pero la auditoría no lo ha verificado y no se ha ensayado una restauración completa. Veredicto del informe: evidencia insuficiente | Aviso si no hay repositorio configurado (OPS-06); ensayo de restauración ([T-20](13-PRIORITIZED-BACKLOG.md#t-20)) |
| Restauración completa | PARCIAL | `restore.sh` + fases manuales; restore parcial declarado | Ensayo en host limpio (OPS-07, [T-20](13-PRIORITIZED-BACKLOG.md#t-20)) |
| Export/import portable | PARCIAL | Código; test en CI; 37/37 y 8/8 declarado por el operador | Límite de 60 versiones/h sin `Retry-After` (BE-07) |
| LICENSE | PENDIENTE | `license: null` | Decisión del propietario ([T-01](13-PRIORITIZED-BACKLOG.md#t-01)) |
| README y documentación de estado | PARCIAL | README dice «no funcional» (V-02) | [T-04](13-PRIORITIZED-BACKLOG.md#t-04) |
| Nightly (señal diaria de CI) | PARCIAL | Rota desde 2026-08-04 (V-03/V-06) | [T-17](13-PRIORITIZED-BACKLOG.md#t-17) |
| Release etiquetada | PENDIENTE | 0 tags, 0 releases | [T-10](13-PRIORITIZED-BACKLOG.md#t-10) |
| Mutantes, streaming real y visuales en CI | PARCIAL | Tests escritos, no ejecutados en ningún flujo | QA-02 |
| Purga del historial git de topología | DESCARTADA | Decisión del director | [T-90](13-PRIORITIZED-BACKLOG.md#t-90) |
| Jobs de staging que siempre se omiten | PARCIAL | Siguen en la CI saliendo «verdes» sin hacer nada (QA-04); la propuesta es retirarlos (DESCARTADA sólo cuando el operador lo decida y se ejecute T-91) | [T-91](13-PRIORITIZED-BACKLOG.md#t-91) |

### 2.4 Qué problemas existen

Esta sección es breve a propósito: los problemas con su explicación y su solución en dos niveles están en los capítulos temáticos y en el [capítulo 4](#4-puntos-débiles-y-riesgos) (transversales). Los que más pesan sobre el estado actual:

- **Instalación que no llega a ejecutar batallas** (OPS-01, P1, grupo A): [detalle](07-INSTALLATION-OPERATIONS.md#ops-01), [T-08](13-PRIORITIZED-BACKLOG.md#t-08).
- **Prueba de aislamiento de red vacía** (REV-01, P1, grupo A): [detalle](03-STRENGTHS-WEAKNESSES.md#rev-01), [T-16](13-PRIORITIZED-BACKLOG.md#t-16).
- **Documentación de estado desfasada** (DOC-01, P1, grupo A): [T-04](13-PRIORITIZED-BACKLOG.md#t-04).
- **Licencia ausente** (DOC-02, P1, grupo A): [T-01](13-PRIORITIZED-BACKLOG.md#t-01).
- **Nightly muerta** (QA-01, P2, grupo A): [T-17](13-PRIORITIZED-BACKLOG.md#t-17).
- **Estado de producción sin verificar** (hasta la Fase 2): [T-23](13-PRIORITIZED-BACKLOG.md#t-23).

### 2.5 Qué falta

- **Para la versión presentable A+ (grupo A):** las 26 tareas del grupo A del [backlog](13-PRIORITIZED-BACKLOG.md): 22 de implementación (T-01 a T-22, tres de ellas ensayos de laboratorio) y 4 de verificación de Fase 2 (T-23 a T-26). Estimación del backlog: 23–62 días-persona en total (19,5–52,5 son sólo la parte de implementación T-01 a T-22); es suma de estimaciones, no medición.
- **Fase 2 de la auditoría** ([T-23](13-PRIORITIZED-BACKLOG.md#t-23) a [T-26](13-PRIORITIZED-BACKLOG.md#t-26)): lectura de producción y laboratorio, hoy bloqueada por la migración en curso. Sin ella siguen sin conocerse: instalación por un tercero, restore completo, escaneo de imágenes, alcance real de red entre bots, coste de `verify`, sesión larga de streaming y estado real de producción.
- **Decisiones del propietario:** licencia, política de registro, destino de los PR abiertos (51, de ellos 29 «NO MERGEAR») y de #295 (reset competitivo), alcance del streaming.

### 2.6 Soluciones técnicas recomendadas

Resumen ordenado (el detalle está en los capítulos 5-13): primero el escaparate y la verdad documental (T-01, T-02, T-03, T-04, T-05); después el camino de instalación completo (T-06 a T-11); luego seguridad barata y visible (T-12, T-14, T-15) y la prueba de aislamiento calibrada (T-16, T-18); la señal de CI (T-17); y al final los ensayos de laboratorio (T-20 a T-22) y la Fase 2 (T-23 a T-26). Streaming V2 y las mejoras visuales no se tocan en este ciclo (T-80, T-81).

### 2.7 Prioridad e impacto en el cierre de la versión

Veredicto vigente: **NOT_READY para presentación pública hoy**, con **INSUFFICIENT_EVIDENCE** sobre producción, instalación medida, restore y streaming real hasta la Fase 2. La opción recomendada es A+ (autoalojable v0.x, en español, registro por invitación, streaming «experimental»). El camino es corto en código y largo en producto: ninguno de los bloqueantes del grupo A exige rediseñar el núcleo.

---

## 3. Puntos fuertes del proyecto

Regla de este capítulo: una fortaleza sólo figura si hay evidencia citada. Se distingue entre «bien diseñado» (comprobado en código) y «demostrado» (una prueba de CI que se ha visto pasar y que podría haber fallado). Nada de lo que se dice de producción cuenta como verificado por la auditoría. Detalle de origen: [03-STRENGTHS-WEAKNESSES.md](03-STRENGTHS-WEAKNESSES.md).

### 3.1 Qué se ha analizado

Se han revisado once ámbitos: arquitectura modular, motor determinista, seguridad, aislamiento de bots, gestión de datos, sistema de torneos, tests, CI, escalabilidad, documentación y mantenibilidad. Para cada uno se pregunta: ¿qué está bien decidido?, ¿qué evidencia lo respalda? y ¿merece de verdad llamarse fortaleza? Cuatro de ellos no lo merecen del todo (aislamiento de red, escalabilidad, parte de la CI y parte de la mantenibilidad), y se dice con claridad en 3.2.

### 3.2 Qué está bien diseñado

#### 3.2.1 Motor determinista y reproducibilidad (fortaleza real)

- **Qué está bien:** el determinismo se impone por construcción y no por convención. Un lint (`apps/arena-engine/scripts/lint-determinism.mjs`) vigila todo `src/` con cuatro exenciones justificadas; el generador de números aleatorios es propio, con flujos derivados por etiqueta; el estado se resume en un hash por componente, de modo que un fallo de verificación dice qué parte divergió. La física (Rapier) está fijada por sha256 y el motor se niega a arrancar si cambia.
- **Por qué es buena decisión:** un combate repetible igual en la misma plataforma (entre CPU o versiones de Node distintas no está probado, ARQ-11) permite verificar replays, detectar trampas, depurar y reproducir un fallo años después.
- **Beneficio:** confianza en el ranking y en los torneos; el replay es una prueba, no una grabación.
- **Evidencia:** comprobado en código (`rng.ts`, `sim/state-hash.ts`, `replay.ts`); el job `determinism-1000` pasa en la nightly 44519497401 (comprobado en pruebas, sólo ese job). Que un mutante ponga rojo el lint y el arranque con wasm alterado: **no ejecutados**.
- **Cómo conservarlo:** una sola subida de motor por «ola» (ADR-022/024), mantener el lint como puerta de CI y probar el determinismo entre CPU y versiones de Node cuando haya laboratorio (ARQ-11, hipótesis).

El verificador de replay distingue «versión distinta» de «manipulado» y la cabecera del replay ata motor, física, protocolo, runtime y catálogo. Contrapartida aceptada: cada subida de motor deja ilegible el histórico anterior (STR-04), y los consumidores que re-simulan sin comprobar versión pueden dar datos erróneos en silencio (ARQ-01, ver [capítulo 4](#4-puntos-débiles-y-riesgos)).

#### 3.2.2 Arquitectura modular (fortaleza parcial)

- **Qué está bien:** separación clara de responsabilidades en servicios (API, workers, motor, replays, proxy), con un único servicio que publica puertos (el gateway), la compilación de bots fuera de la API (la API encola; el worker construye en sandbox y firma el artefacto con ed25519) y el contrato OpenAPI como fuente de la autorización (`x-min-role`): rutas y roles se derivan del contrato y un test de conformidad corre en CI.
- **Por qué es buena decisión:** lo que ejecuta código de terceros queda lejos de lo que tiene credenciales; el contrato único evita que una ruta nueva nazca sin permiso declarado.
- **Evidencia:** comprobado en código (`infrastructure/docker-compose.yml`, `registry.ts`, `conformance.test.ts`).
- **Matiz honesto:** la modularidad es de procesos, no de paquetes. Sólo cinco módulos declaran dependencias `@s9/*`; el resto se importa por rutas relativas entre aplicaciones (la API importa del worker de torneos; el servicio de replays importa del motor y de la API). Es un monolito modular, no un grafo de paquetes independientes (ver [capítulo 4](#4-puntos-débiles-y-riesgos)).
- **Cómo conservarlo:** no «reorganizar por reorganizar»; extraer sólo lo compartido a `packages/` cuando una tarea lo exija.

#### 3.2.3 Gestión de datos y cola (fortaleza real)

- **Qué está bien:** la cola vive en Postgres con `FOR UPDATE SKIP LOCKED`, clave de deduplicación única, fallos clasificados (deportivo, infraestructura, no clasificado) con topes por clase, y un doble cerrojo en batalla (lease de 45 s bajo lock de job de 60 s, renovados juntos). 22 migraciones con `down`, con rollback acotado a una lista cerrada y un test por migración 016–022. Rate limit compartido en base de datos (sobrevive a reinicios) y `audit_log` de sólo inserción por trigger.
- **Por qué es buena decisión:** una sola base de datos con transacciones evita infraestructura extra (no hace falta un broker) y hace la cola auditable. Un único sistema que respaldar.
- **Beneficio:** si un worker muere a mitad de batalla, otro puede reclamar el trabajo sin duplicarlo; el historial no se puede reescribir desde la aplicación.
- **Evidencia:** comprobado en código (`queue.ts`, `battle-runner.ts`, `migrations.ts`); golden y docker-e2e verdes en la CI `ci` 44383512640.
- **Matices:** `down` de las migraciones 011, 018 y 019 pierde datos o reescribe una función compartida (BE-09); sin retención de `jobs` ni de `audit_log` (BE-10).
- **Cómo conservarlo:** mantener la cola en base de datos mientras haya un solo host; no introducir un broker sin una medición que lo pida.

#### 3.2.4 Sistema de torneos (fortaleza parcial)

- **Qué está bien:** seis formatos, inscripción individual y por equipos, cancelación idempotente y auditada, cierres con transacción y `FOR UPDATE`, rescate de torneos con batalla fallida (#299).
- **Evidencia:** comprobado en código (`tournaments.ts:853-895`); prueba `e2e-mvp` en CI.
- **No se puede llamar fortaleza completa:** un torneo `closed` queda atascado si `generate_schedule` se agota (BE-01), los jobs `needs_review` sólo se gestionan por SQL (BE-02) y no hay E2E de formatos distintos de eliminación simple. Lo bien hecho es la integridad transaccional; lo que falta es la operación (ver [capítulo 4](#4-puntos-débiles-y-riesgos)).

#### 3.2.5 Seguridad (fortaleza real en diseño; sin demostrar en red)

- **Qué está bien:** ningún servicio monta `docker.sock` (un escáner de compose lo impone en CI); el proxy de Docker permite sólo una lista de operaciones, exige imagen por digest, etiquetas de propiedad y límites (CPU, memoria, procesos, sin swap extra, usuario no root, todas las capacidades retiradas, sistema de ficheros de sólo lectura) y un perfil seccomp por lista de permitidos. Sesiones con token de 15 minutos en memoria, refresco opaco con rotación por familias y detección de reutilización; JWT que no arranca sin secreto; hash señuelo contra enumeración de usuarios en el login; secretos en ficheros 0400 y sin secretos versionados; clave de emisión del streaming sellada y desconocida para ffmpeg; entradas del espectador en vivo con tickets de un solo uso y proyección por audiencia; sin `pull_request_target` en la CI y `main` protegida con cuatro checks obligatorios, administradores incluidos.
- **Por qué es buena decisión:** reduce el daño de cualquier fallo individual y hace que lo grave (control de Docker, secretos) no dependa de la disciplina de cada servicio.
- **Evidencia:** comprobado en código y, en parte, en CI (escáner de compose, `container-proxy-e2e`). Permisos reales en el host y firewall aplicado: no verificados (Fase 2).
- **Cómo conservarlo:** mantener el escáner de compose y el proxy como único camino hacia Docker.
- **Lo que NO se puede decir:** que el sandbox está probado frente a la red (ver 3.3.1).

#### 3.2.6 Tests y CI (fortaleza parcial)

- **Qué está bien:** la suite es grande (485 ficheros y 6.869 tests en la nightly del 19-nov; 6.777 pasan, 86 saltados, 6 fallan por entorno). El gate `functional-e2e` es «fail-closed»: sin `if:` ni `continue-on-error`, y «saltado, cero tests o sin batalla real» hace fallar. Incluye un golden con navegador real (registro, build real, batalla real, replay). Los tests de backup se calibran con mutaciones de efecto distinguible (red, huella, autenticación, repositorio, checksum, snapshot corrupto): hay evidencia de que pueden ponerse rojos (6 mutaciones PASS en el log de la nightly). Las imágenes de producción son inmutables (`sha-<commit>`, `--no-build`) y la dependencia vulnerable pasa por un gate con excepciones que caducan (la actual el 2026-12-17).
- **Por qué es buena decisión:** que «sin tests reales» falle evita los falsos verdes que arruinan la confianza en la CI.
- **Evidencia:** comprobado en pruebas (run `ci` 44383512640, success con 28 jobs) y en código (`scripts/ci/assert-functional-e2e.mjs`).
- **Matices que impiden llamarla fortaleza plena:** la CI nocturna está rota desde el 2026-08-04 (111 fallos en las últimas 129 ejecuciones, QA-01; registrado como TD-019, pero no bloquea nada y se ha normalizado); dos jobs (`deploy-staging`, `smoke-and-promote`) salen verdes siendo no-op (QA-04); los mutantes (existen y se usaron en las revisiones, pero no corren en ninguna ejecución automática, QA-02), el streaming real, los visuales y el rendimiento del visor no corren en ningún flujo; la cobertura no tiene umbral. Ver [capítulo 8](08-TEST-QUALITY.md) y [capítulo 4](#4-puntos-débiles-y-riesgos).
- **Cómo aprovecharla:** conservar el gate fail-closed como patrón y aplicarlo a la nightly cuando se arregle ([T-17](13-PRIORITIZED-BACKLOG.md#t-17)).

#### 3.2.7 Documentación (fortaleza parcial)

- **Qué está bien:** `docs/` está organizada por audiencia, con 18 ADR indexados, un histórico separado y 12 páginas de programación de bots con ejemplos en Python y JavaScript. La documentación de operaciones es honesta con sus límites (marca FUNCIONA/PARCIAL/PENDIENTE y declara PRECONDITION/EFFECT/ROLLBACK). Cada documento declara su estado y enlaza la deuda técnica (TD-xxx).
- **Evidencia:** comprobado en código (lectura de `docs/`). La cifra «0 de 2.311 enlaces rotos» procede de un script no conservado: **no verificable**.
- **Matiz:** lo que ve primero un visitante (README) está desfasado y dice «no funcional» (DOC-01). Ver [capítulo 10](10-DOCUMENTATION-AUDIT.md).
- **Cómo conservarla:** mantener el hábito de ADR y de estado por documento; sólo hace falta actualizar la portada y el anclaje a un commit reciente.

#### 3.2.8 Backup y portabilidad (fortaleza de diseño)

- **Qué está bien:** copia con `pg_dump -Fc`, manifest sha256, secretos en un snapshot aparte y comprobación de que la copia existe (healthcheck a 26 h). Export/import de bots, versiones y equipos idempotente, reanudable, con `--dry-run` y verificación previa a la escritura.
- **Evidencia:** comprobado en código; `e2e-backup-sftp` y `e2e-restore-sftp-bootstrap` en CI (sintéticos). Restore parcial y export de 37/37 bots y 8/8 equipos: declarado por el operador, no verificado.
- **Matiz:** no hay restore completo ensayado en host limpio (OPS-07) y `forget --prune` es incondicional (OPS-06).

#### 3.2.9 Streaming V1 (fortaleza como herramienta de operador)

Implementado de punta a punta (panel → API → streamer → navegador virtual → ffmpeg → relé RTMPS con TLS verificado y failover) con puerta de render, vigilante de blanco y alertas. Los fallos históricos (pantalla blanca, director que cortaba antes del retardo, latidos) están corregidos en código. La emisión real en noviembre es sólo documental y se presenta como **experimental**; no es una fortaleza de cara al lanzamiento (ver 3.3.3).

### 3.3 Qué funciona... y qué NO merece llamarse fortaleza

#### 3.3.1 Aislamiento de bots: la postura sí, la red no

La postura del contenedor del bot (límites, capacidades retiradas, sólo lectura, seccomp) es una fortaleza comprobada en código. El **aislamiento de red no lo es**: la prueba que debería demostrarlo crea una red vacía y busca destinos que no existen en ella, así que «SANDBOX-BLOCKED» sale siempre (REV-01, confirmado por el director, V-07). En el compose real los trabajadores con credenciales de base de datos comparten red con los bots y dos bots pueden hablar entre sí (REV-04, no explotado). Hasta que la prueba se rehaga en la red real y con un control positivo, la afirmación «el sandbox está aislado en red» **no debe citarse como evidencia**. Remite al [capítulo 4](#4-puntos-débiles-y-riesgos) y a [T-16](13-PRIORITIZED-BACKLOG.md#t-16).

#### 3.3.2 Escalabilidad: no hay evidencia, hay un modelo de un solo host

El modelo soportado es un host con Docker Compose. Los límites del compose suman unos 19,5 CPU y 12,75 GiB (cálculo del autor, no reserva), no hay requisitos declarados y la propia documentación admite que tres batallas simultáneas ahogaron una instancia de 4 vCPU (#185). El gateway de espectador vive en el proceso del motor (STR-08) y el rendimiento por tick no se ha medido (ARQ-12). La cola en base de datos permite varios workers en teoría, pero **no se ha probado**. No es una fortaleza: es una incógnita. Ver [capítulo 4](#4-puntos-débiles-y-riesgos) y [T-22](13-PRIORITIZED-BACKLOG.md#t-22).

#### 3.3.3 CI nocturna y señal diaria

Ver 3.2.6: la señal diaria está muerta. Un rojo permanente oculta regresiones reales. No es fortaleza; es el primer arreglo barato ([T-17](13-PRIORITIZED-BACKLOG.md#t-17)).

#### 3.3.4 Mantenibilidad: mixta

Hay buenas prácticas (ADR, disciplina de evidencia, un frontend con una sola carcasa y errores clasificados en una función, accesibilidad comprobada con axe en navegador real), pero también una superficie grande para el tamaño del equipo (13 servicios de aplicación más la plantilla del bot, 8 de observabilidad, 22 migraciones, 106 operaciones, 18 ADR, unas 71 deudas registradas en 1.444 líneas), código muerto (`match.ts`, `checkpoint.ts`, `map-service`), la regla arma↔munición repartida en tres sitios (ARQ-07) y la versión del motor escrita a mano en varios sitios (ARQ-03). Se trata en el [capítulo 4](#4-puntos-débiles-y-riesgos).

#### 3.3.5 Una «fortaleza» que no lo es

La web interpreta la cabecera `Retry-After` de los 429, pero la API **nunca la emite**. Es una capacidad latente, no efectiva, y rompe el import portable de un operador con muchas versiones (BE-07).

### 3.4 Qué falta

Para que las fortalezas se conviertan en demostraciones: ver la prueba de red en rojo antes de verde ([T-16](13-PRIORITIZED-BACKLOG.md#t-16)), restaurar la nightly ([T-17](13-PRIORITIZED-BACKLOG.md#t-17)), un restore completo ensayado ([T-20](13-PRIORITIZED-BACKLOG.md#t-20)) y una medición de carga ([T-22](13-PRIORITIZED-BACKLOG.md#t-22), [T-25](13-PRIORITIZED-BACKLOG.md#t-25)).

### 3.5 Qué problemas existen

Este capítulo no desarrolla problemas; los matices de arriba se resuelven en el [capítulo 4](#4-puntos-débiles-y-riesgos) (transversales) y en los capítulos temáticos 5-13.

### 3.6 Soluciones técnicas recomendadas

Conservar y aprovechar: determinismo y hash por componente; cola transaccional; contrato OpenAPI como fuente de permisos; proxy de Docker como único camino hacia Docker; gate de CI fail-closed; mutaciones para calibrar pruebas (aplicarlas a la prueba de red y a la nightly). Corregir sólo lo que impide que una fortaleza sea demostrable (T-16, T-17, T-20, T-22).

### 3.7 Prioridad e impacto en el cierre de la versión

Las fortalezas reales no bloquean la versión; las cuatro «falsas» (red del sandbox, escalabilidad, nightly y escaparate) sí tocan el grupo A (T-16, T-17, T-22).

### Partes que no necesitan rediseño

Dicho expresamente, para no gastar esfuerzo donde no hace falta:

- **Motor determinista, hash de estado y formato de replay v2:** no necesitan rediseño; sí necesitan una política de temporadas (decisión, no código: [T-82](13-PRIORITIZED-BACKLOG.md#t-82)).
- **Cola de trabajos en Postgres y sus cerrojos:** no necesita rediseño ni un broker externo; sólo retención y métricas (T-64).
- **Contrato OpenAPI como fuente de autorización:** no necesita rediseño.
- **Proxy de Docker del host y postura del contenedor del bot:** no necesitan rediseño; sí una prueba de red que pueda fallar.
- **Sesiones y autenticación (JWT corto + refresco rotado):** no necesitan rediseño; sí un cambio de contraseña y una política de registro ([T-12](13-PRIORITIZED-BACKLOG.md#t-12), [T-14](13-PRIORITIZED-BACKLOG.md#t-14)).
- **Diseño del backup y del export portable:** no necesitan rediseño; sí aviso de configuración y un ensayo completo.
- **Estructura de `docs/` por audiencia y ADR:** no necesita rediseño; sí actualización de la portada.
- **Streaming V1:** no se rediseña en este ciclo (Streaming V2 queda en diseño, grupo D).

---

## 4. Puntos débiles y riesgos

Este capítulo reúne las debilidades **transversales**: las que atraviesan varias áreas y que un lector sin conocimientos técnicos debe conocer para decidir. No repite el detalle de los capítulos temáticos 5-13: resume y enlaza. En cada una se distingue entre **defecto confirmado** (visto en código o pruebas), **riesgo** (puede ocurrir; hay mecanismo pero no se ha visto) e **hipótesis** (sospecha sin comprobar). Fuentes: [03-STRENGTHS-WEAKNESSES.md](03-STRENGTHS-WEAKNESSES.md), [02-FUNCTIONAL-MATRIX.md](02-FUNCTIONAL-MATRIX.md), [13-PRIORITIZED-BACKLOG.md](13-PRIORITIZED-BACKLOG.md).

### 4.1 Qué se ha analizado

Las debilidades que se repiten en más de un área: complejidad, dependencias, acoplamiento, configuración manual, diagnóstico de errores, experiencia de usuario, documentación, rendimiento, automatización y componentes a medio integrar. Todo se refiere al commit 8f380eb. **Nada de producción está verificado por la auditoría** (Fase 2 bloqueada); lo que afecta a producción se marca como declarado por el operador o no verificable aún.

### 4.2 Qué está bien diseñado

El [capítulo 3](#3-puntos-fuertes-del-proyecto) detalla las fortalezas. Para leer éste con perspectiva: no se ha encontrado ningún defecto P0 ni un P1 con ruta de explotación concreta; las debilidades son sobre todo de empaquetado, operación y evidencia, no de diseño del núcleo.

### 4.3 Qué funciona

El camino feliz funciona en CI sobre 8f380eb (comprobado en pruebas): registro, construcción real de un bot, batalla real en contenedor, replay, backup y restore sintéticos. Cómo funciona la producción es «declarado por el operador» y no se ha reverificado. Ver [capítulo 2](#2-estado-actual-del-proyecto).

### 4.4 Qué problemas existen

#### 4.4.1 [REV-01 / SEC-04 / REV-04] Los bots comparten red con los componentes que tienen credenciales, y la prueba que lo vigila no puede fallar
**Prioridad:** P1 (REV-01), P2 (SEC-04, REV-04) · **Grupo de lanzamiento:** A (medición) y B (segmentación) · **Evidencia:** comprobado en código (la prueba y el compose); alcance real no verificable aún (FASE 2) · **Tarea:** [T-16](13-PRIORITIZED-BACKLOG.md#t-16), [T-39](13-PRIORITIZED-BACKLOG.md#t-39), [T-67](13-PRIORITIZED-BACKLOG.md#t-67)

**Explicación general.** Es el acoplamiento más delicado. El trabajador de torneos y el de construcción de bots (que tienen credenciales de la base de datos) comparten una red interna con los contenedores de los bots, y esa red es única para todas las batallas. La prueba que debería demostrar que un bot no ve esos servicios crea una red vacía y busca nombres que no existen en ella, así que siempre sale «bloqueado». **Defecto confirmado**: la prueba es vacía. **Riesgo**: que un bot alcance puertos del trabajador o a otro bot (saltándose reglas de radio y visión); no se ha demostrado ni descartado. Se confirma en el [detalle](03-STRENGTHS-WEAKNESSES.md#rev-01).

**Solución técnica.**
- Componente: `tests/sandbox-escape/run-escape-suite.sh`, `tests/sandbox-escape/bots/05_internal_network_scan.py`, `infrastructure/docker-compose.yml` (redes `arena`/`data`).
- Cambios: rehacer la prueba contra la red real del compose, con un destino que exista y un control positivo (algo que sí debe ser alcanzable) y un mutante que la ponga roja; después, red por batalla o `enable_icc=false`.
- Comportamiento esperado: la prueba falla si un bot alcanza el worker o a otro bot; la segmentación elimina el canal.
- Riesgos: la segmentación puede romper la conexión legítima bot↔worker; probar con el golden de navegador.
- Pruebas que lo demuestran: el mutante (red sin aislar) debe dar rojo; hoy no puede.
- Esfuerzo: M la prueba (alta incertidumbre); la segmentación es tarea separada del grupo B.

#### 4.4.2 [ARQ §5 / BE §6] Acoplamiento por imports relativos entre aplicaciones
**Prioridad:** P3 · **Grupo de lanzamiento:** C · **Evidencia:** comprobado en código · **Tarea:** [T-69](13-PRIORITIZED-BACKLOG.md#t-69)

**Explicación general.** Se presenta como un monorepo de paquetes pero sólo cinco módulos declaran dependencias `@s9/*`. El resto se enlaza por rutas relativas: el servicio de replays importa del motor y de la API, y la API importa del worker de torneos. **Riesgo** (no defecto actual): cambiar una aplicación puede romper otra sin que lo diga un gestor de paquetes, y extraer un servicio exigirá deshacer esos enlaces. El gateway de espectador, además, vive en el proceso del motor (STR-08), de modo que un pico de espectadores compite con el tick.

**Solución técnica.**
- Componente: `apps/replay-service`, `apps/api` (importa de `tournament-worker/src/results.ts`), `packages/`.
- Cambios: mover lo compartido (`leagueTable`, lectura de replays, conexión a BD) a `packages/` con dependencia declarada; no tocar lo que ya funciona.
- Comportamiento esperado: cada aplicación sólo depende de paquetes declarados.
- Riesgos: movimientos grandes de ficheros; hacer una pieza cada vez, con la suite verde.
- Pruebas que lo demuestran: un lint de dependencias que falle ante un import relativo entre `apps/*`.
- Esfuerzo: M, incertidumbre media. No urgente; no condiciona la versión.

#### 4.4.3 [OPS-01 / OPS-02 / OPS-04 / OPS-13] Configuración manual: la guía termina en un sistema «verde» que no ejecuta batallas
**Prioridad:** P1 (OPS-01 y OPS-04), P2 (OPS-02), P3 (OPS-13) · **Grupo de lanzamiento:** A · **Evidencia:** comprobado en código y documentación; la reinstalación del operador (11 intervenciones manuales) es declarada por él · **Tarea:** [T-08](13-PRIORITIZED-BACKLOG.md#t-08), [T-09](13-PRIORITIZED-BACKLOG.md#t-09), [T-06](13-PRIORITIZED-BACKLOG.md#t-06), [T-11](13-PRIORITIZED-BACKLOG.md#t-11)

**Explicación general.** Si alguien sigue la guía principal, el sistema arranca y las comprobaciones salen en verde, pero las batallas se quedan «en cola» (estado `scheduled`) y ningún bot llega a publicarse. La causa es que falta conectar la plataforma con el proxy de Docker (una pieza que hay que instalar aparte, con permisos de administrador del servidor). Arreglarlo exige una segunda instalación: el proxy, el cortafuegos y los entornos donde corren los bots. Además, la plantilla de configuración (`.env.example`) pide una versión que no existe y trae datos de la instalación de su autor; el primer administrador hay que crearlo escribiendo a mano una orden en la base de datos; y el orden de arranque deja un servicio reiniciándose sin parar. Los fallos tienen distinta gravedad: no poder ejecutar batallas (OPS-01) y la plantilla errónea (OPS-04) son P1; crear el administrador a mano (OPS-02) es P2; el servicio que se reinicia (OPS-13) es P3. **Defecto confirmado** en código y guía. El número real de intervenciones manuales (D-18) está abierto y se medirá en la Fase 2. Ver [detalle](07-INSTALLATION-OPERATIONS.md#ops-01).

**Solución técnica.**
- Componente: `docs/operations/installation.md`, `infrastructure/.env.example`, `infrastructure/scripts/` (nuevo `install-host.sh`), `apps/api/src/db/cli.ts` (nuevo `create-admin`).
- Cambios: un instalador de host con comprobaciones previas, plantilla limpia, orden `up → bootstrap` corregido, `create-admin`, aviso si falta el proxy.
- Comportamiento esperado: tras la guía, una batalla llega a `finished` sin tocar SQL.
- Riesgos: el instalador actúa como root: debe ser idempotente y mostrar lo que hará.
- Pruebas que lo demuestran: ensayo D4 con una persona ajena ([T-21](13-PRIORITIZED-BACKLOG.md#t-21)), y un humo que dé rojo si falta el proxy.
- Esfuerzo: M (instalador) + S (resto); incertidumbre media.

#### 4.4.4 [OPS-03 / TD-031 / SEC-05] Dependencias frágiles: Node reciente, bundle sin publicar e imágenes sin escanear
**Prioridad:** P1 (OPS-03, TD-031), P2 (SEC-05) · **Grupo de lanzamiento:** A (forma mínima) · **Evidencia:** comprobado en código; escaneo de imágenes no re-medido (74 HIGH/CRITICAL de una medición anterior) · **Tarea:** [T-10](13-PRIORITIZED-BACKLOG.md#t-10), [T-18](13-PRIORITIZED-BACKLOG.md#t-18), [T-37](13-PRIORITIZED-BACKLOG.md#t-37)

**Explicación general.** El proxy de Docker exige construir un bundle con Node 22.15 o superior, que Debian 12 no trae, y compararlo con un hash que sólo aparece en el resumen de una ejecución de CI, cuyos artefactos caducan y exigen sesión. Las seis imágenes Node usan una base por etiqueta (no por digest), incluyen dependencias de desarrollo y no se escanean. **Defecto confirmado** (empaquetado); el estado de vulnerabilidades es un **riesgo sin medir**.

**Solución técnica.**
- Componente: `.github/workflows/ci.yml`, Dockerfiles de las imágenes de servicio, release del repositorio.
- Cambios: publicar el bundle del proxy y su sha256 como asset de una release; escanear con Trivy; `--omit=dev` y base por digest.
- Comportamiento esperado: instalar el proxy sin Node ni sesión en CI; imágenes sin HIGH/CRITICAL corregibles.
- Riesgos: actualizar bases puede cambiar comportamiento; pasar `functional-e2e`.
- Pruebas que lo demuestran: informe Trivy adjunto y un gate que falle ante nuevos HIGH/CRITICAL.
- Esfuerzo: M (escaneo y release), S-M (endurecimiento); la medición es Fase 2.

#### 4.4.5 [BE-03 / BE-06 / BE-01 / BE-02] Errores difíciles de diagnosticar
**Prioridad:** P2 · **Grupo de lanzamiento:** B (runbooks en A) · **Evidencia:** comprobado en código · **Tarea:** [T-33](13-PRIORITIZED-BACKLOG.md#t-33), [T-63](13-PRIORITIZED-BACKLOG.md#t-63), [T-19](13-PRIORITIZED-BACKLOG.md#t-19), [T-32](13-PRIORITIZED-BACKLOG.md#t-32)

**Explicación general.** Cuando algo falla, el sistema lo esconde. La comprobación de salud (`/healthz`, la dirección que sirve para preguntar «¿estás bien?») contesta siempre «ok» sin mirar la base de datos. La señal de vida del trabajador de torneos puede salir en verde con el trabajador parado. En 35 sitios del código, un fallo de la base de datos se muestra al usuario como «no existe». Si un torneo se queda atascado o un trabajo queda pendiente de revisión humana (`needs_review`), la única forma de verlo o arreglarlo es escribir órdenes directamente en la base de datos. **Defectos confirmados**. Consecuencia: un operador sin conocimientos de bases de datos no sabrá si algo está roto o simplemente vacío.

**Solución técnica.**
- Componente: `apps/api/src/server.ts` (healthz), rutas con `.catch(() => null)`, `apps/tournament-worker`, panel de administración.
- Cambios: `/healthz` que compruebe base de datos y bucles; devolver 503 `db_unavailable` en lugar de 404; runbook SQL ahora y superficie de producto después.
- Comportamiento esperado: un fallo de base de datos se ve como tal; los jobs atascados se listan y se reintentan desde el panel.
- Riesgos: algunos tests fijan los mensajes actuales.
- Pruebas que lo demuestran: apagar la base de datos y comprobar que `/healthz` y el endpoint de bots devuelven error de servicio, no 404.
- Esfuerzo: S-M por pieza; M para la superficie de jobs.

#### 4.4.6 [DOC-01 / DOC-03 / STR-11 / STR-12] Documentación desactualizada que contradice al código
**Prioridad:** P1 (DOC-01), P2-P3 el resto · **Grupo de lanzamiento:** A (portada) y B (resto) · **Evidencia:** comprobado en código (V-02) · **Tarea:** [T-04](13-PRIORITIZED-BACKLOG.md#t-04), [T-46](13-PRIORITIZED-BACKLOG.md#t-46)

**Explicación general.** El README dice «no es funcional de extremo a extremo» (fechado 2026-10-18) y «12 servicios»; la portada de `docs/` y el roadmap están anclados a un commit 586 por detrás, con motor 0.4.0 frente a 0.5.0 y migración 016 frente a 022. La deuda TD-066 describe defectos que el código ya no tiene y la arquitectura de streaming aún marca YouTube como «BLOCKED». **Defecto confirmado**: el primer texto que lee un visitante le dice que el producto no sirve. Ver [capítulo 10](10-DOCUMENTATION-AUDIT.md).

**Solución técnica.**
- Componente: `README.md`, `docs/README.md`, `docs/roadmap/*`, `docs/technical/known-issues.md`.
- Cambios: reescribir el README con estado real y limitaciones, actualizar anclajes, retirar o corregir TD-066 y TD-015.
- Comportamiento esperado: cifras de la documentación = cifras del código.
- Riesgos: volver a desfasarse; añadir una comprobación en CI de versión del motor y número de servicios.
- Pruebas que lo demuestran: un test que cruce `engine-deps.json` con la documentación.
- Esfuerzo: S (README), M (resto).

#### 4.4.7 [UX-01 / UX-03 / UX-07 / UX-08 / STR-03] Experiencia de usuario confusa
**Prioridad:** P2 (UX-01 grupo A en forma barata; el resto B) · **Evidencia:** comprobado en código; usabilidad con personas no medida · **Tarea:** [T-13](13-PRIORITIZED-BACKLOG.md#t-13), [T-42](13-PRIORITIZED-BACKLOG.md#t-42), [T-43](13-PRIORITIZED-BACKLOG.md#t-43), [T-45](13-PRIORITIZED-BACKLOG.md#t-45)

**Explicación general.** En una instalación nueva no hay rival para el primer combate: hay que crear, equipar, validar y publicar un segundo bot. El anónimo ve una portada y un ranking vacío, con replays y espectador apagados por defecto. Los estados salen en inglés crudo, el ruleset de un torneo se teclea como texto libre, los roles se asignan por UUID y los replays antiguos devuelven el mismo 404 que uno inexistente. **Defectos confirmados en código**; el impacto real en personas es una **hipótesis** hasta medirlo con usuarios (UX §7.1, [T-70](13-PRIORITIZED-BACKLOG.md#t-70)).

**Solución técnica.**
- Componente: `apps/api/src/db/cli.ts` (bootstrap), `apps/web/src`, `apps/replay-service/src/segment.ts`.
- Cambios: bot «sparring» de la casa tras `bootstrap`; textos en español; selector de ruleset; mensaje explícito para replays de versión antigua; gestión de usuarios sin UUID tecleado.
- Comportamiento esperado: un recién llegado ve un combate en pocos pasos.
- Riesgos: el bot de la casa no debe contaminar ranking ni temporadas.
- Pruebas que lo demuestran: el golden de navegador desde instancia vacía hasta una batalla con el bot de la casa.
- Esfuerzo: M (bot) + S por pieza de pulido.

#### 4.4.8 [ARQ-12 / REV-02 / REV-03 / BE-12 / STR-08] Rendimiento sin medir y sin cuotas
**Prioridad:** P2-P3 · **Grupo de lanzamiento:** B condicional (REV-02 pasa a A si se mide más de 1 s con registro abierto) · **Evidencia:** riesgo; mecanismo comprobado en código, magnitud no verificable aún (FASE 2) · **Tarea:** [T-38](13-PRIORITIZED-BACKLOG.md#t-38), [T-22](13-PRIORITIZED-BACKLOG.md#t-22), [T-25](13-PRIORITIZED-BACKLOG.md#t-25), [T-64](13-PRIORITIZED-BACKLOG.md#t-64)

**Explicación general.** Nadie ha medido el coste por tick, la memoria en batallas largas ni la capacidad real de un host. Hay puntos sin freno: `POST /replays/{id}/verify` re-simula una batalla entera dentro de la API y sólo el usuario anónimo tiene cuota; las batallas de práctica no tienen cuota ni autor registrado y comparten cola con los torneos; los listados de torneos no se paginan y hacen N+1 consultas. La propia documentación admite que tres batallas simultáneas ahogaron una instancia de 4 vCPU (#185, abierta). Es un **riesgo**, no un defecto observado en una instalación de terceros.

**Solución técnica.**
- Componente: `apps/api` (verify, prácticas), `apps/tournament-worker`, `apps/arena-engine`.
- Cambios: medir primero en laboratorio; después cuotas por usuario, `created_by` en prácticas, paginación.
- Comportamiento esperado: ningún usuario puede saturar la cola ni la API; requisitos de hardware declarados con datos.
- Riesgos: cuotas demasiado estrictas bloquean uso legítimo.
- Pruebas que lo demuestran: prueba de carga con registro abierto que hoy degrada y con cuotas no.
- Esfuerzo: M (medición) + M (cuotas); incertidumbre alta hasta medir.

#### 4.4.9 [OPS-08 / OPS-14 / OPS-07 / QA-03] Falta de automatización: release, actualización y restauración
**Prioridad:** P1-P2 · **Grupo de lanzamiento:** A en forma mínima (release, un ensayo de restore), B el resto · **Evidencia:** comprobado en código (ausencia de scripts y tags) · **Tarea:** [T-10](13-PRIORITIZED-BACKLOG.md#t-10), [T-20](13-PRIORITIZED-BACKLOG.md#t-20), [T-35](13-PRIORITIZED-BACKLOG.md#t-35), [T-36](13-PRIORITIZED-BACKLOG.md#t-36)

**Explicación general.** No hay tags ni releases ni CHANGELOG: el operador elige un commit sin guía. Actualizar es un procedimiento manual de varios pasos (bajar las imágenes nuevas, arrancar los servicios por grupos y aplicar a mano los cambios de la base de datos), y la API no los aplica sola al arrancar, de modo que puede haber un rato con la base de datos en la versión vieja (hipótesis). Restaurar una copia exige fases manuales y el restore completo en host limpio **no se ha ensayado nunca**. No hay prueba automatizada de instalación ni de actualización con datos. **Defectos confirmados** (la ausencia); el riesgo es perder tiempo o datos en el peor momento.

**Solución técnica.**
- Componente: `.github/workflows/`, `infrastructure/scripts/` (`upgrade.sh`, `restore-all.sh`), `docs/operations/`.
- Cambios: release etiquetada con notas y digests; `upgrade.sh` con rollback; `restore-all.sh`; una prueba N-1 → N con datos.
- Comportamiento esperado: actualizar y restaurar con un comando documentado y comprobado.
- Riesgos: `down` de las migraciones 011, 018 y 019 pierde datos: el rollback debe dejarlo claro.
- Pruebas que lo demuestran: ensayo completo con acta ([T-20](13-PRIORITIZED-BACKLOG.md#t-20)) y test de actualización en CI.
- Esfuerzo: M-L en conjunto.

#### 4.4.10 [QA-01 / QA-02 / QA-04] Señal de calidad que engaña o falta
**Prioridad:** P2 · **Grupo de lanzamiento:** A (nightly), C el resto · **Evidencia:** comprobado en pruebas (run 44519497401) · **Tarea:** [T-17](13-PRIORITIZED-BACKLOG.md#t-17), [T-68](13-PRIORITIZED-BACKLOG.md#t-68), [T-91](13-PRIORITIZED-BACKLOG.md#t-91)

**Explicación general.** Cada noche se ejecutan las pruebas lentas (la «nightly»). Desde el 2026-08-04 no ha salido ni una vez en verde: 111 fallos en las últimas 129 ejecuciones. Siempre falla por lo mismo: a su configuración le falta instalar ffmpeg (un programa de vídeo) y activar userns (una función de aislamiento de Linux), cosas que la CI de cada cambio sí tiene. El fallo estaba registrado (TD-019), pero no bloquea nada, así que se ha normalizado y las pruebas lentas no dan señal desde agosto. Un rojo permanente enseña a ignorarlo. Además, dos pasos de la CI salen en verde sin hacer nada («no-op»), y las pruebas de mutación (cambios deliberados que comprueban que las pruebas detectan errores), el streaming real y las pruebas visuales no corren en ninguna ejecución automática. **Defecto confirmado**.

**Solución técnica.**
- Componente: `.github/workflows/nightly.yml`.
- Cambios: preparar ffmpeg y userns, fijar `ubuntu-24.04`, retirar o renombrar los jobs vacíos, planificar mutantes.
- Comportamiento esperado: 7 ejecuciones seguidas en verde (D13).
- Riesgos: pueden aparecer regresiones ocultas desde agosto; es deseable verlas.
- Pruebas que lo demuestran: la propia nightly, y un mutante que la ponga roja.
- Esfuerzo: S.

#### 4.4.11 [STR-01 / STR-02 / STR-14 / TD-016 / TD-017] Componentes parcialmente integrados
**Prioridad:** P2 (streaming V1), P3-P4 el resto · **Grupo de lanzamiento:** C-D · **Evidencia:** comprobado en código y diseño; emisión real sólo documental · **Tarea:** [T-60](13-PRIORITIZED-BACKLOG.md#t-60), [T-80](13-PRIORITIZED-BACKLOG.md#t-80), [T-69](13-PRIORITIZED-BACKLOG.md#t-69)

**Explicación general.** El streaming V1 está implementado de punta a punta pero sin evidencia de sesión larga (máximo 12 minutos medidos), sin detección de imagen congelada y con un defecto de color blanco sin diagnosticar; en la instalación nueva está desactivado y sin claves migradas. El Streaming V2 es un documento (PR #275), no producto. Hay también campos de catálogo sin efecto (TD-016), un servicio desplegado sin uso (`map-service`), código muerto en el motor (`match.ts`, `checkpoint.ts`), los SDK de .NET y Java reducidos a un README y el modo CTF rechazado en torneos. **Estado confirmado**; ninguno bloquea la versión si se presenta como experimental o se retira.

**Solución técnica.**
- Componente: `apps/streamer`, `docs/`, `sdks/`, `apps/map-service`.
- Cambios: rotular streaming como experimental; decidir ir/no ir de V2; retirar o rotular directorios vacíos y código muerto.
- Comportamiento esperado: lo que figura en la oferta existe y funciona; lo demás está marcado como diseño.
- Riesgos: retirar algo con un consumidor desconocido; comprobar con `grep` antes.
- Pruebas que lo demuestran: soak de 6-8 h en laboratorio ([T-60](13-PRIORITIZED-BACKLOG.md#t-60)).
- Esfuerzo: S (rotular) a XL (V2).

#### 4.4.12 Complejidad excesiva para el tamaño del equipo (riesgo)
**Prioridad:** P3 · **Grupo de lanzamiento:** C · **Evidencia:** comprobado en código (recuentos) · **Tarea:** [T-69](13-PRIORITIZED-BACKLOG.md#t-69), [T-68](13-PRIORITIZED-BACKLOG.md#t-68)

**Explicación general.** 13 servicios de aplicación (más la plantilla del bot) y 8 de observabilidad, 22 migraciones, 106 operaciones de API, unas 71 deudas registradas en 1.444 líneas, 18 ADR, unos 20 scripts de mutantes, y tres lenguajes en el producto más Docker, nginx e iptables. Contribuir es caro (el documento de contribución exige mutantes y controles negativos en cada PR, sin versión ligera para externos) y conviven `pnpm-workspace.yaml` y npm workspaces. **Riesgo de mantenimiento**, no defecto: nada de esto falla hoy. Reglas duplicadas (arma↔munición en tres sitios, ARQ-07; versión del motor a mano, ARQ-03) son los puntos donde la complejidad ya mordió una vez.

**Solución técnica.**
- Componente: `docs/contributing.md`, `CONTRIBUTING` en la raíz, validador de munición, `rules-doc.ts`.
- Cambios: versión ligera de contribución; una función compartida de munición; test que cruce la versión del motor.
- Comportamiento esperado: un externo puede abrir un PR con las comprobaciones mínimas.
- Riesgos: relajar la disciplina de calibración; mantenerla para el núcleo.
- Pruebas que lo demuestran: test de coherencia de versión y de munición.
- Esfuerzo: S-M.

#### 4.4.13 Evidencia de producción no reverificable (hipótesis)
**Prioridad:** — · **Grupo de lanzamiento:** A (en Fase 2) · **Evidencia:** declarado por el operador; no verificable aún (FASE 2) · **Tarea:** [T-23](13-PRIORITIZED-BACKLOG.md#t-23)

**Explicación general.** Todo lo que se sabe de la producción (reinstalación, backup, restore parcial, emisión real) viene de informes del operador. No se sabe qué versión corre, qué replays se conservan, si hay jobs atascados ni la capacidad real. No es un defecto del producto sino un límite de la auditoría.

**Solución técnica.**
- Componente: ninguno; es una actividad de la Fase 2.
- Cambios: lectura de producción en sólo lectura (`/version`, `docker inspect`, estado de jobs).
- Comportamiento esperado: cada afirmación del operador pasa a «comprobada» o «refutada».
- Riesgos: no tocar nada; la lectura debe ser en sólo lectura.
- Pruebas que lo demuestran: acta de la Fase 2.
- Esfuerzo: S-M, a la espera de que termine la migración en curso.

#### 4.4.14 Problemas menores transversales (P3/P4)

| Problema | Explicación breve | Solución | Prioridad |
|---|---|---|---|
| Staging inexistente (QA-04) | La promoción no pasa por un humo en un despliegue | Retirar jobs vacíos o documentar la promoción manual ([T-91](13-PRIORITIZED-BACKLOG.md#t-91)) | P3 |
| Cobertura sin umbral (QA-06) | Sin cifra mínima exigida | Fijar umbral tras medir ([T-68](13-PRIORITIZED-BACKLOG.md#t-68)) | P3 |
| Sólo español (DOC-09) | Barrera para programadores de bots fuera del ámbito hispano | README/quickstart en inglés ([T-83](13-PRIORITIZED-BACKLOG.md#t-83)) | P3 |
| PR «NO MERGEAR» y raíz sucia (DOC-13, DOC-07) | 29 de 51 PR abiertos, un zip, un docx y un compose v1 en la raíz dan imagen de abandono | Cerrar PR y mover ficheros ([T-02](13-PRIORITIZED-BACKLOG.md#t-02), [T-03](13-PRIORITIZED-BACKLOG.md#t-03)) | P3 |
| Topología del operador en ficheros rastreados (SEC-13) | `.env.example` y otros exponen su instalación; sin secretos | Limpiar ficheros; no purgar el historial ([T-03](13-PRIORITIZED-BACKLOG.md#t-03), [T-90](13-PRIORITIZED-BACKLOG.md#t-90)) | P2 (limpieza en A) |
| `Retry-After` nunca emitido (BE-07) | La web lo espera, la API no lo envía | Emitirlo en los 429 ([T-65](13-PRIORITIZED-BACKLOG.md#t-65)) | P2 |

### 4.5 Qué falta

Las mediciones de la Fase 2 (carga, imágenes, red real, restore completo, sesión larga de streaming) y las decisiones del propietario (licencia, registro, qué hacer con los 51 PR abiertos, 29 de ellos «NO MERGEAR»). Sin ellas, varios de los riesgos de arriba no pueden convertirse en defectos ni descartarse.

### 4.6 Soluciones técnicas recomendadas

Orden sugerido, de más barato y visible a más caro: (1) escaparate y verdad documental, 4.4.6 y 4.4.14 (T-01 a T-05); (2) nightly y señal de CI, 4.4.10 (T-17); (3) camino de instalación completo, 4.4.3 y 4.4.4 (T-06 a T-11); (4) prueba de red y escaneo de imágenes, 4.4.1 y 4.4.4 (T-16, T-18); (5) diagnóstico y runbooks, 4.4.5 (T-19, T-33); (6) experiencia de primer uso, 4.4.7 (T-13, T-42); (7) release y ensayos, 4.4.9 (T-10, T-20, T-21); (8) medición y cuotas, 4.4.8 (T-22, T-38); (9) lo demás, grupos B a D.

### 4.7 Prioridad e impacto en el cierre de la versión

Bloquean la versión presentable (grupo A): 4.4.1 (medición de la red), 4.4.3, 4.4.4 (forma mínima), 4.4.6 (portada) y 4.4.10 (nightly). Son necesarios para la versión siguiente (grupo B): segmentación de red, diagnóstico en producto, automatización de actualización y restore, cuotas. El resto es poslanzamiento. Ninguna de estas debilidades obliga a rediseñar el núcleo (motor, cola, contrato de API): ver «Partes que no necesitan rediseño» en el [capítulo 3](#3-puntos-fuertes-del-proyecto).

---

## 5. Auditoría del motor y del sistema de juego

### 5.1 Qué se ha analizado

El motor es la pieza que decide quién gana una batalla: simula el mundo en 2D, aplica las reglas, calcula el daño y registra todo en un «replay» (la grabación de la batalla). Se han revisado, **de forma estática (leyendo código y documentos; no se ha ejecutado nada)**, estos aspectos:

- Simulación y física (motor Rapier fijado por huella criptográfica), generador de números aleatorios con semilla (PRNG), lint de determinismo (una comprobación automática que prohíbe usar azar o reloj del sistema) y hash de estado (una «huella» del estado de la batalla para detectar divergencias).
- Reglas y modos (duelo, equipos, captura de bandera, zonas, 4v4, prórroga), daño y equipamiento (relación arma↔munición, elegibilidad de versiones de bot).
- Bots: protocolo de comunicación, SDK y runtimes Python/JavaScript, y qué información recibe cada bot (estado privado, visibilidad entre equipos, radio).
- Replays y su compatibilidad entre versiones; política de versionado (ADR-022/024; versión actual 0.5.0, escrita a mano en varios sitios).
- Calidad de las pruebas del motor (mutantes: cambios deliberados en el código para comprobar que las pruebas los detectan).

Fuentes: [informe de arquitectura y motor](evidence/agents/01-arquitectura-motor.md), [matriz funcional](02-FUNCTIONAL-MATRIX.md), [deuda técnica](04-TECHNICAL-DEBT.md), [calidad de pruebas](08-TEST-QUALITY.md), [streaming y replays](09-STREAMING-REVIEW.md) y las revisiones independientes. **Límite importante:** la FASE 2 (laboratorio) está pendiente, así que no hay mediciones de rendimiento, ni pruebas de determinismo entre máquinas, ni un test de fuga de información hacia los bots ejecutado por la auditoría.

### 5.2 Qué está bien diseñado

**Esta es la parte más sólida del producto y no necesita rediseño.** Lo que sigue está respaldado por lectura de código (la evidencia de ejecución se indica en 5.3).

- **Determinismo por construcción, no por costumbre.** El lint vigila todo el código fuente del motor y sólo exime a cuatro ficheros explícitamente justificados; cualquier fichero nuevo queda vigilado automáticamente. Beneficio: nadie puede introducir por descuido `Math.random` o la hora del sistema sin que el lint lo detecte.
- **Azar con «flujos con nombre».** Cada subsistema (daño, dispersión, etc.) tiene su propio flujo derivado de la semilla. Añadir una tirada nueva en un subsistema no desplaza los resultados de los demás. Beneficio: los cambios de reglas no alteran el resto de la simulación sin querer.
- **Hash de estado explicable.** Se calcula por componentes, con mapas y conjuntos ordenados y decimales redondeados; si una verificación falla, indica qué parte divergió. Beneficio: diagnosticar una desviación sin adivinar.
- **Cabecera de replay que ata todas las versiones** (motor, física con su huella, protocolo, runtime, catálogo de módulos, esquema de hash y de azar). El verificador distingue «otra versión» de «manipulado» y lo dice con un motivo explícito. Beneficio: nunca se acusa de trampa a un replay que sólo es antiguo.
- **Política de versionado clara y conservadora** (ADR-022/024: una subida por ola de cambios, un único verificador de versión). Es honesta sobre su coste: cada subida de motor deja sin re-simulación el histórico (véase 5.4.3 y 5.4.6), pero evita los casos grises.
- **Física fijada por huella:** el motor se niega a arrancar si el binario de Rapier cambia.
- **Disciplina de mutantes versionada con el código** y con una prueba que vigila que las «anclas» de cuatro matrices no se pierdan.
- **Diseño de información para los bots (según la documentación de bots):** el bot recibe sólo su observación (su estado más lo que perciben sus sensores); un rival fuera de alcance no aparece «ni siquiera como hueco»; la radio sólo llega al propio equipo; los identificadores de vehículo son públicos sólo dentro de la propia partida; una radio de un rival aún no percibido se descarta en lugar de revelar quién es. Es un diseño correcto para evitar fugas, **pero** su cumplimiento real no lo ha medido la auditoría (véase 5.3 y REV-04).

### 5.3 Qué funciona

| Capacidad | Estado de evidencia |
|---|---|
| Lint de determinismo, PRNG con flujos, hash de estado, verificador de replay, cabecera de versiones | **Comprobado en código.** Que el lint corra en la CI —el sistema que ejecuta las pruebas en cada cambio— y que un mutante lo ponga en rojo: no verificado. |
| Prueba `determinism-1000` (mil simulaciones repetidas) | **Comprobado en pruebas:** pasa en el job correspondiente de la ejecución nocturna (la ejecución nocturna completa está en rojo por otra causa, véase 5.4.2). |
| Física fijada por huella | Comprobado en código; **el arranque con el binario alterado no se ha ejecutado.** |
| Modos y rulesets (duelo, equipos, bandera, zonas, 4v4, prórroga hasta 36.000 ticks extra), equipos 4v4 con radio de equipo | Comprobado en código; **declarado por el operador** en producción (informes de su reinstalación, no reverificados por la auditoría). |
| Regla arma↔munición y elegibilidad de versiones | Comprobado en código (validador, motor y API). No se ha encontrado hoy ninguna incoherencia entre los tres. |
| Replays v2 y reproductor web | Golden test —recorrido completo registro→bot→batalla→replay— en verde en la CI. |
| Runtimes y SDK Python/JavaScript (versión 0.1.0) con pruebas de contrato compartidas | Comprobado en código; sólo documentado que las plantillas funcionan contra el motor (CI no verificada). |
| Visibilidad hacia espectadores (una proyección firmada por audiencia, estado privado sólo con ticket de personal) | Comprobado en código; **prueba de fuga real: pendiente de FASE 2**. |

### 5.4 Qué problemas existen

Ningún problema del motor es bloqueante del lanzamiento. El más importante a medio plazo es 5.4.1: **debe corregirse antes de la próxima subida de motor.**

#### 5.4.1 [ARQ-01] El job de estadísticas re-simula replays sin comprobar la versión del motor
**Prioridad:** P2 · **Grupo de lanzamiento:** B (obligatorio antes de la próxima subida de motor) · **Evidencia:** comprobado en código (riesgo; no reproducido) · **Tarea:** [T-41](13-PRIORITIZED-BACKLOG.md#t-41)

**Explicación general.** Para calcular estadísticas por bot (daño, bajas, uso de módulos) el servicio de replays vuelve a simular la batalla. Esa ruta no comprueba que el replay se grabó con la misma versión del motor que está en marcha; sólo el verificador oficial lo hace. Hoy sólo existe una versión en producción, así que **no hay datos erróneos todavía**. Tras la próxima subida de motor, un replay antiguo se re-simularía con otra física y produciría estadísticas distintas a lo jugado, escritas en la base de datos sin ningún aviso. Es un riesgo futuro cierto, no un fallo actual. Queda sin trazar si la ingesta verifica el replay antes de encolar el job.

**Solución técnica.**
- Componente: `apps/replay-service/src/stats.ts`, `apps/replay-service/src/store.ts`, `apps/arena-engine/src/replay.ts` (`resimulateWithEvents`).
- Cambios: llamar a la comprobación de compatibilidad de cabecera (`headerIncompatibility`) antes de re-simular, en la capa de carga o en la propia función, y propagar el motivo.
- Comportamiento esperado: un replay con versión distinta se rechaza con `engine_version_mismatch` y no se escriben filas de estadísticas.
- Riesgos: rechazar por error replays legítimos de la misma versión; hay que cubrir el caso con un replay válido en el mismo test.
- Pruebas que lo demuestran: test con un replay cuya versión de motor se altera; debe fallar con el código actual (escribe filas) y pasar tras el cambio; test calibrado (si se elimina la comprobación, se pone en rojo).
- Esfuerzo: S, incertidumbre baja.

#### 5.4.2 [ARQ-02 / QA-02] Los mutantes de varias matrices no se vigilan en la CI
**Prioridad:** P2 (QA-02; ARQ-02 es P3) · **Grupo de lanzamiento:** C · **Evidencia:** comprobado en código · **Tarea:** [T-68](13-PRIORITIZED-BACKLOG.md#t-68)

**Explicación general.** El proyecto tiene «pruebas de mutación»: se introduce un fallo a propósito en el código para comprobar que las pruebas lo detectan. Estas pruebas existen y se usaron en las revisiones, pero se ejecutan a mano. La comprobación automática sólo vigila 4 de los 8 grupos de esas pruebas, así que en los otros 4 se puede estropear algo sin que nada se ponga en rojo. Los scripts completos no corren en ninguna ejecución automática. Por tanto, «nuestras pruebas detectan errores reales» es una afirmación documentada y no reevaluada: su eficacia actual no está demostrada. Además, la ejecución nocturna de la CI lleva meses en rojo (causa conocida, ajena al motor, en [08](08-TEST-QUALITY.md#qa-01)), así que tampoco podría dar esa señal hoy.

**Solución técnica.**
- Componente: `apps/arena-engine/tests/hardening-mutant-anchors.test.ts`, `scripts/hardening/*`, workflow nocturno.
- Cambios: descubrir las matrices por patrón de nombre en vez de una tabla fija, añadir `--dry-run` a las que no lo tengan, dar a `me-mutants` su propia comprobación y ejecutar en la nocturna un subconjunto de mutantes críticos (autenticación y permisos, aislamiento, torneos, backup).
- Comportamiento esperado: borrar o duplicar una ancla de cualquier matriz pone la CI en rojo; la nocturna sólo es fiable si antes se arregla [T-17](13-PRIORITIZED-BACKLOG.md#t-17).
- Riesgos: tiempo de ejecución de la nocturna; los calibradores de mutantes deben correr en serie, nunca dos sobre el mismo árbol.
- Pruebas que lo demuestran: eliminar a propósito una ancla de `ma-mutants.py` o `g2-mutants.py` y comprobar que la CI falla (hoy no falla).
- Esfuerzo: S-M (anclas) + M (nocturna), incertidumbre media.

#### 5.4.3 [STR-03 / STR-04] Replays antiguos ilegibles sin explicación y sin política de longevidad
**Prioridad:** P2 (STR-03) y P3 (STR-04) · **Grupo de lanzamiento:** B y C · **Evidencia:** comprobado en código; alcance real desconocido · **Tarea:** [T-45](13-PRIORITIZED-BACKLOG.md#t-45), [T-74](13-PRIORITIZED-BACKLOG.md#t-74)

**Explicación general.** Por decisión de diseño el formato de replay es único (v2) y cada subida de motor deja los anteriores sin re-simulación. El defecto confirmado es de comunicación: un replay antiguo aparece en la lista, pero al abrirlo la API devuelve el mismo «no encontrado» que para un replay inexistente, y la web no contiene ningún mensaje de «formato o versión no compatible». Una persona vería un error engañoso. Cuántos replays antiguos conserva producción es desconocido (hay una purga de reset competitivo en borrador). Aparte, la política «ninguna compatibilidad» afecta incluso a los replays oficiales «que se conservan siempre» y a las estadísticas por re-simulación; es una decisión de producto, no un fallo.

**Solución técnica.**
- Componente: `apps/replay-service/src/segment.ts`, `apps/api/src/routes/replays.ts`, `apps/web/src` (`ReplayPage`) y, para la política, los documentos de usuario.
- Cambios: marcar `playable: false` con motivo (`format_version`) en el índice y mostrarlo en el visor; o purgar los replays previos si se decide el reset. Declarar la política de longevidad (congelar motor por temporada, conservar imagen del motor anterior, o aceptar la pérdida).
- Comportamiento esperado: ningún replay antiguo da un 404 sin explicación; la política consta en la documentación de usuario.
- Riesgos: alargar la lista con elementos no reproducibles; la compatibilidad real es una obra grande (L) que no se recomienda ahora.
- Pruebas que lo demuestran: abrir en laboratorio un replay v1, uno 0.4.0 y uno 0.5.0 (verificación T9 de FASE 2): mensaje explícito en los dos primeros, reproducción en el tercero.
- Esfuerzo: S (STR-03); STR-04 es decisión (S) y, si se quisiera compatibilidad real, L.

#### 5.4.4 [ARQ-03] La versión del motor está escrita a mano y ninguna prueba la cruza con la fuente
**Prioridad:** P3 · **Grupo de lanzamiento:** B · **Evidencia:** comprobado en código · **Tarea:** [T-69](13-PRIORITIZED-BACKLOG.md#t-69)

**Explicación general.** El número «0.5.0» aparece literal en la generación de las reglas para el usuario y en ejemplos del protocolo y del SDK. La prueba «el repositorio está al día» es autoconsistente: tras subir la versión oficial a 0.6.0, seguiría en verde mientras las reglas publicadas dicen 0.5.0. Los tests de contrato del SDK leen la versión de la fuente oficial, lo que cubre en parte los ejemplos, pero no está verificado que cubra las reglas. Riesgo: documentación pública con una versión equivocada tras la próxima subida.

**Solución técnica.**
- Componente: `packages/game-rules/rules-doc.ts` (y su test), ejemplos de `packages/protocol/examples` y `sdks/shared-contract-tests`.
- Cambios: importar `engine-deps.json` en la generación de reglas, o añadir un test que compare todas las apariciones literales con la fuente.
- Comportamiento esperado: subir la versión oficial sin actualizar el resto pone un test en rojo.
- Riesgos: ninguno relevante; los comentarios con «0.4.0» son sólo cosméticos.
- Pruebas que lo demuestran: en una copia, cambiar la versión oficial a 0.6.0 (verificación 4 de FASE 2): hoy ninguna prueba falla por esto; tras el cambio, sí.
- Esfuerzo: S, incertidumbre baja.

#### 5.4.5 [ARQ-07] La regla arma↔munición vive en tres sitios
**Prioridad:** P3 · **Grupo de lanzamiento:** C · **Evidencia:** comprobado en código (sin incoherencia hoy) · **Tarea:** [T-69](13-PRIORITIZED-BACKLOG.md#t-69)

**Explicación general.** Que un arma pueda usar una munición se decide en el validador de loadouts, en el motor (al disparar) y en la elegibilidad de la API (qué versiones de bot pueden competir). Hoy coinciden, pero la coherencia depende de tests y de comentarios cruzados. Un cambio en un lado podría aceptar un equipamiento que el otro no dispara, que es justo el caso histórico que ya obligó a reformar la elegibilidad. La regla en sí es correcta y **no necesita rediseño**; lo que falta es una única función compartida.

**Solución técnica.**
- Componente: `packages/module-catalog/validator/index.ts`, `apps/arena-engine/src/sim/combat.ts`, `apps/api/src/services/version-eligibility.ts`.
- Cambios: exponer una función `ammoCompatible(arma, munición)` en el catálogo y usarla en los tres; añadir una prueba de propiedad que cruce validador, motor y elegibilidad sobre el catálogo completo.
- Comportamiento esperado: un solo punto de verdad; cualquier divergencia pone la prueba en rojo.
- Riesgos: el motor hoy cae al primer compatible aunque esté a cero de munición; unificar debe conservar ese comportamiento (afecta al determinismo de replays existentes).
- Pruebas que lo demuestran: la prueba de propiedad cruzada (verificación 8 de FASE 2) y los replays dorados sin cambios de hash.
- Esfuerzo: M, incertidumbre baja.

#### 5.4.6 [ARQ-06] No hay política de ratings ante un cambio de motor
**Prioridad:** P3 · **Grupo de lanzamiento:** D · **Evidencia:** comprobado en código (ausencia en el cálculo de ratings y temporadas) · **Tarea:** [T-82](13-PRIORITIZED-BACKLOG.md#t-82)

**Explicación general.** Cada batalla guarda con qué versión de motor se jugó, pero el cálculo de ELO y temporadas no lo usa. Una subida que cambie la física mezclaría en el mismo ranking batallas jugadas con reglas distintas. Es una decisión de producto, no un fallo de código, y no afecta a la versión actual.

**Solución técnica.** Componente: documentación (nuevo ADR «cambios de motor y temporadas»); si se segmenta, `apps/tournament-worker/src/ratings.ts` y `season.ts`. Cambios: decidir entre reiniciar temporada, segmentar por versión o aceptar la mezcla. Esperado: la decisión consta y es aplicable en la subida. Riesgos: segmentar es costoso. Pruebas: si se segmenta, test de ELO con dos versiones. Esfuerzo: S (decisión) + M (implementación).

#### 5.4.7 [REV-04 / SEC-04] Canal lateral entre bots que salta las reglas de visión y radio
**Prioridad:** P2 · **Grupo de lanzamiento:** B (A si la versión presume de competiciones públicas con premio) · **Evidencia:** comprobado en código el diseño; explotación no probada · **Tarea:** [T-39](13-PRIORITIZED-BACKLOG.md#t-39)

**Explicación general.** Todos los bots de todas las batallas comparten una única red interna. Aunque el diseño de información del motor es correcto, dos bots del mismo dueño podrían comunicarse por conexión directa y saltarse radio y visión, y los workers comparten esa red. No se ha demostrado la explotación. El detalle y la prueba de aislamiento (que además hoy no puede ponerse en rojo, REV-01) están en [05-SECURITY-REVIEW](05-SECURITY-REVIEW.md#rev-04). Solución resumida: red por batalla o comunicación entre contenedores desactivada; la prueba, en laboratorio con dos bots reales. Esfuerzo M, incertidumbre media.

**Solución técnica.** Completa en el [apartado 4.4.1](#4-puntos-débiles-y-riesgos) (componente, cambios, riesgos y pruebas) y en la tarea [T-39](13-PRIORITIZED-BACKLOG.md#t-39): una red interna por batalla, o la comunicación directa entre contenedores desactivada, y una prueba en laboratorio con dos bots reales que intenten hablarse.

#### 5.4.8 Problemas menores del motor

| Problema | Explicación breve | Solución | Prioridad |
|---|---|---|---|
| [ARQ-04] Prueba de resistencia sólo con un modo | Sólo se estresa el duelo de práctica; ni bandera, ni 4v4, ni la prórroga (hasta 36.000 ticks extra) se ven bajo carga. | Parametrizar por modo en el laboratorio ([T-69](13-PRIORITIZED-BACKLOG.md#t-69)). | P3 |
| [ARQ-05] ADR-024 con estado e índice desfasados | La decisión sí explica las copias de reglas antiguas, pero sigue como «propuesta» y falta decir qué pasa con una copia de versión futura. | Cerrar estado y actualizar índice y `engine.md`. | P4 |
| [ARQ-08] Zip, docx y compose v1 en la raíz del repo público | Sin secretos (comprobado por el director), pero ensucian el escaparate. | Mover a `docs/` o eliminar ([T-03](13-PRIORITIZED-BACKLOG.md#t-03)); detalle en [10](10-DOCUMENTATION-AUDIT.md). | P3 (grupo A) |
| [ARQ-09] Código muerto en el motor | `match.ts`, `checkpoint.ts` y el camino `POST /run` no tienen consumidor. | Eliminar o mover a `dev/`. | P4 |
| [ARQ-10] Reanudar batallas desde checkpoint, sólo en diseño | Los checkpoints se graban, pero nada los reanuda; la batalla en vivo no es reproducible por semilla (TD-038). | Dejar como diseño; documentar ([T-82](13-PRIORITIZED-BACKLOG.md#t-82)). | P4 |
| [ARQ-11] Determinismo entre CPU/versiones de Node | Hipótesis: funciones trigonométricas del runtime y versión registrada sólo por «major». Sin evidencia de fallo. | Probar el mismo replay en dos CPUs en laboratorio; si diverge, fijar versión exacta (esfuerzo M, incertidumbre alta). | P3 (hipótesis) |
| [ARQ-12] Sin presupuesto de CPU ni memoria por batalla | Los límites son en ticks, no en CPU; con ≤8 participantes el coste no explota, pero no está medido. | Medir tiempo por tick y memoria por modo en laboratorio ([T-69](13-PRIORITIZED-BACKLOG.md#t-69)). | P3 |

También quedan abiertas, como funcionalidad parcial, TD-016 (campos de catálogo sin efecto, decisión de masa y coste de munición) y las issues de visión compartida de equipo y del atributo `utility` ignorado.

### 5.5 Qué falta

- **Mediciones de FASE 2:** determinismo entre máquinas (ARQ-11), estrés por modo (ARQ-04/12), arranque con la física alterada, verificación cruzada de replays de versiones distintas y prueba de fuga de información hacia bots y espectadores.
- **Una política escrita** sobre qué ocurre con replays, estadísticas y ratings al subir de versión (ARQ-06, STR-04).
- **Mutantes en la CI** (ARQ-02/QA-02), tras reparar la nocturna.
- **Prueba real de aislamiento de bots** en la red de producción (REV-01 y REV-04; capítulo de seguridad).
- La revisión línea a línea del bucle de batalla y de la física no se hizo (sólo muestreo).

### 5.6 Soluciones técnicas recomendadas (resumen ordenado)

1. [T-41](13-PRIORITIZED-BACKLOG.md#t-41): comprobar versión en el job de estadísticas (ARQ-01). Barato y obligatorio antes de subir de motor.
2. [T-17](13-PRIORITIZED-BACKLOG.md#t-17) y después [T-68](13-PRIORITIZED-BACKLOG.md#t-68): nocturna en verde y mutantes críticos en CI (ARQ-02, QA-02).
3. [T-45](13-PRIORITIZED-BACKLOG.md#t-45): explicar o purgar replays antiguos (STR-03); declarar la política de longevidad (STR-04, [T-74](13-PRIORITIZED-BACKLOG.md#t-74)).
4. [T-69](13-PRIORITIZED-BACKLOG.md#t-69): versión única, función compartida arma↔munición, resistencia por modo, limpieza de código muerto y documentos (ARQ-03/04/05/07/09/12).
5. [T-39](13-PRIORITIZED-BACKLOG.md#t-39) con [T-16](13-PRIORITIZED-BACKLOG.md#t-16): aislamiento entre bots, medido primero (REV-04).
6. [T-82](13-PRIORITIZED-BACKLOG.md#t-82): ADR de motor y temporadas y prueba de determinismo entre plataformas (ARQ-06/10/11), grupo D.

**No se recomienda rediseñar** el PRNG, el hash de estado, el verificador de replays, la política de versionado ni la regla arma↔munición: están bien pensados y los cambios propuestos son pequeños y localizados.

### 5.7 Prioridad e impacto en el cierre de la versión

- **Bloqueantes de grupo A del motor: ninguno.** El motor no impide presentar la versión; el veredicto del área es *listo con condiciones*.
- **Antes de la próxima subida de motor (condición, grupo B):** ARQ-01.
- **Versión objetivo siguiente (B):** STR-03, ARQ-03, REV-04 (A si hay competiciones públicas con premio).
- **Poslanzamiento (C):** ARQ-02/QA-02, ARQ-04/05/07/09/12, STR-04. **Futuro (D):** ARQ-06/10/11.
- Condición común: lo dicho de producción (motor 0.5.0 en marcha) es **declarado por el operador**, no verificado; que la CI esté verde no prueba que producción funcione.

---

## 6. Backend, API y base de datos

### 6.1 Qué se ha analizado

El backend es la parte que no se ve: la API (el «mostrador» al que se conectan la web y los programas), la base de datos PostgreSQL, y los «workers» (procesos en segundo plano que ejecutan las batallas y los torneos). Se ha revisado, **de forma estática (código y documentos, sin ejecutar nada)**:

- Autenticación (registro, sesión, contraseñas), roles y permisos, gestión de usuarios, bots y equipos.
- Torneos, clasificaciones y su ciclo de vida; reparto de trabajo mediante una **cola** (lista de tareas pendientes) guardada en PostgreSQL.
- El contrato de la API (OpenAPI, 106 operaciones), la validación de entradas, los formatos de error y la paginación.
- Migraciones de base de datos (001-022, todas con «marcha atrás») y retención de datos.
- Workers, concurrencia y manejo de fallos: el timeout de batalla corregido en el PR #298, los torneos «zombis» corregidos, el torneo `closed` atascado, la exportación e importación portable.
- Ciclo de vida de la cuenta (alta, cambio y recuperación de contraseña).

Fuentes: [informe de backend y datos](evidence/agents/02-backend-api-datos.md), [seguridad](05-SECURITY-REVIEW.md), [deuda técnica](04-TECHNICAL-DEBT.md), las [revisiones independientes](15-INDEPENDENT-REVIEWS.md) y las decisiones del director. **Límite:** no se ha ejecutado nada ni se ha mirado producción; la FASE 2 (laboratorio) está pendiente. La CI —el sistema que ejecuta las pruebas en cada cambio— estaba en verde para el código analizado, pero eso no prueba que producción funcione.

### 6.2 Qué está bien diseñado

**El diseño de la cola, de los workers y del contrato de la API es sólido y no necesita rediseño.** Lo que sigue está respaldado por lectura de código:

- **Cola en PostgreSQL con reclamo atómico** (`FOR UPDATE SKIP LOCKED`: dos workers nunca cogen la misma tarea) y clave de deduplicación única. Beneficio: no hace falta un sistema extra para repartir trabajo y se evitan batallas duplicadas.
- **Doble cerrojo en cada batalla:** la batalla reserva un «lease» (alquiler temporal) de 45 s, por debajo del bloqueo de la tarea (60 s); ambos se renuevan juntos y la reserva exige seguir siendo el titular y que el torneo no esté cancelado. Beneficio: si un worker muere, otro recoge la batalla sin ejecutarla dos veces.
- **Fallos clasificados:** el sistema distingue fallo deportivo del bot, fallo de infraestructura y fallo no clasificado, con topes distintos de reintentos (p. ej., 8 por BD no disponible, 1 por timeout de batalla). Beneficio: un problema pasajero no condena a un bot.
- **Torneos con transacciones y bloqueo de fila** al cerrar inscripciones, inscribirse o cancelar; cancelación idempotente y auditada.
- **Contrato de la API como fuente de autorización:** rutas y roles mínimos se derivan del contrato por construcción (no hay deriva entre la ruta real y lo documentado) y una prueba de conformidad lo vigila. Hay 7 roles acumulativos y un torneo lo gestiona su dueño o el personal.
- **Contraseñas y sesiones:** Argon2id, mínimo de 12 caracteres, bloqueo tras 20 fallos, sesión de 15 minutos con renovación rotada y detección de reutilización.
- **Registro de auditoría de sólo inserción** (lo impone la base de datos) y límite de peticiones compartido en base de datos, que sobrevive a reinicios.
- **Migraciones:** 22, todas con marcha atrás; rollback por nombre acotado a una lista cerrada (016-022).
- **Exportación/importación portable:** idempotente, reanudable, verifica antes de escribir y admite simulacro.

### 6.3 Qué funciona

| Capacidad | Estado de evidencia |
|---|---|
| Cola, reclamo, reintentos por clase, reaper (recuperador de tareas huérfanas) | Comprobado en código; pruebas en la CI. En producción: **declarado por el operador**. |
| Timeout de batalla (321 s) corregido: tope = `ceil(ticks×ms×1,25)+15 s` y fallo `battle_timeout` con un reintento | Comprobado en código (PR #298 en main). La medición real es **evidencia de tercero**; verificación en laboratorio pendiente. |
| Torneos `running` con batallas fallidas ya no se quedan zombis (`settleFailedBattle` + rescate cada 5 min) | Comprobado en código; **queda un caso no cubierto** (6.4.1). |
| 106 operaciones de la API conformes con el contrato | Comprobado en pruebas (prueba de conformidad en la CI). |
| Migraciones 001-022 con marcha atrás; tests por migración 016-022 | Comprobado en código y pruebas; todas tienen `down`, pero al revertir la 011 y la 018 se pierden datos, y la 019 reescribe una función compartida (BE-09, ver 6.4.9). |
| Export/import portable | Comprobado en código; test de ida y vuelta en la CI (su resultado exacto no se verificó). |
| Registro, sesión, roles, equipos, torneos de punta a punta | Golden test de la CI en verde; **declarado por el operador** en producción. |

### 6.4 Qué problemas existen

Ninguno de estos problemas impide por sí mismo el funcionamiento normal; los más serios afectan a **quien opera la instalación** (qué hacer cuando algo se atasca) y a **las cuentas** (qué pasa si alguien olvida su contraseña).

#### 6.4.1 [BE-01] Un torneo cerrado puede quedarse atascado para siempre
**Prioridad:** P2 (el autor lo puso P1; la revisión técnica lo rebajó) · **Grupo de lanzamiento:** B, con receta de salida (runbook SQL) en A · **Evidencia:** comprobado en código (rama de código; no reproducido) · **Tarea:** [T-19](13-PRIORITIZED-BACKLOG.md#t-19) (runbook), [T-31](13-PRIORITIZED-BACKLOG.md#t-31) (salida de producto)

**Explicación general.** Al cerrar las inscripciones se encola la tarea que genera el calendario de batallas. Si esa tarea agota sus reintentos, el sistema sólo sabe actuar sobre batallas, no sobre ese tipo de tarea: la arreglada rutina de rescate sólo mira torneos «en marcha», y cancelar sólo se permite en borrador o abierto. El torneo queda en `closed` sin salida desde el producto, con las versiones de los bots ya congeladas. Es un riesgo con rama de código verificada, no un fallo reproducido.

**Solución técnica.**
- Componente: `apps/tournament-worker/src/battle-failure.ts`, `results.ts`, `apps/api/src/routes/tournaments.ts` (lista de estados cancelables), `scheduler.ts`.
- Cambios: dar un estado de fallo o rescate a los torneos `closed` cuya generación de calendario se agota (volver a `open` descongelando, o cancelación administrativa) y mostrar el motivo; permitir la cancelación administrativa desde `closed`.
- Comportamiento esperado: ningún torneo queda más de un tiempo acotado en `closed` sin una salida visible.
- Riesgos: cancelar con batallas en ejecución; hay que bloquear la fila del torneo y marcar las batallas.
- Pruebas que lo demuestran: test de integración con un manejador que lanza error en `generate_schedule` y comprobación del estado final y de que el administrador puede cancelar (habría fallado antes); verificación 1 de FASE 2.
- Esfuerzo: M, incertidumbre media (el runbook previo: S).

#### 6.4.2 [BE-02] Las tareas aparcadas para revisión sólo se ven con SQL
**Prioridad:** P2 · **Grupo de lanzamiento:** B, con runbook en A · **Evidencia:** comprobado en código · **Tarea:** [T-19](13-PRIORITIZED-BACKLOG.md#t-19), [T-32](13-PRIORITIZED-BACKLOG.md#t-32)

**Explicación general.** Cuando una tarea falla de forma no clasificada, queda en estado `needs_review`. No existe endpoint, comando ni métrica para listarlas, reintentarlas o descartarlas: la palabra sólo aparece en las migraciones. Un tercero que opere la instalación no puede gestionar la cola sin escribir SQL.

**Solución técnica.**
- Componente: `apps/api` (nueva ruta de administración), `apps/api/src/db/cli.ts`, panel web.
- Cambios: listado `GET /admin/jobs?status=`, acción de reencolar o descartar con auditoría, y métrica de tareas por estado.
- Comportamiento esperado: el administrador ve, reintenta y descarta desde web o CLI, y cada acción queda en el registro de auditoría.
- Riesgos: reintentar una tarea envenenada en bucle; mantener el tope de reintentos.
- Pruebas que lo demuestran: forzar una tarea a `needs_review` en laboratorio y resolverla por la nueva superficie; mutante (sin comprobar el rol admin) en rojo.
- Esfuerzo: M, incertidumbre baja.

#### 6.4.3 [D-01 / SEC-02 / SEC-03 / UX-02] Ciclo de vida de la cuenta incompleto: registro abierto sin interruptor, sin cambio ni recuperación de contraseña
**Prioridad:** P2 (P1 si se abre el registro a externos, que es hoy el valor por defecto) · **Grupo de lanzamiento:** A para interruptor de registro, cambio de contraseña y reinicio asistido por administrador; B para recuperación autónoma por correo · **Evidencia:** comprobado en código · **Tarea:** [T-12](13-PRIORITIZED-BACKLOG.md#t-12), [T-14](13-PRIORITIZED-BACKLOG.md#t-14), [T-11](13-PRIORITIZED-BACKLOG.md#t-11), [T-30](13-PRIORITIZED-BACKLOG.md#t-30)

**Explicación general.** Cualquiera puede registrarse y recibe rol `developer`, es decir, puede subir código que se ejecuta en el sandbox del servidor; no hay interruptor para cerrar o limitar el alta. Una vez dentro, no hay forma de cambiar la contraseña, y la «recuperación» crea un token y lo descarta sin enviar nada. El operador tampoco tiene un comando para reiniciar una contraseña: debe escribir un hash por SQL. La discrepancia entre revisores (UX decía P1, seguridad P2) se resolvió así: P1/grupo A si el registro es público; P2 si es por invitación o cerrado. El director fijó para la versión mínima presentable el interruptor, el cambio de contraseña y el reinicio asistido; el correo queda para después.

**Solución técnica.**
- Componente: `apps/api/src/routes/auth.ts`, configuración de runtime, `apps/api/src/db/cli.ts` (`create-admin`), pantallas «Mi cuenta» y panel.
- Cambios: variable `REGISTRATION_MODE=open|invite|closed` con valor por defecto cerrado o por invitación; endpoint de cambio de contraseña; reinicio asistido por administrador con contraseña temporal entregada una sola vez, cambio obligatorio en el primer acceso y entrada en auditoría; `create-admin` por CLI; después, recuperación por correo (canal de correo a decidir).
- Comportamiento esperado: con la configuración por defecto, un alta anónima se rechaza; con invitación válida, 201; nadie queda fuera de su cuenta sin tocar SQL.
- Riesgos: romper el golden de la CI, que se registra (debe fijar el modo explícito); la contraseña temporal visible por el admin.
- Pruebas que lo demuestran: test de contrato del registro con el `.env` por defecto; E2E «admin reinicia → usuario entra → cambia»; mutante (sin comprobar rol admin) en rojo; para el correo, token de un solo uso con caducidad y mutante (token reutilizable) en rojo.
- Esfuerzo: M (interruptor), S-M (cambio y reinicio), L (correo); incertidumbre baja a media.

#### 6.4.4 [BE-11 / REV-06] Registro no atómico, carreras de unicidad y administradores
**Prioridad:** P2 (BE-11) y P3 (REV-06) · **Grupo de lanzamiento:** B y C · **Evidencia:** comprobado en código · **Tarea:** [T-63](13-PRIORITIZED-BACKLOG.md#t-63)

**Explicación general.** El registro comprueba si el correo existe y luego inserta usuario y roles en dos pasos sin transacción: un corte entre ambos deja un usuario sin roles, y un doble envío provoca un error 500 en lugar de un «ya existe». Aparte, un administrador puede quitarse el rol de administrador (o dejar la instalación sin ninguno) porque `setUserRoles` no tiene la guarda de «último administrador»; combinado con que crear un admin exigía SQL, un error en la web dejaría al operador sin panel.

**Solución técnica.**
- Componente: `apps/api/src/routes/auth.ts`, `routes/users.ts`.
- Cambios: transacción única y captura del error de unicidad (23505) como 409; rechazar cualquier cambio de roles que deje cero administradores o que sea autodegradación del último.
- Comportamiento esperado: 20 altas simultáneas con el mismo correo dan 1×201 y 19×409; imposible quedarse sin administradores.
- Riesgos: tests que fijan mensajes actuales.
- Pruebas que lo demuestran: verificación 9 de FASE 2 (hoy se prevé 500) y test que intenta degradar al último admin.
- Esfuerzo: S cada uno.

#### 6.4.5 [BE-06 / REV-07 / SEC-06] Errores de base de datos disfrazados de «no existe» y fugas menores
**Prioridad:** P2 (BE-06), P3 (REV-07, SEC-06) · **Grupo de lanzamiento:** B (BE-06), C · **Evidencia:** comprobado en código; REV-07 contenido real: hipótesis · **Tarea:** [T-63](13-PRIORITIZED-BACKLOG.md#t-63), [T-67](13-PRIORITIZED-BACKLOG.md#t-67)

**Explicación general.** Hay 35 sitios que capturan cualquier error de base de datos y devuelven 404 «no existe o no visible», pensados para identificadores con formato inválido. Una caída de la base de datos o un timeout se presenta como «no encontrado», sin registro, y rompe la clasificación que el worker sí hace. Además, al inscribir un bot, «no existe» y «es de otro» dan códigos distintos (400 y 403): permite averiguar qué bots privados existen. Otros dos detalles menores: el gestor de errores 500 vuelca al log el detalle completo de PostgreSQL, que puede incluir el valor duplicado (p. ej. un correo; REV-07, contenido real por confirmar); y el alta devuelve 409 si el correo existe, lo que permite saber qué correos tienen cuenta (SEC-06, aceptado como P3).

**Solución técnica.**
- Componente: `apps/api/src/routes/tournaments.ts`, `bots.ts` y otras (35 sitios), `app.ts` (gestor de errores), `routes/teams.ts`.
- Cambios: validar el formato UUID antes de consultar y no capturar errores genéricos; unificar 404 para bot ajeno e inexistente; registrar `code` y `constraint`, no `detail`; mensaje uniforme de alta e invitaciones aceptadas por el invitado.
- Comportamiento esperado: caída de base de datos → 5xx con registro; ningún oráculo de existencia.
- Riesgos: muchos tests fijan los mensajes actuales.
- Pruebas que lo demuestran: parar Postgres 30 s con API y worker vivos (verificación 4 de FASE 2): 5xx, no 404; test de inscripción con bot ajeno e inexistente que den la misma respuesta.
- Esfuerzo: M (BE-06), S cada resto; SEC-06 M.

#### 6.4.6 [REV-02 / REV-03] Verificación de replays y batallas de práctica sin cuota
**Prioridad:** P2 (REV-02 pasa a P1 y grupo A si se mide más de 1 s con registro abierto) · **Grupo de lanzamiento:** B condicional · **Evidencia:** comprobado en código; coste real no verificable aún (FASE 2) · **Tarea:** [T-38](13-PRIORITIZED-BACKLOG.md#t-38)

**Explicación general.** Verificar un replay re-simula la batalla entera dentro del proceso de la API, y la única limitación aplica a anónimos, no a usuarios registrados. Un usuario podría encadenar verificaciones y bloquear login, web y panel. Por otro lado, las batallas de práctica no tienen cuota por usuario, no registran quién las creó y comparten cola FIFO con los torneos: un usuario nuevo podría retrasar horas un torneo sin que el operador pueda atribuirlo. Ambos son riesgos; el coste real está sin medir.

**Solución técnica.**
- Componente: `apps/api/src/routes/replays.ts`, `routes/battles.ts`, `apps/tournament-worker/src/queue.ts`, migración para `created_by`.
- Cambios: limitador por usuario y concurrencia global 1-2 para `verify` (o moverlo a la cola, con caché por batalla); cuota de prácticas activas por usuario, prioridad a batallas oficiales y registro del autor con auditoría.
- Comportamiento esperado: la primera batalla oficial no espera a la cola de prácticas; la API sigue respondiendo bajo `verify` repetido.
- Riesgos: límites demasiado estrictos para el personal.
- Pruebas que lo demuestran: 200 prácticas y luego cerrar un torneo; 10 `verify` en paralelo midiendo la latencia de `/users/me` (verificaciones R2 y R3).
- Esfuerzo: S-M cada uno.

#### 6.4.7 [REV-05] `cli seed` puede conceder administrador a una cuenta ya registrada
**Prioridad:** P2 · **Grupo de lanzamiento:** B · **Evidencia:** comprobado en código · **Tarea:** [T-40](13-PRIORITIZED-BACKLOG.md#t-40)

**Explicación general.** El comando de datos de desarrollo reutiliza una cuenta si el correo ya existe y le añade rol de administrador sin tocar su contraseña. Con registro abierto, quien registre antes el correo semilla obtiene admin cuando alguien ejecute el comando. Exige un error del operador contra una prohibición ya documentada (por eso no es P1), pero la documentación de instalación no lo menciona y no hay guarda.

**Solución técnica.** Componente: `apps/api/src/db/cli.ts`, `seeds/dev.ts`. Cambios: negarse fuera de desarrollo explícito (indicador más BD local) y fallar si alguna cuenta semilla existe con otra contraseña. Esperado: el comando no ejecuta en una instalación real. Riesgos: scripts de desarrollo existentes. Pruebas: registrar el correo semilla y ejecutar el comando; debe rechazar (hoy concede). Esfuerzo: S.

#### 6.4.8 [BE-07] La importación portable choca con el límite de 60 versiones por hora y no avisa
**Prioridad:** P2 · **Grupo de lanzamiento:** B · **Evidencia:** comprobado en código · **Tarea:** [T-65](13-PRIORITIZED-BACKLOG.md#t-65)

**Explicación general.** Crear versiones de bot está limitado a 60 por hora y usuario. Un operador que migre 120 versiones tarda más de una hora, y el 429 no incluye la cabecera `Retry-After` (la API nunca la emite), por lo que el cliente sondea a ciegas cada 60 s hasta 65 minutos. La importación en sí está bien diseñada y reanuda; es un problema de producto para operadores.

**Solución técnica.** Componente: `apps/api` (errores y limitador), `scripts/portable`. Cambios: `Retry-After` real, límite configurable por instalación o rol y exención auditada para la importación del personal. Esperado: importar 130 versiones sin esperas ciegas. Riesgos: abrir un agujero de cuota; la exención debe quedar auditada. Pruebas: importar ≥130 versiones en laboratorio y medir (verificación 5 de FASE 2); test de 429 con `Retry-After`. Esfuerzo: S-M.

#### 6.4.9 Problemas menores del backend

| Problema | Explicación breve | Solución | Prioridad |
|---|---|---|---|
| [BE-03] `/healthz` no comprueba nada | Responde «ok» fijo; el latido del worker es independiente de su bucle, así que puede estar verde con el worker parado. | Readiness con `SELECT 1` y nivel de migraciones; latido ligado al último ciclo ([T-33](13-PRIORITIZED-BACKLOG.md#t-33)). | P2 (B) |
| [BE-04] Sin métricas de cola, torneos ni workers | Las métricas HTTP vienen apagadas por defecto; no hay profundidad de cola ni edad de la tarea más antigua. | Indicadores desde SQL y reglas de alerta ([T-64](13-PRIORITIZED-BACKLOG.md#t-64)). | P2 (C) |
| [BE-05] Validación de entrada manual | El contrato tiene esquemas de entrada, pero nada valida contra él; riesgo de 500 por tipos inesperados. | Validar con Ajv desde el contrato ([T-66](13-PRIORITIZED-BACKLOG.md#t-66)); esfuerzo L. | P2 (C) |
| [BE-08] Cancelación sólo en borrador o abierto; issues #287/#288 abiertas con el backend ya en main | Decisión documentada, pero un torneo roto sólo se arregla por SQL. | Cancelación administrativa desde `closed` ([T-31](13-PRIORITIZED-BACKLOG.md#t-31)); cerrar las issues si sólo resta web. | P2 (C) |
| [BE-09] Marcha atrás de migraciones con pérdida | 011 y 018 pierden datos al bajar; 019 reescribe una función compartida; sin test que imponga la regla. | Documentar, test de la lista de rollback ([T-64](13-PRIORITIZED-BACKLOG.md#t-64)). | P3 |
| [BE-10] Sin retención de `jobs` ni `audit_log` | Crecimiento ilimitado (el índice parcial limita el impacto en el reclamo). | Política de retención/archivo. | P3 |
| [BE-12] Listados de batallas sin paginar con N+1 | Un torneo grande round-robin implica miles de consultas. | Paginar y precargar participantes en una consulta. | P2 (C) |
| [BE-13] Batalla `running` huérfana | Hipótesis estrecha: si su tarea termina por otra vía nada la devuelve a `scheduled`. | Matar el worker a mitad de batalla en laboratorio; reconciliador si se confirma. | P3 (hipótesis) |
| [BE-14] Build worker con bloqueo de 10 min sin renovación | Un build lento podría ejecutarse dos veces; errores sin clasificar. | Renovar el bloqueo y clasificar errores. | P3 |
| [BE-15] Limitador con 3 consultas por petición | Incluye un `count(*)` sobre hasta 100.000 filas; sin medir. | Medir y simplificar. | P3 |
| Acoplamiento API → worker | La API importa `leagueTable` desde el worker. | Mover a un paquete común. | P3 |

### 6.5 Qué falta

- **Superficie de operación:** ver y reintentar tareas aparcadas, cancelar torneos atascados, readiness real y métricas de cola (BE-01/02/03/04).
- **Cuentas:** interruptor de registro, cambio de contraseña, reinicio asistido, `create-admin` y, después, recuperación por correo.
- **Cuotas** de verificación y de prácticas; límite configurable para la importación portable.
- **Validación de entrada por esquema** y paginación de los listados grandes.
- **Mediciones de FASE 2** (nada de esto está medido): timeouts con diez batallas largas, huérfanas con `kill -9`, caída de base de datos, importación de 130 versiones, carga de torneos, migraciones y marcha atrás con datos, y lectura de producción en SQL para comprobar si hay torneos o tareas atascadas.
- Limpiar issues cuyo estado real es «hecho en main» (#287, #288 tras confirmar web; #92 obsoleta; #9 y #14 cerrables).

### 6.6 Soluciones técnicas recomendadas (resumen ordenado)

1. **Grupo A, barato y de cuentas:** [T-12](13-PRIORITIZED-BACKLOG.md#t-12) (modo de registro), [T-11](13-PRIORITIZED-BACKLOG.md#t-11) (`create-admin`), [T-14](13-PRIORITIZED-BACKLOG.md#t-14) (cambio de contraseña y reinicio asistido) y [T-19](13-PRIORITIZED-BACKLOG.md#t-19) (runbooks para torneo `closed` y `needs_review`).
2. **Medir primero:** [T-25](13-PRIORITIZED-BACKLOG.md#t-25) (backend, cola y carga en laboratorio): decide si REV-02 sube a grupo A.
3. **Grupo B:** [T-31](13-PRIORITIZED-BACKLOG.md#t-31) y [T-32](13-PRIORITIZED-BACKLOG.md#t-32) (salidas de producto), [T-33](13-PRIORITIZED-BACKLOG.md#t-33) (healthz), [T-38](13-PRIORITIZED-BACKLOG.md#t-38) (cuotas), [T-40](13-PRIORITIZED-BACKLOG.md#t-40) (guarda de `seed`), [T-63](13-PRIORITIZED-BACKLOG.md#t-63) (códigos de error correctos y atomicidad del registro), [T-65](13-PRIORITIZED-BACKLOG.md#t-65) (`Retry-After` e import), [T-30](13-PRIORITIZED-BACKLOG.md#t-30) (recuperación por correo).
4. **Grupo C:** [T-64](13-PRIORITIZED-BACKLOG.md#t-64) (métricas, paginación, retención, migraciones, workers), [T-66](13-PRIORITIZED-BACKLOG.md#t-66) (validación por esquema).

**No se recomienda rediseñar** la cola, el sistema de lease, la clasificación de fallos, el contrato de la API ni el sistema de migraciones: los cambios son añadidos (estados de rescate, endpoints de operación, guardas), no sustituciones.

### 6.7 Prioridad e impacto en el cierre de la versión

- **Bloqueantes de grupo A de este capítulo:** el ciclo de vida de la cuenta (interruptor de registro, cambio de contraseña, reinicio asistido, `create-admin`: 6.4.3) y las recetas de salida para torneos y tareas atascadas (6.4.1 y 6.4.2). Todos son de esfuerzo bajo a medio.
- **Condicional:** REV-02 sube a P1 y grupo A si FASE 2 mide más de 1 s con registro abierto; con registro por invitación se queda en B.
- **Grupo B (versión siguiente):** BE-01 y BE-02 como salida de producto, BE-03, BE-06, BE-07, BE-11, REV-03, REV-05.
- **Grupo C (poslanzamiento):** BE-04, BE-05, BE-08 a BE-15, REV-06, REV-07, SEC-06.
- Lo afirmado sobre producción (cola, workers, timeout corregido, torneos) es **declarado por el operador**; una CI verde no lo verifica.

---

## 7. Web, usabilidad y experiencia del jugador

### 7.1 Qué se ha analizado

Se ha recorrido el producto con los ojos de alguien que nunca lo ha visto, paso a paso: portada, registro, bot, código, equipamiento, validación, primera batalla, equipos, torneos, resultados, replays y ayuda. Después se ha mirado la navegación, el diseño, la consistencia del idioma, la accesibilidad, los mensajes de error y la facilidad de aprendizaje. También se han revisado al visitante anónimo, las notificaciones, la baja de cuenta, la moderación y la parte legal, y la interfaz de administración.

**Límite importante:** todo es lectura de código y de documentación. Nadie ha usado la web con una persona real ni en un navegador durante esta auditoría; las cifras de pasos son estimaciones por código, no mediciones. La prueba con personas queda para la FASE 2 (guion en [06](06-UX-PRODUCT-REVIEW.md#10-guion-de-prueba-de-usabilidad-para-fase-2), tarea [T-26](13-PRIORITIZED-BACKLOG.md#t-26)).

Fuentes: [06](06-UX-PRODUCT-REVIEW.md), informe del agente de frontend, revisión de producto y decisiones del director (incluida la verificación V-05).

### 7.2 Qué está bien diseñado

- **Una sola carcasa para toda la web** (menú único, página 404 propia, alias `#/ayuda` y `#/docs`). Beneficio: el usuario nunca «sale» de la aplicación sin saberlo.
- **Errores clasificados en una única función** (`apps/web/src/errors.ts`: validación, permisos, no encontrado, conflicto, fallo del servidor, plazo, red, límite de peticiones con espera). Beneficio: evita mensajes como «[object Object]» y da el mismo tono en toda la web.
- **Lista de primeros pasos con estado real**: nueve hitos calculados con datos de la API, no con marcas guardadas en el navegador (`HomePage.tsx`). Beneficio: no se queda desfasada si el usuario hace algo desde otra pantalla.
- **Borradores recuperables** cuando la sesión caduca mientras se escribe código (`ui/draft.ts`). Beneficio: no se pierde trabajo.
- **Diagnóstico de validación** con fichero y motivo, y botones Corregir/Reenviar; mensajes de elegibilidad de batalla con motivo.
- **Ayuda dentro de la web** (glosario, SDK, comandos, equipamiento) con nombres reales de botones.
- **Base de accesibilidad trabajada**: enlace para saltar al contenido, foco visible, avisos con `aria-live` y revisión automática de accesibilidad (axe) en la CI de navegador.

Todo esto **no necesita rediseño**. La web no está mal construida; lo que falla es lo que la rodea: instancia vacía, cuentas, día 2 del administrador y primeros minutos del novato.

### 7.3 Qué funciona

| Capacidad | Estado de evidencia |
|---|---|
| Portada, ayuda, checklist, errores clasificados, 404 | comprobado en código |
| Formulario de batalla con elegibilidad explicada y regla «el mismo bot no puede estar en ambos bandos» (`BattleNewPage.tsx`) | comprobado en código |
| Plantilla de código Python/JS funcional; borrador recuperable | comprobado en código |
| Recorrido de navegador completo (golden path) y axe con 2 excepciones registradas | comprobado en pruebas de CI (que exista no prueba que se comporte bien en un navegador real para un novato) |
| Uso real por jugadores | declarado por el operador; no verificado por la auditoría |
| Móvil (menú plegable bajo 1024 px, tablas apiladas) | comprobado en código; sin verificar en dispositivo |

### 7.4 Qué problemas existen

#### Recorrido del novato, en orden

| # | Paso | ¿Se entiende? | Dónde se bloquea |
|---|---|---|---|
| 0 | Qué es el juego | Sí, la portada lo explica con texto y pasos | No hay capturas ni vídeo; en instalación nueva el ranking está vacío y los replays públicos están apagados por defecto: no se ve ningún combate (UX-12, [DOC-10](10-DOCUMENTATION-AUDIT.md#doc-10)) |
| 1 | Registrarse | Sí, validación local y mensajes en español | Si el operador cierra el registro (lo recomendado), aún no existe mecanismo de invitación: la persona no puede entrar ([SEC-02](05-SECURITY-REVIEW.md), [T-12](13-PRIORITIZED-BACKLOG.md#t-12)) |
| 2 | Crear bot | Sí | Nombre libre, sin guía |
| 3 | Equipar (chasis, arma, munición) | En general sí | Muchas selecciones por bot y jerga (loadout, runtime): UX-03 |
| 4 | Programar | Hay plantilla; la API del bot, el SDK y 12 páginas de guía de bots existen | Editor `textarea` sin resaltado ni salto a línea (UX-04); SDK sólo desde el repositorio (UX-09) |
| 5 | Compilar/validar | Sí, el diagnóstico es bueno | Estados crudos en inglés; si falla y el usuario se va, nadie le avisa (UX-13) |
| 6 | Publicar | Parcialmente | «Publicada» no equivale a «elegible para combatir»; se descubre al fallar (UX-11) |
| 7 | Primera batalla | El formulario sí | **Principal muro:** hay que crear un segundo bot completo porque no hay rival de práctica (UX-01) |
| 8 | Equipos | Sí, opcional | Sin hallazgo propio |
| 9 | Torneos | Parcialmente | El ruleset se teclea como texto libre (UX-07) |
| 10 | Resultados, replays | Sí | Replays de otra versión de formato sin explicación (STR-03); sin aviso de que algo terminó |
| 11 | Ayuda | Sí, dentro de la web | — |

Estimación por código (no medida): 8 hitos y unas 20-30 interacciones hasta la primera batalla, creando dos bots.

La mitigación `demo-teams` (V-05, `apps/api/src/db/cli.ts`) crea equipos de demostración, pero sólo por línea de comandos de administración, para un usuario ya existente y en borrador. **Ayuda al operador a preparar una demo; no da rival de práctica al jugador desde la web.**

#### 7.4.1 [UX-01] Sin rival de práctica: la primera batalla exige dos bots propios
**Prioridad:** P2 · **Grupo de lanzamiento:** A (forma barata) · **Evidencia:** comprobado en código (ausencia por búsqueda; confirmar en laboratorio) · **Tarea:** [T-13](13-PRIORITIZED-BACKLOG.md#t-13)

**Explicación general.** La guía manda crear, equipar, validar y publicar un segundo bot antes de la primera batalla, porque un bot no puede combatir contra sí mismo. La web sí lista bots publicados ajenos, así que en una instancia con jugadores hay rivales. El problema está en la instalación nueva y en el primer usuario: no hay nadie contra quien probar. El director lo fija en P2, grupo A en su forma barata, porque sin rival una demo no se sostiene.

**Solución técnica.**
- Componente: `apps/api/src/db/cli.ts` y el seed de `bootstrap`; `apps/web/src/pages/BattleNewPage.tsx` (y la ficha de versión validada).
- Cambios: bots «sparring» de la plataforma (los comportamientos inactivo, cazador y círculo ya existen en el simulador) publicados por `bootstrap` pasando por el sandbox, y un botón «Probar contra un bot de práctica».
- Comportamiento esperado: tras validar su primer bot, el jugador lanza una batalla sin crear un segundo bot.
- Riesgos: depende de cómo modele la API un bot «de sistema» (propietario, ranking); no fabricar estados publicados saltándose el pipeline.
- Pruebas que lo demuestran: test de navegador «bot propio, batalla contra rival de la casa, replay» (habría fallado antes por falta de rival).
- Esfuerzo: M, incertidumbre media.

#### 7.4.2 [UX-12] Visitante anónimo e instancia recién instalada vacíos
**Prioridad:** P2 (propuesta del redactor, no arbitrada por el revisor técnico) · **Grupo de lanzamiento:** A · **Evidencia:** comprobado en código · **Tarea:** [T-13](13-PRIORITIZED-BACKLOG.md#t-13), [T-05](13-PRIORITIZED-BACKLOG.md#t-05)

**Explicación general.** Sin sesión hay portada, ayuda, ranking, visor y replays como rutas públicas, pero replays y espectador públicos vienen apagados por defecto (`infrastructure/.env.example`). En una instalación nueva el visitante ve texto, un ranking vacío y replays que dan 404. `bootstrap` crea reglas, catálogo y mapas, pero ningún bot. Quien evalúa el producto no ve un combate. Criterio propuesto: entender qué es en 60 segundos y ver al menos un combate, o un mensaje claro de por qué no se ve.

**Solución técnica.**
- Componente: seed de `bootstrap`, configuración pública de la instancia de presentación, README.
- Cambios: bots de la casa (como UX-01), uno o dos replays públicos curados en la instancia de presentación, mensaje explícito cuando los flags públicos están apagados, 2-4 capturas o un GIF en el README.
- Comportamiento esperado: un anónimo ve un combate o sabe por qué no.
- Riesgos: dependencia de UX-01 y del modo de registro.
- Pruebas: recorrido de laboratorio como anónimo con los flags en ambos valores.
- Esfuerzo: S-M, incertidumbre media.

#### 7.4.3 [UX-02] Sin cambio ni recuperación de contraseña
**Prioridad:** P1 si el registro está abierto a externos; P2 con registro por invitación · **Grupo de lanzamiento:** A (cambio + reset asistido por admin); B (recuperación por correo) · **Evidencia:** comprobado en código · **Tarea:** [T-14](13-PRIORITIZED-BACKLOG.md#t-14), [T-30](13-PRIORITIZED-BACKLOG.md#t-30)

**Explicación general.** Quien olvida la contraseña no vuelve: el token de recuperación se crea y se descarta sin canal de envío (`routes/auth.ts`), la pantalla de acceso no tiene «Olvidé mi contraseña» y no existe cambio de contraseña ni pantallas de sesiones o 2FA. El operador no tiene herramienta y debe escribir un hash por SQL. La gravedad baja a P2 si el registro es por invitación (decisión D-01 de la revisión técnica).

**Solución técnica.**
- Componente: `apps/api/src/routes/auth.ts`, nueva pantalla «Mi cuenta» en `apps/web`, pantalla de administración.
- Cambios: cambio de contraseña con reautenticación (ya existe `requireStrongReauth`); reset asistido por el administrador con auditoría; correo después.
- Comportamiento esperado: ningún usuario queda bloqueado y el operador nunca toca SQL.
- Riesgos: el reset asistido es un vector de abuso si el rol de administrador se concede mal; auditarlo.
- Pruebas: test que olvida la contraseña, el admin la restablece, el usuario entra y la sesión antigua queda invalidada.
- Esfuerzo: S-M (reset asistido); L para correo, incertidumbre media.

#### 7.4.4 [UX-09] SDK y documentación sólo desde el repositorio
**Prioridad:** P2 · **Grupo de lanzamiento:** B (A: quickstart o starter kit) · **Evidencia:** comprobado en código · **Tarea:** [T-51](13-PRIORITIZED-BACKLOG.md#t-51), [T-71](13-PRIORITIZED-BACKLOG.md#t-71), [T-01](13-PRIORITIZED-BACKLOG.md#t-01)

**Explicación general.** Hay SDK reales en JavaScript y Python, ejemplos y un simulador local. Pero para usarlos hay que clonar el repositorio, instalar Node 22 y hacer `pip install -e`; los SDK no están en ningún registro de paquetes, los directorios de .NET y Java son sólo un README, y el repo no tiene licencia (capítulo 12), de modo que legalmente nadie puede usarlos. Las referencias de la ayuda apuntan a GitHub.

**Solución técnica.**
- Componente: `docs/user/bots/`, `sdks/*`, `apps/web/src/help`.
- Cambios: quickstart de 5 minutos enlazado desde el README (T-51) o starter kit descargable; rotular .NET/Java como «no implementado»; publicar en registros es decisión de producto (T-71, grupo B).
- Comportamiento esperado: un programador ejecuta un bot contra el simulador local en minutos, sin cuenta.
- Riesgos: el simulador local en Python no está verificado (`UNKNOWN`).
- Pruebas: seguir sólo el quickstart en un laboratorio limpio.
- Esfuerzo: S (quickstart) · M-L (registros).

#### 7.4.5 [UX-14] Sin baja de cuenta, aviso de privacidad ni términos
**Prioridad:** P2 (propuesta) · **Grupo de lanzamiento:** B; A si se aloja una instancia pública con registro de terceros · **Evidencia:** comprobado en código (`/users/me` sólo tiene `get` y `patch`) · **Tarea:** [T-49](13-PRIORITIZED-BACKLOG.md#t-49)

**Explicación general.** Hay datos personales (correo, IP en el registro de auditoría, sesiones) pero ni página de privacidad ni términos ni forma de darse de baja. Con usuarios de terceros esto es una obligación legal (por ejemplo, el derecho a borrar los propios datos), no un adorno; para uso privado entre conocidos puede esperar.

**Solución técnica.**
- Componente: `apps/api/openapi.yaml`, rutas de `/users/me`, web («Mi cuenta»), páginas estáticas.
- Cambios: baja de cuenta con política de retención (qué se anonimiza y qué se conserva), inventario de datos personales, aviso de privacidad y términos.
- Comportamiento esperado: el usuario puede salir y sabe qué se guarda.
- Riesgos: borrar usuarios rompe referencias (batallas, rankings): anonimizar en vez de borrar.
- Pruebas: baja de cuenta y verificación de que los datos personales desaparecen y los replays siguen abriendo.
- Esfuerzo: M. Los textos legales los debe validar el propietario.

#### 7.4.6 [UX-08] Administración por UUID y sin gestión de usuarios; día 2 del administrador
**Prioridad:** P2 · **Grupo de lanzamiento:** B · **Evidencia:** comprobado en código · **Tarea:** [T-43](13-PRIORITIZED-BACKLOG.md#t-43), [T-19](13-PRIORITIZED-BACKLOG.md#t-19), [T-32](13-PRIORITIZED-BACKLOG.md#t-32)

**Explicación general.** Para dar un rol hay que teclear el UUID del usuario (un identificador largo e ilegible) en `RolesPage.tsx`. No hay listado, suspensión ni baja de usuarios. Además, un trabajo atascado en `needs_review` sólo se ve por SQL (BE-02) y un torneo atascado en `closed` no tiene salida desde la web (BE-01). Nada de esto impide jugar, pero es el día a día de quien opera la instancia.

| Situación del administrador | Hoy | Solución |
|---|---|---|
| Asignar rol | UUID tecleado | Selector/listado de usuarios |
| Suspender o dar de baja | No existe | Pantalla de usuarios (T-43) |
| Job en `needs_review` | Sólo SQL | Runbook en A ([T-19](13-PRIORITIZED-BACKLOG.md#t-19)); pantalla en B (T-32) |
| Torneo `closed` atascado | Sin salida | Runbook en A; cancelación administrativa en B ([T-31](13-PRIORITIZED-BACKLOG.md#t-31)) |
| Dejar la instancia sin admin | Posible (REV-06, P3) | Guarda «último admin» ([T-63](13-PRIORITIZED-BACKLOG.md#t-63)) |

**Solución técnica.**
- Componente: `apps/web/src/pages/RolesPage.tsx`, rutas de usuarios en `apps/api`.
- Cambios: endpoint de listado con búsqueda, selector en la web, estados suspendido/baja.
- Comportamiento esperado: ningún UUID tecleado a mano.
- Riesgos: ampliar permisos del rol administrador; exigir reautenticación fuerte.
- Pruebas: cambiar un rol desde la web sin conocer el UUID.
- Esfuerzo: M.

#### 7.4.7 UX-03 y resto de hallazgos menores

| Problema | Explicación breve | Solución | Prioridad |
|---|---|---|---|
| **UX-03** Estados y jerga en inglés mezclados | `BotsPage.tsx` pinta `draft`, `validated`, `published`, `frozen`, y «runtime», «build», «loadout», «ruleset» junto a texto en español | Mapa de etiquetas con el término técnico entre paréntesis (ya existe `TOURNAMENT_STATE_NAME`) · [T-42](13-PRIORITIZED-BACKLOG.md#t-42) | P3 · B |
| **UX-07** Ruleset de torneo como texto libre | `<input>` con `mvp-default`; el error llega crudo | `<select>` alimentado por la API de rulesets y `describeApiError` · T-42 | P2 · B |
| **UX-04** Editor `textarea` sin ayuda | 16 filas, un fichero, sin resaltado ni salto a línea; no bloquea (el programador serio usa su editor) | Editor ligero y salto desde el diagnóstico · [T-70](13-PRIORITIZED-BACKLOG.md#t-70) | P2 · C |
| **UX-05** `aria-label` con slugs técnicos | 23 etiquetas únicas tipo «nuevo-bot», «rol-userid» sustituyen al `<label>` visible | Usar `<label>` real y `data-testid` para pruebas · T-42 | P3 · B |
| **UX-06** Tema único oscuro, sin reduced-motion; contraste no medido | Falta respetar preferencias del sistema; el contraste es hipótesis | Medir con axe `color-contrast`; añadir `prefers-reduced-motion` · T-70 | P3 · C |
| **UX-10** Visor/replay: teclado y alternativa textual | Controles con nombre, pero el canvas no narra eventos; la excepción de axe podría estar obsoleta (hipótesis) | Verificar en FASE 2 · T-70 | P2 hipótesis · C |
| **UX-13** Sin notificaciones | Ni correo ni aviso web de build terminado, batalla jugada o torneo cerrado | Indicador de «novedades» en la web sin correo · [T-61](13-PRIORITIZED-BACKLOG.md#t-61) | P3 · B |
| **UX-11** «Publicada» pero no elegible, avisado tarde | Hipótesis: la ficha de la versión quizá no avisa antes de intentar la batalla; no verificado | Mostrar elegibilidad y motivo en la ficha, reutilizando `version-eligibility.tsx` · [T-44](13-PRIORITIZED-BACKLOG.md#t-44) | P2 hipótesis · B (A si FASE 2 lo confirma) |
| **UX-15** Sin moderación de contenido público | Existen rol `moderator` y estados `suspended`, pero no se verificó si un admin puede renombrar u ocultar un bot desde la web | Renombrar/ocultar con auditoría; probar con un nombre ofensivo sin `psql` · [T-62](13-PRIORITIZED-BACKLOG.md#t-62) | P2 propuesta · C (A con registro abierto) |
| **UX-16** Bucle «mi bot pierde: ¿por qué?» | No evaluado por nadie | Medir qué ve el autor tras una derrota · T-26 | hipótesis |
| Idioma único (español) | Cadenas en el código, sin capa de traducción; declararlo | Mencionarlo en el README; inglés posterior · [T-83](13-PRIORITIZED-BACKLOG.md#t-83) | P3 · C |

### 7.5 Qué falta

- Capturas, GIF o vídeo, y al menos un combate visible para un anónimo.
- Rival de práctica y bots de la casa.
- Mecanismo de invitación si el registro se cierra.
- Cambio y reset de contraseña, «Mi cuenta», baja, privacidad y términos.
- Listado y gestión de usuarios, superficie para jobs atascados y moderación.
- Un quickstart de bots y el SDK instalable sin clonar.
- Una prueba de usabilidad con 5-8 personas y una pasada de accesibilidad con teclado, lector de pantalla y móvil real.

### 7.6 Soluciones técnicas recomendadas

1. Bots de la casa + «probar contra bot de práctica» + replays curados (UX-01, UX-12; T-13, T-05).
2. Cambio de contraseña y reset asistido (UX-02; T-14), junto con el interruptor de registro (T-12).
3. Quickstart de 5 minutos (UX-09; T-51) y licencia (T-01).
4. Runbooks de salida para torneo `closed` y `needs_review` (T-19), antes de las pantallas (T-31, T-32).
5. Pulido barato: etiquetas en español, `aria-label`, selector de ruleset (UX-03, 05, 07; T-42).
6. Aviso de elegibilidad (UX-11; T-44), gestión de usuarios (UX-08; T-43), baja y privacidad (UX-14; T-49).
7. Notificaciones, moderación, editor y estudio con personas (T-61, T-62, T-70).

Fuera de la lista a propósito: inglés completo y recuperación de contraseña por correo (más caros y no bloquean).

### 7.7 Prioridad e impacto en el cierre de la versión

Ningún hallazgo UX es P0 y no hay P1 firme (UX-02 lo sería sólo con registro abierto a externos). Condicionan la presentación pública, en grupo A: **UX-01, UX-12 y UX-02 (en su forma barata)**. En grupo B: UX-08, UX-09 (salvo quickstart), UX-11 salvo que FASE 2 lo confirme, UX-14 salvo instancia pública con terceros, UX-03/05/07 y UX-13. UX-04, UX-06, UX-10 y UX-15 (salvo registro abierto) son C. Veredicto de la dimensión: aceptable para jugadores que ya están dentro; **evidencia insuficiente para presentar** hasta que una persona ajena complete el recorrido.

---

## 8. Instalación, configuración y administración

> ### Pregunta obligatoria: ¿una persona con conocimientos básicos de Linux y Docker puede instalar S9 AI Arena siguiendo la documentación pública?
>
> **Respuesta: NO, hoy no.** Con la documentación pública actual esa persona no llega a un producto que juegue batallas sin ayuda de los autores.
>
> **Por qué.** Siguiendo `docs/operations/installation.md` se llega a un conjunto de servicios «sanos» (`healthy`, `/healthz` responde), pero ese sistema **no ejecuta bots ni batallas**: la variable `DOCKER_PROXY_URL` queda vacía, el worker no reclama los combates y las compilaciones de bots se rechazan por «sandbox no verificado» ([OPS-01](07-INSTALLATION-OPERATIONS.md#ops-01)). La persona vería todo verde y las batallas se quedarían en `scheduled` sin explicación.
>
> **En qué paso se atascaría.** (1) Antes de empezar: la guía no explica cómo instalar Docker ni cuánto hardware hace falta. (2) Al copiar la plantilla `.env.example`: lleva `TAG=latest` (la CI sólo publica `sha-<commit>`), enlaces a un documento que no existe y valores de la instalación del operador ([OPS-04](07-INSTALLATION-OPERATIONS.md#ops-04)). (3) En el primer administrador: hay que registrarse por web y promocionarse con SQL directo ([OPS-02](07-INSTALLATION-OPERATIONS.md#ops-02)). (4) El punto de abandono más probable: la segunda instalación «de host» (proxy de Docker como root, Node ≥22.15, firewall, runtimes por digest, un sha256 que sólo está en un run de CI), escrita como migración de producción y no como instalación en limpio ([OPS-03](07-INSTALLATION-OPERATIONS.md#ops-03)).
>
> **Qué hace falta para que sea «sí».** Una release etiquetada con el bundle del proxy y su sha256 ([T-10](13-PRIORITIZED-BACKLOG.md#t-10)); un `install-host.sh` con preflight ([T-08](13-PRIORITIZED-BACKLOG.md#t-08)); `.env.example` correcto ([T-06](13-PRIORITIZED-BACKLOG.md#t-06)); `create-admin` ([T-11](13-PRIORITIZED-BACKLOG.md#t-11)); un humo real que juegue una batalla ([T-07](13-PRIORITIZED-BACKLOG.md#t-07)); guía única con requisitos, Debian 12 y receta TLS ([T-09](13-PRIORITIZED-BACKLOG.md#t-09)); y la prueba de que funciona con una persona ajena ([T-21](13-PRIORITIZED-BACKLOG.md#t-21)).
>
> **Matiz honesto.** Un administrador de sistemas experto, con paciencia, sí llega a un stack sano; y el operador reinstaló con éxito (evidencia de tercero, ver 8.3), pero con intervenciones manuales fuera del guion. **No se ha medido ningún tiempo de instalación**: los recuentos de pasos son estimaciones por lectura de la documentación. El escenario S01 (y S12, con una persona ajena) de la FASE 2 lo medirá.

### 8.1 Qué se ha analizado

Todo el recorrido de una persona ajena: requisitos de hardware y software, Docker, instalación limpia, configuración inicial (`.env`, `init-secrets.sh`), dominio y HTTPS, creación del administrador, secretos, proxy de Docker del host y firewall, concurrencia, volúmenes, backups, restauración, actualización, rollback, monitorización, desinstalación y diagnóstico. Fuentes: [07-INSTALLATION-OPERATIONS](07-INSTALLATION-OPERATIONS.md), el informe de DevOps, la revisión técnica y la revisión de producto (§4), y las tareas T-06..T-10 y T-19..T-22 del [backlog](13-PRIORITIZED-BACKLOG.md).

Límites: en FASE 1 **no se instaló, arrancó ni restauró nada**. Se leyeron documentación y código (main 8f380eb). La reinstalación real del operador es evidencia de tercero, no reverificada.

### 8.2 Qué está bien diseñado

- **Imágenes inmutables por commit (`sha-<commit>`) y compose canónico con comprobaciones automáticas.** Buena decisión: lo que se instala es exactamente lo que probó la CI. No necesita rediseño.
- **Secretos en ficheros, no en la línea de comandos ni en `.env`; `init-secrets.sh` idempotente.** Evita filtraciones por listados de procesos y permite repetir el paso sin daño.
- **Backup que vigila la copia, no el proceso.** El healthcheck mira que exista una copia reciente (26 h), que es lo que importa; `--init-repo` es explícito, así no se crea un repositorio de backup por accidente.
- **Proxy de Docker con frontera de privilegio explícita.** La complejidad de instalarlo es en parte inherente a su seguridad: **no debe relajarse para facilitar la adopción**; hay que empaquetarla (T-08, T-10), no rebajarla.
- **Documentación operativa honesta**: cada documento declara qué FUNCIONA, qué es PARCIAL y qué está PENDIENTE.
- **Export portable de bots y equipos**, verificado por el operador.

### 8.3 Qué funciona

| Elemento | Estado de evidencia |
|---|---|
| El stack Compose se levanta desde cero y pasa el flujo funcional, el proxy de contenedores, backup y restore contra un destino SFTP | En pruebas de CI (run `ci` de 8f380eb); demuestra la mecánica, **no** una instalación de tercero. Los jobs `deploy-staging` y `smoke-and-promote` figuran en verde pero son no-op: no son evidencia de despliegue |
| Reinstalación limpia sobre Debian 12, con proxy, firewall, runtimes y backup (16 comprobaciones) | Declarado por el operador (evidencia de tercero, no reverificada) |
| Restauración real a una base de datos temporal (40/40 tablas idénticas); export portable 37/37 bots y 8/8 equipos | Declarado por el operador, parcial: no es el procedimiento completo de `restore.md` en host limpio |
| Copia correcta desde la máquina reinstalada y `restic check` correcto | Declarado por el operador |
| Guías de diagnóstico y resolución de problemas | Sólo documentado (buenas, sin comando único de «estoy sano») |

**Intervenciones manuales observadas en la reinstalación del operador** (evidencia de tercero, sin datos de su infraestructura):

| # | Intervención fuera del guion | ¿La sufriría una persona ajena? |
|---|---|---|
| 1 | La imagen de nube de la máquina no detectó la configuración inicial; se sembró a mano | No (específico de su plataforma) |
| 2 | Instalar Docker Engine y Compose desde el repositorio oficial | Sí (no documentado) |
| 3 | Instalar Node 22.x desde un repositorio externo para construir el bundle del proxy | Sí (la guía lo llama «opcional») |
| 4 | Clon de root fijado al SHA, `npm ci --ignore-scripts`, build y comparación del sha256 con el de un run de CI | Sí |
| 5 | Instalar el firewall de host y su temporizador | Sí |
| 6 | Descargar las imágenes de runtime por digest | Sí |
| 7 | `bot-build-worker` reinició en bucle hasta ejecutar `bootstrap` (se hizo `up` antes) | Sí |
| 8 | Elegir otro `RESTIC_HOSTNAME` y recolocar secretos de backup | En parte |
| 9 | Interceptar `forget --prune` al lanzar `backup.sh` a mano para no tocar snapshots migrados | No en su motivo; sí con un repositorio de sólo anexar |
| 10 | Primer administrador: registro web y promoción por SQL | Sí |
| 11 | `TOURNAMENT_WORKER_CONCURRENCY=2` por el tamaño de la máquina; claves de streaming reintroducidas por la web | Sí |

Recuento propio sobre la tabla: **8 intervenciones atribuibles a cualquier persona ajena (2, 3, 4, 5, 6, 7, 10, 11), 2 parciales (8, 9) y 1 específica del operador (1)**. El informe de DevOps habla de «5» en su resumen y de «≥6» en su cierre; no coinciden entre sí ni con la tabla. **Discrepancia D-18 abierta**; se usa el conteo de la tabla.

### 8.4 Qué problemas existen

#### 8.4.1 [OPS-01] Una instalación «verde» que no ejecuta batallas
**Prioridad:** P1 · **Grupo de lanzamiento:** A · **Evidencia:** comprobado en código y documentación (confirmado con matiz por la revisión técnica) · **Tarea:** [T-08](13-PRIORITIZED-BACKLOG.md#t-08), T-09, T-07

**Explicación general.** Es el hallazgo clave del capítulo. Si se sigue la guía principal, todos los servicios aparecen como sanos, pero falta una dirección de configuración (`DOCKER_PROXY_URL`): la del proxy que permite a los trabajadores crear las «cajas» donde corren los bots. Sin ella, el trabajador de torneos no recoge ninguna batalla, las batallas se quedan esperando (estado `scheduled`) y todo bot que se intenta compilar se rechaza. Ninguna comprobación existente avisa de ello. Resultado: el propietario ve todo en verde y la plataforma no hace lo principal. Matiz de la revisión técnica: la guía **sí** describe el proxy y las imágenes de runtime, pero como «opcionales» (texto obsoleto), sin el paso de fijar la variable en `.env` ni el firewall.

**Solución técnica.**
- Componente: `docs/operations/installation.md`; nuevo `infrastructure/scripts/install-host.sh`.
- Cambios: convertir la ejecución de bots en paso obligatorio; un script que haga runtimes → red de control → firewall → proxy (desde el asset de la release) → `DOCKER_PROXY_URL` en `.env`, con preflight previo; y una comprobación «puede jugar» (batalla de humo), no sólo `/healthz`.
- Comportamiento esperado: la instalación termina con una batalla `finished`, o con un error claro que dice qué falta.
- Riesgos: el script modifica el firewall del host; probarlo sólo en laboratorio.
- Pruebas que lo demuestran: S01-S05 de FASE 2; en una instalación sin proxy, el humo debe fallar (hoy no falla).
- Esfuerzo: S (documentación) + M (script) · incertidumbre baja-media.

#### 8.4.2 [OPS-03] Instalar el proxy en limpio exige root, Node ≥22.15 y un sha256 que sólo vive en un run de CI
**Prioridad:** P1 · **Grupo de lanzamiento:** A (forma mínima) · **Evidencia:** comprobado en código + declarado por el operador · **Tarea:** [T-10](13-PRIORITIZED-BACKLOG.md#t-10), T-08

**Explicación general.** El procedimiento documentado es una migración: clonar como root al SHA, construir el paquete del proxy y compararlo con un hash publicado en el resumen de un run de CI. Una persona ajena tendría que consultar la interfaz de GitHub Actions; que esos artefactos exijan sesión o caduquen es una hipótesis, no verificada. Debian 12 trae Node 18, y el instalador valida Node ≥22.15 (queda por determinar si lo necesita en ejecución aunque no compile).

**Solución técnica.**
- Componente: flujo de release en `.github/workflows/`; `infrastructure/scripts/install-docker-proxy.sh`.
- Cambios: adjuntar a la release el bundle y su sha256; que `install-host.sh` lo descargue y verifique; declarar Node ≥22.15 como requisito si hace falta.
- Comportamiento esperado: instalar el proxy sin compilar y sin consultar la CI.
- Riesgos: política de confianza (asset de release frente a build local) pendiente de decisión del operador.
- Pruebas: S04; un tercero obtiene el hash sin cuenta de GitHub.
- Esfuerzo: M · incertidumbre media.

#### 8.4.3 [OPS-04] La plantilla `.env.example` y `smoke.sh` apuntan a valores y documentos inexistentes
**Prioridad:** P1 · **Grupo de lanzamiento:** A · **Evidencia:** comprobado en código · **Tarea:** [T-06](13-PRIORITIZED-BACKLOG.md#t-06), [T-07](13-PRIORITIZED-BACKLOG.md#t-07)

**Explicación general.** La plantilla de configuración (`infrastructure/.env.example`) pide una versión de la plataforma que no existe (`latest`: la CI sólo publica versiones con el código del cambio o con número de versión). Si se sigue tal cual, la descarga de imágenes falla o, peor, trae sin avisar una imagen vieja (no comprobado que exista). Además, la plantilla enlaza a un documento que no existe y trae por defecto datos de la instalación del autor (riesgo de seguridad bajo, pero para el producto es P1). La plantilla de la raíz del repositorio es de un prototipo antiguo. Y la prueba rápida de que todo funciona (`smoke.sh`) está mal hecha: pregunta por direcciones que no existen, así que nunca puede salir bien, o sale bien por error. **Defecto confirmado en código.**

**Solución técnica.**
- Componente: `infrastructure/.env.example`, `infrastructure/scripts/smoke.sh`, `.env.example` de la raíz, `docker-compose.demo.yml`.
- Cambios: `TAG=` vacío con fallo claro, dominio `example.com`, quitar enlaces muertos, rehacer o borrar el humo, retirar ficheros de la v1.
- Comportamiento esperado: copiar la plantilla y rellenar lleva a un arranque o a un error comprensible.
- Riesgos: ninguno relevante; comprobar `docker manifest inspect` del `:latest`.
- Pruebas: `$DC pull` con la plantilla recién copiada; un test de humo que falle con una instalación rota.
- Esfuerzo: S · incertidumbre baja.

#### 8.4.4 [OPS-02] El primer administrador exige SQL directo
**Prioridad:** P2 (rebajada de P1 por la revisión técnica) · **Grupo de lanzamiento:** A · **Evidencia:** comprobado en código · **Tarea:** [T-11](13-PRIORITIZED-BACKLOG.md#t-11), T-12

**Explicación general.** El comando `bootstrap` carga las reglas, el catálogo y los mapas, pero no crea ningún usuario. Quien se registra queda como jugador normal; la única forma de tener un administrador es escribir a mano una orden en la base de datos (con la herramienta `psql`, según `first-run.md`). Si te equivocas al escribir el email, no pasa nada y no avisa. Si se pierde al único administrador, hay que repetir la orden. La revisión técnica descarta que sea una brecha de seguridad: es una incomodidad, no una vulnerabilidad. Hay un riesgo relacionado: el comando `seed` (datos de prueba de desarrollo) crea una cuenta administradora con una contraseña pública que está en el repositorio, y sólo la documentación prohíbe usarlo en producción; no hay ninguna barrera técnica (SEC-14/REV-05, P2, grupo B). Además, el modo de registro (abierto o cerrado) debe decidirlo quien instala (SEC-02).

**Solución técnica.**
- Componente: `apps/api/src/db/cli.ts`; `docs/operations/first-run.md`.
- Cambios: comando `create-admin --email <e> [--password-file <f>]`, idempotente y con auditoría; guarda de entorno en `seed`; modo `REGISTRATION_MODE` explícito.
- Comportamiento esperado: primer administrador sin tocar SQL; error visible si el email no existe.
- Riesgos: el comando es una vía privilegiada: exigir acceso al host y auditar.
- Pruebas: test de CI con mutante (D5) y escenario S03.
- Esfuerzo: S · incertidumbre baja.

#### 8.4.5 [OPS-05] Sin requisitos de hardware, disco ni sistema operativo
**Prioridad:** P2 (rebajada de P1) · **Grupo de lanzamiento:** A (tabla) · **Evidencia:** comprobado en documentación; cifras no medidas · **Tarea:** [T-09](13-PRIORITIZED-BACKLOG.md#t-09), [T-22](13-PRIORITIZED-BACKLOG.md#t-22)

**Explicación general.** No hay mínimo ni recomendado. Sólo hay hechos dispersos: producción corre con 4 vCPU y ≈7 GB; la documentación admite que «3 batallas simultáneas ahogaron la VM» y recomienda fijar `TOURNAMENT_WORKER_CONCURRENCY`; el streaming exige ≥3 vCPU libres y ≥1 GiB sin swap. Los **límites** de compose (no reservas) suman, según el informe de DevOps, ≈19,5 CPU y ≈12,75 GiB en el perfil `production`, más 4 CPU/4 GiB con `streaming`, y cada bot hasta 1 GiB y 2 CPU: una suma que la revisión técnica no repitió. Es decir, los límites superan con mucho a la máquina real de producción. Tampoco se dimensiona el disco (imágenes, volúmenes, replays, copias de trabajo del backup, MP4 del streamer). Sólo Debian 12 está evidenciado; el firewall asume iptables-nft y su persistencia con systemd «no está ensayada». Una prueba de carga ya degradó un host compartido del operador.

**Solución técnica.**
- Componente: `docs/operations/installation.md`, `configuration.md`.
- Cambios: tabla mínimo/recomendado por perfil, concurrencia sugerida, disco y declaración «soportado: Debian 12»; **rellenarla sólo con la medición S06**, no con estimaciones.
- Comportamiento esperado: el instalador sabe, antes de empezar, si su máquina sirve (preflight con umbrales).
- Riesgos: publicar cifras inventadas.
- Pruebas: S06 en laboratorio aislado, nunca en producción.
- Esfuerzo: S (documento) + M (medición) · incertidumbre media.

#### 8.4.6 [OPS-06] Backup: destino externo obligatorio sin guía, poda no desactivable, sin alertas por defecto
**Prioridad:** P1 · **Grupo de lanzamiento:** B (aviso mínimo en A) · **Evidencia:** comprobado en código + declarado por el operador · **Tarea:** [T-07](13-PRIORITIZED-BACKLOG.md#t-07), T-34

**Explicación general.** El backup guarda las copias en un almacén externo con la herramienta restic. Si no se configura ese almacén, el servicio de backup arranca pero se queda marcado como «no sano» y no copia nada; sólo avisa tras 26 horas, y la alerta no existe si la observabilidad (el paquete opcional de monitorización) está apagada. No hay guía de cómo preparar el almacén ni opción de guardar en un disco local gestionado. El script borra siempre las copias antiguas (`forget --prune`) sin interruptor para evitarlo (el operador tuvo que interceptarlo). El fichero `.env`, con las claves de la instalación, no entra en la copia: perderlo impide restaurar. Y si la copia vive en la misma máquina física que el servidor, no es una copia independiente. El operador declara que el backup le funciona, pero la auditoría no lo ha verificado y no se ha ensayado una restauración completa: evidencia insuficiente.

**Solución técnica.**
- Componente: `infrastructure/backup/backup.sh`, `entrypoint.sh`, `docs/operations/backup.md`.
- Cambios: incluir `.env` en el snapshot de configuración; `BACKUP_PRUNE=0`; guía breve de destino SFTP o local; aviso/fallo en `up`; alerta mínima sin `observability`.
- Comportamiento esperado: una instalación sin destino de backup lo dice en alto.
- Riesgos: custodiar el `.env` en la copia exige proteger la contraseña del repositorio.
- Pruebas: arrancar sin `RESTIC_REPOSITORY` y obtener rc ≠ 0 en el doctor; destino de sólo anexar.
- Esfuerzo: M · incertidumbre baja.

#### 8.4.7 [OPS-07] Restauración completa manual y sin ensayo reciente
**Prioridad:** P1 · **Grupo de lanzamiento:** B (el ensayo en laboratorio, A) · **Evidencia:** comprobado en código; restauración parcial declarada por el operador · **Tarea:** [T-20](13-PRIORITIZED-BACKLOG.md#t-20)

**Explicación general.** `restore.sh` restaura a un directorio; base de datos y volúmenes se colocan a mano en siete fases. Hay una restauración real a base temporal, pero ninguna del procedimiento completo en host limpio ni con tiempos. Sin la contraseña del repositorio, la clave SSH y `known_hosts` guardados fuera del servidor, no hay restauración. Un backup que nunca se ha restaurado entero es una esperanza, no una garantía.

**Solución técnica.**
- Componente: `docs/operations/restore.md`; futuro `scripts/ops/restore-all.sh`.
- Cambios: ensayo completo en laboratorio con acta (A); automatización después (B); custodia fuera de banda como requisito.
- Comportamiento esperado: tras destruir la máquina, restaurar con sólo la custodia, con tiempos y pasos registrados.
- Riesgos: puede descubrir que no se restauran replays o artefactos de bots (convertiría la verificación en corrección).
- Pruebas: S08 (conteo y md5 por tabla).
- Esfuerzo: M · incertidumbre media.

#### 8.4.8 [OPS-09] HTTPS sin emisión de certificados
**Prioridad:** P2 · **Grupo de lanzamiento:** B (receta con proxy en A; perfil ACME en C) · **Evidencia:** comprobado en código · **Tarea:** [T-09](13-PRIORITIZED-BACKLOG.md#t-09), T-72

**Explicación general.** El gateway usa certificados autofirmados de 365 días generados por `init-secrets.sh`, o delega en un proxy inverso externo. No hay ACME ni receta con Caddy o Traefik. Con autofirmado el navegador avisa en la primera visita; el comportamiento de streamer y WebSocket con ese certificado no está verificado y la caducidad anual no avisa (hipótesis).

**Solución técnica.** Componente: `docs/operations/networking.md`. Cambios: receta documentada con un proxy que emita certificados y modo `behind-proxy`. Esperado: HTTPS válido sin intervención. Riesgos: saltos de proxy de confianza (`TRUST_PROXY_HOPS`) mal puestos falsean la IP del bloqueo de login. Pruebas: S02. Esfuerzo: M · incertidumbre media.

#### 8.4.9 [OPS-14] Sin releases versionadas ni changelog
**Prioridad:** P2 · **Grupo de lanzamiento:** A (forma mínima) · **Evidencia:** comprobado (0 tags, 0 releases) · **Tarea:** [T-10](13-PRIORITIZED-BACKLOG.md#t-10)

**Explicación general.** Nadie puede decir «instala la 0.x» ni saber qué cambió. Sin release no existe dónde colgar el bundle del proxy (OPS-03), ni un punto de referencia para actualizar o volver atrás. Es una dependencia de varias piezas de este capítulo.

**Solución técnica.** Componente: `.github/workflows/`. Cambios: tag `v0.x.y`, notas, digests de imágenes, bundle y sha256. Esperado: instalación verificable por versión. Riesgos: publicar desde un SHA no congelado; el flujo sólo se dispara desde un tag. Pruebas: pre-release de ensayo. Esfuerzo: S-M · incertidumbre media (⚑ decisión del operador).

#### 8.4.10 [OPS-08, OPS-10, OPS-12] Actualización, rollback, diagnóstico y desinstalación sin herramienta
**Prioridad:** P2 · **Grupo de lanzamiento:** B/C · **Evidencia:** comprobado en código / hipótesis donde se indica · **Tarea:** T-21, backlog B/C

**Explicación general.** (OPS-08, OPS-10, OPS-12.) Actualizar la plataforma exige unos diez pasos manuales (hacer copia, cambiar la versión en la configuración, descargar las imágenes nuevas, arrancar los servicios por grupos y aplicar a mano los cambios de la base de datos). Es seguro, pero lento y fácil de equivocar. La API no aplica esos cambios sola al arrancar, así que podría haber un rato con la base de datos en la versión vieja (hipótesis). Si algo sale mal, volver atrás sólo es posible con la copia de seguridad: el deshacer de las migraciones (cambios de la base de datos) sólo cubre las números 016 a 019. No existe procedimiento de desinstalación; sólo se avisa de que una orden concreta borra todos los datos. Tampoco hay ningún comando que diga «la instalación está sana»: el comprobador de preparación nunca da luz verde y la comprobación de salud no informa del estado de las migraciones. Las 11 alertas del paquete de monitorización no se han probado en una instalación real y, si no se configura a quién avisar, no avisan a nadie por defecto.

**Solución técnica.** Componente: `infrastructure/scripts/` y `docs/operations/`. Cambios: `upgrade.sh --to sha-<x>`, `uninstall.md` + `--dry-run`, `doctor` completo (versiones, migraciones, proxy, humo, último backup, disco, firewall). Esperado: una orden por operación. Riesgos: scripts destructivos: dry-run por defecto. Pruebas: S09, S10, S11. Esfuerzo: M-L · incertidumbre media.

**Problemas menores**

| Problema | Explicación breve | Solución | Prioridad |
|---|---|---|---|
| OPS-13 `up` antes de `bootstrap` | `bot-build-worker` reinicia en bucle; la guía cuenta «12 servicios» y «11 healthy», pero son 13 | Orden `up -d postgres queue` → `bootstrap` → `up -d` (T-09) | P3 · A |
| OPS-11 README «no funcional» | El README contradice el estado actual (DOC-01) | Reescribir el README | P2 · A |
| OPS-15 SO fuera de Debian | Ubuntu/otros no probados | Declarar Debian 12; probar Ubuntu 24.04 (S01-bis) | P3 · C |
| REV-06 sin administradores | `setUserRoles` puede dejar la instalación sin admin | Impedir quitar el último admin | P3 · C |
| QA-01 nightly en rojo | Último verde programado 2026-08-04; sin esa señal no se congela versión | Preparar ffmpeg/userns en `nightly.yml`; 7 verdes seguidos | P2 · A |

### 8.5 Qué falta

- Tabla de requisitos medida y SO soportado declarado (T-09, T-22).
- Instalador de host reanudable con preflight y doctor (T-08, T-07), y release con bundle (T-10).
- `create-admin` y modo de registro explícito (T-11, T-12).
- Guía de destino de backup, aviso si no está configurado, ensayo completo de restore (T-20).
- Receta TLS; procedimiento de desinstalación; comando de actualización/rollback.
- Runbooks de salida para torneo `closed` atascado y jobs `needs_review` (T-19).
- Ensayo de instalación por una persona ajena (T-21). Todo el bloque de pruebas S01-S12 está **bloqueado hasta FASE 2**.

### 8.6 Soluciones técnicas recomendadas

**Asistente web o CLI guiado.** Recomendación (informe de DevOps, coincidente con la revisión de producto): **CLI guiado idempotente**, no asistente web. Lo difícil (Docker, proxy como root, firewall, runtimes, backup, TLS) es de host y exige root: una web no puede ni debe hacerlo, y además necesita el stack ya levantado. Un asistente web aportaría poco (bootstrap, admin y comprobaciones) y expondría superficie mientras esté accesible. Existe `packages/first-run/` (13 dominios con pruebas y mutantes) sin interfaz, que puede reutilizarse como lista de comprobaciones del `doctor`. Un panel web de estado puede venir después, nunca como instalador (grupo C/D).

Paquete mínimo para la versión presentable (grupo A): instalador de host + `create-admin` + doctor-lite que juegue una batalla de humo + release con bundle del proxy + receta TLS. `s9ctl` completo (doctor, `upgrade.sh`, `restore-all.sh`, CLI interactivo) es grupo B; desinstalación y perfil ACME, C.

**Ruta de instalación objetivo (versión presentable).** Orden de dependencias entre tareas: T-10 → T-08 → T-06/T-09/T-11 → T-07 → T-21.

1. **Preparar el host**: Debian 12 con Docker y Compose, cumpliendo la tabla de requisitos (el preflight lo comprueba).
2. **Obtener la release** `v0.x.y` (imágenes por digest, bundle del proxy y sha256).
3. **`install-host.sh`**: runtimes, red de control, firewall y proxy desde la release, con `DOCKER_PROXY_URL` escrito en `.env`.
4. **Configurar**: `init-secrets.sh` y `.env` desde una plantilla correcta; destino de backup y modo de registro elegidos.
5. **Arrancar** en el orden correcto (`postgres`+`queue` → `bootstrap` → `up -d`).
6. **`create-admin`**: primer administrador sin SQL.
7. **`doctor`**: versión por servicio, proxy alcanzable, último backup y una **batalla de humo `finished`**; rc ≠ 0 si no puede jugar.
8. **HTTPS**: receta con proxy externo que emite certificados.

Cada paso debe ser reanudable, con `--dry-run`. La cifra de pasos y tiempo reales no se afirma: la medirán S01/S12.

Resumen ordenado: (1) T-10 release; (2) T-08 instalador y T-06 plantilla; (3) T-11 admin y T-09 guía; (4) T-07 humo real y aviso de backup; (5) T-22 medición de recursos; (6) T-20 ensayo de restore; (7) T-19 runbooks; (8) T-21 ensayo con persona ajena. **Lo que no necesita rediseño:** el diseño de imágenes inmutables, secretos por fichero, backup con healthcheck sobre la copia y proxy con frontera de privilegio; hay que empaquetarlos, no rehacerlos.

### 8.7 Prioridad e impacto en el cierre de la versión

- **Bloquean la versión (P1, grupo A):** OPS-01, OPS-03 (forma mínima), OPS-04, junto con OPS-14 como dependencia. Sin ellos la respuesta a la pregunta obligatoria sigue siendo «no».
- **Necesarios para presentar (A, P2/P3):** OPS-02, OPS-05 (tabla), OPS-11, OPS-13, nightly (QA-01) y el ensayo T-21 como prueba de cierre del OPS-01.
- **Grupo B (antes de abrir a terceros sin soporte):** OPS-06, OPS-07 (automatización), OPS-08, OPS-12, OPS-09 (salvo la receta).
- **Grupo C:** OPS-10, OPS-15 y ACME.
- Estado actual: tras FASE 1, la ruta de instalación es **NOT_READY**; el camino a «listo con condiciones» es mayoritariamente documentación y scripts pequeños, pero depende de publicar releases (OPS-03/OPS-14), así que no es tan corto como parece. Producción funciona según el operador; eso no equivale a que la instalación sea reproducible por un tercero.

---

## 9. Seguridad

### 9.1 Qué se ha analizado

La revisión de seguridad fue **estática** (FASE 1): se leyó el código de la rama principal (commit 8f380eb), la configuración de contenedores, los workflows de CI y la configuración por defecto de una instalación nueva. No se ejecutó nada contra el producto, no se miró el servidor de producción, el firewall aplicado ni los permisos de ficheros del servidor. Todo lo que se dice de producción es, como mucho, «declarado por el operador». Detalle completo en [05-SECURITY-REVIEW.md](05-SECURITY-REVIEW.md).

**Modelo de amenazas en lenguaje llano.** S9 AI Arena es una plataforma donde la gente sube programas (los «bots») que el servidor compila y ejecuta en batallas. Eso define tres circunstancias que condicionan toda la seguridad:

1. **Se ejecuta código no confiable de desconocidos.** Cualquier jugador puede subir un bot malicioso que intente escapar del contenedor, agotar la máquina, leer credenciales o espiar a otros bots. Es la amenaza principal.
2. **El registro está abierto por defecto.** Cualquiera puede crear una cuenta con rol de desarrollador sin verificación. Un atacante no necesita ser invitado.
3. **El repositorio es público.** Todo lo que se escribe en ficheros rastreados lo ve cualquiera, incluido el historial.

Además hay amenazas más clásicas: fuerza bruta contra el login, clickjacking (que una web ajena enmarque la nuestra para engañar al usuario), vulnerabilidades en dependencias, y que un jugador abuse de funciones caras (verificar replays, encolar prácticas) para saturar la API.

Fuera del alcance de esta fase: compromiso del servidor físico, del hipervisor, del proxy inverso del operador y del almacenamiento de backup externo.

### 9.2 Qué está bien diseñado

La base de seguridad es **sólida y no necesita rediseño**. Cada decisión de abajo es buena por lo que evita:

- **Ningún servicio monta `docker.sock`.** Ese fichero da control total del servidor a quien lo toque. En su lugar hay un *proxy de Docker* propio que sólo permite crear, arrancar, parar, inspeccionar, borrar y listar contenedores, sólo con imágenes de una lista fija de digests (`DIGESTS.lock`) y con etiquetas impuestas. Un fallo en un servicio no equivale a control del servidor. Un escáner en la CI vigila que nadie vuelva a montar el socket.
- **Sandbox del bot endurecido.** Cada bot corre sin privilegios (usuario no root), con todas las capacidades de Linux retiradas, sistema de ficheros de sólo lectura, `/tmp` sin ejecución, sin DNS, límites obligatorios de CPU, memoria y procesos, y un filtro de llamadas al sistema (seccomp) que excluye las peligrosas. Un bot hostil tiene muy poco con lo que trabajar.
- **La API no compila código de jugadores.** Sólo encola; un worker separado corre el sandbox y firma el artefacto (ed25519), que luego se verifica antes de usarlo en batalla.
- **Secretos por fichero.** Los secretos se generan aleatorios, uno por fichero con permiso de sólo lectura para el dueño, y no hay `.env`, `.pem` ni secretos en el repositorio. Las claves de emisión de streaming van selladas y ffmpeg ni siquiera conoce destino ni clave.
- **Sesiones con rotación.** Token de acceso de 15 minutos en memoria; token de refresco opaco, rotado en cada uso; si se reutiliza uno viejo se revoca toda la familia (señal de robo); tope de 30 días y sesión comprobada en base de datos.
- **Contraseñas y fuerza bruta.** Mínimo 12 caracteres, Argon2id (hash lento resistente a ataques), respuesta que no revela si el email existe, bloqueo tras 20 fallos y límites compartidos en base de datos.
- **Permisos por rol** generados desde el contrato de la API, con defensa contra el truco `__proto__`; sin sumideros de XSS (`innerHTML`, `eval`) en el código web.
- **Espectador en vivo** con ticket de un solo uso, límite de 100 clientes por batalla y datos proyectados según quién mira (no se filtra equipamiento privado).
- **CI y repositorio.** Sin `pull_request_target`, permisos de workflow de sólo lectura, rama principal protegida con administradores incluidos, y un gate de dependencias (`scan`) que falla cerrado.
- **Valores por defecto prudentes.** Ejecución real de batallas, espectador público, replays públicos y métricas vienen **apagados**.

### 9.3 Qué funciona

| Control | Estado de evidencia |
|---|---|
| Sin `docker.sock`, proxy acotado, postura del contenedor | Comprobado en código; en pruebas de CI (jobs `scan` y `container-proxy-e2e` en verde sobre 8f380eb). **No incluye la red** (ver 9.4.1) |
| Sesiones, contraseñas, fuerza bruta, RBAC | Comprobado en código; el RBAC se revisó por muestreo y la matriz de permisos **no se ejecutó** |
| Secretos por fichero | Comprobado en código; permisos reales en el servidor: no verificados |
| Gate de dependencias y escaneo de runtimes de bots | Comprobado en pruebas de CI |
| Todo en producción | Declarado por el operador; no verificado por la auditoría |

La revisión técnica retiró o matizó dos afirmaciones previas: «sandbox conforme con E2E en CI» vale para la postura del contenedor pero **no** para el aislamiento de red; y «429 con Retry-After» es latente, porque la API nunca emite esa cabecera.

### 9.4 Qué problemas existen

Veredicto de seguridad: **READY_WITH_CONDITIONS**. No se encontró ningún P0 ni un P1 con ruta de explotación concreta. Sí hay un P1 de *evidencia* (la prueba de red) y un P1 provisional (imágenes sin escanear).

#### 9.4.1 [REV-01] La prueba de aislamiento de red del sandbox no puede fallar
**Prioridad:** P1 · **Grupo de lanzamiento:** A · **Evidencia:** comprobado en código (la alcanzabilidad real de puertos: no verificable aún, FASE 2) · **Tarea:** [T-16](13-PRIORITIZED-BACKLOG.md#t-16)

**Explicación general.** El proyecto afirma que un bot no puede alcanzar los servicios internos (base de datos, workers). La CI lo «demuestra» con una prueba que siempre sale verde. Pero esa prueba crea una red de Docker nueva y **vacía**, sin DNS, y desde ella intenta conectar con nombres (`postgres`, `redis`, `arena-api`, `bot-manager`) que **no existen en esa red**. Fallar es imposible: no hay nada a lo que conectar, así que siempre sale «bloqueado». Mientras tanto, en la instalación real el bot comparte la red `arena` con el worker de torneos (que tiene credenciales de base de datos), con el worker de builds y con los demás bots.

**Por qué una prueba que no puede fallar es peor que no tener prueba.** Sin prueba, todos saben que ese punto está sin verificar y se miran con cuidado. Con una prueba que siempre pasa, el informe de calidad, el de seguridad y la CI dicen «PASS» y se deja de mirar: la confianza es falsa y además se cita como evidencia en otras decisiones (esta garantía figuraba como «PASS» en tres informes). Y el día que alguien rompa de verdad el aislamiento, la prueba seguirá en verde. Esto no invalida la prueba de postura del contenedor (esa sí es válida), sólo la de red. No se afirma que haya una fuga real: se afirma que **no hay forma de saberlo con lo que existe**.

**Solución técnica.**
- Componente: `tests/sandbox-escape/run-escape-suite.sh`, `tests/sandbox-escape/bots/05_internal_network_scan.py`, `.github/workflows/e6-security.yml`; ejecutar dentro del job `container-proxy-e2e`.
- Cambios: lanzar el escaneo desde un bot real dentro de la red `arena` del stack real, por IP de subred y puertos reales de los workers; añadir un **control positivo** (un puerto abierto a propósito que la prueba debe ver) y un mutante «añadir un servicio con puerto abierto a `arena`».
- Comportamiento esperado: la prueba sale verde sólo si no hay conexión no prevista **y** el control positivo demuestra que sabe detectarla.
- Riesgos: si el resultado real es «sí alcanza», hay que decidir ya SEC-04/REV-04 (ver 9.4.4).
- Pruebas que lo demuestran: el mutante debe poner la prueba en rojo (con la prueba actual no lo haría).
- Esfuerzo: M, incertidumbre media.

#### 9.4.2 [SEC-01] La web se sirve sin cabeceras de seguridad
**Prioridad:** P2 · **Grupo:** A · **Evidencia:** comprobado en código · **Tarea:** [T-15](13-PRIORITIZED-BACKLOG.md#t-15)

**Explicación general.** Las cabeceras de seguridad son instrucciones que el servidor envía al navegador (no permitir que otra web enmarque la nuestra, no adivinar tipos de fichero, restringir de dónde se cargan scripts). La API las envía, pero la web (SPA) y el gateway no. Consecuencia: la consola de administración y el editor se pueden enmarcar en una web ajena (clickjacking). Atenuante: no hay sumideros de XSS en el código web. Se desconoce si el proxy inverso del operador ya las añade.

**Solución técnica.**
- Componente: `infrastructure/gateway/nginx.conf` (y `nginx-behind-proxy.conf`), `infrastructure/docker/web/nginx.conf`.
- Cambios: `add_header … always` con CSP (con excepción para el visor y `/broadcast`), `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- Comportamiento esperado: todas las respuestas de la web llevan las cabeceras y el visor sigue cargando.
- Riesgos: una CSP demasiado estricta puede romper el visor Phaser.
- Pruebas: test sobre la conf real del gateway y el job `golden` en verde.
- Esfuerzo: S (M si la CSP del visor lo exige), incertidumbre media.

#### 9.4.3 [SEC-02, SEC-03, D-01] Registro abierto sin interruptor y cuentas incompletas
**Prioridad:** P2 (P1 si el lanzamiento abre registro a externos, que es el valor actual) · **Grupo:** A (interruptor, cambio de contraseña y reset asistido) / B (recuperación por email) · **Evidencia:** comprobado en código · **Tarea:** [T-12](13-PRIORITIZED-BACKLOG.md#t-12), [T-14](13-PRIORITIZED-BACKLOG.md#t-14), [T-30](13-PRIORITIZED-BACKLOG.md#t-30)

**Explicación general.** Cualquiera puede registrarse al instante como desarrollador, sin verificar el correo y sin forma de cerrar el registro; es la principal puerta abierta para un tercero. Los límites existentes (30 registros por minuto por IP, 60 versiones por hora por usuario, límites por contenedor) frenan abusos burdos, pero nada impide registrar el email de otra persona. A la vez, las cuentas están incompletas: el endpoint de recuperación crea un token y lo **descarta** (no se envía nada), no hay cambio de contraseña y no hay pantallas de 2FA ni de sesiones. Si un usuario olvida su contraseña, el operador no tiene comando para resetearla: debe escribir un hash por SQL. La decisión D-01 del arbitraje vincula la prioridad a una elección de producto: con registro abierto a externos es P1/A; con invitación o cerrado, P2/B.

**Solución técnica.**
- Componente: `apps/api/src/routes/auth.ts`, `RuntimeSettingsStore`, pantallas de `apps/web`.
- Cambios: `REGISTRATION_MODE=open|invite|closed` con valor por defecto cerrado o invitación; cuota global de builds en cola; cambio de contraseña con reautenticación (ya existe `requireStrongReauth`); reset asistido y auditado por administrador; el canal de email queda para después.
- Comportamiento esperado: una instalación nueva no admite registro anónimo sin que el operador lo decida; un usuario puede cambiar su contraseña y el operador resetearla sin SQL.
- Riesgos: cerrar el registro por defecto afecta al primer arranque (hay que ir de la mano de `create-admin`, [T-11](13-PRIORITIZED-BACKLOG.md#t-11)).
- Pruebas: test de contrato (registro anónimo rechazado con el `.env` por defecto) con mutación (batería B-22).
- Esfuerzo: M (interruptor), S-M (cambio y reset), L (email); incertidumbre baja/media.

#### 9.4.4 [SEC-04, REV-04] Red compartida entre bots y workers, y canal lateral entre bots
**Prioridad:** P2 · **Grupo:** B (REV-04; sube a A si la versión presume de competiciones públicas con premio) / C (SEC-04 aislado) · **Evidencia:** comprobado en código el diseño; explotación no verificable aún (FASE 2) · **Tarea:** [T-39](13-PRIORITIZED-BACKLOG.md#t-39), [T-67](13-PRIORITIZED-BACKLOG.md#t-67)

**Explicación general.** Es un **riesgo de diseño**, no un defecto probado. Todos los bots viven en una única red interna `arena`, la misma donde está el anfitrión de sesiones (worker de torneos) con las credenciales de la base de datos. Dos consecuencias: (1) un fallo en el servidor de protocolo de ese anfitrión daría a un bot ejecución en un proceso con acceso a datos; (2) dos bots del mismo dueño o equipo pueden hablarse por TCP, saltándose las reglas de radio y visión del motor y el anti-coaching. Existen mitigaciones reales (límite de tamaño de mensaje, validación, tokens por sesión), pero, por REV-01, ninguna tenía una prueba capaz de ponerse roja. Por eso la verificación de FASE 2 pasa a obligatoria.

**Solución técnica.**
- Componente: `infrastructure/docker-compose.yml` (red `arena`), `apps/bot-manager/src/docker-proxy.ts` (fija `NetworkMode` a `arena`).
- Cambios: red por batalla, o comunicación entre contenedores desactivada más reglas bot→puerto de sesión; a largo plazo separar el anfitrión de sesión sin credenciales.
- Comportamiento esperado: un bot sólo alcanza su puerto de sesión.
- Riesgos: el proxy exige hoy el nombre literal `arena`; un cambio de topología toca el arranque de batallas.
- Pruebas: la de REV-01, más dos bots (uno escucha, otro barre la subred).
- Esfuerzo: M (REV-04), L (SEC-04), incertidumbre media/alta.

#### 9.4.5 [TD-031 / SEC-05] Imágenes de servicio sin escanear
**Prioridad:** P1 provisional · **Grupo:** A hasta medir · **Evidencia:** comprobado en código (Dockerfile); recuento actual no verificable aún (FASE 2) · **Tarea:** [T-18](13-PRIORITIZED-BACKLOG.md#t-18), [T-37](13-PRIORITIZED-BACKLOG.md#t-37)

**Explicación general.** La CI escanea las dependencias del repositorio y los runtimes de los bots, pero **ninguna imagen de servicio construida** (las 6 imágenes Node). Además esas imágenes se construyen con la base por etiqueta (no por digest) e instalan también herramientas de desarrollo. Se midieron 74 vulnerabilidades HIGH/CRITICAL el 2026-10-16 y no se han vuelto a medir. Se mantiene P1 provisional porque la rebaja a P2 se apoyaba en «sin ruta de explotación» sin inventario. Es un riesgo, no una explotación conocida; el recuento de FASE 2 decide P1 o P2.

**Solución técnica.**
- Componente: `infrastructure/docker/node-service/Dockerfile`, `.github/workflows/ci.yml`.
- Cambios: medir con `trivy image --severity HIGH,CRITICAL`; base por digest; etapa final con `npm ci --omit=dev`; job de Trivy sobre las imágenes construidas con control negativo.
- Comportamiento esperado: la CI falla si una imagen de servicio trae un HIGH/CRITICAL corregible no exceptuado.
- Riesgos: el escaneo nuevo puede ponerse rojo de inmediato y bloquear PR hasta limpiar.
- Pruebas: el job debe fallar al introducir a propósito una imagen vulnerable.
- Esfuerzo: M, incertidumbre media.

#### 9.4.6 [REV-05 / SEC-14] `cli seed` es una trampa
**Prioridad:** P2 · **Grupo:** B · **Evidencia:** comprobado en código · **Tarea:** [T-40](13-PRIORITIZED-BACKLOG.md#t-40)

**Explicación general.** El comando `seed` crea cuentas de desarrollo (incluida `admin`) con contraseña pública, sin comprobar el entorno. Peor: si el email de una cuenta semilla ya existe, la reutiliza, le **concede el rol admin** y no toca su contraseña. Con registro abierto, quien registre antes ese email obtendría `admin` cuando alguien ejecute `seed`. No es explotable de forma remota por sí solo: requiere que el operador cometa el error que la documentación ya prohíbe, por eso no es P1.

**Solución técnica.**
- Componente: `apps/api/src/db/cli.ts`, `apps/api/src/db/seeds/dev.ts`.
- Cambios: negarse a ejecutar fuera de desarrollo explícito (flag + base local) y fallar si una cuenta semilla existe con otra contraseña; la instalación usa `bootstrap` y `create-admin`.
- Comportamiento esperado: `seed` en una instalación real falla con mensaje claro.
- Riesgos: mínimos; afecta sólo a flujos de desarrollo.
- Pruebas: test que registra el email semilla y comprueba que `seed` rechaza y nadie obtiene admin (batería B-27).
- Esfuerzo: S.

#### 9.4.7 [Vigilancia] Excepción de dependencias que caduca el 2026-12-17
**Prioridad:** P3 · **Grupo:** C · **Evidencia:** comprobado en código y pruebas de CI · **Tarea:** [T-67](13-PRIORITIZED-BACKLOG.md#t-67)

**Explicación general.** El gate de dependencias tiene una excepción datada para `picomatch` (herramientas de desarrollo, no producción) que **caduca el 2026-12-17**. Si para entonces no hay versión corregida y no se renueva con motivo, el job `scan` se pone rojo y **bloquea todos los PR**, no sólo uno. Es un recordatorio operativo con fecha, no un defecto de seguridad. 

**Solución técnica.**
- Componente: la lista de excepciones del gate de dependencias (job `scan`) y la dependencia `picomatch` de las herramientas de desarrollo.
- Cambios: antes del 2026-12-17, actualizar `picomatch` a una versión corregida o renovar la excepción con un motivo escrito y una fecha nueva; asignar un responsable.
- Comportamiento esperado: el job `scan` sigue en verde después de la fecha.
- Riesgos: renovar sin motivo oculta una vulnerabilidad real; actualizar puede cambiar el comportamiento de las herramientas de compilación.
- Pruebas: ejecutar `scan` con la fecha simulada posterior a la caducidad; debe pasar tras el cambio y habría fallado antes.
- Esfuerzo: S ([T-67](13-PRIORITIZED-BACKLOG.md#t-67)).

#### 9.4.8 Resto de hallazgos (P2-P4)

| Problema | Explicación breve | Solución | Prioridad |
|---|---|---|---|
| REV-02 · Verificar un replay sin cuota | `POST /replays/{id}/verify` re-simula la batalla entera dentro del proceso de la API; un usuario autenticado puede encadenarlas y tirar login y web. Coste real sin medir | Limitador por usuario y concurrencia 1-2, caché o mover a la cola ([T-38](13-PRIORITIZED-BACKLOG.md#t-38)). Sube a P1/A si FASE 2 mide >1 s con registro abierto | P2 · B (condicional) |
| REV-03 · Prácticas sin cuota ni autor | Un usuario nuevo puede encolar prácticas y retrasar horas un torneo; no se puede atribuir el abuso | Cuota por usuario, prioridad a batallas oficiales, `created_by` y auditoría ([T-38](13-PRIORITIZED-BACKLOG.md#t-38)) | P2 · B |
| SEC-06 · Oráculo de cuentas por email | Mensajes distintos revelan si un email existe; alta inmediata a equipos | Mensaje uniforme, invitaciones aceptadas | P3 · C |
| SEC-07 · Hardening desigual, Redis sin clave | Sólo streamer y plantilla de bot retiran capacidades; Redis sin contraseña en red interna | Homogeneizar, autenticar Redis | P3 · C |
| SEC-08 · TOTP en claro en la base de datos | Una fuga de BD o backup permitiría generar códigos 2FA (hipótesis) | Cifrar el secreto en reposo | P3 · C |
| SEC-09 · `/version` en el puerto 80 | Expone commit y fecha de build; alcance depende del firewall (hipótesis) | Restringir a red interna | P3 · C |
| SEC-10 · Sin límites en el gateway | Sin `limit_req`; detrás de proxy externo hacen falta 2 saltos de confianza o el bloqueo de login se vuelve global | `limit_req` en auth y `/ws/`, preflight del salto de proxy | P3 · C |
| SEC-11 · Acciones por tag mutable | Sin Dependabot; permisos del token ya resueltos (sólo lectura) | Fijar por SHA, añadir `dependabot.yml` | P4 · C |
| SEC-12 · JWT sin longitud mínima | Sólo exige no vacío | Mínimo 32 al arrancar y runbook de rotación | P3 · C |
| SEC-13 · Topología del operador en ficheros rastreados | Sin secretos; valores de la instalación del operador en plantillas y scripts. Plantilla errónea para terceros | Valores de ejemplo y gate de CI por parseo ([T-03](13-PRIORITIZED-BACKLOG.md#t-03)). Purga de historial descartada ([T-90](13-PRIORITIZED-BACKLOG.md#t-90)) | P3 (P2 como TD-008) · A sólo limpieza |
| REV-06 · Quedarse sin administradores | `setUserRoles` permite quitar el último admin | Guarda «último admin» | P3 · C |
| REV-07 · Errores 500 vuelcan detalle de BD al log | Puede incluir el email duplicado (hipótesis) | Registrar código y restricción, no el detalle | P3 · C |

### 9.5 Seguridad por defecto de una instalación nueva

Lo que hereda un tercero **sin decidirlo**:

| Aspecto | Por defecto | Valoración |
|---|---|---|
| Ejecución real de batallas | Apagada (la guía no explica cómo activarla: OPS-01) | Cerrado |
| Espectador público, replays públicos, métricas | Apagados | Cerrado |
| Registro de cuentas | **Abierto**, rol desarrollador | **Abierto** |
| Cabeceras de la SPA | Ausentes | **Abierto** |
| `cli seed` | Disponible, contraseñas públicas | **Trampa** |
| Redis | Sin contraseña, red interna | Abierto interno |
| Secretos | Aleatorios por fichero | Bien |
| Primer administrador | `INSERT` SQL manual | Fricción |

Lo cerrado por defecto reduce el riesgo del día 0; lo abierto (registro, cabeceras, `seed`) es lo que un tercero hereda.

### 9.6 Qué falta

- Verificaciones de FASE 2 (laboratorio y lectura de producción), todas **bloqueadas** hasta que cierre la migración de producción en curso: alcance real de bots (R1, obligatoria), `trivy image` (R4), medición de `verify` y prácticas (R2, R3), cabeceras reales en producción, firewall y permisos del servidor.
- Revisión endpoint a endpoint (sólo hubo muestreo; 14 operaciones de administración de streaming sin revisar) y ejecución de la matriz RBAC.
- Moderación de contenido público, baja de cuenta y aviso de privacidad ([T-49](13-PRIORITIZED-BACKLOG.md#t-49), [T-62](13-PRIORITIZED-BACKLOG.md#t-62)): condicionan una instancia pública con registro de terceros.
- `SECURITY.md` y canal de reporte de vulnerabilidades ([T-48](13-PRIORITIZED-BACKLOG.md#t-48)).

### 9.7 Soluciones técnicas recomendadas (orden)

1. [REV-01 / T-16](13-PRIORITIZED-BACKLOG.md#t-16): rehacer la prueba de red con control positivo; condiciona todo lo demás de red.
2. [SEC-02 / T-12](13-PRIORITIZED-BACKLOG.md#t-12) con [T-11](13-PRIORITIZED-BACKLOG.md#t-11) y [SEC-03 / T-14](13-PRIORITIZED-BACKLOG.md#t-14): registro cerrado por defecto, `create-admin`, cambio y reset de contraseña.
3. [SEC-01 / T-15](13-PRIORITIZED-BACKLOG.md#t-15): cabeceras.
4. [TD-031 / T-18](13-PRIORITIZED-BACKLOG.md#t-18): medir y después endurecer ([T-37](13-PRIORITIZED-BACKLOG.md#t-37)).
5. Grupo B: [T-38](13-PRIORITIZED-BACKLOG.md#t-38), [T-39](13-PRIORITIZED-BACKLOG.md#t-39), [T-40](13-PRIORITIZED-BACKLOG.md#t-40).
6. Grupo C: [T-67](13-PRIORITIZED-BACKLOG.md#t-67) (endurecimiento de plataforma) y renovar la excepción de `picomatch` antes del 2026-12-17.

Lo que **no** hay que tocar: proxy de Docker, postura del sandbox, sesiones, gestión de secretos y espectador funcionan bien y no necesitan rediseño.

### 9.8 Prioridad e impacto en el cierre de la versión

Condiciones de seguridad del grupo A: REV-01 (T-16), registro cerrado o por invitación (T-12) con cambio y reset de contraseña (T-14), cabeceras (T-15) y la medición de imágenes (T-18, hasta que el recuento decida entre P1 y P2). Sin ellas, una instalación nueva entrega a un tercero un registro libre, una web enmarcable y una garantía de aislamiento sin demostrar. REV-02 pasa a A si FASE 2 mide más de 1 s por verificación con registro abierto; REV-04 pasa a A si la versión anuncia competiciones públicas con premio. Todo lo demás no bloquea una versión presentable.

---

## 10. Replays, espectador y streaming

### 10.1 Qué se ha analizado

Cómo se guardan y reproducen las batallas (replays), cómo se ven en directo (espectador), cómo se pintan (renderer y colores de equipo) y cómo se emiten a una plataforma de vídeo (Streaming V1 y el diseño de V2), más las mejoras visuales previstas. Revisión estática de la rama principal (8f380eb); no se ejecutó render, ffmpeg ni pruebas de streaming, y no se miró producción. Detalle: [09-STREAMING-REVIEW.md](09-STREAMING-REVIEW.md).

**Cómo leer los niveles.** Cada elemento se clasifica en una escala de cinco peldaños: **diseñado** (hay documento), **implementado** (hay código), **integrado** (está en la rama principal), **desplegado** (corre en producción) y **funcionando** (se ha visto funcionar de verdad). Desplegado y funcionando sólo se afirman con evidencia; si no, se marcan «?». **Ningún elemento llega a desplegado/funcionando con evidencia verificada por esta auditoría**: lo que se sabe de producción es declarado por el operador.

### 10.2 Qué está bien diseñado

No necesita rediseño:

- **Frontera de secretos de emisión.** La clave de emisión va sellada (cifrado híbrido atado a plataforma e ingesta); ffmpeg recibe el vídeo por una tubería y no conoce ni destino ni clave; no aparecen en argumentos, entorno, logs ni en `/status`. Una fuga del proceso de vídeo no regala la clave.
- **El streamer valida cada orden por su cuenta** (listas cerradas, protección contra que la página de emisión apunte a otro origen).
- **Puerta de «render listo» y vigilante de pantalla en blanco**, relé RTMPS propio con TLS verificado y failover a un destino de respaldo.
- **Fallo cerrado:** con el espectador público apagado no se pueden iniciar emisiones (la API responde 409 con motivo), lo que elimina la «emisión vacía».
- **Anti-fugas del canal en directo:** cada espectador recibe sólo lo que su audiencia puede ver (proyección por audiencia), el modo `debug` exige ticket de personal firmado y los buffers del cliente están acotados.
- **Retardo anti-coaching:** el director del streaming sigue una línea temporal retrasada (30 s en torneos), de modo que la emisión no sirve de canal de información en la batalla.
- **Alertas** (`StreamerDown`, `RestartLoop`, `DroppedFramesHigh`, `NoProgress`, `RenderNotReady`) y reconciliador de sesión.
- **Replays con formato v2 único** (JSONL comprimido, keyframes, checkpoints) y verificación por re-simulación: simple y coherente con un motor determinista.

### 10.3 Qué funciona

| Elemento | Dis. | Impl. | Integ. | Desp. | Func. | Evidencia |
|---|---|---|---|---|---|---|
| Replays: formato v2 | sí | sí | sí | ? | ? | Comprobado en código |
| Replays: compatibilidad entre versiones | sí | sólo «misma versión» | sí | ? | ? | Comprobado en código (STR-03/04) |
| Replays: reproductor web | sí | sí | sí | ? | ? | Código; navegador real sólo en el golden de CI |
| Espectador en vivo (gateway WS) | sí | sí | sí | ? | ? | Comprobado en código; sin límites en el borde |
| Retardo anti-spoiler (30 s) | sí | sí | sí | ? | ? | Comprobado en código; no configurable desde la web |
| Visibilidad privada de equipos/equipamiento | sí | sí | sí | ? | ? | Código y pruebas unitarias; sin prueba de fuga E2E real |
| Renderer (Phaser, tinte de equipo) | sí | sí | sí | ? | ? | Comprobado en código; defecto de color en emisión (STR-05) |
| Streaming V1: streamer, director, admin web, claves selladas, failover | sí | sí | sí | ? | sólo documental | Código y pruebas unitarias en CI; la emisión real a una plataforma es **afirmación del operador y de documentos, no reverificada** |
| Streaming V2 / Broadcast Manager | sí | **no** | no | no | no | Sólo diseño (PR #275 borrador); no hay código |
| Mejoras visuales fase 0 | sí (PR #253 borrador) | no | no | no | no | Sólo documentos y un test de contrato |
| Mejoras visuales fase 1 | no existe | | | | | Ninguna rama ni PR |

Los fallos históricos del streaming (pantalla blanca, emisión vacía, director que cortaba antes del retardo, latidos del gateway) están **corregidos en código** en la rama principal. En una instalación nueva el streaming viene **desactivado y sin claves**.

**El streaming se recomienda presentarlo como «experimental».** Es una herramienta de operador útil (Streaming V1: READY_WITH_CONDITIONS), pero no hay evidencia de sesiones largas (máximo medido: 12 minutos), no detecta imagen congelada, el color de los bots en la emisión es un defecto declarado sin resolver, y los E2E reales no corren en la CI. La decisión del director es presentarlo como experimental y no anunciarlo como funcionalidad pública; no condiciona el lanzamiento.

### 10.4 Qué problemas existen

Ninguno de este capítulo bloquea un lanzamiento que no anuncie emisión. Para emitir de verdad hay que reintroducir claves, activar los flags y cerrar los problemas siguientes.

#### 10.4.1 [STR-01] La estabilidad en sesiones largas no está demostrada
**Prioridad:** P2 (era P1) · **Grupo:** C · **Evidencia:** sólo documentado (mediciones) + comprobado en código (ausencia de vigilancia) · **Tarea:** [T-60](13-PRIORITIZED-BACKLOG.md#t-60)

**Explicación general.** El navegador sin pantalla (Chromium) que dibuja la emisión puede ir acumulando memoria durante horas. Las únicas mediciones son de 12 minutos (memoria estable), 90 y 120 segundos (en una creció de 600 a 802 MiB); el propio documento admite que eso «no basta para descartar crecimiento». El supervisor no vigila la memoria ni el tiempo de vida de la página. Es un **riesgo por falta de evidencia**, no un fallo observado; sería P1 si el lanzamiento incluyera emisiones largas sin supervisión.

**Solución técnica.**
- Componente: `apps/streamer/src/supervisor.ts`, métricas `/metrics`.
- Cambios: prueba de resistencia de 6-8 h con batallas encadenadas, métrica de memoria de Chromium y reciclado programado entre batallas con la puerta de render existente.
- Comportamiento esperado: curva plana de memoria, FPS y descartes por hora.
- Riesgos: un reciclado mal ubicado cortaría una batalla en emisión.
- Pruebas: prueba T4 de laboratorio (≥4 vCPU); debe fallar si la memoria crece sin límite.
- Esfuerzo: M, incertidumbre media.

#### 10.4.2 [STR-02] No se detecta la imagen congelada
**Prioridad:** P2 · **Grupo:** C · **Evidencia:** hipótesis con base en el código · **Tarea:** [T-60](13-PRIORITIZED-BACKLOG.md#t-60)

**Explicación general.** El vigilante sólo sabe distinguir una pantalla blanca o uniforme. Si la página se cuelga o el flujo de datos se atasca, ffmpeg seguirá emitiendo la última imagen y la alerta `NoProgress` no salta (ffmpeg sigue avanzando). El espectador vería un vídeo congelado sin que nadie se entere. El efecto real no se ha probado.

**Solución técnica.**
- Componente: `apps/streamer/src/frame-check.ts`, `supervisor.ts`.
- Cambios: comparar fotogramas separados en el tiempo y exigir variación del HUD; alerta distinta.
- Comportamiento esperado: alerta en pocos segundos si la imagen no cambia.
- Riesgos: falsos positivos en pausas legítimas entre batallas.
- Pruebas: pausar el renderer con `SIGSTOP` (prueba T5): hoy no se detecta, tras el arreglo debe saltar.
- Esfuerzo: S-M.

#### 10.4.3 [STR-05] Los bots salen blancos o grises en la emisión
**Prioridad:** P2 · **Grupo:** C · **Evidencia:** defecto declarado en un borrador; causa hipótesis; no registrado como deuda · **Tarea:** [T-60](13-PRIORITIZED-BACKLOG.md#t-60)

**Explicación general.** Según un borrador de documentación, en la emisión los bots aparecen blancos aunque la web los colorea por equipo. En el código, cuando falta el equipo se usa un gris neutro que en vídeo puede parecer blanco. Las causas posibles (hipótesis): el equipo no llega al crear el sprite, el tinte no funciona con el render por software, o la audiencia de emisión no trae equipo. Afecta a la claridad de las partidas por equipos.

**Solución técnica.**
- Componente: `PhaserViewer.ts` (`tintForTeam`), `packages/game-rules/art-direction.ts`.
- Cambios: diagnosticar comparando fotogramas de `/broadcast` con `/viewer` del mismo estado; después corregir y registrarlo como deuda.
- Comportamiento esperado: colores de equipo distintos y no neutros en la emisión.
- Riesgos: el arreglo puede ser distinto según la causa.
- Pruebas: prueba T1 (captura de fotogramas con 4v4 bajo Xvfb) que debería fallar hoy.
- Esfuerzo: S (diagnóstico) + S/M (arreglo).

#### 10.4.4 [STR-03] Los replays anteriores al formato v2 no se pueden ver y el visor no lo explica
**Prioridad:** P2 · **Grupo:** B · **Evidencia:** comprobado en código · **Tarea:** [T-45](13-PRIORITIZED-BACKLOG.md#t-45)

**Explicación general.** El formato v2 es el único soportado, sin compatibilidad hacia atrás por decisión. Un replay antiguo aparece en las listas pero al abrirlo la API devuelve el mismo 404 que para un replay inexistente, y la web no tiene ningún mensaje que lo explique. Cuántos replays antiguos conserva producción no se sabe (depende de un reinicio competitivo pendiente), así que el alcance es desconocido; para una instalación nueva el problema no se presenta.

**Solución técnica.**
- Componente: `replay-service/src/segment.ts`, `routes/replays.ts`, `apps/web` (reproductor).
- Cambios: devolver `playable: false, reason: format_version` en el índice y mostrar un mensaje en el reproductor, o purgar con decisión explícita.
- Comportamiento esperado: el usuario ve «este replay es de una versión antigua» en lugar de un error genérico.
- Riesgos: ninguno relevante.
- Pruebas: abrir fixtures v1, v2 de 0.4.0 y de 0.5.0 (prueba T9).
- Esfuerzo: S.

#### 10.4.5 [STR-09 = QA-01] La nightly rompe los tests del streamer
**Prioridad:** P2 · **Grupo:** A · **Evidencia:** comprobado en pruebas · **Tarea:** [T-17](13-PRIORITIZED-BACKLOG.md#t-17)

**Explicación general.** Los tests del streamer con ffmpeg real pasan en la CI de cada cambio pero fallan en la ejecución nocturna porque ésta no instala ffmpeg. Es el mismo problema que se trata en el [capítulo 11](#11-pruebas-y-ci); aquí importa porque deja el streaming sin red de seguridad diaria. **Solución técnica:** copiar a la nightly los pasos que la CI ya tiene para instalar ffmpeg y activar userns; detalle completo en el [apartado 11.4.1](#11-pruebas-y-ci) y en [T-17](13-PRIORITIZED-BACKLOG.md#t-17). Esfuerzo S.

#### 10.4.6 Resto de hallazgos de este capítulo

| Problema | Explicación breve | Solución | Prioridad |
|---|---|---|---|
| STR-07 · Dependencia del flag de espectador público | `/broadcast` es anónima y exige el flag; activarlo abre la superficie WS sin límites de conexión; si se apaga en caliente no se sabe si el streamer lo reporta (no verificado) | `limit_conn/limit_req` en `/ws/`; probar apagado en caliente (T6) | P2 · C |
| STR-10 · Pruebas E2E de streaming fuera de CI | La verificación de ≥5 ticks distintos por batalla (C3b) sigue abierta; los scripts de emisión local son manuales | Ejecutar T7 en laboratorio y valorar CI | P2 · C |
| STR-17 · Claves no migradas a la instalación nueva | La clave sellada exige el mismo par de claves; si la instalación nueva generó otro hay que reintroducir credenciales por la web. Tarea operativa, no defecto del producto | Reintroducir claves; probar restauración del par | P2 · C |
| STR-04 · Política de compatibilidad «ninguna» | Cada subida de motor deja sin re-simulación a los replays anteriores | Congelar motor por temporada o declarar la política ([T-74](13-PRIORITIZED-BACKLOG.md#t-74)) | P3 · C |
| STR-06 · Retardo fijo y posible spoiler | Con estado público activado, la API puede mostrar el resultado antes del fin retrasado | Medir (T8) y ocultar resultado durante el retardo | P3 · C |
| STR-08 · Gateway en el proceso del worker | Cada snapshot se proyecta 3 veces; sin control de contrapresión; compite con el motor | Medir con 100 clientes (T10) | P3 · C |
| STR-15 · Equipos 4v4 difíciles de distinguir | Paleta de 8 tonos y gris al agotarse; sin comprobación de daltonismo | Fases visuales (sólo plan) | P3 · C |
| STR-16 · Descartes de fotogramas del 0,6-0,8 % | Medidos en laboratorio, causa sin diagnosticar | Diagnóstico T2 | P3 · C |
| STR-11 · TD-066 obsoleta | Sus tres defectos ya no existen en el código | Cerrarla y reabrir sólo «prueba E2E con plataforma real» como P4 ([T-46](13-PRIORITIZED-BACKLOG.md#t-46)) | P3 · E |
| STR-12 · Documentación de streaming desfasada | El documento de arquitectura aún marca el destino real como bloqueado | Actualizar ([T-46](13-PRIORITIZED-BACKLOG.md#t-46)) | P3 · B |
| STR-13 / STR-14 · Fuentes tipo OBS y Streaming V2 | V2 es un documento (PR #275 borrador, base desfasada), no producto | Rebasar y decidir si seguir ([T-80](13-PRIORITIZED-BACKLOG.md#t-80)); XL | P4 · D |

### 10.5 Qué falta

- Evidencia de sesión larga, congelado, flag apagado en caliente y reinicio del streamer en emisión (pruebas T1-T13 de laboratorio, con destino RTMP local y **clave ficticia**; nunca claves de producción). Bloqueadas hasta que cierre la migración de producción.
- Prueba E2E de fuga de proyección del espectador (T11).
- Emisión a una plataforma real: no se probará en esta auditoría; queda como prueba P4 documentada.
- Streaming V2 y mejoras visuales: sólo diseño; deciden el propietario y el director en el grupo D.

### 10.6 Soluciones técnicas recomendadas (orden)

1. [T-17](13-PRIORITIZED-BACKLOG.md#t-17): nightly verde (también devuelve la red de seguridad al streamer).
2. [T-45](13-PRIORITIZED-BACKLOG.md#t-45): explicar o purgar replays antiguos.
3. [T-60](13-PRIORITIZED-BACKLOG.md#t-60): streaming estable y diagnosticable (STR-01/02/05/07/10/16/17), con alcance a decidir.
4. [T-46](13-PRIORITIZED-BACKLOG.md#t-46): corregir la documentación de streaming.
5. [T-74](13-PRIORITIZED-BACKLOG.md#t-74): política de longevidad de replays, retardo y carga del espectador.
6. [T-80](13-PRIORITIZED-BACKLOG.md#t-80) y [T-81](13-PRIORITIZED-BACKLOG.md#t-81): V2 y mejoras visuales, sólo diseño.

### 10.7 Prioridad e impacto en el cierre de la versión

Nada de este capítulo bloquea una versión que no anuncie emisión. Entran en el cierre únicamente la nightly en verde (T-17, grupo A) y, como necesaria para la versión objetivo, la explicación de replays antiguos (T-45, grupo B). Presentar el streaming como **experimental** es la medida que hace honesto el lanzamiento: no se promete una función cuya sesión larga no se ha demostrado.

---

## 11. Pruebas y CI

### 11.1 Qué se ha analizado

El inventario de pruebas, la CI (siglas de integración continua: el sistema que ejecuta las pruebas automáticamente en cada cambio y decide si se puede incorporar a la rama principal), la ejecución nocturna, las pruebas que no pueden fallar y los huecos de cobertura. Revisión estática del commit 8f380eb apoyada en los resultados de runs de CI ya existentes; **la auditoría no ejecutó ninguna prueba**. Detalle: [08-TEST-QUALITY.md](08-TEST-QUALITY.md).

### 11.2 Qué está bien diseñado

No necesita rediseño:

- **Protección real de la rama principal.** Para entrar en `main` hay cuatro checks obligatorios: `semaforo` y tres `functional-e2e` (el golden con navegador, `docker-e2e` y `container-proxy-e2e`), con rama actualizada (`strict`) y **administradores incluidos**. Nadie se salta la CI, tampoco el dueño.
- **Gate que falla cerrado.** `functional-e2e` falla si una prueba se salta, si hay 0 tests o si no hubo batalla real. Evita el clásico «verde porque no corrió nada».
- **Camino feliz de punta a punta.** El golden registra un usuario, construye un bot en el sandbox Docker real, lanza una batalla y comprueba el replay.
- **Determinismo.** El motor se ejecuta 1.000 veces con la misma semilla y los resultados deben ser idénticos; es una garantía clave para replays verificables.
- **Gate de dependencias** con excepciones datadas que caducan solas.
- **Pruebas de backup con mutaciones** visibles en el log (el resultado distinto prueba que la prueba sabe fallar).
- Todos los runners son de GitHub; no hay máquinas propias que mantener.

### 11.3 Qué funciona

| Qué | Evidencia |
|---|---|
| CI de cada cambio sobre 8f380eb: 28 jobs, `ci` en verde (~25 min; el camino crítico es el golden) | Comprobado en pruebas de CI |
| Escaneo de seguridad E6 en verde | Comprobado en pruebas de CI (con la salvedad de la prueba de red, 11.4.3) |
| Ejecución programada `acceptance` en verde (1 fallo en 29) | Comprobado en pruebas de CI |
| Determinismo x1000 en verde | Comprobado en pruebas de CI |
| ≈6.900 tests en la nightly: 6.869, de los que 6.777 pasan, 86 se saltan y 6 fallan, en 485 ficheros | Comprobado en pruebas de CI (salida real de la nightly) |
| Mutantes, rendimiento del visor, pruebas visuales y emisión real | Existen como scripts; **ningún workflow los ejecuta** |
| Todo lo de producción | Declarado por el operador |

**Una CI verde no demuestra que producción funcione**, sólo que el código pasa las pruebas en un entorno de CI.

### 11.4 Qué problemas existen

Veredicto: **READY_WITH_CONDITIONS** para la CI de cada cambio; **evidencia insuficiente** para instalación, actualización, restauración, streaming real y la interfaz ante personas.

#### 11.4.1 [QA-01 / V-06] La ejecución nocturna está rota desde el 2026-08-04
**Prioridad:** P2 · **Grupo:** A · **Evidencia:** comprobado en pruebas (log del run) y en código · **Tarea:** [T-17](13-PRIORITIZED-BACKLOG.md#t-17)

**Explicación general.** La «nightly» es la ejecución que cada noche corre las pruebas lentas y de larga duración. Su último resultado en verde fue el 2026-08-04, y **111 de las últimas 129 ejecuciones fallaron**. No es mala suerte (pruebas «intermitentes»): falla siempre y por una causa de configuración. El fallo no era desconocido: estaba registrado (TD-019 y el documento de problemas conocidos). El problema es que nadie lo ha arreglado, no bloquea nada y se ha normalizado. Es grave por tres razones: no hay señal diaria de regresiones (por ejemplo, de las pruebas lentas de equilibrio y de captura de bandera); un rojo permanente enseña a ignorar el aviso, de modo que cuando falle algo real nadie lo mirará; y el streaming queda sin su red de seguridad.

**Causa.** Fallan 6 tests de 4 ficheros: uno necesita una función de aislamiento de Linux (crear un espacio de usuario sin privilegios, `unshare`) y cinco necesitan `ffmpeg` (el programa de vídeo). El workflow `nightly.yml` no tiene los pasos de preparación que `ci.yml` sí tiene. Los dos arreglos anteriores (backup) sí funcionaron, así que el problema es sólo ése.

**Solución técnica.**
- Componente: `.github/workflows/nightly.yml` (trabajo `slow-suites`).
- Cambios: copiar los pasos «userns sin privilegios» y «ffmpeg real» de `ci.yml`, o limitar el job a los ficheros de suites lentas; fijar `runs-on: ubuntu-24.04`; notificar el fallo.
- Comportamiento esperado: nightly verde.
- Riesgos: al volver a correr, pueden aparecer fallos ocultos de las suites lentas.
- Pruebas: lanzar la nightly a mano tras el cambio; **condición de cierre: 7 ejecuciones consecutivas verdes** (batería B-18).
- Esfuerzo: S, incertidumbre baja.

#### 11.4.2 [QA-04] Verdes vacíos: `deploy-staging` y `smoke-and-promote`
**Prioridad:** P3 · **Grupo:** B · **Evidencia:** comprobado en código · **Tarea:** [T-91](13-PRIORITIZED-BACKLOG.md#t-91)

**Explicación general.** Hay dos jobs que figuran «success» pero no hacen nada (salen con «omitido» porque nunca se configuró un entorno de staging). Es honesto en el sentido de que no mienten activamente, pero un «success» sin ejecutar nada se parece a un verde real: por eso el informe previo habló de «26/26 jobs en verde» cuando el run tiene 28 y dos de ellos son vacíos. Ningún despliegue pasa por una prueba de humo HTTP real.

**Solución técnica.**
- Componente: `.github/workflows/ci.yml` (líneas de staging y promoción).
- Cambios: retirar los jobs o renombrarlos, documentar que la promoción es manual y dejar de citarlos como evidencia.
- Comportamiento esperado: ningún job verde que no ejecute nada.
- Riesgos: ninguno.
- Pruebas: revisar que el recuento de jobs y de conclusiones coincide.
- Esfuerzo: S.

#### 11.4.3 [REV-01] Pruebas que no pueden fallar
**Prioridad:** P1 · **Grupo:** A · **Evidencia:** comprobado en código · **Tarea:** [T-16](13-PRIORITIZED-BACKLOG.md#t-16)

**Explicación general.** La prueba de aislamiento de red del sandbox crea una red vacía y busca nombres que no existen en ella, así que siempre sale «bloqueado». Una prueba que no puede fallar es peor que no tenerla: produce un «PASS» que otros informes citan como evidencia y apaga la atención. El caso está explicado a fondo en el [capítulo 9](#941-rev-01-la-prueba-de-aislamiento-de-red-del-sandbox-no-puede-fallar). Aquí importa el efecto en la batería: el antiguo «PASS» de B-10 se retira para la red.

Otras verificaciones que **no valen** como evidencia: `smoke.sh` (espera 200 en una ruta que el gateway responde 404, así que no puede dar verde, mientras que otra ruta cae en la web y da un verde falso), «ci 26/26», «nightly 29/29» (ventana mal acotada) y «429 con Retry-After» (la API nunca emite esa cabecera).

**Solución técnica.** Ver [9.4.1](#941-rev-01-la-prueba-de-aislamiento-de-red-del-sandbox-no-puede-fallar); además, regla general: toda prueba de seguridad lleva un **control positivo** (algo que debe detectar) y un mutante que la ponga en rojo. Esfuerzo M.

#### 11.4.4 [QA-02] Mutantes y suites de alto valor fuera de la CI
**Prioridad:** P2 · **Grupo:** C · **Evidencia:** comprobado en código · **Tarea:** [T-68](13-PRIORITIZED-BACKLOG.md#t-68)

**Explicación general.** Un mutante es un cambio deliberado que introduce un fallo en el código para comprobar que las pruebas lo detectan; si no lo detectan, las pruebas son débiles. Existen unos 20 scripts de mutantes y se usaron en las revisiones, pero ningún flujo automático los ejecuta: la afirmación «las pruebas detectan errores reales» es sólo documental, nada la reevalúa y su eficacia actual no está demostrada. Un caso concreto: el test de anclas sólo vigila 4 de las 8 familias, de modo que las otras no tienen vigilancia.

**Solución técnica.**
- Componente: `.github/workflows/nightly.yml`, `tests/mutants`, `hardening-mutant-anchors.test.ts`.
- Cambios: subconjunto de mutantes críticos (autenticación y permisos, aislamiento, torneos, backup) en la nightly; ejecutar siempre en serie sobre un árbol limpio; ampliar las anclas.
- Comportamiento esperado: un mutante no detectado pone la nightly en rojo.
- Riesgos: aumenta la duración de la nightly.
- Pruebas: introducir un mutante sabido y comprobar el rojo.
- Esfuerzo: M, incertidumbre media.

#### 11.4.5 Resto de problemas

| Problema | Explicación breve | Solución | Prioridad |
|---|---|---|---|
| QA-03 · Sin prueba de instalación limpia, actualización ni vuelta atrás | La CI levanta el stack desde cero, pero nadie ha seguido la guía literal ni probado actualizar N-1→N con datos ni deshacer. Parcialmente cubierto por una reinstalación manual del operador (evidencia de tercero) | Ensayo de instalación por una persona ajena ([T-21](13-PRIORITIZED-BACKLOG.md#t-21)) y prueba de actualización ([T-36](13-PRIORITIZED-BACKLOG.md#t-36)) | P2 · B (A basta con ensayo manual) |
| QA-05 · Aserción dependiente del tiempo | 1 fallo en 29 en acceptance (margen de 250 ms) | Relojes simulados | P3 · C |
| QA-06 · Cobertura sin umbral; 0 aprobaciones | Con CI verde un PR se incorpora sin revisión humana; el semáforo acepta amarillo | Umbral por paquete crítico y CODEOWNERS en rutas de seguridad | P3 · C |
| QA-07 · Skips por entorno | 29 `.skip` y 14 `.runIf`; 86 saltados en la nightly; algunos specs de streaming y replay pueden dar verde sin ejercerse | Revisar cuáles son críticos y extender el gate fail-closed | P3 · C |
| `ubuntu-latest` sin fijar | Deriva a una versión nueva del sistema | Fijar `ubuntu-24.04` | P3 · C |

### 11.5 Qué falta

**Huecos sin prueba automatizada de extremo a extremo:** instalación en máquina limpia con la guía, actualización con datos y vuelta atrás, restauración real de un backup, streaming a destino real, recuperación tras caída de servicios, consumo con varios torneos, interfaz real con personas (visual, accesibilidad, 60 fps), y los recorridos de visitante anónimo, instancia vacía y día 2 del administrador, que **ningún informe recorrió**.

**Batería mínima para la versión.** Resumen del estado de la batería B-01 a B-31 (detalle y procedimientos en [08-TEST-QUALITY.md](08-TEST-QUALITY.md#7-batería-mínima-de-pruebas)). En una frase: de 31 pruebas mínimas, 8 pasan en la CI, 3 fallan y 11 esperan al laboratorio (el resto pasa a medias o no se ha ejecutado). Ningún estado PASS proviene de una ejecución de esta auditoría: salen de runs de CI citados; **nada se da por PASS sin ejecución**.

| Estado | Pruebas |
|---|---|
| **PASS** (en CI) | B-02 registro y login (2FA no demostrado), B-03 primer bot y primera batalla, B-04 torneo individual, B-07 determinismo x1000, B-09 permisos (la mutación y el IDOR manual no), B-10a postura del sandbox, B-11 backup (en CI), B-17 gate de dependencias |
| **PASS parcial** | B-06 errores y cancelaciones, B-08 replays, B-16 recuperación (sólo gameday unitario) |
| **FAIL** | **B-18 nightly verde** (111/129 rojas), **B-24** `smoke.sh` (por diseño), **B-31** escaparate (29 PR «NO MERGEAR», ficheros sueltos en la raíz) |
| **BLOCKED** (FASE 2: laboratorio o lectura de producción) | B-01 instalación desde cero, B-10b aislamiento de **red**, B-12 restore real, B-13 actualización y rollback, B-15 recursos, B-25 `verify` bajo carga, B-26 cola de prácticas, B-27 `seed`, B-28 escaneo de imágenes, B-29 deriva de runtime, B-30 recorridos de usuario |
| **NOT_RUN** | B-05 torneos por equipos 4v4 (no confirmado que corra en el golden), B-19 UI responsive/visor, B-20 calibración por mutantes, B-21 cabeceras, B-22 registro cerrado, B-23 `create-admin` (el comando no existe) |
| Streaming (B-14) | Unit **PASS** en `ci` y **FAIL** en nightly; E2E de laboratorio BLOCKED |

Para cerrar la versión, el criterio de salida exige acta sobre **un único SHA**: cualquier cambio de código posterior invalida B-01, B-03 (laboratorio), B-18 y el golden de primer bot. Al comprobar la CI hay que contar las **conclusiones de todos los checks**, no la última línea de `--watch`.

### 11.6 Soluciones técnicas recomendadas (orden)

1. [T-17](13-PRIORITIZED-BACKLOG.md#t-17): nightly en verde (7 consecutivas). Barato y devuelve la señal diaria.
2. [T-16](13-PRIORITIZED-BACKLOG.md#t-16): prueba de red real con control positivo y mutante.
3. [T-21](13-PRIORITIZED-BACKLOG.md#t-21) y [T-20](13-PRIORITIZED-BACKLOG.md#t-20): ensayos de instalación limpia y restore con acta.
4. [T-91](13-PRIORITIZED-BACKLOG.md#t-91): quitar los verdes vacíos.
5. [T-36](13-PRIORITIZED-BACKLOG.md#t-36): prueba de actualización N-1→N.
6. [T-68](13-PRIORITIZED-BACKLOG.md#t-68): mutantes en nightly, umbrales y skips.

### 11.7 Prioridad e impacto en el cierre de la versión

Condiciones del grupo A: nightly verde (QA-01/T-17), prueba de red que pueda fallar (REV-01/T-16) y ensayo manual de instalación limpia (T-21). Las pruebas de laboratorio de la FASE 2 siguen **bloqueadas** hasta que cierre la migración de producción en curso. La CI de cada cambio es sólida y no necesita rediseño; lo que le falta es cubrir lo que hoy se supone (instalar, actualizar, restaurar, emitir).

---

## 12. Documentación y preparación para publicar

### 12.1 Qué se ha analizado

La calidad y exactitud de la documentación frente al código actual (main 8f380eb), su organización, las ramas y los PR de documentación, y lo que un repositorio público necesita para presentarse: licencia, versiones, ficheros de comunidad, quick start, referencia de API, capturas, idioma y «escaparate» (PR abiertos, ficheros sueltos, plantilla de configuración). Fuentes: [10](10-DOCUMENTATION-AUDIT.md), informe del agente de documentación, revisión de producto (§8 riesgos de presentación) y decisiones del director (V-01, V-02, V-04).

Los recuentos de ficheros, PR y commits se repitieron en sólo lectura el 2026-11-19. La cifra de «0 enlaces rotos de 2.311» procede de un script no conservado y es **no verificable**.

### 12.2 Qué está bien diseñado

- **Estructura de `docs/` por audiencia** (usuario, operaciones, técnica, desarrollo) con un mapa de migración (`DOC-MIGRATION-MAP.md`). Beneficio: cada lector sabe dónde mirar.
- **Histórico aislado** en `docs/history` (93 ficheros) y 18 decisiones de arquitectura (ADR) con índice. Beneficio: lo viejo se conserva sin contaminar lo vigente.
- **Guía del programador de bots amplia**: 12 páginas, ejemplos Python/JS y guía de pruebas locales.
- **Guías de contribución detalladas** (`setup`, `workflow`, `testing`, `conventions`) y `CODEOWNERS`.
- **PR bien titulados**, lo que permite generar notas de versión casi automáticamente.

**No necesita rediseño** la organización de `docs/`. Lo que falla es la vigencia del contenido y los mínimos de publicación.

### 12.3 Qué funciona

| Elemento | Estado de evidencia |
|---|---|
| 246 ficheros bajo `docs/`, bien clasificados | comprobado en código (`git ls-tree`) |
| Instalación, primer arranque, upgrades, backup, restore, proxy, firewall documentados (19 ficheros) | sólo documentado; su exactitud operativa se trata en [07](07-INSTALLATION-OPERATIONS.md) |
| OpenAPI 0.25.0 con 106 operaciones; tipos del SDK JS generados del contrato | comprobado en código |
| SDK JS y Python reales con simulador local | comprobado en código; simulador Python sin verificar |
| Ramas `docs/usuario` y `docs/integracion` ya integradas en main | comprobado en código |

Que la documentación exista no prueba que lo que dice sea cierto: ver 12.4.

### 12.4 Qué problemas existen

#### 12.4.1 [DOC-01] El README raíz y la portada de docs dicen que el producto no funciona
**Prioridad:** P1 · **Grupo de lanzamiento:** A · **Evidencia:** comprobado en código (V-02) · **Tarea:** [T-04](13-PRIORITIZED-BACKLOG.md#t-04)

**Explicación general.** Lo primero que ve un visitante del repositorio es «Estado actual (2026-10-18)… no es funcional de extremo a extremo», con una tabla de bloqueos ya resueltos, y «12 servicios» cuando hay 13 con el perfil de streaming. `docs/README.md` y todo `docs/roadmap/*` están anclados a un commit que queda 586 commits atrás (motor 0.4.0 y migraciones hasta 016; hoy motor 0.5.0, migraciones hasta 022 y OpenAPI 0.25.0). Es un defecto confirmado: la primera pantalla desmiente el producto y cualquier lector parte de cifras falsas.

**Solución técnica.**
- Componente: `README.md`, `docs/README.md`, `docs/roadmap/current-status.md`.
- Cambios: reescribir cabecera y tabla de estado con «verificado a fecha X sobre SHA Y»; añadir una sección «Limitaciones de esta versión» (idioma español, streaming experimental, registro por invitación); sustituir el SHA fijo por una comprobación en la CI que verifique que el SHA citado sea ancestro reciente de main.
- Comportamiento esperado: el README describe lo que hay y lo que no, con fecha.
- Riesgos: volver a desfasarse; por eso la comprobación automática.
- Pruebas: la comprobación de CI falla si el SHA citado es anterior al umbral fijado (habría fallado con el README actual).
- Esfuerzo: S (README) + M (roadmap), incertidumbre baja.

#### 12.4.2 [DOC-02] Repositorio público sin LICENSE
**Prioridad:** P1 · **Grupo de lanzamiento:** A · **Evidencia:** comprobado en código (sin LICENSE en el árbol; GitHub devuelve licencia nula con visibilidad pública) · **Tarea:** [T-01](13-PRIORITIZED-BACKLOG.md#t-01)

**Explicación general.** En lenguaje llano: **sin licencia, el código es visible pero no es libre**. Por defecto, la ley deja todos los derechos reservados al autor. Cualquiera puede leerlo en GitHub, pero nadie puede legalmente copiarlo, ejecutarlo en su servidor, modificarlo, publicar un SDK derivado ni contribuir con garantías, porque no tiene permiso. Para un proyecto que quiere que otros programen bots con su SDK es contradictorio: «abierto» a la vista, cerrado en derechos. Tampoco hay licencia declarada en los paquetes ni inventario de las licencias de las dependencias (motor de física, librería gráfica).

**Qué decidir (decisión del propietario antes de anunciar nada):** una licencia permisiva (MIT, o Apache-2.0, que añade una concesión de patentes) favorece la adopción; AGPL-3.0 obliga a quien ofrezca el juego como servicio a publicar sus cambios y protege el servicio alojado. Ésta es una decisión legal y de negocio; la auditoría no la toma.

**Solución técnica.**
- Componente: raíz del repo, `package.json` de cada paquete, `pyproject` de los SDK.
- Cambios: añadir `LICENSE`, campo `license` en cada paquete, un `NOTICE` o inventario de terceros, y CLA o DCO si se aceptan PR externos. Antes de licenciar, revisar el documento `.docx` y el zip de la raíz por si contienen material no propio (V-01 no halló secretos, pero no valoró la autoría).
- Comportamiento esperado: GitHub detecta la licencia y los SDK pueden consumirse legalmente.
- Riesgos: cambiar de licencia después es difícil si ya hay contribuciones externas.
- Pruebas: GitHub informa la licencia; comprobación de CI de que cada paquete declara `license`.
- Esfuerzo: S (decisión) + S, incertidumbre media (legal).

#### 12.4.3 [DOC-05 / OPS-14] Sin tags, releases ni changelog
**Prioridad:** P2 · **Grupo de lanzamiento:** A en forma mínima · **Evidencia:** comprobado en código (0 tags, 0 releases, sin CHANGELOG) · **Tarea:** [T-10](13-PRIORITIZED-BACKLOG.md#t-10)

**Explicación general.** El proyecto define que «una release es un commit de main» (ADR-017) con imágenes etiquetadas por commit. Es coherente internamente, pero un tercero no tiene una versión que instalar ni saber qué cambió. `.changeset/` existe sin usarse y el paquete raíz no declara versión.

**Solución técnica.**
- Componente: GitHub Releases, `CHANGELOG.md`, `.changeset/`.
- Cambios: crear un tag `v0.x.y` con notas generadas desde los PR, un CHANGELOG mínimo, los digests de las imágenes y el bundle del proxy como assets; retirar `.changeset` si no se usa.
- Comportamiento esperado: «instala v0.1.0» es una frase con sentido.
- Riesgos: prometer versionado semántico sin intención de mantenerlo; declarar que es 0.x.
- Pruebas: la instalación limpia (T-21) se hace desde la release, no desde main.
- Esfuerzo: S-M.

#### 12.4.4 [OPS-04 / SEC-13 / TD-008] La plantilla de configuración remite a documentación inexistente y trae topología del operador
**Prioridad:** P1 (plantilla) y P2 (topología) · **Grupo de lanzamiento:** A (sólo limpieza de ficheros; la purga del historial es E) · **Evidencia:** comprobado en código (V-04) · **Tarea:** [T-06](13-PRIORITIZED-BACKLOG.md#t-06), [T-03](13-PRIORITIZED-BACKLOG.md#t-03), [T-90](13-PRIORITIZED-BACKLOG.md#t-90)

**Explicación general.** `infrastructure/.env.example`, el fichero que un tercero copia para configurar, remite a `docs/despliegue.md` (que no existe; los documentos están en `docs/operations/`), deja las etiquetas de imagen en `latest` (no reproducible) y usa como valores por defecto datos de la instalación del propio operador, incluido su dominio. Esto no es un incidente de seguridad grave (severidad baja, sin secretos), pero un tercero que copie la plantilla apuntaría a una configuración ajena y la imagen pública es de «proyecto casero». Por privacidad no se reproducen aquí los valores.

**Solución técnica.**
- Componente: `infrastructure/.env.example` y enlaces desde el código y compose a rutas `docs/…` inexistentes.
- Cambios: valores de ejemplo neutros (dominios `example.org`), etiquetas fijadas por versión, enlaces a `docs/operations/*`; auditar con `git ls-tree` del árbol actual para no dejar rastros en otros ficheros. No purgar el historial (decisión del director).
- Comportamiento esperado: copiar la plantilla y rellenar produce una instalación propia sin sorpresas.
- Riesgos: romper el despliegue del operador si usa la plantilla como fuente; separar su configuración real.
- Pruebas: una comprobación que falle si algún fichero rastreado contiene el dominio del operador o enlaza a una ruta de `docs/` inexistente.
- Esfuerzo: S.

#### 12.4.5 [DOC-13] 51 PR abiertos, 29 con «NO MERGEAR» en el título
**Prioridad:** P3 · **Grupo de lanzamiento:** A (higiene de escaparate) · **Evidencia:** comprobado en código (recuento por `gh`, 2026-11-19; el informe original decía 35 de 52, corregido) · **Tarea:** [T-02](13-PRIORITIZED-BACKLOG.md#t-02)

**Explicación general.** Hay 51 PR (propuestas de cambio) abiertos, y 29 de ellos llevan «NO MERGEAR» en el título; los otros 22 no son todos documentales (hay PR de trabajo y de refresco). Las ramas `review/*` y `eq6*` guardan pruebas de rotura de PR ya mergeados. Dan ruido, riesgo de un merge accidental y tapan los PR vivos; la pestaña de PR parece de un proyecto caótico. **Hipótesis no verificada:** que todos los tests de rotura hayan entrado ya en main.

**Solución técnica.**
- Componente: GitHub (acción del operador), un script de comprobación.
- Cambios: (1) script que verifique, por PR, que cada test añadido existe en main; (2) un PR único «tests de rotura» con los que falten; (3) cerrar el resto con «integrado en #NNN»; (4) opcional, conservar las ramas como `archive/review-…`.
- Comportamiento esperado: la búsqueda `NO MERGEAR in:title` de PR abiertos queda vacía.
- Riesgos: cerrar un PR con un test que no esté en main.
- Pruebas: la propia búsqueda de PR; diff de nombres de tests por PR.
- Esfuerzo: S, incertidumbre baja.

#### 12.4.6 [DOC-07 / ARQ-08] Ficheros sueltos en la raíz
**Prioridad:** P3 · **Grupo de lanzamiento:** A · **Evidencia:** comprobado en código (V-01) · **Tarea:** [T-03](13-PRIORITIZED-BACKLOG.md#t-03)

**Explicación general.** La raíz contiene un zip del prototipo v1, un dosier de diseño en `.docx`, un compose de demo v1 que el propio README dice «retirado y no debe usarse», un `.env.example` del prototipo v1, `pnpm-workspace.yaml` (el proyecto usa npm) y `.changeset/` vacío. La verificación del director **descarta riesgo de seguridad** (sin credenciales): es sólo desorden. El dosier se cita en el código sin enlace.

| Fichero | Acción |
|---|---|
| zip del prototipo v1 | Eliminar de la raíz (queda en el historial) |
| dosier `.docx` | Pasar a Markdown o a `docs/history/` con nota; revisar autoría antes de licenciar |
| compose de demo v1 y `.env.example` raíz | Eliminar o mover a `docs/history/`; dejar un puntero a `infrastructure/.env.example` |
| `pnpm-workspace.yaml`, `.changeset/` | Eliminar si no se usan |

No purgar el historial (grupo E).

**Solución técnica.**
- Componente: raíz del repositorio (zip del prototipo, dosier `.docx`, compose y `.env.example` del prototipo v1, `pnpm-workspace.yaml`, `.changeset/`), `docs/history/` y `README.md`.
- Cambios: (1) eliminar de la raíz el zip, el compose de demo v1 y el `.env.example` del prototipo, y `pnpm-workspace.yaml` y `.changeset/` si nada los usa (se comprueba antes con una búsqueda de referencias); (2) convertir el dosier a Markdown o moverlo a `docs/history/` con una nota de contexto, y arreglar el enlace del código que lo cita; (3) dejar en el README un puntero a `infrastructure/.env.example`; (4) no tocar el historial de git.
- Comportamiento esperado: la raíz sólo contiene lo que usa el producto; ningún documento ni script apunta a un fichero retirado.
- Riesgos: borrar algo que un script o la CI referencia sin que se vea; perder el dosier si se elimina en vez de archivarlo; autoría del dosier sin revisar antes de licenciar (relacionado con T-01).
- Pruebas que lo demuestran: `git ls-tree` de la raíz sin esos ficheros; una búsqueda de sus nombres en todo el repo sin resultados; la CI completa en verde (habría fallado antes sólo si algo dependía de ellos); el enlace del dosier en el código resuelve.
- Esfuerzo: S, incertidumbre baja ([T-03](13-PRIORITIZED-BACKLOG.md#t-03)).

#### 12.4.7 [DOC-10] Sin capturas ni demo
**Prioridad:** P3 · **Grupo de lanzamiento:** A («presentar») · **Evidencia:** comprobado en código (ninguna imagen ni vídeo en el árbol) · **Tarea:** [T-05](13-PRIORITIZED-BACKLOG.md#t-05)

**Explicación general.** Es un juego visual y toda la documentación es texto. Un visitante no ve un combate ni la interfaz sin instalar. Si no se expone una instancia pública, esto es lo único que verá el visitante. Ver capítulo 7, UX-12.

**Solución técnica.**
- Componente: `README.md`, una carpeta de imágenes bajo `docs/` y el recorrido de navegador existente (el que usa la CI para probar el primer bot), que puede generar las capturas.
- Cambios: generar 2-4 capturas (portada, editor de bot, visor de una batalla, clasificación) o un GIF corto con ese recorrido sobre una instalación con contenido de ejemplo; insertarlas en el README con texto alternativo; opcionalmente enlazar un vídeo corto de una batalla. Las capturas no deben mostrar direcciones internas ni cuentas reales.
- Comportamiento esperado: quien abre el README ve el producto en funcionamiento sin instalar nada.
- Riesgos: capturas que se quedan viejas tras cambios de interfaz (se regeneran con el mismo recorrido); una instancia vacía da capturas pobres (conviene tener antes el bot de la casa, UX-01); filtrar datos privados en la imagen.
- Pruebas que lo demuestran: `git ls-tree` muestra las imágenes en el repositorio; el README las referencia con rutas que existen (comprobación de enlaces); revisión visual de que no hay datos privados.
- Esfuerzo: S, incertidumbre baja ([T-05](13-PRIORITIZED-BACKLOG.md#t-05)).

#### 12.4.8 Hallazgos menores y de planificación

| Problema | Explicación breve | Solución | Prioridad |
|---|---|---|---|
| **DOC-03** Roadmap obsoleto | `known-issues` da por abierto el torneo que no termina con una batalla fallida (ya resuelto), TD-066 (clave en argv de FFmpeg, ya refutada por el código), y no recoge inscripción de equipos ni cancelación de torneos (mergeadas). 71 deudas en 1.444 líneas | En A sólo `current-status` y `known-issues`; el resto, re-auditoría (T-46, esfuerzo L) | P2 · B |
| **DOC-08** PR de documentación | #277 no se puede mergear como conjunto (384 commits por detrás); rescatar por cherry-pick `streaming.md`, `administration.md`, `equipment.md`, `visibility.md`; #286 mergeable tras revisar fechas; #266 reconciliar; #258 cerrar; #253 decisión de producto; #173, #168 y #174 cerrar tras rescatar; #136 y los borradores históricos R11-R17 cerrar · [T-47](13-PRIORITIZED-BACKLOG.md#t-47) | Rescatar y cerrar | P3 · B |
| **DOC-06** Sin SECURITY.md, plantillas ni CONTRIBUTING en la raíz | `.github/` sólo tiene CODEOWNERS y workflows; el procedimiento de seguridad existe pero GitHub no lo detecta; el contributing exige «mutantes y controles negativos» en cada PR, barrera alta para externos · [T-48](13-PRIORITIZED-BACKLOG.md#t-48) | Ficheros de una pantalla que enlacen a los docs; versión «ligera» de contribución | P2 · B (adelantable a A+, es barato) |
| **DOC-11** Sin quick start de 5 minutos | Hay `getting-started` (web) y `probar.md` (simulador) pero ninguna guía «ejecuta un bot sin cuenta» enlazada desde el README · [T-51](13-PRIORITIZED-BACKLOG.md#t-51) | `docs/user/bots/quickstart.md` y enlace en el README | P2 · B (A mínimo) |
| **DOC-12** Referencia de API sólo a mano | `docs/technical/api.md` (279 líneas) y OpenAPI sin versión renderizada · [T-73](13-PRIORITIZED-BACKLOG.md#t-73) | Publicar referencia estática desde CI | P3 · C |
| **DOC-09** Idioma | Todo en español, incluidos OpenAPI y README de SDK; no bloquea para comunidad hispanohablante · [T-83](13-PRIORITIZED-BACKLOG.md#t-83) | Declararlo en «Limitaciones»; luego README y quick start en inglés | P3 · C |
| **DOC-04** TD-064 no registrada | El PR #169 corrige `init-secrets.sh` y su registro se perdió · [T-75](13-PRIORITIZED-BACKLOG.md#t-75) | Rescatar o registrar la deuda y cerrar | P3 · C |
| Duplicados y rutas fantasma | `ESTADO_ACTUAL` frente a `current-status`; `docs/README.md` reconoce rutas `docs/…` inexistentes citadas en comentarios | Consolidar y comprobar enlaces en CI (sustituye al script no conservado) | P3 |

### 12.5 Qué falta

LICENSE; SECURITY.md, plantillas de issue y PR y CONTRIBUTING en la raíz; CHANGELOG, tag y release; capturas o GIF; quick start enlazado; referencia de API navegable; sección «Limitaciones de esta versión»; un comprobador de enlaces en CI; un README que sirva de portada (qué es, para quién, cómo probarlo, estado, licencia).

**Qué necesita una presentación pública:** (1) licencia decidida, (2) README veraz con capturas, (3) una release instalable con notas, (4) plantilla de configuración neutra, (5) escaparate limpio (PR «NO MERGEAR» cerrados, ficheros sueltos fuera), (6) SECURITY.md, (7) quick start de bots, (8) dejar claro el idioma y que streaming es experimental, y (9) si se aloja una instancia con registro de terceros, privacidad y términos (capítulo 7, UX-14).

### 12.6 Soluciones técnicas recomendadas

1. Decisión de licencia y `LICENSE` (DOC-02; T-01).
2. README, `current-status`, `known-issues` y «Limitaciones» (DOC-01, DOC-03 parcial; T-04).
3. Plantilla `.env.example` y limpieza de ficheros rastreados (OPS-04, SEC-13; T-06, T-03).
4. Cierre de PR «NO MERGEAR» y limpieza de la raíz (DOC-13, DOC-07; T-02, T-03).
5. Capturas o GIF (DOC-10; T-05) y release con CHANGELOG (DOC-05; T-10).
6. SECURITY.md, plantillas y quick start (DOC-06, DOC-11; T-48, T-51), re-auditoría del roadmap y de los PR de documentación (T-46, T-47).
7. Referencia de API, TD-064 e inglés (T-73, T-75, T-83).

### 12.7 Prioridad e impacto en el cierre de la versión

DOC-01 y DOC-02 son **P1 grupo A y bloquean presentar el proyecto hoy**; también la plantilla `.env.example` y la release mínima. La limpieza del escaparate (DOC-13, DOC-07, DOC-10) es barata (S) y condiciona la primera impresión, aunque sea P3. El resto de documentación (DOC-03, 06, 08, 11) puede esperar al grupo B, con SECURITY.md y el quick start como candidatos baratos a adelantar. Veredicto de la dimensión: **NOT_READY para publicar, READY_WITH_CONDITIONS en estructura**; el camino es corto en esfuerzo y no requiere reescribir la documentación, sólo ponerla al día y añadir los mínimos de publicación.

---

## 13. Deuda técnica

### 13.1 Qué se ha analizado

**Deuda técnica**, en una frase: son los atajos, carencias o apaños que el proyecto arrastra y que hoy no impiden funcionar, pero cuestan más cuanto más se tarda en corregirlos. Se revisó el registro histórico del proyecto (`docs/roadmap/technical-debt.md`) contra el código real (8f380eb) y se añadió la deuda que nadie había registrado. El resultado es un único registro deduplicado en [04-TECHNICAL-DEBT.md](04-TECHNICAL-DEBT.md); aquí se resume lo que importa.

**Cifras del registro.** El índice histórico tiene **71 entradas** (TD-001 a TD-073; faltan TD-050 y TD-064). **25 constan como cerradas y 46 como abiertas, parciales o mejoradas** (recuento del índice). Los agentes de la auditoría revalidaron unas cuarenta (las listadas en el anexo); 14 no se revalidaron y se conservan con su prioridad registrada, marcadas «sin revalidar». De las 25 cerradas, 10 se confirmaron en código (TD-004, 009, 028 con condición, 045, 047, 051, 052, 053, 061 y 062) y 15 no se revalidaron.

El propio registro está desfasado: su cabecera ancla en un commit 586 commits atrás y algunas entradas afirman cosas ya falsas (ver 13.4).

### 13.2 Qué está bien diseñado

Tener un registro de deuda numerado, con prioridad y enlace a la causa, ya es una buena práctica poco común: permite distinguir lo conocido de lo descubierto. Funciona bien que las cerradas importantes (proxy de Docker, firewall como código, `functional-e2e` obligatorio, replays ocultos a anónimos) estén **realmente cerradas en el código**. No necesita rediseño el mecanismo; sólo actualizarlo y reescribir las entradas obsoletas.

### 13.3 Qué funciona

- Las cerradas confirmadas en código siguen cerradas (comprobado en código; las pruebas en CI del run de 8f380eb las respaldan donde se cita).
- El gate de dependencias con excepciones datadas es un mecanismo sano de deuda aceptada **con caducidad**.
- Lo que el operador dice sobre producción (p. ej. contenedores en la versión declarada) es **declarado por el operador, no verificado**; por eso TD-006 sigue sin cerrarse formalmente.

### 13.4 Qué problemas existen

#### 13.4.1 Deuda que de verdad afecta al cierre de la versión
**Prioridad:** P1-P2 · **Grupo de lanzamiento:** A · **Evidencia:** comprobado en código, salvo lo marcado · **Tarea:** ver la tabla de 13.4.5

**Explicación general.** El registro de deuda técnica (los atajos y carencias anotados a lo largo del proyecto) tiene unas 70 entradas. Sólo un puñado impide presentar una versión: las que exige el criterio de salida D1-D21 o las que condiciona una «puerta» de calidad. Son estas: la seguridad de las cuentas y del registro (TD-012); las imágenes de los servicios, que no se han escaneado en busca de vulnerabilidades (TD-031); la instalación y la prueba rápida de que todo funciona (TD-024, TD-020); el primer administrador, que hoy se crea a mano (TD-023); la nightly, que lleva meses fallando (TD-019); la prueba de aislamiento de red de los bots, que no puede fallar (TD-018, REV-01); y los datos internos del operador en ficheros del repositorio (TD-008, sólo la limpieza). El resto, aunque sea real, puede esperar. El fallo de la nightly ya estaba registrado; lo que falta es arreglarlo.

**Solución técnica.** Cerrar el grupo A del backlog en el orden de la tabla 13.4.5. Esfuerzo: la suma de estimaciones S-M por entrada, no una medición; no se da plazo total.

#### 13.4.2 Reclasificaciones relevantes
**Prioridad:** — · **Grupo:** — · **Evidencia:** comprobado en código y revisión técnica

**Explicación general.** Varias entradas históricas tenían una prioridad que ya no corresponde. La regla de consolidación es que manda la revisión técnica cuando ajusta la severidad.

| TD | Antes → ahora | Motivo |
|---|---|---|
| TD-006 (deriva de runtime en producción) | P0 → P3 | Es el estado de una instalación, no del producto; evidencia de tercero (13/13 contenedores en la versión declarada); sólo se cierra con una lectura en FASE 2 |
| TD-007 (backup/alertas/poda) | P0 → P1 | Backup funciona según evidencia de tercero; faltan aviso de «backup no configurado», alertas probadas y apagado limpio de la base de datos |
| TD-008 (topología del operador en ficheros rastreados) | P0 → P2 | Sin secretos ni credenciales; valores de la instalación del operador (dominio ya público, direccionamiento privado). Sólo la limpieza es grupo A; **la purga del historial se descarta** |
| TD-012 (registro abierto y cuentas) | P1 → P2, o P1 si se abre a externos | Depende de la decisión de producto: abierto a externos = P1/A; invitación o cerrado = P2/B |
| TD-019 (nightly y staging) | P3 → P2 | Rota desde 2026-08-04, 111 fallos en las últimas 129 ejecuciones |
| TD-023 (primer administrador por SQL) | P2 (la subida a P1 se rechazó) | La revisión técnica consideró injustificada la subida; basta `create-admin` |
| TD-031 (imágenes sin escanear) | P1 → **P1 provisional** | La rebaja a P2 no se justificaba sin inventario; el recuento de FASE 2 decide |
| TD-033 (anfitrión de sesiones en la red de los bots) | P1 → P2 | Justificada con condición: la mitigación no tenía prueba capaz de fallar (REV-01) |
| TD-018 (pruebas fuera de CI) | P3 → P1 para REV-01 | La prueba de red no puede fallar |
| TD-024 (instalación) | P2 → P1 | Paraguas de que la guía no llega a ejecutar batallas |
| TD-015 (torneo con batalla fallida) | P1 parcial → **cerrar y sustituir** | La mitad registrada es obsoleta; queda BE-01 (torneo `closed` atascado) |
| TD-066 (streaming) | P3 → **obsoleta** | Sus tres defectos ya no existen en el código; reescribir como P4 «prueba E2E con plataforma real» |

#### 13.4.3 Deuda obsoleta que hay que cerrar o reescribir
**Prioridad:** P3 · **Grupo:** E · **Evidencia:** comprobado en código · **Tarea:** [T-46](13-PRIORITIZED-BACKLOG.md#t-46), [T-04](13-PRIORITIZED-BACKLOG.md#t-04)

**Explicación general.** Parte del registro de deuda cuenta cosas que ya no son ciertas. **TD-066** decía que la clave de emisión viajaba a la vista en la línea de órdenes, que no se borraban las grabaciones y que faltaban alertas; los tres puntos están ya resueltos. **TD-015** decía que un torneo con una batalla fallida no terminaba; también se resolvió. Hay además filas del documento de problemas conocidos (`known-issues.md`) desfasadas (la causa del fallo de la nightly, «40/40»), cinco incidencias (issues) que pueden cerrarse o redefinirse, y 51 PR abiertos, 29 de ellos con «NO MERGEAR». Un registro que dice falsedades confunde a quien lo lee y es lo primero que ve un tercero.

**Solución técnica.**
- Componente: `docs/roadmap/technical-debt.md`, `known-issues.md`.
- Cambios: cerrar TD-066 y TD-015 con su referencia, abrir BE-01/BE-08, reanclar la cabecera al commit actual, cerrar o rescatar los PR abiertos (51, de ellos 29 «NO MERGEAR»).
- Comportamiento esperado: el registro coincide con el código.
- Riesgos: ninguno técnico; es una acción del propietario sobre issues y PR.
- Pruebas: revisión cruzada de cada entrada cerrada contra el fichero citado.
- Esfuerzo: S-L según el volumen de documentación (DOC-03 es L).

#### 13.4.4 Deuda nueva no registrada
**Prioridad:** P1-P4 · **Grupo:** A-D · **Evidencia:** comprobado en código salvo hipótesis marcadas

**Explicación general.** La auditoría encontró deuda nueva con IDs de área (ARQ, BE, UX, OPS, SEC, STR, DOC, QA, REV) que **no existen como TD**; se propone registrarlas con ID nuevo al incorporarlas (la auditoría no asigna números). Las más relevantes:

| Entrada | Qué es | Prioridad · Grupo |
|---|---|---|
| REV-01 | Prueba de aislamiento de red vacía | P1 · A |
| DOC-01 / OPS-11 | README y portada de docs declaran estado falso | P1 · A |
| DOC-02 | Repositorio público sin licencia | P1 · A |
| OPS-01 / OPS-04 | La instalación no llega a ejecutar batallas; plantilla `.env.example` y humo erróneos | P1 · A |
| SEC-01, SEC-02, SEC-03 | Cabeceras, registro abierto, cuentas | P2 · A |
| QA-01 | Nightly rota | P2 · A |
| OPS-06 / OPS-07 | Backup sin guía de servidor y restore sin ensayo | P1 · B (+ aviso en A) |
| REV-02/03/04/05 | Verificación sin cuota, prácticas sin cuota, canal entre bots, `seed` | P2 · B |
| BE-01 | Torneo `closed` atascado | P2 · B |
| STR-05 | Color de bots blanco en la emisión | P2 · C |
| BE-02…BE-15, UX-xx, ARQ-xx | Validación, métricas, paginación, a11y, código muerto… | P2-P4 · C/D |

Hay hipótesis entre ellas (p. ej. BE-13, ARQ-11, SEC-08, UX-10): no son defectos confirmados.

**Solución técnica.** Registrarlas en `docs/roadmap/technical-debt.md` con ID TD nuevo y enlace al hallazgo; un único ID por problema (STR-09 = QA-01 = TD-019; UX-02 = SEC-03 = TD-012; SEC-13 = TD-008; STR-11 = TD-066). Esfuerzo S.

#### 13.4.5 Tabla priorizada (P0-P4 con grupo)

No hay ningún **P0** abierto: el único P0 histórico con riesgo real (TD-008) se redujo a P2 sin secretos expuestos.

| Prio | Grupo | Deuda | Tarea |
|---|---|---|---|
| P1 | A | REV-01 / TD-018: prueba de red que no puede fallar | [T-16](13-PRIORITIZED-BACKLOG.md#t-16) |
| P1 prov. | A hasta medir | TD-031 / SEC-05: imágenes sin escanear | [T-18](13-PRIORITIZED-BACKLOG.md#t-18) |
| P1 | A | TD-024: instalación que no ejecuta batallas (OPS-01, 03, 05, 13) | [T-08](13-PRIORITIZED-BACKLOG.md#t-08), [T-09](13-PRIORITIZED-BACKLOG.md#t-09), [T-10](13-PRIORITIZED-BACKLOG.md#t-10) |
| P1 | A | DOC-01, DOC-02: README falso y sin licencia | [T-04](13-PRIORITIZED-BACKLOG.md#t-04), [T-01](13-PRIORITIZED-BACKLOG.md#t-01) |
| P1 | B (+ aviso en A) | TD-007 y TD-025: backup y restore | [T-07](13-PRIORITIZED-BACKLOG.md#t-07), [T-20](13-PRIORITIZED-BACKLOG.md#t-20), [T-34](13-PRIORITIZED-BACKLOG.md#t-34) |
| P2 (P1 si externos) | A | TD-012: registro, cambio de contraseña, reset | [T-12](13-PRIORITIZED-BACKLOG.md#t-12), [T-14](13-PRIORITIZED-BACKLOG.md#t-14) |
| P2 | A | TD-019 / QA-01: nightly | [T-17](13-PRIORITIZED-BACKLOG.md#t-17) |
| P2 | A | SEC-01: cabeceras | [T-15](13-PRIORITIZED-BACKLOG.md#t-15) |
| P2 | A | TD-023: `create-admin` | [T-11](13-PRIORITIZED-BACKLOG.md#t-11) |
| P2 | A (limpieza) / E (purga) | TD-008: topología en ficheros | [T-03](13-PRIORITIZED-BACKLOG.md#t-03), [T-90](13-PRIORITIZED-BACKLOG.md#t-90) |
| P2 | A | TD-020: humo que no puede dar verde | [T-07](13-PRIORITIZED-BACKLOG.md#t-07) |
| P2 | B | BE-01 / TD-015: torneo `closed` atascado | [T-31](13-PRIORITIZED-BACKLOG.md#t-31) |
| P2 | B | REV-02/03 (cuotas), REV-04 (red entre bots), REV-05 (`seed`) | [T-38](13-PRIORITIZED-BACKLOG.md#t-38), [T-39](13-PRIORITIZED-BACKLOG.md#t-39), [T-40](13-PRIORITIZED-BACKLOG.md#t-40) |
| P2 | B | TD-013 / BE-11: registro no atómico; TD-022: ruleset libre | [T-63](13-PRIORITIZED-BACKLOG.md#t-63), [T-42](13-PRIORITIZED-BACKLOG.md#t-42) |
| P2 | C | TD-033 / SEC-04 aislado, QA-02, STR-01/02/05 | [T-67](13-PRIORITIZED-BACKLOG.md#t-67), [T-68](13-PRIORITIZED-BACKLOG.md#t-68), [T-60](13-PRIORITIZED-BACKLOG.md#t-60) |
| P3 | C | TD-006, TD-041, TD-043, TD-048, TD-060, TD-063 y SEC-06…SEC-12 | [T-67](13-PRIORITIZED-BACKLOG.md#t-67) |
| P3-P4 | C/D | Código muerto (TD-021/039), checkpoints (TD-038), TD-016, TD-017, TD-026, TD-067…073 | [T-69](13-PRIORITIZED-BACKLOG.md#t-69), [T-82](13-PRIORITIZED-BACKLOG.md#t-82) |
| P3 | E | TD-066 obsoleta (cerrar) | [T-46](13-PRIORITIZED-BACKLOG.md#t-46) |

### 13.5 Qué falta

- **Deuda aceptada** (se conserva abierta sin plan en esta versión): TD-026 (canal Redis sin productor; el worker degrada a polling sin pérdida), TD-043 (secreto raíz en el worker, aporta poco aislado), TD-038/ARQ-10 (reanudación de batallas, sólo promesa de diseño), TD-067…073 y TD-027/035/036/037/042/046/049 (sin revalidar), ARQ-04/07/12, QA-05/06/07, SEC-07/08/09/12, BE-04/05/09/10/12-15, UX-04/06/10, DOC-09/12 (ninguno bloquea una versión presentable), ARQ-06/11, STR-13/14 y las mejoras visuales (futuro), SEC-11 (P4), y la **purga del historial git** (descartada: coste mayor que el beneficio). Aceptar no es ignorar: se revisitan tras el lanzamiento.
- **Excepción con fecha:** la de `picomatch` caduca el **2026-12-17**; si no se renueva o actualiza, `scan` bloquea todos los PR.
- Revalidar las 15 cerradas y las 14 abiertas «sin revalidar», y medir en FASE 2 lo que depende de producción o del laboratorio (TD-006, TD-031, TD-060, TD-063), **bloqueado** hasta que cierre la migración de producción en curso.
- Tres discrepancias de consolidación sin arbitrar: ficheros sueltos en la raíz (limpieza C según el director, A según producto), bundle del proxy y release mínima (B según técnica, A según producto) y gestión de usuarios en la web (B o C).

### 13.6 Soluciones técnicas recomendadas (orden)

1. Actualizar el registro ([T-04](13-PRIORITIZED-BACKLOG.md#t-04), [T-46](13-PRIORITIZED-BACKLOG.md#t-46)): cerrar TD-066 y TD-015, reanclar al commit actual, registrar la deuda nueva con ID.
2. Cerrar el grupo A en el orden de la tabla 13.4.5 (primero la prueba de red y la medición de imágenes, porque cambian prioridades de otras).
3. Grupo B tras la primera versión presentable.
4. Grupo C como cartera de mejora continua.
5. Poner fecha de revisión a cada deuda aceptada.

### 13.7 Prioridad e impacto en el cierre de la versión

La deuda **no es el obstáculo principal**: no hay P0 abierto, y el núcleo (motor, API, sandbox, CI de cambios) está sano. Lo que condiciona el cierre es un conjunto acotado del grupo A (seguridad de registro y cuentas, medición de imágenes, instalación y primera ejecución, nightly, prueba de red, escaparate) más el trabajo de **dejar el registro de deuda honesto**. Todo lo demás se acepta con revisión posterior o se pospone por grupo.

---

## 14. Plan para cerrar una versión presentable

> Capítulo de planificación: no repite la plantilla de análisis de los capítulos 2 a 13. Los problemas y sus soluciones técnicas están allí; aquí se ordenan en tareas, fases y criterios de cierre.

### 14.1 Qué se ha analizado

Las tres posibles ambiciones de la próxima versión, el trabajo pendiente convertido en tareas y el orden en que conviene hacerlas. El detalle completo está en cuatro anexos: [análisis de brecha](11-RELEASE-GAP-ANALYSIS.md), [Definition of Done](12-RELEASE-DEFINITION-OF-DONE.md), [backlog priorizado](13-PRIORITIZED-BACKLOG.md) y [plan de entrega](14-RELEASE-DELIVERY-PLAN.md). Este capítulo los resume para quien tiene que decidir.

### 14.2 Las opciones de lanzamiento

**Explicación general.** No hace falta terminarlo todo para enseñar S9 AI Arena. Hay que elegir *qué se promete* y comprobar que lo prometido es verdad. Cuanto más se promete, más trabajo hay y más tarda. Las cifras de esfuerzo son **sumas de las estimaciones** de los especialistas, en días de trabajo de una persona. **No son mediciones** y no incluyen esperas: decisiones pendientes, pruebas nocturnas consecutivas o el arreglo de lo que aparezca en la fase 2.

| Opción | Qué promete | Esfuerzo estimado (días-persona) | Principal riesgo |
|---|---|---|---|
| **A estricta** — mínima | Instalar, crear bots, combatir, torneos y resultados | 10 – 23 | Saldría con una prueba de seguridad que no prueba nada (REV-01), imágenes sin revisar (TD-031), registro abierto a cualquiera y la señal nocturna en rojo. Presentaría como ciertas cosas que no lo son. |
| **A+ — mínima presentable (RECOMENDADA)** | A, más lo barato que la hace presentable sin riesgos ocultos | **23 – 62** | Lo que descubra la fase 2 (aislamiento de red, imágenes, coste de verificación) puede ampliar el trabajo. |
| **B — pública completa** | Instalación muy sencilla, buena experiencia, correo, moderación y documentación sólida | 66,5 – 206,5 | Correo, actualizaciones automáticas y moderación son trabajo grande. |
| **C — ampliada** | B más Streaming V2 y la nueva experiencia visual | ≥ 89, sin techo | Streaming V2 sólo existe como diseño; su coste no se puede acotar hoy. |

**Recomendación: A+.** Es la versión más pequeña que **no presenta como probado nada que no lo esté** y que protege por defecto a quien la instale. Se presentaría como *software autoalojable v0.x, en español, para un solo servidor Debian 12*, con registro por invitación y el streaming marcado como *experimental*. B es el paso siguiente natural. Streaming V2 y las mejoras visuales no deben retrasar el lanzamiento. Detalle en [11 §5](11-RELEASE-GAP-ANALYSIS.md#5-recomendación).

### 14.3 Qué hay que hacer para A+ (grupo A del backlog)

El backlog convierte los hallazgos en 26 tareas del grupo A (T-01…T-26). Agrupadas por objetivo:

| Objetivo | Tareas principales | Por qué |
|---|---|---|
| **Poder publicarlo legalmente y con buena primera impresión** | Licencia ([T-01](13-PRIORITIZED-BACKLOG.md#t-01)), cerrar los 29 PR «NO MERGEAR» (T-02), limpiar la raíz y la plantilla `.env.example` (T-03), README veraz con capturas (T-04, T-05) | Hoy, sin licencia, nadie puede usar el código legalmente, y el README dice que el producto «no funciona». |
| **Que se instale y funcione a la primera** | Plantilla `.env` correcta, guía con el proxy y el firewall como pasos obligatorios, instalador del servidor, release con el componente del proxy publicado, requisitos de hardware, `create-admin`, comprobador «doctor» que juega una batalla de prueba (T-06…T-11, T-19) | Hoy, siguiendo la guía, el sistema parece sano pero **no juega batallas** (OPS-01). |
| **Proteger a quien lo instale** | Registro por invitación o cerrado por defecto, cabeceras de seguridad de la web, reset de contraseña asistido por admin y cambio de contraseña (T-12, T-14, T-15) | Hoy cualquiera puede registrarse y nadie puede recuperar su cuenta sin tocar la base de datos. |
| **Que un recién llegado juegue enseguida** | Bots de práctica publicados en cada instalación nueva (T-13) | Hoy hacen falta dos bots propios para la primera batalla, y una instalación nueva está vacía. |
| **Que la evidencia sea fiable** | Arreglar la CI nocturna (T-17), rehacer la prueba de aislamiento de red (T-16), escanear las imágenes de servicio (T-18) | Hoy la señal nocturna lleva rota desde agosto y la prueba de aislamiento de red no puede fallar. |
| **Demostrarlo en un laboratorio** | Ensayo de restore, ensayo de instalación por una persona ajena, medición de recursos, fase 2 de la auditoría (T-20…T-26) | Nada de esto se ha podido ejecutar todavía (ver [15.3](#153-limitaciones)). |

### 14.4 Orden y camino crítico

**Explicación general.** Casi todo se puede hacer en paralelo por equipos que no toquen los mismos ficheros. Hay una cadena que no se puede acelerar: primero publicar una *release* (una versión empaquetada y numerada); después el instalador que la usa; después los bots de práctica, las capturas y el README final. Solo entonces se congela la versión y la prueba una persona ajena. Además, la prueba nocturna tiene que salir bien **7 noches seguidas** sobre la misma versión, y eso es calendario, no esfuerzo.

| Fase | Qué ocurre | Puerta de salida |
|---|---|---|
| **F0** | El propietario toma 8 decisiones (licencia, política de registro, alcance del streaming, cierre de PR, si habrá instancia de demostración, publicación de releases, persona ajena para el ensayo, replays antiguos). Se ejecuta la fase 2 de la auditoría. | Decisiones registradas; actas de la fase 2. |
| **F1** | Siete carriles en paralelo implementan el grupo A: instalación, API y CLI, web, CI y release, seguridad, documentación y laboratorio. | Tareas A cerradas con evidencia. |
| **F2** | Integración y validación en laboratorio de lo que sólo se ve con todo junto. | Ensayos en laboratorio con acta. |
| **F3** | Congelación en un único commit, *release candidate*, 7 nocturnas en verde, ensayo de instalación por una persona ajena, GO. | Los 21 criterios de la Definition of Done en PASS. |
| **F4** | Después del GO: grupo B (versión pública completa). | — |

La cadena secuencial suma 6,5 – 19,5 días de esfuerzo estimado, más las esperas. Puntos que pueden alargarla:
- Si la fase 2 confirma que un bot puede conectarse a servicios con acceso a la base de datos, hay que rediseñar la red de las batallas: de 1 a 10 días, con incertidumbre alta.
- Arreglar la CI nocturna puede destapar fallos ocultos desde agosto.
- Cada pregunta de la persona ajena durante el ensayo es un hallazgo y puede obligar a un nuevo *release candidate*.

Detalle en [14-RELEASE-DELIVERY-PLAN](14-RELEASE-DELIVERY-PLAN.md).

### 14.5 Cuándo se considera terminada la versión (Definition of Done)

La versión A+ está terminada cuando se cumplen **21 criterios comprobables** sobre **un único commit congelado**. Ninguno está cumplido hoy. Los más importantes:

| # | Criterio | Cómo se demuestra |
|---|---|---|
| D1 | Hay una release numerada con sus imágenes y el componente del proxy publicado | Página de la release con sus ficheros y su suma de verificación |
| D2 | Hay licencia | GitHub muestra la licencia; cada paquete la declara |
| D4 | **Una persona ajena instala el sistema desde cero, solo con la documentación, hasta jugar una batalla** | Acta del ensayo: pasos, intervenciones y tiempo medidos |
| D5–D7 | Primer administrador sin SQL; registro cerrado o por invitación por defecto; cabeceras de seguridad | Pruebas automáticas que fallarían sin el cambio |
| D8–D9 | Un usuario nuevo juega su primera batalla con **un solo bot**; la instalación nueva trae bots de práctica | Prueba de navegador obligatoria en la CI |
| D11 | Recuperar una cuenta no exige tocar la base de datos | Prueba «el admin resetea, el usuario entra y cambia su contraseña» |
| D12 | Un ensayo completo de restauración de backup | Acta con recuentos y comprobación de datos |
| D13 | CI verde y **7 nocturnas seguidas en verde** | Historial de ejecuciones sobre el mismo commit |
| D17–D18 | Aislamiento de red medido con una prueba que *puede* fallar; imágenes escaneadas | Prueba con control positivo; informe del escáner |
| D20 | Fase 2 de la auditoría cerrada | Actas de cada verificación |

El **GO** es la decisión de presentar públicamente; no es un despliegue en producción. Exige los 21 criterios en PASS, las decisiones del propietario registradas, ningún P0/P1 abierto en el grupo A, y la firma del responsable de la release y del propietario. Contrato completo en [12-RELEASE-DEFINITION-OF-DONE](12-RELEASE-DEFINITION-OF-DONE.md).

### 14.6 Lo que conscientemente NO se exige a A+

Streaming V2, la nueva experiencia visual, editor con resaltado, traducción a otros idiomas, envío de correo, un instalador interactivo completo, automatizar actualizaciones y restauraciones (sí ensayarlas), separar la red de las batallas (sí medirla) y purgar el historial de git. Se declaran como limitaciones (criterio D16) y van a los grupos B, C o D del backlog.

### 14.7 Prioridad e impacto en el cierre

Este capítulo **es** el camino al cierre. El primer paso no es técnico: son las **decisiones del propietario de F0**. La licencia va la primera, porque sin ella no hay presentación pública posible. Después viene la fase 2 de la auditoría, que puede mover tareas del grupo B al A.

---

## 15. Veredicto final de la auditoría

> Capítulo de síntesis: no repite la plantilla de análisis (bien diseñado, funciona, problemas, falta, soluciones) de los capítulos 2 a 13, en los que se apoya cada veredicto.

### 15.1 Veredicto por áreas

Escala: **LISTO** · **LISTO CON CONDICIONES** (presentable tras cumplir condiciones concretas) · **NO LISTO** (hay bloqueantes) · **EVIDENCIA INSUFICIENTE** (no hay pruebas suficientes para concluir). Cada valoración remite a la evidencia del capítulo correspondiente; no es una puntuación subjetiva.

| # | Área | Veredicto | Por qué (evidencia) | Condición para mejorar el veredicto |
|---|---|---|---|---|
| 1 | Calidad del motor | **LISTO CON CONDICIONES** | Determinismo bien construido y comprobado en el código: generador aleatorio con semilla, lint que detecta fuentes de azar no controladas y prueba de 1.000 repeticiones que pasa en la CI. Replays atados a la versión del motor. Ningún hallazgo bloqueante ([cap. 5](#5-auditoría-del-motor-y-del-sistema-de-juego)). | Proteger las estadísticas ante cambios de versión (ARQ-01); sacar la versión escrita a mano (ARQ-03). Ninguna de las dos bloquea A+. |
| 2 | Estabilidad del backend | **LISTO CON CONDICIONES** | La cola de trabajos, el contrato de la API y la corrección de los torneos atascados son sólidos en el código ([cap. 6](#6-backend-api-y-base-de-datos)). No se ha medido en carga ni en producción. | Salida documentada para un torneo `closed` atascado (BE-01); límites de uso para `verify` y las batallas de práctica (REV-02, REV-03), según lo que mida la fase 2. |
| 3 | Seguridad | **LISTO CON CONDICIONES** (condiciones duras) | Buen endurecimiento del contenedor del bot y del proxy de Docker. Pero la prueba de aislamiento de red no puede fallar (REV-01), el registro está abierto sin interruptor y las imágenes de servicio no se escanean ([cap. 9](#9-seguridad)). No hay ninguna ruta de ataque concreta demostrada. | D6, D7, D17 y D18 de la Definition of Done. |
| 4 | Calidad del frontend | **LISTO CON CONDICIONES** | Estructura y gestión de errores correctas, ayuda integrada y comprobaciones de accesibilidad automáticas ([cap. 7](#7-web-usabilidad-y-experiencia-del-jugador)). Faltan editor de código usable y textos coherentes. | Cabeceras de seguridad (SEC-01) y correcciones menores de textos. |
| 5 | Experiencia de nuevos usuarios | **NO LISTO** | Una instalación nueva está vacía y la primera batalla exige programar y publicar **dos** bots. No hay recuperación de cuenta ni notificaciones ([cap. 7](#7-web-usabilidad-y-experiencia-del-jugador)). | Bots de práctica (D8, D9) y reset de contraseña asistido (D11). |
| 6 | Instalación | **NO LISTO** | Siguiendo la guía, el sistema queda «sano» pero **no juega batallas** (OPS-01). La plantilla de configuración es errónea, no hay release publicada y el primer administrador se crea con SQL ([cap. 8](#8-instalación-configuración-y-administración)). | D1, D4, D5 y D15. |
| 7 | Administración | **LISTO CON CONDICIONES** | El sistema se puede operar, pero varias tareas del día a día exigen SQL: promover al administrador, ver trabajos atascados o resetear una contraseña ([cap. 8](#8-instalación-configuración-y-administración)). | `create-admin`, reset asistido y runbooks de las operaciones del día 2. |
| 8 | Backups y recuperación | **EVIDENCIA INSUFICIENTE** | El backup funciona según el informe de reinstalación del operador, que la auditoría no ha verificado. No hay un ensayo completo y reciente de restauración en un servidor limpio. La poda de copias antiguas no se puede desactivar y las alertas no están probadas ([cap. 8](#8-instalación-configuración-y-administración)). | Ensayo de restore con acta (D12). |
| 9 | Streaming | **LISTO CON CONDICIONES** como función *experimental* de operador · **NO LISTO** para emisiones largas sin supervisión · Streaming V2 = **sólo diseño** | V1 está integrado en el código de principio a fin. La emisión real a YouTube sólo está documentada. Lo más largo medido son 12 minutos, con la memoria creciendo ([cap. 10](#10-replays-espectador-y-streaming)). | Presentarlo como experimental (D16). Prueba de sesión larga en grupo C. |
| 10 | Documentación | **NO LISTO** | Hay mucha documentación y es honesta, pero la portada dice que el producto «no funciona», el estado del proyecto va 586 commits por detrás y no hay licencia, changelog ni capturas ([cap. 12](#12-documentación-y-preparación-para-publicar)). | D2, D3, D14 y D16. |
| 11 | Mantenibilidad | **LISTO CON CONDICIONES** | Contrato de API derivado por construcción, migraciones con vuelta atrás (algunas pierden datos al revertir) y miles de pruebas en la CI de cada cambio. Pero la CI nocturna lleva rota desde el 4 de agosto, los mutantes no corren en ningún workflow y la deuda está anotada en un documento desfasado ([cap. 11](#11-pruebas-y-ci), [cap. 13](#13-deuda-técnica)). | D13: 7 nocturnas en verde. |
| 12 | Preparación para publicar | **NO LISTO** | Sin licencia, sin release ni versión etiquetada, README engañoso, 29 PR «NO MERGEAR» abiertos y datos de la instalación del operador en una plantilla ([cap. 12](#12-documentación-y-preparación-para-publicar)). | D1, D2, D3, D14 y D21. |

### Veredicto global: **NO LISTO**

Existen bloqueantes del grupo A abiertos. Además, la **producción, la instalación medida, la restauración y el streaming real** están en **EVIDENCIA INSUFICIENTE** hasta la fase 2. La base técnica es sólida; lo que falta es sobre todo *producto*: instalarlo, empezar a usarlo, documentarlo y publicarlo. Con la opción A+ ([cap. 14](#14-plan-para-cerrar-una-versión-presentable)), el veredicto esperado al cumplir la Definition of Done es **LISTO CON CONDICIONES**: presentable, con sus limitaciones escritas.

### 15.2 Respuestas a las preguntas de la misión

**¿Qué tenemos?**
Una plataforma completa para que personas programen bots en Python o JavaScript, los equipen y los enfrenten en un motor de simulación 2D que siempre da el mismo resultado. Incluye batallas individuales y por equipos, torneos, ranking, replays, espectador en directo y emisión a YouTube. Se despliega con Docker en un único servidor: 13 servicios y backups a un almacenamiento externo. El código de `main` (8f380eb, motor 0.5.0) pasa su CI de cada cambio. Según su propio informe, el operador lo reinstaló desde cero en producción con esa versión el 19-nov; la auditoría no lo ha verificado.

**¿Qué hacemos especialmente bien?**
- El **motor determinista**: en la misma plataforma, la misma batalla da siempre el mismo resultado, se puede verificar y los replays van atados a la versión.
- El **endurecimiento del contenedor** que ejecuta el código de los jugadores: sin privilegios, sistema de ficheros de sólo lectura, llamadas al sistema filtradas.
- El **proxy de Docker** con lista de operaciones permitidas, en vez de dar acceso libre a Docker.
- La **cola de trabajos** con reintentos y rescate de trabajos colgados.
- Un **contrato de API** que no puede desincronizarse del código.
- Una **disciplina de pruebas** poco común: en las revisiones se usaron mutantes para demostrar que las pruebas detectan fallos, aunque no se ejecutan automáticamente.

Ver [cap. 3](#3-puntos-fuertes-del-proyecto).

**¿Dónde están los puntos débiles?**
- En todo lo que rodea al código: instalar, empezar a jugar, recuperar una cuenta, publicar.
- En la **confianza en la evidencia**: una prueba de seguridad que no puede fallar y una prueba nocturna rota desde agosto que, aunque está anotada como deuda, no bloquea nada.
- En que muchas operaciones del día a día dependen de SQL o de conocimiento del equipo original.

Ver [cap. 4](#4-puntos-débiles-y-riesgos).

**¿Qué deuda técnica existe realmente?**
El registro histórico tiene 71 elementos: 25 cerrados y 46 abiertos. Varias prioridades históricas estaban mal: algunos P0 eran en realidad P1–P3 y algunas deudas ya están resueltas en el código. La deuda que **afecta al cierre**:
- la CI nocturna rota (TD-019);
- el acceso de cuentas (TD-012);
- la instalación del proxy (TD-024);
- el restore sin ensayar (TD-025);
- las imágenes sin escanear (TD-031);
- la topología del operador en ficheros del repositorio (TD-008).

Ver [cap. 13](#13-deuda-técnica).

**¿Qué funcionalidades están a medias?**
- Streaming V1: integrado, pero sin prueba de sesión larga.
- Recuperación de contraseña: el código crea el token y lo descarta.
- Gestión de usuarios desde la web.
- Salida para torneos atascados en `closed`.
- Pantalla de trabajos atascados.
- Compatibilidad de replays de motores anteriores: se listan, pero dan error al abrirlos.
- Importación portable: funciona, pero choca con el límite de 60 peticiones por hora y no indica cuánto esperar.

Ver la [matriz del cap. 2](#2-estado-actual-del-proyecto).

**¿Qué mejoras siguen sin desarrollar?**
- Streaming V2 / Broadcast Manager y la nueva experiencia visual: sólo diseño.
- Envío de correo y notificaciones.
- Editor de código con resaltado.
- Moderación de contenido y baja de cuenta.
- Términos y privacidad.
- Actualización y rollback con un solo comando.
- Certificados HTTPS automáticos.
- Desinstalación.
- Traducción.

**¿Qué falta para cerrar el proyecto en una versión estable?**
Los 26 trabajos del grupo A ([cap. 14.3](#143-qué-hay-que-hacer-para-a-grupo-a-del-backlog)), demostrados con los 21 criterios de la Definition of Done sobre un único commit congelado. El primer paso son las decisiones del propietario, empezando por la licencia, y la fase 2 de la auditoría.

**¿Puede instalarlo una persona ajena al desarrollo?**
**Hoy no.** La instalación siguiendo la documentación pública termina en un sistema que parece sano pero no ejecuta batallas. Además, exige conocimientos que la guía no da: proxy en el servidor, firewall, Node y crear el administrador por SQL. Con las tareas T-06…T-11 y el ensayo D4, la respuesta debería pasar a «sí, con conocimientos básicos de Linux y Docker». No se ha medido cuánto tarda; lo medirá el escenario S01 de la fase 2. Ver [cap. 8](#8-instalación-configuración-y-administración).

**¿Puede utilizarlo una persona que no conoce el juego?**
**Con mucho esfuerzo.** La web explica el juego y tiene ayuda, una lista de primeros pasos y documentación del SDK. Pero en una instalación nueva no hay rivales, la primera batalla exige dos bots propios publicados y el editor es un cuadro de texto simple. Sin recuperación de contraseña, quien la olvida pierde la cuenta. No se ha probado con personas reales. Ver [cap. 7](#7-web-usabilidad-y-experiencia-del-jugador).

**¿Qué necesitamos para presentar S9 AI Arena públicamente?**
- Una **licencia**.
- Un **README veraz** con capturas.
- Una **release numerada**.
- Un repositorio limpio: sin PR de revisión abiertos, sin ficheros sueltos y sin datos de la instalación del operador.
- **Registro protegido** por defecto.
- **Bots de práctica**.
- Una **instalación que funcione a la primera**, demostrada por una persona ajena.
- La **CI nocturna en verde**.
- Las **limitaciones escritas**: streaming experimental, sólo español, un servidor, sin correo.

**¿Cuál es el camino más corto y seguro para conseguirlo?**
La **opción A+**, en este orden:
1. Decisiones del propietario y fase 2 de la auditoría (F0).
2. Siete carriles en paralelo para el grupo A (F1).
3. Validación en laboratorio (F2).
4. Congelación, 7 nocturnas en verde, ensayo de instalación por una persona ajena y GO (F3).

No se deben añadir Streaming V2 ni mejoras visuales antes del GO. Ver [cap. 14](#14-plan-para-cerrar-una-versión-presentable).

### 15.3 Limitaciones

- **Fase 2 no ejecutada.** El día de la auditoría la producción estaba en plena migración: importando bots y compilándolos. Por norma no se tocó ningún sistema en marcha y no se ejecutaron pruebas pesadas en la máquina de coordinación. Todo lo que exige laboratorio o producción figura como **NO VERIFICADA / BLOQUEADA (fase 2)** y tiene la prueba que lo resolvería en los anexos [05](05-SECURITY-REVIEW.md), [07](07-INSTALLATION-OPERATIONS.md), [08](08-TEST-QUALITY.md) y [09](09-STREAMING-REVIEW.md).
- **Lo que dice la producción es del operador.** Lo que se sabe de producción procede de sus informes de reinstalación. Se cita como evidencia de tercero y no como verificación de la auditoría. **Que la CI esté verde no demuestra que la producción funcione.**
- **Sin mediciones.** No se ha medido ningún tiempo, consumo de recursos ni prueba con personas. Todos los esfuerzos son estimaciones.
- **Cuatro discrepancias abiertas** (D-15…D-18) que sólo resuelve la fase 2: imágenes, coste de `verify`, explotabilidad de la red compartida y número real de intervenciones manuales. Ver [15-INDEPENDENT-REVIEWS](15-INDEPENDENT-REVIEWS.md).
- **Revisión de autorización por muestreo.** No se revisaron una a una las 106 operaciones de la API, ni las migraciones línea a línea.

---

## Anexo · Glosario

| Término | Qué significa aquí |
|---|---|
| **2FA (doble factor)** | Segunda comprobación al entrar (p. ej. un código del móvil) además de la contraseña. |
| **ACME** | Protocolo que obtiene y renueva certificados HTTPS automáticamente (véase TLS). |
| **ADR** | Registro de una decisión de diseño importante: qué se decidió, por qué y qué alternativas se descartaron. |
| **API** | La «puerta» por la que la web y otros programas piden datos o acciones al servidor. |
| **Argon2** | Método moderno y lento a propósito para guardar contraseñas, de modo que no se puedan adivinar por fuerza bruta aunque se robe la base de datos. |
| **Backup / restore** | Copia de seguridad / recuperar el sistema a partir de esa copia. |
| **Bootstrap** | Comando que carga el contenido base de una instalación nueva (reglas, catálogo, mapas). No crea usuarios. |
| **Bot** | Programa escrito por un jugador que controla un vehículo en la arena. |
| **Build / compilar** | Preparar el código de un bot para que pueda ejecutarse, dentro de un entorno aislado. |
| **Bundle** | Paquete cerrado de ficheros (aquí, el instalador del proxy de Docker) que se publica junto a una versión y se verifica con su huella. |
| **Cabeceras de seguridad** | Instrucciones que el servidor envía al navegador para que bloquee ciertos ataques (p. ej. que otra web incruste la nuestra). |
| **cgroup / seccomp** | Dos funciones de Linux para limitar a un contenedor: cgroup acota CPU, memoria y procesos; seccomp prohíbe llamadas peligrosas al sistema. |
| **Chromium** | El navegador de código abierto en el que se basa Chrome; el visor de batallas y el streamer lo usan en modo invisible. |
| **CI (integración continua)** | Sistema que ejecuta automáticamente todas las pruebas en cada cambio del código (aquí, GitHub Actions). |
| **Cola / lease** | Cola: lista de trabajos pendientes (batallas, compilaciones). Lease («arrendamiento»): reserva temporal de un trabajo por un worker; si el worker se cae y no la renueva, otro puede retomarlo. |
| **Commit / SHA** | Una versión concreta del código, identificada por un código único (p. ej. `8f380eb`). |
| **Contenedor / Docker / Compose** | Docker ejecuta cada servicio en una «caja» aislada (contenedor); Compose arranca todos juntos con un fichero de configuración. |
| **Control positivo** | Prueba de la propia prueba: se provoca a propósito algo que debe detectarse (p. ej. un puerto abierto) para comprobar que la comprobación puede ponerse en rojo. |
| **CORS** | Regla del navegador sobre qué otras webs pueden pedir datos a la API. |
| **CSP** | Cabecera de seguridad (política de contenido) que dice al navegador qué scripts e imágenes puede cargar una página; frena la inyección de código malicioso. |
| **CTF (captura de bandera)** | Modo de juego en el que los equipos intentan llevarse la bandera del rival. |
| **Definition of Done (DoD)** | Lista de condiciones comprobables que deben cumplirse para dar la versión por terminada. |
| **Determinista** | Que con los mismos datos de entrada produce siempre exactamente el mismo resultado. Permite repetir y verificar batallas en la misma plataforma (entre máquinas distintas aún no está comprobado). |
| **Digest** | Huella digital única de una imagen de contenedor; fija exactamente qué versión se instala, a diferencia de una etiqueta como `latest` que puede cambiar. |
| **E2E (extremo a extremo)** | Prueba que recorre el sistema entero como lo haría un usuario. |
| **Elo** | Sistema de puntuación que sube o baja la valoración de cada participante según gane o pierda contra rivales más o menos fuertes. |
| **Endurecimiento (hardening)** | Medidas para reducir lo que un atacante podría hacer si algo falla. |
| **Estado `scheduled` / `closed`** | `scheduled`: batalla pendiente de ejecutarse, aún sin worker que la recoja. `closed`: torneo con inscripciones cerradas, a la espera de empezar o terminar. |
| **Fail-closed** | Diseño en el que, ante la duda o el fallo, el sistema bloquea o da rojo en vez de dejar pasar. |
| **Fase 1 / Fase 2 (de esta auditoría)** | Fase 1: análisis del código sin ejecutar nada. Fase 2: verificación en laboratorio y lectura de producción, pendiente. |
| **ffmpeg** | Programa libre para procesar vídeo; el streamer lo usa para codificar y emitir la batalla. |
| **Flaky (prueba intermitente)** | Prueba que a veces pasa y a veces falla sin que el código haya cambiado. |
| **Gate (puerta de calidad)** | Comprobación automática que debe pasar para poder integrar un cambio o dar una versión por buena. |
| **Gateway / proxy inverso** | Servicio que recibe todo el tráfico de Internet y lo reparte a los servicios internos. |
| **GO / NO-GO** | Decisión final de presentar (o no) la versión. |
| **Golden (prueba golden)** | Prueba de referencia que recorre el camino completo (registro, crear un bot, batalla) con un navegador real; si cambia el resultado, algo se ha roto. |
| **Grupo A-E** | A: bloquea el lanzamiento · B: necesaria para la versión objetivo · C: después del lanzamiento · D: futuro · E: descartar. |
| **Hash / sha256** | Huella digital de un fichero o dato: cualquier cambio, por pequeño que sea, produce una huella distinta. Sirve para comprobar que algo no ha sido alterado. |
| **Healthcheck / healthz** | Comprobación de salud: una dirección (`/healthz`) o un test que responde «estoy bien» o no. Si sólo contesta «ok» sin mirar nada, no informa de nada útil. |
| **Idempotente** | Que se puede ejecutar varias veces y el resultado es el mismo que ejecutarlo una vez; permite repetir un paso sin miedo a estropear nada. |
| **IDOR** | Fallo de seguridad en el que un usuario accede a datos de otro cambiando un identificador en la petición (p. ej. el número de un bot). |
| **JWT** | Credencial firmada que la web recibe al iniciar sesión y envía en cada petición; su secreto de firma debe ser largo y no estar en el repositorio. |
| **Licencia** | Texto legal que dice qué pueden hacer otros con el código. Sin ella, nadie tiene permiso para usarlo aunque sea público. |
| **Lockfile** | Fichero que fija las versiones exactas de todas las dependencias para que dos instalaciones obtengan lo mismo. |
| **Migración (de base de datos)** | Cambio ordenado de la estructura de la base de datos al pasar de una versión a otra. |
| **Mutante / prueba de mutación** | Se introduce un fallo a propósito en el código para comprobar que las pruebas lo detectan. Una prueba que no detecta ningún mutante no protege. En este proyecto existen pero se ejecutan a mano. |
| **needs_review** | Estado de un trabajo que el sistema no sabe resolver solo y deja aparcado a la espera de una persona. |
| **Nightly** | Batería de pruebas lentas que se ejecuta cada noche. |
| **No-op** | Paso que se ejecuta pero no hace nada. En la CI, un job que sale en verde sin comprobar nada engaña a quien lo lee. |
| **OpenAPI** | Fichero estándar que describe todas las operaciones de la API (rutas, datos, permisos); de él se generan documentación y código cliente. |
| **P0-P4** | Severidad: P0 crítico · P1 importante (seguridad, fiabilidad, lanzamiento) · P2 relevante · P3 menor · P4 futuro. |
| **Playwright** | Herramienta que controla un navegador real desde las pruebas automáticas para recorrer la web como lo haría una persona. |
| **Postgres** | La base de datos del proyecto; además guarda la cola de trabajos y la auditoría. |
| **PR (pull request)** | Propuesta de cambio al código, que se revisa antes de integrarla. |
| **Preflight** | Comprobación previa que verifica que el servidor cumple los requisitos antes de instalar o actualizar. |
| **Proxy de Docker** | Componente que se instala en el servidor y deja a los servicios crear contenedores de bots sólo con operaciones permitidas, en vez de darles control total de Docker. |
| **Rate limit / 429** | Límite de peticiones por tiempo; «429» es la respuesta cuando se supera. |
| **Release / tag** | Versión publicada y numerada (p. ej. `v0.6.0`), con sus ficheros descargables. |
| **Replay** | Grabación de una batalla que se puede volver a ver o verificar. |
| **Restic** | Herramienta de copias de seguridad cifradas y por versiones que usa el contenedor de backup. |
| **Rollback** | Volver a la versión anterior (o deshacer un cambio de base de datos) cuando una actualización sale mal. |
| **RTMPS** | Protocolo cifrado con el que se envía vídeo en directo a plataformas como YouTube. |
| **Ruleset / tick** | Ruleset: conjunto de reglas de un modo de juego. Tick: cada paso de tiempo de la simulación del combate. |
| **Runbook** | Procedimiento escrito, paso a paso, para una operación (p. ej. desatascar un torneo). |
| **Sandbox** | Entorno aislado donde se ejecuta código no confiable (los bots) sin que pueda dañar el sistema. |
| **SDK** | Kit de desarrollo: librerías y ejemplos para que un jugador programe su bot (aquí, en JavaScript y Python). |
| **Seed** | Comando de datos de desarrollo que crea usuarios de prueba con contraseñas conocidas. No debe usarse en producción. |
| **SFTP** | Transferencia de ficheros por conexión cifrada; el backup la usa para enviar las copias a un almacenamiento externo. |
| **Sha / `sha-<commit>`** | Etiqueta de imagen formada con el identificador del commit; identifica exactamente qué código contiene. |
| **SPA** | La aplicación web que se carga en el navegador. |
| **SQL** | Lenguaje para consultar y modificar una base de datos. Hacer algo «por SQL» significa escribir órdenes directamente en la base, sin pantalla ni comando del producto. |
| **Streaming / streamer** | Emisión en vivo de una batalla como vídeo a una plataforma externa; el streamer es el servicio que la produce. Función experimental. |
| **TLS / HTTPS / ACME** | Cifrado de la conexión web; ACME es el sistema que obtiene certificados automáticamente (p. ej. Let's Encrypt). |
| **Token** | Cadena secreta de un solo propósito (sesión, restablecer contraseña, clave de emisión) que acredita a quien la presenta. |
| **Trivy** | Herramienta que escanea imágenes de contenedor buscando vulnerabilidades conocidas. |
| **userns** | Función de aislamiento de Linux (espacios de nombres de usuario) que algunas pruebas y el sandbox necesitan; si falta en un entorno, esas pruebas fallan. |
| **UUID** | Identificador largo y único (p. ej. `3f2a…`) que usa el sistema para cuentas, bots o batallas en lugar de un número corriente. |
| **Webhook** | Dirección a la que un sistema envía un aviso automático (p. ej. una alerta). Si está vacía, nadie recibe el aviso. |
| **Worker** | Servicio que ejecuta trabajos en segundo plano (compilar bots, jugar batallas de torneo). |

## Anexos

| Documento | Contenido |
|---|---|
| [00-EXECUTIVE-SUMMARY](00-EXECUTIVE-SUMMARY.md) | Resumen ejecutivo (igual al capítulo 1) |
| [01-PROJECT-INVENTORY](01-PROJECT-INVENTORY.md) | Inventario: arquitectura, servicios, versiones, ramas, CI |
| [02-FUNCTIONAL-MATRIX](02-FUNCTIONAL-MATRIX.md) | Matriz funcional detallada e índice de todos los hallazgos |
| [03-STRENGTHS-WEAKNESSES](03-STRENGTHS-WEAKNESSES.md) | Fortalezas y debilidades con evidencia |
| [04-TECHNICAL-DEBT](04-TECHNICAL-DEBT.md) | Registro consolidado de deuda técnica |
| [05-SECURITY-REVIEW](05-SECURITY-REVIEW.md) | Revisión de seguridad |
| [06-UX-PRODUCT-REVIEW](06-UX-PRODUCT-REVIEW.md) | Experiencia de jugadores, programadores y administradores |
| [07-INSTALLATION-OPERATIONS](07-INSTALLATION-OPERATIONS.md) | Instalación, backup, restore, actualización, operación; escenarios de laboratorio |
| [08-TEST-QUALITY](08-TEST-QUALITY.md) | Calidad de pruebas y CI; batería mínima |
| [09-STREAMING-REVIEW](09-STREAMING-REVIEW.md) | Replays, espectador, streaming V1/V2 |
| [10-DOCUMENTATION-AUDIT](10-DOCUMENTATION-AUDIT.md) | Auditoría de la documentación y de los PR |
| [11-RELEASE-GAP-ANALYSIS](11-RELEASE-GAP-ANALYSIS.md) | Brecha por dimensión y opciones A / A+ / B / C |
| [12-RELEASE-DEFINITION-OF-DONE](12-RELEASE-DEFINITION-OF-DONE.md) | Contrato D1-D21, congelación y GO |
| [13-PRIORITIZED-BACKLOG](13-PRIORITIZED-BACKLOG.md) | Tareas T-NN por grupos A-E |
| [14-RELEASE-DELIVERY-PLAN](14-RELEASE-DELIVERY-PLAN.md) | Fases, carriles, camino crítico |
| [15-INDEPENDENT-REVIEWS](15-INDEPENDENT-REVIEWS.md) | Revisiones independientes y discrepancias |
| [evidence/](evidence/) | Informes originales de los 8 especialistas y de los 2 revisores (saneados) |

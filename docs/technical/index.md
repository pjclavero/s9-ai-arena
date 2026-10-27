# Documentación técnica

## Resumen

Explica cómo está construido S9 AI Arena: qué servicios hay, qué datos mueven, dónde se guardan y
qué reglas aplican. Todo está verificado contra el código de `27f70bb`. Cada documento termina con
una tabla de **Verificación** que da la línea de código de cada afirmación clave.

Si solo vas a leer un documento, que sea [battles.md](battles.md). Recorre el sistema entero
siguiendo una batalla.

Antes conviene leer la visión general en [../overview/architecture.md](../overview/architecture.md).
La deuda que se cita aquí está en [../roadmap/technical-debt.md](../roadmap/technical-debt.md).

## Índice

- [Arquitectura y servicios](#arquitectura-y-servicios)
- [Datos y comunicaciones](#datos-y-comunicaciones)
- [Producto: del bot a la batalla](#producto-del-bot-a-la-batalla)
- [Interfaz](#interfaz)
- [Seguridad](#seguridad)
- [Orden de lectura sugerido](#orden-de-lectura-sugerido)

## Arquitectura y servicios

### Arquitectura

Detalle técnico de la arquitectura: estructura del monorepo, modelo de procesos, qué servicio usa el
código de otro como librería, contratos compartidos, configuración y puntos de extensión.

→ [architecture.md](architecture.md)

### Servicios

Ficha de cada uno de los 12 servicios del perfil `production` y del proxy Docker del host. Para
cada uno recoge responsabilidad, entrypoint, entradas, salidas, dependencias, persistencia,
variables de configuración por nombre, healthcheck, errores conocidos y tests.

→ [services.md](services.md)

### Gateway

El nginx que es el único punto de entrada: qué prefijo va a qué servicio, cabeceras, TLS en modo
standalone o detrás de un proxy, y los casos conocidos de `/replays` y del endpoint de salud.

→ [gateway.md](gateway.md)

### Workers

Los dos procesos que reclaman trabajo de la cola. `tournament-worker` ejecuta batallas y torneos,
calcula ratings y aloja el WebSocket de espectador. `bot-build-worker` valida versiones de bots.
Incluye su ciclo de trabajo, los reintentos y cómo lanzan el código de cada bot en contenedores.

→ [workers.md](workers.md)

## Datos y comunicaciones

### Base de datos

PostgreSQL como base de negocio y como cola. Cubre las 13 migraciones, las tablas por área, qué
servicio escribe y lee cada una, y las restricciones relevantes. No hay tabla de replays.

→ [database.md](database.md)

### Cola

La tabla `jobs` de PostgreSQL como cola durable, y Redis como canal de aviso opcional que hoy no
tiene productor. Explica tipos de trabajo, reclamación, reintentos y degradación.

→ [queue.md](queue.md)

### Comunicaciones

Todas las comunicaciones entre componentes (HTTP, WebSocket, Redis, API de Docker por el proxy,
PostgreSQL, ficheros compartidos y SFTP), con productor, consumidor, contrato, autoridad, errores y
seguridad. El proyecto no usa MQTT.

→ [data-flow.md](data-flow.md)

### API

La API REST bajo `/api/v1`: contrato OpenAPI, cómo se deriva el rol mínimo de cada ruta,
autenticación, recursos por área con su método y ruta, las extensiones fuera del contrato y el
formato de errores.

→ [api.md](api.md)

### WebSocket

El directo de una batalla: ticket firmado, conexión al gateway de espectador del worker, mensajes
del protocolo y por qué hoy no funciona.

→ [websocket.md](websocket.md)

## Producto: del bot a la batalla

### Ciclo de batalla

Documento central. Recorre una batalla desde que se pide hasta que se ve el replay. En cada paso da
el servicio responsable, los datos que entran y salen, las tablas y estados de PostgreSQL y los
errores posibles. Incluye los dos caminos de ejecución que existen hoy.

→ [battles.md](battles.md)

### Motor

El motor 2D determinista: entidades, física Rapier, ticks, decisiones de bot, daño, sensores, PRNG
propio, reglas como datos y por qué una batalla se reproduce bit a bit.

→ [engine.md](engine.md)

### Modos de juego

Los 7 modos del motor, sus 9 rulesets, objetivo, reglas y condición de victoria de cada uno. Explica
por qué la plataforma solo expone 4.

→ [game-modes.md](game-modes.md)

### Bots

El código del usuario de principio a fin: versiones, los estados reales del pipeline de build, el
sandbox, los artefactos firmados, la publicación y la ejecución.

→ [bots.md](bots.md)

### Equipamiento

El loadout: chasis, ranuras, módulos del catálogo `mvp@1`, munición, presupuesto, masa y energía, y
qué efecto tiene de verdad cada campo en el motor (algunos no lo tienen).

→ [equipment.md](equipment.md)

### Mapas

Formato, versionado, validación, generador procedural e importación Tiled. Dónde se guardan (en la
API, no en map-service) y por qué el editor visual aún no guarda.

→ [maps.md](maps.md)

### Torneos

Inscripción, congelación de versiones, formatos, calendario, cuadro, series, rating Elo y
clasificación.

→ [tournaments.md](tournaments.md)

### Replays

Cómo se escribe un replay, su formato (JSONL comprimido con índice), dónde se guarda, cómo se lee
por segmentos, cómo se verifica y quién puede acceder hoy.

→ [replays.md](replays.md)

## Interfaz

### Frontend

La SPA React: enrutado por hash, estado, cliente HTTP, sesión, formularios y errores. Incluye el
visor y el reproductor en Phaser 4 y un mapa de páginas → endpoints.

→ [frontend.md](frontend.md)

## Seguridad

### Seguridad

Modelo real: autenticación y sesiones, roles RBAC, aislamiento del código no confiable, secretos
por nombre, funciones apagadas tras un gate y superficies abiertas conocidas, descritas por su clase
y enlazadas a su deuda.

→ [security.md](security.md)

## Orden de lectura sugerido

1. [../overview/architecture.md](../overview/architecture.md): el mapa general.
2. [battles.md](battles.md): el sistema siguiendo una batalla.
3. [services.md](services.md) y [data-flow.md](data-flow.md): quién habla con quién.
4. [database.md](database.md) y [queue.md](queue.md): dónde está cada dato.
5. El área concreta que vayas a tocar, y después [security.md](security.md).

## Documentación relacionada

- Uso desde la web: [../user/index.md](../user/index.md)
- Instalación y operación: [../operations/index.md](../operations/index.md)
- Cómo contribuir: [../development/index.md](../development/index.md)
- Estado y deuda: [../roadmap/index.md](../roadmap/index.md)
- Decisiones históricas: [../adr/index.md](../adr/index.md)
